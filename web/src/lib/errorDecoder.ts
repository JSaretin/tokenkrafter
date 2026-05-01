/**
 * Contract error decoder.
 *
 * Unified friendly-message surface for every failure mode users can hit:
 *   - Custom errors from our contracts (TokenFactory, LaunchInstance, ...)
 *   - ethers v6 standard codes (user rejection, insufficient funds, network)
 *   - Revert strings from `require(msg, reason)` calls
 *
 * Usage:
 *   try { await contract.buy(...); }
 *   catch (e) {
 *     const decoded = decodeError(e);
 *     toast.error(decoded.friendly);
 *   }
 *
 * The registry is built from signature strings — each `error Foo()` in our
 * .sol files gets one entry. The 4-byte selector is computed at module load
 * via ethers.id / keccak256, so adding a new error is a one-line registry
 * update (no codegen, no ABI hashing to do manually).
 */

import { ethers } from 'ethers';

export interface DecodedError {
	/** The canonical error name, e.g. "BelowMinBuy" — empty if unknown. */
	name: string;
	/** User-facing message safe to show in a toast. */
	friendly: string;
	/** Category for logging / styling / retry decisions. */
	kind: 'custom' | 'revert' | 'rejected' | 'network' | 'funds' | 'unknown';
	/** Raw message for debug logs — never show this to users. */
	raw: string;
}

// ── Custom error registry ──────────────────────────────────────────────
//
// Each entry is `signature → friendly message`. Signatures MUST match the
// Solidity declaration exactly, including argument types. The selector
// (first 4 bytes of keccak256) is derived at module load.
const CUSTOM_ERRORS: Record<string, string> = {
	// TokenFactory
	'InvalidAddress()': 'Address is invalid.',
	'InvalidTokenType()': 'Unsupported token type.',
	'ImplementationNotSet()': 'Contract implementation missing. Contact support.',
	'TransferFailed()': 'Token transfer failed.',
	'CircularReferral()': 'Referral loop detected — pick a different referrer.',
	'NoRewards()': 'No rewards available to claim.',
	'NoBalance()': 'No balance available.',
	'InvalidParams()': 'One or more parameters are invalid.',
	'MaxLevelsExceeded()': 'Referral depth limit exceeded.',
	'TotalExceedsMax()': 'Total exceeds the allowed maximum.',
	'NotFactoryToken()': 'This token was not created by the factory.',
	'NotAuthorizedRouter()': 'Caller is not an authorized router.',

	// PlatformRouter
	'NativeTransferFailed()': 'Native coin transfer failed.',
	'InsufficientNativeValue()': 'Not enough native coin sent for the operation.',
	'ZeroAddress()': 'Zero address is not allowed.',
	'TokensForLaunchExceedsSupply()': 'Launch token amount exceeds total supply.',
	'ArrayLengthMismatch()': 'Mismatched array lengths in the request.',
	'InsufficientTokensForLiquidity()': 'Not enough tokens allocated to liquidity.',
	'BelowMinLiquidity()': 'Below the minimum liquidity threshold.',
	'InvalidFeePath()': 'Fee payment path is invalid — must end in USDT.',
	// NativeFeeWithNativeLp removed — router now splits msg.value between fee swap + LP wrap.

	// LaunchpadFactory
	'InvalidToken()': 'Token address is invalid.',
	'InvalidUsdt()': 'USDT address is invalid.',
	'InvalidCurveParam()': 'Curve parameter is out of range.',
	'InvalidRange()': 'Range is invalid.',
	'ZeroTokens()': 'Token amount must be greater than zero.',
	'MaxDaysExceeded()': 'Duration exceeds the allowed maximum.',
	'NotLaunchCreator()': 'Only the launch creator can do this.',
	'NotRegisteredLaunch()': 'Launch is not registered on the factory.',
	'TokenAlreadyHasLaunch()': 'This token already has an active launch.',
	'WithdrawFailed()': 'Withdrawal failed.',
	'OnlyLaunch()': 'Only a launch instance can call this.',
	'OnlyAuthorizedRouter()': 'Only an authorized router can call this.',

	// LaunchInstance
	'NotActive()': 'Launch is not active.',
	'NotCreator()': 'Only the creator can do this.',
	'InvalidCaps()': 'Soft/hard cap values are invalid.',
	'InvalidDuration()': 'Duration is outside the allowed range (7–90 days).',
	'InvalidMaxBuy()': 'Max buy per wallet must be between 0.5% and 5%.',
	'InvalidCreatorAlloc()': 'Creator allocation exceeds 5%.',
	'InvalidVesting()': 'Vesting period must be 0, 30, 60, or 90 days.',
	'CreatorAllocRequiresVesting()': 'Creator allocation requires a vesting period.',
	'NotPending()': 'Launch is not pending.',
	'ZeroAmount()': 'Amount must be greater than zero.',
	'InsufficientTokenBalance()': 'Not enough tokens deposited to the launch.',
	'OnlyFactory()': 'Only the factory can call this.',
	'NothingDeposited()': 'Nothing has been deposited yet.',
	'SendNativeCoin()': 'Native coin amount does not match msg.value.',
	'LaunchExpired()': 'Launch has expired.',
	'AmountTooSmall()': 'Amount is too small to produce any tokens.',
	'ExceedsMaxBuy()': 'This buy would exceed your per-wallet limit.',
	'SoftCapNotReached()': 'Soft cap has not been reached yet.',
	'OnlyCreatorCanGraduateEarly()': 'Only the creator can graduate early.',
	'NotRefunding()': 'Launch is not in the refund state.',
	'NothingToRefund()': 'You have nothing to refund.',
	'ReturnTokensToRefund()': 'You must return tokens to claim a refund.',
	'OutstandingRefundsRemain()': 'Outstanding refund requests remain.',
	'NoTokens()': 'No tokens available.',
	'NotGraduated()': 'Launch has not graduated yet.',
	'NoAllocation()': 'No allocation for this caller.',
	'CliffNotReached()': 'Vesting cliff has not been reached yet.',
	'NothingToClaim()': 'Nothing available to claim right now.',
	'NoETH()': 'No native coin balance to recover.',
	'DeadlineNotReached()': 'Launch deadline has not been reached.',
	'SoftCapAlreadyReached()': 'Soft cap has already been reached — refunds are not available.',
	'InsufficientTokensOut()': 'Slippage too high — fewer tokens than expected.',
	'LaunchNotStarted()': 'Launch has not started yet.',
	'InvalidStartTimestamp()': 'Start time must be in the future.',
	'InvalidPath()': 'Swap path is invalid.',
	'PathMustEndAtUsdt()': 'Swap path must end at USDT.',
	'StrandedSweepTooEarly()': 'Stranded-fund sweep is not yet allowed.',
	'AlreadyInitialized()': 'Launch has already been initialized.',
	'BelowMinBuy()': 'Amount is below the minimum buy floor.',
	'InvalidMinBuy()': 'Minimum buy value is out of range.',
	'SwapDeadlineExpired()': 'Swap deadline expired — please retry.',
	'AffiliateOverpull()': 'Affiliate fee accounting error — try again.',
	'Unauthorized()': 'You are not authorized to perform this action.',
	'ExceedsTokensRequired()': 'Deposit exceeds the tokens required for this launch.',
	'CurveOverflow()': 'Bonding-curve math overflowed — amount too large.',
	'AlreadyCancelled()': 'Launch has already been cancelled.',

	// TradeRouter
	'NotAdmin()': 'Caller is not an admin.',
	'InvalidFee()': 'Fee is outside the allowed range.',
	'InvalidTimeout()': 'Timeout is outside the allowed range.',
	'BelowMinWithdraw()': 'Amount is below the minimum withdrawal.',
	'InvalidRequest()': 'Withdrawal request is invalid.',
	'NotRequestOwner()': 'You do not own this withdrawal request.',
	'TimeoutNotReached()': 'Request cannot be cancelled yet.',
	'TimeoutReached()': 'Request has timed out.',
	'InsufficientEarnings()': 'Not enough platform earnings to withdraw.',
	'AlreadyAdmin()': 'Already an admin.',
	'NotAnAdmin()': 'Not an admin.',
	'CannotRemoveSelf()': 'You cannot remove yourself.',
	'SlippageTooHigh()': 'Slippage tolerance is set too loose — transaction blocked for safety.',
	'SlippageConfigTooHigh()': 'Maximum slippage configuration is too high.',
	'SlippageRequired()': 'Slippage tolerance is required for this trade.',
	'SlippageQuoteUnavailable()': 'Could not fetch a price quote — try again in a moment.',
	'EmptyPending()': 'No pending withdrawals.',
	'TooManyAdmins()': 'Admin limit reached.',
	'BankRefAlreadyUsed()': 'These bank details have already been used for an in-flight withdrawal. Use a different account or wait for the previous to settle.',
	'OnrampRefAlreadyUsed()': 'This on-ramp transaction has already been delivered. Refresh and try again.',
	'InsufficientReserve()': 'On-ramp reserve too low — please contact support.',
};

/** Map of 4-byte selector → { name, friendly }. Built lazily on first call. */
let _selectorMap: Map<string, { name: string; friendly: string }> | null = null;

function getSelectorMap(): Map<string, { name: string; friendly: string }> {
	if (_selectorMap) return _selectorMap;
	const map = new Map<string, { name: string; friendly: string }>();
	for (const [sig, friendly] of Object.entries(CUSTOM_ERRORS)) {
		const selector = ethers.id(sig).slice(0, 10); // "0x" + 8 hex = 4 bytes
		const name = sig.split('(')[0];
		map.set(selector.toLowerCase(), { name, friendly });
	}
	_selectorMap = map;
	return map;
}

/** Pull a hex data string out of an ethers error's various nested shapes. */
function extractErrorData(e: any): string | null {
	if (!e) return null;
	// ethers v6 typed revert
	if (typeof e.data === 'string' && e.data.startsWith('0x')) return e.data;
	// Nested under e.info.error.data (JsonRpcError wrap)
	const nested = e?.info?.error?.data;
	if (typeof nested === 'string' && nested.startsWith('0x')) return nested;
	// Double-nested for some providers
	const deeper = e?.error?.data;
	if (typeof deeper === 'string' && deeper.startsWith('0x')) return deeper;
	return null;
}

/**
 * Decode any caught error into a user-safe message + category.
 * Never throws — always returns a DecodedError.
 */
export function decodeError(e: unknown): DecodedError {
	const err = e as any;
	const raw = err?.shortMessage || err?.message || String(e);

	// 1. User rejection in wallet (Metamask, injected, embedded signer)
	if (err?.code === 'ACTION_REJECTED' || err?.code === 4001 || /user rejected|user denied/i.test(raw)) {
		return { name: 'UserRejected', friendly: 'Transaction cancelled.', kind: 'rejected', raw };
	}

	// 2. Insufficient gas funds
	if (err?.code === 'INSUFFICIENT_FUNDS' || /insufficient funds/i.test(raw)) {
		return {
			name: 'InsufficientFunds',
			friendly: 'Not enough native coin to cover gas.',
			kind: 'funds',
			raw,
		};
	}

	// 3. Network / RPC failure
	if (err?.code === 'NETWORK_ERROR' || err?.code === 'SERVER_ERROR' || err?.code === 'TIMEOUT') {
		return {
			name: 'NetworkError',
			friendly: 'Network unreachable. Try again in a moment.',
			kind: 'network',
			raw,
		};
	}

	// 4. ethers v6 pre-decoded custom error (happens when the contract ABI
	//    was attached to the Contract instance that produced the error)
	if (err?.revert?.name) {
		const friendly =
			CUSTOM_ERRORS[`${err.revert.name}()`] ||
			_guessFriendlyFromName(err.revert.name) ||
			err.revert.name;
		return { name: err.revert.name, friendly, kind: 'custom', raw };
	}

	// 5. Raw revert data — match selector against the registry
	const data = extractErrorData(err);
	if (data && data.length >= 10) {
		const selector = data.slice(0, 10).toLowerCase();
		const hit = getSelectorMap().get(selector);
		if (hit) return { name: hit.name, friendly: hit.friendly, kind: 'custom', raw };
	}

	// 6. Revert string from require(..., "reason")
	if (err?.reason && typeof err.reason === 'string') {
		return {
			name: 'Revert',
			friendly: _humanizeRevertString(err.reason),
			kind: 'revert',
			raw,
		};
	}

	// 7. Fallback — last-resort message
	return {
		name: 'Unknown',
		friendly: _guessFriendlyFromRaw(raw),
		kind: 'unknown',
		raw,
	};
}

/** Convert "BelowMinBuy" → "Below min buy" as a last-resort friendly string. */
function _guessFriendlyFromName(name: string): string {
	return name
		.replace(/([A-Z])/g, ' $1')
		.replace(/^./, (c) => c.toUpperCase())
		.trim();
}

/** Clean up common ugly patterns in raw revert strings. */
function _humanizeRevertString(reason: string): string {
	const trimmed = reason.trim();
	if (!trimmed) return 'Transaction reverted.';
	// Capitalize first letter for presentation
	return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/** Try to extract something meaningful from an opaque error message. */
function _guessFriendlyFromRaw(raw: string): string {
	if (!raw) return 'Something went wrong.';
	// Strip stack-trace noise and keep the first sentence
	const firstLine = raw.split('\n')[0].trim();
	if (firstLine.length > 160) return 'Transaction failed. Check the console for details.';
	return firstLine;
}

/** Convenience for UI code that just needs the friendly string. */
export function friendlyError(e: unknown): string {
	return decodeError(e).friendly;
}
