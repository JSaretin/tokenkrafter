import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';
import { ethers } from 'ethers';
import { decrypt } from '$lib/crypto';

const TRADE_ROUTER_ABI = [
	'event WithdrawRequested(uint256 indexed id, address indexed user, address token, uint256 grossAmount, uint256 fee, uint256 netAmount, bytes32 bankRef)'
];

// RPC endpoints per chain (server-side)
const RPC_MAP: Record<number, string> = {
	31337: 'http://127.0.0.1:8545',
	56: 'https://bsc-dataseed.binance.org',
	1: 'https://eth.llamarpc.com'
};

// Trade router addresses per chain
const TRADE_ROUTER_MAP: Record<number, string> = {
	31337: '0x09635F643e140090A9A8Dcd712eD6285858ceBef'
};

// POST /api/withdrawals/verify — verify on-chain trade and link to DB record
// Auth: wallet session (hooks.server.ts)
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.wallet) return error(401, 'Wallet authentication required');

	const body = await request.json();
	const { tx_hash, chain_id } = body;
	const wallet_address = locals.wallet;

	if (!tx_hash || !chain_id) {
		return error(400, 'tx_hash and chain_id required');
	}

	const rpc = RPC_MAP[chain_id];
	if (!rpc) return error(400, `Unsupported chain: ${chain_id}`);

	const tradeRouterAddr = TRADE_ROUTER_MAP[chain_id];
	if (!tradeRouterAddr) return error(400, `No TradeRouter on chain ${chain_id}`);

	// 1. Fetch transaction receipt from chain
	let receipt;
	try {
		const provider = new ethers.JsonRpcProvider(rpc);
		receipt = await provider.getTransactionReceipt(tx_hash);
		if (!receipt) return error(404, 'Transaction not found');
		if (receipt.status !== 1) return error(400, 'Transaction failed on-chain');
	} catch (e: any) {
		return error(502, `Failed to fetch receipt: ${e.message}`);
	}

	// 2. Parse WithdrawRequested event from the TradeRouter contract
	const iface = new ethers.Interface(TRADE_ROUTER_ABI);
	let withdrawEvent: any = null;

	for (const log of receipt.logs) {
		if (log.address.toLowerCase() !== tradeRouterAddr.toLowerCase()) continue;
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

	// 3. Extract verified data from event
	const onChainWithdrawId = Number(withdrawEvent.args[0]); // id (indexed)
	const onChainUser = (withdrawEvent.args[1] as string).toLowerCase(); // user (indexed)
	const onChainToken = (withdrawEvent.args[2] as string).toLowerCase();
	const onChainGross = withdrawEvent.args[3].toString();
	const onChainFee = withdrawEvent.args[4].toString();
	const onChainNet = withdrawEvent.args[5].toString();
	const onChainBankRef = withdrawEvent.args[6] as string; // bytes32

	// 4. Verify wallet matches
	const claimedWallet = (wallet_address || '').toLowerCase();
	if (claimedWallet && claimedWallet !== onChainUser) {
		return error(403, 'Wallet address does not match on-chain depositor');
	}

	// 5. Find matching DB record by bankRef (saved during signing step)
	const { data: dbRecords } = await supabaseAdmin
		.from('withdrawal_requests')
		.select('*')
		.eq('status', 'awaiting_trade')
		.eq('wallet_address', onChainUser);

	if (!dbRecords || dbRecords.length === 0) {
		return error(404, 'No awaiting withdrawal found for this wallet');
	}

	// Match by bankRef hash
	// The frontend computed bankRef = keccak256(bankCode:account:holder:walletAddress)
	// The contract stored the same bankRef
	// Find the DB record whose payment_details hash matches
	let matchedRecord: any = null;

	for (const record of dbRecords) {
		let details = record.payment_details || {};
		// Decrypt if encrypted (string = encrypted, object = legacy plaintext)
		if (typeof details === 'string') {
			try { details = await decrypt(details); } catch { continue; }
		}
		let computedRef: string;

		if (record.payment_method === 'bank') {
			computedRef = ethers.id(`bank:${details.bank_code}:${details.account}:${details.holder}`);
		} else if (record.payment_method === 'paypal') {
			computedRef = ethers.id(`paypal:${details.email}`);
		} else if (record.payment_method === 'wise') {
			computedRef = ethers.id(`wise:${details.email}:${details.currency || 'NGN'}`);
		} else {
			continue;
		}

		if (computedRef === onChainBankRef) {
			matchedRecord = record;
			break;
		}
	}

	if (!matchedRecord) {
		return error(404, 'No matching bank details found for this transaction. bankRef mismatch.');
	}

	// 6. Update DB record with verified on-chain data
	const { data: updated, error: dbErr } = await supabaseAdmin
		.from('withdrawal_requests')
		.update({
			withdraw_id: onChainWithdrawId,
			tx_hash,
			gross_amount: onChainGross,
			fee: onChainFee,
			net_amount: onChainNet,
			token_in: onChainToken,
			status: 'pending',
			updated_at: new Date().toISOString()
		})
		.eq('id', matchedRecord.id)
		.select()
		.single();

	if (dbErr) return error(500, dbErr.message);

	return json({
		success: true,
		withdrawal: updated,
		verified: {
			withdraw_id: onChainWithdrawId,
			user: onChainUser,
			gross_amount: onChainGross,
			fee: onChainFee,
			net_amount: onChainNet,
			bank_ref: onChainBankRef
		}
	});
};
