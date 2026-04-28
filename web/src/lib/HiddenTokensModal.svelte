<script lang="ts">
	import { fly, fade } from 'svelte/transition';
	import { toggleHidden } from './hiddenAssets';
	import { pushPreferences } from './embeddedWallet';
	import { getKnownLogo } from './tokenLogo';

	let {
		open = $bindable(false),
		hiddenTokens = [] as { address: string; symbol: string; name: string; logoUrl?: string }[],
		walletType = 'embedded' as 'embedded' | 'external',
		onFeedback = (_: { message: string; type: string }) => {},
	}: {
		open: boolean;
		hiddenTokens: { address: string; symbol: string; name: string; logoUrl?: string }[];
		walletType?: 'embedded' | 'external';
		onFeedback?: (f: { message: string; type: string }) => void;
	} = $props();

	function close() {
		open = false;
	}

	function unhide(addr: string, symbol: string) {
		toggleHidden(addr);
		if (walletType === 'embedded') pushPreferences().catch(() => {});
		onFeedback({ message: `${symbol} unhidden`, type: 'success' });
	}
</script>

<svelte:window onkeydown={(e) => { if (open && e.key === 'Escape') close(); }} />

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-[10001] bg-black/65 backdrop-blur-[3px] flex items-center justify-center p-4 max-[639px]:items-end max-[639px]:p-0"
		onclick={close}
		role="dialog"
		aria-modal="true"
		tabindex="-1"
		transition:fade={{ duration: 120 }}
	>
		<div
			class="w-full max-w-[420px] max-h-[70vh] bg-(--bg) border border-(--border) rounded-2xl overflow-hidden flex flex-col max-[639px]:max-w-full max-[639px]:rounded-t-2xl max-[639px]:rounded-b-none max-[639px]:h-[80vh] max-[639px]:max-h-[80vh]"
			onclick={(e) => e.stopPropagation()}
			transition:fly={{ y: 16, duration: 180 }}
		>
			<div class="flex items-center justify-between gap-2 px-4 py-3 border-b border-(--border)">
				<h3 class="font-display text-sm font-bold text-(--text-heading)">Hidden tokens</h3>
				<button
					type="button"
					aria-label="Close"
					class="p-1.5 rounded-lg text-(--text-dim) hover:text-(--text-heading) hover:bg-(--bg-surface-hover) transition-all"
					onclick={close}
				>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
				</button>
			</div>

			<div class="flex-1 overflow-y-auto p-2">
				{#if hiddenTokens.length === 0}
					<p class="text-center py-10 text-13 text-(--text-dim) font-mono">No hidden tokens</p>
				{:else}
					{#each hiddenTokens as tok}
						{@const logo = tok.logoUrl || getKnownLogo(tok.symbol)}
						<div class="flex items-center gap-3 py-2.5 px-3 rounded-xl hover:bg-(--bg-surface) transition-colors">
							{#if logo}
								<img src={logo} alt={tok.symbol} class="w-9 h-9 rounded-full object-cover shrink-0 border border-(--border)" />
							{:else}
								<div class="w-9 h-9 rounded-full bg-(--bg-surface-input) border border-(--border) flex items-center justify-center font-display text-xs font-extrabold text-(--text-muted) shrink-0">{tok.symbol.charAt(0)}</div>
							{/if}
							<div class="flex-1 min-w-0">
								<span class="block font-display text-sm font-bold text-(--text-heading) leading-[1.3]">{tok.symbol}</span>
								<span class="block font-mono text-3xs text-(--text-dim) mt-0.5 truncate">{tok.name}</span>
							</div>
							<button
								type="button"
								class="htm-unhide-btn"
								onclick={() => unhide(tok.address, tok.symbol)}
								aria-label="Unhide {tok.symbol}"
							>
								Unhide
							</button>
						</div>
					{/each}
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.htm-unhide-btn {
		padding: 6px 12px;
		border-radius: 8px;
		border: 1px solid rgba(0, 210, 255, 0.25);
		background: rgba(0, 210, 255, 0.06);
		color: #00d2ff;
		font-family: 'Syne', sans-serif;
		font-size: 11px;
		font-weight: 700;
		cursor: pointer;
		transition: background 0.12s, border-color 0.12s;
		flex-shrink: 0;
	}
	.htm-unhide-btn:hover {
		background: rgba(0, 210, 255, 0.12);
		border-color: rgba(0, 210, 255, 0.4);
	}
</style>
