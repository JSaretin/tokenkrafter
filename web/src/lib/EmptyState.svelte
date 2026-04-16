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

<div class="empty-state">
	{#if icon}
		<div class="empty-icon">{icon}</div>
	{/if}
	{#if title}
		<h3 class="syne text-lg font-bold text-white mb-2">{title}</h3>
	{/if}
	{#if description}
		<p class="text-gray-500 font-mono text-sm max-w-sm mx-auto">{description}</p>
	{/if}
	{#if action}
		<div class="empty-action">
			{@render action()}
		</div>
	{/if}
</div>

<style>
	.empty-state {
		min-height: 300px;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		text-align: center;
		padding: 40px 16px;
	}
	.empty-icon {
		font-size: 48px;
		opacity: 0.2;
		margin-bottom: 16px;
	}
	.empty-action {
		margin-top: 24px;
	}
</style>
