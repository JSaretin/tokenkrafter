<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		variant = 'primary',
		disabled = false,
		onclick,
		children,
	}: {
		variant?: 'primary' | 'bank' | 'error';
		disabled?: boolean;
		onclick: () => void;
		children: Snippet;
	} = $props();

	let variantClass = $derived(
		variant === 'bank'
			? "bg-[linear-gradient(135deg,#10b981,#059669)] text-white hover:shadow-[0_6px_28px_rgba(16,185,129,0.3)]"
			: variant === 'error'
				? "!bg-[rgba(239,68,68,0.12)] !text-[#f87171] !shadow-none !transform-none"
				: "bg-[linear-gradient(135deg,#00d2ff,#3a7bd5)] text-white hover:shadow-[0_6px_28px_rgba(0,210,255,0.3)]"
	);
</script>

<button
	type="button"
	class={"w-[calc(100%-8px)] mx-1 mt-2 mb-1 py-4 px-0 rounded-2xl border-0 font-display text-15 font-bold tracking-[0.02em] transition-all duration-200 " + variantClass + (disabled ? " opacity-85 cursor-not-allowed" : " cursor-pointer hover:-translate-y-px")}
	{disabled}
	{onclick}
>
	{@render children()}
</button>
