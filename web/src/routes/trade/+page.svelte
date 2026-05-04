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
	import { DexRouterClient } from '$lib/contracts/dexRouter';
	import WithdrawalStatusModal from '$lib/WithdrawalStatusModal.svelte';
	import { apiFetch } from '$lib/apiFetch';
	import { queryTradeLens, getInstantQuote, getWeth, isCacheLoaded, getUsdValue, getCachedToken, findBestRoute as findBestRouteLocal, type TaxInfo, type SwapRoute } from '$lib/tradeLens';
	import { toTokenSlotView, toTradeAmountsView, toTradeActionView, formatAmount } from '$lib/structure/views/tradeView';
	import { findBestRoute as findBestRouteOnChain } from '$lib/routeFinder';
	import { pushPreferences } from '$lib/embeddedWallet';
	import { resolveTokenLogo } from '$lib/tokenLogo';
	import { userTokens, addUserToken, updateUserToken, removeUserToken } from '$lib/userTokens';
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
	import SuccessBurst from '$lib/SuccessBurst.svelte';
	import OnrampPanel from './OnrampPanel.svelte';
	import TokenSelectorModal from './TokenSelectorModal.svelte';
	import BankSelectorModal from './BankSelectorModal.svelte';
	import ConfirmModalShell from './ConfirmModalShell.svelte';
	import TradeStepperList, { type StepDef } from './TradeStepperList.svelte';
	import TradeStepperHeader from './TradeStepperHeader.svelte';
	import TradeCompletion from './TradeCompletion.svelte';
	import TradeReviewRow from './TradeReviewRow.svelte';
	import TradeReviewDetails from './TradeReviewDetails.svelte';
	import TradeHistoryPanel from './TradeHistoryPanel.svelte';
	import OnrampStatusModal from './OnrampStatusModal.svelte';
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
	let outputMode = $state<'token' | 'bank' | 'fiat'>('token');

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
	// Distinct from noLiquidity: priceQuoteUnavailable means the RPC
	// route-find eth_call threw (timeout / rate limit / chain hiccup),
	// not that there's actually no DEX liquidity. We surface a softer
	// message and don't permanently block the swap, so a retry can
	// recover when the RPC settles.
	let priceQuoteUnavailable = $state(false);
	let swapRoute = $state<SwapRoute | null>(null);

	// Slippage — managed by SlippageSetter, shared via localStorage
	let slippageBps = $state(50);
	let showSettings = $state(false);

	// Swap state
	let isSwapping = $state(false);
	let showConfirmModal = $state(false);
	let swapStep = $state(0); // 0=idle, 1=approve, 2=swap, 3=done
	// Success burst trigger — flips true on swap confirm, resets via onComplete
	let swapBurst = $state(false);

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
	let fiatRates: Record<string, number> = $derived(serverData?.fiatRates || {});
	let ngnRate = $derived(fiatRates['NGN'] || 0);
	// On-ramp NGN rate (mid + spread) — separate from off-ramp's fiatRates.NGN
	// so live preview matches what the lock-rate quote will return.
	let onrampNgnRate = $derived(serverData?.onrampNgnRate ?? null);
	// Whole-naira minimum on-ramp (configurable via platform_config.rate_override.onramp_min_kobo).
	let onrampMinNgn = $derived(Math.ceil((serverData?.onrampMinKobo ?? 50_000) / 100));
	// On-ramp amount lives at the page level so it survives tab switches
	// (Buy → Swap → Buy keeps the user's typed amount).
	let onrampAmountNgn = $state<number | null>(null);
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
	let platformTokens: { address: string; symbol: string; name: string; decimals: number; logo_url?: string }[] = $derived(serverData?.platformTokens || []);
	// Platform tokens can never be honeypots — suppress false positives
	let platformTokenAddrs = $derived(new Set(platformTokens.map(t => t.address.toLowerCase())));

	// CoinGecko-known tokens for the current chain (a few thousand
	// entries). Fetched lazily on first modal open per chain, cached
	// in-memory for the lifetime of the page so re-opens are instant.
	// The server endpoint caches the upstream CoinGecko fetch for 6h, so
	// this is one network round-trip per chain per session at most.
	//
	// We don't render these as a separate section — they merge into
	// filteredTokens once the user types a search query, so the picker
	// stays uncluttered when there's no query but resolves any
	// well-known symbol the user types.
	type ChainToken = { address: string; symbol: string; name: string; rank?: number };
	let chainTokens = $state<ChainToken[]>([]);
	const chainTokensCache = new Map<string, ChainToken[]>();
	$effect(() => {
		if (!showTokenModal || !selectedNetwork?.symbol) return;
		const slug = selectedNetwork.symbol.toLowerCase();
		const hit = chainTokensCache.get(slug);
		if (hit) { chainTokens = hit; return; }
		fetch(`/api/popular-tokens?chain=${slug}`)
			.then(r => r.ok ? r.json() : { tokens: [] })
			.then(d => {
				const list = (d.tokens || []) as ChainToken[];
				chainTokensCache.set(slug, list);
				chainTokens = list;
			})
			.catch(() => { chainTokens = []; });
	});

	// History
	let showHistory = $state(false);
	let historyPanel = $state<TradeHistoryPanel | undefined>();
	let activeWithdrawal: WithdrawalView | null = $state(null);
	let activeOnrampRow: any = $state(null);

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

	// ── Imported tokens (backed by shared userTokens store) ─────
	type ImportedToken = { address: string; symbol: string; name: string; decimals: number; chainId: number; logo_url?: string };

	// Derive from the unified store so tokens imported anywhere (wallet,
	// create, launchpad) show up here too. The store handles persistence +
	// legacy-key migration.
	let importedTokens: ImportedToken[] = $derived(
		$userTokens.map(t => ({
			address: t.address,
			symbol: t.symbol,
			name: t.name,
			decimals: t.decimals,
			chainId: t.chainId,
			logo_url: t.logoUrl || '',
		}))
	);

	// Resolve missing logos — writes back to the store so every consumer
	// benefits from the cached URL.
	$effect(() => {
		for (const t of importedTokens) {
			if (!t.logo_url && t.address) {
				resolveTokenLogo(t.address, t.chainId || 56).then(url => {
					if (url) updateUserToken(t.address, t.chainId, { logoUrl: url });
				});
			}
		}
	});

	function saveImportedToken(token: ImportedToken) {
		const chainId = token.chainId || selectedNetwork?.chain_id || 56;
		const addr = token.address.toLowerCase();
		const before = $userTokens.length;
		addUserToken({
			address: addr,
			symbol: token.symbol,
			name: token.name,
			decimals: token.decimals,
			logoUrl: token.logo_url || '',
			chainId,
		});
		if ($userTokens.length !== before) refreshPrices();
		if (!token.logo_url) {
			resolveTokenLogo(addr, chainId).then(url => {
				if (url) updateUserToken(addr, chainId, { logoUrl: url });
			});
		}
	}

	function removeImportedToken(address: string) {
		const chainId = selectedNetwork?.chain_id || 56;
		removeUserToken(address, chainId);
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

		// Cap merged matches to keep the rendered list bounded — CoinGecko
		// can return thousands per chain; 30 entries comfortably covers
		// platform tokens + popular CG tokens + near-misses on a search.
		const cap = 30;
		// `seen` starts pre-populated with the excluded-side address so
		// we never re-introduce it via the chainTokens merge below.
		const excludeAddr = outputMode === 'token'
			? (tokenModalTarget === 'in' ? tokenOutAddr.toLowerCase() : tokenInAddr.toLowerCase())
			: '';
		const seen = new Set<string>();
		if (excludeAddr) seen.add(excludeAddr);
		const out: typeof list = [];
		for (const t of list) {
			if (q && !(
				t.symbol.toLowerCase().includes(q) ||
				t.name.toLowerCase().includes(q) ||
				t.address.toLowerCase().includes(q)
			)) continue;
			out.push(t);
			seen.add(t.address.toLowerCase());
		}

		// Merge DB search results — only when there's a query.
		if (q) {
			for (const r of dbSearchResults) {
				const aLow = r.address.toLowerCase();
				if (seen.has(aLow)) continue;
				out.push(r);
				seen.add(aLow);
			}
		}

		// Merge CoinGecko chain tokens. With no query → top-ranked first
		// (chainTokens is pre-sorted by market-cap rank in the daemon),
		// so users see AAVE / DOGE / etc. without typing. With a query →
		// substring filter. Decimals default to 18; the on-chain
		// decimals lookup runs when the user actually picks the token,
		// so a wrong default here gets corrected before any swap math.
		// Logo URL is empty so the existing tokenLogo resolver picks
		// it up via the fallback chain (KNOWN_LOGOS → DB → GeckoTerminal).
		if (out.length < cap) {
			for (const r of chainTokens) {
				if (out.length >= cap) break;
				const aLow = r.address.toLowerCase();
				if (seen.has(aLow)) continue;
				if (q && !(
					r.symbol.toLowerCase().includes(q) ||
					r.name.toLowerCase().includes(q) ||
					aLow.includes(q)
				)) continue;
				out.push({
					address: r.address,
					symbol: r.symbol,
					name: r.name,
					decimals: 18,
					logo_url: '',
				});
				seen.add(aLow);
			}
		}

		return out;
	});

	// ── Data from server (platformTokens, ngBanks, fiatRates) — already loaded ──
	onMount(async () => {
		// importedTokens hydrates itself from the userTokens store (legacy keys
		// are migrated on first load).

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
		// `?mode=buy|sell|swap` picks the active panel without forcing
		// the user to click a tab. Maps to the internal outputMode
		// machine: buy=fiat (OnrampPanel), sell=bank (off-ramp),
		// swap=token (token-to-token). Anything else is ignored so
		// the page falls back to whatever the user last set / the
		// default 'token'.
		const urlMode = page.url.searchParams.get('mode');
		if (urlMode === 'buy') outputMode = 'fiat';
		else if (urlMode === 'sell') outputMode = 'bank';
		else if (urlMode === 'swap') outputMode = 'token';

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
				const qs = new URLSearchParams({ account_number: acc, account_bank: code });
				const res = await fetch(`/api/bank/resolve?${qs}`);
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
		const net = selectedNetwork;
		// In bank mode the user doesn't pick an output token — the on-chain
		// swap always lands at USDT. We still need a quote (to compute minOut)
		// because TradeRouter requires non-zero amountOutMin on the
		// depositAndSwap path. Previously this branch early-returned, leaving
		// amountOut="" and minOut=0, which now reverts SlippageRequired.
		const outAddr = outputMode === 'bank' ? net?.usdt_address : tokenOutAddr;
		// In bank mode tokenOutDecimals is stale (the user didn't pick an
		// output token). USDT decimals are stable and chain-correct.
		const outDecs = outputMode === 'bank' ? usdtDecimals : tokenOutDecimals;

		if (!amt || !inAddr || !outAddr || !net || parseFloat(amt) <= 0) {
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
					amountOut = ethers.formatUnits(route.amountOut, outDecs);
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
					amountOut = ethers.formatUnits(route.amountOut, outDecs);
					swapRoute = { path: route.path, symbols: [], amountOut: route.amountOut, hops: route.path.length - 1 };
					noLiquidity = false;
					priceQuoteUnavailable = false;
				} else if (!hasInstant) {
					// RouteFinder returned cleanly with no path — definitive
					// no-liquidity at this depth across the configured bases.
					amountOut = '';
					noLiquidity = true;
					priceQuoteUnavailable = false;
				}
			} catch {
				// RouteFinder threw — RPC rate-limit, socket drop, or
				// public-endpoint hiccup. Don't permanently block the
				// swap; surface a soft retry notice and let the next
				// preview tick recover automatically.
				if (!hasInstant) {
					amountOut = '';
					noLiquidity = false;
					priceQuoteUnavailable = true;
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
					// Off-ramp path: prefer the route already discovered by
					// the swap-mode preview (RouteFinder ran with USDT as
					// outAddr earlier in this $effect cycle). When that
					// hasn't landed yet — or when the user submits before
					// preview debounce fires — fall back to a direct
					// RouteFinder lookup so we still pick the best path
					// instead of forcing every token through WBNB.
					let offRampPath: string[];
					if (swapRoute?.path.length) {
						offRampPath = [...swapRoute.path];
					} else if (net.dex_router) {
						const bases: string[] = [];
						if (weth) bases.push(weth);
						if (net.usdt_address) bases.push(net.usdt_address);
						if (net.usdc_address) bases.push(net.usdc_address);
						for (const b of net.default_bases || []) {
							if (b.address && !bases.some((x: string) => x.toLowerCase() === b.address.toLowerCase())) bases.push(b.address);
						}
						const rfIn = tokenInIsNative ? ethers.ZeroAddress : inAddr;
						const r = await findBestRouteOnChain(provider, net.dex_router, rfIn, net.usdt_address, parsedAmt, bases);
						offRampPath = r?.path.length ? r.path : (addrIn !== weth ? [addrIn, weth, net.usdt_address] : [addrIn, net.usdt_address]);
					} else {
						offRampPath = addrIn !== weth ? [addrIn, weth, net.usdt_address] : [addrIn, net.usdt_address];
					}
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

	// `fiat` mode renders OnrampPanel and bypasses this view entirely;
	// coerce to `'token'` so the view's strict union still type-checks.
	let amounts = $derived(toTradeAmountsView({
		amountIn, amountOut, noLiquidity, slippageBps,
		outputMode: outputMode === 'fiat' ? 'token' : outputMode,
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
			// In bank mode the swap output is USDT, not the stale
			// tokenOutDecimals. Use usdtDecimals for the parse.
			const expectedOutDecimals = outputMode === 'bank' ? usdtDecimals : tokenOutDecimals;
			try {
				if (amountOut && parseFloat(amountOut) > 0) {
					const sanitizedOut = parseFloat(amountOut).toFixed(expectedOutDecimals);
					expectedOut = ethers.parseUnits(sanitizedOut, expectedOutDecimals);
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

			// minOut == 0 means we never got a price quote (token has no DEX
			// liquidity, path mis-configured, or user clicked before the
			// preview loaded). TradeRouter rejects with SlippageRequired —
			// surface it here as a clearer error before submitting.
			const _usdtAddr = selectedNetwork.usdt_address.toLowerCase();
			const _tokenInIsUsdt = tokenInAddr.toLowerCase() === _usdtAddr;
			const needsSwap = !(outputMode === 'bank' && _tokenInIsUsdt);
			if (needsSwap && minOut === 0n) {
				addFeedback({ message: 'No price quote available — wait for the preview to load, or this token has no DEX liquidity.', type: 'error' });
				isSwapping = false;
				return;
			}

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

				if (paymentMethod === 'bank') {
					if (!bankResolved || !bankAccount || !bankCode) {
						addFeedback({ message: $t('trade.verifyBankFirst'), type: 'error' });
						isSwapping = false;
						return;
					}
					paymentDetails = { method: 'bank', bank_code: bankCode, bank_name: bankBankName, account: bankAccount, holder: bankName };
				} else if (paymentMethod === 'paypal') {
					if (!paypalEmail) {
						addFeedback({ message: $t('trade.enterPaypalEmail'), type: 'error' });
						isSwapping = false;
						return;
					}
					paymentDetails = { method: 'paypal', email: paypalEmail };
				} else {
					if (!wiseEmail) {
						addFeedback({ message: $t('trade.enterWiseEmail'), type: 'error' });
						isSwapping = false;
						return;
					}
					paymentDetails = { method: 'wise', email: wiseEmail, currency: wiseCurrency };
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

				// bankRef is keyed off the DB row id, NOT the payment details.
				// Earlier this was ethers.id('bank:<code>:<account>:<holder>') —
				// which meant a failed/cancelled withdrawal permanently locked
				// that bank account on-chain via TradeRouter.bankRefUsed[]. Now
				// each new withdrawal_request row gets a fresh ID = fresh hash,
				// so retries with the same bank work. Verify + processor
				// endpoints recompute the same way to match.
				const bankRef = ethers.id(`wd:${preData.id}`);

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

				// Resolve the best [tokenIn → ... → USDT] path for the
				// off-ramp tx. The preview effect ran RouteFinder with
				// USDT as outAddr and stored its result in swapRoute,
				// but if the user submits before debounce settles or
				// swapRoute went stale, ask RouteFinder again so we
				// don't fall back to a hardcoded WBNB hop that misses
				// direct USDT pairs (e.g. USDC).
				let bestPath: string[] | null = null;
				if (swapRoute?.path.length) {
					bestPath = [...swapRoute.path];
				} else if (!tokenInIsNative && tokenInAddr.toLowerCase() === usdtAddr.toLowerCase()) {
					// USDT input doesn't need a swap path.
				} else if (selectedNetwork.dex_router) {
					const provider = networkProviders.get(selectedNetwork.chain_id);
					if (provider) {
						const bases: string[] = [];
						if (weth) bases.push(weth);
						if (usdtAddr) bases.push(usdtAddr);
						if (selectedNetwork.usdc_address) bases.push(selectedNetwork.usdc_address);
						for (const b of selectedNetwork.default_bases || []) {
							if (b.address && !bases.some((x: string) => x.toLowerCase() === b.address.toLowerCase())) bases.push(b.address);
						}
						const rfIn = tokenInIsNative ? ethers.ZeroAddress : tokenInAddr;
						try {
							const r = await findBestRouteOnChain(provider, selectedNetwork.dex_router, rfIn, usdtAddr, parsedIn, bases);
							if (r?.path.length) bestPath = r.path;
						} catch {}
					}
				}

				let result;
				if (tokenInIsNative) {
					// ETH → USDT: build path through best intermediary
					const ethPath = bestPath
						? bestPath.map(a => a.toLowerCase() === ethers.ZeroAddress.toLowerCase() ? weth : a)
						: [weth, usdtAddr];
					if (ethPath[ethPath.length - 1].toLowerCase() !== usdtAddr.toLowerCase()) {
						ethPath.push(usdtAddr);
					}
					result = await router.depositETH(ethPath, minOut, bankRef, referrer, parsedIn);
				} else if (tokenInAddr.toLowerCase() === usdtAddr.toLowerCase()) {
					result = await router.deposit(parsedIn, bankRef, referrer);
				} else {
					// Token → USDT: use best route path
					const tokenPath = bestPath ? [...bestPath] : [tokenInAddr, weth, usdtAddr];
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

				// Auto-open WithdrawalStatusModal directly from receipt data.
				// Earlier this path called getUserWithdrawals(userAddress) and
				// only opened the modal if the new record showed up — but BSC
				// RPC nodes routinely lag a block or two behind the broadcast
				// node, so the just-submitted withdrawal often wasn't visible
				// yet, leaving the modal closed entirely. The receipt's
				// WithdrawRequested event is the authoritative source for
				// withdrawId + expiresAt + fee + netAmount, so build the
				// view from that directly. History refresh runs in the
				// background and will replace this with the merged record
				// once the chain reads catch up.
				const grossAmount = (onChainNet ?? 0n) + (onChainFee ?? 0n);
				const nowSecs = Math.floor(Date.now() / 1000);
				activeWithdrawal = toWithdrawalView({
					id: preData.id,
					withdraw_id: withdrawId,
					user: userAddress?.toLowerCase() || '',
					token: tokenInAddr,
					grossAmount,
					fee: onChainFee ?? 0n,
					netAmount: onChainNet ?? 0n,
					createdAt: nowSecs,
					expiresAt: onChainExpiresAt || 0,
					status: WithdrawStatus.Pending,
					bankRef: '',
					referrer: ethers.ZeroAddress,
					payment_method: paymentMethod,
					payment_details: paymentDetails,
					chain_id: selectedNetwork.chain_id,
					tx_hash: receipt?.hash || '',
					db_status: 'pending',
				});

				// Refresh the history panel in the background so the row
				// shows up there too. Doesn't gate the modal-open above.
				try { historyPanel?.refresh?.(); } catch {}

				// Reset form after capturing values
				amountIn = '';
				previewFee = 0n;
				previewNet = 0n;
			} else {
				// ── Direct swap via PancakeSwap (no TradeRouter intermediary) ──
				const dexRouterAddr = selectedNetwork.dex_router;
				const dex = new DexRouterClient(dexRouterAddr, signer);
				const weth = wethAddr || await dex.weth();

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
				const swapRes = await dex.swap({
					amountIn: parsedIn,
					minOut,
					path,
					to: userAddress,
					deadline,
					fromNative: tokenInIsNative,
					toNative: tokenOutIsNative,
				});
				tx = swapRes.tx;
				swapStep = 3; // done
				swapBurst = true;
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

	// Re-fetch token balances when ANY of these change: wallet connected,
	// network resolved, or active token swapped. Catches three races:
	//   1. Page loads before the wallet unlocks → userAddress null → balance
	//      stays 0n until this effect re-runs.
	//   2. Network providers load after onMount's default selection ran with
	//      a stale (null) selectedNetwork → fetchMeta returned 0n.
	//   3. User changes selectedNetworkIdx mid-flow without re-selecting a
	//      token — old balance lingered against the new chain.
	$effect(() => {
		// Track all four explicit deps so Svelte re-runs when any flips.
		const u = userAddress;
		const net = selectedNetwork;
		const inAddr = tokenInAddr;
		const outAddr = tokenOutAddr;
		if (!u || !net) return;
		if (inAddr) {
			fetchMeta(inAddr, tokenInIsNative).then(meta => {
				if (tokenInAddr === inAddr) tokenInBalance = meta.balance;
			});
		}
		if (outAddr) {
			fetchMeta(outAddr, tokenOutIsNative).then(meta => {
				if (tokenOutAddr === outAddr) tokenOutBalance = meta.balance;
			});
		}
	});

	// If the default-selection on mount ran before selectedNetwork resolved,
	// builtInTokens was empty and nothing got picked. Trigger the same
	// pick-native-and-USDT fallback once the network IS available.
	$effect(() => {
		if (!selectedNetwork || builtInTokens.length === 0) return;
		if (!tokenInAddr) {
			const native = builtInTokens.find(t => t.isNative);
			if (native) selectToken('in', native);
		}
		if (!tokenOutAddr) {
			const usdt = builtInTokens.find(t => t.symbol === 'USDT');
			if (usdt) selectToken('out', usdt);
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
		if (priceQuoteUnavailable && outputMode === 'token') return 'Price unavailable — retry';
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
		(outputMode === 'token' && (!tokenOutAddr || noLiquidity || priceQuoteUnavailable)) ||
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
				<h1 class="font-[Syne,sans-serif] text-28 font-extrabold text-(--text-heading) m-0 leading-tight">{$t('trade.title')}</h1>
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
			{#if outputMode === 'fiat'}
				<OnrampPanel
					chainId={selectedNetwork?.chain_id ?? 56}
					receiver={userAddress ?? undefined}
					initialRate={onrampNgnRate}
					minNgn={onrampMinNgn}
					feeBps={serverData?.onrampFeeBps ?? 250}
					bind:amountNgn={onrampAmountNgn}
					onsuccess={() => {
						// Refresh USDT balance after delivery so the user can
						// immediately swap or use it on the trade page.
						if (tokenInAddr && userAddress && selectedNetwork) {
							fetchMeta(tokenInAddr, tokenInIsNative).then((meta) => {
								if (tokenInAddr) tokenInBalance = meta.balance;
							});
						}
					}}
				/>
			{:else}
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
			{/if}

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
				>
					{#snippet notice()}
						{#if noLiquidity}
							<NoLiquidityNotice />
						{:else if priceQuoteUnavailable}
							<!-- Soft RPC-error notice. Distinct from NoLiquidityNotice
							     because we can't actually tell if liquidity is missing
							     when the RouteFinder eth_call throws — it usually
							     means the public RPC rate-limited or dropped a
							     socket. The next preview tick retries automatically. -->
							<div class="rounded-[10px] border border-amber-500/20 bg-amber-500/5 px-3 py-2.5 flex items-start gap-2">
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2.2" class="shrink-0 mt-0.5"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
								<div class="flex-1">
									<span class="block font-mono text-3xs font-bold text-amber-500">Price quote unavailable</span>
									<span class="block font-mono text-3xs text-(--text-dim) mt-0.5">RPC didn't respond in time. The preview retries automatically — re-enter the amount or wait a moment.</span>
								</div>
							</div>
						{/if}
					{/snippet}
				</TokenInput>

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
					<TrustItem>{$t('trade.noKycRequired')}</TrustItem>
				</TrustCard>
			{/if}

			{#if outputMode !== 'fiat'}
				<SwapActionButton
					variant={buttonVariant}
					disabled={buttonDisabled && !!userAddress}
					onclick={() => { if (!userAddress) connectWallet(); else showConfirmModal = true; }}
				>
					{buttonLabel}
				</SwapActionButton>
			{/if}
		</SwapCardShell>

		<!-- Buy crypto banner (hide when already in fiat mode) -->
		<!-- {#if outputMode !== 'fiat'}
		<div class="flex items-center gap-2 px-3.5 py-2.5 mt-2.5 rounded-xl bg-(--bg-surface) border border-(--border) font-mono text-xs2 text-(--text-muted)">
			<svg class="shrink-0 text-cyan" width="14" height="14" viewBox="0 0 512 512" fill="#00d2ff"><path d="M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512zM169.8 165.3c7.9-22.3 29.1-37.3 52.8-37.3h58.3c34.9 0 63.1 28.3 63.1 63.1c0 22.6-12.1 43.5-31.7 54.8L280 264.4c-.2 13-10.9 23.6-24 23.6c-13.3 0-24-10.7-24-24V250.5c0-8.6 4.6-16.5 12.1-20.8l44.3-25.4c4.7-2.7 7.6-7.7 7.6-13.1c0-8.4-6.8-15.1-15.1-15.1H222.6c-3.4 0-6.4 2.1-7.5 5.3l-.4 1.2c-4.4 12.5-18.2 19-30.6 14.6s-19-18.2-14.6-30.6l.4-1.2zM224 352a32 32 0 1 1 64 0 32 32 0 1 1-64 0z"/></svg>
			<span class="flex-1">{$t('trade.buyCrypto')}</span>
			<button class="py-1.5 px-3.5 rounded-lg border-0 cursor-pointer bg-[linear-gradient(135deg,#00d2ff,#3a7bd5)] text-white font-[Syne,sans-serif] text-xs font-bold whitespace-nowrap transition-all duration-150 shrink-0 hover:-translate-y-px hover:shadow-[0_4px_16px_rgba(0,210,255,0.3)]" onclick={() => { outputMode = 'fiat'; }}>
				{$t('trade.getItNow')}
			</button>
		</div>
		{/if} -->

		<!-- Unified Trade History — off-ramp (sells) + on-ramp (buys) -->
		{#if showHistory && userAddress}
			<TradeHistoryPanel
				bind:this={historyPanel}
				network={selectedNetwork}
				{userAddress}
				{networkProviders}
				{usdtDecimals}
				onselect={(w) => {
					showConfirmModal = false;
					activeWithdrawal = toWithdrawalView(w);
				}}
				onselectBuy={(o) => {
					showConfirmModal = false;
					activeOnrampRow = o;
				}}
			/>
		{/if}
	</div>
</div>

<!-- ═══ SWAP SUCCESS BURST ═══ -->
<!-- Fires once when a swap confirms on-chain. Floats centered in the viewport
     so the burst is visible even after the confirm modal dismisses. -->
{#if swapBurst}
	<div class="fixed inset-0 z-[60] flex items-center justify-center pointer-events-none" aria-hidden="true">
		<SuccessBurst show={swapBurst} onComplete={() => { swapBurst = false; }} />
	</div>
{/if}

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
		getDetailHref={(addr) => {
			// Platform tokens get an in-app /explore page (chart, holders,
			// trades). Everything else falls back to the chain block-
			// explorer via the explorerUrl prop above.
			if (!selectedNetwork?.symbol) return '';
			return platformTokenAddrs.has(addr.toLowerCase())
				? `/explore/${selectedNetwork.symbol}/${addr}`
				: '';
		}}
		isPlatformToken={(addr) => platformTokenAddrs.has(addr.toLowerCase())}
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
					<span class="block font-[Rajdhani,sans-serif] text-22 font-bold text-(--text-heading) leading-[1.3] tabular-nums">{amountIn} <span class="text-sm text-(--text-muted) font-semibold">{tokenInSymbol}</span></span>
					{#if tokenInHasTax}<span class="inline-block mt-[3px] font-mono text-xs4 text-[#f59e0b] bg-[rgba(245,158,11,0.08)] py-px px-1.5 rounded-[3px]">-{tokenInTaxSell / 100}% tax</span>{/if}
				{/snippet}
				{#snippet rightSide()}
					{#if outputMode === 'token'}
						<span class="block font-[Rajdhani,sans-serif] text-22 font-bold text-(--text-heading) leading-[1.3] tabular-nums">{displayAmountOut || '0'} <span class="text-sm text-(--text-muted) font-semibold">{tokenOutSymbol}</span></span>
						{#if tokenOutHasTax}<span class="inline-block mt-[3px] font-mono text-xs4 text-[#f59e0b] bg-[rgba(245,158,11,0.08)] py-px px-1.5 rounded-[3px]">-{tokenOutTaxBuy / 100}% tax</span>{/if}
					{:else}
						<span class="block syne text-13 font-bold text-(--text-heading) leading-[1.3]">{paymentMethod === 'bank' ? bankBankName : paymentMethod === 'paypal' ? 'PayPal' : 'Wise'}</span>
						{#if paymentMethod === 'bank' && bankResolved}
							<span class="block font-mono text-3xs text-[#10b981] font-semibold mt-0.5">{bankName}</span>
						{:else if paymentMethod === 'paypal'}
							<span class="block font-mono text-3xs text-[#10b981] font-semibold mt-0.5">{paypalEmail}</span>
						{:else if paymentMethod === 'wise'}
							<span class="block font-mono text-3xs text-[#10b981] font-semibold mt-0.5">{wiseEmail}</span>
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
							<span class="font-[Rajdhani,sans-serif] text-base font-bold text-[#10b981] tabular-nums">{fiatEquivalent}</span>
						</DetailLine>
						{#if ngnRate > 0}
							<DetailLine label={$t('trade.rate')}>1 USD = ₦{ngnRate.toFixed(2)}</DetailLine>
						{/if}
					{/if}
					{#if payoutTimeoutLoaded}
						<DetailLine label={$t('trade.processingLabel')}>{$t('trade.processingTime').replace('{min}', String(payoutTimeoutMins))}</DetailLine>
					{/if}
					<DetailLine label={$t('trade.escrow')}>
						<span class="text-[#10b981] text-3xs">{$t('trade.escrowHeldBySc')}</span>
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

<!-- ═══ WITHDRAWAL STATUS MODAL (sell rows) ═══ -->
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

<!-- ═══ ON-RAMP STATUS MODAL (buy rows) ═══ -->
{#if activeOnrampRow}
	<OnrampStatusModal
		row={activeOnrampRow}
		onClose={() => { activeOnrampRow = null; }}
	/>
{/if}

