import { ethers } from 'ethers';

// ---------------------------------------------------------------------------
// Raw contract return types — values as ethers returns them (bigint / string)
// ---------------------------------------------------------------------------

export interface ERC20Raw {
	name: string;
	symbol: string;
	decimals: bigint;
	totalSupply: bigint;
	balance: bigint;
	allowance: bigint;
}

// ---------------------------------------------------------------------------
// Frontend-friendly type — human-readable numbers / formatted strings
// ---------------------------------------------------------------------------

export interface ERC20Token {
	name: string;
	symbol: string;
	decimals: number;
	totalSupply: string;   // formatted with decimals (e.g. "1000000.0")
	balance: string;       // formatted with decimals
	allowance: string;     // formatted with decimals
}

// ---------------------------------------------------------------------------
// Converters
// ---------------------------------------------------------------------------

/** Convert raw contract values into a frontend-friendly ERC20Token. */
export function toERC20Token(raw: ERC20Raw): ERC20Token {
	const decimals = Number(raw.decimals);
	return {
		name: raw.name,
		symbol: raw.symbol,
		decimals,
		totalSupply: ethers.formatUnits(raw.totalSupply, decimals),
		balance: ethers.formatUnits(raw.balance, decimals),
		allowance: ethers.formatUnits(raw.allowance, decimals),
	};
}

/** Convert a frontend ERC20Token back to raw bigint values. */
export function toERC20Raw(token: ERC20Token): ERC20Raw {
	return {
		name: token.name,
		symbol: token.symbol,
		decimals: BigInt(token.decimals),
		totalSupply: ethers.parseUnits(token.totalSupply, token.decimals),
		balance: ethers.parseUnits(token.balance, token.decimals),
		allowance: ethers.parseUnits(token.allowance, token.decimals),
	};
}
