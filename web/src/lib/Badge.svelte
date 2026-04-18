<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		variant = 'cyan',
		size = 'sm',
		children,
	}: {
		variant?: 'cyan' | 'emerald' | 'amber' | 'purple' | 'red' | 'blue';
		size?: 'sm' | 'md';
		children: Snippet;
	} = $props();

	let sizeClass = $derived(size === 'md' ? 'text-xs3 py-[3px] px-2.5' : 'text-xxs py-0.5 px-2');
</script>

<span class={"badge badge-" + variant + " " + sizeClass}>{@render children()}</span>
