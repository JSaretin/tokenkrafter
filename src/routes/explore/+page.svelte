<script lang="ts">
	import { ethers } from 'ethers';
	import { getContext, onMount, onDestroy } from 'svelte';
	import { chainSlug, type SupportedNetwork } from '$lib/structure';
	import { querySafuLens, type TokenSafu } from '$lib/safuLens';
	import { page } from '$app/state';

	let { data }: { data: any } = $props();
	let tokens: any[] = data.tokens;
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

	// GeckoTerminal market data — first 30 from SSR, rest filled client-side
	const GECKO_NETWORKS: Record<number, string> = { 56: 'bsc', 1: 'eth', 8453: 'base', 42161: 'arbitrum', 137: 'polygon_pos' };
	type GeckoInfo = { price_usd: number; volume_24h: number; price_change_24h: number; has_data: boolean };
	let geckoMap: Record<string, GeckoInfo> = $state(data.geckoData || {});
	let geckoLoading = $state(tokens.length > 30);

	// Use $derived map so template reads are reactive
	let geckoLookup = $derived(geckoMap);

	// ── Trending tokens: top 8 by 24h volume with market data ──
	let trending = $derived.by(() => {
		return tokens
			.map(t => {
				const g = geckoMap[t.address?.toLowerCase()];
				if (!g?.has_data || g.price_usd <= 0) return null;
				const supply = parseFloat(ethers.formatUnits(data.supplyData?.[`${t.chain_id}:${t.address}`] || t.total_supply || '0', t.decimals || 18));
				const mcap = supply * g.price_usd;
				return { ...t, gecko: g, mcap };
			})
			.filter((t): t is NonNullable<typeof t> => t !== null && t.gecko.volume_24h > 0)
			.sort((a, b) => b.gecko.volume_24h - a.gecko.volume_24h)
			.slice(0, 8);
	});

	// ── Market cap helper for cards ──
	function tokenMcap(tok: any): number {
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
		// Show full precision for small prices (as returned by GCT)
		const s = val.toPrecision(7);
		return `$${parseFloat(s)}`;
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
				geckoMap[addr] = {
					price_usd: parseFloat(a.price_usd || '0'),
					volume_24h: parseFloat(a.volume_usd?.h24 || '0'),
					price_change_24h: parseFloat(a.price_change_percentage?.h24 || '0'),
					has_data: a.price_usd != null && parseFloat(a.price_usd) > 0,
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

	onMount(async () => {
		// Fetch active launches (fire-and-forget)
		fetchActiveLaunches();

		// Set up IntersectionObserver for lazy SafuLens badge detection
		if (typeof IntersectionObserver !== 'undefined') {
			_safuObserver = new IntersectionObserver(onCardVisible, { rootMargin: '200px' });
			setTimeout(() => {
				document.querySelectorAll('[data-token-addr]').forEach(el => _safuObserver?.observe(el));
			}, 100);
		}

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
				<a href="/explore/{slug}/{tok.address}" class="token-card" class:token-card-dim={!gecko?.has_data} class:token-card-active={gecko?.has_data && gecko.volume_24h > 0 && !isSafu} class:token-card-safu={isSafu} data-token-addr={tok.address} data-chain-id={tok.chain_id}>
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
									<span class="tc-live-dot"></span>
								{/if}
							</div>
						</div>
						{#if gecko?.has_data}
							<div class="tc-header-right">
								<span class="tc-price">{fmtPrice(gecko.price_usd)}</span>
								{#if gecko.price_change_24h !== 0}
									<span class="tc-change" class:tc-change-up={gecko.price_change_24h > 0} class:tc-change-down={gecko.price_change_24h < 0}>
										{gecko.price_change_24h > 0 ? '+' : ''}{gecko.price_change_24h.toFixed(1)}%
									</span>
								{/if}
							</div>
						{/if}
					</div>

					<!-- Row 2: Badges (max 2) + market data -->
					<div class="tc-row2">
						<div class="tc-badges-row">
							{#if isSafu}
								<span class="tc-badge tc-badge-safu">SAFU</span>
							{/if}
							{#if tok.created_at && isNew(tok.created_at)}
								<span class="tc-badge tc-badge-new">New</span>
							{:else if tok.is_partner}
								<span class="tc-badge tc-badge-partner">Partner</span>
							{/if}
						</div>
						<div class="tc-market-data">
							{#if mcap > 0}
								<span class="tc-mcap">{fmtMcap(mcap)}</span>
							{/if}
							{#if gecko?.has_data && gecko.volume_24h > 0}
								<span class="tc-vol">{fmtVolume(gecko.volume_24h)}</span>
							{:else if !gecko?.has_data}
								<span class="tc-unlisted">&mdash;</span>
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

					<!-- Row 3: Stats strip -->
					<div class="tc-stats">
						<div class="tc-stat">
							<span class="tc-stat-label">Supply</span>
							<span class="tc-stat-value">{fmtSupply(data.supplyData?.[`${tok.chain_id}:${tok.address}`] || tok.total_supply, tok.decimals || 18)}</span>
						</div>
						<div class="tc-stat">
							<span class="tc-stat-label">{mcap > 0 ? 'MCap' : 'Status'}</span>
							<span class="tc-stat-value">{mcap > 0 ? fmtMcap(mcap) : (gecko?.has_data ? 'Listed' : '\u2014')}</span>
						</div>
						<div class="tc-stat">
							<span class="tc-stat-label">Age</span>
							<span class="tc-stat-value">{tok.created_at ? timeAgo(tok.created_at) : '—'}</span>
						</div>
					</div>

					<!-- Trade CTA (only when tradeable) -->
					{#if gecko?.has_data}
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div class="tc-actions" onclick={(e) => { e.preventDefault(); e.stopPropagation(); window.location.href = `/trade?token=${tok.address}`; }}>
							<span class="tc-action tc-action-trade" role="button" tabindex="0">
								<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
								Trade
							</span>
						</div>
					{/if}
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
		padding: 16px; border-radius: 12px;
		background: var(--bg-surface); border: 1px solid var(--border-subtle);
		transition: all 0.15s;
	}
	.token-card:hover { border-color: rgba(0,210,255,0.15); box-shadow: 0 4px 20px rgba(0,0,0,0.15); }

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
	.tc-header { display: flex; align-items: center; gap: 10px; text-decoration: none; color: inherit; }
	.tc-logo { width: 48px; height: 48px; border-radius: 50%; object-fit: cover; border: 2px solid var(--border); flex-shrink: 0; }
	.tc-logo-fallback {
		width: 48px; height: 48px; border-radius: 50%; flex-shrink: 0;
		display: flex; align-items: center; justify-content: center;
		font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 800;
	}
	.tc-color-cyan { background: rgba(0,210,255,0.12); color: #00d2ff; border: 2px solid rgba(0,210,255,0.2); }
	.tc-color-amber { background: rgba(245,158,11,0.12); color: #f59e0b; border: 2px solid rgba(245,158,11,0.2); }
	.tc-color-purple { background: rgba(139,92,246,0.12); color: #a78bfa; border: 2px solid rgba(139,92,246,0.2); }
	.tc-color-emerald { background: rgba(16,185,129,0.12); color: #10b981; border: 2px solid rgba(16,185,129,0.2); }

	.tc-identity { flex: 1; min-width: 0; }
	.tc-name { display: block; font-family: 'Syne', sans-serif; font-size: 15px; font-weight: 700; color: var(--text-heading); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.tc-meta-row { display: flex; align-items: center; gap: 6px; margin-top: 2px; }
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

	/* ── Dim unlisted tokens ── */
	.token-card-dim { opacity: 0.55; }
	.token-card-dim:hover { opacity: 0.85; }

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
	}
</style>
