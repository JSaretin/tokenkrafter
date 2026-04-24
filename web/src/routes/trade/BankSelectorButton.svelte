<script lang="ts">
	import { t } from '$lib/i18n';

	let {
		bankName = '',
		onclick,
	}: {
		bankName?: string;
		onclick: () => void;
	} = $props();
</script>

<button
	type="button"
	class="w-full flex items-center justify-between py-[11px] px-[14px] rounded-[10px] border border-(--border-input) bg-(--bg-surface-input) cursor-pointer transition-all duration-150 hover:border-[rgba(0,210,255,0.3)]"
	{onclick}
>
	{#if bankName}
		<span class="font-mono text-13 font-semibold text-(--text)">{bankName}</span>
	{:else}
		<span class="font-mono text-13 text-(--placeholder)">{$t('trade.selectBank')}</span>
	{/if}
	<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M6 9l6 6 6-6"/></svg>
</button>
