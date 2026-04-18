import { ethers } from 'ethers';
import { TRADE_ROUTER_ABI } from './tradeRouter';
import type {
	WithdrawRequestRaw,
	RouterStateRaw,
	PreviewDepositRaw,
	WithdrawRequestedEventRaw,
} from './structure/tradeRouter';

/**
 * WithdrawRequestRaw's timestamps come back as bigint from ethers; the client
 * unwraps them to `number` at the edge so callers don't have to. The rest
 * (amounts, status) stays raw.
 */
export interface WithdrawalRecord extends Omit<WithdrawRequestRaw, 'createdAt' | 'expiresAt'> {
	createdAt: number;
	expiresAt: number;
}

export interface WithdrawalResult {
	records: (WithdrawalRecord & { withdraw_id: number })[];
	total: number;
}

export type DepositPreview = PreviewDepositRaw;

/** Unwrap bigint counters + uint8 fields; keep raw amounts for UI formatting. */
export interface RouterState extends Omit<
	RouterStateRaw,
	'feeBps' | 'payoutTimeout' | 'pendingCount' | 'totalWithdrawals' | 'maxSlippageBps' | 'affiliateShareBps'
> {
	feeBps: number;
	payoutTimeout: number;
	pendingCount: number;
	totalWithdrawals: number;
	maxSlippageBps: number;
	minWithdrawUsdt: bigint;
	affiliateShareBps: number;
}

export interface DepositResult {
	tx: ethers.TransactionResponse;
	receipt: ethers.TransactionReceipt | null;
	withdrawId: number;
	fee: bigint;
	netAmount: bigint;
	expiresAt: number;
}

/**
 * Typed wrapper around the TradeRouter smart contract.
 * Handles swap quoting, off-ramp deposits, withdrawal history,
 * event parsing, and admin operations.
 */
export class TradeRouterClient {
	readonly contract: ethers.Contract;
	private readonly iface = new ethers.Interface(TRADE_ROUTER_ABI);

	constructor(address: string, signerOrProvider: ethers.Signer | ethers.Provider) {
		this.contract = new ethers.Contract(address, TRADE_ROUTER_ABI, signerOrProvider);
	}

	/** Create a new instance connected to a signer (for write operations) */
	connect(signer: ethers.Signer): TradeRouterClient {
		return new TradeRouterClient(this.contract.target as string, signer);
	}

	// ── Views ──────────────────────────────────────────────

	async weth(): Promise<string> {
		return this.contract.weth();
	}

	async usdt(): Promise<string> {
		return this.contract.usdt();
	}

	async getAmountOut(path: string[], amountIn: bigint): Promise<bigint> {
		return this.contract.getAmountOut(path, amountIn);
	}

	async previewDeposit(usdtAmount: bigint): Promise<DepositPreview> {
		const [fee, netAmount] = await this.contract.previewDeposit(usdtAmount);
		return { fee, netAmount };
	}

	async payoutTimeout(): Promise<number> {
		return Number(await this.contract.payoutTimeout());
	}

	async minWithdrawUsdt(): Promise<bigint> {
		try {
			return BigInt(await this.contract.minWithdrawUsdt());
		} catch {
			return 0n;
		}
	}

	async feeBps(): Promise<number> {
		return Number(await this.contract.feeBps());
	}

	// ── User Withdrawals ──────────────────────────────────

	async getUserWithdrawals(user: string, offset = 0, limit = 50): Promise<WithdrawalResult> {
		const [result, withdrawIds, total] = await this.contract.getUserWithdrawals(user, offset, limit);
		const records = result.map((r: WithdrawRequestRaw, i: number) => this._normalizeRecord(r, withdrawIds[i]));
		return { records, total: Number(total) };
	}

	async cancel(id: number): Promise<ethers.TransactionReceipt | null> {
		const tx = await this.contract.cancel(id);
		return tx.wait();
	}

	// ── Off-Ramp Deposits ─────────────────────────────────

	/** Deposit USDT directly (no swap needed) */
	async deposit(amount: bigint, bankRef: string, referrer: string): Promise<DepositResult> {
		const est = await this.contract.deposit.estimateGas(amount, bankRef, referrer);
		const tx = await this.contract.deposit(amount, bankRef, referrer, { gasLimit: est * 130n / 100n });
		return this._parseDepositReceipt(tx);
	}

	/** Swap native ETH/BNB → USDT and deposit */
	async depositETH(path: string[], minUsdtOut: bigint, bankRef: string, referrer: string, value: bigint): Promise<DepositResult> {
		const est = await this.contract.depositETH.estimateGas(path, minUsdtOut, bankRef, referrer, { value });
		const tx = await this.contract.depositETH(path, minUsdtOut, bankRef, referrer, { value, gasLimit: est * 130n / 100n });
		return this._parseDepositReceipt(tx);
	}

	/** Swap ERC20 token → USDT and deposit */
	async depositAndSwap(path: string[], amountIn: bigint, minUsdtOut: bigint, hasTax: boolean, bankRef: string, referrer: string): Promise<DepositResult> {
		const est = await this.contract.depositAndSwap.estimateGas(path, amountIn, minUsdtOut, hasTax, bankRef, referrer);
		const tx = await this.contract.depositAndSwap(path, amountIn, minUsdtOut, hasTax, bankRef, referrer, { gasLimit: est * 130n / 100n });
		return this._parseDepositReceipt(tx);
	}

	/** Parse WithdrawRequested event from a deposit transaction receipt */
	private async _parseDepositReceipt(tx: ethers.TransactionResponse): Promise<DepositResult> {
		const receipt = await tx.wait();
		let withdrawId = 0;
		let fee = 0n;
		let netAmount = 0n;
		let expiresAt = 0;

		for (const log of receipt?.logs || []) {
			try {
				const parsed = this.iface.parseLog({ topics: [...log.topics], data: log.data });
				if (parsed?.name === 'WithdrawRequested') {
					const args = parsed.args as unknown as WithdrawRequestedEventRaw;
					withdrawId = Number(args.id);
					fee = args.fee;
					netAmount = args.netAmount;
					expiresAt = Number(args.expiresAt);
					break;
				}
			} catch {}
		}

		return { tx, receipt, withdrawId, fee, netAmount, expiresAt };
	}

	// ── Admin ─────────────────────────────────────────────

	async getState(): Promise<RouterState> {
		const [o, f, t, pw, te, pc, tw, a, p, ms, mw, ae, asb] = await Promise.all([
			this.contract.owner(),
			this.contract.feeBps(),
			this.contract.payoutTimeout(),
			this.contract.platformWallet(),
			this.contract.totalEscrow(),
			this.contract.pendingCount(),
			this.contract.totalWithdrawals(),
			this.contract.getAdmins(),
			this.contract.paused(),
			this.contract.maxSlippageBps(),
			this.contract.minWithdrawUsdt().catch(() => 0n),
			this.contract.affiliateEnabled().catch(() => false),
			this.contract.affiliateShareBps().catch(() => 0),
		]);
		return {
			owner: o,
			feeBps: Number(f),
			payoutTimeout: Number(t),
			platformWallet: pw,
			totalEscrow: BigInt(te),
			pendingCount: Number(pc),
			totalWithdrawals: Number(tw),
			admins: [...a],
			paused: p,
			maxSlippageBps: Number(ms),
			minWithdrawUsdt: BigInt(mw),
			affiliateEnabled: Boolean(ae),
			affiliateShareBps: Number(asb),
		};
	}

	async platformEarnings(tokenAddress: string): Promise<bigint> {
		return this.contract.platformEarnings(tokenAddress);
	}

	// Admin write operations
	async pause(): Promise<ethers.TransactionReceipt | null> {
		return (await this.contract.pause()).wait();
	}

	async unpause(): Promise<ethers.TransactionReceipt | null> {
		return (await this.contract.unpause()).wait();
	}

	async setFeeBps(newFee: number): Promise<ethers.TransactionReceipt | null> {
		return (await this.contract.setFeeBps(newFee)).wait();
	}

	async setPayoutTimeout(seconds: number): Promise<ethers.TransactionReceipt | null> {
		return (await this.contract.setPayoutTimeout(seconds)).wait();
	}

	async setMaxSlippage(bps: number): Promise<ethers.TransactionReceipt | null> {
		return (await this.contract.setMaxSlippage(bps)).wait();
	}

	async setMinWithdrawUsdt(amount: bigint): Promise<ethers.TransactionReceipt | null> {
		return (await this.contract.setMinWithdrawUsdt(amount)).wait();
	}

	async setPlatformWallet(wallet: string): Promise<ethers.TransactionReceipt | null> {
		return (await this.contract.setPlatformWallet(wallet)).wait();
	}

	async addAdmin(admin: string): Promise<ethers.TransactionReceipt | null> {
		return (await this.contract.addAdmin(admin)).wait();
	}

	async removeAdmin(admin: string): Promise<ethers.TransactionReceipt | null> {
		return (await this.contract.removeAdmin(admin)).wait();
	}

	async withdraw(): Promise<ethers.TransactionReceipt | null>;
	async withdraw(to: string): Promise<ethers.TransactionReceipt | null>;
	async withdraw(to: string, amount: bigint): Promise<ethers.TransactionReceipt | null>;
	async withdraw(to?: string, amount?: bigint): Promise<ethers.TransactionReceipt | null> {
		if (to && amount) return (await this.contract['withdraw(address,uint256)'](to, amount)).wait();
		if (to) return (await this.contract['withdraw(address)'](to)).wait();
		return (await (this.contract['withdraw()'] as ethers.BaseContractMethod)()).wait();
	}

	async withdrawETH(): Promise<ethers.TransactionReceipt | null> {
		return (await this.contract.withdrawETH()).wait();
	}

	async withdrawFees(token: string): Promise<ethers.TransactionReceipt | null> {
		return (await this.contract.withdrawFees(token)).wait();
	}

	async rescueToken(token: string): Promise<ethers.TransactionReceipt | null> {
		return (await this.contract.rescueToken(token)).wait();
	}

	async setAffiliateEnabled(enabled: boolean): Promise<ethers.TransactionReceipt | null> {
		return (await this.contract.setAffiliateEnabled(enabled)).wait();
	}

	async setAffiliateShare(bps: number): Promise<ethers.TransactionReceipt | null> {
		return (await this.contract.setAffiliateShare(bps)).wait();
	}

	async confirm(id: number): Promise<ethers.TransactionReceipt | null>;
	async confirm(id: number, to: string): Promise<ethers.TransactionReceipt | null>;
	async confirm(id: number, to?: string): Promise<ethers.TransactionReceipt | null> {
		if (to) return (await this.contract['confirm(uint256,address)'](id, to)).wait();
		return (await this.contract['confirm(uint256)'](id)).wait();
	}

	async confirmBatch(ids: number[]): Promise<number> {
		const tx = await this.contract.confirmBatch(ids);
		await tx.wait();
		return Number(await this.contract.confirmBatch.staticCall(ids));
	}

	async refund(id: number): Promise<ethers.TransactionReceipt | null> {
		return (await this.contract.refund(id)).wait();
	}

	async getPendingWithdrawals(offset = 0, limit = 50): Promise<{ records: WithdrawalRecord[]; total: number }> {
		const [result, total] = await this.contract.getPendingWithdrawals(offset, limit);
		const records = result.map((r: WithdrawRequestRaw) => this._normalizeRecord(r));
		return { records, total: Number(total) };
	}

	/** Shared normalizer — unwraps timestamp bigints to numbers and canonicalizes addresses. */
	private _normalizeRecord(r: WithdrawRequestRaw, withdrawId?: bigint): WithdrawalRecord & { withdraw_id?: number } {
		return {
			withdraw_id: withdrawId !== undefined ? Number(withdrawId) : undefined,
			user: r.user?.toLowerCase(),
			token: r.token,
			grossAmount: r.grossAmount,
			fee: r.fee,
			netAmount: r.netAmount,
			createdAt: Number(r.createdAt),
			expiresAt: Number(r.expiresAt || 0n),
			status: Number(r.status),
			bankRef: r.bankRef,
			referrer: r.referrer?.toLowerCase() || ethers.ZeroAddress,
		} as WithdrawalRecord & { withdraw_id?: number };
	}
}
