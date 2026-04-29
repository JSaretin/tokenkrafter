/**
 * POST /api/onramp/deliver
 * Body: { reference: string }
 *
 * Delivers the USDT for a paid on-ramp intent. Called by the on-ramp
 * delivery daemon once Flutterwave's webhook has flipped the row to
 * `payment_received`.
 *
 * Flow:
 *   1. Vault auth (SYNC_SECRET) — daemon-only access.
 *   2. Read intent by reference; refuse anything not in `payment_received`.
 *   3. CAS-flip status → 'delivering' to prevent double-fire (idempotency).
 *   4. Sign IERC20(USDT).transfer(receiver, usdt_amount_wei) with ADMIN_KEY.
 *   5. Update row: status='delivered', delivery_tx_hash, delivered_at.
 *   6. On failure: status='failed' + failure_reason; the daemon will not
 *      retry these — operator review needed.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';
import { isVaultAuth } from '$lib/daemonAuth';
import { ethers } from 'ethers';
import { env } from '$env/dynamic/private';

const ERC20_TRANSFER_ABI = [
	'function transfer(address to, uint256 amount) returns (bool)',
	'function balanceOf(address owner) view returns (uint256)',
];

async function getNetwork(chainId: number) {
	const { data } = await supabaseAdmin
		.from('platform_config')
		.select('value')
		.eq('key', 'networks')
		.single();
	if (!data?.value) return null;
	const networks = data.value as any[];
	const net = networks.find((n: any) => Number(n.chain_id) === chainId);
	if (!net?.rpc || !net?.usdt_address) return null;
	return {
		rpc: (net.daemon_rpc?.startsWith('http') ? net.daemon_rpc : null) || net.rpc,
		usdt_address: net.usdt_address as string,
	};
}

export const POST: RequestHandler = async ({ request }) => {
	if (!isVaultAuth(request)) return error(401, 'Vault auth required');

	const body = await request.json().catch(() => null);
	const reference: string | undefined = body?.reference;
	if (!reference) return error(400, 'reference required');

	// 1. Read the intent.
	const { data: row, error: readErr } = await supabaseAdmin
		.from('onramp_intents')
		.select('reference, status, chain_id, receiver, usdt_amount_wei')
		.eq('reference', reference)
		.single();
	if (readErr || !row) return error(404, 'Intent not found');
	if (row.status !== 'payment_received') {
		return json({
			success: false,
			skipped: true,
			reason: `Intent in status '${row.status}', not 'payment_received'`,
		});
	}
	if (!row.receiver || !ethers.isAddress(row.receiver)) {
		return error(400, 'Intent has no valid receiver address');
	}

	// 2. CAS lock — flip to 'delivering' only if still 'payment_received'.
	//    Prevents two concurrent daemon polls from both firing the tx.
	const { data: locked, error: lockErr } = await supabaseAdmin
		.from('onramp_intents')
		.update({ status: 'delivering' })
		.eq('reference', reference)
		.eq('status', 'payment_received')
		.select('reference')
		.single();
	if (lockErr || !locked) {
		// Another worker grabbed it first.
		return json({ success: false, skipped: true, reason: 'Another worker is delivering' });
	}

	// 3. Resolve network + admin signer.
	const adminKey = env.ADMIN_KEY;
	if (!adminKey) return error(500, 'ADMIN_KEY not configured');
	const network = await getNetwork(Number(row.chain_id));
	if (!network) {
		await markFailed(reference, `No network config for chain ${row.chain_id}`);
		return json({ success: false, error: 'No network config' }, { status: 500 });
	}

	let provider: ethers.JsonRpcProvider;
	try {
		provider = new ethers.JsonRpcProvider(network.rpc, Number(row.chain_id), { staticNetwork: true });
	} catch (e: any) {
		// RPC-level errors are transient — roll back to payment_received
		// so the next poll retries.
		await rollbackToPaid(reference);
		return json({ success: false, error: `Provider init: ${e.message?.slice(0, 200)}` }, { status: 502 });
	}

	const signer = new ethers.Wallet(adminKey, provider);
	const usdt = new ethers.Contract(network.usdt_address, ERC20_TRANSFER_ABI, signer);

	// 4. Pre-flight treasury balance check. Insufficient is *transient*
	//    (operator funds the wallet → next poll succeeds), so roll back
	//    to payment_received instead of marking failed.
	const amount = BigInt(row.usdt_amount_wei);
	try {
		const treasury: bigint = await usdt.balanceOf(signer.address);
		if (treasury < amount) {
			await rollbackToPaid(reference);
			return json(
				{
					success: false,
					error: 'Treasury insufficient',
					detail: {
						treasury_have_wei: treasury.toString(),
						required_wei: amount.toString(),
						shortfall_wei: (amount - treasury).toString(),
					},
				},
				{ status: 503 },
			);
		}
	} catch (e: any) {
		await rollbackToPaid(reference);
		return json({ success: false, error: `Balance check: ${e.message?.slice(0, 200)}` }, { status: 502 });
	}

	// 5. Sign + broadcast the transfer.
	let txHash: string | undefined;
	try {
		const est = await usdt.transfer.estimateGas(row.receiver, amount);
		const tx = await usdt.transfer(row.receiver, amount, {
			gasLimit: (est * 130n) / 100n,
		});
		const receipt = await tx.wait();
		txHash = receipt?.hash ?? tx.hash;
	} catch (e: any) {
		// Distinguish transient (RPC drop, gas estimation glitch) from
		// permanent (revert, blocked address). Conservative default:
		// treat unknown failures as permanent so an operator looks.
		const msg = e?.message ?? '';
		const transient = /timeout|network|ECONN|nonce too low|replacement|gas|RPC|503|502/i.test(msg);
		if (transient) {
			await rollbackToPaid(reference);
			return json({ success: false, error: `Transfer (transient): ${msg.slice(0, 300)}` }, { status: 502 });
		}
		await markFailed(reference, `Transfer failed: ${msg.slice(0, 300)}`);
		return json({ success: false, error: 'On-chain transfer failed' }, { status: 500 });
	}

	// 6. Mark delivered.
	await supabaseAdmin
		.from('onramp_intents')
		.update({
			status: 'delivered',
			delivered_at: new Date().toISOString(),
			delivery_tx_hash: txHash,
		})
		.eq('reference', reference);

	return json({ success: true, reference, delivery_tx_hash: txHash });
};

async function markFailed(reference: string, reason: string) {
	console.error(`[onramp.deliver] ${reference}: ${reason}`);
	await supabaseAdmin
		.from('onramp_intents')
		.update({
			status: 'failed',
			failure_reason: reason,
		})
		.eq('reference', reference);
}

/** Roll back to `payment_received` so the next daemon poll retries. */
async function rollbackToPaid(reference: string) {
	await supabaseAdmin
		.from('onramp_intents')
		.update({ status: 'payment_received' })
		.eq('reference', reference)
		.eq('status', 'delivering');
}
