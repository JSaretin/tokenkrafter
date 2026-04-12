import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { supabaseAdmin } from '$lib/supabaseServer';
import { timingSafeEqual } from 'crypto';
import { ethers } from 'ethers';
import { TRADE_ROUTER_ABI } from '$lib/tradeRouter';

function timingSafeCompare(a: string, b: string): boolean {
	const bufA = Buffer.from(a);
	const bufB = Buffer.from(b);
	if (bufA.length !== bufB.length) return false;
	return timingSafeEqual(bufA, bufB);
}

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

/** Call TradeRouter.confirm(id) on-chain using ADMIN_KEY */
async function confirmOnChain(chainId: number, withdrawId: number): Promise<{ success: boolean; txHash?: string; error?: string }> {
	const adminKey = env.ADMIN_KEY;
	if (!adminKey) {
		return { success: false, error: 'ADMIN_KEY not configured' };
	}

	const netConfig = await getNetworkConfig(chainId);
	if (!netConfig) {
		return { success: false, error: `No network config for chain ${chainId}` };
	}

	const provider = new ethers.JsonRpcProvider(netConfig.rpc, chainId, { staticNetwork: true });
	const wallet = new ethers.Wallet(adminKey.startsWith('0x') ? adminKey : `0x${adminKey}`, provider);
	const router = new ethers.Contract(netConfig.trade_router_address, TRADE_ROUTER_ABI, wallet);

	// Check on-chain status before confirming — abort if not Pending (0)
	const withdrawal = await router.getWithdrawal(withdrawId);
	const onChainStatus = Number(withdrawal.status);
	if (onChainStatus !== 0) {
		return { success: false, error: `On-chain status is ${onChainStatus} (not Pending), skipping confirm` };
	}

	// Call confirm(uint256 id) — 1-arg version sends to platformWallet
	const tx = await router['confirm(uint256)'](withdrawId);
	const receipt = await tx.wait();
	return { success: true, txHash: receipt.hash };
}

// POST /api/webhooks/flutterwave — handle transfer status updates
export const POST: RequestHandler = async ({ request }) => {
	// Verify webhook signature.
	// Flutterwave sends the webhook secret verbatim in the `verif-hash` header.
	// This is NOT an HMAC of the payload — it is a direct secret comparison.
	// See: https://developer.flutterwave.com/docs/integration-guides/webhooks/
	// We use timing-safe comparison to prevent timing side-channel attacks.
	const signature = request.headers.get('verif-hash');
	const webhookSecret = env.FLUTTERWAVE_WEBHOOK_SECRET || env.FLUTTERWAVE_ENCRYPTION_KEY;

	if (!webhookSecret) {
		console.error('[Flutterwave Webhook] No webhook secret configured — rejecting request');
		return json({ status: 'error', message: 'Webhook not configured' }, { status: 500 });
	}

	if (!signature || !timingSafeCompare(signature, webhookSecret)) {
		return json({ status: 'error', message: 'Invalid signature' }, { status: 401 });
	}

	const body = await request.json();
	const event = body.event;
	const data = body.data;

	if (!event || !data) {
		return json({ status: 'error', message: 'Invalid payload' }, { status: 400 });
	}

	console.log(`[Flutterwave Webhook] ${event}:`, data.reference, data.status);

	// Handle transfer events
	if (event === 'transfer.completed') {
		const reference = data.reference; // e.g. "TKR-56-123"
		const status = data.status; // "SUCCESSFUL", "FAILED"

		if (!reference) {
			return json({ status: 'ok' });
		}

		// Extract withdraw_id from reference (format: TKR-chain-withdrawId)
		const match = reference.match(/^TKR-(\d+)-(\d+)$/);
		if (!match) {
			return json({ status: 'ok' });
		}

		const chainId = parseInt(match[1]);
		const withdrawId = parseInt(match[2]);

		if (status === 'SUCCESSFUL') {
			// Fiat transfer succeeded — release USDT escrow on-chain
			const result = await confirmOnChain(chainId, withdrawId);

			if (result.success) {
				console.log(`[Flutterwave Webhook] On-chain confirm OK: withdrawId=${withdrawId}, tx=${result.txHash}`);
				await supabaseAdmin
					.from('withdrawal_requests')
					.update({
						status: 'confirmed',
						admin_note: `Fiat sent (Flutterwave ID: ${data.id}). On-chain confirm tx: ${result.txHash}`,
						confirmed_at: new Date().toISOString(),
						updated_at: new Date().toISOString()
					})
					.eq('withdraw_id', withdrawId)
					.eq('chain_id', chainId);
			} else {
				console.error(`[Flutterwave Webhook] On-chain confirm FAILED: withdrawId=${withdrawId}, error=${result.error}`);
				await supabaseAdmin
					.from('withdrawal_requests')
					.update({
						status: 'confirmed_fiat_only',
						admin_note: `Fiat sent (Flutterwave ID: ${data.id}), but on-chain confirm failed: ${result.error}. REQUIRES MANUAL ON-CHAIN CONFIRM.`,
						confirmed_at: new Date().toISOString(),
						updated_at: new Date().toISOString()
					})
					.eq('withdraw_id', withdrawId)
					.eq('chain_id', chainId);
			}
		} else {
			// Fiat transfer failed — do NOT release escrow
			const { error: dbErr } = await supabaseAdmin
				.from('withdrawal_requests')
				.update({
					status: 'failed',
					admin_note: `Flutterwave transfer ${status}. ID: ${data.id}`,
					updated_at: new Date().toISOString()
				})
				.eq('withdraw_id', withdrawId)
				.eq('chain_id', chainId);

			if (dbErr) {
				console.error('[Flutterwave Webhook] DB update failed:', dbErr.message);
			}
		}
	}

	return json({ status: 'ok' });
};
