<script lang="ts">
	type ListingPair = { base: 'native' | 'usdt' | 'usdc'; amount: string };

	let {
		name, symbol, totalSupply, decimals, network,
		isMintable, isTaxable, isPartner,
		launchEnabled, listingEnabled,
		buyTaxPct, sellTaxPct, transferTaxPct, taxWallets,
		protectionEnabled, maxWalletPct, maxTransactionPct, cooldownSeconds,
		launchTokensPct, launchCurveType, launchSoftCap, launchHardCap,
		launchDurationDays, launchMaxBuyPct, launchCreatorAllocPct, launchVestingDays,
		listingPoolPct, listingPairs, autoPrice, totalLiquidityUsd,
		nativeCoin, useExistingToken, existingTokenAddress,
	}: {
		name: string; symbol: string; totalSupply: string; decimals: number; network: any;
		isMintable: boolean; isTaxable: boolean; isPartner: boolean;
		launchEnabled: boolean; listingEnabled: boolean;
		buyTaxPct: string; sellTaxPct: string; transferTaxPct: string;
		taxWallets: { address: string; sharePct: string }[];
		protectionEnabled: boolean; maxWalletPct: string; maxTransactionPct: string; cooldownSeconds: string;
		launchTokensPct: number; launchCurveType: number; launchSoftCap: string; launchHardCap: string;
		launchDurationDays: string; launchMaxBuyPct: string; launchCreatorAllocPct: string; launchVestingDays: string;
		listingPoolPct: number; listingPairs: ListingPair[]; autoPrice: number; totalLiquidityUsd: number;
		nativeCoin: string; useExistingToken: boolean; existingTokenAddress: string;
	} = $props();

	const curveLabels = ['Linear', 'Square Root', 'Quadratic', 'Exponential'];
	const features: string[] = [];
	$effect(() => {
		features.length = 0;
		if (isMintable) features.push('Mintable');
		if (isTaxable) features.push('Taxable');
		if (isPartner) features.push('Partner');
		if (protectionEnabled) features.push('Anti-Whale');
	});

	function fmtAddr(addr: string): string {
		if (!addr || addr.length < 12) return addr || '—';
		return addr.slice(0, 8) + '...' + addr.slice(-6);
	}

	function getLabel(base: string): string {
		return base === 'native' ? nativeCoin : base.toUpperCase();
	}

	function pairTokens(pair: ListingPair): string {
		if (autoPrice <= 0 || !pair.amount) return '0';
		const usd = pair.base === 'native' ? Number(pair.amount) * (totalLiquidityUsd / (listingPairs.reduce((s, p) => s + Number(p.amount || 0), 0) || 1)) : Number(pair.amount);
		const supply = Number(totalSupply) * (listingPoolPct / 100);
		if (totalLiquidityUsd <= 0) return '0';
		return (supply * usd / totalLiquidityUsd).toLocaleString(undefined, { maximumFractionDigits: 0 });
	}

	let totalTax = $derived(Number(buyTaxPct || 0) + Number(sellTaxPct || 0) + Number(transferTaxPct || 0));
</script>

<div class="rv">
	<!-- Token -->
	<div class="rv-section">
		<div class="rv-section-title">Token</div>
		{#if useExistingToken}
			<div class="rv-row"><span>Address</span><span class="rv-mono">{fmtAddr(existingTokenAddress)}</span></div>
		{:else}
			<div class="rv-row"><span>Name</span><span>{name} ({symbol})</span></div>
			<div class="rv-row"><span>Supply</span><span>{Number(totalSupply).toLocaleString()}</span></div>
			<div class="rv-row"><span>Decimals</span><span>{decimals}</span></div>
		{/if}
		<div class="rv-row"><span>Network</span><span>{network?.name || '—'}</span></div>
		{#if features.length > 0}
			<div class="rv-row"><span>Features</span><span class="rv-badges">{#each features as f}<span class="rv-badge">{f}</span>{/each}</span></div>
		{/if}
	</div>

	<!-- Tax -->
	{#if (isTaxable || isPartner) && totalTax > 0}
		<div class="rv-section">
			<div class="rv-section-title">Tax</div>
			<div class="rv-row"><span>Buy</span><span>{buyTaxPct || '0'}%</span></div>
			<div class="rv-row"><span>Sell</span><span>{sellTaxPct || '0'}%</span></div>
			{#if Number(transferTaxPct) > 0}
				<div class="rv-row"><span>Transfer</span><span>{transferTaxPct}%</span></div>
			{/if}
			{#each taxWallets.filter(w => w.address) as w}
				<div class="rv-row rv-sub"><span>{fmtAddr(w.address)}</span><span>{w.sharePct}%</span></div>
			{/each}
		</div>
	{/if}

	<!-- Protection -->
	{#if protectionEnabled}
		<div class="rv-section">
			<div class="rv-section-title">Protection</div>
			<div class="rv-row"><span>Max wallet</span><span>{maxWalletPct}% of supply</span></div>
			<div class="rv-row"><span>Max transaction</span><span>{maxTransactionPct}% of supply</span></div>
			{#if Number(cooldownSeconds) > 0}
				<div class="rv-row"><span>Cooldown</span><span>{cooldownSeconds}s</span></div>
			{/if}
		</div>
	{/if}

	<!-- Launch -->
	{#if launchEnabled}
		<div class="rv-section">
			<div class="rv-section-title">Bonding Curve Launch</div>
			<div class="rv-row"><span>Tokens for launch</span><span>{launchTokensPct}%</span></div>
			<div class="rv-row"><span>Curve</span><span>{curveLabels[launchCurveType] || 'Linear'}</span></div>
			<div class="rv-row"><span>Soft cap</span><span>${launchSoftCap}</span></div>
			<div class="rv-row"><span>Hard cap</span><span>${launchHardCap}</span></div>
			<div class="rv-row"><span>Duration</span><span>{launchDurationDays} days</span></div>
			<div class="rv-row"><span>Max buy per wallet</span><span>{launchMaxBuyPct}% of hard cap</span></div>
			{#if Number(launchCreatorAllocPct) > 0}
				<div class="rv-row"><span>Creator allocation</span><span>{launchCreatorAllocPct}%</span></div>
				<div class="rv-row"><span>Vesting</span><span>{launchVestingDays} days</span></div>
			{/if}
		</div>
	{/if}

	<!-- Listing -->
	{#if listingEnabled}
		<div class="rv-section">
			<div class="rv-section-title">DEX Listing</div>
			<div class="rv-row"><span>Tokens for pools</span><span>{listingPoolPct}% ({(Number(totalSupply) * listingPoolPct / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })})</span></div>
			{#if autoPrice > 0}
				<div class="rv-row"><span>Starting price</span><span>{autoPrice >= 0.01 ? '$' + autoPrice.toFixed(4) : '$' + autoPrice.toFixed(12).replace(/0+$/, '').replace(/\.$/, '')}</span></div>
				<div class="rv-row rv-highlight"><span>Market cap</span><span>${(autoPrice * Number(totalSupply)).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span></div>
			{/if}
			{#each listingPairs.filter(p => Number(p.amount) > 0) as pair}
				<div class="rv-row rv-pool">
					<span class="rv-pool-dot" style="background:{pair.base === 'native' ? '#f59e0b' : pair.base === 'usdt' ? '#10b981' : '#3b82f6'}"></span>
					<span>{symbol}/{getLabel(pair.base)}</span>
					<span>{pair.amount} {getLabel(pair.base)} ↔ {pairTokens(pair)} {symbol}</span>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.rv { display: flex; flex-direction: column; gap: 12px; }
	.rv-section { background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; padding: 14px; }
	.rv-section-title { font-family: 'Syne', sans-serif; font-size: 13px; font-weight: 700; color: #00d2ff; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }
	.rv-row { display: flex; justify-content: space-between; align-items: center; padding: 4px 0; font-size: 12px; font-family: 'Space Mono', monospace; }
	.rv-row span:first-child { color: #64748b; }
	.rv-row span:last-child { color: #e2e8f0; font-weight: 600; }
	.rv-sub { padding-left: 12px; }
	.rv-sub span:first-child { color: #94a3b8; font-size: 10px; }
	.rv-mono { font-size: 11px; }
	.rv-highlight span:last-child { color: #10b981; font-size: 14px; }
	.rv-badges { display: flex; gap: 4px; flex-wrap: wrap; }
	.rv-badge { font-size: 10px; padding: 2px 8px; border-radius: 4px; background: rgba(0,210,255,0.08); color: #00d2ff; border: 1px solid rgba(0,210,255,0.15); }
	.rv-pool { gap: 8px; }
	.rv-pool-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
	.rv-pool span:nth-child(2) { flex: 0; white-space: nowrap; color: #e2e8f0; font-weight: 700; }
	.rv-pool span:nth-child(3) { color: #64748b; font-size: 10px; text-align: right; flex: 1; }
</style>
