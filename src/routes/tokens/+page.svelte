<script lang="ts">
	import { ethers } from 'ethers';
	import { t } from '$lib/i18n';

	let { data }: { data: any } = $props();
	let tokens: any[] = data.tokens;
	let search = $state('');

	let filtered = $derived.by(() => {
		if (!search.trim()) return tokens;
		const q = search.toLowerCase();
		return tokens.filter(t =>
			t.name?.toLowerCase().includes(q) ||
			t.symbol?.toLowerCase().includes(q) ||
			t.address?.toLowerCase().includes(q) ||
			t.creator?.toLowerCase().includes(q)
		);
	});

	function fmtSupply(val: string, dec: number): string {
		const n = parseFloat(ethers.formatUnits(val || '0', dec));
		if (n >= 1e12) return `${(n / 1e12).toFixed(1)}T`;
		if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
		if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
		if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
		return n.toLocaleString();
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
</script>

<svelte:head>
	<title>Explore Tokens | TokenKrafter</title>
	<meta name="description" content="Browse tokens created on TokenKrafter. Discover new projects, view token details, and trade." />
</svelte:head>

<div class="explore">
	<div class="explore-header">
		<div>
			<h1 class="explore-title">Explore Tokens</h1>
			<p class="explore-sub">Discover tokens created on TokenKrafter</p>
		</div>
		<div class="explore-search">
			<svg class="search-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
			<input class="search-input" type="text" placeholder="Search name, symbol, or address..." bind:value={search} />
		</div>
	</div>

	{#if filtered.length === 0}
		<div class="explore-empty">
			{search ? 'No tokens match your search' : 'No tokens created yet. Be the first!'}
		</div>
	{:else}
		<div class="token-grid">
			{#each filtered as tok}
				<a href="/token/bsc/{tok.address}" class="token-card">
					<!-- Header -->
					<div class="tc-header">
						{#if tok.logo_url}
							<img src={tok.logo_url} alt={tok.symbol} class="tc-logo" />
						{:else}
							<div class="tc-logo-fallback tc-color-{typeColor(tok)}">{tok.symbol?.charAt(0) || '?'}</div>
						{/if}
						<div class="tc-identity">
							<span class="tc-name">{tok.name || 'Unknown'}</span>
							<span class="tc-symbol">${tok.symbol || '???'}</span>
						</div>
						<span class="tc-badge tc-badge-{typeColor(tok)}">{tokenType(tok)}</span>
					</div>

					<!-- Stats -->
					<div class="tc-stats">
						<div class="tc-stat">
							<span class="tc-stat-label">Supply</span>
							<span class="tc-stat-value">{fmtSupply(tok.total_supply, tok.decimals)}</span>
						</div>
						<div class="tc-stat">
							<span class="tc-stat-label">Created</span>
							<span class="tc-stat-value">{tok.created_at ? timeAgo(tok.created_at) : '—'}</span>
						</div>
					</div>

					<!-- Footer -->
					<div class="tc-footer">
						<span class="tc-creator">{tok.creator?.slice(0, 6)}...{tok.creator?.slice(-4)}</span>
						{#if tok.description}
							<span class="tc-desc">{tok.description.slice(0, 50)}{tok.description.length > 50 ? '...' : ''}</span>
						{/if}
					</div>
				</a>
			{/each}
		</div>
	{/if}
</div>

<style>
	.explore { max-width: 1100px; margin: 0 auto; padding: 24px 16px 60px; }

	.explore-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
	.explore-title { font-family: 'Syne', sans-serif; font-size: 28px; font-weight: 800; color: #fff; margin: 0; }
	.explore-sub { font-size: 13px; color: #475569; font-family: 'Space Mono', monospace; margin: 4px 0 0; }

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

	.explore-loading { display: flex; justify-content: center; padding: 60px 0; }
	.spinner { width: 32px; height: 32px; border: 2px solid rgba(255,255,255,0.06); border-top-color: #00d2ff; border-radius: 50%; animation: spin 0.8s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }
	.explore-empty { text-align: center; padding: 60px 0; color: #1e293b; font-family: 'Space Mono', monospace; font-size: 13px; }

	/* Token Grid */
	.token-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }

	.token-card {
		display: flex; flex-direction: column; gap: 10px;
		padding: 16px; border-radius: 12px;
		background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05);
		text-decoration: none; color: inherit; transition: all 0.15s;
	}
	.token-card:hover { border-color: rgba(0,210,255,0.2); transform: translateY(-2px); box-shadow: 0 4px 20px rgba(0,0,0,0.2); }

	/* Card header */
	.tc-header { display: flex; align-items: center; gap: 10px; }
	.tc-logo { width: 36px; height: 36px; border-radius: 50%; object-fit: cover; border: 1px solid rgba(255,255,255,0.06); flex-shrink: 0; }
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
	.tc-name { display: block; font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 700; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.tc-symbol { display: block; font-family: 'Space Mono', monospace; font-size: 10px; color: #475569; }

	.tc-badge {
		font-size: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
		padding: 2px 7px; border-radius: 99px; font-family: 'Space Mono', monospace; flex-shrink: 0;
	}
	.tc-badge-cyan { background: rgba(0,210,255,0.1); color: #00d2ff; }
	.tc-badge-amber { background: rgba(245,158,11,0.1); color: #f59e0b; }
	.tc-badge-purple { background: rgba(139,92,246,0.1); color: #a78bfa; }
	.tc-badge-emerald { background: rgba(16,185,129,0.1); color: #10b981; }

	/* Card stats */
	.tc-stats { display: flex; gap: 0; border-radius: 8px; overflow: hidden; border: 1px solid rgba(255,255,255,0.04); }
	.tc-stat { flex: 1; padding: 8px 10px; }
	.tc-stat + .tc-stat { border-left: 1px solid rgba(255,255,255,0.04); }
	.tc-stat-label { display: block; font-size: 8px; color: #374151; font-family: 'Space Mono', monospace; text-transform: uppercase; letter-spacing: 0.04em; }
	.tc-stat-value { display: block; font-family: 'Rajdhani', sans-serif; font-size: 14px; font-weight: 600; color: #e2e8f0; font-variant-numeric: tabular-nums; margin-top: 1px; }

	/* Card footer */
	.tc-footer { display: flex; flex-direction: column; gap: 2px; }
	.tc-creator { font-family: 'Space Mono', monospace; font-size: 9px; color: #1e293b; }
	.tc-desc { font-family: 'Space Mono', monospace; font-size: 10px; color: #374151; line-height: 1.4; }

	@media (max-width: 500px) {
		.explore-header { flex-direction: column; }
		.explore-search { min-width: 0; width: 100%; }
		.token-grid { grid-template-columns: 1fr; }
	}
</style>
