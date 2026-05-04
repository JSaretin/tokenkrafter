<script lang="ts">
	/**
	 * Wrapper around the shared $lib/TokenSelectorModal. Preserves the
	 * create-wizard's existing API (PaymentOption[] in, onSelect/onImport
	 * out) so callers don't need to change, but renders inside the same
	 * picker the trade page uses — search merges curated payment options
	 * with the chain's CoinGecko-known token list, infinite scroll, IDB-
	 * cached logos, paste-to-import.
	 */
	import { ethers } from 'ethers';
	import TokenSelectorModal from '$lib/TokenSelectorModal.svelte';
	import { getChainTokens, preloadChainTokens } from '$lib/chainTokensStore.svelte';

	type PaymentOption = {
		address: string;
		symbol: string;
		name: string;
		decimals?: number;
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
		chainSlug = 'bsc',
		chainId = 56,
		explorerUrl = '',
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
		chainSlug?: string;
		chainId?: number;
		explorerUrl?: string;
		onSelect: (token: PaymentOption, index: number) => void;
		onImport: (address: string) => void;
		onClose?: () => void;
	} = $props();

	// Warm the CG token list for this chain so the modal's search merges
	// across both the curated payment options and the full CG inventory.
	$effect(() => { if (show && chainSlug) preloadChainTokens(chainSlug); });
	let chainTokens = $derived(show ? getChainTokens(chainSlug) : []);

	let tokenSearch = $state('');

	// Reset the search every time the modal opens so the user lands on a
	// fresh state instead of whatever they typed last time.
	$effect(() => { if (show) tokenSearch = ''; });

	type TokenItem = {
		address: string;
		symbol: string;
		name: string;
		decimals: number;
		isNative?: boolean;
		logo_url?: string;
	};

	// Curated tokens always lead the list (so balances + quotes show
	// first); CG tokens fill the rest. Both are filtered by the search
	// query when present.
	let filteredTokens = $derived.by(() => {
		const q = tokenSearch.toLowerCase().trim();
		const seen = new Set<string>();
		const out: TokenItem[] = [];
		for (const opt of tokens) {
			if (q && !(
				opt.symbol.toLowerCase().includes(q) ||
				opt.name.toLowerCase().includes(q) ||
				opt.address.toLowerCase().includes(q)
			)) continue;
			out.push({
				address: opt.address,
				symbol: opt.symbol,
				name: opt.name,
				decimals: opt.decimals ?? 18,
				logo_url: opt.logoUrl ?? '',
			});
			seen.add(opt.address.toLowerCase());
		}
		for (const r of chainTokens) {
			const aLow = r.address.toLowerCase();
			if (seen.has(aLow)) continue;
			if (q && !(
				r.symbol.toLowerCase().includes(q) ||
				r.name.toLowerCase().includes(q) ||
				aLow.includes(q)
			)) continue;
			out.push({
				address: r.address,
				symbol: r.symbol,
				name: r.name,
				decimals: r.decimals,
				logo_url: r.logo,
			});
			seen.add(aLow);
		}
		return out;
	});

	// Map a row click to the right callback: known curated payment →
	// onSelect with index; CG token not in the curated list → onImport
	// (the wizard's import flow resolves the on-chain decimals + adds
	// the row to paymentOptions, which then triggers a fresh balance
	// + fee-quote computation).
	function handleSelect(t: TokenItem) {
		const idx = tokens.findIndex((p) => p.address.toLowerCase() === t.address.toLowerCase());
		if (idx >= 0) onSelect(tokens[idx], idx);
		else onImport(t.address);
	}

	// Paste-to-import: when the user types a fresh address in the search
	// field, the modal renders an "Import" row at the top; clicking it
	// fires onImport with the address. The wizard's flow does the on-
	// chain ERC20 read + balance fetch.
	let pastedTokenMeta = $derived.by(() => {
		const q = tokenSearch.trim();
		if (!q || !ethers.isAddress(q)) return null;
		// Skip if the address is already in the merged list — the row
		// renders normally then, no import needed.
		const aLow = q.toLowerCase();
		if (filteredTokens.some((t) => t.address.toLowerCase() === aLow)) return null;
		// Minimal stub so the modal renders the import row; symbol/name
		// will populate after the wizard's import resolver runs.
		return { address: q, symbol: '...', name: importBusy ? 'Importing…' : 'New payment token', decimals: 18, logo_url: '' };
	});
</script>

{#if show}
<TokenSelectorModal
	bind:tokenSearch
	builtInTokens={[]}
	{filteredTokens}
	{pastedTokenMeta}
	pastedTokenLoading={importBusy}
	dbSearchLoading={loading}
	{explorerUrl}
	{chainId}
	title="Select payment"
	onSelect={handleSelect}
	onImport={() => onImport(tokenSearch.trim())}
	onClose={() => { show = false; onClose?.(); }}
>
	{#snippet rowRightSlot(t)}
		{@const opt = tokens.find((p) => p.address.toLowerCase() === t.address.toLowerCase())}
		{#if opt}
			<div class="text-right shrink-0 flex flex-col items-end">
				<span class="font-mono text-3xs font-semibold text-(--text-heading) tabular-nums leading-tight">{opt.quoteDisplay ?? '—'}</span>
				<span class="font-mono text-4xs text-(--text-dim) tabular-nums leading-tight">{opt.balanceDisplay ?? '—'}</span>
			</div>
			{#if selectedAddress.toLowerCase() === opt.address.toLowerCase()}
				<span class="text-emerald-500 text-sm shrink-0 ml-1">&#10003;</span>
			{/if}
		{/if}
	{/snippet}
</TokenSelectorModal>
{/if}

{#if importError}
	<!-- Surfaced via a toast / inline message in the wizard flow; the
	     modal itself stays clean. -->
{/if}
