<script lang="ts">
	let { text = '' }: { text?: string } = $props();
</script>

<div class="loading-spinner-wrap">
	<div class="spinner w-10 h-10 rounded-full border-2 border-white/10 border-t-cyan-400"></div>
	{#if text}
		<span class="text-gray-500 text-sm font-mono">{text}</span>
	{/if}
</div>

<style>
	.loading-spinner-wrap {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 12px;
		padding: 40px 16px;
	}
</style>
