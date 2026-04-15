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
<div class="lc-field">
	<label class="lc-label">Tokens for trading</label>
	<div class="lc-slider-row">
		<input type="range" class="lc-slider" min="10" max="100" step="5" bind:value={poolPct} />
		<span class="lc-slider-val">{poolPct}%</span>
	</div>
	<div class="lc-slider-info">
		<span>{tokensForPool > 0 ? tokensForPool.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '0'} {symbol} in pools</span>
		<span>{(Number(totalSupply) - tokensForPool).toLocaleString(undefined, { maximumFractionDigits: 0 })} in your wallet</span>
	</div>
</div>

<!-- Liquidity pairs -->
<div class="lc-field">
	<label class="lc-label">Add liquidity</label>
	{#each pairs as pair, i}
		<div class="lc-pair">
			<div class="lc-pair-head">
				<select class="lc-pair-select" value={pair.base} onchange={(e) => updateBase(i, (e.target as HTMLSelectElement).value as any)} tabindex="0">
					<option value="native">{nativeCoin}</option>
					<option value="usdt">USDT</option>
					<option value="usdc">USDC</option>
				</select>
				{#if pairs.length > 1}
					<button type="button" class="lc-pair-rm" tabindex="-1" onclick={() => removePair(i)}>×</button>
				{/if}
			</div>
			<div class="lc-pair-input-row">
				<input class="lc-pair-input" type="text" inputmode="decimal" placeholder="0.00" value={pair.amount} oninput={(e) => updateAmount(i, (e.target as HTMLInputElement).value)} />
				<span class="lc-pair-unit">{getLabel(pair.base)}</span>
			</div>
			{#if pairUsd(pair) > 0}
				<div class="lc-pair-usd">≈ ${pairUsd(pair).toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
			{/if}
			{#if totalUsd > 0 && pairUsd(pair) > 0}
				<div class="lc-pair-share">
					<div class="lc-bar"><div class="lc-bar-fill" style="width:{sharePct(pair)}%;background:{pair.base === 'native' ? '#f59e0b' : pair.base === 'usdt' ? '#10b981' : '#3b82f6'}"></div></div>
					<div class="lc-share-row">
						<span>{symbol}/{getLabel(pair.base)}</span>
						<span>{sharePct(pair).toFixed(0)}% · {tokensForPair(pair).toLocaleString(undefined, { maximumFractionDigits: 0 })} {symbol}</span>
					</div>
				</div>
			{/if}
		</div>
	{/each}

	{#if pairs.length < 3}
		<button type="button" class="lc-add" tabindex="-1" onclick={addPair}>+ Add pair ({pairs.length}/3)</button>
	{/if}
</div>

<!-- Preview -->
{#if totalUsd > 0 && tokensForPool > 0}
	<div class="lc-preview">
		<div class="lc-preview-title">Preview</div>
		<div class="lc-grid">
			<div class="lc-grid-item">
				<span class="lc-grid-label">Starting price</span>
				<span class="lc-grid-val">{fmtPrice(autoPrice)}</span>
			</div>
			<div class="lc-grid-item">
				<span class="lc-grid-label">Market cap</span>
				<span class="lc-grid-val lc-green">${marketCap.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
			</div>
			<div class="lc-grid-item">
				<span class="lc-grid-label">Total liquidity</span>
				<span class="lc-grid-val">${totalUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
			</div>
			<div class="lc-grid-item">
				<span class="lc-grid-label">$10 buys</span>
				<span class="lc-grid-val">{tenDollarBuy > 0 ? tenDollarBuy.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'} {symbol}</span>
			</div>
		</div>

		<!-- Pool breakdown bars -->
		{#each pairs.filter(p => Number(p.amount) > 0) as pair}
			<div class="lc-pool-row">
				<div class="lc-pool-bar-wrap"><div class="lc-pool-bar" style="width:{sharePct(pair)}%;background:{pair.base === 'native' ? '#f59e0b' : pair.base === 'usdt' ? '#10b981' : '#3b82f6'}"></div></div>
				<span class="lc-pool-name">{symbol}/{getLabel(pair.base)}</span>
				<span class="lc-pool-detail">{pair.amount} {getLabel(pair.base)} ↔ {tokensForPair(pair).toLocaleString(undefined, { maximumFractionDigits: 0 })} {symbol}</span>
				<span class="lc-pool-pct">{sharePct(pair).toFixed(0)}%</span>
			</div>
		{/each}
	</div>
{/if}

<!-- Advanced -->
<button type="button" class="lc-advanced" tabindex="-1" onclick={() => advanced = !advanced}>
	{advanced ? '▾ Hide' : '▸ Advanced'} — set price manually
</button>
{#if advanced}
	<div class="lc-field" style="margin-top:6px;">
		<label class="lc-label">Token price (USDT)</label>
		<input class="input-field" type="text" bind:value={pricePerToken} placeholder="0.001" />
	</div>
{/if}

<style>
	.lc-field { margin-bottom: 16px; }
	.lc-label { display: block; font-size: 11px; font-weight: 700; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; font-family: 'Space Mono', monospace; margin-bottom: 6px; }

	.lc-slider-row { display: flex; align-items: center; gap: 12px; }
	.lc-slider { flex: 1; -webkit-appearance: none; height: 6px; background: var(--bg-surface-hover); border-radius: 3px; outline: none; }
	.lc-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 18px; height: 18px; border-radius: 50%; background: #00d2ff; cursor: pointer; border: 2px solid var(--bg); }
	.lc-slider-val { font-size: 16px; font-weight: 700; color: #00d2ff; font-family: 'Syne', sans-serif; min-width: 40px; text-align: right; }
	.lc-slider-info { display: flex; justify-content: space-between; margin-top: 4px; font-size: 10px; color: var(--text-dim); font-family: 'Space Mono', monospace; }

	.lc-pair { border: 1px solid var(--border); border-radius: 12px; padding: 12px; margin-bottom: 8px; background: var(--bg-surface); }
	.lc-pair-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
	.lc-pair-select { padding: 4px 10px; border-radius: 8px; border: 1px solid rgba(0,210,255,0.2); background: rgba(0,210,255,0.06); color: #00d2ff; font-family: 'Space Mono', monospace; font-size: 12px; font-weight: 700; cursor: pointer; }
	.lc-pair-rm { background: none; border: none; color: var(--text-dim); font-size: 18px; cursor: pointer; padding: 0 4px; }
	.lc-pair-rm:hover { color: #f87171; }
	.lc-pair-input-row { display: flex; align-items: center; gap: 8px; }
	.lc-pair-input { flex: 1; background: transparent; border: none; outline: none; color: var(--text-heading); font-family: 'Syne', sans-serif; font-size: 24px; font-weight: 700; padding: 0; min-width: 0; }
	.lc-pair-input::placeholder { color: var(--placeholder); }
	.lc-pair-unit { font-size: 13px; font-weight: 700; color: var(--text-dim); font-family: 'Space Mono', monospace; }
	.lc-pair-usd { font-size: 11px; color: var(--text-dim); font-family: 'Space Mono', monospace; margin-top: 4px; }

	.lc-pair-share { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border-subtle); }
	.lc-bar { width: 100%; height: 5px; background: var(--bg-surface-input); border-radius: 3px; overflow: hidden; }
	.lc-bar-fill { height: 100%; border-radius: 3px; transition: width 200ms; }
	.lc-share-row { display: flex; justify-content: space-between; margin-top: 3px; font-size: 10px; color: var(--text-dim); font-family: 'Space Mono', monospace; }
	.lc-share-row span:last-child { color: #00d2ff; }

	.lc-add { display: block; width: 100%; padding: 10px; border-radius: 10px; border: 1px dashed rgba(0,210,255,0.2); background: transparent; color: var(--text-dim); font-family: 'Space Mono', monospace; font-size: 12px; cursor: pointer; transition: all 150ms; }
	.lc-add:hover { border-color: rgba(0,210,255,0.4); color: #00d2ff; }

	.lc-preview { border: 1px solid rgba(0,210,255,0.12); border-radius: 12px; background: rgba(0,210,255,0.02); padding: 14px; margin-bottom: 12px; }
	.lc-preview-title { font-family: 'Syne', sans-serif; font-size: 12px; font-weight: 700; color: #00d2ff; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 10px; }
	.lc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 10px; }
	.lc-grid-item { background: rgba(0,0,0,0.2); border-radius: 8px; padding: 8px 10px; }
	.lc-grid-label { display: block; font-size: 9px; color: var(--text-dim); font-family: 'Space Mono', monospace; text-transform: uppercase; letter-spacing: 0.03em; }
	.lc-grid-val { display: block; font-size: 13px; font-weight: 700; color: var(--text-heading); font-family: 'Space Mono', monospace; margin-top: 2px; }
	.lc-green { color: #10b981; }

	.lc-pool-row { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: 10px; font-family: 'Space Mono', monospace; }
	.lc-pool-bar-wrap { width: 50px; height: 6px; background: var(--bg-surface-input); border-radius: 3px; overflow: hidden; flex-shrink: 0; }
	.lc-pool-bar { height: 100%; border-radius: 3px; }
	.lc-pool-name { color: var(--text); font-weight: 700; min-width: 80px; }
	.lc-pool-detail { color: var(--text-dim); flex: 1; }
	.lc-pool-pct { color: #00d2ff; font-weight: 700; }

	.lc-advanced { display: block; margin-top: 8px; padding: 0; border: none; background: none; color: var(--text-dim); font-size: 11px; font-family: 'Space Mono', monospace; cursor: pointer; }
	.lc-advanced:hover { color: #00d2ff; }

	@media (max-width: 500px) { .lc-grid { grid-template-columns: 1fr; } }
</style>
