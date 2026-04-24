<script lang="ts">
	import FixedOverlay from '$lib/FixedOverlay.svelte';
	import { ethers } from 'ethers';

	type PaymentOption = {
		address: string;
		symbol: string;
		name: string;
		balanceDisplay?: string;
		quoteDisplay?: string;
		logoUrl?: string | null;
	};

	let {
		show = $bindable(false),
		tokens,
		selectedAddress = '',
		loading = false,
		importBusy = false,
		importError = null,
		onSelect,
		onImport,
		onClose,
	}: {
		show: boolean;
		tokens: PaymentOption[];
		selectedAddress?: string;
		loading?: boolean;
		importBusy?: boolean;
		importError?: string | null;
		onSelect: (token: PaymentOption, index: number) => void;
		onImport: (address: string) => void;
		onClose?: () => void;
	} = $props();

	let importAddr = $state('');

	function handleClose() {
		if (onClose) onClose();
		else show = false;
	}

	function handleImport() {
		const trimmed = importAddr.trim();
		if (!trimmed) return;
		onImport(trimmed);
	}
</script>

<FixedOverlay bind:show onclose={handleClose}>
	<div
		class="w-full max-w-[420px] max-h-[85vh] bg-(--bg) border border-(--border) rounded-[20px] overflow-hidden flex flex-col max-sm:max-w-full max-sm:rounded-t-[20px] max-sm:rounded-b-none max-sm:h-[85vh] max-sm:max-h-[85vh]"
	>
		<div class="flex justify-between items-center py-4 px-5 border-b border-(--border)">
			<h3 class="heading-3">Select payment</h3>
			<button
				class="bg-transparent border-none text-(--text-muted) cursor-pointer p-1 rounded-lg transition-all hover:text-(--text) hover:bg-(--bg-surface-hover)"
				onclick={handleClose}
				aria-label="Close"
			>
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
			</button>
		</div>

		<div class="px-4 py-3">
			<input
				class="input-field"
				placeholder="0x... paste token address to import"
				bind:value={importAddr}
				disabled={importBusy}
				onkeydown={(e) => { if (e.key === 'Enter') handleImport(); }}
			/>
		</div>
		{#if importError}
			<p class="text-xs2 text-red-400 syne px-4 pb-2 m-0">{importError}</p>
		{/if}
		{#if importAddr.trim() && ethers.isAddress(importAddr.trim())}
			<div class="px-4 pb-2.5">
				<button
					class="w-full p-2 rounded-[10px] border border-purple-400/20 bg-purple-400/10 text-purple-300 cursor-pointer syne text-xs2 font-bold transition-all hover:bg-purple-400/20 disabled:opacity-50 disabled:cursor-not-allowed"
					disabled={importBusy}
					onclick={handleImport}
				>
					{importBusy ? 'Resolving...' : 'Import token'}
				</button>
			</div>
		{/if}

		<div class="overflow-y-auto px-2 pb-2 flex-1">
			{#if loading}
				<div class="flex items-center justify-center gap-2 p-4 text-(--text-muted) syne text-xs2">
					<div class="w-4 h-4 border-2 border-(--border) border-t-cyan-400 rounded-full animate-spin"></div>
					<span>Loading quotes...</span>
				</div>
			{/if}
			{#each tokens as opt, i}
				{@const active = selectedAddress.toLowerCase() === opt.address.toLowerCase()}
				<button
					class={"flex items-center gap-2.5 w-full p-2.5 px-3 rounded-xl border bg-transparent cursor-pointer transition-all text-left hover:bg-(--bg-surface-hover) "
						+ (active ? "border-cyan-400/20 bg-cyan-400/[0.03]" : "border-transparent")}
					onclick={() => onSelect(opt, i)}
				>
					{#if opt.logoUrl}
						<img src={opt.logoUrl} alt={opt.symbol} class="w-9 h-9 rounded-full object-cover shrink-0" />
					{:else}
						<div class="w-9 h-9 rounded-full shrink-0 flex items-center justify-center bg-cyan-400/[0.08] text-cyan-400 border border-cyan-400/15 syne text-sm font-bold">
							{opt.symbol.charAt(0)}
						</div>
					{/if}
					<div class="flex-1 min-w-0 flex flex-col">
						<span class="block syne text-xs3 font-bold text-(--text-heading)">{opt.symbol}</span>
						<span class="block syne text-3xs text-(--text-muted) whitespace-nowrap overflow-hidden text-ellipsis">{opt.name}</span>
					</div>
					<div class="text-right shrink-0">
						<span class="block font-['Rajdhani',sans-serif] text-sm font-semibold text-(--text-heading) tabular-nums">{opt.quoteDisplay ?? '—'}</span>
						<span class="block font-['Rajdhani',sans-serif] text-3xs text-(--text-dim) tabular-nums">{opt.balanceDisplay ?? '—'}</span>
					</div>
					{#if active}
						<span class="text-emerald-500 text-sm shrink-0 ml-1">&#10003;</span>
					{/if}
				</button>
			{/each}
		</div>
	</div>
</FixedOverlay>
