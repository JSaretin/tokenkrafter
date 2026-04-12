<script lang="ts">
	import { ethers } from 'ethers';

	let { data }: { data: any } = $props();

	const { tokenAddress, chain: chainInfo, dbData, lensData } = data;

	// TradeLensV2 data from SSR (on-chain: token info + pools + tax)
	const onChainData = lensData?.tokenInfo || null;
	let pools: any[] = $state(lensData?.pools || []);
	const ssrTaxInfo = lensData?.taxInfo || null;
	let copied = $state(false);
	let copiedUrl = $state(false);
	let taxInfo = ssrTaxInfo;
	let addedToWallet = $state(false);

	// ── Derived display values ──
	let tokenName = $derived(dbData?.name || onChainData?.name || 'Unknown Token');
	let tokenSymbol = $derived(dbData?.symbol || onChainData?.symbol || '???');
	let tokenDecimals = $derived(dbData?.decimals || onChainData?.decimals || 18);
	let totalSupply = $derived(onChainData?.totalSupply || '0');
	let logoUrl = $derived(dbData?.logo_url || '');
	let description = $derived(dbData?.description || '');
	let website = $derived(dbData?.website || '');
	let twitter = $derived(dbData?.twitter || '');
	let telegram = $derived(dbData?.telegram || '');
	let creator = $derived(dbData?.creator || '');
	let isOnPlatform = $derived(!!dbData);
	let createdAt = $derived(dbData?.created_at ? new Date(dbData.created_at).toLocaleDateString() : '');
	let hasLiquidity = $derived(onChainData?.hasLiquidity || pools.some((p: any) => p.has_liquidity));
	let activePools = $derived(pools.filter((p: any) => p.has_liquidity));
	let allBurned = $derived(pools.length > 0 && pools.every((p: any) => p.lp_burned && p.lp_burned_pct >= 9900));

	function fmtSupply(val: string | number, dec: number): string {
		const raw = String(val ?? '0');
		const n = /^\d+$/.test(raw)
			? parseFloat(ethers.formatUnits(raw, dec))
			: parseFloat(raw);
		if (!Number.isFinite(n) || n === 0) return '0';
		if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
		if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
		if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
		if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
		return n.toLocaleString();
	}

	function shortAddr(addr: string): string {
		if (!addr || addr.length < 12) return addr || '';
		return addr.slice(0, 6) + '...' + addr.slice(-4);
	}

	function copyAddress() {
		navigator.clipboard.writeText(tokenAddress);
		copied = true;
		setTimeout(() => copied = false, 2000);
	}

	function shareUrl() {
		if (navigator.share) {
			navigator.share({ title: `${tokenName} (${tokenSymbol})`, url: window.location.href });
		} else {
			navigator.clipboard.writeText(window.location.href);
			copiedUrl = true;
			setTimeout(() => copiedUrl = false, 2000);
		}
	}

	async function addToWallet() {
		try {
			const provider = (window as any).ethereum;
			if (provider?.request) {
				await provider.request({
					method: 'wallet_watchAsset',
					params: { type: 'ERC20', options: { address: tokenAddress, symbol: tokenSymbol.slice(0, 11), decimals: tokenDecimals, image: logoUrl || undefined } },
				});
			}
		} catch {}
		try {
			const saved = JSON.parse(localStorage.getItem('imported_tokens') || '[]');
			if (!saved.some((t: any) => t.address?.toLowerCase() === tokenAddress.toLowerCase())) {
				saved.push({ address: tokenAddress.toLowerCase(), name: tokenName, symbol: tokenSymbol, decimals: tokenDecimals, logoUrl: logoUrl || '' });
				localStorage.setItem('imported_tokens', JSON.stringify(saved));
				import('$lib/embeddedWallet').then(m => m.pushPreferences()).catch(() => {});
			}
		} catch {}
		addedToWallet = true;
		setTimeout(() => addedToWallet = false, 3000);
	}
</script>

<svelte:head>
	<title>{tokenSymbol} — {tokenName} | TokenKrafter</title>
	<meta name="description" content="{tokenName} ({tokenSymbol}) on {chainInfo.name}. {description?.slice(0, 120) || 'View token details, price, and more.'}" />
	{#if logoUrl}<meta property="og:image" content={logoUrl} />{/if}
	<meta property="og:title" content="{tokenName} ({tokenSymbol}) | TokenKrafter" />
</svelte:head>

<div class="page">
	<!-- Ambient glow -->
	<div class="glow"></div>

	<!-- Hero -->
	<header class="hero">
		<div class="hero-left">
			{#if logoUrl}
				<img src={logoUrl} alt={tokenSymbol} class="avatar" />
			{:else}
				<div class="avatar avatar-gen">
					<span>{tokenSymbol.slice(0, 2)}</span>
				</div>
			{/if}
			<div>
				<h1 class="token-name">{tokenName}</h1>
				<div class="meta-row">
					<span class="sym">{tokenSymbol}</span>
					<span class="chain-pill">{chainInfo.name}</span>
					{#if isOnPlatform}<span class="tk-pill">TokenKrafter</span>{/if}
				</div>
			</div>
		</div>

		<div class="hero-right">
			{#if hasLiquidity}
				<div class="status-live">
					<span class="pulse"></span>
					Tradeable
				</div>
			{:else}
				<div class="status-off">Not Listed</div>
			{/if}
		</div>
	</header>

	<!-- Feature badges -->
	<div class="badges">
		{#if dbData?.is_taxable}<span class="badge badge-amber">Taxable</span>{/if}
		{#if dbData?.is_mintable}<span class="badge badge-red">Mintable</span>{/if}
		{#if dbData?.is_partner}<span class="badge badge-purple">Partner</span>{/if}
		{#if allBurned}<span class="badge badge-green">LP Burned</span>{/if}
		{#if creator}
			<button class="badge badge-addr" onclick={copyAddress}>
				{copied ? 'Copied!' : shortAddr(tokenAddress)}
				<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
			</button>
		{/if}
	</div>

	<!-- Stats strip -->
	<div class="stats-strip">
		<div class="s-cell">
			<span class="s-label">Supply</span>
			<span class="s-val">{fmtSupply(totalSupply, tokenDecimals)}</span>
		</div>
		<div class="s-divider"></div>
		<div class="s-cell">
			<span class="s-label">Pools</span>
			<span class="s-val">{activePools.length}<span class="s-sub">/{pools.length}</span></span>
		</div>
		<div class="s-divider"></div>
		<div class="s-cell">
			<span class="s-label">Decimals</span>
			<span class="s-val">{tokenDecimals}</span>
		</div>
		{#if createdAt}
			<div class="s-divider"></div>
			<div class="s-cell">
				<span class="s-label">Created</span>
				<span class="s-val">{createdAt}</span>
			</div>
		{/if}
	</div>

	<!-- Tax panel -->
	{#if taxInfo}
		<div class="tax-panel">
			<div class="tax-header">
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
				<span>Tax Simulation</span>
			</div>
			<div class="tax-grid">
				<div class="tax-cell">
					<span class="tax-label">Buy</span>
					<span class="tax-val">{(taxInfo.buyTaxBps / 100).toFixed(1)}%</span>
				</div>
				<div class="tax-cell">
					<span class="tax-label">Sell</span>
					<span class="tax-val">{(taxInfo.sellTaxBps / 100).toFixed(1)}%</span>
				</div>
				<div class="tax-cell">
					<span class="tax-label">Transfer</span>
					<span class="tax-val" class:tax-free={taxInfo.transferTaxBps === 0}>{taxInfo.transferTaxBps === 0 ? 'Free' : `${(taxInfo.transferTaxBps / 100).toFixed(1)}%`}</span>
				</div>
			</div>
			{#if !taxInfo.canBuy}
				<div class="tax-warn">Cannot buy — {taxInfo.buyError || 'reverts'}</div>
			{/if}
			{#if !taxInfo.canSell}
				<div class="tax-warn">Cannot sell — {taxInfo.sellError || 'honeypot'}</div>
			{/if}
		</div>
	{/if}

	<!-- Action bar -->
	<div class="actions">
		{#if hasLiquidity}
			<a href="/trade?token={tokenAddress}" class="act act-trade">
				<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
				Trade {tokenSymbol}
			</a>
		{/if}
		<button class="act" onclick={addToWallet}>
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/></svg>
			{addedToWallet ? 'Added!' : 'Wallet'}
		</button>
		<a href="{chainInfo.explorer}/token/{tokenAddress}" target="_blank" rel="noopener" class="act">
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
			Explorer
		</a>
		<button class="act" onclick={shareUrl}>
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
			{copiedUrl ? 'Copied!' : 'Share'}
		</button>
	</div>

	<!-- Pools -->
	{#if pools.length > 0}
		<section class="section">
			<div class="section-head">
				<h2 class="section-title">
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
					Liquidity
				</h2>
				<span class="section-meta">{activePools.length} active · {pools.length} total</span>
			</div>
			<div class="pool-list">
				{#each pools as pool, i}
					<a href="{chainInfo.explorer}/address/{pool.address}" target="_blank" rel="noopener"
						class="pool" class:pool-active={pool.has_liquidity} class:pool-empty={!pool.has_liquidity}
						style="animation-delay: {i * 60}ms"
					>
						<div class="pool-top">
							<span class="pool-pair">{pool.name}</span>
							<span class="pool-lp" class:lp-burned={pool.lp_burned && pool.lp_burned_pct >= 9900} class:lp-held={pool.has_liquidity && !pool.lp_burned} class:lp-empty={!pool.has_liquidity}>
								{#if pool.lp_burned}
									{pool.lp_burned_pct >= 9900 ? '🔥 Burned' : `${(pool.lp_burned_pct / 100).toFixed(0)}% burned`}
								{:else if pool.has_liquidity}
									Held
								{:else}
									Empty
								{/if}
							</span>
						</div>
						<div class="pool-reserves">
							<div class="pool-r">
								<span class="pool-r-label">{tokenSymbol}</span>
								<span class="pool-r-val">{fmtSupply(pool.reserve_token, tokenDecimals)}</span>
							</div>
							<div class="pool-r-sep">
								<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" opacity="0.3"><path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4"/></svg>
							</div>
							<div class="pool-r">
								<span class="pool-r-label">{pool.base_symbol}</span>
								<span class="pool-r-val">{fmtSupply(pool.reserve_base, 18)}</span>
							</div>
						</div>
					</a>
				{/each}
			</div>
		</section>
	{/if}

	<!-- About -->
	{#if description || website || twitter || telegram}
		<section class="section">
			<h2 class="section-title">About</h2>
			{#if description}
				<p class="about-text">{description}</p>
			{/if}
			{#if website || twitter || telegram}
				<div class="socials">
					{#if website}
						<a href={website.startsWith('http') ? website : `https://${website}`} target="_blank" rel="noopener" class="social-link">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
							Website
						</a>
					{/if}
					{#if twitter}
						<a href={twitter.startsWith('http') ? twitter : `https://x.com/${twitter.replace('@', '')}`} target="_blank" rel="noopener" class="social-link">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
							Twitter
						</a>
					{/if}
					{#if telegram}
						<a href={telegram.startsWith('http') ? telegram : `https://t.me/${telegram.replace('@', '')}`} target="_blank" rel="noopener" class="social-link">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
							Telegram
						</a>
					{/if}
				</div>
			{/if}
		</section>
	{/if}

	<!-- Contract info -->
	<section class="section">
		<h2 class="section-title">Contract</h2>
		<div class="contract-bar" onclick={copyAddress} role="button" tabindex="0" onkeydown={(e) => { if (e.key === 'Enter') copyAddress(); }}>
			<span class="contract-addr">{tokenAddress}</span>
			<span class="contract-copy">{copied ? '✓ Copied' : 'Copy'}</span>
		</div>
		{#if creator}
			<div class="creator-bar">
				<span class="creator-label">Creator</span>
				<a href="{chainInfo.explorer}/address/{creator}" target="_blank" rel="noopener" class="creator-link">{shortAddr(creator)}</a>
			</div>
		{/if}
	</section>
</div>

<style>
	/* ═══ Token Detail — Command Center ═══ */
	.page {
		max-width: 720px; margin: 0 auto; padding: 32px 20px 80px;
		position: relative;
	}

	/* Ambient background glow */
	.glow {
		position: fixed; top: -200px; left: 50%; transform: translateX(-50%);
		width: 600px; height: 400px;
		background: radial-gradient(ellipse, rgba(0,210,255,0.04) 0%, transparent 70%);
		pointer-events: none; z-index: 0;
	}

	/* ── Hero ── */
	.hero {
		display: flex; justify-content: space-between; align-items: flex-start;
		gap: 16px; margin-bottom: 16px; position: relative; z-index: 1;
	}
	.hero-left { display: flex; align-items: center; gap: 16px; min-width: 0; }
	.hero-right { flex-shrink: 0; }

	.avatar {
		width: 64px; height: 64px; border-radius: 16px; object-fit: cover;
		border: 2px solid rgba(255,255,255,0.06); flex-shrink: 0;
		box-shadow: 0 0 24px rgba(0,210,255,0.08);
	}
	.avatar-gen {
		background: linear-gradient(135deg, #0c1220 0%, #0a1628 100%);
		border-color: rgba(0,210,255,0.15);
		display: flex; align-items: center; justify-content: center;
	}
	.avatar-gen span {
		font-family: 'Syne', sans-serif; font-size: 22px; font-weight: 800;
		background: linear-gradient(135deg, #00d2ff, #10b981);
		-webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
	}

	.token-name {
		font-family: 'Syne', sans-serif; font-size: 26px; font-weight: 800;
		color: var(--text-heading); margin: 0; line-height: 1.15;
		letter-spacing: -0.02em;
	}
	.meta-row { display: flex; align-items: center; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
	.sym {
		font-family: 'Space Mono', monospace; font-size: 11px; color: var(--text-dim);
		background: var(--bg-surface); padding: 2px 8px; border-radius: 4px;
		border: 1px solid var(--border-subtle);
	}
	.chain-pill {
		font-size: 9px; padding: 2px 8px; border-radius: 4px;
		background: rgba(245,158,11,0.08); color: #b45309;
		font-family: 'Space Mono', monospace; border: 1px solid rgba(245,158,11,0.1);
	}
	.tk-pill {
		font-size: 9px; padding: 2px 8px; border-radius: 4px;
		background: rgba(0,210,255,0.06); color: #0891b2;
		font-family: 'Space Mono', monospace; font-weight: 700;
		border: 1px solid rgba(0,210,255,0.1);
	}

	.status-live {
		display: flex; align-items: center; gap: 8px;
		font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 700;
		color: #10b981; padding: 8px 16px; border-radius: 10px;
		background: rgba(16,185,129,0.06); border: 1px solid rgba(16,185,129,0.12);
	}
	.pulse {
		width: 8px; height: 8px; border-radius: 50%; background: #10b981;
		box-shadow: 0 0 8px #10b981;
		animation: pulse-glow 2s ease-in-out infinite;
	}
	@keyframes pulse-glow {
		0%, 100% { opacity: 1; transform: scale(1); }
		50% { opacity: 0.5; transform: scale(1.3); }
	}
	.status-off {
		font-family: 'Space Mono', monospace; font-size: 11px;
		color: var(--text-dim); padding: 8px 14px; border-radius: 10px;
		border: 1px solid var(--border-subtle);
	}

	/* ── Badges ── */
	.badges { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 20px; }
	.badge {
		font-family: 'Space Mono', monospace; font-size: 10px; font-weight: 700;
		padding: 4px 10px; border-radius: 6px;
		border: 1px solid transparent; cursor: default;
		text-transform: uppercase; letter-spacing: 0.04em;
	}
	.badge-amber { background: rgba(245,158,11,0.08); color: #d97706; border-color: rgba(245,158,11,0.12); }
	.badge-red { background: rgba(239,68,68,0.08); color: #dc2626; border-color: rgba(239,68,68,0.12); }
	.badge-purple { background: rgba(139,92,246,0.08); color: #7c3aed; border-color: rgba(139,92,246,0.12); }
	.badge-green { background: rgba(16,185,129,0.08); color: #059669; border-color: rgba(16,185,129,0.12); }
	.badge-addr {
		background: rgba(0,210,255,0.04); color: #0e7490; border-color: rgba(0,210,255,0.08);
		cursor: pointer; display: flex; align-items: center; gap: 5px;
		font-size: 10px; font-weight: 400;
	}
	.badge-addr:hover { background: rgba(0,210,255,0.08); color: #00d2ff; }

	/* ── Stats strip ── */
	.stats-strip {
		display: flex; align-items: stretch;
		background: var(--bg-surface);
		border: 1px solid var(--border-subtle);
		border-radius: 12px; overflow: hidden;
		margin-bottom: 16px;
	}
	.s-cell { flex: 1; padding: 14px 18px; }
	.s-divider { width: 1px; background: var(--bg-surface-input); align-self: stretch; }
	.s-label {
		display: block; font-family: 'Space Mono', monospace; font-size: 9px;
		color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 4px;
	}
	.s-val {
		font-family: 'Rajdhani', sans-serif; font-size: 18px; font-weight: 700;
		color: var(--text); font-variant-numeric: tabular-nums;
	}
	.s-sub { font-size: 13px; color: var(--text-dim); font-weight: 500; }

	/* ── Tax panel ── */
	.tax-panel {
		background: rgba(245,158,11,0.02);
		border: 1px solid rgba(245,158,11,0.1);
		border-radius: 12px; overflow: hidden; margin-bottom: 16px;
	}
	.tax-header {
		display: flex; align-items: center; gap: 8px;
		padding: 10px 16px; border-bottom: 1px solid rgba(245,158,11,0.08);
		font-family: 'Syne', sans-serif; font-size: 11px; font-weight: 700;
		color: #92400e; text-transform: uppercase; letter-spacing: 0.04em;
	}
	.tax-grid { display: flex; }
	.tax-cell {
		flex: 1; padding: 12px 16px;
		border-right: 1px solid rgba(245,158,11,0.06);
	}
	.tax-cell:last-child { border-right: none; }
	.tax-label {
		display: block; font-family: 'Space Mono', monospace; font-size: 9px;
		color: #78350f; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 4px;
	}
	.tax-val {
		font-family: 'Rajdhani', sans-serif; font-size: 20px; font-weight: 700;
		color: #f59e0b; font-variant-numeric: tabular-nums;
	}
	.tax-free { color: #10b981; }
	.tax-warn {
		padding: 8px 16px; border-top: 1px solid rgba(239,68,68,0.1);
		font-family: 'Space Mono', monospace; font-size: 10px; color: #f87171;
		background: rgba(239,68,68,0.03);
	}

	/* ── Actions ── */
	.actions { display: flex; gap: 8px; margin-bottom: 28px; flex-wrap: wrap; }
	.act {
		display: inline-flex; align-items: center; gap: 7px;
		padding: 10px 16px; border-radius: 10px;
		border: 1px solid var(--border);
		background: var(--bg-surface);
		color: var(--text-dim); font-family: 'Space Mono', monospace; font-size: 11px;
		cursor: pointer; transition: all 0.15s; text-decoration: none;
	}
	.act:hover { background: var(--bg-surface-hover); color: var(--text); border-color: var(--border-input); }
	.act-trade {
		background: linear-gradient(135deg, rgba(0,210,255,0.12), rgba(16,185,129,0.12));
		border-color: rgba(0,210,255,0.2); color: #00d2ff;
		font-family: 'Syne', sans-serif; font-weight: 700; font-size: 12px;
	}
	.act-trade:hover {
		transform: translateY(-1px);
		box-shadow: 0 4px 20px rgba(0,210,255,0.15);
		background: linear-gradient(135deg, rgba(0,210,255,0.18), rgba(16,185,129,0.18));
	}

	/* ── Sections ── */
	.section { margin-bottom: 28px; }
	.section-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
	.section-title {
		display: flex; align-items: center; gap: 8px;
		font-family: 'Syne', sans-serif; font-size: 13px; font-weight: 700;
		color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; margin: 0;
	}
	.section-meta { font-family: 'Space Mono', monospace; font-size: 10px; color: var(--text-dim); }

	/* ── Pools ── */
	.pool-list { display: flex; flex-direction: column; gap: 6px; }
	.pool {
		display: block; padding: 14px 16px; border-radius: 10px;
		border: 1px solid var(--border-subtle);
		background: rgba(255,255,255,0.012);
		text-decoration: none; color: inherit;
		transition: all 0.2s; animation: pool-in 0.3s ease-out both;
	}
	@keyframes pool-in { from { opacity: 0; transform: translateY(8px); } }
	.pool:hover { border-color: rgba(0,210,255,0.15); background: rgba(0,210,255,0.02); }
	.pool-empty { opacity: 0.5; }
	.pool-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
	.pool-pair { font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 700; color: var(--text); }
	.pool-lp {
		font-family: 'Space Mono', monospace; font-size: 10px; font-weight: 700;
		padding: 3px 8px; border-radius: 5px;
	}
	.lp-burned { color: #10b981; background: rgba(16,185,129,0.08); }
	.lp-held { color: #f59e0b; background: rgba(245,158,11,0.06); }
	.lp-empty { color: var(--text-dim); background: var(--bg-surface); }

	.pool-reserves { display: flex; align-items: center; gap: 0; }
	.pool-r { flex: 1; }
	.pool-r-sep { flex-shrink: 0; padding: 0 12px; }
	.pool-r-label {
		display: block; font-family: 'Space Mono', monospace; font-size: 9px;
		color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 2px;
	}
	.pool-r-val {
		font-family: 'Rajdhani', sans-serif; font-size: 16px; font-weight: 600;
		color: var(--text); font-variant-numeric: tabular-nums;
	}

	/* ── About ── */
	.about-text {
		font-family: 'Space Mono', monospace; font-size: 12px; line-height: 1.8;
		color: var(--text-dim); margin: 0 0 12px;
	}
	.socials { display: flex; gap: 8px; flex-wrap: wrap; }
	.social-link {
		display: inline-flex; align-items: center; gap: 6px;
		padding: 7px 14px; border-radius: 8px;
		border: 1px solid var(--border-subtle);
		background: var(--bg-surface);
		color: var(--text-dim); font-family: 'Space Mono', monospace; font-size: 10px;
		text-decoration: none; transition: all 0.15s;
	}
	.social-link:hover { color: #00d2ff; border-color: rgba(0,210,255,0.15); background: rgba(0,210,255,0.03); }

	/* ── Contract ── */
	.contract-bar {
		display: flex; justify-content: space-between; align-items: center;
		padding: 14px 16px; border-radius: 10px;
		border: 1px solid var(--border-subtle);
		background: var(--bg-surface);
		cursor: pointer; transition: all 0.15s;
	}
	.contract-bar:hover { border-color: rgba(0,210,255,0.15); background: rgba(0,210,255,0.02); }
	.contract-addr {
		font-family: 'Space Mono', monospace; font-size: 11px; color: var(--text-dim);
		overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	}
	.contract-copy {
		font-family: 'Space Mono', monospace; font-size: 10px; color: #00d2ff;
		flex-shrink: 0;
	}
	.creator-bar {
		display: flex; justify-content: space-between; align-items: center;
		padding: 10px 16px; margin-top: 6px;
	}
	.creator-label { font-family: 'Space Mono', monospace; font-size: 9px; color: var(--text-dim); text-transform: uppercase; }
	.creator-link {
		font-family: 'Space Mono', monospace; font-size: 11px; color: #0891b2;
		text-decoration: none;
	}
	.creator-link:hover { color: #00d2ff; text-decoration: underline; }

	/* ── Responsive ── */
	@media (max-width: 540px) {
		.hero { flex-direction: column; gap: 12px; }
		.hero-right { align-self: flex-start; }
		.avatar, .avatar-gen { width: 52px; height: 52px; border-radius: 14px; }
		.token-name { font-size: 22px; }
		.stats-strip { flex-wrap: wrap; }
		.s-cell { min-width: 45%; }
		.s-divider { display: none; }
		.tax-grid { flex-direction: column; }
		.tax-cell { border-right: none; border-bottom: 1px solid rgba(245,158,11,0.06); }
		.tax-cell:last-child { border-bottom: none; }
		.contract-addr { font-size: 9px; }
	}
</style>
