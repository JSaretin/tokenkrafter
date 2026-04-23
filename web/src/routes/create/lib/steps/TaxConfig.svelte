<script lang="ts">
	let {
		buyTaxPct = $bindable(''),
		sellTaxPct = $bindable(''),
		transferTaxPct = $bindable(''),
		taxWallets = $bindable([{ address: '', sharePct: '100' }]),
		isPartner = false,
	}: {
		buyTaxPct: string;
		sellTaxPct: string;
		transferTaxPct: string;
		taxWallets: { address: string; sharePct: string }[];
		isPartner: boolean;
	} = $props();

	const num = (v: string) => parseFloat(v) || 0;
	let totalTax = $derived(num(buyTaxPct) + num(sellTaxPct) + num(transferTaxPct));
	let totalShares = $derived(taxWallets.reduce((s, w) => s + num(w.sharePct), 0));
	let sharesValid = $derived(totalShares <= 100 && totalShares > 0);
	let sharesBurned = $derived(100 - totalShares);
	let hasValidWallet = $derived(taxWallets.some(w => w.address.trim() && /^0x[a-fA-F0-9]{40}$/.test(w.address.trim())));
	let taxWithoutWallet = $derived(totalTax > 0 && !hasValidWallet);

	// Per-tax limits (from contract). Partner tokens allow up to 9%
	// Contract-enforced hard caps (TaxableToken.sol / PartnerTaxableToken.sol):
	//   Non-partner: MAX_BUY_TAX_BPS=400 (4%), MAX_SELL_TAX_BPS=400 (4%), MAX_TRANSFER_TAX_BPS=200 (2%)
	//   Partner: PARTNER_MAX_BUY_TAX_BPS=350 (3.5%), PARTNER_MAX_SELL_TAX_BPS=350 (3.5%), PARTNER_MAX_TRANSFER_TAX_BPS=200 (2%)
	// The tax ceiling then locks at whatever you SET, which can be <= these caps.
	let MAX_BUY = $derived(isPartner ? 3.5 : 4);
	let MAX_SELL = $derived(isPartner ? 3.5 : 4);
	const MAX_TRANSFER = 2;
	let MAX_TOTAL = $derived(isPartner ? 9 : 10);
	let buyOver = $derived(num(buyTaxPct) > MAX_BUY);
	let sellOver = $derived(num(sellTaxPct) > MAX_SELL);
	let transferOver = $derived(num(transferTaxPct) > MAX_TRANSFER);

	// Presets match contract caps. Partner tokens cap at 3.5% so the
	// highest preset is 3.5; non-partner cap at 4% so highest is 4.
	let presets = $derived(isPartner ? [0, 0.5, 1, 2, 3.5] : [0, 1, 2, 3, 4]);

	function addWallet() {
		if (taxWallets.length < 10) taxWallets = [...taxWallets, { address: '', sharePct: '' }];
	}
	function removeWallet(i: number) {
		taxWallets = taxWallets.filter((_, idx) => idx !== i);
	}
</script>

<div class="flex flex-col gap-4">
	<!-- Tax ceiling info -->
	<div class="py-[10px] px-3 rounded-lg bg-[rgba(248,113,113,0.06)] border border-[rgba(248,113,113,0.22)] text-[#fca5a5] text-[11px] font-mono leading-[1.55]">
		Tax rates are permanently capped at these values once trading starts. You can lower them later but never raise them above what you set here. Setting 0% means tax-free forever.
		<div class="mt-[6px] text-[10px] text-[#fca5a5] opacity-90 [&_strong]:text-[#fecaca] [&_strong]:font-bold">
			Max allowed: <strong>Buy {MAX_BUY}%</strong> · <strong>Sell {MAX_SELL}%</strong> · <strong>Transfer {MAX_TRANSFER}%</strong> ({MAX_TOTAL}% combined){isPartner ? ' — partner tokens' : ''}
		</div>
	</div>

	<!-- Tax Rate Rows -->
	<div class="flex flex-col gap-2">
		<!-- Buy -->
		<div class={'tc-rate flex items-center justify-between gap-3 py-3 px-[14px] max-[500px]:py-[10px] max-[500px]:px-3 rounded-[10px] bg-surface border ' + (buyOver ? 'border-[rgba(248,113,113,0.25)]' : 'border-line-subtle')}>
			<div class="flex items-center gap-2 shrink-0">
				<span class="w-2 h-2 rounded-full shrink-0 bg-brand-cyan"></span>
				<span class="font-display text-[13px] font-semibold text-foreground">Buy Tax</span>
				<span class={'text-[9px] font-mono ml-auto uppercase tracking-[0.04em] ' + (buyOver ? 'text-[#f87171]' : 'text-dim')}>max {MAX_BUY}%</span>
			</div>
			<div class="flex items-center gap-2">
				<div class="tc-presets flex gap-[3px]">
					{#each presets as p}
						<button type="button" class={'py-[3px] px-2 rounded-md border bg-transparent font-mono text-[9px] cursor-pointer transition-all ' + (num(buyTaxPct) === p ? 'text-brand-cyan border-[rgba(0,210,255,0.3)] bg-[rgba(0,210,255,0.06)]' : 'text-dim border-line-subtle hover:text-muted hover:border-line-input')} onclick={() => buyTaxPct = String(p)}>{p}%</button>
					{/each}
				</div>
				<div class={'flex items-center gap-px w-14 py-1 px-2 rounded-md bg-surface-input border ' + (buyOver ? 'border-[rgba(248,113,113,0.4)]' : 'border-line')}>
					<input class={'w-full bg-transparent border-none outline-none font-numeric text-base font-bold text-right p-0 tabular-nums placeholder:text-placeholder ' + (buyOver ? 'text-[#f87171]' : 'text-heading')} type="text" inputmode="decimal" bind:value={buyTaxPct} placeholder="0" />
					<span class="font-mono text-[10px] text-dim">%</span>
				</div>
			</div>
		</div>

		<!-- Sell -->
		<div class={'tc-rate flex items-center justify-between gap-3 py-3 px-[14px] max-[500px]:py-[10px] max-[500px]:px-3 rounded-[10px] bg-surface border ' + (sellOver ? 'border-[rgba(248,113,113,0.25)]' : 'border-line-subtle')}>
			<div class="flex items-center gap-2 shrink-0">
				<span class="w-2 h-2 rounded-full shrink-0 bg-[#f59e0b]"></span>
				<span class="font-display text-[13px] font-semibold text-foreground">Sell Tax</span>
				<span class={'text-[9px] font-mono ml-auto uppercase tracking-[0.04em] ' + (sellOver ? 'text-[#f87171]' : 'text-dim')}>max {MAX_SELL}%</span>
			</div>
			<div class="flex items-center gap-2">
				<div class="tc-presets flex gap-[3px]">
					{#each presets as p}
						<button type="button" class={'py-[3px] px-2 rounded-md border bg-transparent font-mono text-[9px] cursor-pointer transition-all ' + (num(sellTaxPct) === p ? 'text-brand-cyan border-[rgba(0,210,255,0.3)] bg-[rgba(0,210,255,0.06)]' : 'text-dim border-line-subtle hover:text-muted hover:border-line-input')} onclick={() => sellTaxPct = String(p)}>{p}%</button>
					{/each}
				</div>
				<div class={'flex items-center gap-px w-14 py-1 px-2 rounded-md bg-surface-input border ' + (sellOver ? 'border-[rgba(248,113,113,0.4)]' : 'border-line')}>
					<input class={'w-full bg-transparent border-none outline-none font-numeric text-base font-bold text-right p-0 tabular-nums placeholder:text-placeholder ' + (sellOver ? 'text-[#f87171]' : 'text-heading')} type="text" inputmode="decimal" bind:value={sellTaxPct} placeholder="0" />
					<span class="font-mono text-[10px] text-dim">%</span>
				</div>
			</div>
		</div>

		<!-- Transfer -->
		<div class={'tc-rate flex items-center justify-between gap-3 py-3 px-[14px] max-[500px]:py-[10px] max-[500px]:px-3 rounded-[10px] bg-surface border ' + (transferOver ? 'border-[rgba(248,113,113,0.25)]' : 'border-line-subtle')}>
			<div class="flex items-center gap-2 shrink-0">
				<span class="w-2 h-2 rounded-full shrink-0 bg-[#a78bfa]"></span>
				<span class="font-display text-[13px] font-semibold text-foreground">Transfer Tax</span>
				<span class={'text-[9px] font-mono ml-auto uppercase tracking-[0.04em] ' + (transferOver ? 'text-[#f87171]' : 'text-dim')}>max {MAX_TRANSFER}%</span>
			</div>
			<div class="flex items-center gap-2">
				<div class="tc-presets flex gap-[3px]">
					{#each presets.filter(p => p <= MAX_TRANSFER) as p}
						<button type="button" class={'py-[3px] px-2 rounded-md border bg-transparent font-mono text-[9px] cursor-pointer transition-all ' + (num(transferTaxPct) === p ? 'text-brand-cyan border-[rgba(0,210,255,0.3)] bg-[rgba(0,210,255,0.06)]' : 'text-dim border-line-subtle hover:text-muted hover:border-line-input')} onclick={() => transferTaxPct = String(p)}>{p}%</button>
					{/each}
				</div>
				<div class={'flex items-center gap-px w-14 py-1 px-2 rounded-md bg-surface-input border ' + (transferOver ? 'border-[rgba(248,113,113,0.4)]' : 'border-line')}>
					<input class={'w-full bg-transparent border-none outline-none font-numeric text-base font-bold text-right p-0 tabular-nums placeholder:text-placeholder ' + (transferOver ? 'text-[#f87171]' : 'text-heading')} type="text" inputmode="decimal" bind:value={transferTaxPct} placeholder="0" />
					<span class="font-mono text-[10px] text-dim">%</span>
				</div>
			</div>
		</div>
	</div>

	<!-- Total bar -->
	{#if totalTax > 0}
		<div class="px-[2px]">
			<div class="flex h-1 rounded-[2px] overflow-hidden bg-surface-input gap-px">
				{#if num(buyTaxPct) > 0}<div class="h-full rounded-[2px] transition-[width] duration-200 bg-brand-cyan" style="width: {(num(buyTaxPct) / MAX_TOTAL) * 100}%"></div>{/if}
				{#if num(sellTaxPct) > 0}<div class="h-full rounded-[2px] transition-[width] duration-200 bg-[#f59e0b]" style="width: {(num(sellTaxPct) / MAX_TOTAL) * 100}%"></div>{/if}
				{#if num(transferTaxPct) > 0}<div class="h-full rounded-[2px] transition-[width] duration-200 bg-[#a78bfa]" style="width: {(num(transferTaxPct) / MAX_TOTAL) * 100}%"></div>{/if}
			</div>
			<div class="flex items-center gap-2 mt-1">
				<span class={'font-mono text-[10px] ' + ((totalTax > MAX_TOTAL || buyOver || sellOver || transferOver) ? 'text-[#f87171]' : 'text-dim')}>{totalTax}% total</span>
				{#if totalTax > MAX_TOTAL}<span class="text-[9px] text-[#f87171] font-mono">Max {MAX_TOTAL}%</span>{/if}
			</div>
		</div>
	{/if}

	<!-- Tax Wallets -->
	{#if totalTax > 0}
		<div class="flex flex-col gap-2">
			<div class="flex items-baseline gap-2">
				<span class="font-display text-[13px] font-bold text-muted">Revenue Wallets</span>
				<span class="text-[10px] text-dim font-mono">Where collected tax goes</span>
			</div>
			{#each taxWallets as wallet, i}
				<div class="tc-wallet flex items-center gap-[6px] py-2 px-[10px] max-[500px]:flex-wrap rounded-lg bg-surface border border-line-subtle">
					<input class="tc-wallet-addr flex-1 min-w-0 bg-transparent border-none outline-none font-mono text-[11px] max-[500px]:basis-full max-[500px]:text-[10px] text-foreground p-0 placeholder:text-dim" bind:value={wallet.address} placeholder="0x... wallet address" />
					<div class="flex items-center gap-px w-[52px] shrink-0 py-[2px] px-[6px] rounded bg-surface-input">
						<input class="w-full bg-transparent border-none outline-none font-numeric text-sm font-semibold text-heading text-right p-0" type="text" inputmode="numeric" bind:value={wallet.sharePct} placeholder="100" />
						<span class="text-[10px] text-dim font-mono">%</span>
					</div>
					{#if taxWallets.length > 1}
						<button type="button" aria-label="Remove tax wallet" class="w-6 h-6 rounded-md border-none bg-[rgba(248,113,113,0.08)] text-[#f87171] cursor-pointer flex items-center justify-center shrink-0 transition-colors hover:bg-[rgba(248,113,113,0.15)]" onclick={() => removeWallet(i)}>
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
						</button>
					{/if}
				</div>
			{/each}
			<div class="flex items-center gap-[10px]">
				{#if taxWallets.length < 10}
					<button type="button" class="py-[6px] px-3 rounded-md border border-dashed border-line bg-transparent text-dim font-mono text-[10px] cursor-pointer transition-all hover:text-brand-cyan hover:border-[rgba(0,210,255,0.2)]" onclick={addWallet}>+ Add wallet</button>
				{/if}
				{#if totalShares > 100}
					<span class="text-[10px] text-[#f87171] font-mono">Shares total {totalShares}% — max 100%</span>
				{:else if sharesBurned > 0 && totalShares > 0}
					<span class="text-[10px] text-dim font-mono">{sharesBurned}% will be burned</span>
				{/if}
			</div>
			{#if taxWithoutWallet}
				<div class="mt-[10px] py-2 px-[10px] rounded-lg bg-[rgba(245,158,11,0.08)] border border-[rgba(245,158,11,0.2)] text-[#fbbf24] text-[11px] font-mono leading-[1.5]">
					No valid wallet address set. All collected tax ({totalTax}%) will be permanently burned (sent to address zero) on every trade.
				</div>
			{/if}
		</div>
	{/if}

</div>

<style>
	/* Hide presets on small screens (retained because arbitrary media query
	   with display toggle on a utility class is noisy to inline). */
	@media (max-width: 500px) {
		.tc-presets { display: none; }
	}
</style>
