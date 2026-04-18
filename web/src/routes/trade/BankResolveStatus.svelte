<script lang="ts">
	import { t } from '$lib/i18n';

	let {
		resolving = false,
		resolved = false,
		bankName = '',
		error = '',
	}: {
		resolving?: boolean;
		resolved?: boolean;
		bankName?: string;
		error?: string;
	} = $props();

	let state = $derived(
		resolving ? 'resolving' : (resolved && bankName) ? 'resolved' : error ? 'error' : 'none'
	);
</script>

{#if state === 'resolving'}
	<div class="flex items-center gap-2 py-2.5 px-3 rounded-lg font-mono text-xs bg-(--bg-surface-input) text-(--text-muted)">
		<div class="w-3.5 h-3.5 border-2 border-(--border) border-t-[#00d2ff] rounded-full animate-spin"></div>
		<span>{$t('trade.verifying')}</span>
	</div>
{:else if state === 'resolved'}
	<div class="flex items-center gap-2 py-2.5 px-3 rounded-lg font-mono text-xs font-bold text-[#10b981] bg-[rgba(16,185,129,0.08)] border border-[rgba(16,185,129,0.2)]">
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
		<span>{bankName}</span>
	</div>
{:else if state === 'error'}
	<div class="flex items-center gap-2 py-2.5 px-3 rounded-lg font-mono text-xs text-[#f87171] bg-[rgba(239,68,68,0.06)] border border-[rgba(239,68,68,0.15)]">
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
		<span>{error}</span>
	</div>
{/if}
