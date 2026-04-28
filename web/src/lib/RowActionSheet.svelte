<script lang="ts">
	import { fly, fade } from 'svelte/transition';
	import { toggleHidden, hiddenAssets } from './hiddenAssets';
	import { removeUserToken, userTokens } from './userTokens';
	import { markDeleted } from './deletedTokens';
	import { pushPreferences } from './embeddedWallet';
	import { getKnownLogo } from './tokenLogo';

	let {
		open = $bindable(false),
		token = null as { address: string; symbol: string; name: string; logoUrl?: string } | null,
		chainId = 56,
		walletType = 'embedded' as 'embedded' | 'external',
		onFeedback = (_: { message: string; type: string }) => {},
	}: {
		open: boolean;
		token: { address: string; symbol: string; name: string; logoUrl?: string } | null;
		chainId: number;
		walletType?: 'embedded' | 'external';
		onFeedback?: (f: { message: string; type: string }) => void;
	} = $props();

	// Delete is only meaningful for user-imported tokens. Pinned stables and
	// auto-detected holdings have no row in userTokens — for those, only the
	// Hide action makes sense.
	let canDelete = $derived.by(() => {
		if (!token) return false;
		const lower = token.address.toLowerCase();
		return $userTokens.some((t) => t.chainId === chainId && t.address === lower);
	});

	let isHidden = $derived.by(() => {
		if (!token) return false;
		return $hiddenAssets.includes(token.address.toLowerCase());
	});

	function close() {
		open = false;
	}

	function doHide() {
		if (!token) return;
		toggleHidden(token.address);
		if (walletType === 'embedded') pushPreferences().catch(() => {});
		onFeedback({ message: isHidden ? `${token.symbol} unhidden` : `${token.symbol} hidden`, type: 'success' });
		open = false;
	}

	function doDelete() {
		if (!token) return;
		removeUserToken(token.address, chainId);
		// Tombstone — blocks the auto-import paths (poller discovery,
		// created-tokens fetch, stablecoin auto-pin) from re-adding it.
		// The import modal clears the tombstone on re-import.
		markDeleted(token.address);
		// If it was hidden, also remove from hiddenAssets so a re-import shows up.
		if ($hiddenAssets.includes(token.address.toLowerCase())) toggleHidden(token.address);
		if (walletType === 'embedded') pushPreferences().catch(() => {});
		onFeedback({ message: `${token.symbol} deleted`, type: 'success' });
		open = false;
	}
</script>

<svelte:window onkeydown={(e) => { if (open && e.key === 'Escape') close(); }} />

{#if open && token}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-[10002] bg-black/65 backdrop-blur-[3px] flex items-center justify-center p-4 max-[639px]:items-end max-[639px]:p-0"
		onclick={close}
		role="dialog"
		aria-modal="true"
		tabindex="-1"
		transition:fade={{ duration: 120 }}
	>
		<div
			class="w-full max-w-[380px] max-h-[80vh] bg-(--bg) border border-(--border) rounded-2xl overflow-hidden flex flex-col max-[639px]:max-w-full max-[639px]:rounded-t-2xl max-[639px]:rounded-b-none max-[639px]:h-[80vh] max-[639px]:max-h-[80vh]"
			onclick={(e) => e.stopPropagation()}
			transition:fly={{ y: 24, duration: 200 }}
		>
			<!-- Token header -->
			<div class="flex items-center gap-3 px-4 py-3.5 border-b border-(--border)">
				{#if token.logoUrl || getKnownLogo(token.symbol)}
					<img src={token.logoUrl || getKnownLogo(token.symbol)} alt={token.symbol} class="w-10 h-10 rounded-full object-cover shrink-0 border border-(--border)" />
				{:else}
					<div class="w-10 h-10 rounded-full bg-(--bg-surface-input) border border-(--border) flex items-center justify-center font-display text-sm font-extrabold text-(--text-muted) shrink-0">{token.symbol.charAt(0)}</div>
				{/if}
				<div class="flex-1 min-w-0">
					<span class="block font-display text-base font-bold text-(--text-heading) leading-[1.3]">{token.symbol}</span>
					<span class="block font-mono text-3xs text-(--text-dim) mt-0.5 truncate">{token.name}</span>
				</div>
			</div>

			<!-- Actions -->
			<div class="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
				<button type="button" class="ras-action" onclick={doHide}>
					<div class="ras-icon" style="color: #f59e0b; background: rgba(245,158,11,0.08); border-color: rgba(245,158,11,0.2);">
						{#if isHidden}
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
						{:else}
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
						{/if}
					</div>
					<div class="ras-text">
						<span class="ras-title">{isHidden ? 'Unhide' : 'Hide'}</span>
						<span class="ras-sub">{isHidden ? 'Show this token in the assets list' : 'Move to hidden tokens — you can unhide anytime'}</span>
					</div>
				</button>

				{#if canDelete}
					<button type="button" class="ras-action ras-action-danger" onclick={doDelete}>
						<div class="ras-icon" style="color: #f87171; background: rgba(248,113,113,0.08); border-color: rgba(248,113,113,0.2);">
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>
						</div>
						<div class="ras-text">
							<span class="ras-title">Delete</span>
							<span class="ras-sub">Remove from imported tokens</span>
						</div>
					</button>
				{/if}
			</div>

			<!-- Sticky bottom Cancel — Trust Wallet pattern. Always reachable
			     even when the action list scrolls; safe-area-inset-bottom keeps
			     it clear of the home-indicator bar on iOS. -->
			<div class="ras-footer">
				<button type="button" class="ras-cancel" onclick={close}>Cancel</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.ras-action {
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
	.ras-action:hover { background: var(--bg-surface); }
	.ras-icon {
		width: 32px; height: 32px;
		border-radius: 9px;
		border: 1px solid;
		display: flex; align-items: center; justify-content: center;
		flex-shrink: 0;
	}
	.ras-text {
		flex: 1; min-width: 0;
		display: flex; flex-direction: column; gap: 1px;
	}
	.ras-title {
		font-family: 'Syne', sans-serif;
		font-size: 13px; font-weight: 700;
		color: var(--text-heading);
	}
	.ras-action-danger .ras-title { color: #f87171; }
	.ras-sub {
		font-family: 'Space Mono', monospace;
		font-size: 10px; color: var(--text-dim);
		line-height: 1.4;
	}
	.ras-footer {
		flex-shrink: 0;
		padding: 12px 16px calc(12px + env(safe-area-inset-bottom));
		border-top: 1px solid var(--border);
		background: var(--bg);
	}
	.ras-cancel {
		width: 100%;
		padding: 12px 16px;
		border-radius: 12px;
		border: 1px solid var(--border-subtle);
		background: transparent;
		color: var(--text-dim);
		font-family: 'Space Mono', monospace;
		font-size: 12px;
		cursor: pointer;
		transition: background 0.12s, color 0.12s;
	}
	.ras-cancel:hover { background: var(--bg-surface); color: var(--text-heading); }
</style>
