import { ethers } from 'ethers';

/**
 * RouteFinder — constructor-only simulator (never deployed).
 * Finds all viable swap routes between two tokens, sorted best-output first.
 *
 * Constructor args: (dexRouter, inToken, outToken, amountIn, bases[])
 * Returns: Route[] abi-encoded
 */

// ════════════════════════════════════════════════════════════════════════════
//  Raw / View
// ════════════════════════════════════════════════════════════════════════════

export interface RouteRaw {
	path: string[];
	amountOut: bigint;
	reserveIn: bigint;
	reserveOut: bigint;
}

export interface RouteView {
	path: string[];
	symbols?: string[];         // caller may fill in
	amountOut: string;          // formatted with outToken decimals
	hops: number;
	reserveIn: string;          // formatted with limiting pool's input side
	reserveOut: string;
}

// ════════════════════════════════════════════════════════════════════════════
//  Constructor params
// ════════════════════════════════════════════════════════════════════════════

export interface ConstructorParams {
	dexRouter: string;
	inToken: string;
	outToken: string;
	amountIn: string;           // human amount of inToken
	bases: string[];
	inTokenDecimals: number;
}
export interface ConstructorParamsRaw {
	dexRouter: string;
	inToken: string;
	outToken: string;
	amountIn: bigint;
	bases: string[];
}

export function toConstructorParamsRaw(p: ConstructorParams): ConstructorParamsRaw {
	return {
		dexRouter: p.dexRouter,
		inToken: p.inToken,
		outToken: p.outToken,
		amountIn: ethers.parseUnits(p.amountIn || '0', p.inTokenDecimals),
		bases: p.bases,
	};
}

// ════════════════════════════════════════════════════════════════════════════
//  Converters
// ════════════════════════════════════════════════════════════════════════════

export interface RouteViewOpts {
	outTokenDecimals?: number;
	/** Reserve decimals depend on the limiting pool's token sides — pass both. */
	reserveInDecimals?: number;
	reserveOutDecimals?: number;
}

export function toRouteView(raw: RouteRaw, opts: RouteViewOpts = {}): RouteView {
	return {
		path: raw.path,
		amountOut: ethers.formatUnits(raw.amountOut, opts.outTokenDecimals ?? 18),
		hops: Math.max(0, raw.path.length - 1),
		reserveIn: ethers.formatUnits(raw.reserveIn, opts.reserveInDecimals ?? 18),
		reserveOut: ethers.formatUnits(raw.reserveOut, opts.reserveOutDecimals ?? 18),
	};
}

export function toRoutesView(raws: RouteRaw[], opts: RouteViewOpts = {}): RouteView[] {
	return raws.map(r => toRouteView(r, opts));
}
