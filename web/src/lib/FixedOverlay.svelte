<script lang="ts">
	import type { Snippet } from 'svelte';
	import { tap } from './haptics';

	let {
		show = $bindable(false),
		onclose,
		mobileSheet = true,
		swipeToDismiss = true,
		children,
	}: {
		show: boolean;
		onclose?: () => void;
		mobileSheet?: boolean;
		swipeToDismiss?: boolean;
		children: Snippet;
	} = $props();

	function close() {
		if (onclose) onclose();
		else show = false;
	}

	function handleBackdropClick() {
		close();
	}

	// --- Drag-to-dismiss state -------------------------------------------------
	let sheet = $state<HTMLDivElement | null>(null);
	let dragging = $state(false);
	let dragY = $state(0);
	// Recent (timestamp, clientY) samples used to compute exit velocity.
	type Sample = { t: number; y: number };
	let samples: Sample[] = [];
	let pointerId: number | null = null;
	let startY = 0;

	function reducedMotion(): boolean {
		if (typeof window === 'undefined') return false;
		try {
			return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
		} catch {
			return false;
		}
	}

	function isMobileViewport(): boolean {
		if (typeof window === 'undefined') return false;
		try {
			// Tailwind sm breakpoint: 640px. Sheet behavior is max-sm only.
			return window.matchMedia('(max-width: 639px)').matches;
		} catch {
			return false;
		}
	}

	function gestureEnabled(): boolean {
		return swipeToDismiss && mobileSheet && isMobileViewport() && !reducedMotion();
	}

	// Walk up from the touched node and check if any ancestor (within sheet) is
	// a vertically-scrollable element with scrollTop > 0. If so, the user wants
	// to scroll the inner content, not drag the sheet.
	function startsOnScrolledChild(target: EventTarget | null): boolean {
		if (!sheet || !(target instanceof Node)) return false;
		let el: Node | null = target;
		while (el && el !== sheet) {
			if (el instanceof HTMLElement && el.scrollTop > 0) return true;
			el = el.parentNode;
		}
		return false;
	}

	function pruneSamples(now: number) {
		const cutoff = now - 80;
		while (samples.length > 0 && samples[0].t < cutoff) samples.shift();
	}

	function onPointerDown(e: PointerEvent) {
		if (!gestureEnabled()) return;
		if (e.pointerType === 'mouse' && e.button !== 0) return;
		if (startsOnScrolledChild(e.target)) return;
		// Only initiate from the top ~64px of the sheet so taps inside the modal
		// body (buttons, lists) don't accidentally start a drag.
		if (sheet) {
			const rect = sheet.getBoundingClientRect();
			if (e.clientY - rect.top > 64) return;
		}
		dragging = true;
		pointerId = e.pointerId;
		startY = e.clientY;
		dragY = 0;
		samples = [{ t: performance.now(), y: e.clientY }];
		try {
			(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		} catch {}
	}

	function onPointerMove(e: PointerEvent) {
		if (!dragging || e.pointerId !== pointerId) return;
		const delta = e.clientY - startY;
		// Only allow downward drag; upward resists.
		dragY = Math.max(0, delta);
		const now = performance.now();
		samples.push({ t: now, y: e.clientY });
		pruneSamples(now);
	}

	function endDrag(e: PointerEvent) {
		if (!dragging || e.pointerId !== pointerId) return;
		const now = performance.now();
		pruneSamples(now);
		// Velocity: average px/ms over the recent sample window.
		let velocity = 0;
		if (samples.length >= 2) {
			const first = samples[0];
			const last = samples[samples.length - 1];
			const dt = last.t - first.t;
			if (dt > 0) velocity = (last.y - first.y) / dt;
		}
		const distance = dragY;
		dragging = false;
		pointerId = null;
		try {
			(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
		} catch {}
		if (distance > 100 || velocity > 0.5) {
			tap();
			close();
			// Reset on next frame so re-open starts at translateY(0).
			requestAnimationFrame(() => { dragY = 0; });
		} else {
			// Spring back. Resetting dragY triggers the transition (since dragging=false).
			dragY = 0;
		}
		samples = [];
	}

	function onPointerCancel(e: PointerEvent) {
		if (!dragging || e.pointerId !== pointerId) return;
		dragging = false;
		pointerId = null;
		dragY = 0;
		samples = [];
	}
</script>

{#if show}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<!-- svelte-ignore a11y_interactive_supports_focus -->
	<div
		class={"fixed inset-0 z-50 bg-black/70 backdrop-blur-[4px] flex items-center justify-center p-4 " + (mobileSheet ? "max-sm:items-end max-sm:p-0" : "")}
		onclick={handleBackdropClick}
		role="dialog"
		aria-modal="true"
	>
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			bind:this={sheet}
			class={"w-full max-w-[420px] flex flex-col " + (mobileSheet ? "max-sm:max-w-full" : "")}
			style:transform={dragY > 0 ? `translateY(${dragY}px)` : undefined}
			style:transition={dragging ? 'none' : 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)'}
			style:will-change={dragging ? 'transform' : undefined}
			style:touch-action={gestureEnabled() ? 'pan-y' : undefined}
			onclick={(e) => e.stopPropagation()}
			onpointerdown={onPointerDown}
			onpointermove={onPointerMove}
			onpointerup={endDrag}
			onpointercancel={onPointerCancel}
		>
			{@render children()}
		</div>
	</div>
{/if}
