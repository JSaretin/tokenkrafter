<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '$lib/i18n';

	const SLIPPAGE_KEY = 'trade_slippage_bps';
	const CUSTOM_SLIP_KEY = 'trade_custom_slippage';

	let {
		slippageBps = $bindable(50),
	}: {
		slippageBps?: number;
	} = $props();

	let customSlippage = $state('');

	onMount(() => {
		try {
			const savedBps = localStorage.getItem(SLIPPAGE_KEY);
			if (savedBps) {
				const n = parseInt(savedBps);
				if (n > 0 && n <= 5000) slippageBps = n;
			}
			const savedCustom = localStorage.getItem(CUSTOM_SLIP_KEY);
			if (savedCustom) customSlippage = savedCustom;
		} catch {}
	});

	$effect(() => {
		if (typeof localStorage === 'undefined') return;
		try {
			localStorage.setItem(SLIPPAGE_KEY, String(slippageBps));
			localStorage.setItem(CUSTOM_SLIP_KEY, customSlippage);
		} catch {}
	});
</script>

<div class="bg-(--bg-surface) border border-(--border) rounded-[14px] px-4 py-3.5 mb-3">
	<span class="block font-mono text-xs3 font-semibold uppercase tracking-[0.07em] text-(--text-muted) mb-2">{$t('trade.slippageTolerance')}</span>
	<div class="flex gap-1.5">
		{#each [50, 100, 200, 500] as bps}
			<button
				class={"flex-1 py-2 rounded-lg border bg-transparent font-mono text-xs font-semibold cursor-pointer transition-[border-color,color,background] duration-150 hover:border-cyan/30 hover:text-cyan " + (slippageBps === bps && !customSlippage ? 'border-cyan/40 bg-cyan/10 text-cyan' : 'border-(--border) text-(--text-muted)')}
				onclick={() => { slippageBps = bps; customSlippage = ''; }}
			>{bps / 100}%</button>
		{/each}
		<div class={"flex-[1.2] flex items-center rounded-lg border bg-transparent px-2 transition-[border-color] duration-150 focus-within:border-cyan/40 " + (customSlippage ? 'border-cyan/40 bg-cyan/10' : 'border-(--border)')}>
			<input
				class="w-full border-0 bg-transparent outline-none focus:outline-none focus:ring-0 text-(--text) font-mono text-xs font-semibold py-2 text-right placeholder:text-(--text-dim) placeholder:font-normal"
				type="text"
				inputmode="decimal"
				placeholder={$t('trade.custom')}
				bind:value={customSlippage}
				oninput={() => {
					const v = parseFloat(customSlippage);
					if (!isNaN(v) && v > 0 && v <= 20) {
						slippageBps = Math.round(v * 100);
					}
				}}
				max="20"
			/>
			<span class="font-mono text-xs3 text-(--text-muted) ml-0.5 shrink-0">%</span>
		</div>
	</div>
	{#if customSlippage}
		{@const v = parseFloat(customSlippage)}
		{#if v > 5}
			<p class="font-mono text-xs2 text-warning-light mt-1.5 mb-0 p-0">{$t('trade.slippageHigh')}</p>
		{:else if v < 0.1}
			<p class="font-mono text-xs2 text-warning-light mt-1.5 mb-0 p-0">{$t('trade.slippageLow')}</p>
		{/if}
	{/if}
</div>
