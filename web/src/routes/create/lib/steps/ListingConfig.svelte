<script lang="ts">
	import { ethers } from 'ethers';

	type ListingPair = { base: 'native' | 'usdt' | 'usdc'; amount: string };

	let {
		symbol = $bindable(''),
		totalSupply = $bindable(''),
		poolPct = $bindable(80),
		pairs = $bindable([{ base: 'native', amount: '' }] as ListingPair[]),
		pricePerToken = $bindable(''),
		nativeCoin = 'BNB',
		bnbPriceUsd = 0,
	}: {
		symbol: string;
		totalSupply: string;
		poolPct: number;
		pairs: ListingPair[];
		pricePerToken: string;
		nativeCoin: string;
		bnbPriceUsd: number;
	} = $props();

	let advanced = $state(false);

	function pairUsd(pair: ListingPair): number {
		const amt = Number(pair.amount);
		if (!amt || amt <= 0) return 0;
		return pair.base === 'native' ? amt * bnbPriceUsd : amt;
	}

	let totalUsd = $derived(pairs.reduce((s, p) => s + pairUsd(p), 0));
	let tokensForPool = $derived(Number(totalSupply) * (poolPct / 100));

	let autoPrice = $derived.by(() => {
		if (tokensForPool <= 0 || totalUsd <= 0) return 0;
		return totalUsd / tokensForPool;
	});

	// Auto-set price (unless manual)
	$effect(() => {
		if (!advanced && autoPrice > 0) {
			pricePerToken = autoPrice.toFixed(18).replace(/0+$/, '').replace(/\.$/, '');
		}
	});

	function tokensForPair(pair: ListingPair): number {
		if (totalUsd <= 0 || tokensForPool <= 0) return 0;
		return tokensForPool * (pairUsd(pair) / totalUsd);
	}

	function sharePct(pair: ListingPair): number {
		return totalUsd > 0 ? (pairUsd(pair) / totalUsd) * 100 : 0;
	}

	function getLabel(base: string): string {
		return base === 'native' ? nativeCoin : base.toUpperCase();
	}

	function addPair() {
		const used = new Set(pairs.map(p => p.base));
		const next = (['native', 'usdt', 'usdc'] as const).find(b => !used.has(b));
		if (next) pairs = [...pairs, { base: next, amount: '' }];
	}

	function removePair(i: number) { pairs = pairs.filter((_, idx) => idx !== i); }

	function updateBase(i: number, base: 'native' | 'usdt' | 'usdc') {
		pairs = pairs.map((p, idx) => idx === i ? { ...p, base } : p);
	}

	function updateAmount(i: number, amount: string) {
		pairs = pairs.map((p, idx) => idx === i ? { ...p, amount } : p);
	}

	function fmtPrice(p: number): string {
		if (p <= 0) return '—';
		if (p >= 0.01) return '$' + p.toFixed(4);
		if (p >= 0.000001) return '$' + p.toFixed(8);
		// Show all significant digits, no scientific notation
		const s = p.toFixed(18);
		const trimmed = s.replace(/0+$/, '').replace(/\.$/, '');
		return '$' + trimmed;
	}

	let marketCap = $derived(autoPrice > 0 ? autoPrice * Number(totalSupply) : 0);
	let tenDollarBuy = $derived(autoPrice > 0 ? 10 / autoPrice : 0);
</script>

<!-- Tokens for trading -->
<div class="mb-4">
	<label for="lc-pool-pct" class="block text-[11px] font-bold text-dim uppercase tracking-[0.05em] font-mono mb-1.5">Tokens for trading</label>
	<div class="flex items-center gap-3">
		<input id="lc-pool-pct" type="range" class="lc-slider flex-1 h-1.5 bg-surface-hover rounded-[3px] outline-none" min="10" max="100" step="5" bind:value={poolPct} />
		<span class="text-base font-bold text-[#00d2ff] font-display min-w-[40px] text-right">{poolPct}%</span>
	</div>
	<div class="flex justify-between mt-1 text-[10px] text-dim font-mono">
		<span>{tokensForPool > 0 ? tokensForPool.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '0'} {symbol} in pools</span>
		<span>{(Number(totalSupply) - tokensForPool).toLocaleString(undefined, { maximumFractionDigits: 0 })} in your wallet</span>
	</div>
</div>

<!-- Liquidity pairs -->
<div class="mb-4">
	<span class="block text-[11px] font-bold text-dim uppercase tracking-[0.05em] font-mono mb-1.5">Add liquidity</span>
	{#each pairs as pair, i}
		<div class="border border-line rounded-xl p-3 mb-2 bg-surface">
			<div class="flex justify-between items-center mb-2">
				<select class="py-1 px-2.5 rounded-lg border border-[rgba(0,210,255,0.2)] bg-[rgba(0,210,255,0.06)] text-[#00d2ff] font-mono text-xs font-bold cursor-pointer" value={pair.base} onchange={(e) => updateBase(i, (e.target as HTMLSelectElement).value as any)} tabindex="0">
					<option value="native">{nativeCoin}</option>
					<option value="usdt">USDT</option>
					<option value="usdc">USDC</option>
				</select>
				{#if pairs.length > 1}
					<button type="button" class="bg-none border-none text-dim text-lg cursor-pointer px-1 hover:text-[#f87171]" tabindex="-1" onclick={() => removePair(i)}>×</button>
				{/if}
			</div>
			<div class="flex items-center gap-2">
				<input class="flex-1 bg-transparent border-none outline-none text-heading font-display text-2xl font-bold p-0 min-w-0 placeholder:text-placeholder" type="text" inputmode="decimal" placeholder="0.00" value={pair.amount} oninput={(e) => updateAmount(i, (e.target as HTMLInputElement).value)} />
				<span class="text-[13px] font-bold text-dim font-mono">{getLabel(pair.base)}</span>
			</div>
			{#if pairUsd(pair) > 0}
				<div class="text-[11px] text-dim font-mono mt-1">≈ ${pairUsd(pair).toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
			{/if}
			{#if totalUsd > 0 && pairUsd(pair) > 0}
				<div class="mt-2 pt-2 border-t border-line-subtle">
					<div class="w-full h-[5px] bg-surface-input rounded-[3px] overflow-hidden"><div class="h-full rounded-[3px] transition-[width] duration-200" style="width:{sharePct(pair)}%;background:{pair.base === 'native' ? '#f59e0b' : pair.base === 'usdt' ? '#10b981' : '#3b82f6'}"></div></div>
					<div class="flex justify-between mt-[3px] text-[10px] text-dim font-mono">
						<span>{symbol}/{getLabel(pair.base)}</span>
						<span class="text-[#00d2ff]">{sharePct(pair).toFixed(0)}% · {tokensForPair(pair).toLocaleString(undefined, { maximumFractionDigits: 0 })} {symbol}</span>
					</div>
				</div>
			{/if}
		</div>
	{/each}

	{#if pairs.length < 3}
		<button type="button" class="block w-full p-2.5 rounded-[10px] border border-dashed border-[rgba(0,210,255,0.2)] bg-transparent text-dim font-mono text-xs cursor-pointer transition-all duration-150 hover:border-[rgba(0,210,255,0.4)] hover:text-[#00d2ff]" tabindex="-1" onclick={addPair}>+ Add pair ({pairs.length}/3)</button>
	{/if}
</div>

<!-- Preview -->
{#if totalUsd > 0 && tokensForPool > 0}
	<div class="border border-[rgba(0,210,255,0.12)] rounded-xl bg-[rgba(0,210,255,0.02)] p-3.5 mb-3 overflow-hidden min-w-0">
		<div class="font-display text-xs font-bold text-[#00d2ff] uppercase tracking-[0.05em] mb-2.5">Preview</div>
		<div class="grid grid-cols-2 max-[500px]:grid-cols-1 gap-2 mb-2.5">
			<div class="bg-black/20 rounded-lg py-2 px-2.5 min-w-0">
				<span class="block text-[9px] text-dim font-mono uppercase tracking-[0.03em]">Starting price</span>
				<span class="block text-[13px] font-bold text-heading font-mono mt-0.5 truncate">{fmtPrice(autoPrice)}</span>
			</div>
			<div class="bg-black/20 rounded-lg py-2 px-2.5 min-w-0">
				<span class="block text-[9px] text-dim font-mono uppercase tracking-[0.03em]">Market cap</span>
				<span class="block text-[13px] font-bold font-mono mt-0.5 text-[#10b981] truncate">${marketCap.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
			</div>
			<div class="bg-black/20 rounded-lg py-2 px-2.5 min-w-0">
				<span class="block text-[9px] text-dim font-mono uppercase tracking-[0.03em]">Total liquidity</span>
				<span class="block text-[13px] font-bold text-heading font-mono mt-0.5 truncate">${totalUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
			</div>
			<div class="bg-black/20 rounded-lg py-2 px-2.5 min-w-0">
				<span class="block text-[9px] text-dim font-mono uppercase tracking-[0.03em]">$10 buys</span>
				<span class="block text-[13px] font-bold text-heading font-mono mt-0.5 truncate">{tenDollarBuy > 0 ? tenDollarBuy.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'} {symbol}</span>
			</div>
		</div>

		<!-- Pool breakdown bars -->
		{#each pairs.filter(p => Number(p.amount) > 0) as pair}
			<div class="flex items-center gap-2 py-[3px] text-[10px] font-mono min-w-0">
				<div class="w-[40px] h-1.5 bg-surface-input rounded-[3px] overflow-hidden shrink-0"><div class="h-full rounded-[3px]" style="width:{sharePct(pair)}%;background:{pair.base === 'native' ? '#f59e0b' : pair.base === 'usdt' ? '#10b981' : '#3b82f6'}"></div></div>
				<span class="text-foreground font-bold shrink-0 truncate max-w-[80px]">{symbol}/{getLabel(pair.base)}</span>
				<span class="text-dim flex-1 min-w-0 truncate">{pair.amount} {getLabel(pair.base)} ↔ {tokensForPair(pair).toLocaleString(undefined, { maximumFractionDigits: 0 })} {symbol}</span>
				<span class="text-[#00d2ff] font-bold shrink-0">{sharePct(pair).toFixed(0)}%</span>
			</div>
		{/each}
	</div>
{/if}

<!-- Advanced -->
<button type="button" class="block mt-2 p-0 border-none bg-none text-dim text-[11px] font-mono cursor-pointer hover:text-[#00d2ff]" tabindex="-1" onclick={() => advanced = !advanced}>
	{advanced ? '▾ Hide' : '▸ Advanced'} — set price manually
</button>
{#if advanced}
	<div class="mb-4 mt-1.5">
		<label for="lc-price-per-token" class="block text-[11px] font-bold text-dim uppercase tracking-[0.05em] font-mono mb-1.5">Token price (USDT)</label>
		<input id="lc-price-per-token" class="input-field" type="text" bind:value={pricePerToken} placeholder="0.001" />
	</div>
{/if}

<style>
	.lc-slider { -webkit-appearance: none; }
	.lc-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 18px; height: 18px; border-radius: 50%; background: #00d2ff; cursor: pointer; border: 2px solid var(--bg); }
</style>
