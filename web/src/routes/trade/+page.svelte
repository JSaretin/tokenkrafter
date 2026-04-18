<script lang="ts">
	import { ethers } from 'ethers';
	import { getContext, onMount } from 'svelte';
	import { page } from '$app/state';
	import type { SupportedNetwork, TradePageServerData, PlatformTokenRow, WithdrawalView, MergedWithdrawal } from '$lib/structure';
	import type { WsProviderManager, EventSubscription } from '$lib/wsProvider';
	import { ERC20_ABI, ZERO_ADDRESS } from '$lib/tokenCrafter';
	import { friendlyError } from '$lib/errorDecoder';
	import { ERC20_DECIMALS_ABI } from '$lib/commonABIs';
	import { WithdrawStatus, withdrawStatusLabel } from '$lib/structure/tradeRouter';
	import { TradeRouterClient } from '$lib/contracts/tradeRouter';
	import WithdrawalStatusModal from '$lib/WithdrawalStatusModal.svelte';
	import { apiFetch } from '$lib/apiFetch';
	import { queryTradeLens, getInstantQuote, getWeth, isCacheLoaded, getUsdValue, getCachedToken, findBestRoute as findBestRouteLocal, type TaxInfo, type SwapRoute } from '$lib/tradeLens';
	import { toTokenSlotView, toTradeAmountsView, toTradeActionView, formatAmount } from '$lib/structure/views/tradeView';
	import { findBestRoute as findBestRouteOnChain } from '$lib/routeFinder';
	import { pushPreferences } from '$lib/embeddedWallet';
	import { resolveTokenLogo } from '$lib/tokenLogo';
	import { t } from '$lib/i18n';
	import SwapCardShell from './SwapCardShell.svelte';
	import TokenInput from './TokenInput.svelte';
	import FlipButton from './FlipButton.svelte';
	import SpotRatePreview from './SpotRatePreview.svelte';
	import TradeDetails from './TradeDetails.svelte';
	import DetailLine from './DetailLine.svelte';
	import NoLiquidityNotice from './NoLiquidityNotice.svelte';
	import SwapActionButton from './SwapActionButton.svelte';
	import PayoutPreviewCard from './PayoutPreviewCard.svelte';
	import BankSelectorButton from './BankSelectorButton.svelte';
	import BankAccountField from './BankAccountField.svelte';
	import BankResolveStatus from './BankResolveStatus.svelte';
	import TrustCard from './TrustCard.svelte';
	import TrustItem from './TrustItem.svelte';
	import SlippageSetter from '$lib/SlippageSetter.svelte';
	import TokenSelectorModal from './TokenSelectorModal.svelte';
	import BankSelectorModal from './BankSelectorModal.svelte';
	import ConfirmModalShell from './ConfirmModalShell.svelte';
	import TradeStepperList, { type StepDef } from './TradeStepperList.svelte';
	import TradeStepperHeader from './TradeStepperHeader.svelte';
	import TradeCompletion from './TradeCompletion.svelte';
	import TradeReviewRow from './TradeReviewRow.svelte';
	import TradeReviewDetails from './TradeReviewDetails.svelte';
	import WithdrawalHistoryPanel from './WithdrawalHistoryPanel.svelte';
	import OutputModeToggle from './OutputModeToggle.svelte';

	let { data: serverData }: { data: TradePageServerData } = $props();

	let getSigner: () => ethers.Signer | null = getContext('signer');
	let getUserAddress: () => string | null = getContext('userAddress');
	let connectWallet: () => Promise<boolean> = getContext('connectWallet');
	const addFeedback = getContext<(f: { message: string; type: string }) => void>('addFeedback');
	let _getNetworks: () => SupportedNetwork[] = getContext('supportedNetworks');
	let supportedNetworks = $derived(_getNetworks());
	let getNetworkProviders: () => Map<number, ethers.JsonRpcProvider> = getContext('networkProviders');
	let getWsManager: () => WsProviderManager | null = getContext('wsManager');

	let signer = $derived(getSigner());
	let userAddress = $derived(getUserAddress());
	let networkProviders = $derived(getNetworkProviders());

	let tradeNetworks = $derived(supportedNetworks.filter(
		(n: SupportedNetwork) => n.trade_router_address && n.trade_router_address !== ''
	));

	// ── Core State ──────────────────────────────────────────────
	let selectedNetworkIdx = $state(0);
	let outputMode = $state<'token' | 'bank'>('token');

	// Token In
	let tokenInAddr = $state('');
	let tokenInSymbol = $state('');
	let tokenInName = $state('');
	let tokenInDecimals = $state(18);
	let tokenInBalance = $state(0n);
	let tokenInIsNative = $state(false);
	let tokenInTaxBuy = $state(0);
	let tokenInTaxSell = $state(0);
	let tokenInHasTax = $state(false);
	let tokenInLoading = $state(false);
	let tokenInLogo = $state('');

	// Token Out
	let tokenOutAddr = $state('');
	let tokenOutSymbol = $state('');
	let tokenOutName = $state('');
	let tokenOutDecimals = $state(18);
	let tokenOutBalance = $state(0n);
	let tokenOutIsNative = $state(false);
	let tokenOutTaxBuy = $state(0);
	let tokenOutTaxSell = $state(0);
	let tokenOutHasTax = $state(false);
	let tokenOutLogo = $state('');
	let tokenOutLoading = $state(false);

	// Token tax detection (from TradeLens simulation)
	let tokenInTax = $state<TaxInfo | null>(null);
	let tokenOutTax = $state<TaxInfo | null>(null);

	// Amounts
	let amountIn = $state('');
	let amountOut = $state('');
	let previewLoading = $state(false);
	let noLiquidity = $state(false);
	let swapRoute = $state<SwapRoute | null>(null);

	// Slippage — managed by SlippageSetter, shared via localStorage
	let slippageBps = $state(50);
	let showSettings = $state(false);

	// Swap state
	let isSwapping = $state(false);
	let showConfirmModal = $state(false);
	let swapStep = $state(0); // 0=idle, 1=approve, 2=swap, 3=done

	// Payment method
	let paymentMethod = $state<'bank' | 'paypal' | 'wise'>('bank');
	let previewFee = $state(0n);
	let previewNet = $state(0n);
	let payoutTimeoutMins = $state(0);
	let payoutTimeoutLoaded = $state(false);
	let minWithdrawUsdt = $state(0n);

	// Withdrawal step tracking (bank off-ramp)
	// 0=idle, 1=signing, 2=approving, 3=trading
	let withdrawStep = $state(0);

	// NGN rate lock — captured at confirm time so the processing modal
	// shows the same NGN figure as the confirmation screen.
	let lockedNgnRate = $state(0);
	let lockedNgnAmount = $state(0);

	// Exchange rates (spread already applied server-side in +page.server.ts)
	let fiatRates: Record<string, number> = $state(serverData?.fiatRates || {});
	let ngnRate = $derived(fiatRates['NGN'] || 0);
	// Use gross amount for NGN display (fee is hidden in the spread)
	// USDT decimals for the selected network (BSC USDT = 18, ETH USDT = 6)
	let usdtDecimals = $state(18);
	$effect(() => {
		if (!selectedNetwork?.usdt_address) return;
		const provider = networkProviders.get(selectedNetwork.chain_id);
		if (!provider) return;
		const token = new ethers.Contract(selectedNetwork.usdt_address, ERC20_DECIMALS_ABI, provider);
		token.decimals().then((d: bigint) => { usdtDecimals = Number(d); }).catch(() => {});
	});

	// Bank details
	let bankAccount = $state('');
	let bankCode = $state('');
	let bankName = $state(''); // resolved account holder name
	let bankBankName = $state(''); // bank institution name
	let bankResolving = $state(false);
	let bankResolved = $state(false);
	let bankError = $state('');
	let ngBanks: { code: string; name: string; slug: string; logo?: string; ussd?: string }[] = $derived(serverData?.ngBanks || []);
	let bankSearchQuery = $state('');
	let showBankDropdown = $state(false);
	let showBankModal = $state(false);

	// PayPal / Wise details
	let paypalEmail = $state('');
	let wiseEmail = $state('');
	let wiseCurrency = $state('NGN');

	// Token selector modal
	let showTokenModal = $state(false);
	let tokenModalTarget = $state<'in' | 'out'>('in');
	let tokenSearch = $state('');
	let platformTokens: { address: string; symbol: string; name: string; decimals: number; logo_url?: string }[] = $state(serverData?.platformTokens || []);
	// Platform tokens can never be honeypots — suppress false positives
	let platformTokenAddrs = $derived(new Set(platformTokens.map(t => t.address.toLowerCase())));

	// History
	let showHistory = $state(false);
	let historyPanel = $state<WithdrawalHistoryPanel | undefined>();
	let activeWithdrawal: WithdrawalView | null = $state(null);

	let selectedNetwork = $derived(tradeNetworks[selectedNetworkIdx]);

	function toWithdrawalView(w: MergedWithdrawal): WithdrawalView {
		const timedOut = w.status === WithdrawStatus.Pending && w.expiresAt > 0 && Date.now() / 1000 > w.expiresAt;
		return {
			id: w.id,
			withdraw_id: w.withdraw_id,
			chain_id: w.chain_id || selectedNetwork?.chain_id,
			wallet_address: userAddress || '',
			status: timedOut ? 'timeout' : withdrawStatusLabel(w.status).toLowerCase(),
			net_amount: w.netAmount?.toString() || w.grossAmount?.toString() || '0',
			fee: w.fee?.toString() || '0',
			gross_amount: w.grossAmount?.toString() || '0',
			payment_method: w.payment_method || 'bank',
			payment_details: w.payment_details || {},
			tx_hash: w.tx_hash || '',
			created_at: new Date(Number(w.createdAt) * 1000).toISOString(),
			expiresAt: w.expiresAt || 0,
		};
	}

	// ── Lock body scroll when any modal is open ──────────────
	let anyModalOpen = $derived(showTokenModal || showConfirmModal || showBankModal || !!activeWithdrawal);
	$effect(() => {
		if (typeof document !== 'undefined') {
			document.body.classList.toggle('modal-open', anyModalOpen);
		}
	});

	// ── Built-in token presets ──────────────────────────────────
	const TOKEN_LOGOS: Record<string, string> = {
		BNB: 'https://assets.coingecko.com/coins/images/825/small/bnb-icon2_2x.png',
		ETH: 'https://assets.coingecko.com/coins/images/279/small/ethereum.png',
		USDT: 'https://assets.coingecko.com/coins/images/325/small/Tether.png',
		USDC: 'https://assets.coingecko.com/coins/images/6319/small/usdc.png',
		BUSD: 'https://assets.coingecko.com/coins/images/9576/small/BUSD.png',
		MATIC: 'https://assets.coingecko.com/coins/images/4713/small/polygon.png',
	};

	let builtInTokens = $derived.by(() => {
		if (!selectedNetwork) return [];
		const nc = selectedNetwork.native_coin;
		const tokens: { address: string; symbol: string; name: string; decimals: number; isNative?: boolean; logo_url?: string }[] = [];
		tokens.push({ address: ZERO_ADDRESS, symbol: nc, name: nc, decimals: 18, isNative: true, logo_url: TOKEN_LOGOS[nc.toUpperCase()] });
		if (selectedNetwork.usdt_address) tokens.push({ address: selectedNetwork.usdt_address, symbol: 'USDT', name: 'Tether USD', decimals: 18, logo_url: TOKEN_LOGOS.USDT });
		if (selectedNetwork.usdc_address) tokens.push({ address: selectedNetwork.usdc_address, symbol: 'USDC', name: 'USD Coin', decimals: 18, logo_url: TOKEN_LOGOS.USDC });
		return tokens;
	});

	// ── Imported tokens (persisted to localStorage) ──────────
	type ImportedToken = { address: string; symbol: string; name: string; decimals: number; chainId: number; logo_url?: string };
	let importedTokens: ImportedToken[] = $state([]);

	// Load from localStorage on mount — merge both trade + wallet imported tokens
	function loadImportedTokens() {
		try {
			// Trade page tokens
			const stored = localStorage.getItem('importedTokens');
			if (stored) importedTokens = JSON.parse(stored);
		} catch {}
		// Also load wallet imported tokens (different localStorage key)
		try {
			const walletTokens = localStorage.getItem('imported_tokens');
			if (walletTokens) {
				const parsed = JSON.parse(walletTokens);
				for (const t of parsed) {
					const addr = t.address?.toLowerCase();
					if (addr && !importedTokens.find(x => x.address.toLowerCase() === addr)) {
						importedTokens.push({
							address: t.address,
							symbol: t.symbol || '???',
							name: t.name || 'Unknown',
							decimals: t.decimals || 18,
							chainId: 56,
							logo_url: t.logoUrl || '',
						});
					}
				}
			}
		} catch {}
		// Resolve missing logos via shared cache
		for (const t of importedTokens) {
			if (!t.logo_url && t.address) {
				resolveTokenLogo(t.address, t.chainId || 56).then(url => {
					if (url) {
						t.logo_url = url;
						importedTokens = [...importedTokens];
					}
				});
			}
		}
	}

	function saveImportedToken(token: ImportedToken) {
		if (importedTokens.find(t => t.address.toLowerCase() === token.address.toLowerCase() && t.chainId === token.chainId)) return;
		// Resolve logo before saving
		if (!token.logo_url && token.address) {
			resolveTokenLogo(token.address, token.chainId || 56).then(url => {
				if (url) {
					token.logo_url = url;
					importedTokens = [...importedTokens];
					try { localStorage.setItem('importedTokens', JSON.stringify(importedTokens)); } catch {}
				}
			});
		}
		importedTokens = [...importedTokens, token];
		try { localStorage.setItem('importedTokens', JSON.stringify(importedTokens)); } catch {}
		refreshPrices();
	}

	function removeImportedToken(address: string) {
		importedTokens = importedTokens.filter(t => t.address.toLowerCase() !== address.toLowerCase());
		try { localStorage.setItem('importedTokens', JSON.stringify(importedTokens)); } catch {}
	}

	// ── Auto-detect pasted address ────────────────────────────
	let pastedTokenMeta = $state<{ address: string; symbol: string; name: string; decimals: number; logo_url?: string } | null>(null);
	let pastedTokenLoading = $state(false);

	/** Fetch token logo from our DB or GeckoTerminal */
	async function fetchTokenLogoUrl(address: string): Promise<string> {
		return resolveTokenLogo(address, selectedNetwork?.chain_id || 56, selectedNetwork?.gecko_network || 'bsc');
	}

	$effect(() => {
		const q = tokenSearch.trim();
		pastedTokenMeta = null;
		if (!ethers.isAddress(q)) return;
		if (allTokens.find(t => t.address.toLowerCase() === q.toLowerCase())) return;

		pastedTokenLoading = true;
		fetchMeta(q, false).then(async (meta) => {
			if (tokenSearch.trim().toLowerCase() === q.toLowerCase() && meta.symbol !== '???') {
				const logo = TOKEN_LOGOS[meta.symbol.toUpperCase()] || await fetchTokenLogoUrl(q);
				pastedTokenMeta = { address: q, symbol: meta.symbol, name: meta.name, decimals: meta.decimals, logo_url: logo };
			}
		}).catch(() => {}).finally(() => { pastedTokenLoading = false; });
	});

	// DB search results (for token modal search)
	let dbSearchResults: typeof platformTokens = $state([]);
	let dbSearchLoading = $state(false);
	let dbSearchTimer: ReturnType<typeof setTimeout> | null = null;

	function searchTokensDB(query: string) {
		if (dbSearchTimer) clearTimeout(dbSearchTimer);
		if (!query || query.length < 2) { dbSearchResults = []; return; }
		dbSearchLoading = true;
		dbSearchTimer = setTimeout(async () => {
			try {
				const res = await fetch(`/api/created-tokens?search=${encodeURIComponent(query)}&limit=20`);
				if (res.ok) {
					const rows = await res.json();
					dbSearchResults = (rows as PlatformTokenRow[])
						.filter(t => t.address && t.symbol)
						.map(t => ({
							address: t.address,
							symbol: t.symbol,
							name: t.name || t.symbol,
							decimals: t.decimals || 18,
							logo_url: t.logo_url,
						}));
				}
			} catch {}
			dbSearchLoading = false;
		}, 300);
	}

	// Trigger DB search when token search query changes
	$effect(() => {
		const q = tokenSearch.trim();
		if (showTokenModal && q.length >= 2 && !ethers.isAddress(q)) {
			searchTokensDB(q);
		} else {
			dbSearchResults = [];
		}
	});

	/** Check if a token has liquidity (from TradeLens cache) */
	function hasLiquidity(address: string): boolean {
		if (!pricesLoaded) return true; // assume yes until we know
		if (address === ZERO_ADDRESS) return true; // native always liquid
		const cached = getCachedToken(address);
		return cached ? cached.hasLiquidity : false; // unknown tokens hidden after price load
	}

	let allTokens = $derived.by(() => {
		const chainId = selectedNetwork?.chain_id;
		const seen = new Set<string>();
		const combined: typeof builtInTokens = [];

		// 1. Built-in tokens first (native, USDT, USDC)
		for (const t of builtInTokens) {
			combined.push(t);
			seen.add(t.address.toLowerCase());
		}

		// 2. User-imported tokens (recently used, at the top after built-ins)
		for (const it of importedTokens) {
			const addr = it.address.toLowerCase();
			if (it.chainId === chainId && !seen.has(addr)) {
				combined.push(it);
				seen.add(addr);
			}
		}

		// 3. Platform tokens — only show ones with liquidity (after TradeLens loads)
		for (const pt of platformTokens) {
			const addr = pt.address.toLowerCase();
			if (!seen.has(addr) && hasLiquidity(addr)) {
				combined.push(pt);
				seen.add(addr);
			}
		}

		return combined;
	});

	let filteredTokens = $derived.by(() => {
		// In bank mode, show all tokens (no output token to exclude)
		// In swap mode, exclude the token already selected on the opposite side
		let list = allTokens;
		if (outputMode === 'token') {
			const excludeAddr = tokenModalTarget === 'in'
				? tokenOutAddr.toLowerCase()
				: tokenInAddr.toLowerCase();
			if (excludeAddr) {
				list = list.filter(t => t.address.toLowerCase() !== excludeAddr);
			}
		}

		const q = tokenSearch.toLowerCase().trim();
		if (!q) return list;

		// Filter local list
		const localMatches = list.filter(t =>
			t.symbol.toLowerCase().includes(q) ||
			t.name.toLowerCase().includes(q) ||
			t.address.toLowerCase().includes(q)
		);

		// Merge DB search results (for tokens not in the local list)
		const seen = new Set(localMatches.map(t => t.address.toLowerCase()));
		for (const r of dbSearchResults) {
			if (!seen.has(r.address.toLowerCase())) {
				localMatches.push(r);
				seen.add(r.address.toLowerCase());
			}
		}

		return localMatches;
	});

	// ── Data from server (platformTokens, ngBanks, fiatRates) — already loaded ──
	onMount(async () => {
		loadImportedTokens();

		// ── Fetch all token prices (instant quotes) ──────────────
		refreshPrices();

		// ── Default token selection (native coin → USDT) ─────────
		if (!tokenInAddr && builtInTokens.length > 0) {
			const native = builtInTokens.find(t => t.isNative);
			if (native) selectToken('in', native);
		}
		if (!tokenOutAddr && builtInTokens.length > 1) {
			const usdt = builtInTokens.find(t => t.symbol === 'USDT');
			if (usdt) selectToken('out', usdt);
		}

		// ── URL parameter pre-selection (overrides defaults) ─────
		await handleUrlParams();
	});

	// ── Price cache (MultiQuoter) ────────────────────────────
	let wethAddr = $state('');
	let pricesLoaded = $state(false);

	async function refreshPrices() {
		const net = selectedNetwork;
		if (!net?.dex_router) return;
		const provider = networkProviders.get(net.chain_id);
		if (!provider) return;

		try {
			const tokenAddrs = allTokens
				.map(t => t.isNative ? (wethAddr || '') : t.address)
				.filter(a => a && a !== ZERO_ADDRESS);

			for (const it of importedTokens) {
				if (it.chainId === net.chain_id && !tokenAddrs.find(a => a.toLowerCase() === it.address.toLowerCase())) {
					tokenAddrs.push(it.address);
				}
			}

			if (tokenAddrs.length === 0) return;

			// Prices only, no tax simulation (address(0) skips simulation)
			// Pass all base tokens so each token is checked against BNB, USDT, USDC pools
			const bases = [net.usdt_address, net.usdc_address].filter(a => a && a !== ZERO_ADDRESS);
			const result = await queryTradeLens(provider, net.dex_router, tokenAddrs, ethers.ZeroAddress, ethers.parseEther('0.001'), userAddress || ethers.ZeroAddress, net.chain_id, bases);
			wethAddr = result.weth;
			pricesLoaded = true;

			// Load payout timeout + min withdrawal from TradeRouter
			if (net.trade_router_address) {
				try {
					const router = new TradeRouterClient(net.trade_router_address, provider);
					const [timeout, minW] = await Promise.all([
						router.payoutTimeout(),
						router.minWithdrawUsdt(),
					]);
					payoutTimeoutMins = Math.ceil(timeout / 60);
					payoutTimeoutLoaded = true;
					minWithdrawUsdt = minW;
				} catch {}
			}

			// Update decimals + balances for selected tokens
			for (const t of result.tokens) {
				const tAddr = t.token.toLowerCase();
				if (tAddr === tokenInAddr.toLowerCase() && !tokenInIsNative) {
					tokenInDecimals = t.decimals;
					tokenInBalance = t.balance;
				}
				if (tAddr === tokenOutAddr.toLowerCase() && !tokenOutIsNative) {
					tokenOutDecimals = t.decimals;
					tokenOutBalance = t.balance;
				}
			}
			if (result.nativeBalance > 0n) {
				if (tokenInIsNative) tokenInBalance = result.nativeBalance;
				if (tokenOutIsNative) tokenOutBalance = result.nativeBalance;
				nativeBalance = result.nativeBalance;
			}
		} catch (e) {
			console.warn('Price refresh failed:', (e instanceof Error ? e.message : String(e)).slice(0, 80));
		}
	}

	// Refresh prices: WS-driven on Swap/Sync events, with polling fallback
	let _tradeSubs: EventSubscription[] = [];
	let _tradeDebounce: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		if (!selectedNetwork?.dex_router) return;
		// Only subscribe once both tokens are selected — an unscoped Sync
		// topic catches every PancakeSwap pair on the chain.
		const inAddr = tokenInAddr;
		const outAddr = tokenOutAddr;
		const ws = getWsManager();
		const chainId = selectedNetwork.chain_id;
		let interval: ReturnType<typeof setInterval>;

		for (const s of _tradeSubs) s.unsubscribe();
		_tradeSubs = [];

		if (ws && inAddr && outAddr && selectedNetwork.trade_router_address) {
			// Swap event on our TradeRouter — scoped to a single address.
			// External DEX trades (not through our router) are caught by the
			// polling fallback. This replaces the previous unscoped Sync
			// subscription that matched every PancakeSwap pair on the chain.
			const SWAP_TOPIC = ethers.id('Swap(address,address,address,uint256,uint256)');
			const swapSub = ws.subscribeLogs(chainId, {
				address: selectedNetwork.trade_router_address,
				topics: [SWAP_TOPIC],
			}, () => {
				if (_tradeDebounce) clearTimeout(_tradeDebounce);
				_tradeDebounce = setTimeout(() => { _tradeDebounce = null; refreshPrices(); }, 1000);
			});
			_tradeSubs.push(swapSub);
			interval = setInterval(refreshPrices, 120_000);
		} else if (ws) {
			interval = setInterval(refreshPrices, 120_000);
		} else {
			interval = setInterval(refreshPrices, 15000);
		}

		return () => {
			clearInterval(interval);
			if (_tradeDebounce) { clearTimeout(_tradeDebounce); _tradeDebounce = null; }
			for (const s of _tradeSubs) s.unsubscribe();
			_tradeSubs = [];
		};
	});

	async function handleUrlParams() {
		const urlFrom = page.url.searchParams.get('from');
		const urlTo = page.url.searchParams.get('to');
		const urlToken = page.url.searchParams.get('token');

		// Resolve "from" token (input side)
		if (urlFrom) {
			const matchedIn = findTokenBySymbolOrAddress(urlFrom);
			if (matchedIn) {
				selectToken('in', matchedIn);
			} else if (ethers.isAddress(urlFrom)) {
				const meta = await fetchMeta(urlFrom, false);
				selectToken('in', { address: urlFrom, symbol: meta.symbol, name: meta.name, decimals: meta.decimals });
			}
		}

		// Resolve "to" or "token" (output side)
		const target = urlToken || urlTo;
		if (target) {
			if (ethers.isAddress(target)) {
				const meta = await fetchMeta(target, false);
				selectToken('out', { address: target, symbol: meta.symbol, name: meta.name, decimals: meta.decimals });
			} else {
				// Try matching built-in / platform tokens by symbol first
				const matchedOut = findTokenBySymbolOrAddress(target);
				if (matchedOut) {
					selectToken('out', matchedOut);
				} else {
					// Resolve via token alias API
					try {
						const res = await fetch(`/api/token-alias?alias=${encodeURIComponent(target)}`);
						const data = await res.json();
						if (data.address) {
							const meta = await fetchMeta(data.address, false);
							selectToken('out', { address: data.address, symbol: meta.symbol, name: meta.name, decimals: meta.decimals });
						}
					} catch {}
				}
			}
		}
	}

	function findTokenBySymbolOrAddress(query: string): { address: string; symbol: string; name: string; decimals: number; isNative?: boolean } | undefined {
		const q = query.toLowerCase();
		return allTokens.find(
			(t) => t.symbol.toLowerCase() === q || t.address.toLowerCase() === q
		);
	}

	let filteredBanks = $derived.by(() => {
		const q = bankSearchQuery.toLowerCase().trim();
		if (!q) return ngBanks;
		return ngBanks.filter(b => b.name.toLowerCase().includes(q) || b.code.includes(q));
	});

	// ── Auto-resolve bank account ──────────────────────────────
	let resolveTimeout: ReturnType<typeof setTimeout> | null = null;
	$effect(() => {
		if (resolveTimeout) clearTimeout(resolveTimeout);
		const acc = bankAccount;
		const code = bankCode;
		bankResolved = false;
		bankName = '';
		bankError = '';

		if (!acc || acc.length !== 10 || !code) return;

		resolveTimeout = setTimeout(async () => {
			bankResolving = true;
			try {
				const res = await fetch('/api/bank/resolve', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ account_number: acc, account_bank: code })
				});
				const data = await res.json();
				if (data.account_name) {
					bankName = data.account_name;
					bankResolved = true;
					bankError = '';
				} else {
					bankError = data.error || $t('trade.accountNotFound');
					bankName = '';
				}
			} catch {
				bankError = $t('trade.failedVerifyAccount');
			} finally {
				bankResolving = false;
			}
		}, 500);
	});

	function selectBank(bank: { code: string; name: string }) {
		bankCode = bank.code;
		bankBankName = bank.name;
		bankSearchQuery = bank.name;
		showBankDropdown = false;
		bankResolved = false;
		bankName = '';
		bankError = '';
	}

	// ── Token metadata fetch ───────────────────────────────────
	async function fetchMeta(address: string, isNative: boolean) {
		if (!selectedNetwork) return { symbol: '???', name: 'Unknown', decimals: 18, balance: 0n };
		const provider = networkProviders.get(selectedNetwork.chain_id);
		if (!provider) return { symbol: '???', name: 'Unknown', decimals: 18, balance: 0n };

		if (isNative) {
			const bal = userAddress ? await provider.getBalance(userAddress) : 0n;
			return { symbol: selectedNetwork.native_coin, name: selectedNetwork.native_coin, decimals: 18, balance: bal };
		}

		try {
			const token = new ethers.Contract(address, [
				'function symbol() view returns (string)',
				'function name() view returns (string)',
				'function decimals() view returns (uint8)',
				'function balanceOf(address) view returns (uint256)'
			], provider);
			const [sym, name, dec, bal] = await Promise.all([
				token.symbol().catch(() => '???'),
				token.name().catch(() => 'Unknown'),
				token.decimals().catch(() => 18),
				userAddress ? token.balanceOf(userAddress).catch(() => 0n) : Promise.resolve(0n)
			]);
			return { symbol: sym, name, decimals: Number(dec), balance: bal };
		} catch {
			return { symbol: '???', name: 'Unknown', decimals: 18, balance: 0n };
		}
	}

	// ── Select token (optimistic — close modal instantly, fetch in background) ──
	function selectToken(target: 'in' | 'out', token: { address: string; symbol: string; name: string; decimals: number; isNative?: boolean; logo_url?: string }) {
		const isNative = !!token.isNative;
		const addr = token.address;

		// Close modal immediately (optimistic UI)
		showTokenModal = false;
		tokenSearch = '';

		// Set known values instantly
		if (target === 'in') {
			tokenInAddr = addr;
			tokenInSymbol = token.symbol;
			tokenInName = token.name;
			tokenInDecimals = token.decimals;
			tokenInIsNative = isNative;
			tokenInBalance = 0n;
			tokenInLoading = true;
			tokenInTax = null;
			tokenInTaxBuy = 0;
			tokenInTaxSell = 0;
			tokenInHasTax = false;
			tokenInLogo = token.logo_url || TOKEN_LOGOS[token.symbol.toUpperCase()] || '';
			if (!tokenInLogo && !isNative && addr) {
				resolveTokenLogo(addr, selectedNetwork?.chain_id || 56).then(url => { if (url && tokenInAddr === addr) tokenInLogo = url; });
			}
		} else {
			tokenOutAddr = addr;
			tokenOutSymbol = token.symbol;
			tokenOutName = token.name;
			tokenOutDecimals = token.decimals;
			tokenOutIsNative = isNative;
			tokenOutBalance = 0n;
			tokenOutLoading = true;
			tokenOutTax = null;
			tokenOutTaxBuy = 0;
			tokenOutTaxSell = 0;
			tokenOutHasTax = false;
			tokenOutLogo = token.logo_url || TOKEN_LOGOS[token.symbol.toUpperCase()] || '';
			if (!tokenOutLogo && !isNative && addr) {
				resolveTokenLogo(addr, selectedNetwork?.chain_id || 56).then(url => { if (url && tokenOutAddr === addr) tokenOutLogo = url; });
			}
		}

		// Fetch metadata quickly (balance, decimals, symbol)
		fetchMeta(addr, isNative).then(meta => {
			if (!isNative && selectedNetwork && meta.symbol !== '???') {
				saveImportedToken({ address: addr, symbol: meta.symbol, name: meta.name, decimals: meta.decimals, chainId: selectedNetwork.chain_id });
			}
			if (target === 'in' && tokenInAddr === addr) {
				tokenInBalance = meta.balance;
				tokenInDecimals = meta.decimals;
				tokenInSymbol = meta.symbol !== '???' ? meta.symbol : token.symbol;
				tokenInLoading = false;
			} else if (target === 'out' && tokenOutAddr === addr) {
				tokenOutBalance = meta.balance;
				tokenOutDecimals = meta.decimals;
				tokenOutSymbol = meta.symbol !== '???' ? meta.symbol : token.symbol;
				tokenOutLoading = false;
			}
		}).catch(() => {
			if (target === 'in') tokenInLoading = false;
			else tokenOutLoading = false;
		});

		// Run tax simulation via TradeLens (non-native tokens only)
		if (!isNative && selectedNetwork?.dex_router) {
			const provider = networkProviders.get(selectedNetwork.chain_id);
			if (provider) {
				// Collect all token addresses for batch query + simulate tax for the selected token
				const allAddrs = allTokens
					.map(t => t.isNative ? getWeth() || '' : t.address)
					.filter(a => a && a !== ZERO_ADDRESS);
				if (!allAddrs.find(a => a.toLowerCase() === addr.toLowerCase())) allAddrs.push(addr);

				const taxBases = [selectedNetwork.usdt_address, selectedNetwork.usdc_address].filter(a => a && a !== ZERO_ADDRESS);
				queryTradeLens(provider, selectedNetwork.dex_router, allAddrs, addr, ethers.parseEther('0.001'), userAddress || ethers.ZeroAddress, selectedNetwork.chain_id, taxBases).then(result => {
					pricesLoaded = true;
					wethAddr = result.weth;

					// Update decimals + balances from TradeLens for all selected tokens
					for (const t of result.tokens) {
						const tAddr = t.token.toLowerCase();
						if (tAddr === tokenInAddr.toLowerCase() && !tokenInIsNative) {
							tokenInDecimals = t.decimals;
							if (t.balance > 0n) tokenInBalance = t.balance;
						}
						if (tAddr === tokenOutAddr.toLowerCase() && !tokenOutIsNative) {
							tokenOutDecimals = t.decimals;
							if (t.balance > 0n) tokenOutBalance = t.balance;
						}
					}
					// Native balance
					if (result.nativeBalance > 0n) {
						if (tokenInIsNative) tokenInBalance = result.nativeBalance;
						if (tokenOutIsNative) tokenOutBalance = result.nativeBalance;
						nativeBalance = result.nativeBalance;
					}

					// Tax
					const tax = result.taxInfo;
					if (target === 'in' && tokenInAddr === addr) {
						tokenInTax = tax;
						tokenInTaxBuy = tax.buyTaxBps;
						tokenInTaxSell = tax.sellTaxBps;
						tokenInHasTax = tax.buyTaxBps > 0 || tax.sellTaxBps > 0;
					} else if (target === 'out' && tokenOutAddr === addr) {
						tokenOutTax = tax;
						tokenOutTaxBuy = tax.buyTaxBps;
						tokenOutTaxSell = tax.sellTaxBps;
						tokenOutHasTax = tax.buyTaxBps > 0 || tax.sellTaxBps > 0;
					}
				}).catch(e => {
					console.warn(`TradeLens failed:`, (e instanceof Error ? e.message : String(e)).slice(0, 200));
				});
			}
		}
	}

	// ── Custom address paste in modal ──────────────────────────
	function handleCustomAddress() {
		const addr = tokenSearch.trim();
		if (!ethers.isAddress(addr)) return;
		const meta = pastedTokenMeta && pastedTokenMeta.address.toLowerCase() === addr.toLowerCase()
			? pastedTokenMeta
			: { address: addr, symbol: '...', name: 'Loading...', decimals: 18 };

		// Save to localStorage for future visits
		if (selectedNetwork && meta.symbol !== '...') {
			saveImportedToken({ ...meta, chainId: selectedNetwork.chain_id });
		}

		selectToken(tokenModalTarget, meta);
	}

	// ── Flip tokens ────────────────────────────────────────────
	function flipTokens() {
		const tmpIn = {
			addr: tokenInAddr, sym: tokenInSymbol, name: tokenInName, dec: tokenInDecimals,
			native: tokenInIsNative, bal: tokenInBalance,
			taxB: tokenInTaxBuy, taxS: tokenInTaxSell, hasTax: tokenInHasTax, sim: tokenInTax, logo: tokenInLogo
		};
		const tmpOut = {
			addr: tokenOutAddr, sym: tokenOutSymbol, name: tokenOutName, dec: tokenOutDecimals,
			native: tokenOutIsNative, bal: tokenOutBalance,
			taxB: tokenOutTaxBuy, taxS: tokenOutTaxSell, hasTax: tokenOutHasTax, sim: tokenOutTax, logo: tokenOutLogo
		};

		// Swap in ← out
		tokenInAddr = tmpOut.addr; tokenInSymbol = tmpOut.sym; tokenInName = tmpOut.name;
		tokenInDecimals = tmpOut.dec; tokenInIsNative = tmpOut.native; tokenInBalance = tmpOut.bal;
		tokenInTaxBuy = tmpOut.taxB; tokenInTaxSell = tmpOut.taxS; tokenInHasTax = tmpOut.hasTax;
		tokenInTax = tmpOut.sim;
		tokenInLogo = tmpOut.logo;

		// Swap out ← in
		tokenOutAddr = tmpIn.addr; tokenOutSymbol = tmpIn.sym; tokenOutName = tmpIn.name;
		tokenOutDecimals = tmpIn.dec; tokenOutIsNative = tmpIn.native; tokenOutBalance = tmpIn.bal;
		tokenOutTaxBuy = tmpIn.taxB; tokenOutTaxSell = tmpIn.taxS; tokenOutHasTax = tmpIn.hasTax;
		tokenOutTax = tmpIn.sim;
		tokenOutLogo = tmpIn.logo;

		// Keep the input amount, clear output (preview will recalculate)
		amountOut = '';
	}

	// Old reserves cache removed — replaced by MultiQuoter

	// ── Preview swap (instant from cache + background on-chain) ──
	let previewTimeout: ReturnType<typeof setTimeout> | null = null;
	$effect(() => {
		if (previewTimeout) clearTimeout(previewTimeout);
		const amt = amountIn;
		const inAddr = tokenInAddr;
		const outAddr = tokenOutAddr;
		const net = selectedNetwork;

		if (!amt || !inAddr || !outAddr || !net || parseFloat(amt) <= 0 || outputMode === 'bank') {
			amountOut = '';
			noLiquidity = false;
			previewLoading = false;
			swapRoute = null;
			return;
		}

		// ── Instant calculation from TradeLens cache (0ms, local route) ──
		let hasInstant = false;
		try {
			if (pricesLoaded) {
				const sanitized = parseFloat(amt).toFixed(tokenInDecimals);
				const parsedIn = ethers.parseUnits(sanitized, tokenInDecimals);
				const addrIn = tokenInIsNative ? (wethAddr || getWeth()) : inAddr;
				const addrOut = tokenOutIsNative ? (wethAddr || getWeth()) : outAddr;

				const route = findBestRouteLocal(addrIn, addrOut, parsedIn);
				if (route && route.amountOut > 0n) {
					amountOut = ethers.formatUnits(route.amountOut, tokenOutDecimals);
					swapRoute = route;
					noLiquidity = false;
					hasInstant = true;
				} else {
					swapRoute = null;
				}
			}
		} catch {}

		// ── On-chain RouteFinder (single eth_call, finds best path through all bases) ──
		if (!hasInstant) previewLoading = true;
		previewTimeout = setTimeout(async () => {
			try {
				const provider = networkProviders.get(net.chain_id);
				if (!provider || !net.dex_router) return;

				const sanitized = parseFloat(amt).toFixed(tokenInDecimals);
				const parsedIn = ethers.parseUnits(sanitized, tokenInDecimals);
				const addrIn = tokenInIsNative ? ethers.ZeroAddress : inAddr;
				const addrOut = tokenOutIsNative ? ethers.ZeroAddress : outAddr;

				// Collect base tokens from network config
				const bases: string[] = [];
				const weth = wethAddr || getWeth();
				if (weth) bases.push(weth);
				if (net.usdt_address) bases.push(net.usdt_address);
				if (net.usdc_address) bases.push(net.usdc_address);
				for (const b of net.default_bases || []) {
					if (b.address && !bases.some((x: string) => x.toLowerCase() === b.address.toLowerCase())) {
						bases.push(b.address);
					}
				}

				const route = await findBestRouteOnChain(provider, net.dex_router, addrIn, addrOut, parsedIn, bases);
				if (route && route.amountOut > 0n) {
					amountOut = ethers.formatUnits(route.amountOut, tokenOutDecimals);
					// Map to SwapRoute format for the swap execution
					swapRoute = { path: route.path, symbols: [], amountOut: route.amountOut, hops: route.path.length - 1 };
					noLiquidity = false;
				} else if (!hasInstant) {
					amountOut = '';
					noLiquidity = true;
				}
			} catch {
				if (!hasInstant) {
					amountOut = '';
					noLiquidity = true;
				}
			} finally {
				previewLoading = false;
			}
		}, hasInstant ? 500 : 150);
	});

	// ── Preview bank fee ───────────────────────────────────────
	$effect(() => {
		if (outputMode !== 'bank') return;
		const amt = amountIn;
		const net = selectedNetwork;
		const inAddr = tokenInAddr;
		if (!amt || !net || !inAddr || parseFloat(amt) <= 0) { previewFee = 0n; previewNet = 0n; return; }
		(async () => {
			try {
				const provider = networkProviders.get(net.chain_id);
				if (!provider) return;
				const router = new TradeRouterClient(net.trade_router_address, provider);
				const sanitizedAmt = parseFloat(amt).toFixed(tokenInDecimals);
				const parsedAmt = ethers.parseUnits(sanitizedAmt, tokenInDecimals);

				// For non-USDT tokens, estimate USDT output accounting for token taxes
				let usdtAmount: bigint;
				const isUsdt = inAddr.toLowerCase() === net.usdt_address?.toLowerCase();
				if (isUsdt) {
					usdtAmount = parsedAmt;
				} else {
					const weth = await router.weth();
					const addrIn = tokenInIsNative ? weth : inAddr;
					// Build path for off-ramp quote
					const offRampPath = swapRoute?.path.length ? [...swapRoute.path] : (addrIn !== weth ? [addrIn, weth, net.usdt_address] : [addrIn, net.usdt_address]);
					if (offRampPath[offRampPath.length - 1].toLowerCase() !== net.usdt_address.toLowerCase()) offRampPath.push(net.usdt_address);
					// Raw DEX quote (before tax)
					let rawOut = await router.getAmountOut(offRampPath, parsedAmt);
					// Apply token taxes: transfer tax (user→router) + sell tax (router→DEX)
					const transferTax = tokenInTax?.transferTaxBps || 0;
					const sellTax = tokenInTax?.sellTaxBps || tokenInTaxSell || 0;
					const totalTax = transferTax + sellTax;
					if (totalTax > 0) {
						rawOut = (rawOut * BigInt(10000 - totalTax)) / 10000n;
					}
					usdtAmount = rawOut;
				}

				// Apply slippage tolerance — show worst-case output (skip for direct USDT, no swap)
				if (!isUsdt) {
					usdtAmount = (usdtAmount * BigInt(10000 - slippageBps)) / 10000n;
				}

				const { fee, netAmount: netAmt } = await router.previewDeposit(usdtAmount);
				previewFee = fee;
				previewNet = netAmt;
			} catch { previewFee = 0n; previewNet = 0n; }
		})();
	});

	// ── View-model: derived display strings for amounts / USD / rate / fiat ──
	// One pure function replaces ~12 individual $derived fallback chains.
	let tokenInSlot = $derived(toTokenSlotView({
		addr: tokenInAddr, symbol: tokenInSymbol, name: tokenInName, decimals: tokenInDecimals,
		balance: tokenInBalance, isNative: tokenInIsNative, hasTax: tokenInHasTax,
		taxBuy: tokenInTaxBuy, taxSell: tokenInTaxSell, taxInfo: tokenInTax,
		logo: tokenInLogo, loading: tokenInLoading,
	}, platformTokenAddrs));
	let tokenOutSlot = $derived(toTokenSlotView({
		addr: tokenOutAddr, symbol: tokenOutSymbol, name: tokenOutName, decimals: tokenOutDecimals,
		balance: tokenOutBalance, isNative: tokenOutIsNative, hasTax: tokenOutHasTax,
		taxBuy: tokenOutTaxBuy, taxSell: tokenOutTaxSell, taxInfo: tokenOutTax,
		logo: tokenOutLogo, loading: tokenOutLoading,
	}, platformTokenAddrs));

	let amounts = $derived(toTradeAmountsView({
		amountIn, amountOut, noLiquidity, slippageBps, outputMode,
		previewNet, usdtDecimals, ngnRate,
		tokenIn: tokenInSlot, tokenOut: tokenOutSlot,
		pricesLoaded, wethAddr, network: selectedNetwork,
	}));

	let withdrawSteps = $derived<StepDef[]>([
		{ n: 1, title: $t('trade.saveDetails'), desc: $t('trade.savingPaymentInfo'), activeDesc: $t('trade.savingDetails') },
		{ n: 2, title: $t('trade.approveToken'), desc: tokenInIsNative ? $t('trade.skippedForNative') : $t('trade.allowToken').replace('{symbol}', tokenInSymbol), activeDesc: tokenInIsNative ? $t('trade.skipping') : $t('trade.confirmInWallet') },
		{ n: 3, title: $t('trade.executeTrade'), desc: $t('trade.depositToContract'), activeDesc: $t('trade.confirmInWallet') }
	]);

	let swapSteps = $derived<StepDef[]>([
		{ n: 1, title: $t('trade.approveToken'), desc: tokenInIsNative ? $t('trade.skippedForNative') : $t('trade.allowToken').replace('{symbol}', tokenInSymbol), activeDesc: tokenInIsNative ? $t('trade.skipping') : $t('trade.confirmInWallet') },
		{ n: 2, title: $t('trade.executeSwap'), desc: $t('trade.tradeArrow').replace('{symbolIn}', tokenInSymbol).replace('{symbolOut}', tokenOutSymbol), activeDesc: $t('trade.confirmInWallet') }
	]);

	// ── Swap handler ───────────────────────────────────────────
	async function handleSwap() {
		if (!signer || !userAddress) { connectWallet(); return; }
		if (!selectedNetwork || !tokenInAddr || !amountIn || parseFloat(amountIn) <= 0) return;

		isSwapping = true;
		try {
			const router = new TradeRouterClient(selectedNetwork.trade_router_address, signer);
			// Sanitize amounts — truncate to max decimal places for the token
			const sanitizedIn = parseFloat(amountIn).toFixed(tokenInDecimals);
			const parsedIn = ethers.parseUnits(sanitizedIn, tokenInDecimals);
			let expectedOut = 0n;
			try {
				if (amountOut && parseFloat(amountOut) > 0) {
					const sanitizedOut = parseFloat(amountOut).toFixed(tokenOutDecimals);
					expectedOut = ethers.parseUnits(sanitizedOut, tokenOutDecimals);
				}
			} catch {}
			// Account for all applicable taxes + slippage in minOut:
			// - Transfer tax: triggers on transferFrom (user → router/DEX)
			// - Sell tax: triggers when selling into a DEX pool
			// - Buy tax: triggers when buying from a DEX pool (output token)
			const transferTaxIn = tokenInTax?.transferTaxBps || 0;
			const sellTax = tokenInTax?.sellTaxBps || tokenInTaxSell || 0;
			const buyTax = tokenOutTax?.buyTaxBps || tokenOutTaxBuy || 0;
			// Off-ramp: user→router (transfer tax) + router→DEX (sell tax), no buy tax on USDT
			// Swap: sell tax on input + buy tax on output (transfer tax applies if token has it)
			const isOfframp = outputMode === 'bank';
			const totalTaxBps = isOfframp
				? transferTaxIn + sellTax
				: sellTax + buyTax + transferTaxIn;
			const afterTax = totalTaxBps > 0
				? (expectedOut * BigInt(10000 - totalTaxBps)) / 10000n
				: expectedOut;
			const minOut = afterTax > 0n ? (afterTax * BigInt(10000 - slippageBps)) / 10000n : 0n;

			let tx;
			if (outputMode === 'bank') {
				// ── 3-step off-ramp flow ──────────────────────────
				const usdtGrossCheck = previewFee + previewNet;
				if (minWithdrawUsdt > 0n && usdtGrossCheck < minWithdrawUsdt) {
					addFeedback({ message: $t('trade.minimumWithdrawal').replace('{amount}', parseFloat(ethers.formatUnits(minWithdrawUsdt, usdtDecimals)).toFixed(2)), type: 'error' });
					isSwapping = false;
					return;
				}
				let paymentDetails: Record<string, unknown> = {};
				let bankRef: string;

				if (paymentMethod === 'bank') {
					if (!bankResolved || !bankAccount || !bankCode) {
						addFeedback({ message: $t('trade.verifyBankFirst'), type: 'error' });
						isSwapping = false;
						return;
					}
					paymentDetails = { method: 'bank', bank_code: bankCode, bank_name: bankBankName, account: bankAccount, holder: bankName };
					bankRef = ethers.id(`bank:${bankCode}:${bankAccount}:${bankName}`);
				} else if (paymentMethod === 'paypal') {
					if (!paypalEmail) {
						addFeedback({ message: $t('trade.enterPaypalEmail'), type: 'error' });
						isSwapping = false;
						return;
					}
					paymentDetails = { method: 'paypal', email: paypalEmail };
					bankRef = ethers.id(`paypal:${paypalEmail}`);
				} else {
					if (!wiseEmail) {
						addFeedback({ message: $t('trade.enterWiseEmail'), type: 'error' });
						isSwapping = false;
						return;
					}
					paymentDetails = { method: 'wise', email: wiseEmail, currency: wiseCurrency };
					bankRef = ethers.id(`wise:${wiseEmail}:${wiseCurrency}`);
				}

				// Step 1: Save payment details to DB (session cookie authenticates)
				withdrawStep = 1;
				// Use USDT-equivalent amounts (not input token amount)
				const usdtGross = previewFee + previewNet; // gross in USDT
				const preRes = await apiFetch('/api/withdrawals', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						chain_id: selectedNetwork.chain_id,
						wallet_address: userAddress,
						token_in: tokenInAddr,
						token_in_symbol: tokenInSymbol,
						gross_amount: usdtGross.toString(),
						fee: previewFee.toString(),
						net_amount: previewNet.toString(),
						payment_method: paymentMethod,
						payment_details: paymentDetails,
						locked_naira_rate: lockedNgnRate || ngnRate,
						locked_ngn_amount: lockedNgnAmount > 0 ? Math.floor(lockedNgnAmount) : Math.floor(parseFloat(ethers.formatUnits(previewNet, usdtDecimals)) * ngnRate),
					})
				});
				if (!preRes.ok) {
					const errData = await preRes.json().catch(() => ({ message: $t('trade.failedSavePayment') }));
					throw new Error(errData.message || $t('trade.failedSavePayment'));
				}
				const preData = await preRes.json();

				// Step 2: Approve token (skipped for native)
				withdrawStep = 2;
				if (!tokenInIsNative) {
					const erc20 = new ethers.Contract(tokenInAddr, ERC20_ABI, signer);
					const allowance = await erc20.allowance(userAddress, selectedNetwork.trade_router_address);
					if (allowance < parsedIn) {
						await (await erc20.approve(selectedNetwork.trade_router_address, parsedIn)).wait();
					}
				}

				// Step 3: Execute trade
				withdrawStep = 3;
				const referrer = ethers.ZeroAddress; // TODO: get from URL param or localStorage
				const weth = wethAddr || getWeth();
				const usdtAddr = selectedNetwork.usdt_address;
				let result;
				if (tokenInIsNative) {
					// ETH → USDT: build path through best intermediary
					const ethPath = swapRoute?.path.length
						? swapRoute.path.map(a => a.toLowerCase() === ethers.ZeroAddress.toLowerCase() ? weth : a)
						: [weth, usdtAddr];
					// Ensure path ends at USDT
					if (ethPath[ethPath.length - 1].toLowerCase() !== usdtAddr.toLowerCase()) {
						ethPath.push(usdtAddr);
					}
					result = await router.depositETH(ethPath, minOut, bankRef, referrer, parsedIn);
				} else if (tokenInAddr.toLowerCase() === usdtAddr.toLowerCase()) {
					result = await router.deposit(parsedIn, bankRef, referrer);
				} else {
					// Token → USDT: use best route path
					const tokenPath = swapRoute?.path.length
						? [...swapRoute.path]
						: [tokenInAddr, weth, usdtAddr];
					// Ensure path ends at USDT
					if (tokenPath[tokenPath.length - 1].toLowerCase() !== usdtAddr.toLowerCase()) {
						tokenPath.push(usdtAddr);
					}
					result = await router.depositAndSwap(tokenPath, parsedIn, minOut, true, bankRef, referrer);
				}
				const receipt = result.receipt;
				const withdrawId = result.withdrawId;
				const onChainFee = result.fee || previewFee;
				const onChainNet = result.netAmount || previewNet;
				const onChainExpiresAt = result.expiresAt;

				// Verify on-chain and link to DB record (session cookie authenticates)
				try {
					await apiFetch('/api/withdrawals/verify', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							tx_hash: receipt?.hash,
							chain_id: selectedNetwork.chain_id
						})
					});
				} catch {}

				withdrawStep = 4; // all done
				showConfirmModal = false;

				activeWithdrawal = {
					id: preData.id,
					withdraw_id: withdrawId,
					chain_id: selectedNetwork.chain_id,
					wallet_address: userAddress,
					status: 'pending',
					net_amount: onChainNet.toString(),
					fee: onChainFee.toString(),
					gross_amount: usdtGross.toString(),
					payment_method: paymentMethod,
					payment_details: paymentDetails,
					tx_hash: receipt?.hash || '',
					created_at: new Date().toISOString(),
					expiresAt: onChainExpiresAt,
				};

				// Reset form after capturing values
				amountIn = '';
				previewFee = 0n;
				previewNet = 0n;
			} else {
				// ── Direct swap via PancakeSwap (no TradeRouter intermediary) ──
				const dexRouterAddr = selectedNetwork.dex_router;
				const { DEX_ROUTER_ABI } = await import('$lib/tradeRouter');
				const dex = new ethers.Contract(dexRouterAddr, DEX_ROUTER_ABI, signer);
				const weth = wethAddr || await dex.WETH();

				// Step 1: Approve DEX router (not TradeRouter)
				swapStep = 1;
				if (!tokenInIsNative) {
					const erc20 = new ethers.Contract(tokenInAddr, ERC20_ABI, signer);
					const allowance = await erc20.allowance(userAddress, dexRouterAddr);
					if (allowance < parsedIn) {
						await (await erc20.approve(dexRouterAddr, parsedIn)).wait();
					}
				}

				// Build path using best route from TradeLens
				const addrIn = tokenInIsNative ? weth : tokenInAddr;
				const addrOut = tokenOutIsNative ? weth : tokenOutAddr;
				let path: string[];
				if (swapRoute && swapRoute.path.length >= 2) {
					// Use the optimal route found by findBestRoute
					path = swapRoute.path;
				} else if (addrIn !== weth && addrOut !== weth) {
					path = [addrIn, weth, addrOut]; // fallback: route through WETH
				} else {
					path = [addrIn, addrOut];
				}

				const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 min

				// Step 2: Execute swap directly on PancakeSwap
				swapStep = 2;
				try {
				if (tokenInIsNative) {
					const est = await dex.swapExactETHForTokensSupportingFeeOnTransferTokens.estimateGas(
						minOut, path, userAddress, deadline, { value: parsedIn });
					tx = await dex.swapExactETHForTokensSupportingFeeOnTransferTokens(
						minOut, path, userAddress, deadline, { value: parsedIn, gasLimit: est * 130n / 100n }
					);
				} else if (tokenOutIsNative) {
					const est2 = await dex.swapExactTokensForETHSupportingFeeOnTransferTokens.estimateGas(
						parsedIn, minOut, path, userAddress, deadline);
					tx = await dex.swapExactTokensForETHSupportingFeeOnTransferTokens(
						parsedIn, minOut, path, userAddress, deadline, { gasLimit: est2 * 130n / 100n }
					);
				} else {
					const est3 = await dex.swapExactTokensForTokensSupportingFeeOnTransferTokens.estimateGas(
						parsedIn, minOut, path, userAddress, deadline);
					tx = await dex.swapExactTokensForTokensSupportingFeeOnTransferTokens(
						parsedIn, minOut, path, userAddress, deadline, { gasLimit: est3 * 130n / 100n }
					);
				}
				const swapReceipt = await tx.wait();
				swapStep = 3; // done
				addFeedback({ message: $t('trade.swappedSuccess').replace('{amountIn}', amountIn).replace('{symbolIn}', tokenInSymbol).replace('{amountOut}', displayAmountOut).replace('{symbolOut}', tokenOutSymbol), type: 'success' });
				showConfirmModal = false;

				// Auto-import "to" token to wallet portfolio
				if (tokenOutAddr && tokenOutAddr !== ZERO_ADDRESS && tokenOutSymbol) {
					try {
						const saved = JSON.parse(localStorage.getItem('imported_tokens') || '[]');
						const exists = saved.some((t: { address?: string }) => t.address?.toLowerCase() === tokenOutAddr.toLowerCase());
						if (!exists) {
							saved.push({
								address: tokenOutAddr.toLowerCase(),
								name: tokenOutSymbol, // best we have
								symbol: tokenOutSymbol,
								decimals: tokenOutDecimals,
								logoUrl: allTokens.find(t => t.address.toLowerCase() === tokenOutAddr.toLowerCase())?.logo_url || '',
							});
							localStorage.setItem('imported_tokens', JSON.stringify(saved));
							pushPreferences();
						}
					} catch {}
				}
				} catch (swapErr: unknown) {
					console.error('Swap error:', swapErr);
					addFeedback({ message: friendlyError(swapErr), type: 'error' });
					swapStep = 0;
				}
			}

			amountIn = '';
			amountOut = '';
			// Refresh balance
			const meta = await fetchMeta(tokenInAddr, tokenInIsNative);
			tokenInBalance = meta.balance;
		} catch (e: unknown) {
			addFeedback({ message: friendlyError(e), type: 'error' });
		} finally {
			isSwapping = false;
			if (withdrawStep < 4) withdrawStep = 0; // don't reset if completed
			if (swapStep < 3) swapStep = 0;
		}
	}

	// ── History (from Supabase + Realtime) ────────────────────
	function safeBigInt(val: unknown): bigint {
		try {
			if (val === undefined || val === null || val === '') return 0n;
			const s = String(val).split('.')[0]; // strip decimals if any
			return BigInt(s);
		} catch { return 0n; }
	}

	async function handleCancel(id: number) {
		if (!signer || !selectedNetwork) return;
		try {
			const router = new TradeRouterClient(selectedNetwork.trade_router_address, signer);
			await router.cancel(id);
			addFeedback({ message: $t('trade.cancelledFundsReturned'), type: 'success' });
			historyPanel?.refresh();
		} catch (e: unknown) {
			addFeedback({ message: friendlyError(e), type: 'error' });
		}
	}

	// Refresh balances when wallet connects (user was browsing without wallet)
	$effect(() => {
		if (userAddress && tokenInAddr) {
			fetchMeta(tokenInAddr, tokenInIsNative).then(meta => { tokenInBalance = meta.balance; });
		}
		if (userAddress && tokenOutAddr) {
			fetchMeta(tokenOutAddr, tokenOutIsNative).then(meta => { tokenOutBalance = meta.balance; });
		}
	});

	// ── Gas balance check ─────────────────────────────────────
	let nativeBalance = $state(0n);
	let estimatedGasCost = $state(ethers.parseUnits('0.001', 18)); // default fallback

	// Fetch gas price and estimate cost
	$effect(() => {
		if (!selectedNetwork) return;
		const provider = networkProviders.get(selectedNetwork.chain_id);
		if (!provider) return;
		provider.getFeeData().then(fee => {
			const gasPrice = fee.gasPrice || fee.maxFeePerGas || 5000000000n; // fallback 5 gwei
			const swapGasUnits = 300000n; // typical swap gas
			estimatedGasCost = gasPrice * swapGasUnits;
		}).catch(() => {});
	});

	let hasGas = $derived(nativeBalance > estimatedGasCost);

	// Fetch native balance when wallet connects or network changes
	$effect(() => {
		if (!userAddress || !selectedNetwork) { nativeBalance = 0n; return; }
		const provider = networkProviders.get(selectedNetwork.chain_id);
		if (!provider) return;
		provider.getBalance(userAddress).then(b => { nativeBalance = b; }).catch(() => {});
	});

	// ── Button label ───────────────────────────────────────────
	// Button shows action label even without wallet — prompts connect on click
	// Insufficient balance check
	let insufficientBalance = $derived.by(() => {
		if (!userAddress || !tokenInAddr || !amountIn || parseFloat(amountIn) <= 0) return false;
		if (tokenInBalance === 0n) return true;
		try {
			const sanitized = parseFloat(amountIn).toFixed(tokenInDecimals);
			const needed = ethers.parseUnits(sanitized, tokenInDecimals);
			return needed > tokenInBalance;
		} catch { return false; }
	});

	let noGas = $derived(!!userAddress && !tokenInIsNative && !hasGas && !!tokenInAddr && !!amountIn);

	// Off-ramp floor: gross USDT output (before fee) must clear the router's
	// minWithdrawUsdt. Gate the submit button so users can't attempt a payout
	// that the contract will revert on.
	let belowMinWithdraw = $derived(
		outputMode === 'bank' &&
		minWithdrawUsdt > 0n &&
		(previewFee + previewNet) > 0n &&
		(previewFee + previewNet) < minWithdrawUsdt
	);

	let buttonLabel = $derived.by(() => {
		if (isSwapping) return $t('trade.processing');
		if (!tokenInAddr) return $t('trade.selectToken');
		if (!amountIn || parseFloat(amountIn) <= 0) return $t('trade.enterAmount');
		if (insufficientBalance) return $t('trade.insufficientBalance').replace('{symbol}', tokenInSymbol);
		if (noGas) return $t('trade.insufficientGas').replace('{symbol}', selectedNetwork?.native_coin || 'gas');
		if (noLiquidity && outputMode === 'token') return $t('trade.insufficientLiquidity');
		if (outputMode === 'bank') {
			if (belowMinWithdraw) {
				const min = parseFloat(ethers.formatUnits(minWithdrawUsdt, usdtDecimals)).toFixed(2);
				return $t('trade.minimumWithdrawal').replace('{amount}', min);
			}
			if (paymentMethod === 'bank' && (!bankResolved || !bankAccount || !bankCode)) return $t('trade.verifyBank');
			if (paymentMethod === 'paypal' && !paypalEmail) return $t('trade.enterPaypalEmail');
			if (paymentMethod === 'wise' && !wiseEmail) return $t('trade.enterWiseEmail');
			const methodLabel = paymentMethod === 'bank' ? $t('trade.bankPayment') : paymentMethod === 'paypal' ? $t('trade.paypalPayment') : $t('trade.wisePayment');
			return `${$t('common.sell')} ${tokenInSymbol} → ${methodLabel}`;
		}
		if (!tokenOutAddr) return $t('trade.selectOutputToken');
		return `${$t('trade.swap')} ${tokenInSymbol} → ${tokenOutSymbol}`;
	});

	let buttonDisabled = $derived(
		isSwapping ||
		!tokenInAddr || !amountIn || parseFloat(amountIn) <= 0 ||
		insufficientBalance || noGas ||
		(outputMode === 'token' && (!tokenOutAddr || noLiquidity)) ||
		(outputMode === 'bank' && (
			belowMinWithdraw ||
			(paymentMethod === 'bank' && (!bankResolved || !bankAccount || !bankCode)) ||
			(paymentMethod === 'paypal' && !paypalEmail) ||
			(paymentMethod === 'wise' && !wiseEmail)
		))
	);

	// ── Template aliases — flat names from view objects ──────────
	// Template expects flat names; surface them from the view objects.
	let displayAmountOut = $derived(amounts.displayAmountOut);
	let usdValueIn = $derived(amounts.usdValueIn);
	let usdValueOut = $derived(amounts.usdValueOut);
	let rate = $derived(amounts.rate);
	let spotRate = $derived(amounts.spotRate);
	let minReceived = $derived(amounts.minReceived);
	let fiatEquivalent = $derived(amounts.fiatEquivalent);
	let tokenInIsPlatform = $derived(tokenInSlot.isPlatform);
	let tokenOutIsPlatform = $derived(tokenOutSlot.isPlatform);

	// ── SwapCard composition helpers ─────────────────────────────
	let slippagePct = $derived((slippageBps / 100).toFixed(slippageBps % 100 === 0 ? 0 : slippageBps % 10 === 0 ? 1 : 2));
	let minUsd = $derived(amounts.minUsd);
	let confirmMinUsd = $derived(amounts.minUsd);
	let buttonVariant = $derived<'primary' | 'bank' | 'error'>(
		insufficientBalance || noGas ? 'error' : outputMode === 'bank' ? 'bank' : 'primary'
	);
	let contractUrl = $derived(
		selectedNetwork?.trade_router_address
			? `${selectedNetwork.explorer_url || 'https://bscscan.com'}/address/${selectedNetwork.trade_router_address}`
			: ''
	);
</script>

<svelte:head>
	<title>{$t('trade.pageTitle')}</title>
</svelte:head>

<div class="min-h-[calc(100vh-140px)] flex items-start justify-center px-4 pt-10 pb-15 max-sm:px-3 max-sm:pt-4 max-sm:pb-10">
	<div class="w-full max-w-115">

		<!-- Header -->
		<div class="flex justify-between items-start mb-5">
			<div>
				<h1 class="font-[Syne,sans-serif] text-2xl2 font-extrabold text-(--text-heading) m-0">{$t('trade.title')}</h1>
				<p class="font-mono text-xs text-(--text-muted) mt-1 mb-0">{$t('trade.subtitle')}</p>
			</div>
			<div class="flex gap-1.5">
				{#if userAddress}
					<button class={"w-9 h-9 rounded-[10px] border bg-(--bg-surface) cursor-pointer flex items-center justify-center transition-all duration-150 ease-in-out hover:text-cyan hover:border-[rgba(0,210,255,0.3)] hover:bg-[rgba(0,210,255,0.05)] " + (showHistory ? "text-cyan border-[rgba(0,210,255,0.3)] bg-[rgba(0,210,255,0.08)]" : "text-(--text-muted) border-(--border)")} onclick={() => { showHistory = !showHistory; if (!showHistory) return; setTimeout(() => document.getElementById('trade-history')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100); }} title={$t('trade.withdrawalHistoryTitle')}>
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
					</button>
				{/if}
				<button class={"w-9 h-9 rounded-[10px] border bg-(--bg-surface) cursor-pointer flex items-center justify-center transition-all duration-150 ease-in-out hover:text-cyan hover:border-[rgba(0,210,255,0.3)] hover:bg-[rgba(0,210,255,0.05)] " + (showSettings ? "text-cyan border-[rgba(0,210,255,0.3)] bg-[rgba(0,210,255,0.08)]" : "text-(--text-muted) border-(--border)")} onclick={() => (showSettings = !showSettings)} title={$t('trade.settings')}>
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
				</button>
			</div>
		</div>

		{#if showSettings}
			<SlippageSetter bind:slippageBps />
		{/if}

		<!-- Network selector (only if multiple trade networks) -->
		{#if tradeNetworks.length > 1}
			<div class="flex gap-1 p-1 bg-(--bg-surface) border border-(--border) rounded-[14px] mb-2">
				{#each tradeNetworks as net, i}
					<button
						class={"flex-1 py-2 px-0 rounded-[10px] border-0 font-mono text-xs font-bold cursor-pointer transition-all duration-150 hover:text-(--text) " + (selectedNetworkIdx === i ? "bg-[rgba(0,210,255,0.1)] text-cyan" : "bg-transparent text-(--text-muted)")}
						onclick={() => {
							if (selectedNetworkIdx !== i) {
								selectedNetworkIdx = i;
								tokenInAddr = ''; tokenInSymbol = ''; tokenInBalance = 0n; tokenInHasTax = false;
								tokenOutAddr = ''; tokenOutSymbol = ''; tokenOutBalance = 0n; tokenOutHasTax = false;
								amountIn = ''; amountOut = '';
							}
						}}
					>
						{net.symbol}
					</button>
				{/each}
			</div>
		{/if}

		<!-- Output mode toggle -->
		<OutputModeToggle bind:selected={outputMode} />

		<!-- ═══ SWAP CARD ═══ -->
		<SwapCardShell>
			<TokenInput
				label={$t('trade.youPay')}
				tokenSymbol={tokenInSymbol}
				tokenLogo={tokenInLogo}
				bind:amount={amountIn}
				balance={tokenInBalance}
				decimals={tokenInDecimals}
				isNative={tokenInIsNative}
				hasTax={tokenInHasTax}
				taxBuy={tokenInTaxBuy}
				taxSell={tokenInTaxSell}
				taxInfo={tokenInTax}
				isPlatform={tokenInIsPlatform}
				usdValue={usdValueIn}
				{estimatedGasCost}
				onSelectToken={() => { tokenModalTarget = 'in'; showTokenModal = true; }}
			/>

			{#if outputMode === 'token'}
				<FlipButton onclick={flipTokens} />

				<TokenInput
					label={$t('trade.youReceive')}
					tokenSymbol={tokenOutSymbol}
					tokenLogo={tokenOutLogo}
					amount={displayAmountOut}
					readonly
					balance={tokenOutBalance}
					decimals={tokenOutDecimals}
					isNative={tokenOutIsNative}
					hasTax={tokenOutHasTax}
					taxBuy={tokenOutTaxBuy}
					taxSell={tokenOutTaxSell}
					taxInfo={tokenOutTax}
					isPlatform={tokenOutIsPlatform}
					usdValue={usdValueOut}
					{previewLoading}
					onSelectToken={() => { tokenModalTarget = 'out'; showTokenModal = true; }}
				/>

				{#if spotRate}
					<SpotRatePreview text={spotRate} />
				{/if}

				{#if rate}
					<TradeDetails>
						<DetailLine label={$t('trade.rate')}>1 {tokenInSymbol} = {rate} {tokenOutSymbol}</DetailLine>
						{#if minReceived}
							<DetailLine label={$t('trade.minReceived')}>
								{minReceived} {tokenOutSymbol}{#if minUsd} <span class="text-(--text-muted) text-xs font-[Rajdhani,sans-serif] font-medium tabular-nums">(≈${minUsd})</span>{/if}
							</DetailLine>
						{/if}
						<DetailLine label={$t('trade.slippage')}>{slippagePct}%</DetailLine>
						{#if tokenInTaxSell > 0}
							<DetailLine label="{$t('trade.sellTax')} ({tokenInSymbol})" warn>{(tokenInTaxSell / 100).toFixed(1)}%</DetailLine>
						{/if}
						{#if tokenOutTaxBuy > 0}
							<DetailLine label="{$t('trade.buyTax')} ({tokenOutSymbol})" warn>{(tokenOutTaxBuy / 100).toFixed(1)}%</DetailLine>
						{/if}
					</TradeDetails>
				{/if}

				{#if noLiquidity}
					<NoLiquidityNotice />
				{/if}
			{/if}

			{#if outputMode === 'bank'}
				<PayoutPreviewCard {fiatEquivalent} {previewFee} {previewNet} {usdtDecimals} />

				<div class="flex flex-col gap-2.5 mb-2 px-0.5">
					<div class="flex flex-col">
						<span class="font-mono text-xs2 font-semibold uppercase tracking-[0.05em] text-(--text-muted) mb-1">{$t('trade.bank')}</span>
						<BankSelectorButton bankName={bankBankName} onclick={() => { showBankModal = true; bankSearchQuery = ''; }} />
					</div>
					<BankAccountField bind:value={bankAccount} />
					<BankResolveStatus resolving={bankResolving} resolved={bankResolved} {bankName} error={bankError} />
				</div>

				<TrustCard title={$t('trade.onChainEscrow')} {contractUrl}>
					<TrustItem>{$t('trade.heldInSmartContract')}</TrustItem>
					<TrustItem>
						{#if payoutTimeoutLoaded}{$t('trade.autoRefundAfter').replace('{min}', String(payoutTimeoutMins))}{:else}{$t('trade.autoRefundIfFails')}{/if}
					</TrustItem>
					<TrustItem>{$t('trade.cancelBeforeConfirmation')}</TrustItem>
					<TrustItem>{$t('trade.noKycRequired')}</TrustItem>
				</TrustCard>
			{/if}

			<SwapActionButton
				variant={buttonVariant}
				disabled={buttonDisabled && !!userAddress}
				onclick={() => { if (!userAddress) connectWallet(); else showConfirmModal = true; }}
			>
				{buttonLabel}
			</SwapActionButton>
		</SwapCardShell>

		<!-- Buy crypto banner -->
		<div class="flex items-center gap-2 px-3.5 py-2.5 mt-2.5 rounded-xl bg-(--bg-surface) border border-(--border) font-mono text-xs3 text-(--text-muted)">
			<svg class="shrink-0 text-cyan" width="14" height="14" viewBox="0 0 512 512" fill="#00d2ff"><path d="M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512zM169.8 165.3c7.9-22.3 29.1-37.3 52.8-37.3h58.3c34.9 0 63.1 28.3 63.1 63.1c0 22.6-12.1 43.5-31.7 54.8L280 264.4c-.2 13-10.9 23.6-24 23.6c-13.3 0-24-10.7-24-24V250.5c0-8.6 4.6-16.5 12.1-20.8l44.3-25.4c4.7-2.7 7.6-7.7 7.6-13.1c0-8.4-6.8-15.1-15.1-15.1H222.6c-3.4 0-6.4 2.1-7.5 5.3l-.4 1.2c-4.4 12.5-18.2 19-30.6 14.6s-19-18.2-14.6-30.6l.4-1.2zM224 352a32 32 0 1 1 64 0 32 32 0 1 1-64 0z"/></svg>
			<span class="flex-1">{$t('trade.buyCrypto')}</span>
			<button class="py-1.5 px-3.5 rounded-lg border-0 cursor-pointer bg-[linear-gradient(135deg,#00d2ff,#3a7bd5)] text-white font-[Syne,sans-serif] text-xs font-bold whitespace-nowrap transition-all duration-150 shrink-0 hover:-translate-y-px hover:shadow-[0_4px_16px_rgba(0,210,255,0.3)]" onclick={() => addFeedback({ message: $t('trade.comingSoon'), type: 'info' })}>
				{$t('trade.getItNow')}
			</button>
		</div>

		<!-- History panel -->
		{#if showHistory && userAddress}
			<WithdrawalHistoryPanel
				bind:this={historyPanel}
				network={selectedNetwork}
				{userAddress}
				{networkProviders}
				{usdtDecimals}
				onselect={(w) => {
					showConfirmModal = false;
					activeWithdrawal = toWithdrawalView(w);
				}}
			/>
		{/if}
	</div>
</div>

<!-- ═══ TOKEN SELECTOR MODAL ═══ -->
{#if showTokenModal}
	<TokenSelectorModal
		{builtInTokens}
		{filteredTokens}
		bind:tokenSearch
		{pastedTokenMeta}
		{pastedTokenLoading}
		{dbSearchLoading}
		explorerUrl={selectedNetwork?.explorer_url || ''}
		onSelect={(token) => selectToken(tokenModalTarget, token)}
		onImport={handleCustomAddress}
		onClose={() => { showTokenModal = false; tokenSearch = ''; }}
		onCopyAddress={(addr) => { navigator.clipboard.writeText(addr); addFeedback({ message: $t('trade.addressCopied'), type: 'success' }); }}
	/>
{/if}

<!-- ═══ BANK SELECTOR MODAL ═══ -->
{#if showBankModal}
	<BankSelectorModal
		banks={ngBanks}
		bind:searchQuery={bankSearchQuery}
		onSelect={(bank) => { selectBank(bank); showBankModal = false; bankSearchQuery = ''; }}
		onClose={() => { showBankModal = false; bankSearchQuery = ''; }}
	/>
{/if}

<!-- ═══ CONFIRM TRADE MODAL ═══ -->
{#if showConfirmModal}
	<ConfirmModalShell
		title={outputMode === 'bank' ? $t('trade.confirmWithdrawal') : $t('trade.confirmSwap')}
		closable={!isSwapping}
		onClose={() => { if (!isSwapping) showConfirmModal = false; }}
	>
		{#if isSwapping}
			<!-- ═══ BANK MODE STEPPER / COMPLETION ═══ -->
			{#if outputMode === 'bank' && withdrawStep > 0}
				{#if withdrawStep >= 5}
					<TradeCompletion title={$t('trade.withdrawalSubmitted')} subtitle={$t('trade.withdrawalSubmittedDesc')}>
						{#snippet action()}
							<SwapActionButton variant="bank" onclick={() => {
								showConfirmModal = false;
								if (outputMode === 'token') { swapStep = 0; amountIn = ''; amountOut = ''; }
							}}>
								{$t('trade.viewStatus')}
							</SwapActionButton>
						{/snippet}
					</TradeCompletion>
				{:else}
					<TradeStepperHeader amount={amountIn} symbol={tokenInSymbol} {fiatEquivalent} />
					<TradeStepperList steps={withdrawSteps} currentStep={withdrawStep} />
				{/if}
			{:else if outputMode === 'token'}
				{#if swapStep >= 3}
					<TradeCompletion title={$t('trade.swapComplete')} subtitle="{tokenInSymbol} → {tokenOutSymbol}">
						{#snippet action()}
							<SwapActionButton variant="primary" onclick={() => {
								showConfirmModal = false;
								swapStep = 0; amountIn = ''; amountOut = '';
							}}>
								{$t('trade.done')}
							</SwapActionButton>
						{/snippet}
					</TradeCompletion>
				{:else}
					<TradeStepperList steps={swapSteps} currentStep={swapStep} />
				{/if}
			{/if}
		{:else}
			<!-- ═══ REVIEW ═══ -->
			<TradeReviewRow
				leftLabel={$t('trade.pay')}
				rightLabel={outputMode === 'token' ? $t('trade.receive') : $t('trade.to')}
			>
				{#snippet leftSide()}
					<span class="block font-[Rajdhani,sans-serif] text-lg2 font-bold text-(--text-heading) leading-[1.3] tabular-nums">{amountIn} <span class="text-sm text-(--text-muted) font-semibold">{tokenInSymbol}</span></span>
					{#if tokenInHasTax}<span class="inline-block mt-[3px] font-mono text-xxs text-warning bg-[rgba(245,158,11,0.08)] py-px px-1.5 rounded-[3px]">-{tokenInTaxSell / 100}% tax</span>{/if}
				{/snippet}
				{#snippet rightSide()}
					{#if outputMode === 'token'}
						<span class="block font-[Rajdhani,sans-serif] text-lg2 font-bold text-(--text-heading) leading-[1.3] tabular-nums">{displayAmountOut || '0'} <span class="text-sm text-(--text-muted) font-semibold">{tokenOutSymbol}</span></span>
						{#if tokenOutHasTax}<span class="inline-block mt-[3px] font-mono text-xxs text-warning bg-[rgba(245,158,11,0.08)] py-px px-1.5 rounded-[3px]">-{tokenOutTaxBuy / 100}% tax</span>{/if}
					{:else}
						<span class="block syne text-sm2 font-bold text-(--text-heading) leading-[1.3]">{paymentMethod === 'bank' ? bankBankName : paymentMethod === 'paypal' ? 'PayPal' : 'Wise'}</span>
						{#if paymentMethod === 'bank' && bankResolved}
							<span class="block font-mono text-xs2 text-success font-semibold mt-0.5">{bankName}</span>
						{:else if paymentMethod === 'paypal'}
							<span class="block font-mono text-xs2 text-success font-semibold mt-0.5">{paypalEmail}</span>
						{:else if paymentMethod === 'wise'}
							<span class="block font-mono text-xs2 text-success font-semibold mt-0.5">{wiseEmail}</span>
						{/if}
					{/if}
				{/snippet}
			</TradeReviewRow>

			<TradeReviewDetails>
				{#if outputMode === 'token' && rate}
					<DetailLine label={$t('trade.rate')}>1 {tokenInSymbol} = {rate}</DetailLine>
					<DetailLine label={$t('trade.minReceived')}>
						{minReceived} {tokenOutSymbol}{#if confirmMinUsd} <span class="text-(--text-muted) text-xs font-[Rajdhani,sans-serif] font-medium tabular-nums">(≈${confirmMinUsd})</span>{/if}
					</DetailLine>
					<DetailLine label={$t('trade.slippage')}>{(slippageBps / 100).toFixed(slippageBps % 100 === 0 ? 0 : slippageBps % 10 === 0 ? 1 : 2)}%</DetailLine>
					{#if tokenInTaxSell > 0}
						<DetailLine label="{$t('trade.sellTax')} ({tokenInSymbol})" warn>{(tokenInTaxSell / 100).toFixed(1)}%</DetailLine>
					{/if}
					{#if tokenOutTaxBuy > 0}
						<DetailLine label="{$t('trade.buyTax')} ({tokenOutSymbol})" warn>{(tokenOutTaxBuy / 100).toFixed(1)}%</DetailLine>
					{/if}
				{:else if outputMode === 'bank'}
					{#if previewFee > 0n}
						<DetailLine label={$t('trade.feeWithPct').replace('{pct}', ((Number(previewFee) / Number(previewFee + previewNet)) * 100).toFixed(1))}>${parseFloat(ethers.formatUnits(previewFee, usdtDecimals)).toFixed(2)}</DetailLine>
						<DetailLine label={$t('trade.netAmount')}>${parseFloat(ethers.formatUnits(previewNet, usdtDecimals)).toFixed(2)}</DetailLine>
					{/if}
					{#if fiatEquivalent}
						<DetailLine label={$t('trade.youReceive')}>
							<span class="font-[Rajdhani,sans-serif] text-base font-bold text-success tabular-nums">{fiatEquivalent}</span>
						</DetailLine>
						{#if ngnRate > 0}
							<DetailLine label={$t('trade.rate')}>1 USD = ₦{ngnRate.toFixed(2)}</DetailLine>
						{/if}
					{/if}
					{#if payoutTimeoutLoaded}
						<DetailLine label={$t('trade.processingLabel')}>{$t('trade.processingTime').replace('{min}', String(payoutTimeoutMins))}</DetailLine>
					{/if}
					<DetailLine label={$t('trade.escrow')}>
						<span class="text-success">{$t('trade.escrowHeldBySc')}</span>
					</DetailLine>
				{/if}
			</TradeReviewDetails>

			<SwapActionButton
				variant={outputMode === 'bank' ? 'bank' : 'primary'}
				onclick={async () => {
					if (outputMode === 'bank' && ngnRate > 0) {
						lockedNgnRate = ngnRate;
						const netVal = previewNet > 0n
							? parseFloat(ethers.formatUnits(previewNet, usdtDecimals))
							: 0;
						lockedNgnAmount = netVal * ngnRate;
					}
					await handleSwap();
				}}
			>
				{outputMode === 'bank' ? $t('trade.confirmWithdrawal') : $t('trade.confirmSwap')}
			</SwapActionButton>
		{/if}
	</ConfirmModalShell>
{/if}

<!-- ═══ WITHDRAWAL STATUS MODAL ═══ -->
{#if activeWithdrawal}
	<WithdrawalStatusModal
		withdrawal={activeWithdrawal}
		{usdtDecimals}
		lockedNgnRate={lockedNgnRate}
		lockedNgnAmount={lockedNgnAmount}
		explorerUrl={selectedNetwork?.explorer_url || ''}
		onclose={() => { activeWithdrawal = null; lockedNgnRate = 0; lockedNgnAmount = 0; amountIn = ''; bankAccount = ''; bankCode = ''; bankName = ''; bankBankName = ''; bankResolved = false; bankError = ''; }}
		oncancel={async (id) => { await handleCancel(id); activeWithdrawal = null; lockedNgnRate = 0; lockedNgnAmount = 0; amountIn = ''; bankAccount = ''; bankCode = ''; bankName = ''; bankBankName = ''; bankResolved = false; bankError = ''; }}
	/>
{/if}

