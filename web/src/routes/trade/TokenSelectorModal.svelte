<script lang="ts">
	import { ethers } from 'ethers';
	import { ZERO_ADDRESS } from '$lib/tokenCrafter';
	import { t } from '$lib/i18n';
	import Modal from '$lib/Modal.svelte';
	import QuickTokenButton from './QuickTokenButton.svelte';
	import TokenListItem from './TokenListItem.svelte';
	import TokenAddressActions from './TokenAddressActions.svelte';

	type TokenItem = {
		address: string;
		symbol: string;
		name: string;
		decimals: number;
		isNative?: boolean;
		logo_url?: string;
	};

	type PastedMeta = {
		address: string;
		symbol: string;
		name: string;
		decimals: number;
		logo_url?: string;
	};

	let {
		builtInTokens = [],
		filteredTokens = [],
		tokenSearch = $bindable(''),
		pastedTokenMeta = null,
		pastedTokenLoading = false,
		dbSearchLoading = false,
		explorerUrl = '',
		onSelect,
		onImport,
		onClose,
		onCopyAddress,
	}: {
		builtInTokens?: TokenItem[];
		filteredTokens?: TokenItem[];
		tokenSearch?: string;
		pastedTokenMeta?: PastedMeta | null;
		pastedTokenLoading?: boolean;
		dbSearchLoading?: boolean;
		explorerUrl?: string;
		onSelect: (token: TokenItem) => void;
		onImport: () => void;
		onClose: () => void;
		onCopyAddress?: (address: string) => void;
	} = $props();

	let trimmedSearch = $derived(tokenSearch.trim());
	let isAddressSearch = $derived(ethers.isAddress(trimmedSearch));
	let shortSearch = $derived(trimmedSearch.slice(0, 6) + '...' + trimmedSearch.slice(-4));
	let showImportRow = $derived(isAddressSearch && !filteredTokens.find(t => t.address.toLowerCase() === trimmedSearch.toLowerCase()));

	let show = $state(true);
	$effect(() => { if (!show) onClose(); });
</script>

<Modal bind:show maxWidth="max-w-[420px]">
	<div class="flex flex-col max-h-[85vh] max-sm:h-full max-sm:max-h-full max-sm:min-h-0">
	<div class="flex justify-between items-center py-4 px-5 border-b border-(--border)">
		<h3 class="font-display text-[16px] font-bold text-(--text-heading) m-0">{$t('trade.selectAToken')}</h3>
		<button aria-label="Close" class="bg-transparent border-0 text-(--text-muted) cursor-pointer p-1 rounded-lg transition-all duration-150 hover:text-(--text) hover:bg-(--bg-surface-hover)" onclick={() => show = false}>
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
		</button>
	</div>

	<input
		class="input-field mx-4 my-3 w-[calc(100%-32px)]"
		placeholder={$t('trade.searchTokens')}
		bind:value={tokenSearch}
	/>

	<div class="flex gap-1.5 px-4 pb-3 flex-wrap">
		{#each builtInTokens as t}
			<QuickTokenButton logo={t.logo_url} symbol={t.symbol} onclick={() => onSelect(t)} />
		{/each}
	</div>

	<div class="overflow-y-auto flex-1 min-h-0 px-2 pb-2">
		{#if showImportRow}
			{#if pastedTokenLoading}
				<TokenListItem
					loading
					disabled
					primary={$t('trade.loading')}
					secondary={shortSearch}
				/>
			{:else if pastedTokenMeta}
				<TokenListItem
					logo={pastedTokenMeta.logo_url}
					symbol={pastedTokenMeta.symbol}
					iconVariant="custom"
					primary={pastedTokenMeta.symbol}
					secondary={pastedTokenMeta.name}
					onclick={onImport}
				>
					{#snippet rightSlot()}
						<span class="font-mono text-[10px] font-bold text-[#a78bfa] bg-[rgba(139,92,246,0.1)] border border-[rgba(139,92,246,0.2)] py-[3px] px-2 rounded-md shrink-0">{$t('trade.import')}</span>
					{/snippet}
				</TokenListItem>
			{:else}
				<TokenListItem
					symbol="?"
					iconVariant="custom"
					primary={$t('trade.importToken')}
					secondary={shortSearch}
					onclick={onImport}
				/>
			{/if}
		{/if}

		{#each filteredTokens as t}
			<TokenListItem
				logo={t.logo_url}
				symbol={t.symbol}
				primary={t.symbol}
				secondary={t.name}
				onclick={() => onSelect(t)}
			>
				{#snippet rightSlot()}
					{#if t.address !== ZERO_ADDRESS}
						<TokenAddressActions address={t.address} {explorerUrl} oncopy={onCopyAddress} />
					{/if}
				{/snippet}
			</TokenListItem>
		{/each}

		{#if dbSearchLoading}
			<div class="flex items-center justify-center py-2.5 px-3 opacity-50">
				<span class="font-mono text-[10px] text-(--text-muted)">{$t('trade.searching')}</span>
			</div>
		{:else if filteredTokens.length === 0 && !isAddressSearch}
			<p class="text-center p-5 text-(--text-muted) font-mono text-xs">{$t('trade.noTokensFound')}</p>
		{/if}
	</div>
	</div>
</Modal>
