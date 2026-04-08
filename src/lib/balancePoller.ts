/**
 * Background balance poller for embedded wallet users.
 * Polls native balance + all imported token balances using batch calls.
 * Pauses when tab is hidden, resumes when visible.
 */
import { writable, get } from 'svelte/store';
import { ethers } from 'ethers';

export interface TokenBalance {
	address: string;
	symbol: string;
	name: string;
	decimals: number;
	balance: bigint;
	logoUrl?: string;
}

export interface BalanceState {
	nativeBalance: bigint;
	tokens: TokenBalance[];
	lastUpdated: number;
}

export const balanceState = writable<BalanceState>({
	nativeBalance: 0n,
	tokens: [],
	lastUpdated: 0,
});

// ERC-20 multicall ABI fragment
const MULTICALL_ABI = [
	'function aggregate(tuple(address target, bytes callData)[] calls) view returns (uint256 blockNumber, bytes[] returnData)',
];
const BALANCE_OF_SIG = '0x70a08231'; // balanceOf(address)

// BSC multicall3 address (same on most EVM chains)
const MULTICALL_ADDRESSES: Record<number, string> = {
	56: '0xcA11bde05977b3631167028862bE2a173976CA11',
	1: '0xcA11bde05977b3631167028862bE2a173976CA11',
	137: '0xcA11bde05977b3631167028862bE2a173976CA11',
	42161: '0xcA11bde05977b3631167028862bE2a173976CA11',
	8453: '0xcA11bde05977b3631167028862bE2a173976CA11',
};

let _interval: ReturnType<typeof setInterval> | null = null;
let _provider: ethers.JsonRpcProvider | null = null;
let _userAddress: string = '';
let _chainId: number = 56;
let _pollIntervalMs: number = 30_000;
let _visibilityHandler: (() => void) | null = null;
let _started = false;
let _generation = 0; // incremented on address change to discard stale results

/** Get imported tokens from localStorage */
function getImportedTokens(): { address: string; symbol: string; name: string; decimals: number; logoUrl?: string }[] {
	try {
		const saved = localStorage.getItem('imported_tokens');
		if (saved) return JSON.parse(saved);
	} catch {}
	return [];
}

/** Fetch all balances in one batch via multicall */
async function fetchBalances(): Promise<void> {
	if (!_provider || !_userAddress) return;

	const gen = _generation;
	const addr = _userAddress;
	const imported = getImportedTokens();
	const paddedAddr = ethers.zeroPadValue(addr, 32);
	const multicallAddr = MULTICALL_ADDRESSES[_chainId];

	try {
		// Always fetch native balance
		const nativeBal = await _provider.getBalance(addr);

		let tokenBalances: TokenBalance[] = [];

		if (imported.length > 0 && multicallAddr) {
			// Use multicall for token balances
			const calls = imported.map(t => ({
				target: t.address,
				callData: BALANCE_OF_SIG + paddedAddr.slice(2),
			}));

			try {
				const multicall = new ethers.Contract(multicallAddr, MULTICALL_ABI, _provider);
				const [, returnData] = await multicall.aggregate(calls);

				tokenBalances = imported.map((t, i) => {
					let balance = 0n;
					try {
						const data = returnData[i];
						if (data && data !== '0x') {
							balance = BigInt(data);
						}
					} catch {}
					return {
						address: t.address,
						symbol: t.symbol,
						name: t.name,
						decimals: t.decimals,
						balance,
						logoUrl: t.logoUrl,
					};
				});
			} catch {
				// Multicall failed — fall back to individual calls
				tokenBalances = await fetchBalancesIndividual(imported);
			}
		} else if (imported.length > 0) {
			// No multicall on this chain — individual calls
			tokenBalances = await fetchBalancesIndividual(imported);
		}

		// Discard if address changed while fetching
		if (gen !== _generation) return;

		balanceState.set({
			nativeBalance: nativeBal,
			tokens: tokenBalances,
			lastUpdated: Date.now(),
		});
	} catch {
		// Silent fail — will retry on next poll
	}
}

async function fetchBalancesIndividual(
	imported: { address: string; symbol: string; name: string; decimals: number; logoUrl?: string }[]
): Promise<TokenBalance[]> {
	const results: TokenBalance[] = [];
	for (const t of imported) {
		let balance = 0n;
		try {
			const c = new ethers.Contract(t.address, ['function balanceOf(address) view returns (uint256)'], _provider!);
			balance = await c.balanceOf(_userAddress);
		} catch {}
		results.push({ address: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals, balance, logoUrl: t.logoUrl });
	}
	return results;
}

function startInterval() {
	stopInterval();
	// Fetch immediately
	fetchBalances();
	_interval = setInterval(fetchBalances, _pollIntervalMs);
}

function stopInterval() {
	if (_interval) {
		clearInterval(_interval);
		_interval = null;
	}
}

function handleVisibility() {
	if (document.hidden) {
		stopInterval();
	} else if (_started) {
		startInterval();
	}
}

/**
 * Start polling balances for an embedded wallet user.
 * Call once when wallet connects.
 */
export function startBalancePoller(
	provider: ethers.JsonRpcProvider,
	userAddress: string,
	chainId: number = 56,
	intervalMs: number = 30_000,
): void {
	_provider = provider;
	_userAddress = userAddress;
	_chainId = chainId;
	_generation++;
	_pollIntervalMs = intervalMs;
	_started = true;

	// Listen for tab visibility
	if (!_visibilityHandler) {
		_visibilityHandler = handleVisibility;
		document.addEventListener('visibilitychange', _visibilityHandler);
	}

	startInterval();
}

/** Stop polling. Call on disconnect. */
export function stopBalancePoller(): void {
	_started = false;
	stopInterval();

	if (_visibilityHandler) {
		document.removeEventListener('visibilitychange', _visibilityHandler);
		_visibilityHandler = null;
	}

	balanceState.set({ nativeBalance: 0n, tokens: [], lastUpdated: 0 });
}

/** Force an immediate refresh (e.g. after a transaction) */
export function refreshBalancesNow(): void {
	if (_started) fetchBalances();
}

/** Update the user address (e.g. on account switch) */
export function updatePollerAddress(address: string): void {
	_userAddress = address;
	_generation++;
	// Clear stale balances immediately
	balanceState.set({ nativeBalance: 0n, tokens: [], lastUpdated: 0 });
	if (_started) fetchBalances();
}
