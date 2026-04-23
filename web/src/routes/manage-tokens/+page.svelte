<script lang="ts">
	import { ethers } from 'ethers';
	import { getContext } from 'svelte';
	import { shortAddr } from '$lib/formatters';
	import { page } from '$app/stores';
	import { chainSlug, type SupportedNetworks } from '$lib/structure';
	import { FACTORY_ABI } from '$lib/tokenCrafter';
	import { supabase } from '$lib/supabaseClient';
	import { t } from '$lib/i18n';
	import TokenLogo from '$lib/TokenLogo.svelte';

	let getUserAddress: () => string | null = getContext('userAddress');
	let connectWallet: () => Promise<boolean> = getContext('connectWallet');
	let _getNetworks: () => SupportedNetworks = getContext('supportedNetworks');
	let supportedNetworks = $derived(_getNetworks());
	let getNetworkProviders: () => Map<number, ethers.JsonRpcProvider> = getContext('networkProviders');
	let networkProviders = $derived(getNetworkProviders());
	let userAddress = $derived(getUserAddress());

	type TokenItem = {
		address: string;
		chain_id: number;
		chain_symbol: string;
		network_name: string;
		name: string;
		symbol: string;
		decimals: number;
		total_supply: string;
		creator: string;
		logo_url?: string;
		description?: string;
		is_mintable: boolean;
		is_taxable: boolean;
		is_partner: boolean;
		created_at?: string;
	};

	let tokens: TokenItem[] = $state([]);
	let isLoading = $state(true);
	let search = $state('');

	// Optimistic "just created" placeholder — the daemon may not have indexed
	// the token yet when the user lands here from the deploy success modal.
	// Read ?just_created=0x... (with optional ?chain=56) and render a
	// placeholder card until the real row arrives via the realtime subscription.
	let justCreatedAddress = $derived(($page.url.searchParams.get('just_created') || '').toLowerCase());
	let justCreatedChainId = $derived(parseInt($page.url.searchParams.get('chain') || '0') || 0);
	let justCreatedResolved = $state(false);

	let placeholderToken = $derived.by<TokenItem | null>(() => {
		if (!justCreatedAddress || justCreatedResolved) return null;
		// Hide placeholder once the real row appears in `tokens`
		if (tokens.find(t => t.address === justCreatedAddress && (!justCreatedChainId || t.chain_id === justCreatedChainId))) return null;
		const net = supportedNetworks.find((n: any) => n.chain_id === justCreatedChainId) || supportedNetworks[0];
		return {
			address: justCreatedAddress,
			chain_id: net?.chain_id ?? justCreatedChainId,
			chain_symbol: net ? chainSlug(net.chain_id) : '',
			network_name: net?.name ?? 'Unknown',
			name: 'Indexing...',
			symbol: '···',
			decimals: 18,
			total_supply: '0',
			creator: userAddress || '',
			is_mintable: false,
			is_taxable: false,
			is_partner: false,
		};
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

	// Merge optimistic placeholder (if any) into the displayed list so the user
	// sees their newly-deployed token immediately after redirect from Create.
	let displayTokens = $derived.by(() => {
		return placeholderToken ? [placeholderToken, ...tokens] : tokens;
	});

	let filtered = $derived.by(() => {
		if (!search.trim()) return displayTokens;
		const q = search.toLowerCase();
		return displayTokens.filter(t =>
			t.name?.toLowerCase().includes(q) ||
			t.symbol?.toLowerCase().includes(q) ||
			t.address?.toLowerCase().includes(q)
		);
	});

	function tokenType(t: TokenItem): string {
		if (t.is_partner && t.is_taxable) return 'Partner+Tax';
		if (t.is_partner) return 'Partner';
		if (t.is_taxable && t.is_mintable) return 'Tax+Mint';
		if (t.is_taxable) return 'Taxable';
		if (t.is_mintable) return 'Mintable';
		return 'Basic';
	}

	function typeColor(t: TokenItem): string {
		if (t.is_partner) return 'purple';
		if (t.is_taxable) return 'amber';
		if (t.is_mintable) return 'cyan';
		return 'emerald';
	}

	function timeAgo(dateStr: string): string {
		const diff = Date.now() - new Date(dateStr).getTime();
		const mins = Math.floor(diff / 60000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		const hrs = Math.floor(mins / 60);
		if (hrs < 24) return `${hrs}h ago`;
		const days = Math.floor(hrs / 24);
		if (days < 30) return `${days}d ago`;
		return new Date(dateStr).toLocaleDateString();
	}


	async function loadTokens() {
		if (!userAddress) return;
		isLoading = true;
		tokens = [];

		// Fetch from DB — all tokens created by this user
		try {
			const res = await fetch(`/api/created-tokens?creator=${userAddress}&limit=200`);
			if (res.ok) {
				const rows = await res.json();
				tokens = rows.map((r: any) => ({
					address: r.address,
					chain_id: r.chain_id,
					chain_symbol: chainSlug(r.chain_id),
					network_name: supportedNetworks.find(n => n.chain_id === r.chain_id)?.name || chainSlug(r.chain_id).toUpperCase(),
					name: r.name || 'Unknown',
					symbol: r.symbol || '???',
					decimals: r.decimals || 18,
					total_supply: r.total_supply || '0',
					creator: r.creator || '',
					logo_url: r.logo_url,
					description: r.description,
					is_mintable: r.is_mintable || false,
					is_taxable: r.is_taxable || false,
					is_partner: r.is_partner || false,
					created_at: r.created_at,
				}));
			}
		} catch {}

		// Also check on-chain for tokens not yet in DB
		for (const net of supportedNetworks) {
			if (!net.platform_address || net.platform_address === '0x') continue;
			try {
				const p = networkProviders.get(net.chain_id) ?? new ethers.JsonRpcProvider(net.rpc);
				const platform = new ethers.Contract(net.platform_address, FACTORY_ABI, p);
				const addrs: string[] = await platform.getCreatedTokens(userAddress);
				for (const addr of addrs) {
					const lower = addr.toLowerCase();
					if (!tokens.find(t => t.address === lower && t.chain_id === net.chain_id)) {
						// Token on-chain but not in DB yet — add with minimal info
						tokens = [...tokens, {
							address: lower, chain_id: net.chain_id,
							chain_symbol: net.symbol.toLowerCase(),
							network_name: net.name,
							name: 'Indexing...', symbol: '???', decimals: 18,
							total_supply: '0',
							creator: userAddress!,
							description: 'Confirming on-chain — usually under a minute',
							is_mintable: false, is_taxable: false, is_partner: false,
						}];
					}
				}
			} catch {}
		}

		isLoading = false;
	}

	// Reload whenever the connected address changes (e.g. in-app wallet account switch).
	// Keying off userAddress ensures we re-fetch instead of latching on hasLoaded.
	let loadedForAddress: string | null = null;
	$effect(() => {
		if (userAddress && userAddress !== loadedForAddress) {
			loadedForAddress = userAddress;
			loadTokens();
		} else if (!userAddress) {
			isLoading = false;
		}
	});

	// Realtime subscription: swap the optimistic placeholder for the real
	// row as soon as the daemon writes it into `created_tokens`.
	// Pattern mirrors the platform-realtime channel in src/lib/realtime.svelte.ts.
	let _tokensChannel: any = null;
	$effect(() => {
		if (!userAddress) return;
		const addr = userAddress.toLowerCase();
		try {
			_tokensChannel = supabase
				.channel(`created-tokens-${addr}`)
				.on(
					'postgres_changes',
					{ event: 'INSERT', schema: 'public', table: 'created_tokens', filter: `creator=eq.${addr}` },
					(payload: any) => {
						const r = payload.new;
						const newTok: TokenItem = {
							address: (r.address || '').toLowerCase(),
							chain_id: r.chain_id,
							chain_symbol: chainSlug(r.chain_id),
							network_name: supportedNetworks.find((n: any) => n.chain_id === r.chain_id)?.name || chainSlug(r.chain_id).toUpperCase(),
							name: r.name || 'Unknown',
							symbol: r.symbol || '???',
							decimals: r.decimals || 18,
							total_supply: r.total_supply || '0',
							creator: r.creator || '',
							logo_url: r.logo_url,
							description: r.description,
							is_mintable: r.is_mintable || false,
							is_taxable: r.is_taxable || false,
							is_partner: r.is_partner || false,
							created_at: r.created_at,
						};
						// If the inserted token was our placeholder, mark resolved and prepend;
						// otherwise just prepend if not already present.
						if (justCreatedAddress && newTok.address === justCreatedAddress) {
							justCreatedResolved = true;
						}
						if (!tokens.find(t => t.address === newTok.address && t.chain_id === newTok.chain_id)) {
							tokens = [newTok, ...tokens];
						}
					}
				)
				.on(
					'postgres_changes',
					{ event: 'UPDATE', schema: 'public', table: 'created_tokens', filter: `creator=eq.${addr}` },
					(payload: any) => {
						const r = payload.new;
						const a = (r.address || '').toLowerCase();
						tokens = tokens.map(t => (t.address === a && t.chain_id === r.chain_id)
							? { ...t, name: r.name || t.name, symbol: r.symbol || t.symbol, total_supply: r.total_supply || t.total_supply, logo_url: r.logo_url ?? t.logo_url, description: r.description ?? t.description, is_mintable: r.is_mintable ?? t.is_mintable, is_taxable: r.is_taxable ?? t.is_taxable, is_partner: r.is_partner ?? t.is_partner, created_at: r.created_at ?? t.created_at }
							: t);
					}
				)
				.subscribe();
		} catch {}
		return () => {
			if (_tokensChannel) {
				try { supabase.removeChannel(_tokensChannel); } catch {}
				_tokensChannel = null;
			}
		};
	});

	async function handleConnect() {
		const ok = await connectWallet();
		if (ok) await loadTokens();
	}
</script>

<svelte:head>
	<title>{$t('mt.pageTitle')} | TokenKrafter</title>
	<meta name="description" content={$t('mt.metaDesc')} />
</svelte:head>

<div class="max-w-[1100px] mx-auto px-4 pt-6 pb-[60px]">
	<!-- Header -->
	<div class="flex items-start justify-between gap-4 mb-6 flex-wrap max-[500px]:flex-col">
		<div>
			<h1 class="font-display text-2xl sm:text-3xl font-extrabold text-heading m-0">{$t('mt.pageTitle')}</h1>
			<p class="text-[13px] text-dim font-mono mt-1 mb-0">
				{#if userAddress}
					Tokens created by <span class="text-brand-cyan">{shortAddr(userAddress)}</span>
				{:else}
					Connect your wallet to manage tokens
				{/if}
			</p>
		</div>
		<div class="flex items-center gap-2.5 flex-wrap max-[500px]:w-full">
			{#if tokens.length > 0}
				<div class="flex items-center gap-2 px-3.5 py-2 rounded-[10px] bg-surface border border-line min-w-[180px] transition-[border-color] focus-within:border-cyan-500/30 max-[500px]:flex-1 max-[500px]:min-w-0">
					<svg class="text-dim shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
					<input class="bg-transparent border-none outline-none flex-1 text-foreground font-mono text-xs w-full placeholder:text-dim" type="text" placeholder="Search..." bind:value={search} />
				</div>
			{/if}
			<a href="/create" class="inline-flex items-center gap-1 px-[18px] py-[9px] rounded-[10px] bg-gradient-to-br from-[#00d2ff] to-[#3a7bd5] text-white font-display font-bold text-[13px] no-underline transition duration-200 hover:-translate-y-px hover:shadow-[0_6px_24px_rgba(0,210,255,0.3)]">+ Create Token</a>
		</div>
	</div>

	{#if !userAddress}
		<div class="flex flex-col items-center gap-2 py-[60px] px-5 text-center">
			<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#374151" stroke-width="1.5"><rect x="2" y="6" width="20" height="12" rx="3"/><path d="M22 10h-4a2 2 0 0 0 0 4h4"/></svg>
			<h2 class="font-display text-lg font-bold text-heading m-0">Wallet not connected</h2>
			<p class="font-mono text-xs text-dim m-0">Connect to see tokens you've created</p>
			<button onclick={handleConnect} class="inline-block mt-2 px-6 py-[11px] rounded-[10px] border-none bg-gradient-to-br from-[#00d2ff] to-[#3a7bd5] text-white font-display font-bold text-[13px] cursor-pointer transition duration-200 hover:-translate-y-px hover:shadow-[0_6px_24px_rgba(0,210,255,0.3)]">Connect Wallet</button>
		</div>

	{:else if isLoading}
		<div class="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-[14px] max-[500px]:grid-cols-1">
			{#each [0,1,2] as _}
				<div class="h-40 rounded-xl bg-surface border border-line-subtle animate-[pulse_1.5s_ease-in-out_infinite]"></div>
			{/each}
		</div>

	{:else if filtered.length === 0}
		<div class="flex flex-col items-center gap-2 py-[60px] px-5 text-center">
			{#if search}
				<p class="font-mono text-xs text-dim m-0">No tokens match "{search}"</p>
			{:else}
				<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#374151" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
				<h2 class="font-display text-lg font-bold text-heading m-0">No tokens yet</h2>
				<p class="font-mono text-xs text-dim m-0">Create your first token to get started</p>
				<a href="/create" class="inline-block mt-2 px-6 py-[11px] rounded-[10px] bg-gradient-to-br from-[#00d2ff] to-[#3a7bd5] text-white font-display font-bold text-[13px] no-underline transition duration-200 hover:-translate-y-px hover:shadow-[0_6px_24px_rgba(0,210,255,0.3)]">Create Token</a>
			{/if}
		</div>

	{:else}
		<div class="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-[14px] max-[500px]:grid-cols-1">
			{#each filtered as tok (tok.address + tok.chain_id)}
				{@const tc = typeColor(tok)}
				<a href="/manage-tokens/{tok.chain_symbol}/{tok.address}" class="group flex flex-col gap-2.5 p-4 rounded-xl bg-surface border border-line-subtle no-underline text-inherit transition duration-150 hover:border-cyan-500/20 hover:-translate-y-0.5 hover:shadow-[0_4px_20px_rgba(0,0,0,0.2)]">
					<!-- Header -->
					<div class="flex items-center gap-2.5">
						<TokenLogo logoUrl={tok.logo_url} symbol={tok.symbol} address={tok.address} chainId={tok.chain_id} size={36} />
						<div class="flex-1 min-w-0">
							<span class="block font-display text-sm font-bold text-heading whitespace-nowrap overflow-hidden text-ellipsis">{tok.name}</span>
							<span class="block font-mono text-[10px] text-dim">${tok.symbol}</span>
						</div>
						<span class={'text-[8px] font-bold uppercase tracking-[0.05em] px-[7px] py-0.5 rounded-full font-mono shrink-0 ' +
							(tc === 'cyan' ? 'bg-cyan-500/10 text-cyan-400' :
							 tc === 'amber' ? 'bg-amber-500/10 text-amber-400' :
							 tc === 'purple' ? 'bg-purple-500/10 text-[#a78bfa]' :
							 'bg-emerald-500/10 text-emerald-400')}>{tokenType(tok)}</span>
					</div>

					<!-- Stats -->
					<div class="flex gap-0 rounded-lg overflow-hidden border border-line-subtle">
						<div class="flex-1 px-2.5 py-2">
							<span class="block text-[8px] text-dim font-mono uppercase tracking-[0.04em]">Supply</span>
							<span class="block font-numeric text-sm font-semibold text-foreground tabular-nums mt-px">{fmtSupply(tok.total_supply, tok.decimals)}</span>
						</div>
						<div class="flex-1 px-2.5 py-2 border-l border-line-subtle">
							<span class="block text-[8px] text-dim font-mono uppercase tracking-[0.04em]">Created</span>
							<span class="block font-numeric text-sm font-semibold text-foreground tabular-nums mt-px">{tok.created_at ? timeAgo(tok.created_at) : '—'}</span>
						</div>
						<div class="flex-1 px-2.5 py-2 border-l border-line-subtle">
							<span class="block text-[8px] text-dim font-mono uppercase tracking-[0.04em]">Chain</span>
							<span class="block font-numeric text-sm font-semibold text-foreground tabular-nums mt-px">{tok.network_name}</span>
						</div>
					</div>

					<!-- Description -->
					{#if tok.description}
						<div class="font-mono text-[10px] text-dim leading-[1.4]">{tok.description.slice(0, 80)}{tok.description.length > 80 ? '...' : ''}</div>
					{/if}

					<!-- Manage arrow -->
					<div class="flex items-center justify-end gap-1 font-mono text-[10px] text-dim transition-colors group-hover:text-brand-cyan">
						<span>Manage</span>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
					</div>
				</a>
			{/each}
		</div>

		<div class="flex justify-center mt-4">
			<button onclick={loadTokens} class="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-line bg-surface text-dim font-mono text-[11px] cursor-pointer transition hover:text-brand-cyan hover:border-cyan-500/20 hover:bg-cyan-500/[0.04]">
				<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
				Refresh
			</button>
		</div>
	{/if}
</div>

<style>
	.manage { max-width: 1100px; margin: 0 auto; padding: 24px 16px 60px; }

	.manage-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
	.manage-title { font-family: 'Syne', sans-serif; font-size: 28px; font-weight: 800; color: var(--text-heading); margin: 0; }
	.manage-sub { font-size: 13px; color: var(--text-dim); font-family: 'Space Mono', monospace; margin: 4px 0 0; }
	.manage-addr { color: #00d2ff; }
	.manage-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }

	.manage-search {
		display: flex; align-items: center; gap: 8px;
		padding: 8px 14px; border-radius: 10px;
		background: var(--bg-surface); border: 1px solid var(--border);
		min-width: 180px; transition: border-color 0.15s;
	}
	.manage-search:focus-within { border-color: rgba(0,210,255,0.3); }
	.search-icon { color: var(--text-dim); flex-shrink: 0; }
	.search-input {
		background: transparent; border: none; outline: none; flex: 1;
		color: var(--text); font-family: 'Space Mono', monospace; font-size: 12px; width: 100%;
	}
	.search-input::placeholder { color: var(--text-dim); }

	.manage-create {
		display: inline-flex; align-items: center; gap: 4px;
		padding: 9px 18px; border-radius: 10px;
		background: linear-gradient(135deg, #00d2ff, #3a7bd5);
		color: white; font-family: 'Syne', sans-serif; font-weight: 700; font-size: 13px;
		text-decoration: none; transition: all 0.2s;
	}
	.manage-create:hover { transform: translateY(-1px); box-shadow: 0 6px 24px rgba(0,210,255,0.3); }

	/* Empty states */
	.manage-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 60px 20px; text-align: center; }
	.manage-empty-title { font-family: 'Syne', sans-serif; font-size: 18px; font-weight: 700; color: var(--text-heading); margin: 0; }
	.manage-empty-sub { font-family: 'Space Mono', monospace; font-size: 12px; color: var(--text-dim); margin: 0; }
	.manage-connect {
		display: inline-block; margin-top: 8px;
		padding: 11px 24px; border-radius: 10px; border: none;
		background: linear-gradient(135deg, #00d2ff, #3a7bd5);
		color: white; font-family: 'Syne', sans-serif; font-weight: 700; font-size: 13px;
		cursor: pointer; transition: all 0.2s;
	}
	.manage-connect:hover { transform: translateY(-1px); box-shadow: 0 6px 24px rgba(0,210,255,0.3); }

	/* Token grid — same as explore */
	.token-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }

	.skeleton-card {
		height: 160px; border-radius: 12px;
		background: var(--bg-surface); border: 1px solid var(--border-subtle);
		animation: pulse 1.5s ease-in-out infinite;
	}
	@keyframes pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 0.7; } }

	.token-card {
		display: flex; flex-direction: column; gap: 10px;
		padding: 16px; border-radius: 12px;
		background: var(--bg-surface); border: 1px solid var(--border-subtle);
		text-decoration: none; color: inherit; transition: all 0.15s;
	}
	.token-card:hover { border-color: rgba(0,210,255,0.2); transform: translateY(-2px); box-shadow: 0 4px 20px rgba(0,0,0,0.2); }

	/* Card header */
	.tc-header { display: flex; align-items: center; gap: 10px; }
	.tc-logo { width: 36px; height: 36px; border-radius: 50%; object-fit: cover; border: 1px solid var(--border); flex-shrink: 0; }
	.tc-logo-fallback {
		width: 36px; height: 36px; border-radius: 50%; flex-shrink: 0;
		display: flex; align-items: center; justify-content: center;
		font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 800;
	}
	.tc-color-cyan { background: rgba(0,210,255,0.1); color: #00d2ff; border: 1px solid rgba(0,210,255,0.15); }
	.tc-color-amber { background: rgba(245,158,11,0.1); color: #f59e0b; border: 1px solid rgba(245,158,11,0.15); }
	.tc-color-purple { background: rgba(139,92,246,0.1); color: #a78bfa; border: 1px solid rgba(139,92,246,0.15); }
	.tc-color-emerald { background: rgba(16,185,129,0.1); color: #10b981; border: 1px solid rgba(16,185,129,0.15); }

	.tc-identity { flex: 1; min-width: 0; }
	.tc-name { display: block; font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 700; color: var(--text-heading); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.tc-symbol { display: block; font-family: 'Space Mono', monospace; font-size: 10px; color: var(--text-dim); }

	.tc-badge {
		font-size: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
		padding: 2px 7px; border-radius: 99px; font-family: 'Space Mono', monospace; flex-shrink: 0;
	}
	.tc-badge-cyan { background: rgba(0,210,255,0.1); color: #00d2ff; }
	.tc-badge-amber { background: rgba(245,158,11,0.1); color: #f59e0b; }
	.tc-badge-purple { background: rgba(139,92,246,0.1); color: #a78bfa; }
	.tc-badge-emerald { background: rgba(16,185,129,0.1); color: #10b981; }

	/* Card stats */
	.tc-stats { display: flex; gap: 0; border-radius: 8px; overflow: hidden; border: 1px solid var(--border-subtle); }
	.tc-stat { flex: 1; padding: 8px 10px; }
	.tc-stat + .tc-stat { border-left: 1px solid var(--border-subtle); }
	.tc-stat-label { display: block; font-size: 8px; color: var(--text-dim); font-family: 'Space Mono', monospace; text-transform: uppercase; letter-spacing: 0.04em; }
	.tc-stat-value { display: block; font-family: 'Rajdhani', sans-serif; font-size: 14px; font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums; margin-top: 1px; }

	/* Description */
	.tc-desc { font-family: 'Space Mono', monospace; font-size: 10px; color: var(--text-dim); line-height: 1.4; }

	/* Manage link */
	.tc-manage {
		display: flex; align-items: center; justify-content: flex-end; gap: 4px;
		font-family: 'Space Mono', monospace; font-size: 10px; color: var(--text-dim);
		transition: color 0.15s;
	}
	.token-card:hover .tc-manage { color: #00d2ff; }

	/* Footer */
	.manage-footer { display: flex; justify-content: center; margin-top: 16px; }
	.manage-refresh {
		display: inline-flex; align-items: center; gap: 6px;
		padding: 8px 16px; border-radius: 8px; border: 1px solid var(--border);
		background: var(--bg-surface); color: var(--text-dim);
		font-family: 'Space Mono', monospace; font-size: 11px;
		cursor: pointer; transition: all 0.15s;
	}
	.manage-refresh:hover { color: #00d2ff; border-color: rgba(0,210,255,0.2); background: rgba(0,210,255,0.04); }

	@media (max-width: 500px) {
		.manage-header { flex-direction: column; }
		.manage-actions { width: 100%; }
		.manage-search { flex: 1; min-width: 0; }
		.token-grid { grid-template-columns: 1fr; }
	}
</style>
