<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		id,
		selected = $bindable(),
		activeColor = 'cyan',
		children,
	}: {
		id: string;
		selected: string;
		activeColor?: 'cyan' | 'emerald';
		children: Snippet;
	} = $props();

	let active = $derived(selected === id);

	let activeClass = $derived(
		activeColor === 'emerald'
			? 'bg-[rgba(16,185,129,0.1)] text-success'
			: 'bg-[rgba(0,210,255,0.1)] text-cyan'
	);
</script>

<button
	type="button"
	class={"flex-1 flex items-center justify-center gap-1.5 py-2.5 px-0 rounded-[10px] border-0 font-mono text-xs font-semibold cursor-pointer transition-all duration-150 " + (active ? activeClass : "bg-transparent text-(--text-muted) hover:text-(--text)")}
	onclick={() => selected = id}
>
	{@render children()}
</button>
