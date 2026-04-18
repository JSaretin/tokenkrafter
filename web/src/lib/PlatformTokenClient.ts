import { ethers } from 'ethers';
import type { TaxDistributionRow } from './structure';

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
