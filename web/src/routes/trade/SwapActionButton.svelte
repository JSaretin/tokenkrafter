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
			? "bg-linear-to-br from-success to-success-dark text-white hover:shadow-[0_6px_28px_rgba(16,185,129,0.3)]"
			: variant === 'error'
				? "!bg-[rgba(239,68,68,0.12)] !text-danger-light !shadow-none !transform-none"
				: "bg-linear-to-br from-cyan to-blue text-white hover:shadow-[0_6px_28px_rgba(0,210,255,0.3)]"
	);
</script>

<button
	type="button"
	class={"w-[calc(100%-8px)] mx-1 mt-2 mb-1 py-4 px-0 rounded-2xl border-0 font-[Syne,sans-serif] text-md font-bold tracking-[0.02em] transition-all duration-200 " + variantClass + (disabled ? " opacity-85 cursor-not-allowed" : " cursor-pointer hover:-translate-y-px")}
	{disabled}
	{onclick}
>
	{@render children()}
</button>
