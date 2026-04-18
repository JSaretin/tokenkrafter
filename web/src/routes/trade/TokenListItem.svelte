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
			<div class="w-4 h-4 border-2 border-[rgba(139,92,246,0.2)] border-t-purple rounded-full animate-spin"></div>
		</div>
	{:else}
		<TokenIcon {logo} {symbol} variant={iconVariant} />
	{/if}

	<div class="flex-1 min-w-0">
		<span class="block font-mono text-sm2 font-bold text-(--text-heading)">{primary}</span>
		{#if secondary}
			<span class="block font-mono text-xs2 text-(--text-muted) whitespace-nowrap overflow-hidden text-ellipsis">{secondary}</span>
		{/if}
	</div>

	{#if rightSlot}
		{@render rightSlot()}
	{/if}
</button>
