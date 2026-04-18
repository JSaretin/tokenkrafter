<script lang="ts">
	import { t } from '$lib/i18n';
	import { getKnownLogo } from '$lib/tokenLogo';

	let {
		paySymbol,
		buyPaymentMethod,
		onOpenPicker,
	}: {
		paySymbol: string;
		buyPaymentMethod: 'native' | 'usdt' | 'usdc' | 'custom';
		onOpenPicker: () => void;
	} = $props();

	let logoUrl = $derived(getKnownLogo(paySymbol));
</script>

<!-- Payment method select -->
<div class="mb-3">
	<label class="label-text">{$t('lpd.payWith')}</label>
	<button
		type="button"
		onclick={onOpenPicker}
		class="flex items-center gap-2 w-full py-2.5 px-3 rounded-[10px] cursor-pointer bg-[var(--bg-surface)] border border-[var(--border)] text-[var(--text)] font-mono text-sm2 transition-[border-color] duration-150 hover:border-cyan-400/30"
	>
		{#if logoUrl}
			<img src={logoUrl} alt="" class="w-[22px] h-[22px] rounded-full object-cover shrink-0" />
		{:else}
			<span class="w-[22px] h-[22px] rounded-full shrink-0 flex items-center justify-center bg-cyan-400/15 text-cyan text-xs2 font-bold">{paySymbol.charAt(0)}</span>
		{/if}
		<span class="flex-1 text-left font-semibold">{paySymbol}</span>
		{#if buyPaymentMethod === 'native'}<span class="text-xxs text-[var(--text-dim)] bg-[var(--bg-surface-hover)] px-1.5 py-0.5 rounded">{$t('lpd.autoConvertedShort')}</span>{/if}
		{#if buyPaymentMethod === 'custom'}<span class="text-xxs text-[var(--text-dim)] bg-[var(--bg-surface-hover)] px-1.5 py-0.5 rounded">{$t('lpd.swapToUsdt')}</span>{/if}
		<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M6 9l6 6 6-6"/></svg>
	</button>
</div>
