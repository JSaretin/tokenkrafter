<script lang="ts">
	import { t } from '$lib/i18n';

	type IntentMode = 'token' | 'both' | 'list' | 'launch';

	let {
		onSelect,
	}: {
		onSelect: (mode: IntentMode) => void;
	} = $props();
</script>

<div class="text-center mb-7">
	<h1 class="syne text-2xl sm:text-3xl font-extrabold text-(--text-heading) m-0">What do you want to build?</h1>
	<p class="text-xs3 text-(--text-muted) font-['Rajdhani',sans-serif] mt-1 mb-0">Every option is non-custodial and on-chain</p>
</div>

<div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5 max-w-[720px] mx-auto">
	<!-- Featured: Create + Launch -->
	<button
		class="sel-card sel-featured col-span-full relative rounded-[14px] overflow-hidden bg-(--bg-surface) border border-cyan-400/15 cursor-pointer transition-all duration-200 text-left font-inherit text-inherit hover:border-cyan-400/40 hover:-translate-y-0.5 hover:shadow-[0_0_40px_rgba(0,210,255,0.08),0_8px_30px_rgba(0,0,0,0.2)]"
		onclick={() => onSelect('both')}
	>
		<div
			class="absolute inset-0 z-0 pointer-events-none"
			style="background: radial-gradient(ellipse at 30% 50%, rgba(0,210,255,0.06), transparent 60%);"
		></div>
		<div class="relative z-10 p-[18px] flex flex-row items-start gap-4 flex-wrap h-full">
			<div class="w-[42px] h-[42px] rounded-xl shrink-0 flex items-center justify-center bg-cyan-400/10 text-cyan-400 border border-cyan-400/15">
				<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
			</div>
			<div class="flex-1 min-w-[200px]">
				<div class="flex items-start justify-between gap-2">
					<h3 class="syne text-lg font-bold text-(--text-heading) m-0">Create & Launch</h3>
					<span class="shrink-0 inline-flex items-center gap-1 text-4xs font-bold uppercase tracking-[0.06em] py-1 px-2.5 rounded-md bg-cyan-400/15 text-cyan-400 font-['Rajdhani',sans-serif] border border-cyan-400/25">
						<svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
						Recommended
					</span>
				</div>
				<p class="text-xs2 text-(--text-muted) font-['Rajdhani',sans-serif] leading-[1.4] m-0 mt-1">Deploy your token with a bonding curve fundraise. Price rises with demand. Graduates to DEX with liquidity burned automatically.</p>
				<div class="flex gap-1.5 flex-wrap mt-1">
					<span class="text-4xs py-0.5 px-2 rounded-full bg-cyan-400/[0.08] border border-cyan-400/20 text-cyan-400 font-['Rajdhani',sans-serif] font-semibold">Bonding curve</span>
					<span class="text-4xs py-0.5 px-2 rounded-full bg-cyan-400/[0.08] border border-cyan-400/20 text-cyan-400 font-['Rajdhani',sans-serif] font-semibold">Auto DEX listing</span>
					<span class="text-4xs py-0.5 px-2 rounded-full bg-cyan-400/[0.08] border border-cyan-400/20 text-cyan-400 font-['Rajdhani',sans-serif] font-semibold">Anti-whale</span>
					<span class="text-4xs py-0.5 px-2 rounded-full bg-cyan-400/[0.08] border border-cyan-400/20 text-cyan-400 font-['Rajdhani',sans-serif] font-semibold">Refundable</span>
				</div>
			</div>
			<span class="inline-flex items-center gap-1 mt-auto pt-2.5 font-['Rajdhani',sans-serif] text-xs3 font-bold text-cyan-400">
				Get Started
				<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
			</span>
		</div>
	</button>

	<!-- Create + List on DEX -->
	<button
		class="group sel-card relative rounded-[14px] overflow-hidden bg-(--bg-surface) border border-(--border-subtle) cursor-pointer transition-all duration-200 text-left font-inherit text-inherit hover:border-cyan-400/20 hover:-translate-y-0.5 hover:shadow-[0_8px_30px_rgba(0,0,0,0.2)]"
		onclick={() => onSelect('list')}
	>
		<div class="relative z-10 p-[18px] flex flex-col gap-2 h-full">
			<div class="w-[42px] h-[42px] rounded-xl shrink-0 flex items-center justify-center bg-amber-400/10 text-amber-500 border border-amber-400/15">
				<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
			</div>
			<div class="flex-1 min-w-0">
				<h3 class="syne text-[15px] font-bold text-(--text-heading) m-0">Create & List on DEX</h3>
				<p class="text-xs2 text-(--text-muted) font-['Rajdhani',sans-serif] leading-[1.4] m-0">Deploy token and add liquidity to PancakeSwap in one transaction. You set the initial price.</p>
				<div class="flex gap-1.5 flex-wrap mt-1">
					<span class="text-4xs py-0.5 px-2 rounded-full bg-(--bg-surface-hover) border border-(--border) text-(--text-muted) font-['Rajdhani',sans-serif] font-semibold">Instant trading</span>
					<span class="text-4xs py-0.5 px-2 rounded-full bg-(--bg-surface-hover) border border-(--border) text-(--text-muted) font-['Rajdhani',sans-serif] font-semibold">Set your price</span>
					<span class="text-4xs py-0.5 px-2 rounded-full bg-(--bg-surface-hover) border border-(--border) text-(--text-muted) font-['Rajdhani',sans-serif] font-semibold">LP burned</span>
				</div>
			</div>
			<span class="inline-flex items-center gap-1 mt-auto pt-2.5 font-['Rajdhani',sans-serif] text-xs2 font-bold text-(--text-dim) transition-colors duration-150 group-hover:text-[#00d2ff]">
				Continue
				<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
			</span>
		</div>
	</button>

	<!-- Create Token Only -->
	<button
		class="group sel-card relative rounded-[14px] overflow-hidden bg-(--bg-surface) border border-(--border-subtle) cursor-pointer transition-all duration-200 text-left font-inherit text-inherit hover:border-cyan-400/20 hover:-translate-y-0.5 hover:shadow-[0_8px_30px_rgba(0,0,0,0.2)]"
		onclick={() => onSelect('token')}
	>
		<div class="relative z-10 p-[18px] flex flex-col gap-2 h-full">
			<div class="w-[42px] h-[42px] rounded-xl shrink-0 flex items-center justify-center bg-purple-400/10 text-purple-300 border border-purple-400/15">
				<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v12M6 12h12"/></svg>
			</div>
			<div class="flex-1 min-w-0">
				<h3 class="syne text-[15px] font-bold text-(--text-heading) m-0">Deploy Token Only</h3>
				<p class="text-xs2 text-(--text-muted) font-['Rajdhani',sans-serif] leading-[1.4] m-0">Just the token contract. Add liquidity, launch, or integrate later on your terms.</p>
				<div class="flex gap-1.5 flex-wrap mt-1">
					<span class="text-4xs py-0.5 px-2 rounded-full bg-(--bg-surface-hover) border border-(--border) text-(--text-muted) font-['Rajdhani',sans-serif] font-semibold">Just the token</span>
					<span class="text-4xs py-0.5 px-2 rounded-full bg-(--bg-surface-hover) border border-(--border) text-(--text-muted) font-['Rajdhani',sans-serif] font-semibold">Add features later</span>
				</div>
			</div>
			<span class="inline-flex items-center gap-1 mt-auto pt-2.5 font-['Rajdhani',sans-serif] text-xs2 font-bold text-(--text-dim) transition-colors duration-150 group-hover:text-[#00d2ff]">
				Continue
				<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
			</span>
		</div>
	</button>

	<!-- Launch Existing Token -->
	<button
		class="group sel-card relative rounded-[14px] overflow-hidden bg-(--bg-surface) border border-(--border-subtle) cursor-pointer transition-all duration-200 text-left font-inherit text-inherit hover:border-cyan-400/20 hover:-translate-y-0.5 hover:shadow-[0_8px_30px_rgba(0,0,0,0.2)]"
		onclick={() => onSelect('launch')}
	>
		<div class="relative z-10 p-[18px] flex flex-col gap-2 h-full">
			<div class="w-[42px] h-[42px] rounded-xl shrink-0 flex items-center justify-center bg-emerald-400/10 text-emerald-500 border border-emerald-400/15">
				<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/></svg>
			</div>
			<div class="flex-1 min-w-0">
				<h3 class="syne text-[15px] font-bold text-(--text-heading) m-0">Launch Existing Token</h3>
				<p class="text-xs2 text-(--text-muted) font-['Rajdhani',sans-serif] leading-[1.4] m-0">Already deployed a token? Add a bonding curve fundraise with refund guarantees.</p>
				<div class="flex gap-1.5 flex-wrap mt-1">
					<span class="text-4xs py-0.5 px-2 rounded-full bg-(--bg-surface-hover) border border-(--border) text-(--text-muted) font-['Rajdhani',sans-serif] font-semibold">Bring your token</span>
					<span class="text-4xs py-0.5 px-2 rounded-full bg-(--bg-surface-hover) border border-(--border) text-(--text-muted) font-['Rajdhani',sans-serif] font-semibold">Fundraise</span>
					<span class="text-4xs py-0.5 px-2 rounded-full bg-(--bg-surface-hover) border border-(--border) text-(--text-muted) font-['Rajdhani',sans-serif] font-semibold">Refundable</span>
				</div>
			</div>
			<span class="inline-flex items-center gap-1 mt-auto pt-2.5 font-['Rajdhani',sans-serif] text-xs2 font-bold text-(--text-dim) transition-colors duration-150 group-hover:text-[#00d2ff]">
				Continue
				<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
			</span>
		</div>
	</button>
</div>

<!-- Comparison table -->
<div class="max-w-[720px] mx-auto mt-7">
	<h4 class="syne text-sm font-extrabold text-(--text-heading) m-0 mb-2.5 text-center">Compare paths</h4>
	<div class="border border-(--border-subtle) rounded-xl overflow-hidden">
		<div class="sel-compare-row grid grid-cols-[1.2fr_repeat(4,1fr)] sm:grid-cols-[1.4fr_repeat(4,1fr)] border-b border-(--border-subtle) bg-(--bg-surface)">
			<span class="py-2 px-2 sm:py-2 sm:px-2.5 font-['Rajdhani',sans-serif] text-3xs text-(--text-dim) font-semibold flex items-center"></span>
			<span class="py-2 px-1 sm:py-2 sm:px-2.5 syne text-[8px] sm:text-xs4 font-bold text-(--text-heading) flex items-center justify-center text-center">Create & Launch</span>
			<span class="py-2 px-1 sm:py-2 sm:px-2.5 syne text-[8px] sm:text-xs4 font-bold text-(--text-heading) flex items-center justify-center text-center">Create & List</span>
			<span class="py-2 px-1 sm:py-2 sm:px-2.5 syne text-[8px] sm:text-xs4 font-bold text-(--text-heading) flex items-center justify-center text-center">Deploy Only</span>
			<span class="py-2 px-1 sm:py-2 sm:px-2.5 syne text-[8px] sm:text-xs4 font-bold text-(--text-heading) flex items-center justify-center text-center">Launch Existing</span>
		</div>

		{#each [
			{ feature: 'Token created', values: ['check', 'check', 'check', 'dash:Already deployed'] },
			{ feature: 'Bonding curve fundraise', values: ['check', 'dash', 'dash', 'check'] },
			{ feature: 'DEX liquidity', values: ['note:Auto at graduation', 'note:Instant (same tx)', 'dash:Manual later', 'note:Auto at graduation'] },
			{ feature: 'LP burned', values: ['note:Always (at graduation)', 'note:Optional', 'dash', 'note:Always (at graduation)'] },
			{ feature: 'Multi-pool LP', values: ['dash', 'check', 'dash', 'dash'] },
			{ feature: 'Set your own price', values: ['dash:Curve-driven', 'check', 'dash', 'dash:Curve-driven'] },
			{ feature: 'Refundable if soft cap missed', values: ['check', 'dash', 'dash', 'check'] },
			{ feature: 'Unsold tokens burned', values: ['check', 'dash', 'dash', 'check'] },
			{ feature: 'Creator vesting', values: ['note:Configurable', 'dash', 'dash', 'note:Configurable'] },
			{ feature: 'Anti-snipe trading delay', values: ['note:At graduation', 'note:Configurable', 'dash:Immediate', 'note:At graduation'] },
			{ feature: 'Max wallet / max tx / cooldown', values: ['check', 'check', 'check', 'check'] },
			{ feature: 'Tax ceiling locked', values: ['check', 'check', 'check', 'check'] },
		] as row, rowIdx}
			<div class={"grid grid-cols-[1.2fr_repeat(4,1fr)] sm:grid-cols-[1.4fr_repeat(4,1fr)] " + (rowIdx < 11 ? "border-b border-(--border-subtle)" : "")}>
				<span class="py-2 px-2 sm:py-2 sm:px-2.5 font-['Rajdhani',sans-serif] text-[9px] sm:text-xs2 text-(--text-dim) font-semibold bg-(--bg-surface) flex items-center">{row.feature}</span>
				{#each row.values as v}
					{@const parts = v.split(':')}
					{@const kind = parts[0]}
					{@const label = parts[1]}
					{#if kind === 'check' && !label}
						<span class="py-2 px-1 sm:py-2 sm:px-2.5 font-['Rajdhani',sans-serif] text-[9px] sm:text-xs2 text-emerald-500 font-bold flex items-center justify-center">&#10003;</span>
					{:else if kind === 'check'}
						<span class="py-2 px-1 sm:py-2 sm:px-2.5 font-['Rajdhani',sans-serif] text-[9px] sm:text-xs2 text-emerald-500 font-bold flex items-center justify-center text-center">{label}</span>
					{:else if kind === 'dash' && !label}
						<span class="py-2 px-1 sm:py-2 sm:px-2.5 font-['Rajdhani',sans-serif] text-[9px] sm:text-xs2 text-(--text-dim) opacity-30 flex items-center justify-center">—</span>
					{:else if kind === 'dash'}
						<span class="py-2 px-1 sm:py-2 sm:px-2.5 font-['Rajdhani',sans-serif] text-[9px] sm:text-3xs text-(--text-dim) opacity-70 flex items-center justify-center text-center">{label}</span>
					{:else if kind === 'note'}
						<span class="py-2 px-1 sm:py-2 sm:px-2.5 font-['Rajdhani',sans-serif] text-[9px] sm:text-3xs text-(--text-muted) flex items-center justify-center text-center">{label}</span>
					{/if}
				{/each}
			</div>
		{/each}
	</div>
</div>

