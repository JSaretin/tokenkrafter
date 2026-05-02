export const TRADE_ROUTER_ABI = [
	// Swap — path-based routing (without deadline — defaults to block.timestamp + 300)
	'function swapTokens(address[] path, uint256 amountIn, uint256 amountOutMin, bool hasTax) external returns (uint256 amountOut)',
	'function swapETHForTokens(address[] path, uint256 amountOutMin, bool hasTax) external payable returns (uint256 amountOut)',
	'function swapTokensForETH(address[] path, uint256 amountIn, uint256 amountOutMin, bool hasTax) external returns (uint256 amountOut)',
	// Swap — with deadline
	'function swapTokens(address[] path, uint256 amountIn, uint256 amountOutMin, bool hasTax, uint256 deadline) external returns (uint256 amountOut)',
	'function swapETHForTokens(address[] path, uint256 amountOutMin, bool hasTax, uint256 deadline) external payable returns (uint256 amountOut)',
	'function swapTokensForETH(address[] path, uint256 amountIn, uint256 amountOutMin, bool hasTax, uint256 deadline) external returns (uint256 amountOut)',
	'function getAmountOut(address[] path, uint256 amountIn) external view returns (uint256)',

	// Off-ramp
	'function deposit(uint256 amount, bytes32 bankRef, address referrer) external returns (uint256 id)',
	'function depositAndSwap(address[] path, uint256 amountIn, uint256 minUsdtOut, bool hasTax, bytes32 bankRef, address referrer) external returns (uint256 id)',
	'function depositETH(address[] path, uint256 minUsdtOut, bytes32 bankRef, address referrer) external payable returns (uint256 id)',
	'function confirm(uint256 id) external',
	'function confirm(uint256 id, address to) external',
	'function confirmBatch(uint256[] ids) external returns (uint256 confirmed)',
	'function cancel(uint256 id) external',
	'function refund(uint256 id) external',
	'function getWithdrawal(uint256 id) view returns (tuple(address user, address token, uint256 grossAmount, uint256 fee, uint256 netAmount, uint256 createdAt, uint256 expiresAt, uint8 status, bytes32 bankRef, address referrer))',
	'function previewDeposit(uint256 amount) view returns (uint256 fee, uint256 netAmount)',

	// Views
	'function usdt() view returns (address)',
	'function weth() view returns (address)',
	'function feeBps() view returns (uint256)',
	'function payoutTimeout() view returns (uint256)',
	'function getUserWithdrawals(address user, uint256 offset, uint256 limit) view returns (tuple(address user, address token, uint256 grossAmount, uint256 fee, uint256 netAmount, uint256 createdAt, uint256 expiresAt, uint8 status, bytes32 bankRef, address referrer)[] result, uint256[] withdrawIds, uint256 total)',

	// Admin
	'function owner() view returns (address)',
	'function feeBps() view returns (uint256)',
	'function payoutTimeout() view returns (uint256)',
	'function platformWallet() view returns (address)',
	'function totalEscrow() view returns (uint256)',
	'function platformEarnings(address token) view returns (uint256)',
	'function pendingCount() view returns (uint256)',
	'function pendingIds(uint256) view returns (uint256)',
	'function getPendingWithdrawals(uint256 offset, uint256 limit) view returns (tuple(address user, address token, uint256 grossAmount, uint256 fee, uint256 netAmount, uint256 createdAt, uint256 expiresAt, uint8 status, bytes32 bankRef, address referrer)[] result, uint256 total)',
	'function totalWithdrawals() view returns (uint256)',
	'function getAdmins() view returns (address[])',
	'function getState() view returns (tuple(address owner, uint256 feeBps, uint256 payoutTimeout, address platformWallet, uint256 totalEscrow, uint256 pendingCount, uint256 totalWithdrawals, bool paused, uint256 maxSlippageBps, bool affiliateEnabled, uint256 affiliateShareBps, address[] admins))',
	'function paused() view returns (bool)',
	'function maxSlippageBps() view returns (uint256)',
	'function setFeeBps(uint256 newFee) external',
	'function setPayoutTimeout(uint256 newTimeout) external',
	'function setMaxSlippage(uint256 newBps) external',
	'function setMinWithdrawUsdt(uint256 newMin) external',
	'function minWithdrawUsdt() view returns (uint256)',
	'function setPlatformWallet(address wallet) external',
	'function addAdmin(address admin) external',
	'function removeAdmin(address admin) external',
	'function withdrawFees(address token) external',
	'function withdraw() external',
	'function withdraw(address to) external',
	'function withdraw(address to, uint256 amount) external',
	'function withdrawETH() external',
	'function rescueToken(address token) external',
	'function setAffiliateEnabled(bool enabled) external',
	'function setAffiliateShare(uint256 bps) external',
	'function affiliateEnabled() view returns (bool)',
	'function affiliateShareBps() view returns (uint256)',
	'function affiliateEarnings(address) view returns (uint256)',
	'function pause() external',
	'function unpause() external',

	// Events — match the deployed contract exactly. The previous short
	// shapes (no referrer/expiresAt on WithdrawRequested, no
	// gross/fee/token on WithdrawConfirmed) had a different topic[0]
	// hash, so parseLog threw on every receipt log. Symptom: the auto-
	// open WithdrawalStatusModal showed no countdown ring and never
	// flipped to Confirmed live (the chain event never matched the
	// FE filter). History click worked because it reads via
	// getWithdrawal() instead of parsing a receipt event.
	'event Swap(address indexed user, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)',
	'event WithdrawRequested(uint256 indexed id, address indexed user, address token, uint256 grossAmount, uint256 fee, uint256 netAmount, bytes32 bankRef, address referrer, uint256 expiresAt)',
	'event WithdrawConfirmed(uint256 indexed id, address indexed admin, address indexed to, uint256 netAmount, uint256 grossAmount, uint256 fee, address token)',
	'event WithdrawCancelled(uint256 indexed id, address indexed user, uint256 refundedAmount)',
	'event MinWithdrawUpdated(uint256 oldMin, uint256 newMin)',
	'event AffiliatePaid(uint256 indexed id, address indexed referrer, uint256 amount)'
];

// PancakeSwap / Uniswap V2 Router ABI (for direct swaps, no intermediary)
export const DEX_ROUTER_ABI = [
	'function WETH() view returns (address)',
	'function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) external',
	'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) external payable',
	'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) external',
	'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])',
];

export const WITHDRAW_STATUS = ['Pending', 'Confirmed', 'Cancelled'] as const;

export interface WithdrawRequest {
	user: string;
	token: string;
	grossAmount: bigint;
	fee: bigint;
	netAmount: bigint;
	createdAt: bigint;
	status: 0 | 1 | 2;
	bankRef: string;
	referrer: string;
}

export function withdrawStatusLabel(status: number): string {
	return WITHDRAW_STATUS[status] ?? 'Unknown';
}

export function withdrawStatusColor(status: number): string {
	switch (status) {
		case 0: return 'amber';
		case 1: return 'emerald';
		case 2: return 'red';
		default: return 'gray';
	}
}
