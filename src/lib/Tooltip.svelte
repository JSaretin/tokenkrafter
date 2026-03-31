<script lang="ts">
	let { text }: { text: string } = $props();

	let visible = $state(false);
	let tooltipEl: HTMLDivElement | undefined = $state();
	let triggerEl: HTMLButtonElement | undefined = $state();
	let placement = $state<'above' | 'below'>('above');

	function show() {
		updatePlacement();
		visible = true;
	}

	function hide() {
		visible = false;
	}

	function toggle(e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
		if (visible) {
			hide();
		} else {
			show();
		}
	}

	function updatePlacement() {
		if (!triggerEl) return;
		const rect = triggerEl.getBoundingClientRect();
		// If trigger is in the top 120px of viewport, show below
		placement = rect.top < 120 ? 'below' : 'above';
	}

	function handleClickOutside(e: MouseEvent) {
		if (visible && triggerEl && !triggerEl.contains(e.target as Node) && tooltipEl && !tooltipEl.contains(e.target as Node)) {
			hide();
		}
	}

	$effect(() => {
		if (visible) {
			document.addEventListener('click', handleClickOutside, true);
			return () => document.removeEventListener('click', handleClickOutside, true);
		}
	});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<span
	class="tooltip-wrap"
	onmouseenter={show}
	onmouseleave={hide}
>
	<button
		type="button"
		class="tooltip-trigger"
		bind:this={triggerEl}
		onclick={toggle}
		aria-label="Help"
	>?</button>
	{#if visible}
		<div class="tooltip-bubble {placement}" bind:this={tooltipEl}>
			{text}
			<div class="tooltip-arrow"></div>
		</div>
	{/if}
</span>

<style>
	.tooltip-wrap {
		position: relative;
		display: inline-flex;
		align-items: center;
		margin-left: 5px;
		vertical-align: middle;
	}

	.tooltip-trigger {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: rgba(6, 182, 212, 0.15);
		color: rgb(34, 211, 238);
		border: 1px solid rgba(6, 182, 212, 0.3);
		font-size: 9px;
		font-weight: 700;
		line-height: 1;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		cursor: help;
		padding: 0;
		flex-shrink: 0;
		font-family: 'Space Mono', monospace;
		transition: background 0.15s, border-color 0.15s;
	}

	.tooltip-trigger:hover {
		background: rgba(6, 182, 212, 0.25);
		border-color: rgba(6, 182, 212, 0.5);
	}

	.tooltip-bubble {
		position: absolute;
		left: 50%;
		transform: translateX(-50%);
		background: #1a1a2e;
		color: #d1d5db;
		font-size: 11px;
		font-family: 'Space Mono', monospace;
		line-height: 1.5;
		padding: 8px 10px;
		border-radius: 8px;
		max-width: 250px;
		min-width: 160px;
		width: max-content;
		z-index: 1000;
		pointer-events: auto;
		border: 1px solid rgba(6, 182, 212, 0.15);
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
	}

	.tooltip-bubble.above {
		bottom: calc(100% + 8px);
	}

	.tooltip-bubble.below {
		top: calc(100% + 8px);
	}

	.tooltip-arrow {
		position: absolute;
		left: 50%;
		transform: translateX(-50%);
		width: 0;
		height: 0;
		border-left: 5px solid transparent;
		border-right: 5px solid transparent;
	}

	.tooltip-bubble.above .tooltip-arrow {
		bottom: -5px;
		border-top: 5px solid #1a1a2e;
	}

	.tooltip-bubble.below .tooltip-arrow {
		top: -5px;
		border-bottom: 5px solid #1a1a2e;
	}
</style>
