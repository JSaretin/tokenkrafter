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

<div class="flex flex-col gap-3">
	<!-- Token -->
	<div class="bg-surface border border-line rounded-xl p-3.5">
		<div class="font-display text-13 font-bold text-[#00d2ff] uppercase tracking-[0.05em] mb-2">Token</div>
		{#if useExistingToken && existingTokenAddress}
			<div class="flex justify-between items-center py-1 text-xs font-mono"><span class="text-dim">Address</span><span class="text-foreground font-semibold text-xs2">{fmtAddr(existingTokenAddress)}</span></div>
		{:else}
			<div class="flex justify-between items-center py-1 text-xs font-mono"><span class="text-dim">Name</span><span class="text-foreground font-semibold">{name} ({symbol})</span></div>
			<div class="flex justify-between items-center py-1 text-xs font-mono"><span class="text-dim">Supply</span><span class="text-foreground font-semibold">{Number(totalSupply).toLocaleString()}</span></div>
			<div class="flex justify-between items-center py-1 text-xs font-mono"><span class="text-dim">Decimals</span><span class="text-foreground font-semibold">{decimals}</span></div>
		{/if}
		<div class="flex justify-between items-center py-1 text-xs font-mono"><span class="text-dim">Network</span><span class="text-foreground font-semibold">{network?.name || '—'}</span></div>
		{#if features.length > 0}
			<div class="flex justify-between items-center py-1 text-xs font-mono"><span class="text-dim">Features</span><span class="flex gap-1 flex-wrap">{#each features as f}<span class="text-3xs px-2 py-0.5 rounded bg-[rgba(0,210,255,0.08)] text-[#00d2ff] border border-[rgba(0,210,255,0.15)]">{f}</span>{/each}</span></div>
		{/if}
	</div>

	<!-- Tax -->
	{#if isTaxable || isPartner}
		<div class="bg-surface border border-line rounded-xl p-3.5">
			<div class="font-display text-13 font-bold text-[#00d2ff] uppercase tracking-[0.05em] mb-2">Tax</div>
			<div class="flex justify-between items-center py-1 text-xs font-mono"><span class="text-dim">Buy</span><span class="text-foreground font-semibold">{buyTaxPct || '0'}%</span></div>
			<div class="flex justify-between items-center py-1 text-xs font-mono"><span class="text-dim">Sell</span><span class="text-foreground font-semibold">{sellTaxPct || '0'}%</span></div>
			<div class="flex justify-between items-center py-1 text-xs font-mono"><span class="text-dim">Transfer</span><span class="text-foreground font-semibold">{transferTaxPct || '0'}%</span></div>
			{#each taxWallets.filter(w => w.address) as w}
				<div class="flex justify-between items-center py-1 pl-3 text-xs font-mono"><span class="text-muted text-3xs">{fmtAddr(w.address)}</span><span class="text-foreground font-semibold">{w.sharePct}%</span></div>
			{/each}
			{#if totalTax === 0 && (launchEnabled || listingEnabled)}
				<div class="mt-2 px-2.5 py-2 rounded-lg bg-[rgba(248,113,113,0.08)] border border-[rgba(248,113,113,0.25)] text-[#fca5a5] text-xs2 font-mono leading-[1.5] font-semibold">
					&#9888; You're launching with 0% tax. This is permanent — you will never be able to add tax to this token after trading starts.
				</div>
			{/if}
		</div>
	{/if}

	<!-- Protection -->
	{#if protectionEnabled}
		<div class="bg-surface border border-line rounded-xl p-3.5">
			<div class="font-display text-13 font-bold text-[#00d2ff] uppercase tracking-[0.05em] mb-2">Protection</div>
			<div class="flex justify-between items-center py-1 text-xs font-mono"><span class="text-dim">Max wallet</span><span class="text-foreground font-semibold">{maxWalletPct}% of supply</span></div>
			<div class="flex justify-between items-center py-1 text-xs font-mono"><span class="text-dim">Max transaction</span><span class="text-foreground font-semibold">{maxTransactionPct}% of supply</span></div>
			{#if Number(cooldownSeconds) > 0}
				<div class="flex justify-between items-center py-1 text-xs font-mono"><span class="text-dim">Cooldown</span><span class="text-foreground font-semibold">{cooldownSeconds}s</span></div>
			{/if}
		</div>
	{/if}

	<!-- Launch -->
	{#if launchEnabled}
		<div class="bg-surface border border-line rounded-xl p-3.5">
			<div class="font-display text-13 font-bold text-[#00d2ff] uppercase tracking-[0.05em] mb-2">Bonding Curve Launch</div>
			<div class="flex justify-between items-center py-1 text-xs font-mono"><span class="text-dim">Tokens for launch</span><span class="text-foreground font-semibold">{launchTokensPct}%</span></div>
			<div class="flex justify-between items-center py-1 text-xs font-mono"><span class="text-dim">Curve</span><span class="text-foreground font-semibold">{curveLabels[launchCurveType] || 'Linear'}</span></div>
			<div class="flex justify-between items-center py-1 text-xs font-mono"><span class="text-dim">Soft cap</span><span class="text-foreground font-semibold">${launchSoftCap}</span></div>
			<div class="flex justify-between items-center py-1 text-xs font-mono"><span class="text-dim">Hard cap</span><span class="text-foreground font-semibold">${launchHardCap}</span></div>
			<div class="flex justify-between items-center py-1 text-xs font-mono"><span class="text-dim">Duration</span><span class="text-foreground font-semibold">{launchDurationDays} days</span></div>
			<div class="flex justify-between items-center py-1 text-xs font-mono"><span class="text-dim">Max buy per wallet</span><span class="text-foreground font-semibold">{launchMaxBuyPct}% of hard cap</span></div>
			{#if Number(launchCreatorAllocPct) > 0}
				<div class="flex justify-between items-center py-1 text-xs font-mono"><span class="text-dim">Creator allocation</span><span class="text-foreground font-semibold">{launchCreatorAllocPct}%</span></div>
				<div class="flex justify-between items-center py-1 text-xs font-mono"><span class="text-dim">Vesting</span><span class="text-foreground font-semibold">{launchVestingDays} days</span></div>
			{/if}
			<div class="mt-2 px-2.5 py-2 rounded-lg bg-[rgba(0,210,255,0.05)] border border-[rgba(0,210,255,0.12)] text-[rgba(0,210,255,0.7)] text-3xs font-mono leading-[1.5]">Unsold tokens from the bonding curve and unused LP allocation are burned on graduation.</div>
		</div>
	{/if}

	<!-- Listing -->
	{#if listingEnabled}
		<div class="bg-surface border border-line rounded-xl p-3.5">
			<div class="font-display text-13 font-bold text-[#00d2ff] uppercase tracking-[0.05em] mb-2">DEX Listing</div>
			<div class="flex justify-between items-center py-1 text-xs font-mono"><span class="text-dim">Tokens for pools</span><span class="text-foreground font-semibold">{listingPoolPct}% ({(Number(totalSupply) * listingPoolPct / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })})</span></div>
			{#if autoPrice > 0}
				<div class="flex justify-between items-center py-1 text-xs font-mono"><span class="text-dim">Starting price</span><span class="text-foreground font-semibold">{autoPrice >= 0.01 ? '$' + autoPrice.toFixed(4) : '$' + autoPrice.toFixed(12).replace(/0+$/, '').replace(/\.$/, '')}</span></div>
				<div class="flex justify-between items-center py-1.5 text-xs font-mono"><span class="text-dim">Market cap</span><span class="text-emerald-500 font-semibold text-sm">${(autoPrice * Number(totalSupply)).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span></div>
			{/if}
			{#each listingPairs.filter(p => Number(p.amount) > 0) as pair}
				<div class="flex justify-between items-center py-1 gap-2 text-xs font-mono">
					<span class="w-2 h-2 rounded-full shrink-0" style="background:{pair.base === 'native' ? '#f59e0b' : pair.base === 'usdt' ? '#10b981' : '#3b82f6'}"></span>
					<span class="flex-none whitespace-nowrap text-foreground font-bold">{symbol}/{getLabel(pair.base)}</span>
					<span class="flex-1 text-right text-dim text-3xs">{pair.amount} {getLabel(pair.base)} ↔ {pairTokens(pair)} {symbol}</span>
				</div>
			{/each}
		</div>
	{/if}
</div>
