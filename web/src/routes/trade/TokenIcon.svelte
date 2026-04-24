<script lang="ts">
	let {
		logo,
		symbol = '?',
		size = 36,
		variant = 'brand',
	}: {
		logo?: string;
		symbol?: string;
		size?: number;
		variant?: 'brand' | 'custom';
	} = $props();

	let fallbackClass = $derived(
		variant === 'custom'
			? 'bg-[rgba(139,92,246,0.1)] text-[#a78bfa] border border-[rgba(139,92,246,0.2)]'
			: 'bg-[rgba(0,210,255,0.08)] text-[#00d2ff] border border-[rgba(0,210,255,0.15)]'
	);
</script>

{#if logo}
	<img src={logo} alt="" class="rounded-full object-cover shrink-0" style="width: {size}px; height: {size}px;" />
{:else}
	<div
		class={"flex items-center justify-center rounded-full shrink-0 font-display text-sm font-bold " + fallbackClass}
		style="width: {size}px; height: {size}px;"
	>
		{symbol.charAt(0)}
	</div>
{/if}
