<script lang="ts">
	import { ethers } from 'ethers';
	import { onMount } from 'svelte';
	import { queryTradeLens, type TaxInfo } from '$lib/tradeLens';

	let { data }: { data: any } = $props();

	const { tokenAddress, chain: chainInfo, dbData, onChainData } = data;

	// ── GeckoTerminal data (client-side) ──
	let geckoData = $state<any>(null);
	let copied = $state(false);
	let copiedUrl = $state(false);
	let priceLoading = $state(true);
	let taxInfo = $state<TaxInfo | null>(null);
	let taxLoading = $state(false);
	let addedToWallet = $state(false);

	// ── Derived display values ──
	let tokenName = $derived(dbData?.name || onChainData?.name || geckoData?.name || 'Unknown Token');
	let tokenSymbol = $derived(dbData?.symbol || onChainData?.symbol || geckoData?.symbol || '???');
	let tokenDecimals = $derived(dbData?.decimals || onChainData?.decimals || 18);
	let totalSupply = $derived(onChainData?.totalSupply || dbData?.total_supply || '0');
	let logoUrl = $derived(dbData?.logo_url || geckoData?.image_url || '');
	let description = $derived(dbData?.description || geckoData?.description || '');
	let website = $derived(dbData?.website || geckoData?.websites?.[0] || '');
	let twitter = $derived(dbData?.twitter || '');
	let telegram = $derived(dbData?.telegram || '');
	let creator = $derived(dbData?.creator || '');
	let isOnPlatform = $derived(!!dbData);
	let isTaxable = $derived(dbData?.is_taxable || false);
	let tokenType = $derived.by(() => {
		if (!dbData) return '';
		if (dbData.is_partner && dbData.is_taxable) return 'Partner + Taxable';
		if (dbData.is_partner) return 'Partner';
		if (dbData.is_taxable && dbData.is_mintable) return 'Taxable + Mintable';
		if (dbData.is_taxable) return 'Taxable';
		if (dbData.is_mintable) return 'Mintable';
		return 'Basic';
	});
	let createdAt = $derived(dbData?.created_at ? new Date(dbData.created_at).toLocaleDateString() : '');

	let price = $derived(geckoData?.price_usd ? parseFloat(geckoData.price_usd) : 0);
	let priceChange24h = $derived(geckoData?.price_change_24h || 0);
	let marketCap = $derived(geckoData?.market_cap_usd ? parseFloat(geckoData.market_cap_usd) : 0);
	let volume24h = $derived(geckoData?.volume_24h_usd ? parseFloat(geckoData.volume_24h_usd) : 0);

	function fmtPrice(val: number): string {
		if (val === 0) return '$0.00';
		if (val >= 1) return `$${val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
		const s = val.toPrecision(7);
		return `$${parseFloat(s)}`;
	}

	function fmtLarge(val: number): string {
		if (val === 0) return '$0';
		if (val >= 1e9) return `$${(val / 1e9).toFixed(2)}B`;
		if (val >= 1e6) return `$${(val / 1e6).toFixed(2)}M`;
		if (val >= 1e3) return `$${(val / 1e3).toFixed(1)}K`;
		return `$${val.toFixed(2)}`;
	}

	function fmtSupply(val: string, dec: number): string {
		const n = parseFloat(ethers.formatUnits(val, dec));
		if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
		if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
		if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
		if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
		return n.toLocaleString();
	}

	function shortAddr(addr: string): string {
		if (!addr || addr.length < 12) return addr || '';
		return addr.slice(0, 8) + '...' + addr.slice(-6);
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
			// Try MetaMask / external wallet first
			const provider = (window as any).ethereum;
			if (provider?.request) {
				await provider.request({
					method: 'wallet_watchAsset',
					params: { type: 'ERC20', options: { address: tokenAddress, symbol: tokenSymbol.slice(0, 11), decimals: tokenDecimals, image: logoUrl || undefined } },
				});
			}
		} catch {}

		// Always add to in-app imported tokens (works for both embedded + external)
		try {
			const saved = JSON.parse(localStorage.getItem('imported_tokens') || '[]');
			if (!saved.some((t: any) => t.address?.toLowerCase() === tokenAddress.toLowerCase())) {
				saved.push({ address: tokenAddress.toLowerCase(), name: tokenName, symbol: tokenSymbol, decimals: tokenDecimals, logoUrl: logoUrl || '' });
				localStorage.setItem('imported_tokens', JSON.stringify(saved));
				// Sync to server if embedded wallet
				import('./../../lib/embeddedWallet').then(m => m.pushPreferences()).catch(() => {});
			}
		} catch {}

		addedToWallet = true;
		setTimeout(() => addedToWallet = false, 3000);
	}

	// Fetch GeckoTerminal + tax simulation
	onMount(async () => {
		// GeckoTerminal price
		try {
			const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/${chainInfo.gecko}/tokens/${tokenAddress}`);
			if (res.ok) {
				const d = await res.json();
				if (d?.data?.attributes) {
					const a = d.data.attributes;
					geckoData = {
						name: a.name, symbol: a.symbol, image_url: a.image_url, description: a.description,
						price_usd: a.price_usd,
						price_change_24h: parseFloat(a.price_change_percentage?.h24 || '0'),
						market_cap_usd: a.market_cap_usd || a.fdv_usd,
						volume_24h_usd: a.volume_usd?.h24,
						websites: a.websites,
					};
				}
			}
		} catch {}
		priceLoading = false;

		// Tax simulation (if taxable)
		if (isTaxable && chainInfo.rpc) {
			taxLoading = true;
			try {
				const provider = new ethers.JsonRpcProvider(chainInfo.rpc);
				// We need the dex router — use PancakeSwap on BSC
				const dexRouter = chainInfo.id === 56 ? '0x10ED43C718714eb63d5aA57B78B54704E256024E' : '';
				if (dexRouter) {
					const result = await queryTradeLens(provider, dexRouter, [tokenAddress], tokenAddress, ethers.parseEther('0.001'), [], chainInfo.id, []);
					taxInfo = result.taxInfo;
				}
			} catch {}
			taxLoading = false;
		}
	});
</script>

<svelte:head>
	<title>{tokenSymbol} — {tokenName} | TokenKrafter</title>
	<meta name="description" content="{tokenName} ({tokenSymbol}) on {chainInfo.name}. {description?.slice(0, 120) || 'View token details, price, and more.'}" />
	{#if logoUrl}
		<meta property="og:image" content={logoUrl} />
	{/if}
	<meta property="og:title" content="{tokenName} ({tokenSymbol}) | TokenKrafter" />
	<meta property="og:description" content={description?.slice(0, 200) || `${tokenName} on ${chainInfo.name}. View price, supply, and details.`} />
</svelte:head>

<div class="td">
	<!-- Header -->
	<div class="td-header">
		<div class="td-id">
			{#if logoUrl}
				<img src={logoUrl} alt={tokenSymbol} class="td-logo" />
			{:else}
				<div class="td-logo-fallback">{tokenSymbol.slice(0, 2).toUpperCase()}</div>
			{/if}
			<div class="td-name-block">
				<h1 class="td-name">{tokenName}</h1>
				<div class="td-badges">
					<span class="td-symbol">{tokenSymbol}</span>
					<span class="td-chain-badge">{chainInfo.name}</span>
					{#if isOnPlatform}
						<span class="td-tk-badge">TokenKrafter</span>
					{/if}
					{#if tokenType}
						<span class="td-type-badge">{tokenType}</span>
					{/if}
				</div>
			</div>
		</div>

		{#if creator}
			<a href="/creator/{creator}" class="td-creator">
				<span class="td-creator-label">Creator</span>
				<span class="td-creator-addr">{shortAddr(creator)}</span>
			</a>
		{/if}
	</div>

	<!-- Price -->
	<div class="td-price-section">
		<div class="td-price-main">
			{#if price > 0}
				<span class="td-price">{fmtPrice(price)}</span>
				<span class="td-change" class:td-change-up={priceChange24h > 0} class:td-change-down={priceChange24h < 0} class:td-change-neutral={priceChange24h === 0}>
					{priceChange24h > 0 ? '+' : ''}{priceChange24h.toFixed(2)}%
				</span>
			{:else if !priceLoading}
				<span class="td-price td-price-na">Not Listed</span>
			{:else}
				<span class="td-price td-price-loading">Loading...</span>
			{/if}
		</div>

		<!-- Stats row (always show supply, conditionally show market data) -->
		<div class="td-stats">
			{#if price > 0}
				<div class="td-stat">
					<span class="td-stat-label">Market Cap</span>
					<span class="td-stat-value">{fmtLarge(marketCap)}</span>
				</div>
				{#if volume24h > 0}
					<div class="td-stat">
						<span class="td-stat-label">24h Volume</span>
						<span class="td-stat-value">{fmtLarge(volume24h)}</span>
					</div>
				{/if}
			{/if}
			<div class="td-stat">
				<span class="td-stat-label">Total Supply</span>
				<span class="td-stat-value">{fmtSupply(totalSupply, tokenDecimals)}</span>
			</div>
			{#if createdAt}
				<div class="td-stat">
					<span class="td-stat-label">Created</span>
					<span class="td-stat-value">{createdAt}</span>
				</div>
			{/if}
		</div>
	</div>

	<!-- Tax Info (if taxable) -->
	{#if isTaxable}
		<div class="td-tax">
			{#if taxLoading}
				<div class="td-tax-row"><span class="td-tax-label">Tax</span><span class="td-tax-val td-tax-loading">Simulating...</span></div>
			{:else if taxInfo}
				<div class="td-tax-row">
					<span class="td-tax-label">Buy Tax</span>
					<span class="td-tax-val">{(taxInfo.buyTaxBps / 100).toFixed(1)}%</span>
				</div>
				<div class="td-tax-row">
					<span class="td-tax-label">Sell Tax</span>
					<span class="td-tax-val">{(taxInfo.sellTaxBps / 100).toFixed(1)}%</span>
				</div>
				<div class="td-tax-row">
					<span class="td-tax-label">Transfer Tax</span>
					<span class="td-tax-val {taxInfo.transferTaxBps === 0 ? 'td-tax-free' : ''}">{taxInfo.transferTaxBps === 0 ? 'Free' : `${(taxInfo.transferTaxBps / 100).toFixed(1)}%`}</span>
				</div>
				{#if !taxInfo.canBuy}
					<div class="td-tax-warn">Cannot buy: {taxInfo.buyError || 'unknown'}</div>
				{/if}
				{#if !taxInfo.canSell}
					<div class="td-tax-warn">Cannot sell: {taxInfo.sellError || 'honeypot'}</div>
				{/if}
			{:else}
				<div class="td-tax-row"><span class="td-tax-label">Tax</span><span class="td-tax-val">Taxable token</span></div>
			{/if}
		</div>
	{/if}

	<!-- Actions -->
	<div class="td-actions">
		{#if price > 0}
			<a href="/trade?token={tokenAddress}" class="td-act td-act-primary">
				<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
				Trade
			</a>
		{/if}
		<button class="td-act" onclick={addToWallet}>
			<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/></svg>
			{addedToWallet ? 'Added!' : 'Add to Wallet'}
		</button>
		<a href="{chainInfo.explorer}/token/{tokenAddress}" target="_blank" rel="noopener" class="td-act">
			<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
			Explorer
		</a>
		<button class="td-act" onclick={shareUrl}>
			<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
			{copiedUrl ? 'Copied!' : 'Share'}
		</button>
	</div>

	<!-- About -->
	{#if description || website || twitter || telegram}
		<div class="td-section">
			<h2 class="td-section-title">About</h2>
			{#if description}
				<p class="td-desc">{description}</p>
			{/if}
			{#if website || twitter || telegram}
				<div class="td-links">
					{#if website}
						<a href={website.startsWith('http') ? website : `https://${website}`} target="_blank" rel="noopener" class="td-link">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
							Website
						</a>
					{/if}
					{#if twitter}
						<a href={twitter.startsWith('http') ? twitter : `https://x.com/${twitter.replace('@', '')}`} target="_blank" rel="noopener" class="td-link">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
							Twitter
						</a>
					{/if}
					{#if telegram}
						<a href={telegram.startsWith('http') ? telegram : `https://t.me/${telegram.replace('@', '')}`} target="_blank" rel="noopener" class="td-link">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
							Telegram
						</a>
					{/if}
				</div>
			{/if}
		</div>
	{/if}

	<!-- Token Info (compact — no duplicates) -->
	<div class="td-section">
		<h2 class="td-section-title">Token Info</h2>
		<div class="td-info-grid">
			<div class="td-info-item" onclick={copyAddress} role="button" tabindex="0" onkeydown={(e) => { if (e.key === 'Enter') copyAddress(); }}>
				<span class="td-info-label">Contract</span>
				<span class="td-info-value td-info-addr">
					{shortAddr(tokenAddress)}
					<span class="td-copy-hint">{copied ? 'Copied!' : 'Copy'}</span>
				</span>
			</div>
			<div class="td-info-item">
				<span class="td-info-label">Decimals</span>
				<span class="td-info-value">{tokenDecimals}</span>
			</div>
		</div>
	</div>
</div>

<style>
	.td { max-width: 680px; margin: 0 auto; padding: 24px 16px 60px; }

	/* Header */
	.td-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 20px; }
	.td-id { display: flex; align-items: center; gap: 14px; }
	.td-logo { width: 56px; height: 56px; border-radius: 50%; object-fit: cover; border: 2px solid rgba(255,255,255,0.06); flex-shrink: 0; }
	.td-logo-fallback {
		width: 56px; height: 56px; border-radius: 50%; flex-shrink: 0;
		background: linear-gradient(135deg, rgba(0,210,255,0.12), rgba(16,185,129,0.12));
		border: 2px solid rgba(0,210,255,0.15);
		display: flex; align-items: center; justify-content: center;
		font-family: 'Syne', sans-serif; font-size: 18px; font-weight: 800; color: #00d2ff;
	}
	.td-name-block { min-width: 0; }
	.td-name { font-family: 'Syne', sans-serif; font-size: 22px; font-weight: 800; color: #fff; margin: 0; line-height: 1.2; }
	.td-badges { display: flex; align-items: center; gap: 5px; margin-top: 6px; flex-wrap: wrap; }
	.td-symbol { font-family: 'Space Mono', monospace; font-size: 11px; color: #64748b; background: rgba(255,255,255,0.04); padding: 2px 8px; border-radius: 4px; }
	.td-chain-badge { font-size: 9px; padding: 2px 8px; border-radius: 4px; background: rgba(245,158,11,0.1); color: #f59e0b; font-family: 'Space Mono', monospace; }
	.td-tk-badge { font-size: 9px; padding: 2px 8px; border-radius: 4px; background: rgba(0,210,255,0.1); color: #00d2ff; font-family: 'Space Mono', monospace; font-weight: 700; }
	.td-type-badge { font-size: 9px; padding: 2px 8px; border-radius: 4px; background: rgba(139,92,246,0.1); color: #a78bfa; font-family: 'Space Mono', monospace; }
	.td-creator { text-decoration: none; display: flex; flex-direction: column; align-items: flex-end; gap: 1px; flex-shrink: 0; }
	.td-creator-label { font-size: 9px; color: #374151; font-family: 'Space Mono', monospace; }
	.td-creator-addr { font-size: 10px; color: #00d2ff; font-family: 'Space Mono', monospace; }
	.td-creator:hover .td-creator-addr { text-decoration: underline; }

	/* Price */
	.td-price-section { margin-bottom: 16px; }
	.td-price-main { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; }
	.td-price { font-family: 'Rajdhani', sans-serif; font-size: 36px; font-weight: 700; color: #fff; font-variant-numeric: tabular-nums; }
	.td-price-na { font-size: 18px; color: #374151; }
	.td-price-loading { font-size: 18px; color: #1e293b; }
	.td-change {
		font-family: 'Rajdhani', sans-serif; font-size: 16px; font-weight: 600;
		padding: 2px 8px; border-radius: 6px; font-variant-numeric: tabular-nums;
	}
	.td-change-up { color: #10b981; background: rgba(16,185,129,0.1); }
	.td-change-down { color: #f87171; background: rgba(248,113,113,0.1); }
	.td-change-neutral { color: #475569; background: rgba(255,255,255,0.04); }

	.td-stats { display: flex; gap: 0; border: 1px solid rgba(255,255,255,0.04); border-radius: 10px; overflow: hidden; }
	.td-stat { flex: 1; padding: 10px 14px; border-right: 1px solid rgba(255,255,255,0.04); }
	.td-stat:last-child { border-right: none; }
	.td-stat-label { display: block; font-size: 9px; color: #374151; font-family: 'Space Mono', monospace; text-transform: uppercase; letter-spacing: 0.04em; }
	.td-stat-value { display: block; font-family: 'Rajdhani', sans-serif; font-size: 16px; font-weight: 600; color: #e2e8f0; margin-top: 2px; font-variant-numeric: tabular-nums; }

	/* Tax info */
	.td-tax {
		display: flex; gap: 0; border: 1px solid rgba(245,158,11,0.15); border-radius: 10px;
		overflow: hidden; margin-bottom: 16px; background: rgba(245,158,11,0.03);
	}
	.td-tax-row { flex: 1; padding: 10px 14px; border-right: 1px solid rgba(245,158,11,0.1); display: flex; flex-direction: column; gap: 2px; }
	.td-tax-row:last-child { border-right: none; }
	.td-tax-label { font-size: 9px; color: #92400e; font-family: 'Space Mono', monospace; text-transform: uppercase; letter-spacing: 0.04em; }
	.td-tax-val { font-family: 'Rajdhani', sans-serif; font-size: 16px; font-weight: 600; color: #f59e0b; font-variant-numeric: tabular-nums; }
	.td-tax-loading { font-size: 12px; color: #92400e; }
	.td-tax-free { color: #10b981; }
	.td-tax-warn {
		flex: none; width: 100%; padding: 8px 14px; border-top: 1px solid rgba(245,158,11,0.1);
		font-size: 11px; color: #f87171; font-family: 'Space Mono', monospace;
	}

	/* Actions */
	.td-actions { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; }
	.td-act {
		display: flex; align-items: center; gap: 6px; padding: 9px 14px; border-radius: 8px;
		border: 1px solid rgba(255,255,255,0.06); background: rgba(255,255,255,0.03);
		color: #94a3b8; font-family: 'Space Mono', monospace; font-size: 11px;
		cursor: pointer; transition: all 0.12s; text-decoration: none;
	}
	.td-act:hover { background: rgba(255,255,255,0.06); color: #fff; border-color: rgba(255,255,255,0.1); }
	.td-act-primary {
		background: linear-gradient(135deg, #0891b2, #1d4ed8); border: none; color: white;
		font-family: 'Syne', sans-serif; font-weight: 700; font-size: 12px;
	}
	.td-act-primary:hover { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(8,145,178,0.3); }

	/* Sections */
	.td-section { margin-bottom: 20px; }
	.td-section-title {
		font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 700;
		color: #475569; text-transform: uppercase; letter-spacing: 0.04em; margin: 0 0 10px;
	}
	.td-desc { font-size: 13px; color: #94a3b8; line-height: 1.7; margin: 0 0 10px; font-family: 'Space Mono', monospace; }
	.td-links { display: flex; gap: 8px; flex-wrap: wrap; }
	.td-link {
		display: flex; align-items: center; gap: 5px; padding: 6px 12px; border-radius: 6px;
		border: 1px solid rgba(255,255,255,0.06); background: rgba(255,255,255,0.02);
		color: #64748b; font-family: 'Space Mono', monospace; font-size: 10px;
		text-decoration: none; transition: all 0.12s;
	}
	.td-link:hover { color: #00d2ff; border-color: rgba(0,210,255,0.2); background: rgba(0,210,255,0.04); }

	/* Info grid (compact — just contract + decimals) */
	.td-info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.04); border-radius: 10px; overflow: hidden; }
	.td-info-item { padding: 12px 14px; background: var(--bg, #07070d); cursor: default; }
	.td-info-item[role="button"] { cursor: pointer; }
	.td-info-item[role="button"]:hover { background: rgba(255,255,255,0.02); }
	.td-info-label { display: block; font-size: 9px; color: #374151; font-family: 'Space Mono', monospace; text-transform: uppercase; letter-spacing: 0.04em; }
	.td-info-value { display: block; font-size: 12px; color: #e2e8f0; font-family: 'Space Mono', monospace; margin-top: 3px; }
	.td-info-addr { display: flex; align-items: center; gap: 6px; }
	.td-copy-hint { font-size: 9px; color: #00d2ff; }

	@media (max-width: 500px) {
		.td-header { flex-direction: column; }
		.td-name { font-size: 18px; }
		.td-logo, .td-logo-fallback { width: 48px; height: 48px; }
		.td-price { font-size: 28px; }
		.td-stats { flex-direction: column; }
		.td-stat { border-right: none; border-bottom: 1px solid rgba(255,255,255,0.04); }
		.td-stat:last-child { border-bottom: none; }
		.td-tax { flex-direction: column; }
		.td-tax-row { border-right: none; border-bottom: 1px solid rgba(245,158,11,0.1); }
		.td-tax-row:last-child { border-bottom: none; }
		.td-info-grid { grid-template-columns: 1fr; }
	}
</style>
