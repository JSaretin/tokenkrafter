<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		icon = '',
		title = '',
		description = '',
		action
	}: {
		icon?: string;
		title?: string;
		description?: string;
		action?: Snippet;
	} = $props();
</script>

<div class="min-h-[300px] flex flex-col items-center justify-center text-center px-4 py-10">
	{#if icon}
		<div class="text-[48px] opacity-20 mb-4">{icon}</div>
	{/if}
	{#if title}
		<h3 class="font-display text-lg font-bold text-white mb-2">{title}</h3>
	{/if}
	{#if description}
		<p class="text-gray-500 font-mono text-sm max-w-sm mx-auto">{description}</p>
	{/if}
	{#if action}
		<div class="mt-6">
			{@render action()}
		</div>
	{/if}
</div>
