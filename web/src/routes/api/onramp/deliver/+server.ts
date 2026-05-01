/**
 * POST /api/onramp/deliver
 * Body: { reference: string }
 *
 * Delivers the USDT (and optional BNB gas drip) for a paid on-ramp
 * intent. Called by the on-ramp delivery daemon once Flutterwave's
 * webhook has flipped the row to `payment_received`.
 *
 * Flow:
 *   1. Vault auth (SYNC_SECRET) — daemon-only access.
 *   2. Read intent by reference; refuse anything not in `payment_received`.
 *   3. CAS-flip status → 'delivering' to prevent double-fire (idempotency).
 *   4. Sign TradeRouter.onramp(receiver, usdt_amount_wei, txRef) with
 *      ADMIN_KEY — admin wallet pays gas, attaches `gas_drip_wei` BNB as
 *      msg.value (the contract forwards it to the receiver). USDT itself
 *      comes from TradeRouter's reserve (owner pre-funds the contract;
 *      admin wallet no longer needs a USDT balance).
 *   5. Update row: status='delivered', delivery_tx_hash, delivered_at.
 *   6. On failure: status='failed' + failure_reason; the daemon will not
 *      retry these — operator review needed.
 *
 * Replay protection lives on-chain: TradeRouter rejects a duplicate
 * txRef with OnrampRefAlreadyUsed, so even if the DB CAS races we can
 * never deliver the same reference twice.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';
import { isVaultAuth } from '$lib/daemonAuth';
import { ethers } from 'ethers';
import { env } from '$env/dynamic/private';

const ERC20_BALANCE_ABI = [
	'function balanceOf(address owner) view returns (uint256)',
];

const TRADE_ROUTER_ABI = [
	'function onramp(address to, uint256 usdtAmount, bytes32 txRef) payable',
	'function totalEscrow() view returns (uint256)',
	'function platformEarnings(address token) view returns (uint256)',
	'function onrampRefUsed(bytes32 txRef) view returns (bool)',
	'function isAdmin(address account) view returns (bool)',
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
	if (!net?.rpc || !net?.usdt_address || !net?.trade_router_address) return null;
	return {
		rpc: (net.daemon_rpc?.startsWith('http') ? net.daemon_rpc : null) || net.rpc,
		usdt_address: net.usdt_address as string,
		trade_router_address: net.trade_router_address as string,
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
		.select('reference, status, chain_id, receiver, usdt_amount_wei, gas_drip_wei')
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
	const usdt = new ethers.Contract(network.usdt_address, ERC20_BALANCE_ABI, provider);
	const tradeRouter = new ethers.Contract(network.trade_router_address, TRADE_ROUTER_ABI, signer);

	const amount = BigInt(row.usdt_amount_wei);
	const gasDripWei = BigInt((row as any).gas_drip_wei ?? '0');
	// onramp() dedups on this — keccak256(reference) keys the on-chain
	// `onrampRefUsed` mapping. Using the FLW reference directly (not a
	// derived hash) so any replay debugging can be done by hashing the
	// reference column from the DB.
	const txRef = ethers.keccak256(ethers.toUtf8Bytes(reference));

	// 4. Short-circuit if the contract has already accepted this txRef
	//    from a previous attempt (e.g. delivery succeeded on-chain but
	//    the response never reached us). Marking failed without recording
	//    a tx hash would leave a phantom — instead, look up the event by
	//    txRef topic in operator review. Surface as a permanent fail so
	//    a human looks; auto-retry would just revert again.
	try {
		const used: boolean = await tradeRouter.onrampRefUsed(txRef);
		if (used) {
			await markFailed(reference, 'TradeRouter already accepted this txRef — possible orphaned delivery, check on-chain');
			return json({ success: false, error: 'txRef already used on-chain' }, { status: 500 });
		}
	} catch (e: any) {
		await rollbackToPaid(reference);
		return json({ success: false, error: `txRef check: ${e.message?.slice(0, 200)}` }, { status: 502 });
	}

	// 5. Pre-flight reserve check. TradeRouter must hold enough free USDT
	//    above (totalEscrow + platformEarnings[USDT]) to honour this
	//    delivery without dipping into off-ramp escrow. Insufficient is
	//    *transient* (operator tops up the contract → next poll succeeds),
	//    so roll back to payment_received.
	try {
		const [bal, escrow, earnings] = (await Promise.all([
			usdt.balanceOf(network.trade_router_address),
			tradeRouter.totalEscrow(),
			tradeRouter.platformEarnings(network.usdt_address),
		])) as [bigint, bigint, bigint];
		const reserved = escrow + earnings;
		const free = bal > reserved ? bal - reserved : 0n;
		if (free < amount) {
			await rollbackToPaid(reference);
			return json(
				{
					success: false,
					error: 'Treasury insufficient',
					detail: {
						treasury_have_wei: free.toString(),
						required_wei: amount.toString(),
						shortfall_wei: (amount - free).toString(),
					},
				},
				{ status: 503 },
			);
		}
	} catch (e: any) {
		await rollbackToPaid(reference);
		return json({ success: false, error: `Reserve check: ${e.message?.slice(0, 200)}` }, { status: 502 });
	}

	// 6. Sign + broadcast onramp(). The admin wallet must have enough BNB
	//    for gas + the gas-drip msg.value; the contract pulls USDT from
	//    its own reserve (no admin USDT approval needed).
	let txHash: string | undefined;
	try {
		const est = await tradeRouter.onramp.estimateGas(row.receiver, amount, txRef, {
			value: gasDripWei,
		});
		const tx = await tradeRouter.onramp(row.receiver, amount, txRef, {
			value: gasDripWei,
			gasLimit: (est * 130n) / 100n,
		});
		const receipt = await tx.wait();
		txHash = receipt?.hash ?? tx.hash;
	} catch (e: any) {
		// Distinguish transient (RPC drop, gas estimation glitch) from
		// permanent (revert, OnrampRefAlreadyUsed, InsufficientReserve).
		// Conservative default: treat unknown failures as permanent so an
		// operator looks.
		const msg = e?.message ?? '';
		const transient = /timeout|network|ECONN|nonce too low|replacement|gas required|RPC|503|502/i.test(msg);
		if (transient) {
			await rollbackToPaid(reference);
			return json({ success: false, error: `onramp (transient): ${msg.slice(0, 300)}` }, { status: 502 });
		}
		await markFailed(reference, `onramp failed: ${msg.slice(0, 300)}`);
		return json({ success: false, error: 'On-chain onramp failed' }, { status: 500 });
	}

	// 7. Mark delivered. delivery_tx_hash covers both USDT + BNB drip
	//    since they ride on the same tx now; gas_drip_tx_hash is kept
	//    for backwards compat with the legacy split-tx delivery path
	//    (older rows in onramp_intents have separate hashes).
	await supabaseAdmin
		.from('onramp_intents')
		.update({
			status: 'delivered',
			delivered_at: new Date().toISOString(),
			delivery_tx_hash: txHash,
			gas_drip_tx_hash: gasDripWei > 0n ? txHash : null,
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
