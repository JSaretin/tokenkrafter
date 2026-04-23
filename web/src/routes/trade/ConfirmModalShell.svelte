<script lang="ts">
	import type { Snippet } from 'svelte';
	import { t } from '$lib/i18n';
	import FixedOverlay from '$lib/FixedOverlay.svelte';

	let {
		show = $bindable(true),
		title,
		closable = true,
		onClose,
		children,
	}: {
		show?: boolean;
		title: string;
		closable?: boolean;
		onClose?: () => void;
		children: Snippet;
	} = $props();

	function handleClose() {
		if (!closable) return;
		if (onClose) onClose();
		else show = false;
	}
</script>

<FixedOverlay bind:show onclose={handleClose}>
	<div class="w-full max-w-[420px] bg-(--bg) border border-(--border) rounded-[20px] overflow-hidden max-h-[80vh] max-sm:h-[85vh] max-sm:max-h-[85vh] max-sm:w-full max-sm:max-w-full max-sm:rounded-b-none flex flex-col">
		<div class="flex justify-between items-center py-4 px-5 border-b border-(--border)">
			<h3 class="syne text-[16px] font-bold text-(--text-heading) m-0">{title}</h3>
			{#if closable}
				<button aria-label={$t('common.close')} class="bg-transparent border-0 text-(--text-muted) cursor-pointer p-1 rounded-lg transition-all duration-150 hover:text-(--text) hover:bg-(--bg-surface-hover)" onclick={handleClose}>
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
				</button>
			{/if}
		</div>
		<div class="pt-3.5 px-4 pb-4 overflow-y-auto flex-1">
			{@render children()}
		</div>
	</div>
</FixedOverlay>
