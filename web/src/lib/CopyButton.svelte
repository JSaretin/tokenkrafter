<script lang="ts">
	import { t } from '$lib/i18n';

	let {
		text,
		label = '',
		copiedLabel = '',
		iconOnly = false,
		class: className = '',
	}: {
		text: string;
		label?: string;
		copiedLabel?: string;
		iconOnly?: boolean;
		class?: string;
	} = $props();

	let copied = $state(false);

	function copy() {
		navigator.clipboard.writeText(text);
		copied = true;
		setTimeout(() => { copied = false; }, 2000);
	}
</script>

<button
	class={"inline-flex items-center gap-1.5 cursor-pointer transition-all duration-150 " + className}
	onclick={copy}
	title={label || $t('lib.copy.copy')}
>
	{#if copied}
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
		{#if !iconOnly}<span>{copiedLabel || $t('lib.copy.copied')}</span>{/if}
	{:else}
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
		{#if !iconOnly}<span>{label || $t('lib.copy.copy')}</span>{/if}
	{/if}
</button>
