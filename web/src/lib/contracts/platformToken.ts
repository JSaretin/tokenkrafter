import { ethers } from 'ethers';
import type { TaxDistributionRow } from '../structure';

/**
 * Minimal ABI for protection + tax-distribution reads on platform tokens
 * (clones of TaxableToken / TaxableMintableToken implementations).
 *
 * The full ABI lives in `structure/tokens/taxableToken.ts` as converter
 * helpers, but that file exports no concrete ABI array — so we declare
 * the narrow subset this client actually calls.
 */
const PLATFORM_TOKEN_READ_ABI = [
	'function maxWalletAmount() view returns (uint256)',
	'function maxTransactionAmount() view returns (uint256)',
	'function cooldownTime() view returns (uint256)',
	'function blacklistWindow() view returns (uint256)',
	'function tradingStartTime() view returns (uint256)',
	'function taxWallets(uint256) view returns (address)',
	'function taxSharesBps(uint256) view returns (uint16)',
	'function secondsUntilTradingOpens() view returns (uint256)',
	'function isExcludedFromLimits(address) view returns (bool)',
	'function isTaxFree(address) view returns (bool)',
	'function isAuthorizedLauncher(address) view returns (bool)',
	// ── Admin writes (creator-only for platform token clones) ──
	'function setExcludedFromLimits(address account, bool excluded) external',
	'function excludeFromTax(address account, bool exempt) external',
	'function setAuthorizedLauncher(address launcher, bool authorized) external',
	'function enableTrading(uint256 delay) external',
] as const;

export interface ProtectionSettings {
	maxWallet: bigint;
	maxTransaction: bigint;
	cooldownTime: bigint;
	blacklistWindow: bigint;
}

/**
 * Read-focused client for platform-issued tokens (TaxableToken family).
 * Wraps the inline ethers.Contract reads that used to live in the explore
 * page's onMount. Mirrors the TradeRouterClient shape: constructor takes
 * `(address, signerOrProvider)`, exposes typed methods.
 */
export class PlatformTokenClient {
	readonly contract: ethers.Contract;

	constructor(address: string, signerOrProvider: ethers.Signer | ethers.Provider) {
		this.contract = new ethers.Contract(address, PLATFORM_TOKEN_READ_ABI, signerOrProvider);
	}

	/** Create a new instance connected to a signer (for future write methods). */
	connect(signer: ethers.Signer): PlatformTokenClient {
		return new PlatformTokenClient(this.contract.target as string, signer);
	}

	/**
	 * Read the four anti-bot/MEV protection settings in parallel. Each read
	 * individually tolerates a revert (falls back to 0n) so a token that
	 * only implements a subset still returns a usable object.
	 */
	async getProtectionSettings(): Promise<ProtectionSettings> {
		const [maxWallet, maxTransaction, cooldownTime, blacklistWindow] = await Promise.all([
			this.contract.maxWalletAmount().catch(() => 0n),
			this.contract.maxTransactionAmount().catch(() => 0n),
			this.contract.cooldownTime().catch(() => 0n),
			this.contract.blacklistWindow().catch(() => 0n),
		]);
		return { maxWallet, maxTransaction, cooldownTime, blacklistWindow };
	}

	/**
	 * Seconds until the token's trading window opens. Returns:
	 *   - 0 when trading is currently open
	 *   - (max uint256) sentinel when enableTrading() has never been called
	 *   - otherwise the remaining anti-snipe lock seconds
	 */
	async secondsUntilTradingOpens(): Promise<bigint> {
		return BigInt(await this.contract.secondsUntilTradingOpens());
	}

	async isExcludedFromLimits(account: string): Promise<boolean> {
		return Boolean(await this.contract.isExcludedFromLimits(account));
	}

	async isTaxFree(account: string): Promise<boolean> {
		return Boolean(await this.contract.isTaxFree(account));
	}

	async isAuthorizedLauncher(account: string): Promise<boolean> {
		return Boolean(await this.contract.isAuthorizedLauncher(account));
	}

	// ── Writes ────────────────────────────────────────────

	/** Exclude/include `account` from wallet/transaction caps. Creator-only. */
	async setExcludedFromLimits(account: string, excluded: boolean): Promise<ethers.TransactionReceipt | null> {
		const tx = (await this.contract.setExcludedFromLimits(account, excluded)) as ethers.TransactionResponse;
		return tx.wait();
	}

	/** Mark `account` as tax-exempt. Creator-only. */
	async excludeFromTax(account: string, exempt: boolean): Promise<ethers.TransactionReceipt | null> {
		const tx = (await this.contract.excludeFromTax(account, exempt)) as ethers.TransactionResponse;
		return tx.wait();
	}

	/** Authorize a launcher contract (e.g. LaunchInstance) to enable trading on graduation. */
	async setAuthorizedLauncher(launcher: string, authorized: boolean): Promise<ethers.TransactionReceipt | null> {
		const tx = (await this.contract.setAuthorizedLauncher(launcher, authorized)) as ethers.TransactionResponse;
		return tx.wait();
	}

	/** Open trading with an optional anti-snipe delay in seconds. Creator-only. */
	async enableTrading(delaySeconds: bigint | number): Promise<ethers.TransactionReceipt | null> {
		const tx = (await this.contract.enableTrading(BigInt(delaySeconds))) as ethers.TransactionResponse;
		return tx.wait();
	}

	/**
	 * Walk the tax wallet / share-bps arrays until we hit the zero address
	 * sentinel or a revert (both mean "end of list"). The contract stores
	 * these as two parallel arrays; we zip them into {addr, shareBps} rows
	 * the UI can render directly.
	 *
	 * @param maxWallets hard upper bound on the walk (default 10 — matches
	 *                   MAX_TAX_WALLETS in the taxable token struct).
	 */
	async getTaxDistribution(maxWallets = 10): Promise<TaxDistributionRow[]> {
		const wallets: TaxDistributionRow[] = [];
		for (let i = 0; i < maxWallets; i++) {
			try {
				const [addr, share] = await Promise.all([
					this.contract.taxWallets(i),
					this.contract.taxSharesBps(i),
				]);
				if (addr === ethers.ZeroAddress) break;
				wallets.push({ addr, shareBps: Number(share) });
			} catch {
				break;
			}
		}
		return wallets;
	}
}
