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

/**
 * POST /api/withdrawals/process
 *
 * Reads the withdrawal from the blockchain, matches it to a DB record
 * via bankRef + user, checks Flutterwave balance, confirms on-chain
 * (releases USDT from escrow), then initiates the fiat transfer.
 *
 * Auth: admin session cookie OR TX_CONFIRM_SECRET bearer token (daemon).
 *
 * Body: { withdraw_id: number, chain_id: number, naira_rate?: number, confirm_to?: string }
 *   confirm_to: optional address to receive USDT instead of platformWallet
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	// ── Auth: admin cookie OR TX_CONFIRM_SECRET ──
	const authHeader = request.headers.get('authorization');
	const isDaemon = env.TX_CONFIRM_SECRET && authHeader === `Bearer ${env.TX_CONFIRM_SECRET}`;
	if (!locals.isAdmin && !isDaemon) {
		return error(401, 'Admin or daemon access required');
	}

	const body = await request.json();
	const { withdraw_id, chain_id, naira_rate, confirm_to } = body;

	if (withdraw_id == null || !chain_id) {
		return error(400, 'withdraw_id and chain_id required');
	}

	// ── 1. Get network config ──
	const netConfig = await getNetworkConfig(chain_id);
	if (!netConfig) return error(500, `No network config for chain ${chain_id}`);

	const provider = new ethers.JsonRpcProvider(netConfig.rpc, chain_id, { staticNetwork: true });
	const router = new ethers.Contract(netConfig.trade_router_address, TRADE_ROUTER_ABI, provider);

	// ── 2. Read withdrawal from blockchain ──
	let onChain: any;
	try {
		onChain = await router.getWithdrawal(withdraw_id);
	} catch (e: any) {
		return error(502, `Failed to read on-chain withdrawal: ${e.message?.slice(0, 200)}`);
	}

	const onChainStatus = Number(onChain.status);
	const onChainUser = (onChain.user as string).toLowerCase();
	const bankRef = onChain.bankRef as string; // bytes32 hex
	const netAmount = onChain.netAmount as bigint;
	const grossAmount = onChain.grossAmount as bigint;
	const fee = onChain.fee as bigint;

	// Must be pending (status 0) to process
	if (onChainStatus !== 0) {
		const label = onChainStatus === 1 ? 'Confirmed' : onChainStatus === 2 ? 'Cancelled' : `Unknown(${onChainStatus})`;
		return error(409, `On-chain withdrawal is ${label}, not Pending`);
	}

	// ── 3. Match DB record by bankRef + wallet_address ──
	// The bankRef is a keccak256 hash of the user's bank details, set
	// when the user initiated the withdrawal. We find the matching DB
	// record to get the decrypted payment details for the fiat transfer.
	const { data: candidates, error: dbErr } = await supabaseAdmin
		.from('withdrawal_requests')
		.select('*')
		.eq('wallet_address', onChainUser)
		.in('status', ['pending', 'awaiting_trade']);

	if (dbErr) {
		console.error('[process] DB query failed:', dbErr.message);
		return error(500, 'Database error');
	}

	if (!candidates || candidates.length === 0) {
		return error(404, `No pending withdrawal found for wallet ${onChainUser}`);
	}

	// Match by bankRef — decrypt each candidate's payment details and
	// compare the computed hash to the on-chain bankRef.
	let matched: (typeof candidates)[0] | null = null;
	for (const row of candidates) {
		let details = row.payment_details;
		if (typeof details === 'string') {
			try { details = await decrypt(details); } catch { continue; }
		}
		if (!details?.bank_code || !details?.account) continue;

		let computed: string;
		if (row.payment_method === 'paypal') {
			computed = ethers.id(`paypal:${details.email}`);
		} else if (row.payment_method === 'wise') {
			computed = ethers.id(`wise:${details.email}:${details.currency || 'NGN'}`);
		} else {
			computed = ethers.id(`bank:${details.bank_code}:${details.account}:${details.holder}`);
		}

		if (computed === bankRef) {
			matched = { ...row, _details: details };
			break;
		}
	}

	if (!matched) {
		return error(404, 'No matching bank details found for on-chain bankRef');
	}

	const details = matched._details;

	// ── 4. Calculate NGN amount ──
	// Use the locked rate/amount from trade creation time if available.
	// This is the exact amount the user was shown — no recalculation drift.
	let ngnAmount: number;
	let rate: number;

	if (matched.locked_ngn_amount && matched.locked_naira_rate) {
		ngnAmount = Math.floor(parseFloat(matched.locked_ngn_amount));
		rate = parseFloat(matched.locked_naira_rate);
	} else {
		// Fallback: recalculate (for old records without locked values)
		let usdtDecimals = 18;
		try {
			const tokenContract = new ethers.Contract(onChain.token, ['function decimals() view returns (uint8)'], provider);
			usdtDecimals = Number(await tokenContract.decimals());
		} catch {}
		const netUsdt = parseFloat(ethers.formatUnits(netAmount, usdtDecimals));
		rate = naira_rate || 1600;
		ngnAmount = Math.floor(netUsdt * rate);
	}

	if (ngnAmount <= 0) return error(400, 'Amount too small');

	// ── 5. Check Flutterwave balance ──
	const { available } = await getBalance('NGN');
	if (available < ngnAmount + 50) {
		return json(
			{
				success: false,
				error: `Insufficient Flutterwave balance: ₦${available.toLocaleString()} available, ₦${ngnAmount.toLocaleString()} needed`,
			},
			{ status: 400 },
		);
	}

	// ── 6. Confirm on-chain (release USDT from escrow) ──
	const adminKey = env.ADMIN_KEY;
	if (!adminKey) return error(500, 'ADMIN_KEY not configured');

	let confirmTxHash: string | undefined;
	try {
		const signer = new ethers.Wallet(adminKey, provider);
		const routerSigner = new ethers.Contract(netConfig.trade_router_address, TRADE_ROUTER_ABI, signer);
		let tx;
		if (confirm_to && ethers.isAddress(confirm_to)) {
			const est = await routerSigner['confirm(uint256,address)'].estimateGas(withdraw_id, confirm_to);
			tx = await routerSigner['confirm(uint256,address)'](withdraw_id, confirm_to, {
				gasLimit: (est * 130n) / 100n,
			});
		} else {
			const est = await routerSigner['confirm(uint256)'].estimateGas(withdraw_id);
			tx = await routerSigner['confirm(uint256)'](withdraw_id, {
				gasLimit: (est * 130n) / 100n,
			});
		}
		const receipt = await tx.wait();
		confirmTxHash = receipt.hash;
	} catch (e: any) {
		return json(
			{ success: false, error: `On-chain confirm failed: ${e.message?.slice(0, 300)}` },
			{ status: 500 },
		);
	}

	// Update DB — mark confirmed
	await supabaseAdmin
		.from('withdrawal_requests')
		.update({
			status: 'confirmed',
			withdraw_id: withdraw_id,
			admin_note: `On-chain confirmed: ${confirmTxHash}`,
			updated_at: new Date().toISOString(),
		})
		.eq('id', matched.id);

	// ── 7. Initiate Flutterwave transfer ──
	try {
		const refHash = ethers.id(`TKR:${chain_id}:${withdraw_id}:${Date.now()}`).slice(2, 42);
		const reference = `TKR${refHash}`;

		const result = await initiateTransfer({
			accountNumber: details.account,
			bankCode: details.bank_code,
			amount: ngnAmount,
			narration: `TKR${refHash}`,
			reference,
			accountName: details.holder,
		});

		if (!result.success) {
			// On-chain already confirmed but fiat failed — flag for manual resolution
			await supabaseAdmin
				.from('withdrawal_requests')
				.update({
					status: 'confirmed',
					admin_note: `On-chain confirmed (${confirmTxHash}) but fiat transfer FAILED: ${result.error}. Needs manual resolution.`,
					updated_at: new Date().toISOString(),
				})
				.eq('id', matched.id);

			return json({ success: false, error: `Fiat transfer failed: ${result.error}. On-chain already confirmed.` }, { status: 500 });
		}

		// Update DB with transfer info
		await supabaseAdmin
			.from('withdrawal_requests')
			.update({
				status: 'processing',
				admin_note: `Confirmed on-chain (${confirmTxHash}). Flutterwave transfer ID: ${result.transferId}, ₦${ngnAmount.toLocaleString()} @ rate ${rate}.`,
				updated_at: new Date().toISOString(),
			})
			.eq('id', matched.id);

		return json({
			success: true,
			transfer_id: result.transferId,
			confirm_tx: confirmTxHash,
			ngn_amount: ngnAmount,
			rate,
			reference,
			matched_withdrawal_id: matched.id,
		});
	} catch (e: any) {
		return json({ success: false, error: e.message || 'Transfer failed' }, { status: 500 });
	}
};
