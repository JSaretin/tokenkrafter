<script lang="ts">
	let {
		onclick,
	}: {
		onclick: () => void;
	} = $props();
</script>

<div class="flex justify-center -my-2 relative z-[2]">
	<button
		type="button"
		class="w-[42px] h-[42px] rounded-xl border-[3px] border-(--bg-surface) bg-(--bg-surface-hover) text-(--text-muted) cursor-pointer flex items-center justify-center transition-all duration-200 shadow-[0_2px_8px_rgba(0,0,0,0.15)] hover:text-cyan hover:bg-[rgba(0,210,255,0.1)] hover:rotate-180 hover:shadow-[0_4px_16px_rgba(0,210,255,0.15)]"
		{onclick}
	>
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
			<path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" />
		</svg>
	</button>
</div>
