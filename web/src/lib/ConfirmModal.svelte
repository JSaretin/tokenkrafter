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
	<div class="cm-overlay" onclick={() => { if (!processing) show = false; }} role="dialog" aria-modal="true">
		<div class="cm-modal" onclick={(e) => e.stopPropagation()}>
			<div class="cm-header">
				<h3>{title}</h3>
				{#if !processing}
					<button class="cm-close" onclick={() => { show = false; }}>
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
					</button>
				{/if}
			</div>

			<div class="cm-body">
				<!-- From / To -->
				<div class="cm-swap-row">
					<div class="cm-side">
						<span class="cm-label">{fromLabel}</span>
						<span class="cm-amount">{fromAmount} <span class="cm-sym">{fromSymbol}</span></span>
						{#if fromSub}<span class="cm-sub">{fromSub}</span>{/if}
					</div>
					<div class="cm-arrow">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14m0 0l-4-4m4 4l4-4"/></svg>
					</div>
					<div class="cm-side cm-side-to">
						<span class="cm-label">{toLabel}</span>
						<span class="cm-amount">{toAmount} <span class="cm-sym">{toSymbol}</span></span>
						{#if toSub}<span class="cm-sub">{toSub}</span>{/if}
					</div>
				</div>

				<!-- Details -->
				{#if details.length > 0}
					<div class="cm-details">
						{#each details as d}
							<div class="cm-row" class:cm-row-warn={d.warn} class:cm-row-highlight={d.highlight}>
								<span>{d.label}</span>
								<span>{d.value}</span>
							</div>
						{/each}
					</div>
				{/if}

				<!-- Warning -->
				{#if warning}
					<div class="cm-warn">{warning}</div>
				{/if}

				<!-- Confirm -->
				<button class="cm-btn-confirm" style={confirmStyle} onclick={onconfirm} disabled={processing}>
					{confirmText}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.cm-overlay {
		position: fixed; inset: 0; z-index: 1000;
		background: rgba(0,0,0,0.7); backdrop-filter: blur(4px);
		display: flex; align-items: center; justify-content: center;
		padding: 16px;
	}
	.cm-modal {
		width: 100%; max-width: 400px; background: var(--bg-card, #0f1729);
		border: 1px solid rgba(255,255,255,0.08); border-radius: 20px;
		overflow: hidden; display: flex; flex-direction: column;
		box-shadow: 0 20px 60px rgba(0,0,0,0.5);
	}
	.cm-header {
		display: flex; justify-content: space-between; align-items: center;
		padding: 16px 18px 0;
	}
	.cm-header h3 {
		font-family: 'Syne', sans-serif; font-size: 15px; font-weight: 700;
		color: var(--text-heading, #fff); margin: 0;
	}
	.cm-close {
		background: none; border: none; color: var(--text-dim, #6b7280);
		cursor: pointer; padding: 4px; border-radius: 8px;
	}
	.cm-close:hover { color: var(--text-heading, #fff); background: rgba(255,255,255,0.05); }
	.cm-body { padding: 14px 16px 16px; }

	/* Swap row */
	.cm-swap-row {
		display: flex; flex-direction: column;
		background: rgba(255,255,255,0.02); border-radius: 12px; overflow: hidden;
		border: 1px solid rgba(255,255,255,0.05);
	}
	.cm-side { padding: 10px 14px; }
	.cm-side-to { border-top: 1px solid rgba(255,255,255,0.05); }
	.cm-arrow {
		width: 28px; height: 28px; border-radius: 50%;
		background: var(--bg-card, #0f1729); border: 1px solid rgba(255,255,255,0.08);
		display: flex; align-items: center; justify-content: center;
		color: var(--text-dim, #6b7280); margin: -14px auto; z-index: 1;
	}
	.cm-label {
		display: block; font-family: 'Space Mono', monospace; font-size: 9px;
		font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;
		color: var(--text-muted, #9ca3af); margin-bottom: 2px;
	}
	.cm-amount {
		display: block; font-family: 'Rajdhani', sans-serif; font-size: 22px;
		font-weight: 700; color: var(--text-heading, #fff); line-height: 1.3;
		font-variant-numeric: tabular-nums;
	}
	.cm-sym { font-size: 14px; color: var(--text-muted, #9ca3af); font-weight: 600; }
	.cm-sub {
		display: block; font-family: 'Space Mono', monospace; font-size: 10px;
		color: var(--text-dim, #6b7280); margin-top: 2px;
	}

	/* Details */
	.cm-details {
		margin: 10px 0 12px; padding: 10px 12px;
		border: 1px solid rgba(255,255,255,0.05); border-radius: 10px;
	}
	.cm-row {
		display: flex; justify-content: space-between; padding: 3px 0;
		font-family: 'Space Mono', monospace; font-size: 10px;
	}
	.cm-row span:first-child { color: var(--text-muted, #9ca3af); }
	.cm-row span:last-child { color: var(--text-heading, #fff); }
	.cm-row-warn span:last-child { color: #f59e0b; }
	.cm-row-highlight { padding: 6px 0; }

	/* Warning */
	.cm-warn {
		font-family: 'Space Mono', monospace; font-size: 10px;
		color: var(--text-dim, #6b7280); margin-bottom: 12px; line-height: 1.5;
		padding: 8px 10px; border-radius: 8px;
		background: rgba(245,158,11,0.04); border: 1px solid rgba(245,158,11,0.1);
		color: #f59e0b;
	}

	/* Confirm button */
	.cm-btn-confirm {
		width: 100%; padding: 12px; border-radius: 12px; cursor: pointer;
		font-family: 'Space Mono', monospace; font-size: 13px; font-weight: 600;
		background: linear-gradient(135deg, #00d2ff, #8b5cf6); border: none;
		color: #fff;
	}
	.cm-btn-confirm:hover { filter: brightness(1.1); }
	.cm-btn-confirm:disabled { opacity: 0.5; cursor: not-allowed; }

	@media (max-width: 480px) {
		.cm-overlay { padding: 0; align-items: flex-end; }
		.cm-modal { max-width: 100%; border-radius: 20px 20px 0 0; }
	}
</style>
