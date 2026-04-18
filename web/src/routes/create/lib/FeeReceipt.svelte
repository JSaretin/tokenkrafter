<script lang="ts">
	type FeeRow = {
		label: string;
		amount: string;
		note?: boolean;
	};

	let {
		fees,
		total,
		totalLabel = 'You pay now',
		hint = null,
		warnings = [],
	}: {
		fees: FeeRow[];
		total: string;
		totalLabel?: string;
		hint?: string | null;
		warnings?: string[];
	} = $props();
</script>

<div class="bg-cyan-400/[0.03] rounded-[10px] p-3.5 border border-cyan-400/10">
	<div class="flex flex-col gap-0">
		{#each fees as row}
			<div class="flex justify-between items-center py-1.5 font-mono text-xs2">
				<span class="text-(--text-dim)">{row.label}</span>
				<span
					class={"text-right tabular-nums "
						+ (row.note
							? "text-(--text-dim) font-normal text-3xs font-mono"
							: "text-(--text) font-semibold font-['Rajdhani',sans-serif] text-[13px]")}
				>{row.amount}</span>
			</div>
		{/each}

		<div class="h-px bg-(--bg-surface-hover) my-1.5"></div>

		<div class="flex justify-between items-center py-1.5 font-mono text-xs2">
			<span class="text-(--text-heading) font-bold">{totalLabel}</span>
			<span class="text-cyan-400 text-[15px] font-bold font-['Rajdhani',sans-serif] tabular-nums text-right">{total}</span>
		</div>
	</div>

	{#if hint}
		<p class="text-4xs text-(--text-dim) font-mono mt-1.5 opacity-70">{hint}</p>
	{/if}

	{#if warnings.length > 0}
		<div class="mt-2 flex flex-col gap-1.5">
			{#each warnings as w}
				<div class="p-3 rounded-[10px] bg-amber-400/[0.08] border border-amber-400/[0.35] text-amber-200 text-sm leading-normal">
					{w}
				</div>
			{/each}
		</div>
	{/if}
</div>
