<script lang="ts">
	import { fly, fade } from 'svelte/transition';
	import type { ActionItem } from './actionSheetTypes';

	let {
		open = $bindable(false),
		title = '',
		subtitle = '',
		avatar = '', // emoji or single letter
		avatarColor = '#00d2ff',
		actions = [] as ActionItem[],
		onClose = () => {},
	}: {
		open: boolean;
		title?: string;
		subtitle?: string;
		avatar?: string;
		avatarColor?: string;
		actions: ActionItem[];
		onClose?: () => void;
	} = $props();

	function close() {
		open = false;
		onClose();
	}

	function trigger(a: ActionItem) {
		if (a.disabled) return;
		a.onClick();
		open = false;
	}
</script>

<svelte:window onkeydown={(e) => { if (open && e.key === 'Escape') close(); }} />

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="absolute inset-0 z-[60] bg-black/65 backdrop-blur-[3px] flex items-end justify-center"
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
			<!-- Header (avatar + title + subtitle) -->
			{#if title || avatar}
				<div class="flex items-center gap-3 px-4 py-3.5 border-b border-(--border)">
					{#if avatar}
						<div
							class="w-10 h-10 rounded-full flex items-center justify-center font-display text-sm font-extrabold shrink-0 border"
							style="color: {avatarColor}; background: {avatarColor}1a; border-color: {avatarColor}33;"
						>{avatar}</div>
					{/if}
					<div class="flex-1 min-w-0">
						{#if title}<span class="block font-display text-base font-bold text-(--text-heading) leading-[1.3] truncate">{title}</span>{/if}
						{#if subtitle}<span class="block font-mono text-3xs text-(--text-dim) mt-0.5 truncate">{subtitle}</span>{/if}
					</div>
				</div>
			{/if}

			<!-- Actions -->
			<div class="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
				{#each actions as a}
					<button
						type="button"
						class="as-action"
						class:as-danger={a.danger}
						disabled={a.disabled}
						onclick={() => trigger(a)}
					>
						<div
							class="as-icon"
							style="color: {a.iconColor || (a.danger ? '#f87171' : '#00d2ff')}; background: {(a.iconColor || (a.danger ? '#f87171' : '#00d2ff'))}1a; border-color: {(a.iconColor || (a.danger ? '#f87171' : '#00d2ff'))}33;"
						>
							{#if a.iconSvg}
								{@html a.iconSvg}
							{:else}
								<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/></svg>
							{/if}
						</div>
						<div class="as-text">
							<span class="as-title">{a.title}</span>
							{#if a.sub}<span class="as-sub">{a.sub}</span>{/if}
						</div>
					</button>
				{/each}
			</div>

			<!-- Sticky bottom Cancel — Trust Wallet pattern -->
			<div class="as-footer">
				<button type="button" class="as-cancel" onclick={close}>Cancel</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.as-action {
		display: flex; align-items: center; gap: 12px;
		width: 100%; padding: 10px 12px;
		border: none; background: transparent; border-radius: 10px;
		cursor: pointer; text-align: left; font-family: inherit; color: inherit;
		transition: background 0.12s;
	}
	.as-action:hover:not(:disabled) { background: var(--bg-surface); }
	.as-action:disabled { opacity: 0.45; cursor: not-allowed; }
	.as-icon {
		width: 32px; height: 32px;
		border-radius: 9px; border: 1px solid;
		display: flex; align-items: center; justify-content: center;
		flex-shrink: 0;
	}
	.as-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
	.as-title {
		font-family: 'Syne', sans-serif;
		font-size: 13px; font-weight: 700;
		color: var(--text-heading);
	}
	.as-danger .as-title { color: #f87171; }
	.as-sub {
		font-family: 'Space Mono', monospace;
		font-size: 10px; color: var(--text-dim);
		line-height: 1.4;
	}
	.as-footer {
		flex-shrink: 0;
		padding: 12px 16px calc(12px + env(safe-area-inset-bottom));
		border-top: 1px solid var(--border);
		background: var(--bg);
	}
	.as-cancel {
		width: 100%; padding: 12px 16px;
		border-radius: 12px;
		border: 1px solid var(--border-subtle);
		background: transparent; color: var(--text-dim);
		font-family: 'Space Mono', monospace; font-size: 12px;
		cursor: pointer;
		transition: background 0.12s, color 0.12s;
	}
	.as-cancel:hover { background: var(--bg-surface); color: var(--text-heading); }
</style>
