<script lang="ts">
	let {
		show = $bindable(false),
		title = 'Confirm Transaction',
		fromLabel = 'You pay',
		fromAmount = '',
		fromSymbol = '',
		fromSub = '' as string,
		toLabel = 'You receive',
		toAmount = '',
		toSymbol = '',
		toSub = '' as string,
		details = [] as { label: string; value: string; warn?: boolean; highlight?: boolean }[],
		warning = '' as string,
		confirmText = 'Confirm',
		confirmStyle = '' as string,
		processing = false,
		onconfirm = () => {},
	}: {
		show: boolean;
		title?: string;
		fromLabel?: string;
		fromAmount: string;
		fromSymbol: string;
		fromSub?: string;
		toLabel?: string;
		toAmount: string;
		toSymbol: string;
		toSub?: string;
		details?: { label: string; value: string; warn?: boolean; highlight?: boolean }[];
		warning?: string;
		confirmText?: string;
		confirmStyle?: string;
		processing?: boolean;
		onconfirm?: () => void;
	} = $props();
</script>

{#if show}
	<div class="fixed inset-0 z-[1000] bg-black/70 backdrop-blur flex items-center justify-center p-4 max-[480px]:p-0 max-[480px]:items-end" onclick={() => { if (!processing) show = false; }} role="dialog" aria-modal="true">
		<div class="w-full max-w-[400px] max-[480px]:max-w-full bg-surface border border-white/[0.08] rounded-[20px] max-[480px]:rounded-b-none overflow-hidden flex flex-col shadow-[0_20px_60px_rgba(0,0,0,0.5)]" onclick={(e) => e.stopPropagation()}>
			<div class="flex justify-between items-center px-4 pt-4">
				<h3 class="font-display text-[15px] font-bold text-heading m-0">{title}</h3>
				{#if !processing}
					<button class="bg-none border-none text-dim cursor-pointer p-1 rounded-lg hover:text-heading hover:bg-white/5" onclick={() => { show = false; }}>
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
					</button>
				{/if}
			</div>

			<div class="px-4 pt-3.5 pb-4">
				<!-- From / To -->
				<div class="flex flex-col bg-white/[0.02] rounded-xl overflow-hidden border border-white/[0.05]">
					<div class="px-3.5 py-2.5">
						<span class="block font-mono text-[9px] font-semibold uppercase tracking-[0.05em] text-muted mb-0.5">{fromLabel}</span>
						<span class="block font-numeric text-[22px] font-bold text-heading leading-[1.3]">{fromAmount} <span class="text-sm text-muted font-semibold">{fromSymbol}</span></span>
						{#if fromSub}<span class="block font-mono text-[10px] text-dim mt-0.5">{fromSub}</span>{/if}
					</div>
					<div class="w-7 h-7 rounded-full bg-surface border border-white/[0.08] flex items-center justify-center text-dim -my-3.5 mx-auto z-[1]">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14m0 0l-4-4m4 4l4-4"/></svg>
					</div>
					<div class="px-3.5 py-2.5 border-t border-white/[0.05]">
						<span class="block font-mono text-[9px] font-semibold uppercase tracking-[0.05em] text-muted mb-0.5">{toLabel}</span>
						<span class="block font-numeric text-[22px] font-bold text-heading leading-[1.3]">{toAmount} <span class="text-sm text-muted font-semibold">{toSymbol}</span></span>
						{#if toSub}<span class="block font-mono text-[10px] text-dim mt-0.5">{toSub}</span>{/if}
					</div>
				</div>

				<!-- Details -->
				{#if details.length > 0}
					<div class="mt-2.5 mb-3 px-3 py-2.5 border border-white/[0.05] rounded-[10px]">
						{#each details as d}
							<div class={'flex justify-between font-mono text-[10px] ' + (d.highlight ? 'py-1.5' : 'py-[3px]')}>
								<span class="text-muted">{d.label}</span>
								<span class={d.warn ? 'text-amber-500' : 'text-heading'}>{d.value}</span>
							</div>
						{/each}
					</div>
				{/if}

				<!-- Warning -->
				{#if warning}
					<div class="font-mono text-[10px] mb-3 leading-[1.5] px-2.5 py-2 rounded-lg bg-amber-500/[0.04] border border-amber-500/10 text-amber-500">{warning}</div>
				{/if}

				<!-- Confirm -->
				<button class="cm-confirm w-full p-3 rounded-xl cursor-pointer font-mono text-[13px] font-semibold border-none text-white hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed" style={confirmStyle} onclick={onconfirm} disabled={processing}>
					{confirmText}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.cm-confirm { background: linear-gradient(135deg, #00d2ff, #8b5cf6); }
</style>
