import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';
import { ethers } from 'ethers';
import { isDaemonAuth } from '$lib/daemonAuth';

const TRADE_ROUTER_ABI = [
	'event WithdrawRequested(uint256 indexed id, address indexed user, address token, uint256 grossAmount, uint256 fee, uint256 netAmount, bytes32 bankRef)'
];

/** Get network config from DB */
async function getNetworkConfig(chainId: number): Promise<{ rpc: string; trade_router_address: string } | null> {
	const { data } = await supabaseAdmin
		.from('platform_config')
		.select('value')
		.eq('key', 'networks')
		.single();

	if (!data?.value) return null;
	const networks = data.value as any[];
	const net = networks.find((n: any) => n.chain_id === chainId);
	if (!net?.rpc || !net?.trade_router_address) return null;
	return { rpc: net.rpc, trade_router_address: net.trade_router_address };
}

// POST /api/withdrawals/verify — verify on-chain trade and link to DB record
// Auth: wallet session OR SYNC_SECRET (daemon)
export const POST: RequestHandler = async ({ request, locals }) => {
	const body = await request.json();

	// Auth: session cookie (frontend) or daemon (isDaemonAuth)
	const isDaemon = isDaemonAuth(request);
	const wallet_address = locals.wallet || (isDaemon ? body.wallet_address?.toLowerCase() : null);

	if (!wallet_address && !isDaemon) {
		return error(401, 'Authentication required');
	}

	const { tx_hash, chain_id } = body;

	if (!chain_id) {
		return error(400, 'chain_id required');
	}

	// Get network config from DB
	const netConfig = await getNetworkConfig(chain_id);
	if (!netConfig) return error(400, `No network config for chain ${chain_id}`);

	// If daemon sends pre-fetched data (no tx_hash), use it directly for bankRef matching
	if (isDaemon && !tx_hash && body.withdraw_id !== undefined) {
		return await handleDaemonVerify(body, chain_id);
	}

	if (!tx_hash) {
		return error(400, 'tx_hash required');
	}

	// 1. Fetch transaction receipt from chain
	let receipt;
	try {
		const provider = new ethers.JsonRpcProvider(netConfig.rpc, chain_id, { staticNetwork: true });
		receipt = await provider.getTransactionReceipt(tx_hash);
		if (!receipt) return error(404, 'Transaction not found');
		if (receipt.status !== 1) return error(400, 'Transaction failed on-chain');
	} catch (e: any) {
		return error(502, `Failed to fetch receipt: ${e.message}`);
	}

	// 2. Parse WithdrawRequested event
	const iface = new ethers.Interface(TRADE_ROUTER_ABI);
	let withdrawEvent: any = null;

	for (const log of receipt.logs) {
		if (log.address.toLowerCase() !== netConfig.trade_router_address.toLowerCase()) continue;
		try {
			const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
			if (parsed?.name === 'WithdrawRequested') {
				withdrawEvent = parsed;
				break;
			}
		} catch {}
	}

	if (!withdrawEvent) {
		return error(400, 'No WithdrawRequested event found in transaction');
	}

	// 3. Extract verified data
	const onChainWithdrawId = Number(withdrawEvent.args[0]);
	const onChainUser = (withdrawEvent.args[1] as string).toLowerCase();
	const onChainToken = (withdrawEvent.args[2] as string).toLowerCase();
	const onChainGross = withdrawEvent.args[3].toString();
	const onChainFee = withdrawEvent.args[4].toString();
	const onChainNet = withdrawEvent.args[5].toString();
	const onChainBankRef = withdrawEvent.args[6] as string;

	// 4. Verify wallet matches (skip for daemon)
	if (wallet_address && wallet_address !== onChainUser) {
		return error(403, 'Wallet address does not match on-chain depositor');
	}

	// 5. Find and update matching DB record
	return await matchAndUpdate(onChainUser, onChainBankRef, {
		withdraw_id: onChainWithdrawId,
		tx_hash,
		gross_amount: onChainGross,
		fee: onChainFee,
		net_amount: onChainNet,
		token_in: onChainToken,
	});
};

/** Handle daemon verify — matches by wallet + bankRef from on-chain data */
async function handleDaemonVerify(body: any, chainId: number) {
	const { withdraw_id, wallet_address, gross_amount, fee, net_amount, bank_ref, status, expires_at } = body;

	// If already confirmed/cancelled on-chain, just sync the status
	if (status === 1 || status === 2) {
		const newStatus = status === 1 ? 'confirmed' : 'cancelled';
		const { data: existing } = await supabaseAdmin
			.from('withdrawal_requests')
			.select('id, status')
			.eq('withdraw_id', withdraw_id)
			.eq('chain_id', chainId)
			.single();

		if (existing && existing.status !== newStatus) {
			await supabaseAdmin
				.from('withdrawal_requests')
				.update({ status: newStatus, updated_at: new Date().toISOString() })
				.eq('id', existing.id);
		}
		return json({ ok: true, action: 'status_synced' });
	}

	// Try to match awaiting_trade record by bankRef
	if (bank_ref) {
		return await matchAndUpdate(wallet_address, bank_ref, {
			withdraw_id,
			gross_amount,
			fee,
			net_amount,
			...(expires_at ? { expires_at: new Date(expires_at * 1000).toISOString() } : {}),
		});
	}

	return json({ ok: true, action: 'skipped' });
}

/** Match an awaiting_trade record by wallet + bankRef, then update to pending */
async function matchAndUpdate(
	walletAddress: string,
	bankRef: string,
	updateData: Record<string, any>
) {
	// bankRef is now ethers.id('wd:<row_id>'), generated by the FE after
	// the row is created in /api/withdrawals POST. Iterate awaiting_trade
	// rows for this wallet, recompute, and match. (Was previously a hash
	// of payment-method details — that meant retrying with the same bank
	// account permanently failed because TradeRouter.bankRefUsed locked
	// the hash on first deposit.)
	const { data: dbRecords } = await supabaseAdmin
		.from('withdrawal_requests')
		.select('*')
		.eq('status', 'awaiting_trade')
		.eq('wallet_address', walletAddress.toLowerCase());

	if (!dbRecords || dbRecords.length === 0) {
		return error(404, 'No awaiting withdrawal found for this wallet');
	}

	let matchedRecord: any = null;

	for (const record of dbRecords) {
		const computedRef = ethers.id(`wd:${record.id}`);
		if (computedRef === bankRef) {
			matchedRecord = record;
			break;
		}
	}

	if (!matchedRecord) {
		return error(404, 'No matching withdrawal found for this bankRef.');
	}

	const { data: updated, error: dbErr } = await supabaseAdmin
		.from('withdrawal_requests')
		.update({
			...updateData,
			status: 'pending',
			updated_at: new Date().toISOString()
		})
		.eq('id', matchedRecord.id)
		.select()
		.single();

	if (dbErr) {
		console.error('[withdrawals verify] DB error:', dbErr.message);
		return error(500, 'Failed to update withdrawal');
	}

	return json({ success: true, withdrawal: updated });
}
