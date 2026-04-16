/**
 * Background balance updater for embedded wallet users.
 * Prefers WebSocket event subscriptions (Transfer events) for instant updates.
 * Falls back to interval polling when WS is unavailable.
 *
 * Auto-discovers unknown tokens: when a Transfer event arrives from a contract
 * not in the imported list, we fetch its metadata and auto-import it.
 * Pauses when tab is hidden, resumes when visible.
 */
import { writable, get } from 'svelte/store';
import { ethers } from 'ethers';
import type { WsProviderManager, EventSubscription } from './wsProvider';
import { transferFilter, transferFromFilter } from './wsProvider';
import { resolveTokenLogo } from './tokenLogo';

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

const MULTICALL_ABI = [
	'function aggregate(tuple(address target, bytes callData)[] calls) view returns (uint256 blockNumber, bytes[] returnData)',
];
const BALANCE_OF_SIG = '0x70a08231';

const MULTICALL_ADDRESSES: Record<number, string> = {
	56: '0xcA11bde05977b3631167028862bE2a173976CA11',
	1: '0xcA11bde05977b3631167028862bE2a173976CA11',
	137: '0xcA11bde05977b3631167028862bE2a173976CA11',
	42161: '0xcA11bde05977b3631167028862bE2a173976CA11',
	8453: '0xcA11bde05977b3631167028862bE2a173976CA11',
};

let _interval: ReturnType<typeof setInterval> | null = null;
let _provider: ethers.JsonRpcProvider | null = null;
let _wsManager: WsProviderManager | null = null;
let _wsSubs: EventSubscription[] = [];
let _userAddress: string = '';
let _chainId: number = 56;
let _pollIntervalMs: number = 30_000;
let _visibilityHandler: (() => void) | null = null;
let _started = false;
let _generation = 0;
let _useWs = false;
let _debounceTimer: ReturnType<typeof setTimeout> | null = null;
let _pendingDiscovery = new Set<string>();
let _onTokenDiscovered: ((token: { address: string; symbol: string; name: string; decimals: number; logoUrl?: string }) => void) | null = null;

function getImportedTokens(): { address: string; symbol: string; name: string; decimals: number; logoUrl?: string }[] {
	try {
		const saved = localStorage.getItem('imported_tokens');
		if (saved) return JSON.parse(saved);
	} catch {}
	return [];
}

async function fetchBalances(): Promise<void> {
	if (!_provider || !_userAddress) return;

	const gen = _generation;
	const addr = _userAddress;
	const imported = getImportedTokens();
	const paddedAddr = ethers.zeroPadValue(addr, 32);
	const multicallAddr = MULTICALL_ADDRESSES[_chainId];

	try {
		const nativeBal = await _provider.getBalance(addr);

		let tokenBalances: TokenBalance[] = [];

		if (imported.length > 0 && multicallAddr) {
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
				tokenBalances = await fetchBalancesIndividual(imported);
			}
		} else if (imported.length > 0) {
			tokenBalances = await fetchBalancesIndividual(imported);
		}

		if (gen !== _generation) return;

		balanceState.set({
			nativeBalance: nativeBal,
			tokens: tokenBalances,
			lastUpdated: Date.now(),
		});
	} catch {}
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

function debouncedFetch() {
	if (_debounceTimer) clearTimeout(_debounceTimer);
	_debounceTimer = setTimeout(() => {
		_debounceTimer = null;
		fetchBalances();
	}, 500);
}

async function handleTransferLog(log: ethers.Log) {
	const tokenAddr = log.address.toLowerCase();

	const imported = getImportedTokens();
	if (imported.some(t => t.address.toLowerCase() === tokenAddr)) {
		debouncedFetch();
		return;
	}

	if (_pendingDiscovery.has(tokenAddr)) return;
	_pendingDiscovery.add(tokenAddr);

	try {
		if (!_provider) return;
		const c = new ethers.Contract(tokenAddr, [
			'function name() view returns (string)',
			'function symbol() view returns (string)',
			'function decimals() view returns (uint8)',
		], _provider);

		const [name, symbol, decimals] = await Promise.all([
			c.name().catch(() => ''),
			c.symbol().catch(() => ''),
			c.decimals().catch(() => 0),
		]);

		if (!symbol) return;

		const logoUrl = await resolveTokenLogo(tokenAddr, _chainId).catch(() => '');
		const token = { address: tokenAddr, symbol, name: name || symbol, decimals: Number(decimals), logoUrl };

		const current = getImportedTokens();
		if (current.some(t => t.address.toLowerCase() === tokenAddr)) return;
		current.push(token);
		try { localStorage.setItem('imported_tokens', JSON.stringify(current)); } catch {}

		_onTokenDiscovered?.(token);
	} catch {} finally {
		_pendingDiscovery.delete(tokenAddr);
	}

	debouncedFetch();
}

function subscribeWs() {
	unsubscribeWs();
	if (!_wsManager || !_userAddress) return;

	const incomingSub = _wsManager.subscribeLogs(
		_chainId,
		transferFilter(_userAddress),
		(log) => handleTransferLog(log),
	);
	_wsSubs.push(incomingSub);

	const outgoingSub = _wsManager.subscribeLogs(
		_chainId,
		transferFromFilter(_userAddress),
		() => debouncedFetch(),
	);
	_wsSubs.push(outgoingSub);

	_useWs = true;
}

function unsubscribeWs() {
	for (const sub of _wsSubs) sub.unsubscribe();
	_wsSubs = [];
	_useWs = false;
}

function startInterval() {
	stopInterval();
	fetchBalances();
	if (_useWs) {
		// WS active: use a slow safety-net poll (2 min) instead of 30s
		_interval = setInterval(fetchBalances, 120_000);
	} else {
		_interval = setInterval(fetchBalances, _pollIntervalMs);
	}
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

export function startBalancePoller(
	provider: ethers.JsonRpcProvider,
	userAddress: string,
	chainId: number = 56,
	intervalMs: number = 30_000,
	wsManager?: WsProviderManager | null,
): void {
	_provider = provider;
	_userAddress = userAddress;
	_chainId = chainId;
	_generation++;
	_pollIntervalMs = intervalMs;
	_started = true;
	_wsManager = wsManager ?? _wsManager;

	if (!_visibilityHandler) {
		_visibilityHandler = handleVisibility;
		document.addEventListener('visibilitychange', _visibilityHandler);
	}

	if (_wsManager) {
		subscribeWs();
	}

	startInterval();
}

export function stopBalancePoller(): void {
	_started = false;
	stopInterval();
	unsubscribeWs();

	if (_visibilityHandler) {
		document.removeEventListener('visibilitychange', _visibilityHandler);
		_visibilityHandler = null;
	}

	if (_debounceTimer) {
		clearTimeout(_debounceTimer);
		_debounceTimer = null;
	}

	balanceState.set({ nativeBalance: 0n, tokens: [], lastUpdated: 0 });
}

export function refreshBalancesNow(): void {
	if (_started) fetchBalances();
}

export function updatePollerAddress(address: string): void {
	_userAddress = address;
	_generation++;
	balanceState.set({ nativeBalance: 0n, tokens: [], lastUpdated: 0 });
	if (_started) {
		if (_wsManager) subscribeWs();
		fetchBalances();
	}
}

export function setWsManager(wsManager: WsProviderManager | null): void {
	_wsManager = wsManager;
	if (_started && wsManager) {
		subscribeWs();
		stopInterval();
		startInterval();
	} else if (_started && !wsManager) {
		unsubscribeWs();
		stopInterval();
		startInterval();
	}
}

export function onTokenDiscovered(
	cb: ((token: { address: string; symbol: string; name: string; decimals: number; logoUrl?: string }) => void) | null,
): void {
	_onTokenDiscovered = cb;
}
