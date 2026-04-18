<script lang="ts">
	let {
		name,
		symbol,
		totalSupply,
		decimals,
		isMintable,
		isTaxable,
		isPartner,
		networkName,
		launchEnabled,
		launchTokensPct,
		launchCurveType,
		launchSoftCap,
		launchHardCap,
		protectionEnabled,
		maxWalletPct,
		maxTransactionPct,
		buyTaxPct,
		sellTaxPct,
		transferTaxPct,
		wizardStep,
		logoUrl = '',
		description = '',
		website = '',
		twitter = '',
		telegram = '',
	}: {
		name: string;
		symbol: string;
		totalSupply: string;
		decimals: number;
		isMintable: boolean;
		isTaxable: boolean;
		isPartner: boolean;
		networkName: string;
		launchEnabled: boolean;
		launchTokensPct: number;
		launchCurveType: number;
		launchSoftCap: string;
		launchHardCap: string;
		protectionEnabled: boolean;
		maxWalletPct: string;
		maxTransactionPct: string;
		buyTaxPct: string;
		sellTaxPct: string;
		transferTaxPct: string;
		wizardStep: string;
		logoUrl?: string;
		description?: string;
		website?: string;
		twitter?: string;
		telegram?: string;
	} = $props();

	let hasMetadata = $derived(description || website || twitter || telegram);

	const CURVE_LABELS = ['Linear', 'Sqrt', 'Quadratic', 'Exponential'];

	let hasBasics = $derived(name.trim() || symbol.trim());
	let hasFeatures = $derived(isMintable || isTaxable || isPartner || launchEnabled);
	let hasTax = $derived(isTaxable && (parseFloat(buyTaxPct) > 0 || parseFloat(sellTaxPct) > 0 || parseFloat(transferTaxPct) > 0));
	let hasProtection = $derived(launchEnabled && protectionEnabled && (maxWalletPct !== '0' || maxTransactionPct !== '0'));

	let supplyFormatted = $derived(() => {
		const n = Number(totalSupply);
		if (!n || isNaN(n)) return '—';
		if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
		if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
		if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
		return n.toLocaleString();
	});
</script>

<div class="bg-surface border border-line rounded-2xl p-5">
	<!-- Token Identity -->
	<div class="flex items-center gap-3 mb-4 pb-4 border-b border-line-subtle">
		{#if logoUrl}
			<img src={logoUrl} alt={symbol} class="w-11 h-11 rounded-xl object-cover border border-[rgba(0,210,255,0.2)] shrink-0" />
		{:else}
			<div class={'w-11 h-11 rounded-xl border border-[rgba(0,210,255,0.2)] flex items-center justify-center font-display font-bold text-sm text-brand-cyan shrink-0 transition-all ' + (name.trim() ? 'bg-[linear-gradient(135deg,rgba(0,210,255,0.2),rgba(58,123,213,0.2))]' : 'bg-[linear-gradient(135deg,rgba(0,210,255,0.15),rgba(58,123,213,0.15))]')}>
				{symbol ? symbol.slice(0, 3).toUpperCase() : '?'}
			</div>
		{/if}
		<div class="min-w-0">
			<div class="font-display text-base font-bold text-foreground whitespace-nowrap overflow-hidden text-ellipsis">{name || 'Token Name'}</div>
			<div class="text-xs text-muted font-mono">{symbol ? symbol.toUpperCase() : 'SYMBOL'}</div>
		</div>
	</div>

	<!-- Metadata (right below identity) -->
	{#if hasMetadata}
		<div class="mb-[14px]">
			{#if description}
				<p class="text-[11px] text-muted font-mono leading-[1.5] m-0 mb-[6px]">{description.length > 80 ? description.slice(0, 80) + '...' : description}</p>
			{/if}
			{#if website || twitter || telegram}
				<div class="flex gap-[6px] flex-wrap">
					{#if website}<span class="text-[9px] px-[6px] py-[2px] rounded bg-surface border border-line text-dim font-mono">🌐 Website</span>{/if}
					{#if twitter}<span class="text-[9px] px-[6px] py-[2px] rounded bg-surface border border-line text-dim font-mono">𝕏 Twitter</span>{/if}
					{#if telegram}<span class="text-[9px] px-[6px] py-[2px] rounded bg-surface border border-line text-dim font-mono">✈ Telegram</span>{/if}
				</div>
			{/if}
		</div>
	{/if}

	<!-- Quick Stats -->
	<div class="grid grid-cols-2 gap-2 mb-[14px]">
		<div class="py-2 px-[10px] bg-surface rounded-lg border border-line-subtle">
			<span class="block text-[10px] text-dim font-mono uppercase tracking-[0.04em] mb-[2px]">Supply</span>
			<span class="block text-[13px] text-foreground font-mono font-semibold">{supplyFormatted()}</span>
		</div>
		<div class="py-2 px-[10px] bg-surface rounded-lg border border-line-subtle">
			<span class="block text-[10px] text-dim font-mono uppercase tracking-[0.04em] mb-[2px]">Decimals</span>
			<span class="block text-[13px] text-foreground font-mono font-semibold">{decimals}</span>
		</div>
		<div class="py-2 px-[10px] bg-surface rounded-lg border border-line-subtle">
			<span class="block text-[10px] text-dim font-mono uppercase tracking-[0.04em] mb-[2px]">Network</span>
			<span class="block text-[13px] text-brand-cyan font-mono font-semibold">{networkName || '—'}</span>
		</div>
		<div class="py-2 px-[10px] bg-surface rounded-lg border border-line-subtle">
			<span class="block text-[10px] text-dim font-mono uppercase tracking-[0.04em] mb-[2px]">Type</span>
			<span class="block text-[13px] text-foreground font-mono font-semibold">
				{#if isPartner && isTaxable}Partner+Tax
				{:else if isPartner}Partner
				{:else if isTaxable && isMintable}Tax+Mint
				{:else if isTaxable}Taxable
				{:else if isMintable}Mintable
				{:else}Standard{/if}
			</span>
		</div>
	</div>

	<!-- Feature Badges -->
	{#if hasFeatures}
		<div class="flex gap-[6px] flex-wrap mb-[14px]">
			{#if isMintable}<span class="text-[10px] font-semibold uppercase tracking-[0.04em] px-2 py-[2px] rounded-full font-mono bg-[rgba(0,210,255,0.1)] text-brand-cyan border border-[rgba(0,210,255,0.2)]">Mintable</span>{/if}
			{#if isTaxable}<span class="text-[10px] font-semibold uppercase tracking-[0.04em] px-2 py-[2px] rounded-full font-mono bg-[rgba(245,158,11,0.1)] text-[#f59e0b] border border-[rgba(245,158,11,0.2)]">Taxable</span>{/if}
			{#if isPartner}<span class="text-[10px] font-semibold uppercase tracking-[0.04em] px-2 py-[2px] rounded-full font-mono bg-[rgba(139,92,246,0.1)] text-[#a78bfa] border border-[rgba(139,92,246,0.2)]">Partner</span>{/if}
			{#if launchEnabled}<span class="text-[10px] font-semibold uppercase tracking-[0.04em] px-2 py-[2px] rounded-full font-mono bg-[rgba(16,185,129,0.1)] text-[#10b981] border border-[rgba(16,185,129,0.2)]">Launch</span>{/if}
		</div>
	{/if}

	<!-- Tax Summary -->
	{#if hasTax}
		<div class="mb-3 p-[10px] bg-surface rounded-lg border border-line-subtle">
			<div class="text-[10px] font-semibold uppercase tracking-[0.06em] text-muted font-mono mb-[6px]">Tax Rates</div>
			<div class="flex flex-col gap-1">
				{#if parseFloat(buyTaxPct) > 0}
					<div class="flex justify-between text-xs font-mono text-muted"><span>Buy</span><span class="text-foreground font-semibold">{buyTaxPct}%</span></div>
				{/if}
				{#if parseFloat(sellTaxPct) > 0}
					<div class="flex justify-between text-xs font-mono text-muted"><span>Sell</span><span class="text-foreground font-semibold">{sellTaxPct}%</span></div>
				{/if}
				{#if parseFloat(transferTaxPct) > 0}
					<div class="flex justify-between text-xs font-mono text-muted"><span>Transfer</span><span class="text-foreground font-semibold">{transferTaxPct}%</span></div>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Launch Summary -->
	{#if launchEnabled}
		<div class="mb-3 p-[10px] bg-surface rounded-lg border border-line-subtle">
			<div class="text-[10px] font-semibold uppercase tracking-[0.06em] text-muted font-mono mb-[6px]">Launchpad</div>
			<div class="flex flex-col gap-1">
				<div class="flex justify-between text-xs font-mono text-muted"><span>Tokens</span><span class="text-foreground font-semibold">{launchTokensPct}%</span></div>
				<div class="flex justify-between text-xs font-mono text-muted"><span>Curve</span><span class="text-foreground font-semibold">{CURVE_LABELS[launchCurveType]}</span></div>
				<div class="flex justify-between text-xs font-mono text-muted"><span>Cap</span><span class="text-foreground font-semibold">{launchSoftCap}–{launchHardCap} USDT</span></div>
			</div>
		</div>
	{/if}

	<!-- Protection Summary -->
	{#if hasProtection}
		<div class="mb-3 p-[10px] bg-surface rounded-lg border border-line-subtle">
			<div class="text-[10px] font-semibold uppercase tracking-[0.06em] text-[#f59e0b] font-mono mb-[6px]">Protection</div>
			<div class="flex flex-col gap-1">
				{#if maxWalletPct !== '0'}
					<div class="flex justify-between text-xs font-mono text-muted"><span>Max wallet</span><span class="text-[#f59e0b] font-semibold">{maxWalletPct}%</span></div>
				{/if}
				{#if maxTransactionPct !== '0'}
					<div class="flex justify-between text-xs font-mono text-muted"><span>Max tx</span><span class="text-[#f59e0b] font-semibold">{maxTransactionPct}%</span></div>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Partner note -->
	{#if isPartner && !isTaxable}
		<div class="text-[11px] text-[#a78bfa] font-mono py-2 px-[10px] bg-[rgba(139,92,246,0.06)] border border-[rgba(139,92,246,0.12)] rounded-lg mb-3">
			0.5% platform fee on buys/sells (fixed)
		</div>
	{/if}

	<!-- Current step indicator -->
	<div class="text-[11px] text-dim font-mono text-center pt-3 border-t border-line-subtle mt-1">
		{#if wizardStep === 'basics'}Configure your token's identity
		{:else if wizardStep === 'features'}Choose token capabilities
		{:else if wizardStep === 'tax'}Set tax rates and wallets
		{:else if wizardStep === 'launch'}Configure bonding curve launch
		{/if}
	</div>
</div>
