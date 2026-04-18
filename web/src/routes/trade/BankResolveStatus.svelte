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
	<div class="flex items-center gap-2 py-2.5 px-3 rounded-lg font-mono text-xs bg-(--bg-surface-input) text-(--text-dim)">
		<svg class="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
			<circle cx="12" cy="12" r="10" stroke-opacity="0.25"/>
			<path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"/>
		</svg>
		<span>{$t('trade.verifying')}</span>
	</div>
{:else if state === 'resolved'}
	<div class="flex items-center gap-2 py-2.5 px-3 rounded-lg font-mono text-xs font-bold text-success bg-[rgba(16,185,129,0.08)] border border-[rgba(16,185,129,0.2)]">
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"/></svg>
		<span>{bankName}</span>
	</div>
{:else if state === 'error'}
	<div class="flex items-center gap-2 py-2.5 px-3 rounded-lg font-mono text-xs text-danger-light bg-[rgba(239,68,68,0.06)] border border-[rgba(239,68,68,0.15)]">
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M6 6l12 12M18 6L6 18"/></svg>
		<span>{error}</span>
	</div>
{/if}
