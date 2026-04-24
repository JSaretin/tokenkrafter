<script lang="ts">
	import { t } from '$lib/i18n';
	import TradeStepIndicator from './TradeStepIndicator.svelte';

	export type StepDef = {
		n: number;
		title: string;
		desc: string;
		activeDesc: string;
	};

	let {
		steps,
		currentStep,
	}: {
		steps: StepDef[];
		currentStep: number;
	} = $props();

	function stateFor(n: number): 'pending' | 'active' | 'done' {
		if (currentStep > n) return 'done';
		if (currentStep === n) return 'active';
		return 'pending';
	}

	function borderCls(state: 'pending' | 'active' | 'done'): string {
		if (state === 'done') return 'border-l-[#10b981]';
		if (state === 'active') return 'border-l-[#00d2ff] bg-[rgba(0,210,255,0.03)]';
		return 'border-l-(--border)';
	}

	function titleCls(state: 'pending' | 'active' | 'done'): string {
		if (state === 'pending') return 'text-(--text-dim)';
		if (state === 'done') return 'text-[#10b981]';
		if (state === 'active') return 'text-[#00d2ff]';
		return 'text-(--text-heading)';
	}
</script>

<div class="flex flex-col mt-1 mb-3">
	{#each steps as step}
		{@const state = stateFor(step.n)}
		<div class={"flex items-center gap-3 py-3 px-3.5 border-l-2 relative transition-all duration-300 " + borderCls(state)}>
			<TradeStepIndicator {state} number={step.n} />
			<div class="flex-1 min-w-0">
				<span class={"block font-mono text-xs font-bold " + titleCls(state)}>{step.title}</span>
				<span class={"block font-mono text-3xs mt-px " + (state === 'active' ? 'text-[rgba(0,210,255,0.7)]' : 'text-(--text-muted)')}>
					{state === 'active' ? step.activeDesc : step.desc}
				</span>
			</div>
			{#if state === 'done'}
				<span class="font-mono text-3xs font-bold text-[#10b981] shrink-0">{$t('trade.done')}</span>
			{/if}
		</div>
	{/each}
</div>
