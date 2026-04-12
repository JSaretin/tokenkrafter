import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';
import { initiateTransfer, getBalance } from '$lib/flutterwave';
import { decrypt } from '$lib/crypto';
import { ethers } from 'ethers';
import { TRADE_ROUTER_ABI } from '$lib/tradeRouter';
import { env } from '$env/dynamic/private';

/** Get network config from DB */
async function getNetworkConfig(chainId: number): Promise<{
	rpc: string;
	trade_router_address: string;
} | null> {
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

/** Confirm withdrawal on-chain using the admin signer. */
async function confirmOnChain(
	chainId: number,
	withdrawId: number,
	routerAddress: string,
	rpcUrl: string,
): Promise<{ success: boolean; txHash?: string; error?: string }> {
	const adminKey = env.ADMIN_KEY;
	if (!adminKey) return { success: false, error: 'ADMIN_KEY not configured' };

	try {
		const provider = new ethers.JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
		const signer = new ethers.Wallet(adminKey, provider);
		const router = new ethers.Contract(routerAddress, TRADE_ROUTER_ABI, signer);

		const est = await router['confirm(uint256)'].estimateGas(withdrawId);
		const tx = await router['confirm(uint256)'](withdrawId, {
			gasLimit: (est * 130n) / 100n,
		});
		const receipt = await tx.wait();
		return { success: true, txHash: receipt.hash };
	} catch (e: any) {
		return { success: false, error: e.message?.slice(0, 300) || 'On-chain confirm failed' };
	}
}

// POST /api/withdrawals/process — confirm on-chain + initiate Flutterwave transfer
// Flow: check balance → confirm on-chain → send fiat
// Auth: admin session (set by hooks.server.ts)
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.isAdmin) return error(401, 'Admin access required');

	const body = await request.json();
	const { withdrawal_id, naira_rate } = body;

	if (!withdrawal_id) return error(400, 'withdrawal_id required');

	// ── 1. Fetch withdrawal from DB ──
	const { data: withdrawal, error: dbErr } = await supabaseAdmin
		.from('withdrawal_requests')
		.select('*')
		.eq('id', withdrawal_id)
		.single();

	if (dbErr || !withdrawal) return error(404, 'Withdrawal not found');
	if (withdrawal.status !== 'pending') return error(400, `Withdrawal is ${withdrawal.status}, not pending`);
	if (withdrawal.payment_method !== 'bank') return error(400, 'Only bank transfers are auto-processed');

	// ── 2. Get network config ──
	const netConfig = await getNetworkConfig(withdrawal.chain_id);
	if (!netConfig) return error(500, `No network config for chain ${withdrawal.chain_id}`);

	// ── 3. Verify on-chain withdrawal is still pending ──
	if (withdrawal.withdraw_id != null) {
		try {
			const provider = new ethers.JsonRpcProvider(netConfig.rpc, withdrawal.chain_id, { staticNetwork: true });
			const router = new ethers.Contract(netConfig.trade_router_address, TRADE_ROUTER_ABI, provider);
			const onChain = await router.getWithdrawal(withdrawal.withdraw_id);
			const onChainStatus = Number(onChain.status);

			if (onChainStatus !== 0) {
				const label = onChainStatus === 1 ? 'Confirmed' : onChainStatus === 2 ? 'Cancelled' : `Unknown(${onChainStatus})`;
				const dbStatus = onChainStatus === 2 ? 'cancelled' : 'confirmed';
				await supabaseAdmin
					.from('withdrawal_requests')
					.update({
						status: dbStatus,
						admin_note: `On-chain status is ${label} — aborting.`,
						updated_at: new Date().toISOString(),
					})
					.eq('id', withdrawal_id);
				return error(409, `Withdrawal already ${label} on-chain`);
			}
		} catch (e: any) {
			console.error('[process] On-chain status check failed:', e.message);
			return error(502, 'Failed to verify on-chain status');
		}
	}

	// ── 4. Decrypt payment details ──
	let details = withdrawal.payment_details;
	if (typeof details === 'string') {
		try {
			details = await decrypt(details);
		} catch {
			return error(500, 'Failed to decrypt payment details');
		}
	}
	if (!details?.bank_code || !details?.account) {
		return error(400, 'Missing bank details');
	}

	// ── 5. Calculate NGN amount ──
	const netUsdt = parseFloat(withdrawal.net_amount) / 1e6;
	const rate = naira_rate || 1600;
	const ngnAmount = Math.floor(netUsdt * rate);
	if (ngnAmount <= 0) return error(400, 'Amount too small');

	// ── 6. Check Flutterwave balance ──
	const { available } = await getBalance('NGN');
	if (available < ngnAmount + 50) {
		// +50 buffer for Flutterwave transfer fee
		return json(
			{ success: false, error: `Insufficient Flutterwave balance: ₦${available.toLocaleString()} available, ₦${ngnAmount.toLocaleString()} needed` },
			{ status: 400 },
		);
	}

	// ── 7. Confirm on-chain (release USDT from escrow) ──
	if (withdrawal.withdraw_id != null) {
		const confirmResult = await confirmOnChain(
			withdrawal.chain_id,
			withdrawal.withdraw_id,
			netConfig.trade_router_address,
			netConfig.rpc,
		);

		if (!confirmResult.success) {
			return json(
				{ success: false, error: `On-chain confirm failed: ${confirmResult.error}` },
				{ status: 500 },
			);
		}

		// Update DB with tx hash
		await supabaseAdmin
			.from('withdrawal_requests')
			.update({
				status: 'confirmed',
				admin_note: `On-chain confirmed: ${confirmResult.txHash}`,
				updated_at: new Date().toISOString(),
			})
			.eq('id', withdrawal_id);
	}

	// ── 8. Initiate Flutterwave transfer ──
	try {
		const reference = `TKR-${withdrawal.chain_id}-${withdrawal.withdraw_id}`;

		const result = await initiateTransfer({
			accountNumber: details.account,
			bankCode: details.bank_code,
			amount: ngnAmount,
			narration: `TokenKrafter withdrawal #${withdrawal.withdraw_id}`,
			reference,
			accountName: details.holder,
		});

		if (!result.success) {
			return json({ success: false, error: result.error }, { status: 500 });
		}

		// Update DB with transfer info
		await supabaseAdmin
			.from('withdrawal_requests')
			.update({
				status: 'processing',
				admin_note: `Flutterwave transfer initiated. ID: ${result.transferId}, NGN ${ngnAmount} @ rate ${rate}. On-chain confirmed.`,
				updated_at: new Date().toISOString(),
			})
			.eq('id', withdrawal_id);

		return json({
			success: true,
			transfer_id: result.transferId,
			ngn_amount: ngnAmount,
			rate,
			reference,
		});
	} catch (e: any) {
		return json({ success: false, error: e.message || 'Transfer failed' }, { status: 500 });
	}
};
