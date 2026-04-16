<script lang="ts">
	import { ethers } from 'ethers';
	import { getContext, onMount, onDestroy } from 'svelte';
	import { chainSlug, type SupportedNetwork } from '$lib/structure';
	import { progressPercent } from '$lib/launchpad';
	import { querySafuLens, type TokenSafu } from '$lib/safuLens';
	import LaunchProgressBar from '$lib/LaunchProgressBar.svelte';
	import LaunchCountdown from '$lib/LaunchCountdown.svelte';
	import TokenLogo from '$lib/TokenLogo.svelte';

	let { data }: { data: any } = $props();
	let tokens: any[] = data.tokens;
	let activeLaunches: any[] = data.activeLaunches || [];
	let activeLaunchAddrs = $derived(new Set(
		activeLaunches.map((l: any) => (l.token_address || '').toLowerCase()).filter(Boolean)
	));
	function isOnLaunchpad(tok: any): boolean {
		return activeLaunchAddrs.has(tok.address?.toLowerCase());
	}
	let search = $state('');
	let sortBy = $state<'newest' | 'safu' | 'name'>('safu');
	let filterType = $state<'all' | 'basic' | 'taxable' | 'mintable' | 'partner'>('all');
	let tradeableOnly = $state(false);

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

	function fmtPrice(val: number): string {
		if (val === 0) return '$0';
		if (val >= 1) return `$${val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
		if (val >= 0.01) return `$${val.toFixed(4)}`;
		// Subscript notation for tiny prices: $0.0₇2008
		const str = val.toFixed(20);
		const afterDot = str.split('.')[1] || '';
		let zeros = 0;
		for (const ch of afterDot) {
			if (ch === '0') zeros++;
			else break;
		}
		if (zeros < 2) return `$${val.toFixed(4)}`;
		const sig = afterDot.slice(zeros, zeros + 4).replace(/0+$/, '');
		const sub = String(zeros).split('').map(d => '₀₁₂₃₄₅₆₇₈₉'[+d]).join('');
		return `$0.0${sub}${sig || '0'}`;
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

	onMount(async () => {
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

		// Tradeable filter — DB columns first (indexed by SAFU daemon),
		// client-side SafuLens overlay for freshness, Gecko as fallback.
		if (tradeableOnly) {
			list = list.filter(t => {
				const s = safuMap[safuKey(t)];
				return s?.hasLiquidity || t.has_liquidity || geckoLookup[t.address?.toLowerCase()]?.has_data;
			});
		}

		// Type filter
		if (filterType !== 'all') {
			list = list.filter(t => {
				if (filterType === 'taxable') return t.is_taxable;
				if (filterType === 'mintable') return t.is_mintable;
				if (filterType === 'partner') return t.is_partner;
				return !t.is_taxable && !t.is_mintable && !t.is_partner;
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
				// Client-side override takes precedence over DB if available
				const safuA = sa?.isSafu ?? a.is_safu ?? false;
				const safuB = sb?.isSafu ?? b.is_safu ?? false;
				const liqA = sa?.hasLiquidity ?? a.has_liquidity ?? false;
				const liqB = sb?.hasLiquidity ?? b.has_liquidity ?? false;
				const tradeA = sa?.tradingEnabled ?? a.trading_enabled ?? false;
				const tradeB = sb?.tradingEnabled ?? b.trading_enabled ?? false;
				const scoreA = (safuA ? 4 : 0) + (liqA ? 2 : 0) + (tradeA ? 1 : 0);
				const scoreB = (safuB ? 4 : 0) + (liqB ? 2 : 0) + (tradeB ? 1 : 0);
				if (scoreA !== scoreB) return scoreB - scoreA;
				return 0; // preserve DB order within same tier
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

	function tokenType(t: any): string {
		if (t.is_partner && t.is_taxable) return 'Partner+Tax';
		if (t.is_partner) return 'Partner';
		if (t.is_taxable && t.is_mintable) return 'Tax+Mint';
		if (t.is_taxable) return 'Taxable';
		if (t.is_mintable) return 'Mintable';
		return 'Basic';
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
		const counts = { all: tokens.length, basic: 0, taxable: 0, mintable: 0, partner: 0 };
		for (const t of tokens) {
			if (t.is_partner) counts.partner++;
			else if (t.is_taxable) counts.taxable++;
			else if (t.is_mintable) counts.mintable++;
			else counts.basic++;
		}
		return counts;
	});
</script>

<svelte:head>
	<title>Explore Tokens | TokenKrafter</title>
	<meta name="description" content="Browse tokens created on TokenKrafter. Discover new projects, view token details, and trade." />
</svelte:head>

<div class="explore">
	<!-- Header -->
	<div class="explore-header">
		<div>
			<h1 class="explore-title">Explore Tokens</h1>
			<p class="explore-sub">{tokens.length} tokens on TokenKrafter</p>
		</div>
		<div class="explore-search">
			<svg class="search-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
			<input class="search-input" type="text" placeholder="Search name, symbol, or address..." bind:value={search} />
		</div>
	</div>

	<!-- Live Launches -->
	{#if activeLaunches.length > 0 && !search.trim()}
		<div class="launches-section">
			<div class="launches-header">
				<span class="launches-dot"></span>
				<span class="launches-label">Live Launches</span>
			</div>
			<div class="launches-scroll">
				{#each activeLaunches as launch}
					{@const slug = launch.chain_id === 56 ? 'bsc' : 'eth'}
					{@const decimals = launch.usdt_decimals || 18}
					{@const raised = parseFloat(ethers.formatUnits(launch.total_base_raised || '0', decimals))}
					{@const cap = parseFloat(ethers.formatUnits(launch.hard_cap || '1', decimals))}
					{@const sc = parseFloat(ethers.formatUnits(launch.soft_cap || '0', decimals))}
					{@const raisedBig = BigInt(launch.total_base_raised || '0')}
				{@const capBig = BigInt(launch.hard_cap || '1')}
				{@const progress = progressPercent(raisedBig, capBig)}
					{@const scPct = cap > 0 ? Math.min(100, (sc / cap) * 100) : 0}
					<a href="/launchpad/{slug}/{launch.address}" class="launch-card">
						<div class="launch-card-top">
							<TokenLogo logoUrl={launch.logo_url} symbol={launch.token_symbol} address={launch.token_address || launch.address} size={28} />
							<div class="launch-identity">
								<span class="launch-name">{launch.token_name || 'Unknown'}</span>
								<span class="launch-symbol">{launch.token_symbol || '???'}</span>
							</div>
							{#if launch.is_partner}
								<span class="tc-badge tc-badge-partner" style="font-size:7px">Partner</span>
							{/if}
						</div>
						{#if launch.deadline}
							<LaunchCountdown deadline={Number(launch.deadline)} size="sm" />
						{/if}
						<LaunchProgressBar
							{progress}
							softCapPct={scPct}
							raised="${raised.toFixed(2)}"
							hardCap="${cap.toFixed(2)}"
							size="sm"
						/>
						<span class="launch-buy-cta">Buy Now</span>
					</a>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Filters -->
	<div class="explore-controls">
		<div class="filter-pills">
			{#each [['all','All'],['basic','Basic'],['taxable','Taxable'],['mintable','Mintable'],['partner','Partner']] as [key, label]}
				<button
					class="filter-pill"
					class:filter-pill-active={filterType === key}
					onclick={() => filterType = key as typeof filterType}
				>
					{label}
					<span class="filter-count">{typeCounts[key as keyof typeof typeCounts]}</span>
				</button>
			{/each}
		</div>
		<div class="explore-right-controls">
			<button
				class="filter-pill"
				class:filter-pill-tradeable={tradeableOnly}
				onclick={() => tradeableOnly = !tradeableOnly}
			>
				<span class="tradeable-dot" class:tradeable-dot-on={tradeableOnly}></span>
				Tradeable
			</button>
			<select class="sort-select" bind:value={sortBy}>
				<option value="safu" title="Tokens with burned LP, locked taxes, and renounced ownership appear first.">SAFU first</option>
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
			{#each filtered as tok}
				{@const color = typeColor(tok)}
				{@const slug = chainSlug(tok.chain_id)}
				{@const gecko = geckoLookup[tok.address?.toLowerCase()]}
				{@const safu = safuMap[safuKey(tok)]}
			{@const isSafu = safu?.isSafu ?? tok.is_safu}
			{@const isLpBurned = safu ? safu.lpBurned && safu.lpBurnedPct >= 9900 : tok.lp_burned && (tok.lp_burned_pct ?? 0) >= 9900}
			{@const isRenounced = safu?.ownerIsZero ?? tok.owner_renounced}
			{@const isTaxLocked = safu?.taxCeilingLocked ?? tok.tax_ceiling_locked}
			{@const sellTax = safu?.sellTaxBps ?? tok.sell_tax_bps ?? 0}
			{@const isMintableRisk = (safu ? safu.isMintable && !safu.ownerIsZero : tok.is_mintable && !tok.owner_renounced)}
			{@const buyTax = safu?.buyTaxBps ?? tok.buy_tax_bps ?? 0}
				<div class="token-card" data-token-addr={tok.address} data-chain-id={tok.chain_id}>
					<!-- Header: clickable to detail page -->
					<a href="/explore/{slug}/{tok.address}" class="tc-header">
						<TokenLogo logoUrl={tok.logo_url} symbol={tok.symbol} address={tok.address} chainId={tok.chain_id} size={36} />
						<div class="tc-identity">
							<span class="tc-name">{tok.name || 'Unknown'}</span>
							<div class="tc-meta-row">
								<span class="tc-symbol">{tok.symbol || '???'}</span>
								<span class="tc-chain">{chainName(tok.chain_id)}</span>
								{#if gecko?.has_data}
									<span class="tc-live-dot"></span>
								{/if}
							</div>
						</div>
						<div class="tc-header-right">
							<div class="tc-badges-row">
								{#if isSafu}
									<span class="badge-tip">
										<span class="tc-badge tc-badge-safu">SAFU</span>
										<div class="badge-tip-content">
											<div class="btp-title">SAFU Token</div>
											<div class="btp-row"><span class="btp-check">✓</span><span>LP ≥99% burned</span></div>
											<div class="btp-row"><span class="btp-check">✓</span><span>Tax ceiling locked</span></div>
											<div class="btp-row"><span class="btp-check">✓</span><span>Trading enabled + liquidity</span></div>
											<div class="btp-row"><span class="btp-check">✓</span><span>Not mintable / owner renounced</span></div>
										</div>
									</span>
								{/if}
								{#if tok.is_kyc}
									<span class="badge-tip">
										<span class="tc-badge tc-badge-kyc">KYC</span>
										<div class="badge-tip-content">
											<div class="btp-title">KYC Verified</div>
											<div class="btp-row"><span>Creator identity confirmed via AMA or KYC</span></div>
										</div>
									</span>
								{/if}
								{#if tok.is_taxable}
									<span class="badge-tip">
										<span class="tc-badge tc-badge-tax">Taxable</span>
										<div class="badge-tip-content">
											<div class="btp-title">Token Tax</div>
											<div class="btp-kv"><span>Buy</span><span>{(buyTax / 100).toFixed(1)}%</span></div>
											<div class="btp-kv"><span>Sell</span><span>{(sellTax / 100).toFixed(1)}%</span></div>
											{#if isTaxLocked}<div class="btp-row"><span class="btp-check">✓</span><span>Tax ceiling locked</span></div>{/if}
										</div>
									</span>
								{/if}
								{#if isMintableRisk}
									<span class="badge-tip">
										<span class="tc-badge tc-badge-mintable">Mintable</span>
										<div class="badge-tip-content">
											<div class="btp-title">Mintable Token</div>
											<div class="btp-row"><span class="btp-warn">⚠</span><span>Owner can increase supply</span></div>
											<div class="btp-row"><span class="btp-warn">⚠</span><span>Ownership not renounced</span></div>
										</div>
									</span>
								{/if}
								{#if isOnLaunchpad(tok)}
									<span class="tc-badge tc-badge-live-launch">Live Launch</span>
								{:else if !gecko?.has_data && !isOnLaunchpad(tok)}
									<span class="tc-badge tc-badge-prelaunch">Pre-launch</span>
								{/if}
								{#if tok.created_at && isNew(tok.created_at)}
									<span class="tc-badge tc-badge-new">New</span>
								{/if}
							</div>
							{#if gecko?.has_data}
								<span class="tc-price">{fmtPrice(gecko.price_usd)}</span>
								{#if gecko.price_change_24h !== 0}
									<span class="tc-change" class:tc-change-up={gecko.price_change_24h > 0} class:tc-change-down={gecko.price_change_24h < 0}>
										{gecko.price_change_24h > 0 ? '+' : ''}{gecko.price_change_24h.toFixed(1)}%
									</span>
								{/if}
							{/if}
						</div>
					</a>

					<!-- Description -->
					{#if tok.description}
						<p class="tc-desc">{tok.description.slice(0, 90)}{tok.description.length > 90 ? '...' : ''}</p>
					{/if}

					<!-- Stats -->
					<div class="tc-stats">
						<div class="tc-stat">
							<span class="tc-stat-label">Supply</span>
							<span class="tc-stat-value">{fmtSupply(tok.total_supply, tok.decimals || 18)}</span>
						</div>
						{#if gecko?.has_data}
							{#if gecko.volume_24h > 0}
								<div class="tc-stat">
									<span class="tc-stat-label">Volume 24h</span>
									<span class="tc-stat-value">{fmtVolume(gecko.volume_24h)}</span>
								</div>
							{:else}
								<div class="tc-stat">
									<span class="tc-stat-label">Status</span>
									<span class="tc-stat-value tc-listed">Listed</span>
								</div>
							{/if}
						{:else}
							<div class="tc-stat">
								<span class="tc-stat-label">Status</span>
								<span class="tc-stat-value tc-not-listed">Not Listed</span>
							</div>
						{/if}
						<div class="tc-stat">
							<span class="tc-stat-label">Created</span>
							<span class="tc-stat-value">{tok.created_at ? timeAgo(tok.created_at) : '—'}</span>
						</div>
					</div>

					<!-- Actions -->
					<div class="tc-actions">
						{#if gecko?.has_data}
							<a href="/trade?token={tok.address}" class="tc-action tc-action-trade">
								<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
								Trade
							</a>
						{/if}
						<a href="/explore/{slug}/{tok.address}" class="tc-action tc-action-view" class:tc-action-full={!gecko?.has_data}>
							View
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
						</a>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.explore { max-width: 1100px; margin: 0 auto; padding: 24px 16px 60px; }

	/* Header */
	.explore-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
	.explore-title { font-family: 'Syne', sans-serif; font-size: 28px; font-weight: 800; color: var(--text-heading); margin: 0; }
	.explore-sub { font-size: 12px; color: #475569; font-family: 'Space Mono', monospace; margin: 4px 0 0; }

	.explore-search {
		display: flex; align-items: center; gap: 8px;
		padding: 8px 14px; border-radius: 10px;
		background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);
		min-width: 260px; transition: border-color 0.15s;
	}
	.explore-search:focus-within { border-color: rgba(0,210,255,0.3); }
	.search-icon { color: #374151; flex-shrink: 0; }
	.search-input {
		background: transparent; border: none; outline: none; flex: 1;
		color: #e2e8f0; font-family: 'Space Mono', monospace; font-size: 12px;
	}
	.search-input::placeholder { color: #1e293b; }

	/* Controls */
	/* Live Launches */
	.launches-section { margin-bottom: 20px; }
	.launches-header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
	.launches-dot { width: 7px; height: 7px; border-radius: 50%; background: #00d2ff; box-shadow: 0 0 8px rgba(0,210,255,0.6); animation: pulse 2s ease-in-out infinite; }
	@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
	.launches-label { font-family: 'Syne', sans-serif; font-size: 13px; font-weight: 700; color: var(--text-heading); }
	.launches-scroll { display: flex; gap: 10px; overflow-x: auto; padding-bottom: 8px; scrollbar-width: thin; }
	.launch-card {
		display: flex; flex-direction: column; gap: 8px;
		min-width: 220px; max-width: 260px; padding: 12px 14px;
		background: var(--bg-surface); border: 1px solid var(--border-subtle);
		border-radius: 10px; text-decoration: none; color: inherit;
		transition: all 0.15s; flex-shrink: 0;
	}
	.launch-card:hover { border-color: rgba(0,210,255,0.2); transform: translateY(-2px); box-shadow: 0 6px 20px rgba(0,0,0,0.15); }
	.launch-card-top { display: flex; align-items: center; gap: 8px; }
	.launch-logo { width: 28px; height: 28px; border-radius: 8px; object-fit: cover; flex-shrink: 0; border: 1px solid var(--border); }
	.launch-logo-fallback { width: 28px; height: 28px; border-radius: 8px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; background: rgba(0,210,255,0.1); color: #00d2ff; border: 1px solid rgba(0,210,255,0.2); font-size: 10px; font-weight: 800; }
	.launch-identity { flex: 1; min-width: 0; }
	.launch-name { display: block; font-family: 'Syne', sans-serif; font-size: 13px; font-weight: 700; color: var(--text-heading); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.launch-symbol { font-family: 'Space Mono', monospace; font-size: 9px; color: var(--text-dim); }
	.launch-progress-wrap { display: flex; flex-direction: column; gap: 4px; }
	.launch-progress-bar { height: 8px; border-radius: 4px; background: var(--border-subtle); overflow: hidden; border: 1px solid var(--border-subtle, rgba(255,255,255,0.06)); }
	.launch-progress-fill { height: 100%; border-radius: 4px; background: linear-gradient(90deg, #00d2ff, #10b981); min-width: 3px; }
	.launch-progress-label { display: flex; justify-content: space-between; font-family: 'Space Mono', monospace; font-size: 9px; color: var(--text-dim); }
	.launch-buy-cta {
		display: block; width: 100%; text-align: center;
		font-family: 'Syne', sans-serif; font-size: 11px; font-weight: 700; color: #00d2ff;
		padding: 6px 10px; border-radius: 8px;
		background: rgba(0,210,255,0.08); border: 1px solid rgba(0,210,255,0.15);
		transition: all 0.15s;
	}
	.launch-card:hover .launch-buy-cta { background: rgba(0,210,255,0.18); border-color: rgba(0,210,255,0.3); }

	.explore-controls { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
	.filter-pills { display: flex; gap: 6px; flex-wrap: wrap; }
	.filter-pill {
		display: inline-flex; align-items: center; gap: 5px;
		padding: 5px 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.06);
		background: rgba(255,255,255,0.02); color: #64748b;
		font-family: 'Space Mono', monospace; font-size: 11px;
		cursor: pointer; transition: all 0.15s;
	}
	.filter-pill:hover { border-color: rgba(255,255,255,0.12); color: #94a3b8; }
	.filter-pill-active { border-color: rgba(0,210,255,0.3); background: rgba(0,210,255,0.06); color: #00d2ff; }
	.filter-count { font-size: 9px; opacity: 0.6; }

	.explore-right-controls { display: flex; align-items: center; gap: 8px; }
	.filter-pill-tradeable { border-color: rgba(16,185,129,0.3); background: rgba(16,185,129,0.08); color: #10b981; }
	.tradeable-dot { width: 6px; height: 6px; border-radius: 50%; background: #374151; transition: all 0.15s; }
	.tradeable-dot-on { background: #10b981; box-shadow: 0 0 6px rgba(16,185,129,0.5); }

	.sort-select {
		padding: 6px 10px; border-radius: 8px;
		background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);
		color: #94a3b8; font-family: 'Space Mono', monospace; font-size: 11px;
		cursor: pointer; outline: none;
	}
	.sort-select option { background: #0d0d14; }

	/* Empty */
	.explore-empty {
		display: flex; flex-direction: column; align-items: center; gap: 8px;
		text-align: center; padding: 60px 0; color: #374151;
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
		background: rgba(255,255,255,0.02); border: 1px solid var(--border, rgba(0,0,0,0.08));
		transition: all 0.15s;
	}
	.token-card:hover { border-color: rgba(0,210,255,0.15); box-shadow: 0 4px 20px rgba(0,0,0,0.15); }

	/* Badges row */
	.tc-badges-row { display: flex; gap: 4px; align-items: center; justify-content: flex-end; flex-wrap: wrap; }
	.tc-badge-new { background: rgba(16,185,129,0.15); color: #10b981; }
	.tc-badge-safu { background: rgba(16,185,129,0.2); color: #10b981; font-weight: 800; border: 1px solid rgba(16,185,129,0.3); }
	.tc-badge-live-launch { background: rgba(0,210,255,0.12); color: #00d2ff; border: 1px solid rgba(0,210,255,0.25); font-weight: 700; }
	.tc-badge-prelaunch { background: rgba(245,158,11,0.1); color: #f59e0b; border: 1px solid rgba(245,158,11,0.2); }

	/* Styled badge tooltip popover — matches launchpad hover card */
	.badge-tip { position: relative; display: inline-flex; cursor: pointer; }
	.badge-tip-content {
		display: none; position: absolute; bottom: calc(100% + 10px); left: 50%;
		transform: translateX(-50%); z-index: 50; pointer-events: none;
		background: var(--bg, #1e293b); border: 1px solid var(--border, #334155);
		border-radius: 10px; padding: 12px 16px; min-width: 200px;
		box-shadow: 0 12px 40px rgba(0,0,0,0.5);
		flex-direction: column; gap: 0;
		white-space: normal;
	}
	.badge-tip-content::after {
		content: ''; position: absolute; top: 100%; left: 50%; transform: translateX(-50%);
		border: 6px solid transparent; border-top-color: var(--border, #334155);
	}
	.btp-title {
		font-family: 'Syne', sans-serif; font-size: 12px; font-weight: 700;
		color: var(--text-heading); margin-bottom: 8px; padding-bottom: 6px;
		border-bottom: 1px solid var(--divider);
	}
	.btp-row {
		display: flex; align-items: flex-start; gap: 6px; padding: 3px 0;
		font-family: 'Space Mono', monospace; font-size: 10px; color: var(--text-muted);
		line-height: 1.4;
	}
	.btp-check { color: #10b981; flex-shrink: 0; font-size: 11px; }
	.btp-warn { color: #f59e0b; flex-shrink: 0; font-size: 11px; }
	.btp-kv {
		display: flex; justify-content: space-between; padding: 3px 0;
		font-family: 'Space Mono', monospace; font-size: 10px;
	}
	.btp-kv span:first-child { color: var(--text-dim); }
	.btp-kv span:last-child { color: var(--text); font-weight: 600; }
	.badge-tip:hover .badge-tip-content { display: flex; }
	.tc-badge-lp { background: rgba(59,130,246,0.12); color: #60a5fa; }
	.tc-badge-renounced { background: rgba(16,185,129,0.12); color: #34d399; }
	.tc-badge-locked { background: rgba(139,92,246,0.12); color: #a78bfa; }
	.tc-badge-tax { background: rgba(245,158,11,0.12); color: #f59e0b; }
	.tc-badge-mintable { background: rgba(239,68,68,0.12); color: #f87171; }

	/* Header */
	.tc-header { display: flex; align-items: center; gap: 10px; text-decoration: none; color: inherit; }
	.tc-logo { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; border: 2px solid rgba(255,255,255,0.06); flex-shrink: 0; }
	.tc-logo-fallback {
		width: 40px; height: 40px; border-radius: 50%; flex-shrink: 0;
		display: flex; align-items: center; justify-content: center;
		font-family: 'Syne', sans-serif; font-size: 13px; font-weight: 800;
	}
	.tc-color-cyan { background: rgba(0,210,255,0.12); color: #00d2ff; border: 2px solid rgba(0,210,255,0.2); }
	.tc-color-amber { background: rgba(245,158,11,0.12); color: #f59e0b; border: 2px solid rgba(245,158,11,0.2); }
	.tc-color-purple { background: rgba(139,92,246,0.12); color: #a78bfa; border: 2px solid rgba(139,92,246,0.2); }
	.tc-color-emerald { background: rgba(16,185,129,0.12); color: #10b981; border: 2px solid rgba(16,185,129,0.2); }

	.tc-identity { flex: 1; min-width: 0; }
	.tc-name { display: block; font-family: 'Syne', sans-serif; font-size: 15px; font-weight: 700; color: var(--text-heading); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.tc-meta-row { display: flex; align-items: center; gap: 6px; margin-top: 2px; }
	.tc-symbol { font-family: 'Space Mono', monospace; font-size: 10px; color: #475569; }
	.tc-chain { font-family: 'Space Mono', monospace; font-size: 8px; color: #374151; padding: 1px 5px; border-radius: 4px; background: rgba(255,255,255,0.04); }

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
		font-family: 'Space Mono', monospace; font-size: 10px; color: #475569;
		line-height: 1.5; margin: 0;
	}

	/* Stats */
	.tc-stats { display: flex; gap: 0; border-radius: 8px; overflow: hidden; border: 1px solid rgba(255,255,255,0.04); }
	.tc-stat { flex: 1; padding: 7px 10px; }
	.tc-stat + .tc-stat { border-left: 1px solid rgba(255,255,255,0.04); }
	.tc-stat-label { display: block; font-size: 8px; color: #374151; font-family: 'Space Mono', monospace; text-transform: uppercase; letter-spacing: 0.04em; }
	.tc-stat-value { display: block; font-family: 'Rajdhani', sans-serif; font-size: 14px; font-weight: 600; color: #e2e8f0; font-variant-numeric: tabular-nums; margin-top: 1px; }

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
		background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);
		color: #64748b;
	}
	.tc-action-view:hover { color: #e2e8f0; border-color: rgba(255,255,255,0.12); }
	.tc-action-full { flex: 1; justify-content: center; }
	.tc-not-listed { color: #374151; font-size: 11px; }
	.tc-listed { color: #10b981; font-size: 11px; }

	@media (max-width: 500px) {
		.explore-header { flex-direction: column; }
		.explore-search { min-width: 0; width: 100%; }
		.explore-controls { flex-direction: column; align-items: flex-start; }
		.token-grid { grid-template-columns: 1fr; }
	}
</style>
