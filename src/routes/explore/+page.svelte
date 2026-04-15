<script lang="ts">
	import { ethers } from 'ethers';
	import { getContext, onMount, onDestroy } from 'svelte';
	import { chainSlug, type SupportedNetwork } from '$lib/structure';
	import { querySafuLens, type TokenSafu } from '$lib/safuLens';
	import { queryExploreLens, type ExploreTokenData } from '$lib/exploreLens';
	import { supabase } from '$lib/supabaseClient';
	import { page } from '$app/state';

	let { data }: { data: any } = $props();
	let tokens: any[] = $state(data.tokens);
	let search = $state(page.url.searchParams.get('q') || '');
	let sortBy = $state<'newest' | 'safu' | 'name'>('safu');
	let filterType = $state<'all' | 'tradeable' | 'new' | 'safu'>('all');
	let tradeableOnly = $derived(filterType === 'tradeable');

	const NOW = Date.now();

	// ── SAFU badge detection (client-side, lazy, batched via SafuLens) ──
	let _getNetworks: () => SupportedNetwork[] = getContext('supportedNetworks');
	let getNetworkProviders: () => Map<number, ethers.JsonRpcProvider> = getContext('networkProviders');

	let safuMap: Record<string, TokenSafu> = $state({});
	const _safuQueried = new Set<string>();
	let _safuObserver: IntersectionObserver | null = null;
	let _safuPending: any[] = [];
	let _safuTimer: ReturnType<typeof setTimeout> | null = null;

	function safuKey(tok: any): string {
		return `${tok.chain_id}:${tok.address?.toLowerCase()}`;
	}

	/** Debounced batch: collect visible tokens, then fire one SafuLens eth_call per chain. */
	function scheduleSafuBatch() {
		if (_safuTimer) clearTimeout(_safuTimer);
		_safuTimer = setTimeout(() => flushSafuBatch(), 200);
	}

	async function flushSafuBatch() {
		const batch = _safuPending.splice(0);
		if (batch.length === 0) return;
		const networks = _getNetworks();
		const providers = getNetworkProviders();

		// Group by chain
		const byChain: Record<number, any[]> = {};
		for (const t of batch) {
			if (!byChain[t.chain_id]) byChain[t.chain_id] = [];
			byChain[t.chain_id].push(t);
		}

		for (const [cidStr, toks] of Object.entries(byChain)) {
			const cid = Number(cidStr);
			const net = networks.find(n => n.chain_id === cid);
			const provider = providers.get(cid);
			if (!net || !provider || !net.platform_address || !net.dex_router) continue;

			// Resolve dexFactory from the dex router
			let dexFactory = '';
			try {
				const r = new ethers.Contract(net.dex_router, ['function factory() view returns (address)'], provider);
				dexFactory = await r.factory();
			} catch { continue; }

			// Resolve WETH
			let weth = '';
			try {
				const r = new ethers.Contract(net.dex_router, ['function WETH() view returns (address)'], provider);
				weth = await r.WETH();
			} catch { continue; }

			const addrs = toks.map(t => t.address);
			try {
				const results = await querySafuLens(provider, net.platform_address, dexFactory, weth, net.usdt_address, addrs);
				for (const s of results) {
					safuMap[`${cid}:${s.token}`] = s;
				}
				safuMap = { ...safuMap }; // trigger reactivity
			} catch (e) {
				console.warn('SafuLens query failed:', (e as any)?.message?.slice(0, 80));
			}
		}
	}

	function onCardVisible(entries: IntersectionObserverEntry[]) {
		for (const entry of entries) {
			if (!entry.isIntersecting) continue;
			const el = entry.target as HTMLElement;
			const addr = el.dataset.tokenAddr;
			const cid = Number(el.dataset.chainId);
			if (!addr) continue;
			const key = `${cid}:${addr.toLowerCase()}`;
			if (_safuQueried.has(key)) continue;
			_safuQueried.add(key);
			_safuPending.push({ address: addr, chain_id: cid });
		}
		if (_safuPending.length > 0) scheduleSafuBatch();
	}

	// ── ExploreLens: on-chain market data (price, mcap, holders, volume) ──
	let exploreLensMap: Record<string, ExploreTokenData> = $state({});

	async function fetchExploreLens() {
		const networks = _getNetworks();
		const providers = getNetworkProviders();
		if (!networks.length) return;

		// Group tokens by chain
		const byChain: Record<number, string[]> = {};
		for (const t of tokens) {
			if (!byChain[t.chain_id]) byChain[t.chain_id] = [];
			byChain[t.chain_id].push(t.address);
		}

		for (const [cidStr, addrs] of Object.entries(byChain)) {
			const cid = Number(cidStr);
			const net = networks.find(n => n.chain_id === cid);
			const provider = providers.get(cid);
			if (!net || !provider || !net.platform_address || !net.dex_router) continue;

			// Resolve dexFactory + weth
			let dexFactory = '';
			let weth = '';
			try {
				const r = new ethers.Contract(net.dex_router, ['function factory() view returns (address)', 'function WETH() view returns (address)'], provider);
				[dexFactory, weth] = await Promise.all([r.factory(), r.WETH()]);
			} catch { continue; }

			// Batch in groups of 24
			for (let i = 0; i < addrs.length; i += 24) {
				try {
					const batch = addrs.slice(i, i + 24);
					const results = await queryExploreLens(provider, net.platform_address, dexFactory, weth, net.usdt_address, batch);
					for (const r of results) {
						exploreLensMap[r.token.toLowerCase()] = r;
					}
					exploreLensMap = { ...exploreLensMap };
				} catch (e) {
					console.warn('ExploreLens batch failed:', (e as any)?.message?.slice(0, 100));
				}
			}
		}
	}

	// ── Merged data: ExploreLens (on-chain) + Gecko (24h change) ──
	function tokenPrice(tok: any): number {
		const lens = exploreLensMap[tok.address?.toLowerCase()];
		if (lens?.priceUsd && lens.priceUsd > 0) return lens.priceUsd;
		const g = geckoLookup[tok.address?.toLowerCase()];
		return g?.price_usd || 0;
	}

	function tokenHasData(tok: any): boolean {
		const lens = exploreLensMap[tok.address?.toLowerCase()];
		if (lens?.hasLiquidity) return true;
		return !!geckoLookup[tok.address?.toLowerCase()]?.has_data;
	}

	function tokenHolders(tok: any): number {
		return exploreLensMap[tok.address?.toLowerCase()]?.holderCount || 0;
	}

	function tokenVolume(tok: any): bigint {
		return exploreLensMap[tok.address?.toLowerCase()]?.totalVolume || 0n;
	}

	// GeckoTerminal market data — first 30 from SSR, rest filled client-side
	const GECKO_NETWORKS: Record<number, string> = { 56: 'bsc', 1: 'eth', 8453: 'base', 42161: 'arbitrum', 137: 'polygon_pos' };
	type GeckoInfo = { price_usd: number; volume_24h: number; price_change_24h: number; has_data: boolean; spark: number[] };

	function buildSpark(a: any, price: number): number[] {
		const pc = a?.price_change_percentage || {};
		const steps = ['h24', 'h6', 'h1', 'm30', 'm15', 'm5'] as const;
		const s: number[] = [];
		for (const k of steps) {
			const v = parseFloat(pc[k] || '0');
			s.push(price / (1 + v / 100));
		}
		s.push(price);
		return s;
	}

	function sparkPath(pts: number[], w: number, h: number): string {
		if (!pts || pts.length < 2) return '';
		const min = Math.min(...pts);
		const max = Math.max(...pts);
		const range = max - min || 1;
		const step = w / (pts.length - 1);
		return pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(h - ((v - min) / range) * h).toFixed(1)}`).join(' ');
	}
	let geckoMap: Record<string, GeckoInfo> = $state(data.geckoData || {});
	let geckoLoading = $state(tokens.length > 30);

	// Use $derived map so template reads are reactive
	let geckoLookup = $derived(geckoMap);

	// ── Trending tokens: top 8 by 24h volume with market data ──
	let withMarket = $derived.by(() => {
		return tokens
			.map(t => {
				const g = geckoMap[t.address?.toLowerCase()];
				if (!g?.has_data || g.price_usd <= 0) return null;
				const supply = parseFloat(ethers.formatUnits(data.supplyData?.[`${t.chain_id}:${t.address}`] || t.total_supply || '0', t.decimals || 18));
				const mcap = supply * g.price_usd;
				return { ...t, gecko: g, mcap };
			})
			.filter((t): t is NonNullable<typeof t> => t !== null);
	});

	let trending = $derived(
		withMarket
			.filter(t => t.gecko.volume_24h > 0)
			.sort((a, b) => b.gecko.volume_24h - a.gecko.volume_24h)
			.slice(0, 8)
	);

	// Top Gainers: positive 24h change, minimum volume to filter noise,
	// sorted by % change desc. Falls back to any positive change if volume
	// data is thin.
	let gainers = $derived.by(() => {
		const withVol = withMarket.filter(t => t.gecko.price_change_24h > 0 && t.gecko.volume_24h > 100);
		const base = withVol.length > 0 ? withVol : withMarket.filter(t => t.gecko.price_change_24h > 0);
		return [...base].sort((a, b) => b.gecko.price_change_24h - a.gecko.price_change_24h).slice(0, 6);
	});

	// ── Market cap helper for cards — ExploreLens first, Gecko fallback ──
	function tokenMcap(tok: any): number {
		const lens = exploreLensMap[tok.address?.toLowerCase()];
		if (lens?.marketCap && lens.marketCap > 0n) {
			// marketCap is in USDT-unit raw — format with USDT decimals (18 for BSC)
			return parseFloat(ethers.formatUnits(lens.marketCap, 18));
		}
		const g = geckoLookup[tok.address?.toLowerCase()];
		if (!g?.has_data || g.price_usd <= 0) return 0;
		const supply = parseFloat(ethers.formatUnits(data.supplyData?.[`${tok.chain_id}:${tok.address}`] || tok.total_supply || '0', tok.decimals || 18));
		return supply * g.price_usd;
	}

	function fmtMcap(val: number): string {
		if (val <= 0) return '—';
		if (val >= 1e9) return `$${(val / 1e9).toFixed(1)}B`;
		if (val >= 1e6) return `$${(val / 1e6).toFixed(1)}M`;
		if (val >= 1e3) return `$${(val / 1e3).toFixed(1)}K`;
		return `$${val.toFixed(0)}`;
	}

	function fmtPrice(val: number): string {
		if (val === 0) return '$0';
		if (val >= 1) return `$${val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
		// For sub-$1 prices, compute how many decimals are needed to show
		// 4 significant digits, then render via toFixed() to avoid
		// scientific notation for very small numbers.
		const absVal = Math.abs(val);
		const magnitude = Math.floor(Math.log10(absVal));
		const decimals = Math.min(20, Math.max(2, 4 - magnitude - 1));
		return `$${val.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '')}`;
	}

	function fmtVolume(val: number): string {
		if (val >= 1e6) return `$${(val / 1e6).toFixed(1)}M`;
		if (val >= 1e3) return `$${(val / 1e3).toFixed(1)}K`;
		if (val > 0) return `$${val.toFixed(2)}`;
		return '$0';
	}

	async function fetchGeckoBatch(addresses: string[], geckoNetwork: string) {
		if (addresses.length === 0) return;
		const batch = addresses.slice(0, 30);
		const url = `https://api.geckoterminal.com/api/v2/networks/${geckoNetwork}/tokens/multi/${batch.join(',')}`;
		try {
			const res = await fetch(url);
			if (!res.ok) return;
			const json = await res.json();
			const items = json?.data || [];
			for (const item of items) {
				const a = item.attributes;
				if (!a) continue;
				const addr = (item.id || '').split('_').pop()?.toLowerCase();
				if (!addr) continue;
				const p = parseFloat(a.price_usd || '0');
				geckoMap[addr] = {
					price_usd: p,
					volume_24h: parseFloat(a.volume_usd?.h24 || '0'),
					price_change_24h: parseFloat(a.price_change_percentage?.h24 || '0'),
					has_data: a.price_usd != null && p > 0,
					spark: buildSpark(a, p),
				};
			}
			// Trigger reactivity
			geckoMap = { ...geckoMap };
		} catch {}
	}

	// ── Live Launches ──
	let activeLaunches: any[] = $state([]);

	async function fetchActiveLaunches() {
		try {
			const res = await fetch('/api/launches?status=active&limit=5');
			if (!res.ok) return;
			const json = await res.json();
			activeLaunches = json?.launches || json?.data || json || [];
			if (!Array.isArray(activeLaunches)) activeLaunches = [];
		} catch {}
	}

	function launchProgress(l: any): number {
		try {
			const raised = parseFloat(ethers.formatUnits(l.total_base_raised || '0', l.usdt_decimals || 18));
			const cap = parseFloat(ethers.formatUnits(l.hard_cap || '1', l.usdt_decimals || 18));
			return cap > 0 ? Math.min((raised / cap) * 100, 100) : 0;
		} catch { return 0; }
	}

	function fmtLaunchAmount(raw: string | undefined, decimals: number): string {
		if (!raw || raw === '0') return '0';
		try {
			const n = parseFloat(ethers.formatUnits(raw, decimals));
			if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
			if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
			return n.toFixed(2);
		} catch { return '0'; }
	}

	function launchTimeRemaining(deadline: number): string {
		const now = Math.floor(Date.now() / 1000);
		const diff = deadline - now;
		if (diff <= 0) return 'Ended';
		const days = Math.floor(diff / 86400);
		const hrs = Math.floor((diff % 86400) / 3600);
		if (days > 0) return `${days}d ${hrs}h`;
		const mins = Math.floor((diff % 3600) / 60);
		if (hrs > 0) return `${hrs}h ${mins}m`;
		return `${mins}m`;
	}

	// Realtime subscription — prepend newly indexed tokens without a reload.
	// We only trust rows where the daemon has actually confirmed the token
	// on-chain. Creators can pre-save a row via /api/token-metadata before
	// the daemon indexes it (to attach logo/description early), but those
	// pre-saves ship with name='Pending', symbol='???', total_supply='0'.
	// We reject those until the daemon overwrites them with real chain data.
	let _tokensChannel: any = null;
	function isDaemonVerified(t: any): boolean {
		if (!t) return false;
		if (!t.name || t.name === 'Pending') return false;
		if (!t.symbol || t.symbol === '???') return false;
		if (!t.total_supply || t.total_supply === '0') return false;
		return true;
	}

	onMount(async () => {
		// Fetch active launches + on-chain token data (fire-and-forget)
		fetchActiveLaunches();
		fetchExploreLens();

		// Set up IntersectionObserver for lazy SafuLens badge detection
		if (typeof IntersectionObserver !== 'undefined') {
			_safuObserver = new IntersectionObserver(onCardVisible, { rootMargin: '200px' });
			setTimeout(() => {
				document.querySelectorAll('[data-token-addr]').forEach(el => _safuObserver?.observe(el));
			}, 100);
		}

		// Subscribe to daemon-verified tokens being indexed or updated.
		_tokensChannel = supabase
			.channel('explore-tokens')
			.on('postgres_changes', {
				event: 'INSERT',
				schema: 'public',
				table: 'created_tokens',
			}, (payload: any) => {
				const t = payload.new;
				if (!isDaemonVerified(t)) return;
				if (tokens.some(x => x.address?.toLowerCase() === t.address.toLowerCase())) return;
				tokens = [t, ...tokens];
				setTimeout(() => {
					document.querySelectorAll('[data-token-addr]').forEach(el => _safuObserver?.observe(el));
				}, 50);
			})
			.on('postgres_changes', {
				event: 'UPDATE',
				schema: 'public',
				table: 'created_tokens',
			}, (payload: any) => {
				const t = payload.new;
				if (!t?.address) return;
				const idx = tokens.findIndex(x => x.address?.toLowerCase() === t.address.toLowerCase());
				if (idx >= 0) {
					// Merge in updated fields — SAFU badges, logo, description, etc.
					tokens[idx] = { ...tokens[idx], ...t };
					tokens = tokens;
				} else if (isDaemonVerified(t)) {
					// First time seeing this one AND daemon has verified it
					// (e.g., daemon just overwrote a user's pre-save) — show it.
					tokens = [t, ...tokens];
					setTimeout(() => {
						document.querySelectorAll('[data-token-addr]').forEach(el => _safuObserver?.observe(el));
					}, 50);
				}
			})
			.subscribe();

		// First 30 already loaded from SSR — fetch remaining batches
		const remaining = tokens.slice(30);
		if (remaining.length === 0) { geckoLoading = false; return; }

		const byChain: Record<string, string[]> = {};
		for (const t of remaining) {
			const net = GECKO_NETWORKS[t.chain_id] || 'bsc';
			if (!byChain[net]) byChain[net] = [];
			byChain[net].push(t.address);
		}

		for (const [net, addrs] of Object.entries(byChain)) {
			for (let i = 0; i < addrs.length; i += 30) {
				await fetchGeckoBatch(addrs.slice(i, i + 30), net);
			}
		}
		geckoLoading = false;
	});

	onDestroy(() => {
		_safuObserver?.disconnect();
		if (_safuTimer) clearTimeout(_safuTimer);
		if (_tokensChannel) supabase.removeChannel(_tokensChannel);
	});

	// Re-observe cards when the filtered list changes
	$effect(() => {
		void filtered;
		if (!_safuObserver) return;
		setTimeout(() => {
			document.querySelectorAll('[data-token-addr]').forEach(el => _safuObserver?.observe(el));
		}, 50);
	});

	let filtered = $derived.by(() => {
		let list = tokens;

		// Outcome-based filters
		if (filterType === 'tradeable') {
			list = list.filter(t => {
				const s = safuMap[safuKey(t)];
				return s?.hasLiquidity || t.has_liquidity || geckoLookup[t.address?.toLowerCase()]?.has_data;
			});
		} else if (filterType === 'new') {
			list = list.filter(t => t.created_at && isNew(t.created_at));
		} else if (filterType === 'safu') {
			list = list.filter(t => {
				const s = safuMap[safuKey(t)];
				return s?.isSafu ?? t.is_safu ?? false;
			});
		}

		// Search
		if (search.trim()) {
			const q = search.toLowerCase();
			list = list.filter(t =>
				t.name?.toLowerCase().includes(q) ||
				t.symbol?.toLowerCase().includes(q) ||
				t.address?.toLowerCase().includes(q)
			);
		}

		// Sort
		if (sortBy === 'safu') {
			// SAFU first, then liquidity, then rest. Uses DB columns (pre-indexed
			// by the SAFU daemon) with client-side SafuLens as a live override.
			list = [...list].sort((a, b) => {
				const sa = safuMap[safuKey(a)];
				const sb = safuMap[safuKey(b)];
				const safuA = sa?.isSafu ?? a.is_safu ?? false;
				const safuB = sb?.isSafu ?? b.is_safu ?? false;
				const liqA = sa?.hasLiquidity ?? a.has_liquidity ?? false;
				const liqB = sb?.hasLiquidity ?? b.has_liquidity ?? false;
				const scoreA = (safuA ? 4 : 0) + (liqA ? 2 : 0);
				const scoreB = (safuB ? 4 : 0) + (liqB ? 2 : 0);
				if (scoreA !== scoreB) return scoreB - scoreA;
				return 0;
			});
		} else if (sortBy === 'name') {
			list = [...list].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
		}
		// 'newest' preserves default DB order

		return list;
	});

	function fmtSupply(raw: string | undefined, dec: number): string {
		if (!raw || raw === '0') return '—';
		try {
			const n = parseFloat(ethers.formatUnits(raw, dec));
			if (!Number.isFinite(n)) return '0';
			if (n >= 1e12) return `${(n / 1e12).toFixed(1)}T`;
			if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
			if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
			if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
			return n.toLocaleString();
		} catch { return '—'; }
	}

	function typeColor(t: any): string {
		if (t.is_partner) return 'purple';
		if (t.is_taxable) return 'amber';
		if (t.is_mintable) return 'cyan';
		return 'emerald';
	}

	function timeAgo(dateStr: string): string {
		const diff = NOW - new Date(dateStr).getTime();
		const mins = Math.floor(diff / 60000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		const hrs = Math.floor(mins / 60);
		if (hrs < 24) return `${hrs}h ago`;
		const days = Math.floor(hrs / 24);
		if (days < 30) return `${days}d ago`;
		return new Date(dateStr).toLocaleDateString();
	}

	function isNew(dateStr: string): boolean {
		return NOW - new Date(dateStr).getTime() < 24 * 60 * 60 * 1000;
	}

	function chainName(id: number): string {
		const map: Record<number, string> = { 56: 'BSC', 1: 'ETH', 8453: 'Base', 42161: 'Arbitrum', 137: 'Polygon' };
		return map[id] || 'BSC';
	}

	let typeCounts = $derived.by(() => {
		const counts = { all: tokens.length, tradeable: 0, new: 0, safu: 0 };
		for (const t of tokens) {
			const s = safuMap[safuKey(t)];
			if (s?.hasLiquidity || t.has_liquidity || geckoLookup[t.address?.toLowerCase()]?.has_data) counts.tradeable++;
			if (t.created_at && isNew(t.created_at)) counts.new++;
			if (s?.isSafu ?? t.is_safu) counts.safu++;
		}
		return counts;
	});

	// ── Pagination ──
	let page_num = $state(1);
	const PER_PAGE = 24;
	let paged = $derived(filtered.slice(0, page_num * PER_PAGE));
	let hasMore = $derived(filtered.length > page_num * PER_PAGE);

	// Reset page when filters change
	$effect(() => {
		void search;
		void filterType;
		void sortBy;
		page_num = 1;
	});

</script>

<svelte:head>
	<title>Explore Tokens | TokenKrafter</title>
	<meta name="description" content="Browse tokens created on TokenKrafter. Discover new projects, view token details, and trade." />
</svelte:head>

<div class="explore">
	<!-- Hero stats bar -->
	<div class="explore-header">
		<div>
			<h1 class="explore-title">Explore Tokens</h1>
			<div class="explore-stats">
				<span class="explore-stat"><strong>{tokens.length}</strong> tokens</span>
				{#if trending.length > 0}
					<span class="explore-stat-sep">·</span>
					<span class="explore-stat"><strong>{trending.length}</strong> trading</span>
				{/if}
			</div>
		</div>
		<div class="explore-header-right">
			<div class="explore-search">
				<svg class="search-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
				<input class="search-input" type="text" placeholder="Search name, symbol, or address..." bind:value={search} />
			</div>
			<a href="/create" class="explore-create-btn">
				<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
				Create
			</a>
		</div>
	</div>

	<!-- Trending — horizontal scroll of top tokens by volume -->
	{#if trending.length > 0 && !search.trim()}
		<div class="trending-section">
			<div class="trending-header">
				<span class="trending-dot"></span>
				<span class="trending-label">Trending</span>
			</div>
			<div class="trending-scroll">
				{#each trending as tok}
					{@const slug = chainSlug(tok.chain_id)}
					<a href="/explore/{slug}/{tok.address}" class="trending-card">
						<div class="trending-top">
							{#if tok.logo_url}
								<img src={tok.logo_url} alt="" class="trending-logo" />
							{:else}
								<div class="trending-logo-fallback">{tok.symbol?.slice(0, 2)}</div>
							{/if}
							<div class="trending-identity">
								<span class="trending-name">{tok.symbol || '???'}</span>
								<span class="trending-chain">{chainName(tok.chain_id)}</span>
							</div>
							<div class="trending-price-col">
								<span class="trending-price">{fmtPrice(tok.gecko.price_usd)}</span>
								<span class="trending-change" class:up={tok.gecko.price_change_24h > 0} class:down={tok.gecko.price_change_24h < 0}>
									{tok.gecko.price_change_24h > 0 ? '+' : ''}{tok.gecko.price_change_24h.toFixed(1)}%
								</span>
							</div>
						</div>
						{#if tok.gecko.spark && tok.gecko.spark.length > 1}
							<svg class="sparkline" viewBox="0 0 80 22" preserveAspectRatio="none" aria-hidden="true">
								<path d={sparkPath(tok.gecko.spark, 80, 22)} fill="none" stroke-width="1.5"
									stroke={tok.gecko.price_change_24h >= 0 ? '#10b981' : '#f87171'} />
							</svg>
						{/if}
						<div class="trending-bottom">
							<span class="trending-mcap">{fmtMcap(tok.mcap)} mcap</span>
							<span class="trending-vol">{fmtVolume(tok.gecko.volume_24h)} vol</span>
						</div>
					</a>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Top Gainers — tokens with biggest positive 24h move -->
	{#if gainers.length > 0 && !search.trim()}
		<div class="trending-section">
			<div class="trending-header">
				<span class="gainers-dot"></span>
				<span class="trending-label">Top Gainers</span>
				<span class="trending-sub">24h</span>
			</div>
			<div class="trending-scroll">
				{#each gainers as tok}
					{@const slug = chainSlug(tok.chain_id)}
					<a href="/explore/{slug}/{tok.address}" class="trending-card">
						<div class="trending-top">
							{#if tok.logo_url}
								<img src={tok.logo_url} alt="" class="trending-logo" />
							{:else}
								<div class="trending-logo-fallback">{tok.symbol?.slice(0, 2)}</div>
							{/if}
							<div class="trending-identity">
								<span class="trending-name">{tok.symbol || '???'}</span>
								<span class="trending-chain">{chainName(tok.chain_id)}</span>
							</div>
							<div class="trending-price-col">
								<span class="trending-price">{fmtPrice(tok.gecko.price_usd)}</span>
								<span class="trending-change up">+{tok.gecko.price_change_24h.toFixed(1)}%</span>
							</div>
						</div>
						{#if tok.gecko.spark && tok.gecko.spark.length > 1}
							<svg class="sparkline" viewBox="0 0 80 22" preserveAspectRatio="none" aria-hidden="true">
								<path d={sparkPath(tok.gecko.spark, 80, 22)} fill="none" stroke-width="1.5" stroke="#10b981" />
							</svg>
						{/if}
						<div class="trending-bottom">
							<span class="trending-mcap">{fmtMcap(tok.mcap)} mcap</span>
							<span class="trending-vol">{fmtVolume(tok.gecko.volume_24h)} vol</span>
						</div>
					</a>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Live Launches — active bonding curve sales -->
	{#if activeLaunches.length > 0 && !search.trim()}
		<div class="launches-section">
			<div class="trending-header">
				<span class="launches-dot"></span>
				<span class="trending-label">Live Launches</span>
			</div>
			<div class="trending-scroll">
				{#each activeLaunches as launch}
					{@const slug = chainSlug(launch.chain_id)}
					{@const decimals = launch.usdt_decimals || 18}
					{@const progress = launchProgress(launch)}
					{@const raised = fmtLaunchAmount(launch.total_base_raised, decimals)}
					{@const cap = fmtLaunchAmount(launch.hard_cap, decimals)}
					{@const timeLeft = launchTimeRemaining(launch.deadline)}
					<a href="/launchpad/{slug}/{launch.address}" class="launch-card">
						<div class="trending-top">
							{#if launch.logo_url}
								<img src={launch.logo_url} alt="" class="trending-logo" />
							{:else}
								<div class="trending-logo-fallback">{launch.token_symbol?.slice(0, 2) || '??'}</div>
							{/if}
							<div class="trending-identity">
								<span class="trending-name">{launch.token_name || 'Unknown'}</span>
								<span class="trending-chain">{launch.token_symbol}</span>
							</div>
							<div class="launch-time" class:launch-ended={timeLeft === 'Ended'}>
								{timeLeft}
							</div>
						</div>
						<div class="launch-progress-wrap">
							<div class="launch-progress-bar">
								<div class="launch-progress-fill" style="width:{progress}%"></div>
							</div>
							<div class="launch-progress-label">
								<span>{raised} / {cap} USDT</span>
								<span>{progress.toFixed(0)}%</span>
							</div>
						</div>
						<div class="launch-buy-row">
							{#if launch.is_partner}
								<span class="tc-badge tc-badge-partner">Partner</span>
							{/if}
							<span class="launch-buy-cta">Buy</span>
						</div>
					</a>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Filters -->
	<div class="explore-controls">
		<div class="filter-pills">
			{#each [['all','All'],['tradeable','Tradeable'],['new','New'],['safu','SAFU']] as [key, label]}
				<button
					class="filter-pill"
					class:filter-pill-active={filterType === key}
					class:filter-pill-tradeable={filterType === key && key === 'tradeable'}
					class:filter-pill-safu={filterType === key && key === 'safu'}
					onclick={() => filterType = key as typeof filterType}
				>
					{#if key === 'tradeable'}
						<span class="tradeable-dot" class:tradeable-dot-on={filterType === 'tradeable'}></span>
					{/if}
					{label}
					{#if typeCounts[key as keyof typeof typeCounts] > 0}
						<span class="filter-count">{typeCounts[key as keyof typeof typeCounts]}</span>
					{/if}
				</button>
			{/each}
		</div>
		<div class="explore-right-controls">
			<select class="sort-select" bind:value={sortBy}>
				<option value="safu">SAFU first</option>
				<option value="newest">Newest</option>
				<option value="name">A → Z</option>
			</select>
		</div>
	</div>

	<!-- Grid -->
	{#if filtered.length === 0}
		<div class="explore-empty">
			<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#374151" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
			<span>{search ? `No tokens match "${search}"` : 'No tokens created yet'}</span>
			{#if !search}
				<a href="/create" class="explore-empty-cta">Create the first token</a>
			{/if}
		</div>
	{:else}
		<div class="token-grid">
			{#each paged as tok}
				{@const color = typeColor(tok)}
				{@const slug = chainSlug(tok.chain_id)}
				{@const gecko = geckoLookup[tok.address?.toLowerCase()]}
				{@const safu = safuMap[safuKey(tok)]}
			<!-- SAFU uses the full SafuLens composite: owner renounced + trading
			     enabled + has liquidity + LP ≥99% burned + tax safe + mint safe.
			     Falls back to DB is_safu when SafuLens hasn't queried yet. -->
			{@const isSafu = safu?.isSafu ?? tok.is_safu ?? false}
				{@const mcap = tokenMcap(tok)}
				{@const hasData = tokenHasData(tok)}
				{@const price = tokenPrice(tok)}
				{@const holders = tokenHolders(tok)}
				{@const vol = tokenVolume(tok)}
				<a href="/explore/{slug}/{tok.address}" class="token-card" class:token-card-dim={!hasData} class:token-card-active={hasData && !isSafu} class:token-card-safu={isSafu} data-token-addr={tok.address} data-chain-id={tok.chain_id}>
					<!-- Row 1: Logo + identity + price -->
					<div class="tc-header">
						{#if tok.logo_url}
							<img src={tok.logo_url} alt={tok.symbol} class="tc-logo" />
						{:else}
							<div class="tc-logo-fallback tc-color-{color}">
								<span>{tok.symbol?.slice(0, 2).toUpperCase() || '??'}</span>
							</div>
						{/if}
						<div class="tc-identity">
							<span class="tc-name">{tok.name || 'Unknown'}</span>
							<div class="tc-meta-row">
								<span class="tc-symbol">{tok.symbol || '???'}</span>
								<span class="tc-chain">{chainName(tok.chain_id)}</span>
								{#if tok.created_at}
									<span class="tc-age">{timeAgo(tok.created_at)}</span>
								{/if}
								{#if gecko?.has_data}
									<span class="tc-live-dot" title="Live DEX data"></span>
								{/if}
							</div>
						</div>
						<div class="tc-header-right">
							{#if price > 0}
								<span class="tc-price">{fmtPrice(price)}</span>
								{#if gecko?.price_change_24h && gecko.price_change_24h !== 0}
									<span class="tc-change" class:tc-change-up={gecko.price_change_24h > 0} class:tc-change-down={gecko.price_change_24h < 0}>
										{gecko.price_change_24h > 0 ? '+' : ''}{gecko.price_change_24h.toFixed(1)}%
									</span>
								{/if}
								{#if gecko?.spark && gecko.spark.length > 1}
									<svg class="tc-spark" viewBox="0 0 64 18" preserveAspectRatio="none" aria-hidden="true">
										<path d={sparkPath(gecko.spark, 64, 18)} fill="none" stroke-width="1.4"
											stroke={gecko.price_change_24h >= 0 ? '#10b981' : '#f87171'} />
									</svg>
								{/if}
							{:else}
								<span class="tc-status-pill">{hasData ? 'Listed' : 'Pre-launch'}</span>
							{/if}
						</div>
					</div>

					<!-- Row 2: Badges (max 2) + market data -->
					<div class="tc-row2">
						<div class="tc-badges-row">
							{#if isSafu}
								<span
									class="tc-badge tc-badge-safu"
									title="SAFU — passes all on-chain safety checks:&#10;• Trading enabled + liquidity has reserves&#10;• LP ≥99% burned to 0xdEaD&#10;• Tax ceiling locked (or token is non-taxable)&#10;• Not mintable, or owner renounced"
								>SAFU</span>
							{/if}
							{#if tok.created_at && isNew(tok.created_at)}
								<span class="tc-badge tc-badge-new">New</span>
							{:else if tok.is_partner}
								<span class="tc-badge tc-badge-partner">Partner</span>
							{/if}
						</div>
						<div class="tc-market-data">
							{#if mcap > 0}
								<span class="tc-mcap">{fmtMcap(mcap)} mcap</span>
							{/if}
							{#if gecko?.has_data && gecko.volume_24h > 0}
								<span class="tc-vol">{fmtVolume(gecko.volume_24h)} vol</span>
							{/if}
						</div>
					</div>

					<!-- SAFU breakdown signals -->
					{#if isSafu}
						{@const taxLocked = safu?.taxCeilingLocked ?? tok.tax_ceiling_locked}
						{@const lpBurned = safu?.lpBurned ?? tok.lp_burned}
						{@const lpPct = safu?.lpBurnedPct ?? (tok.lp_burned_pct || 0)}
						{@const renounced = safu?.ownerIsZero ?? tok.owner_renounced}
						{@const trading = safu?.tradingEnabled ?? tok.trading_enabled}
						{@const buyTax = safu?.buyTaxBps ?? 0}
						{@const sellTax = safu?.sellTaxBps ?? 0}
						{@const hasLiq = safu?.hasLiquidity}
						{#if taxLocked || lpBurned || renounced || trading || hasLiq}
							<div class="tc-safu-signals">
								{#if renounced}<span class="tc-safu-check">&#10003; Renounced</span>{/if}
								{#if taxLocked}<span class="tc-safu-check">&#10003; Tax locked</span>{/if}
								{#if lpBurned}<span class="tc-safu-check">&#10003; LP burned {lpPct > 0 ? `${Math.round(lpPct / 100)}%` : ''}</span>{/if}
								{#if trading}<span class="tc-safu-check">&#10003; Trading on</span>{/if}
								{#if hasLiq}<span class="tc-safu-check">&#10003; Liquidity</span>{/if}
								{#if buyTax > 0 || sellTax > 0}<span class="tc-safu-check">&#10003; Tax {buyTax / 100}/{sellTax / 100}%</span>{/if}
							</div>
						{/if}
					{/if}

					<!-- Row 3: Stats strip — always fixed 3 columns (Supply | MCap | Holders) -->
					<div class="tc-stats">
						<div class="tc-stat">
							<span class="tc-stat-label">Supply</span>
							<span class="tc-stat-value">{fmtSupply(data.supplyData?.[`${tok.chain_id}:${tok.address}`] || tok.total_supply, tok.decimals || 18)}</span>
						</div>
						<div class="tc-stat">
							<span class="tc-stat-label">Market cap</span>
							<span class="tc-stat-value" class:tc-stat-dim={mcap <= 0}>
								{mcap > 0 ? fmtMcap(mcap) : 'Not listed'}
							</span>
						</div>
						<div class="tc-stat">
							<span class="tc-stat-label">Holders</span>
							<span class="tc-stat-value" class:tc-stat-dim={!holders}>
								{holders > 0 ? holders.toLocaleString() : '0'}
							</span>
						</div>
					</div>

					<!-- Action — always visible so card heights match. Text reflects state. -->
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div class="tc-actions" onclick={(e) => {
						if (hasData) { e.preventDefault(); e.stopPropagation(); window.location.href = `/trade?token=${tok.address}`; }
					}}>
						{#if hasData}
							<span class="tc-action tc-action-trade" role="button" tabindex="0">
								<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
								Trade
							</span>
						{:else}
							<span class="tc-action tc-action-view">
								<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
								View details
							</span>
						{/if}
					</div>
				</a>
			{/each}
		</div>
		{#if hasMore}
			<div class="load-more-wrap">
				<button class="load-more-btn" onclick={() => page_num++}>
					Load more ({filtered.length - paged.length} remaining)
				</button>
			</div>
		{/if}
	{/if}
</div>

<style>
	.explore { max-width: 1100px; margin: 0 auto; padding: 24px 16px 60px; }

	/* Header */
	.explore-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
	.explore-header-right { display: flex; align-items: center; gap: 10px; }
	.explore-title { font-family: 'Syne', sans-serif; font-size: 28px; font-weight: 800; color: var(--text-heading); margin: 0; }
	.explore-stats { display: flex; align-items: center; gap: 6px; margin-top: 4px; font-family: 'Space Mono', monospace; font-size: 12px; color: var(--text-dim); }
	.explore-stats strong { color: var(--text-heading); }
	.explore-stat-sep { color: var(--text-dim); opacity: 0.4; }
	.explore-create-btn {
		display: inline-flex; align-items: center; gap: 5px;
		padding: 8px 16px; border-radius: 10px;
		background: linear-gradient(135deg, #00d2ff, #3a7bd5); color: white;
		font-family: 'Syne', sans-serif; font-size: 12px; font-weight: 700;
		text-decoration: none; transition: all 0.15s; flex-shrink: 0;
	}
	.explore-create-btn:hover { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(0,210,255,0.3); }

	.explore-search {
		display: flex; align-items: center; gap: 8px;
		padding: 8px 14px; border-radius: 10px;
		background: var(--bg-surface); border: 1px solid var(--border);
		min-width: 260px; transition: border-color 0.15s;
	}
	.explore-search:focus-within { border-color: rgba(0,210,255,0.3); }
	.search-icon { color: var(--text-dim); flex-shrink: 0; }
	.search-input {
		background: transparent; border: none; outline: none; flex: 1;
		color: var(--text); font-family: 'Space Mono', monospace; font-size: 12px;
	}
	.search-input::placeholder { color: var(--text-dim); }

	/* Controls */
	.explore-controls { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
	.filter-pills { display: flex; gap: 6px; flex-wrap: wrap; }
	.filter-pill {
		display: inline-flex; align-items: center; gap: 5px;
		padding: 5px 12px; border-radius: 8px; border: 1px solid var(--border);
		background: var(--bg-surface); color: var(--text-dim);
		font-family: 'Space Mono', monospace; font-size: 11px;
		cursor: pointer; transition: all 0.15s;
	}
	.filter-pill:hover { border-color: var(--placeholder); color: var(--text-muted); }
	.filter-pill-active { border-color: rgba(0,210,255,0.3); background: rgba(0,210,255,0.06); color: #00d2ff; }
	.filter-count { font-size: 9px; opacity: 0.6; }

	.explore-right-controls { display: flex; align-items: center; gap: 8px; }
	.filter-pill-tradeable { border-color: rgba(16,185,129,0.3); background: rgba(16,185,129,0.08); color: #10b981; }
	.filter-pill-safu { border-color: rgba(16,185,129,0.3); background: rgba(16,185,129,0.08); color: #10b981; }
	.tradeable-dot { width: 6px; height: 6px; border-radius: 50%; background: #374151; transition: all 0.15s; }
	.tradeable-dot-on { background: #10b981; box-shadow: 0 0 6px rgba(16,185,129,0.5); }

	.sort-select {
		padding: 6px 10px; border-radius: 8px;
		background: var(--bg-surface); border: 1px solid var(--border);
		color: var(--text-muted); font-family: 'Space Mono', monospace; font-size: 11px;
		cursor: pointer; outline: none;
	}
	.sort-select option { background: var(--bg); }

	/* Empty */
	.explore-empty {
		display: flex; flex-direction: column; align-items: center; gap: 8px;
		text-align: center; padding: 60px 0; color: var(--text-dim);
		font-family: 'Space Mono', monospace; font-size: 13px;
	}
	.explore-empty-cta {
		margin-top: 8px; padding: 9px 20px; border-radius: 10px;
		background: linear-gradient(135deg, #00d2ff, #3a7bd5); color: white;
		font-family: 'Syne', sans-serif; font-weight: 700; font-size: 13px;
		text-decoration: none; transition: all 0.2s;
	}
	.explore-empty-cta:hover { transform: translateY(-1px); box-shadow: 0 6px 24px rgba(0,210,255,0.3); }

	/* Grid */
	.token-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }

	.token-card {
		display: flex; flex-direction: column; gap: 10px;
		padding: 16px; border-radius: 12px; min-height: 230px;
		background: var(--bg-surface); border: 1px solid var(--border-subtle);
		transition: all 0.15s;
		overflow: hidden; min-width: 0;
	}
	.token-card:hover { border-color: rgba(0,210,255,0.25); box-shadow: 0 6px 24px rgba(0,0,0,0.2); transform: translateY(-2px); }
	.token-card-safu { border-color: rgba(16,185,129,0.25); }
	.token-card-safu:hover { border-color: rgba(16,185,129,0.5); box-shadow: 0 6px 24px rgba(16,185,129,0.12); }
	.token-card-dim { opacity: 0.85; }
	.token-card-dim:hover { opacity: 1; }

	/* Badges row */
	.tc-badges-row { display: flex; gap: 4px; align-items: center; justify-content: flex-end; }
	.tc-badge-new { background: rgba(16,185,129,0.15); color: #10b981; }
	.tc-badge-safu { background: rgba(16,185,129,0.2); color: #10b981; font-weight: 800; border: 1px solid rgba(16,185,129,0.3); }
	.tc-badge-lp { background: rgba(59,130,246,0.12); color: #60a5fa; }
	.tc-badge-renounced { background: rgba(16,185,129,0.12); color: #34d399; }
	.tc-badge-locked { background: rgba(139,92,246,0.12); color: #a78bfa; }
	.tc-badge-tax { background: rgba(245,158,11,0.12); color: #f59e0b; }
	.tc-badge-mintable { background: rgba(239,68,68,0.12); color: #f87171; }
	.tc-badge-partner { background: rgba(139,92,246,0.12); color: #a78bfa; }
	.tc-badge-ownable { background: rgba(100,116,139,0.12); color: var(--text-muted); }
	.tc-liq-row { display: flex; gap: 4px; margin-top: 2px; }
	.tc-liq { font-family: 'Space Mono', monospace; font-size: 9px; color: var(--text-dim); }
	.tc-liq-warn { font-family: 'Space Mono', monospace; font-size: 9px; color: #f59e0b; }

	/* SAFU breakdown signals */
	.tc-safu-signals { display: flex; flex-wrap: wrap; gap: 3px 6px; margin-top: -4px; }
	.tc-safu-check { font-family: 'Space Mono', monospace; font-size: 8px; color: #10b981; white-space: nowrap; line-height: 1.2; }

	/* Header */
	.tc-header { display: flex; align-items: flex-start; gap: 12px; text-decoration: none; color: inherit; min-width: 0; }
	.tc-logo { width: 46px; height: 46px; border-radius: 12px; object-fit: cover; border: 1px solid var(--border); flex-shrink: 0; }
	.tc-logo-fallback {
		width: 46px; height: 46px; border-radius: 12px; flex-shrink: 0;
		display: flex; align-items: center; justify-content: center;
		font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 800;
	}
	.tc-color-cyan { background: rgba(0,210,255,0.12); color: #00d2ff; border: 2px solid rgba(0,210,255,0.2); }
	.tc-color-amber { background: rgba(245,158,11,0.12); color: #f59e0b; border: 2px solid rgba(245,158,11,0.2); }
	.tc-color-purple { background: rgba(139,92,246,0.12); color: #a78bfa; border: 2px solid rgba(139,92,246,0.2); }
	.tc-color-emerald { background: rgba(16,185,129,0.12); color: #10b981; border: 2px solid rgba(16,185,129,0.2); }

	.tc-identity { flex: 1; min-width: 0; }
	.tc-name {
		display: -webkit-box; -webkit-box-orient: vertical;
		-webkit-line-clamp: 2; line-clamp: 2;
		font-family: 'Syne', sans-serif; font-size: 16px; font-weight: 800;
		color: var(--text-heading); letter-spacing: -0.01em; line-height: 1.25;
		overflow: hidden; overflow-wrap: anywhere; word-break: break-word;
	}
	.tc-meta-row { display: flex; align-items: center; gap: 6px; margin-top: 4px; flex-wrap: wrap; }
	.tc-symbol { font-family: 'Space Mono', monospace; font-size: 10px; color: var(--text-dim); }
	.tc-chain { font-family: 'Space Mono', monospace; font-size: 8px; color: var(--text-dim); padding: 1px 5px; border-radius: 4px; background: var(--bg-surface-input); }
	.tc-age { font-family: 'Space Mono', monospace; font-size: 9px; color: var(--text-dim); opacity: 0.7; }

	.tc-badge {
		font-size: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
		padding: 2px 7px; border-radius: 99px; font-family: 'Space Mono', monospace; flex-shrink: 0;
	}
	.tc-badge-cyan { background: rgba(0,210,255,0.1); color: #00d2ff; }
	.tc-badge-amber { background: rgba(245,158,11,0.1); color: #f59e0b; }
	.tc-badge-purple { background: rgba(139,92,246,0.1); color: #a78bfa; }
	.tc-badge-emerald { background: rgba(16,185,129,0.1); color: #10b981; }

	/* Header right (badge + price) */
	.tc-header-right { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; flex-shrink: 0; }
	.tc-price { font-family: 'Rajdhani', sans-serif; font-size: 15px; font-weight: 700; color: var(--text-heading); font-variant-numeric: tabular-nums; line-height: 1; }
	.tc-change { font-family: 'Rajdhani', sans-serif; font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1; }
	.tc-change-up { color: #10b981; }
	.tc-change-down { color: #f87171; }

	/* Live dot */
	.tc-live-dot {
		width: 5px; height: 5px; border-radius: 50%;
		background: #10b981; flex-shrink: 0;
		box-shadow: 0 0 4px rgba(16,185,129,0.5);
	}

	/* Description */
	.tc-desc {
		font-family: 'Space Mono', monospace; font-size: 10px; color: var(--text-dim);
		line-height: 1.5; margin: 0;
	}

	/* Stats */
	.tc-stats { display: flex; gap: 0; border-radius: 8px; overflow: hidden; border: 1px solid var(--border-subtle); }
	.tc-stat { flex: 1; padding: 7px 10px; }
	.tc-stat + .tc-stat { border-left: 1px solid var(--border-subtle); }
	.tc-stat-label { display: block; font-size: 8px; color: var(--text-dim); font-family: 'Space Mono', monospace; text-transform: uppercase; letter-spacing: 0.04em; }
	.tc-stat-value { display: block; font-family: 'Rajdhani', sans-serif; font-size: 14px; font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums; margin-top: 1px; }

	/* Actions */
	.tc-actions { display: flex; gap: 8px; margin-top: auto; }
	.tc-action {
		display: inline-flex; align-items: center; gap: 5px;
		padding: 7px 14px; border-radius: 8px;
		font-family: 'Space Mono', monospace; font-size: 11px;
		text-decoration: none; transition: all 0.15s; cursor: pointer;
	}
	.tc-action-trade {
		flex: 1; justify-content: center;
		background: linear-gradient(135deg, rgba(0,210,255,0.12), rgba(59,130,246,0.12));
		border: 1px solid rgba(0,210,255,0.15); color: #00d2ff;
	}
	.tc-action-trade:hover { background: linear-gradient(135deg, rgba(0,210,255,0.2), rgba(59,130,246,0.2)); border-color: rgba(0,210,255,0.3); }
	.tc-action-view {
		padding: 7px 12px;
		background: var(--bg-surface); border: 1px solid var(--border);
		color: var(--text-dim);
	}
	.tc-action-view:hover { color: var(--text); border-color: var(--placeholder); }
	.tc-action-full { flex: 1; justify-content: center; }
	.tc-not-listed { color: var(--text-dim); font-size: 11px; }
	.tc-listed { color: #10b981; font-size: 11px; }

	/* ── Trending Section ── */
	.trending-section { margin-bottom: 20px; }
	.trending-header {
		display: flex; align-items: center; gap: 8px; margin-bottom: 10px;
	}
	.trending-dot {
		width: 7px; height: 7px; border-radius: 50%;
		background: #10b981; box-shadow: 0 0 8px rgba(16,185,129,0.6);
		animation: pulse 2s ease-in-out infinite;
	}
	@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
	.trending-label { font-family: 'Syne', sans-serif; font-size: 13px; font-weight: 700; color: var(--text-heading); }
	.trending-scroll {
		display: flex; gap: 10px; overflow-x: auto; padding-bottom: 8px;
		scrollbar-width: thin; scrollbar-color: var(--bg-surface-hover) transparent;
	}
	.trending-scroll::-webkit-scrollbar { height: 4px; }
	.trending-scroll::-webkit-scrollbar-thumb { background: var(--bg-surface-hover); border-radius: 2px; }
	.trending-card {
		display: flex; flex-direction: column; gap: 8px;
		min-width: 200px; max-width: 240px; padding: 12px 14px;
		background: var(--bg-surface); border: 1px solid var(--border-subtle);
		border-radius: 10px; text-decoration: none; color: inherit;
		transition: all 0.15s; flex-shrink: 0;
	}
	.trending-card:hover { border-color: rgba(0,210,255,0.2); transform: translateY(-2px); box-shadow: 0 6px 20px rgba(0,0,0,0.15); }
	.trending-top { display: flex; align-items: center; gap: 8px; }
	.trending-logo { width: 28px; height: 28px; border-radius: 50%; object-fit: cover; flex-shrink: 0; border: 1px solid var(--border); }
	.trending-logo-fallback {
		width: 28px; height: 28px; border-radius: 50%; flex-shrink: 0;
		display: flex; align-items: center; justify-content: center;
		background: rgba(0,210,255,0.1); color: #00d2ff; border: 1px solid rgba(0,210,255,0.2);
		font-size: 10px; font-weight: 800; font-family: 'Syne', sans-serif;
	}
	.trending-identity { flex: 1; min-width: 0; }
	.trending-name { display: block; font-family: 'Syne', sans-serif; font-size: 13px; font-weight: 700; color: var(--text-heading); }
	.trending-chain { font-family: 'Space Mono', monospace; font-size: 9px; color: var(--text-dim); }
	.trending-price-col { text-align: right; flex-shrink: 0; }
	.trending-price { display: block; font-family: 'Rajdhani', sans-serif; font-size: 14px; font-weight: 700; color: var(--text-heading); font-variant-numeric: tabular-nums; }
	.trending-change { font-family: 'Rajdhani', sans-serif; font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
	.trending-change.up { color: #10b981; }
	.trending-change.down { color: #f87171; }
	.trending-bottom { display: flex; justify-content: space-between; font-family: 'Space Mono', monospace; font-size: 9px; color: var(--text-dim); }

	/* Sparklines */
	.sparkline { width: 100%; height: 22px; display: block; opacity: 0.85; }
	.tc-spark { width: 64px; height: 18px; margin-top: 2px; opacity: 0.85; }

	.tc-status-pill {
		font-family: 'Space Mono', monospace; font-size: 9px; font-weight: 700;
		padding: 3px 8px; border-radius: 99px;
		background: var(--bg-surface-input); color: var(--text-dim);
		text-transform: uppercase; letter-spacing: 0.05em;
	}

	/* Gainers header dot */
	.gainers-dot {
		width: 7px; height: 7px; border-radius: 50%;
		background: #f59e0b; box-shadow: 0 0 8px rgba(245,158,11,0.6);
		animation: pulse 2s ease-in-out infinite;
	}
	.trending-sub { font-family: 'Space Mono', monospace; font-size: 10px; color: var(--text-dim); margin-left: 2px; }

	/* ── Tightened card: Row 2 (badges + market data) ── */
	.tc-row2 { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
	.tc-market-data { display: flex; align-items: center; gap: 8px; }
	.tc-mcap { font-family: 'Rajdhani', sans-serif; font-size: 15px; font-weight: 700; color: var(--text-heading); font-variant-numeric: tabular-nums; }
	.tc-vol { font-family: 'Space Mono', monospace; font-size: 9px; color: var(--text-dim); }
	.tc-unlisted { font-family: 'Space Mono', monospace; font-size: 9px; color: var(--text-dim); }

	/* Make the whole card an <a> — remove old action buttons row for unlisted tokens */
	.token-card { text-decoration: none; color: inherit; cursor: pointer; }

	/* ── Visual triage borders ── */
	.token-card-active { border-left: 3px solid rgba(0,210,255,0.4); }
	.token-card-safu { border-left: 3px solid rgba(16,185,129,0.4); }

	/* ── Subtle dim for unlisted tokens — only noticeable when mixed with listed ones ── */
	.token-card-dim { opacity: 0.8; }
	.token-card-dim:hover { opacity: 1; }

	/* ── Live Launches Section ── */
	.launches-section { margin-bottom: 20px; }
	.launches-dot {
		width: 7px; height: 7px; border-radius: 50%;
		background: #00d2ff; box-shadow: 0 0 8px rgba(0,210,255,0.6);
		animation: pulse 2s ease-in-out infinite;
	}
	.launch-card {
		display: flex; flex-direction: column; gap: 8px;
		min-width: 220px; max-width: 260px; padding: 12px 14px;
		background: var(--bg-surface); border: 1px solid var(--border-subtle);
		border-radius: 10px; text-decoration: none; color: inherit;
		transition: all 0.15s; flex-shrink: 0;
	}
	.launch-card:hover { border-color: rgba(0,210,255,0.2); transform: translateY(-2px); box-shadow: 0 6px 20px rgba(0,0,0,0.15); }
	.launch-time {
		font-family: 'Space Mono', monospace; font-size: 10px; font-weight: 700;
		color: #10b981; flex-shrink: 0; white-space: nowrap;
	}
	.launch-ended { color: #f87171; }
	.launch-progress-wrap { display: flex; flex-direction: column; gap: 4px; }
	.launch-progress-bar {
		height: 5px; border-radius: 3px; background: var(--border-subtle); overflow: hidden;
	}
	.launch-progress-fill {
		height: 100%; border-radius: 3px;
		background: linear-gradient(90deg, #00d2ff, #10b981);
		transition: width 0.3s ease;
	}
	.launch-progress-label {
		display: flex; justify-content: space-between;
		font-family: 'Space Mono', monospace; font-size: 9px; color: var(--text-dim);
	}
	.launch-buy-row {
		display: flex; align-items: center; justify-content: space-between; gap: 6px;
	}
	.launch-buy-cta {
		margin-left: auto;
		font-family: 'Space Mono', monospace; font-size: 10px; font-weight: 700;
		color: #00d2ff; padding: 3px 10px; border-radius: 6px;
		background: rgba(0,210,255,0.1); border: 1px solid rgba(0,210,255,0.15);
		transition: all 0.15s;
	}
	.launch-card:hover .launch-buy-cta { background: rgba(0,210,255,0.18); border-color: rgba(0,210,255,0.3); }

	/* ── Load More ── */
	.load-more-wrap { display: flex; justify-content: center; padding: 24px 0 8px; }
	.load-more-btn {
		padding: 10px 28px; border-radius: 10px; cursor: pointer;
		background: var(--bg-surface); border: 1px solid var(--border);
		color: var(--text-muted); font-family: 'Space Mono', monospace; font-size: 12px;
		transition: all 0.15s;
	}
	.load-more-btn:hover { border-color: rgba(0,210,255,0.3); color: #00d2ff; background: rgba(0,210,255,0.04); }

	@media (max-width: 500px) {
		.explore-header { flex-direction: column; }
		.explore-header-right { width: 100%; }
		.explore-search { min-width: 0; flex: 1; }
		.explore-controls { flex-direction: column; align-items: flex-start; }
		.token-grid { grid-template-columns: 1fr; }
		.trending-card { min-width: 180px; }
		.launch-card { min-width: 200px; }
		.tc-name { font-size: 14px; }
		.tc-price { font-size: 13px; }
		.tc-logo, .tc-logo-fallback { width: 38px; height: 38px; }
		.tc-spark { width: 48px; }
		.token-card { padding: 12px; }
		.tc-stats { overflow: hidden; }
		.tc-stat { padding: 6px 6px; min-width: 0; }
		.tc-stat-value { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	}
</style>
