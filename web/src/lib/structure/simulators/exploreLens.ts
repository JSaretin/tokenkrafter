import { ethers } from 'ethers';

/**
 * ExploreLens — constructor-only. Returns per-token market data (price via
 * USDT pair with WETH fallback, market cap, reserves, protection state).
 *
 * Price uses a numerator/denominator pair to avoid precision loss for
 * micro-cap tokens — frontend divides when formatting.
 *
 * Constructor args: (factory, dexFactory, weth, usdt, tokens[])
 * Returns: TokenData[] abi-encoded
 */

// ════════════════════════════════════════════════════════════════════════════
//  Raw / View
// ════════════════════════════════════════════════════════════════════════════

export interface TokenDataRaw {
	token: string;
	name: string;
	symbol: string;
	decimals: number;
	totalSupply: bigint;
	creator: string;
	owner: string;
	ownerIsZero: boolean;
	isMintable: boolean;
	isTaxable: boolean;
	isPartner: boolean;
	priceNumerator: bigint;
	priceDenominator: bigint;
	marketCap: bigint;           // in USDT native units
	hasLiquidity: boolean;
	reserveToken: bigint;
	reserveBase: bigint;
	pairAddress: string;
	holderCount: bigint;
	totalVolume: bigint;
	tradingEnabled: boolean;
	buyTaxBps: bigint;
	sellTaxBps: bigint;
	transferTaxBps: bigint;
	taxCeilingBuy: bigint;
	taxCeilingSell: bigint;
	maxWalletAmount: bigint;
	maxTransactionAmount: bigint;
}

export interface TokenDataView {
	token: string;
	name: string;
	symbol: string;
	decimals: number;
	totalSupply: string;
	creator: string;
	owner: string;
	ownerIsZero: boolean;
	isMintable: boolean;
	isTaxable: boolean;
	isPartner: boolean;
	/** Raw price ratio kept for precision; display via `price`. */
	priceNumerator: string;
	priceDenominator: string;
	/** Formatted token price in USDT (already accounts for decimals on both sides). */
	price: string;
	marketCap: string;           // formatted USDT
	hasLiquidity: boolean;
	reserveToken: string;
	reserveBase: string;
	pairAddress: string;
	holderCount: number;
	totalVolume: string;         // formatted token amount
	tradingEnabled: boolean;
	buyTaxPct: number;
	sellTaxPct: number;
	transferTaxPct: number;
	taxCeilingBuyPct: number;
	taxCeilingSellPct: number;
	maxWalletAmount: string;
	maxTransactionAmount: string;
}

// ════════════════════════════════════════════════════════════════════════════
//  Constructor params
// ════════════════════════════════════════════════════════════════════════════

export interface ConstructorParams {
	factory: string;
	dexFactory: string;
	weth: string;
	usdt: string;
	tokens: string[];
}
export type ConstructorParamsRaw = ConstructorParams;

// ════════════════════════════════════════════════════════════════════════════
//  Converters
// ════════════════════════════════════════════════════════════════════════════

const bpsToPct = (b: bigint | number) => Number(b) / 100;

export interface TokenDataViewOpts { usdtDecimals?: number; }

export function toTokenDataView(raw: TokenDataRaw, opts: TokenDataViewOpts = {}): TokenDataView {
	const dec = Number(raw.decimals);
	const ud = opts.usdtDecimals ?? 18;

	let price = '0';
	if (raw.priceDenominator > 0n) {
		// price in USDT per 1 token. priceNum/priceDen is in USDT-native per token-native.
		// Scale to (USDT per token) human number:
		// priceNum * 10^dec / (priceDen * 10^ud)
		const numScaled = raw.priceNumerator * 10n ** BigInt(dec);
		const denScaled = raw.priceDenominator * 10n ** BigInt(ud);
		if (denScaled > 0n) {
			// fixed-point: 18-decimal result
			const fixed = (numScaled * 10n ** 18n) / denScaled;
			price = ethers.formatUnits(fixed, 18);
		}
	}

	return {
		token: raw.token,
		name: raw.name,
		symbol: raw.symbol,
		decimals: dec,
		totalSupply: ethers.formatUnits(raw.totalSupply, dec),
		creator: raw.creator,
		owner: raw.owner,
		ownerIsZero: raw.ownerIsZero,
		isMintable: raw.isMintable,
		isTaxable: raw.isTaxable,
		isPartner: raw.isPartner,
		priceNumerator: raw.priceNumerator.toString(),
		priceDenominator: raw.priceDenominator.toString(),
		price,
		marketCap: ethers.formatUnits(raw.marketCap, ud),
		hasLiquidity: raw.hasLiquidity,
		reserveToken: ethers.formatUnits(raw.reserveToken, dec),
		reserveBase: ethers.formatUnits(raw.reserveBase, ud),
		pairAddress: raw.pairAddress,
		holderCount: Number(raw.holderCount),
		totalVolume: ethers.formatUnits(raw.totalVolume, dec),
		tradingEnabled: raw.tradingEnabled,
		buyTaxPct: bpsToPct(raw.buyTaxBps),
		sellTaxPct: bpsToPct(raw.sellTaxBps),
		transferTaxPct: bpsToPct(raw.transferTaxBps),
		taxCeilingBuyPct: bpsToPct(raw.taxCeilingBuy),
		taxCeilingSellPct: bpsToPct(raw.taxCeilingSell),
		maxWalletAmount: ethers.formatUnits(raw.maxWalletAmount, dec),
		maxTransactionAmount: ethers.formatUnits(raw.maxTransactionAmount, dec),
	};
}

export function toTokensDataView(raws: TokenDataRaw[], opts: TokenDataViewOpts = {}): TokenDataView[] {
	return raws.map(r => toTokenDataView(r, opts));
}
