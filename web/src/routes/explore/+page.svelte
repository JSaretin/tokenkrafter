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

<div class="max-w-[1100px] mx-auto px-4 pt-6 pb-[60px]">
	<!-- Header -->
	<div class="flex items-start justify-between gap-4 mb-4 flex-wrap max-[500px]:flex-col">
		<div>
			<h1 class="font-display text-[28px] font-extrabold text-(--text-heading) m-0">Explore Tokens</h1>
			<p class="text-xs text-[#475569] font-mono mt-1 mb-0">{tokens.length} tokens on TokenKrafter</p>
		</div>
		<div class="flex items-center gap-2 px-3.5 py-2 rounded-[10px] bg-white/[0.03] border border-white/[0.06] min-w-[260px] max-[500px]:min-w-0 max-[500px]:w-full transition-colors duration-150 focus-within:border-[rgba(0,210,255,0.3)]">
			<svg class="text-[#374151] shrink-0" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
			<input class="bg-transparent border-none outline-none flex-1 text-[#e2e8f0] font-mono text-xs placeholder:text-[#1e293b]" type="text" placeholder="Search name, symbol, or address..." bind:value={search} />
		</div>
	</div>

	<!-- Live Launches -->
	{#if activeLaunches.length > 0 && !search.trim()}
		<div class="mb-5">
			<div class="flex items-center gap-2 mb-2.5">
				<span class="w-[7px] h-[7px] rounded-full bg-[#00d2ff] shadow-[0_0_8px_rgba(0,210,255,0.6)] animate-[pulse_2s_ease-in-out_infinite]"></span>
				<span class="font-display text-[13px] font-bold text-(--text-heading)">Live Launches</span>
			</div>
			<div class="flex gap-2.5 overflow-x-auto pb-2 [scrollbar-width:thin]">
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
					<a href="/launchpad/{slug}/{launch.address}" class="group/launch flex flex-col gap-2 min-w-[220px] max-w-[260px] px-3.5 py-3 bg-(--bg-surface) border border-(--border-subtle) rounded-[10px] no-underline text-inherit transition-all duration-150 shrink-0 hover:border-[rgba(0,210,255,0.2)] hover:-translate-y-0.5 hover:shadow-[0_6px_20px_rgba(0,0,0,0.15)]">
						<div class="flex items-center gap-2">
							<TokenLogo logoUrl={launch.logo_url} symbol={launch.token_symbol} address={launch.token_address || launch.address} size={28} />
							<div class="flex-1 min-w-0">
								<span class="block font-display text-[13px] font-bold text-(--text-heading) whitespace-nowrap overflow-hidden text-ellipsis">{launch.token_name || 'Unknown'}</span>
								<span class="font-mono text-[9px] text-(--text-dim)">{launch.token_symbol || '???'}</span>
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
						<span class="block w-full text-center font-display text-[11px] font-bold text-[#00d2ff] px-2.5 py-1.5 rounded-lg bg-[rgba(0,210,255,0.08)] border border-[rgba(0,210,255,0.15)] transition-all duration-150 group-hover/launch:bg-[rgba(0,210,255,0.18)] group-hover/launch:border-[rgba(0,210,255,0.3)]">Buy Now</span>
					</a>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Filters -->
	<div class="flex items-center justify-between gap-3 mb-5 flex-wrap max-[500px]:flex-col max-[500px]:items-start">
		<div class="flex gap-1.5 flex-wrap">
			{#each [['all','All'],['basic','Basic'],['taxable','Taxable'],['mintable','Mintable'],['partner','Partner']] as [key, label]}
				<button
					class="inline-flex items-center gap-1.5 px-3 py-[5px] rounded-lg border font-mono text-[11px] cursor-pointer transition-all duration-150"
					class:filter-pill-active={filterType === key}
					class:filter-pill-idle={filterType !== key}
					onclick={() => filterType = key as typeof filterType}
				>
					{label}
					<span class="text-[9px] opacity-60">{typeCounts[key as keyof typeof typeCounts]}</span>
				</button>
			{/each}
		</div>
		<div class="flex items-center gap-2">
			<button
				class="inline-flex items-center gap-1.5 px-3 py-[5px] rounded-lg border font-mono text-[11px] cursor-pointer transition-all duration-150"
				class:filter-pill-tradeable={tradeableOnly}
				class:filter-pill-idle={!tradeableOnly}
				onclick={() => tradeableOnly = !tradeableOnly}
			>
				<span class="w-[6px] h-[6px] rounded-full transition-all duration-150" class:tradeable-dot-on={tradeableOnly} class:tradeable-dot-off={!tradeableOnly}></span>
				Tradeable
			</button>
			<select class="sort-select px-2.5 py-1.5 rounded-lg bg-white/[0.03] border border-white/[0.06] text-[#94a3b8] font-mono text-[11px] cursor-pointer outline-none" bind:value={sortBy}>
				<option value="safu" title="Tokens with burned LP, locked taxes, and renounced ownership appear first.">SAFU first</option>
				<option value="newest">Newest</option>
				<option value="name">A → Z</option>
			</select>
		</div>
	</div>

	<!-- Grid -->
	{#if filtered.length === 0}
		<div class="flex flex-col items-center gap-2 text-center py-[60px] text-[#374151] font-mono text-[13px]">
			<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#374151" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
			<span>{search ? `No tokens match "${search}"` : 'No tokens created yet'}</span>
			{#if !search}
				<a href="/create" class="mt-2 px-5 py-[9px] rounded-[10px] bg-gradient-to-br from-[#00d2ff] to-[#3a7bd5] text-white font-display font-bold text-[13px] no-underline transition-all duration-200 hover:-translate-y-px hover:shadow-[0_6px_24px_rgba(0,210,255,0.3)]">Create the first token</a>
			{/if}
		</div>
	{:else}
		<div class="grid gap-3.5 grid-cols-[repeat(auto-fill,minmax(300px,1fr))] max-[500px]:grid-cols-[1fr]">
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
				<div class="flex flex-col gap-2.5 p-4 rounded-xl bg-white/[0.02] border border-(--border) transition-all duration-150 hover:border-[rgba(0,210,255,0.15)] hover:shadow-[0_4px_20px_rgba(0,0,0,0.15)]" data-token-addr={tok.address} data-chain-id={tok.chain_id}>
					<!-- Header: clickable to detail page -->
					<a href="/explore/{slug}/{tok.address}" class="flex items-center gap-2.5 no-underline text-inherit">
						<TokenLogo logoUrl={tok.logo_url} symbol={tok.symbol} address={tok.address} chainId={tok.chain_id} size={36} />
						<div class="flex-1 min-w-0">
							<span class="block font-display text-[15px] font-bold text-(--text-heading) whitespace-nowrap overflow-hidden text-ellipsis">{tok.name || 'Unknown'}</span>
							<div class="flex items-center gap-1.5 mt-0.5">
								<span class="font-mono text-[10px] text-[#475569]">{tok.symbol || '???'}</span>
								<span class="font-mono text-[8px] text-[#374151] py-px px-[5px] rounded bg-white/[0.04]">{chainName(tok.chain_id)}</span>
								{#if gecko?.has_data}
									<span class="w-[5px] h-[5px] rounded-full bg-[#10b981] shrink-0 shadow-[0_0_4px_rgba(16,185,129,0.5)]"></span>
								{/if}
							</div>
						</div>
						<div class="flex flex-col items-end gap-[3px] shrink-0">
							<div class="flex gap-1 items-center justify-end flex-wrap">
								{#if isSafu}
									<span class="badge-tip relative inline-flex cursor-pointer">
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
									<span class="badge-tip relative inline-flex cursor-pointer">
										<span class="tc-badge tc-badge-kyc">KYC</span>
										<div class="badge-tip-content">
											<div class="btp-title">KYC Verified</div>
											<div class="btp-row"><span>Creator identity confirmed via AMA or KYC</span></div>
										</div>
									</span>
								{/if}
								{#if tok.is_taxable && (buyTax > 0 || sellTax > 0)}
									<span class="badge-tip relative inline-flex cursor-pointer">
										{#if isTaxLocked}
											<span class="tc-badge tc-badge-tax-locked">Tax {(buyTax / 100).toFixed(0)}/{(sellTax / 100).toFixed(0)}% Locked</span>
										{:else}
											<span class="tc-badge tc-badge-tax">Tax {(buyTax / 100).toFixed(0)}/{(sellTax / 100).toFixed(0)}%</span>
										{/if}
										<div class="badge-tip-content">
											<div class="btp-title">{isTaxLocked ? 'Tax Rates (Locked)' : 'Token Tax'}</div>
											<div class="btp-kv"><span>Buy</span><span>{(buyTax / 100).toFixed(1)}%</span></div>
											<div class="btp-kv"><span>Sell</span><span>{(sellTax / 100).toFixed(1)}%</span></div>
											{#if isTaxLocked}
												<div class="btp-row"><span class="btp-check">✓</span><span>Rates locked at creation — cannot be increased after graduation</span></div>
											{:else}
												<div class="btp-row"><span class="btp-warn">⚠</span><span>Tax ceiling not locked — creator could increase rates</span></div>
											{/if}
										</div>
									</span>
								{/if}
								{#if isMintableRisk}
									<span class="badge-tip relative inline-flex cursor-pointer">
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
								{:else if !gecko?.has_data && !tok.has_liquidity}
									<span class="tc-badge tc-badge-prelaunch">Pre-launch</span>
								{/if}
								{#if tok.created_at && isNew(tok.created_at)}
									<span class="tc-badge tc-badge-new">New</span>
								{/if}
							</div>
							{#if gecko?.has_data}
								<span class="font-numeric text-[15px] font-bold text-(--text-heading) leading-none">{fmtPrice(gecko.price_usd)}</span>
								{#if gecko.price_change_24h !== 0}
									<span class={"font-numeric text-[11px] font-semibold leading-none " + (gecko.price_change_24h > 0 ? "text-[#10b981]" : gecko.price_change_24h < 0 ? "text-[#f87171]" : "")}>
										{gecko.price_change_24h > 0 ? '+' : ''}{gecko.price_change_24h.toFixed(1)}%
									</span>
								{/if}
							{/if}
						</div>
					</a>

					<!-- Description -->
					{#if tok.description}
						<p class="font-mono text-[10px] text-[#475569] leading-[1.5] m-0">{tok.description.slice(0, 90)}{tok.description.length > 90 ? '...' : ''}</p>
					{/if}

					<!-- Stats -->
					<div class="flex rounded-lg overflow-hidden border border-white/[0.04]">
						<div class="flex-1 py-[7px] px-2.5">
							<span class="block text-[8px] text-[#374151] font-mono uppercase tracking-[0.04em]">Supply</span>
							<span class="block font-numeric text-[14px] font-semibold text-[#e2e8f0] mt-px">{fmtSupply(tok.total_supply, tok.decimals || 18)}</span>
						</div>
						{#if gecko?.has_data}
							{#if gecko.volume_24h > 0}
								<div class="flex-1 py-[7px] px-2.5 border-l border-white/[0.04]">
									<span class="block text-[8px] text-[#374151] font-mono uppercase tracking-[0.04em]">Volume 24h</span>
									<span class="block font-numeric text-[14px] font-semibold text-[#e2e8f0] mt-px">{fmtVolume(gecko.volume_24h)}</span>
								</div>
							{:else}
								<div class="flex-1 py-[7px] px-2.5 border-l border-white/[0.04]">
									<span class="block text-[8px] text-[#374151] font-mono uppercase tracking-[0.04em]">Status</span>
									<span class="block font-numeric text-[11px] font-semibold text-[#10b981] mt-px">Listed</span>
								</div>
							{/if}
						{:else}
							<div class="flex-1 py-[7px] px-2.5 border-l border-white/[0.04]">
								<span class="block text-[8px] text-[#374151] font-mono uppercase tracking-[0.04em]">Status</span>
								<span class="block font-numeric text-[11px] font-semibold text-[#374151] mt-px">Not Listed</span>
							</div>
						{/if}
						<div class="flex-1 py-[7px] px-2.5 border-l border-white/[0.04]">
							<span class="block text-[8px] text-[#374151] font-mono uppercase tracking-[0.04em]">Created</span>
							<span class="block font-numeric text-[14px] font-semibold text-[#e2e8f0] mt-px">{tok.created_at ? timeAgo(tok.created_at) : '—'}</span>
						</div>
					</div>

					<!-- Actions -->
					<div class="flex gap-2 mt-auto">
						{#if gecko?.has_data}
							<a href="/trade?token={tok.address}" class="inline-flex items-center gap-1.5 px-3.5 py-[7px] rounded-lg font-mono text-[11px] no-underline transition-all duration-150 cursor-pointer flex-1 justify-center bg-gradient-to-br from-[rgba(0,210,255,0.12)] to-[rgba(59,130,246,0.12)] border border-[rgba(0,210,255,0.15)] text-[#00d2ff] hover:from-[rgba(0,210,255,0.2)] hover:to-[rgba(59,130,246,0.2)] hover:border-[rgba(0,210,255,0.3)]">
								<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
								Trade
							</a>
						{/if}
						<a href="/explore/{slug}/{tok.address}" class={"inline-flex items-center gap-1.5 px-3 py-[7px] rounded-lg font-mono text-[11px] no-underline transition-all duration-150 cursor-pointer bg-white/[0.03] border border-white/[0.06] text-[#64748b] hover:text-[#e2e8f0] hover:border-white/[0.12] " + (!gecko?.has_data ? "flex-1 justify-center" : "")}>
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
	/* Keyframes — not expressible as utilities */
	@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

	/* Filter pills: class toggles used for conditional state */
	.filter-pill-active { border-color: rgba(0,210,255,0.3); background: rgba(0,210,255,0.06); color: #00d2ff; }
	.filter-pill-idle { border-color: rgba(255,255,255,0.06); background: rgba(255,255,255,0.02); color: #64748b; }
	.filter-pill-idle:hover { border-color: rgba(255,255,255,0.12); color: #94a3b8; }
	.filter-pill-tradeable { border-color: rgba(16,185,129,0.3); background: rgba(16,185,129,0.08); color: #10b981; }
	.tradeable-dot-on { background: #10b981; box-shadow: 0 0 6px rgba(16,185,129,0.5); }
	.tradeable-dot-off { background: #374151; }

	.sort-select option { background: #0d0d14; }

	/* Styled badge + tooltip popover — hover-chain + pseudo-element arrow */
	.tc-badge {
		font-size: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
		padding: 2px 7px; border-radius: 99px; font-family: 'Space Mono', monospace; flex-shrink: 0;
	}
	.tc-badge-new { background: rgba(16,185,129,0.15); color: #10b981; }
	.tc-badge-safu { background: rgba(16,185,129,0.2); color: #10b981; font-weight: 800; border: 1px solid rgba(16,185,129,0.3); }
	.tc-badge-kyc { background: rgba(139,92,246,0.12); color: #a78bfa; border: 1px solid rgba(139,92,246,0.25); font-weight: 700; }
	.tc-badge-live-launch { background: rgba(0,210,255,0.12); color: #00d2ff; border: 1px solid rgba(0,210,255,0.25); font-weight: 700; }
	.tc-badge-prelaunch { background: rgba(245,158,11,0.1); color: #f59e0b; border: 1px solid rgba(245,158,11,0.2); }
	.tc-badge-tax { background: rgba(245,158,11,0.12); color: #f59e0b; }
	.tc-badge-tax-locked { background: rgba(16,185,129,0.12); color: #10b981; }
	.tc-badge-mintable { background: rgba(239,68,68,0.12); color: #f87171; }
	.tc-badge-partner { background: rgba(139,92,246,0.12); color: #a78bfa; }

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
</style>
