import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';
import { initiateTransfer } from '$lib/flutterwave';
import { decrypt } from '$lib/crypto';
import { ethers } from 'ethers';
import { TRADE_ROUTER_ABI } from '$lib/tradeRouter';

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

// POST /api/withdrawals/process — initiate Flutterwave transfer
// Auth: admin session (set by hooks.server.ts)
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.isAdmin) return error(401, 'Admin access required');

	const body = await request.json();

	const { withdrawal_id, naira_rate } = body;

	if (!withdrawal_id) return error(400, 'withdrawal_id required');

	// Get withdrawal from DB
	const { data: withdrawal, error: dbErr } = await supabaseAdmin
		.from('withdrawal_requests')
		.select('*')
		.eq('id', withdrawal_id)
		.single();

	if (dbErr || !withdrawal) return error(404, 'Withdrawal not found');
	if (withdrawal.status !== 'pending') return error(400, 'Withdrawal not pending');
	if (withdrawal.payment_method !== 'bank') return error(400, 'Only bank transfers are auto-processed');

	// C2/H2: Check on-chain withdrawal status before processing.
	// Prevents race condition where user cancels on-chain while admin initiates fiat transfer.
	if (withdrawal.withdraw_id != null && withdrawal.chain_id != null) {
		const netConfig = await getNetworkConfig(withdrawal.chain_id);
		if (!netConfig) return error(500, `No network config for chain ${withdrawal.chain_id}`);

		try {
			const provider = new ethers.JsonRpcProvider(netConfig.rpc, withdrawal.chain_id, { staticNetwork: true });
			const router = new ethers.Contract(netConfig.trade_router_address, TRADE_ROUTER_ABI, provider);
			const onChain = await router.getWithdrawal(withdrawal.withdraw_id);
			const onChainStatus = Number(onChain.status);

			if (onChainStatus !== 0) {
				// Status 0=Pending, 1=Confirmed, 2=Cancelled
				const label = onChainStatus === 1 ? 'Confirmed' : onChainStatus === 2 ? 'Cancelled' : `Unknown(${onChainStatus})`;
				// Sync DB status to match on-chain reality
				const dbStatus = onChainStatus === 2 ? 'cancelled' : 'confirmed';
				await supabaseAdmin
					.from('withdrawal_requests')
					.update({
						status: dbStatus,
						admin_note: `On-chain status is ${label} — aborting fiat transfer.`,
						updated_at: new Date().toISOString()
					})
					.eq('id', withdrawal_id);
				return error(409, `Withdrawal already ${label} on-chain. Cannot process.`);
			}
		} catch (e: any) {
			console.error('[withdrawals/process] On-chain status check failed:', e.message);
			return error(502, `Failed to verify on-chain status: ${e.message}`);
		}
	}

	// Decrypt payment details
	let details = withdrawal.payment_details;
	if (typeof details === 'string') {
		try { details = await decrypt(details); } catch { return error(500, 'Failed to decrypt payment details'); }
	}
	if (!details?.bank_code || !details?.account) {
		return error(400, 'Missing bank details');
	}

	// Calculate NGN amount (net USDT × naira rate)
	const netUsdt = parseFloat(withdrawal.net_amount) / 1e6; // USDT has 6 decimals
	const rate = naira_rate || 1600; // Default rate, should be passed by admin
	const ngnAmount = Math.floor(netUsdt * rate);

	if (ngnAmount <= 0) return error(400, 'Amount too small');

	// Initiate transfer
	try {
		const reference = `TKR-${withdrawal.chain_id}-${withdrawal.withdraw_id}`;

		const result = await initiateTransfer({
			accountNumber: details.account,
			bankCode: details.bank_code,
			amount: ngnAmount,
			narration: `TokenKrafter withdrawal #${withdrawal.withdraw_id}`,
			reference,
			accountName: details.holder
		});

		if (!result.success) {
			return json({ success: false, error: result.error }, { status: 500 });
		}

		// Update DB with transfer info
		await supabaseAdmin
			.from('withdrawal_requests')
			.update({
				status: 'processing',
				admin_note: `Flutterwave transfer initiated. ID: ${result.transferId}, NGN ${ngnAmount} @ rate ${rate}`,
				updated_at: new Date().toISOString()
			})
			.eq('id', withdrawal_id);

		return json({
			success: true,
			transfer_id: result.transferId,
			ngn_amount: ngnAmount,
			rate,
			reference
		});
	} catch (e: any) {
		return json({ success: false, error: e.message || 'Transfer failed' }, { status: 500 });
	}
};
