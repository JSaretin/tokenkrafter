import { ethers } from 'ethers';

export const TRADE_ROUTER_ABI = [
	// Swap
	'function swapTokens(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin, bool hasTax) external returns (uint256 amountOut)',
	'function swapETHForTokens(address tokenOut, uint256 amountOutMin, bool hasTax) external payable returns (uint256 amountOut)',
	'function swapTokensForETH(address tokenIn, uint256 amountIn, uint256 amountOutMin, bool hasTax) external returns (uint256 amountOut)',
	'function getAmountOut(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256)',

	// Off-ramp
	'function deposit(uint256 amount, bytes32 bankRef) external returns (uint256 id)',
	'function depositAndSwap(address tokenIn, uint256 amountIn, uint256 minUsdtOut, bool hasTax, bytes32 bankRef) external returns (uint256 id)',
	'function depositETH(uint256 minUsdtOut, bytes32 bankRef) external payable returns (uint256 id)',
	'function confirm(uint256 id) external',
	'function confirmBatch(uint256[] ids) external returns (uint256 confirmed)',
	'function cancel(uint256 id) external',
	'function getWithdrawal(uint256 id) view returns (tuple(address user, address token, uint256 grossAmount, uint256 fee, uint256 netAmount, uint256 createdAt, uint8 status, bytes32 bankRef))',
	'function previewDeposit(uint256 amount) view returns (uint256 fee, uint256 netAmount)',

	// Views
	'function usdt() view returns (address)',
	'function weth() view returns (address)',
	'function feeBps() view returns (uint256)',
	'function payoutTimeout() view returns (uint256)',
	'function getUserWithdrawals(address user, uint256 offset, uint256 limit) view returns (tuple(address user, address token, uint256 grossAmount, uint256 fee, uint256 netAmount, uint256 createdAt, uint8 status, bytes32 bankRef)[] result, uint256 total)',

	// Events
	'event Swap(address indexed user, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)',
	'event WithdrawRequested(uint256 indexed id, address indexed user, address token, uint256 grossAmount, uint256 fee, uint256 netAmount, bytes32 bankRef)',
	'event WithdrawConfirmed(uint256 indexed id, address indexed admin)',
	'event WithdrawCancelled(uint256 indexed id, address indexed user)'
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
