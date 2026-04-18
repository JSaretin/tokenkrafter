<script lang="ts">
	let { text = '' }: { text?: string } = $props();
</script>

<div class="flex flex-col items-center justify-center gap-3 px-4 py-10">
	<div class="spinner w-10 h-10 rounded-full border-2 border-white/10 border-t-cyan-400"></div>
	{#if text}
		<span class="text-gray-500 text-sm font-mono">{text}</span>
	{/if}
</div>
