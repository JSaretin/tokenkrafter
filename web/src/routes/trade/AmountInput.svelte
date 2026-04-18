<script lang="ts">
	let {
		value = $bindable(''),
		readonly = false,
		loading = false,
		placeholder = '0.00',
	}: {
		value?: string;
		readonly?: boolean;
		loading?: boolean;
		placeholder?: string;
	} = $props();
</script>

<input
	type="text"
	inputmode="decimal"
	class={"flex-1 bg-transparent border-0 font-[Rajdhani,sans-serif] text-[30px] font-bold p-0 min-w-0 tabular-nums placeholder:text-(--text-muted) placeholder:opacity-60 max-[480px]:text-2xl2 focus:outline-none focus:ring-0 focus-visible:outline-none " + (readonly ? "text-(--text-muted)" : "text-(--text-heading)")}
	{placeholder}
	value={readonly && loading ? '' : value}
	{readonly}
	oninput={(e) => { if (!readonly) value = e.currentTarget.value; }}
/>
{#if loading}
	<div class="absolute left-0 top-1/2 -translate-y-1/2 w-30 h-7 rounded-md bg-[linear-gradient(90deg,var(--bg-surface-hover),rgba(0,210,255,0.05),var(--bg-surface-hover))] bg-[length:200%_100%] animate-shimmer"></div>
{/if}
