<script lang="ts">
	type StepStatus = 'done' | 'active' | 'pending' | 'error' | 'skipped';
	type Step = {
		label: string;
		status: StepStatus;
	};

	let {
		steps,
		title = 'Deploying your token',
		subtitle = 'Please wait — do not close this window',
		txHash = null,
		txHref = null,
	}: {
		steps: Step[];
		title?: string;
		subtitle?: string;
		txHash?: string | null;
		txHref?: string | null;
	} = $props();
</script>

<div class="py-2">
	<div class="text-center mb-5">
		<h2 class="heading-2">{title}</h2>
		<p class="text-xs2 text-(--text-dim) syne mt-1 mb-0">{subtitle}</p>
	</div>

	<div class="flex flex-col gap-0 px-2">
		{#each steps as s, i}
			{@const status = s.status}
			{@const isDone = status === 'done' || status === 'skipped'}
			{@const isActive = status === 'active'}
			{@const isError = status === 'error'}
			<div class="flex items-center gap-3 py-2.5">
				<div
					class={"w-7 h-7 rounded-full shrink-0 flex items-center justify-center border-2 transition-all duration-300 "
						+ (isDone ? "border-emerald-500 text-emerald-500 bg-emerald-500/10 "
						: isActive ? "border-cyan-400 bg-cyan-400/10 "
						: isError ? "border-red-500 text-red-500 bg-red-500/10 "
						: "border-(--border) bg-transparent ")}
				>
					{#if isDone}
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
					{:else if isActive}
						<div class="w-3.5 h-3.5 rounded-full border-2 border-cyan-400/20 border-t-cyan-400 animate-spin"></div>
					{:else if isError}
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
					{:else}
						<span class="font-mono text-3xs text-(--text-dim)">{i + 1}</span>
					{/if}
				</div>
				<div class="flex-1 flex items-baseline gap-1.5">
					<span
						class={"syne text-xs2 font-semibold "
							+ (status === 'done' ? "text-emerald-500 "
							: status === 'active' ? "text-cyan-400 "
							: status === 'error' ? "text-red-500 "
							: status === 'skipped' ? "text-(--text-dim) "
							: "text-(--text-dim) ")}
					>{s.label}</span>
					{#if status === 'skipped'}
						<span class="text-4xs text-(--text-dim) syne uppercase tracking-[0.06em]">Skipped</span>
					{/if}
				</div>
			</div>
			{#if i < steps.length - 1}
				<div
					class={"w-0.5 h-4 ml-3.25 transition-colors duration-300 "
						+ (isDone ? "bg-emerald-500" : "bg-(--bg-surface-input)")}
				></div>
			{/if}
		{/each}
	</div>

	{#if txHash && txHref}
		<a
			href={txHref}
			target="_blank"
			rel="noopener"
			class="block text-center mt-4 p-2 text-xs2 text-cyan-400 font-mono no-underline transition-opacity duration-150 hover:opacity-70"
		>
			View transaction →
		</a>
	{/if}
</div>
