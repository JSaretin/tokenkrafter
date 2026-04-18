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
	class="relative inline-flex items-center ml-[5px] align-middle"
	onmouseenter={show}
	onmouseleave={hide}
>
	<button
		type="button"
		class="w-[14px] h-[14px] rounded-full bg-cyan-500/15 text-cyan-400 border border-cyan-500/30 hover:bg-cyan-500/25 hover:border-cyan-500/50 text-[9px] font-bold leading-none inline-flex items-center justify-center cursor-help p-0 shrink-0 font-mono transition-[background,border-color] duration-150"
		bind:this={triggerEl}
		onclick={toggle}
		aria-label="Help"
	>?</button>
	{#if visible}
		<div class="fixed bg-surface text-foreground text-xs font-mono font-normal leading-[1.5] text-left px-3 py-2.5 rounded-[10px] min-w-[160px] w-max z-[9999] pointer-events-auto border border-cyan-500/15 shadow-[0_8px_24px_rgba(0,0,0,0.5)] max-w-[min(280px,calc(100vw-32px))]" style={tooltipStyle} bind:this={tooltipEl}>
			{text}
			<div class="tooltip-arrow"></div>
		</div>
	{/if}
</span>
