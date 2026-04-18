<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		variant = 'cyan',
		dot = false,
		children,
	}: {
		variant?: 'cyan' | 'warning' | 'success';
		dot?: boolean;
		children: Snippet;
	} = $props();

	const variantCls: Record<string, string> = {
		cyan: 'text-cyan bg-cyan-400/[0.06] border-cyan-400/10',
		warning: 'text-warning bg-warning/[0.06] border-warning/10',
		success: 'text-success bg-success/[0.06] border-success/10',
	};
</script>

<div class={"flex items-center gap-1.5 font-mono text-xs2 font-semibold py-1.5 px-2.5 rounded-lg border " + variantCls[variant]}>
	{#if dot}
		<span class="signal-pulse w-1.5 h-1.5 rounded-full bg-cyan shadow-[0_0_6px_rgba(0,210,255,0.5)]"></span>
	{/if}
	{@render children()}
</div>
