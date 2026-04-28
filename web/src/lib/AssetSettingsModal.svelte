<script lang="ts">
	import { ethers } from 'ethers';
	import { fly, fade } from 'svelte/transition';
	import { hideDust } from './hideDust';
	import { hiddenAssets } from './hiddenAssets';
	import ImportTokenModal from './ImportTokenModal.svelte';
	import HiddenTokensModal from './HiddenTokensModal.svelte';
	import type { SupportedNetwork } from './structure';

	let {
		open = $bindable(false),
		networks = [] as SupportedNetwork[],
		defaultChainId = 56,
		walletType = 'embedded' as 'embedded' | 'external',
		sharedProviders = null as Map<number, ethers.JsonRpcProvider> | null,
		hiddenTokens = [] as { address: string; symbol: string; name: string; logoUrl?: string }[],
		onFeedback = (_: { message: string; type: string }) => {},
	}: {
		open: boolean;
		networks: SupportedNetwork[];
		defaultChainId: number;
		walletType?: 'embedded' | 'external';
		sharedProviders?: Map<number, ethers.JsonRpcProvider> | null;
		hiddenTokens?: { address: string; symbol: string; name: string; logoUrl?: string }[];
		onFeedback?: (f: { message: string; type: string }) => void;
	} = $props();

	let showImport = $state(false);
	let showHiddenList = $state(false);

	function close() {
		open = false;
	}
</script>

<svelte:window onkeydown={(e) => { if (open && !showImport && !showHiddenList && e.key === 'Escape') close(); }} />

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="absolute inset-0 z-30 bg-black/65 backdrop-blur-[3px] flex items-end justify-center"
		onclick={close}
		role="dialog"
		aria-modal="true"
		tabindex="-1"
		transition:fade={{ duration: 120 }}
		style="border-radius: inherit;"
	>
		<div
			class="w-full h-[80vh] max-h-[80%] bg-(--bg) border-t border-(--border) rounded-t-2xl overflow-hidden flex flex-col"
			onclick={(e) => e.stopPropagation()}
			transition:fly={{ y: 400, duration: 220 }}
		>
			<div class="flex items-center justify-between gap-2 px-4 py-3 border-b border-(--border)">
				<h3 class="font-display text-sm font-bold text-(--text-heading)">Asset settings</h3>
				<button
					type="button"
					aria-label="Close"
					class="p-1.5 rounded-lg text-(--text-dim) hover:text-(--text-heading) hover:bg-(--bg-surface-hover) transition-all"
					onclick={close}
				>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
				</button>
			</div>

			<div class="p-2 flex flex-col gap-1">
				<!-- Hide low balance toggle row -->
				<button
					type="button"
					class="asm-row asm-row-toggle"
					onclick={(e) => { e.preventDefault(); hideDust.update((v) => !v); }}
					aria-pressed={$hideDust}
				>
					<div class="asm-row-icon" style="color: #00d2ff; background: rgba(0,210,255,0.08); border-color: rgba(0,210,255,0.2);">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6l9 6 9-6"/><path d="M3 6v12h18V6"/></svg>
					</div>
					<div class="asm-row-text">
						<span class="asm-row-title">Hide small balances</span>
						<span class="asm-row-sub">Skip assets worth less than $0.10</span>
					</div>
					<span class="asm-toggle" class:asm-toggle-on={$hideDust} aria-hidden="true">
						<span class="asm-toggle-dot"></span>
					</span>
				</button>

				<!-- Import token row -->
				<button
					type="button"
					class="asm-row"
					onclick={() => (showImport = true)}
				>
					<div class="asm-row-icon" style="color: #a78bfa; background: rgba(167,139,250,0.08); border-color: rgba(167,139,250,0.2);">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
					</div>
					<div class="asm-row-text">
						<span class="asm-row-title">Import token</span>
						<span class="asm-row-sub">Add a custom ERC-20 by contract address</span>
					</div>
					<svg class="asm-row-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
				</button>

				<!-- See hidden tokens row -->
				<button
					type="button"
					class="asm-row"
					disabled={hiddenTokens.length === 0}
					onclick={() => (showHiddenList = true)}
				>
					<div class="asm-row-icon" style="color: #f59e0b; background: rgba(245,158,11,0.08); border-color: rgba(245,158,11,0.2);">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
					</div>
					<div class="asm-row-text">
						<span class="asm-row-title">See hidden tokens</span>
						<span class="asm-row-sub">{hiddenTokens.length === 0 ? 'No hidden tokens' : `${hiddenTokens.length} hidden — tap to unhide`}</span>
					</div>
					{#if hiddenTokens.length > 0}
						<svg class="asm-row-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
					{/if}
				</button>
			</div>
		</div>
	</div>
{/if}

<ImportTokenModal
	bind:open={showImport}
	{networks}
	{defaultChainId}
	{walletType}
	{sharedProviders}
	onFeedback={(f) => { onFeedback(f); if (f.type === 'success') open = false; }}
/>

<HiddenTokensModal
	bind:open={showHiddenList}
	{hiddenTokens}
	{walletType}
	onFeedback={(f) => onFeedback(f)}
/>

<style>
	.asm-row {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		padding: 10px 12px;
		border: none;
		background: transparent;
		border-radius: 10px;
		cursor: pointer;
		text-align: left;
		font-family: inherit;
		color: inherit;
		transition: background 0.12s;
	}
	.asm-row:hover:not(:disabled) { background: var(--bg-surface); }
	.asm-row:disabled { opacity: 0.5; cursor: not-allowed; }
	.asm-row-icon {
		width: 32px; height: 32px;
		border-radius: 9px;
		border: 1px solid;
		display: flex; align-items: center; justify-content: center;
		flex-shrink: 0;
	}
	.asm-row-text {
		flex: 1; min-width: 0;
		display: flex; flex-direction: column; gap: 1px;
	}
	.asm-row-title {
		font-family: 'Syne', sans-serif;
		font-size: 13px; font-weight: 700;
		color: var(--text-heading);
	}
	.asm-row-sub {
		font-family: 'Space Mono', monospace;
		font-size: 10px; color: var(--text-dim);
		line-height: 1.4;
	}
	.asm-row-chev { color: var(--text-dim); flex-shrink: 0; }
	.asm-row-toggle:hover .asm-toggle:not(.asm-toggle-on) { border-color: var(--text-dim); }
	.asm-toggle {
		position: relative;
		width: 38px; height: 22px;
		border-radius: 999px;
		background: var(--bg-surface-input);
		border: 1px solid var(--border);
		flex-shrink: 0;
		transition: background 0.15s, border-color 0.15s;
	}
	.asm-toggle-on { background: #00d2ff; border-color: #00d2ff; }
	.asm-toggle-dot {
		position: absolute;
		top: 1px; left: 1px;
		width: 18px; height: 18px;
		border-radius: 50%;
		background: white;
		box-shadow: 0 1px 3px rgba(0,0,0,0.3);
		transition: transform 0.15s;
	}
	.asm-toggle-on .asm-toggle-dot { transform: translateX(16px); }
</style>
