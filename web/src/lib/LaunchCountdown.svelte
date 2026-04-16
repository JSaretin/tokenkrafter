<script lang="ts">
	let {
		deadline = 0,
		label = 'Sale ends in',
		size = 'md' as 'sm' | 'md' | 'lg',
		variant = 'cyan' as 'cyan' | 'amber',
	}: {
		deadline: number;
		label?: string;
		size?: 'sm' | 'md' | 'lg';
		variant?: 'cyan' | 'amber';
	} = $props();

	let tickNow = $state(Date.now());
	let interval: ReturnType<typeof setInterval> | null = null;

	$effect(() => {
		interval = setInterval(() => { tickNow = Date.now(); }, 1000);
		return () => { if (interval) clearInterval(interval); };
	});

	let ms = $derived(deadline * 1000 - tickNow);
	let ended = $derived(ms <= 0);
	let d = $derived(Math.floor(Math.max(0, ms) / 86400000));
	let h = $derived(Math.floor((Math.max(0, ms) % 86400000) / 3600000));
	let m = $derived(Math.floor((Math.max(0, ms) % 3600000) / 60000));
	let s = $derived(Math.floor((Math.max(0, ms) % 60000) / 1000));
	let urgent = $derived(ms > 0 && ms < 900000);
	let warning = $derived(ms > 0 && ms >= 900000 && ms < 3600000);
	let pad = (n: number) => String(n).padStart(2, '0');
</script>

{#if !ended}
	<div class="lcd lcd-{size} lcd-{variant}">
		{#if label}
			<span class="lcd-label" class:lcd-urgent={urgent} class:lcd-warning={warning}>{label}</span>
		{/if}
		<div class="lcd-grid">
			<div class="lcd-box"><span class="lcd-num">{pad(d)}</span><span class="lcd-unit">{size === 'sm' ? 'd' : 'Days'}</span></div>
			<div class="lcd-box"><span class="lcd-num">{pad(h)}</span><span class="lcd-unit">{size === 'sm' ? 'h' : 'Hrs'}</span></div>
			<div class="lcd-box"><span class="lcd-num">{pad(m)}</span><span class="lcd-unit">{size === 'sm' ? 'm' : 'Min'}</span></div>
			<div class="lcd-box"><span class="lcd-num">{pad(s)}</span><span class="lcd-unit">{size === 'sm' ? 's' : 'Sec'}</span></div>
		</div>
	</div>
{/if}

<style>
	.lcd { width: 100%; }

	.lcd-label {
		display: block; text-align: center; margin-bottom: 6px;
		font-family: 'Space Mono', monospace;
		text-transform: uppercase; letter-spacing: 0.06em;
	}
	.lcd-cyan .lcd-label { color: #00d2ff; }
	.lcd-amber .lcd-label { color: #f59e0b; }
	.lcd-warning { color: #fbbf24 !important; }
	.lcd-urgent { color: #f87171 !important; animation: urgentPulse 1.5s ease-in-out infinite; }

	.lcd-grid { display: grid; grid-template-columns: repeat(4, 1fr); }

	.lcd-box {
		display: flex; flex-direction: column; align-items: center;
		border-radius: 8px;
	}
	.lcd-cyan .lcd-box {
		background: linear-gradient(135deg, rgba(0, 210, 255, 0.06), rgba(139, 92, 246, 0.06));
		border: 1px solid rgba(0, 210, 255, 0.1);
	}
	.lcd-amber .lcd-box {
		background: linear-gradient(135deg, rgba(245, 158, 11, 0.06), rgba(217, 119, 6, 0.06));
		border: 1px solid rgba(245, 158, 11, 0.12);
	}

	.lcd-num {
		font-family: 'Space Mono', monospace; font-weight: 700;
		color: var(--text-heading); line-height: 1;
	}
	.lcd-amber .lcd-num { color: #f59e0b; }

	.lcd-unit {
		font-family: 'Space Mono', monospace;
		text-transform: uppercase; letter-spacing: 0.06em;
		color: var(--text-dim);
	}

	/* ── Size: sm (explore cards) ── */
	.lcd-sm .lcd-label { font-size: 8px; margin-bottom: 4px; }
	.lcd-sm .lcd-grid { gap: 3px; }
	.lcd-sm .lcd-box { padding: 4px 2px; gap: 1px; flex-direction: row; justify-content: center; border-radius: 5px; }
	.lcd-sm .lcd-num { font-size: 12px; }
	.lcd-sm .lcd-unit { font-size: 7px; }

	/* ── Size: md (home + launchpad cards) ── */
	.lcd-md .lcd-label { font-size: 9px; }
	.lcd-md .lcd-grid { gap: 4px; }
	.lcd-md .lcd-box { padding: 6px 2px; gap: 2px; }
	.lcd-md .lcd-num { font-size: 16px; }
	.lcd-md .lcd-unit { font-size: 7px; }

	/* ── Size: lg (detail page) ── */
	.lcd-lg .lcd-label { font-size: 10px; margin-bottom: 8px; }
	.lcd-lg .lcd-grid { gap: 8px; }
	.lcd-lg .lcd-box { padding: 10px 4px; gap: 4px; }
	.lcd-lg .lcd-num { font-size: 22px; }
	.lcd-lg .lcd-unit { font-size: 9px; }

	@keyframes urgentPulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.5; }
	}
</style>
