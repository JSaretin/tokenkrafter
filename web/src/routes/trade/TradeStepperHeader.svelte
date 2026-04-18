<script lang="ts">
	let {
		amount,
		symbol,
		fiatEquivalent = '',
	}: {
		amount: string;
		symbol: string;
		fiatEquivalent?: string;
	} = $props();
</script>

<div class="pt-1 pb-3">
	<span class="font-[Rajdhani,sans-serif] text-lg2 font-bold text-(--text-heading) tabular-nums">{amount} {symbol}</span>
	{#if fiatEquivalent}
		<span class="font-mono text-sm text-success font-semibold ml-2">→ {fiatEquivalent}</span>
	{/if}
</div>
