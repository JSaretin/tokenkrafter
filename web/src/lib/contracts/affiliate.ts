/**
 * Minimal Affiliate.sol client. The contract pays referrers a share
 * (default 25%) of platform fees from launchpad buys. Referrers
 * accumulate a `pending` USDT balance and pull it via `claim()`.
 *
 * Resolve the deployed address per network from
 * `LaunchpadFactoryClient.affiliate()` rather than hard-coding —
 * platform_address rotates across redeploys.
 */
import { ethers } from 'ethers';

export const AFFILIATE_ABI = [
	'function shareBps() view returns (uint256)',
	'function minClaim() view returns (uint256)',
	'function totalPending() view returns (uint256)',
	'function getStats(address referrer) view returns (uint256 pending, uint256 totalEarned, uint256 totalClaimed, uint32 referredCount, uint32 actionCount, uint64 lastActionAt)',
	'function claim() external',
	'event Claimed(address indexed referrer, uint256 amount)',
	'event Reported(address indexed user, address indexed referrer, uint256 platformFee, uint256 cut)',
];

export interface AffiliateStats {
	pending: bigint;
	totalEarned: bigint;
	totalClaimed: bigint;
	referredCount: number;
	actionCount: number;
	lastActionAt: number;
}

export class AffiliateClient {
	contract: ethers.Contract;

	constructor(address: string, runner: ethers.ContractRunner) {
		this.contract = new ethers.Contract(address, AFFILIATE_ABI, runner);
	}

	async getStats(referrer: string): Promise<AffiliateStats> {
		const r = await this.contract.getStats(referrer);
		return {
			pending: r.pending,
			totalEarned: r.totalEarned,
			totalClaimed: r.totalClaimed,
			referredCount: Number(r.referredCount),
			actionCount: Number(r.actionCount),
			lastActionAt: Number(r.lastActionAt),
		};
	}

	async minClaim(): Promise<bigint> {
		return this.contract.minClaim();
	}

	async claim(): Promise<ethers.TransactionReceipt | null> {
		const tx = (await this.contract.claim()) as ethers.TransactionResponse;
		return tx.wait();
	}
}
