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

	let tooltipStyle = $state('');

	function updatePlacement() {
		if (!triggerEl) return;
		const rect = triggerEl.getBoundingClientRect();
		placement = rect.top < 120 ? 'below' : 'above';

		// Position fixed relative to viewport
		// Clamp left so tooltip doesn't go off-screen
		let left = rect.left + rect.width / 2;
		const maxWidth = Math.min(280, window.innerWidth - 32);
		left = Math.max(16 + maxWidth / 2, Math.min(left, window.innerWidth - 16 - maxWidth / 2));

		if (placement === 'above') {
			tooltipStyle = `bottom: ${window.innerHeight - rect.top + 8}px; left: ${left}px; transform: translateX(-50%);`;
		} else {
			tooltipStyle = `top: ${rect.bottom + 8}px; left: ${left}px; transform: translateX(-50%);`;
		}
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
		<div class="tooltip-bubble {placement}" style={tooltipStyle} bind:this={tooltipEl}>
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
		position: fixed;
		background: #1a1a2e;
		color: #d1d5db;
		font-size: 12px;
		font-family: 'Space Mono', monospace;
		font-weight: 400;
		line-height: 1.5;
		letter-spacing: 0;
		text-transform: none;
		text-align: left;
		padding: 10px 12px;
		border-radius: 10px;
		max-width: min(280px, calc(100vw - 32px));
		min-width: 160px;
		width: max-content;
		z-index: 9999;
		pointer-events: auto;
		border: 1px solid rgba(6, 182, 212, 0.15);
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
	}
</style>
