<script lang="ts">
	import type { Snippet } from 'svelte';
	import TokenIcon from './TokenIcon.svelte';

	let {
		logo,
		symbol = '',
		primary,
		secondary,
		iconVariant = 'brand',
		loading = false,
		disabled = false,
		// Marks tokens that were created on TokenKrafter — gives them a
		// small inline badge in the picker so users know which tokens
		// are platform-native (have detail page, are vetted) vs CG-pulled
		// or pasted-by-address.
		isPlatform = false,
		// Forwarded to TokenIcon so it can lazy-resolve missing logos
		// via GeckoTerminal (same pattern the activity bot uses).
		address = '',
		chainId = 56,
		onclick,
		rightSlot,
	}: {
		logo?: string;
		symbol?: string;
		primary: string;
		secondary?: string;
		iconVariant?: 'brand' | 'custom';
		loading?: boolean;
		disabled?: boolean;
		isPlatform?: boolean;
		address?: string;
		chainId?: number;
		onclick?: () => void;
		rightSlot?: Snippet;
	} = $props();
</script>

<button
	type="button"
	class={"flex items-center gap-2.5 w-full py-2.5 px-3 rounded-xl border-0 bg-transparent text-left transition-all duration-150 " + (disabled ? "opacity-60 cursor-default" : "cursor-pointer hover:bg-(--bg-surface-hover)")}
	{onclick}
	{disabled}
>
	{#if loading}
		<div class="flex items-center justify-center w-9 h-9 rounded-full shrink-0 bg-[rgba(139,92,246,0.1)] border border-[rgba(139,92,246,0.2)]">
			<div class="w-4 h-4 border-2 border-[rgba(139,92,246,0.2)] border-t-[#a78bfa] rounded-full animate-spin"></div>
		</div>
	{:else}
		<TokenIcon {logo} {symbol} {address} {chainId} variant={iconVariant} />
	{/if}

	<div class="flex-1 min-w-0">
		<div class="flex items-center gap-1.5">
			<span class="font-mono text-13 font-bold text-(--text-heading)">{primary}</span>
			{#if isPlatform}
				<span class="font-mono text-4xs font-bold uppercase tracking-[0.05em] py-0.5 px-1.5 rounded bg-cyan-400/10 text-cyan-400 border border-cyan-400/20" title="Created on TokenKrafter">TK</span>
			{/if}
		</div>
		{#if secondary}
			<span class="block font-mono text-3xs text-(--text-muted) whitespace-nowrap overflow-hidden text-ellipsis">{secondary}</span>
		{/if}
	</div>

	{#if rightSlot}
		{@render rightSlot()}
	{/if}
</button>
