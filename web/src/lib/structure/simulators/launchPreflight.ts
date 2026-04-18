/**
 * LaunchPreflight — constructor-only simulator. Returns a diagnostic report
 * about a token's suitability for the launchpad. Detects fee-on-transfer,
 * missing exclusions, tax interface presence, and ownership state.
 *
 * Usage (ethers.js):
 *   const args = abiCoder.encode(
 *     ['address','address','address','uint256'],
 *     [token, predictedLaunch, testFrom, testAmount]
 *   );
 *   const raw = await provider.call({ data: bytecode + args.slice(2), gasLimit: 30_000_000 });
 *   const decoded = abiCoder.decode(RESULT_TYPES, raw);
 */

// ════════════════════════════════════════════════════════════════════════════
//  Raw types
// ════════════════════════════════════════════════════════════════════════════

export interface ReportRaw {
	supportsIsExcludedFromLimits: boolean;
	supportsIsTaxFree: boolean;
	supportsIsAuthorizedLauncher: boolean;

	excludedFromLimits: boolean;
	taxFree: boolean;
	authorizedLauncher: boolean;

	hasKrafterTaxInterface: boolean;
	buyTaxBps: number;       // uint16
	sellTaxBps: number;      // uint16
	transferTaxBps: number;  // uint16
	taxCeilingLocked: boolean;

	feeOnTransferProbeRan: boolean;
	feeOnTransferDetected: boolean;
	expectedReceived: bigint;
	actualReceived: bigint;

	owner: string;
	isRenounced: boolean;

	totalSupply: bigint;
	decimals: number;        // uint8
	creatorBalance: bigint;

	safeForPlatformTokenRules: boolean;
	safeForExternalToken: boolean;
	blockedReason: string;
}

// ════════════════════════════════════════════════════════════════════════════
//  View types
// ════════════════════════════════════════════════════════════════════════════

export interface ReportView {
	supportsIsExcludedFromLimits: boolean;
	supportsIsTaxFree: boolean;
	supportsIsAuthorizedLauncher: boolean;

	excludedFromLimits: boolean;
	taxFree: boolean;
	authorizedLauncher: boolean;

	hasKrafterTaxInterface: boolean;
	buyTaxBps: number;
	sellTaxBps: number;
	transferTaxBps: number;
	taxCeilingLocked: boolean;

	feeOnTransferProbeRan: boolean;
	feeOnTransferDetected: boolean;
	expectedReceived: string;
	actualReceived: string;

	owner: string;
	isRenounced: boolean;

	totalSupply: string;
	decimals: number;
	creatorBalance: string;

	safeForPlatformTokenRules: boolean;
	safeForExternalToken: boolean;
	blockedReason: string;
}

// ════════════════════════════════════════════════════════════════════════════
//  Constructor params
// ════════════════════════════════════════════════════════════════════════════

export interface ConstructorParams {
	token: string;
	predictedLaunch: string;
	testFrom: string;        // address(0) to skip fee-on-transfer probe
	testAmount: string;      // human-readable token amount
	tokenDecimals: number;
}

export interface ConstructorParamsRaw {
	token: string;
	predictedLaunch: string;
	testFrom: string;
	testAmount: bigint;
}

// ════════════════════════════════════════════════════════════════════════════
//  Converters
// ════════════════════════════════════════════════════════════════════════════

import { ethers } from 'ethers';

export function toConstructorParamsRaw(p: ConstructorParams): ConstructorParamsRaw {
	return {
		token: p.token,
		predictedLaunch: p.predictedLaunch,
		testFrom: p.testFrom,
		testAmount: ethers.parseUnits(p.testAmount || '0', p.tokenDecimals),
	};
}

export function toReportView(raw: ReportRaw, tokenDecimals = 18): ReportView {
	return {
		supportsIsExcludedFromLimits: raw.supportsIsExcludedFromLimits,
		supportsIsTaxFree: raw.supportsIsTaxFree,
		supportsIsAuthorizedLauncher: raw.supportsIsAuthorizedLauncher,

		excludedFromLimits: raw.excludedFromLimits,
		taxFree: raw.taxFree,
		authorizedLauncher: raw.authorizedLauncher,

		hasKrafterTaxInterface: raw.hasKrafterTaxInterface,
		buyTaxBps: Number(raw.buyTaxBps),
		sellTaxBps: Number(raw.sellTaxBps),
		transferTaxBps: Number(raw.transferTaxBps),
		taxCeilingLocked: raw.taxCeilingLocked,

		feeOnTransferProbeRan: raw.feeOnTransferProbeRan,
		feeOnTransferDetected: raw.feeOnTransferDetected,
		expectedReceived: ethers.formatUnits(raw.expectedReceived, tokenDecimals),
		actualReceived: ethers.formatUnits(raw.actualReceived, tokenDecimals),

		owner: raw.owner,
		isRenounced: raw.isRenounced,

		totalSupply: ethers.formatUnits(raw.totalSupply, tokenDecimals),
		decimals: Number(raw.decimals),
		creatorBalance: ethers.formatUnits(raw.creatorBalance, tokenDecimals),

		safeForPlatformTokenRules: raw.safeForPlatformTokenRules,
		safeForExternalToken: raw.safeForExternalToken,
		blockedReason: raw.blockedReason,
	};
}
