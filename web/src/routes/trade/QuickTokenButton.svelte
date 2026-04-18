<script lang="ts">
	let {
		logo,
		symbol,
		onclick,
	}: {
		logo?: string;
		symbol: string;
		onclick: () => void;
	} = $props();
</script>

<button
	type="button"
	class="inline-flex items-center gap-[5px] py-1.5 px-3.5 rounded-[20px] border border-(--border) bg-(--bg-surface) text-(--text) cursor-pointer font-mono text-xs font-bold transition-all duration-150 hover:border-[rgba(0,210,255,0.3)] hover:text-[#00d2ff] hover:bg-[rgba(0,210,255,0.05)]"
	{onclick}
>
	{#if logo}<img src={logo} alt="" class="w-4 h-4 rounded-full object-cover align-[-2px]" />{/if}
	{symbol}
</button>
