<script lang="ts">
	import type { Snippet } from 'svelte';
	import FixedOverlay from './FixedOverlay.svelte';

	let {
		show = $bindable(false),
		maxWidth = 'max-w-110',
		onclose,
		children,
		mobileSheet = true,
		swipeToDismiss = true,
	}: {
		show: boolean;
		maxWidth?: string;
		onclose?: () => void;
		children: Snippet;
		mobileSheet?: boolean;
		/**
		 * If true (default), users can dismiss the sheet by swiping down on
		 * mobile. Set to false for confirmation dialogs where accidental
		 * swipe-close would be costly.
		 */
		swipeToDismiss?: boolean;
	} = $props();
</script>

<FixedOverlay bind:show {onclose} {mobileSheet} {swipeToDismiss}>
	<div
		class={"w-full " + maxWidth + " bg-(--bg) border border-(--border) rounded-[20px] overflow-hidden shadow-[0_24px_80px_rgba(0,0,0,0.5)] animate-modal-in " + (mobileSheet ? "max-sm:max-w-full max-sm:rounded-t-[20px] max-sm:rounded-b-none max-sm:h-[85vh] max-sm:flex max-sm:flex-col" : "")}
	>
		{#if mobileSheet}
			<!-- Drag handle (mobile only). Visual affordance for swipe-to-dismiss;
			     gesture itself is handled by FixedOverlay on the whole sheet. -->
			<div class="hidden max-sm:flex justify-center pt-2 pb-1 shrink-0" aria-hidden="true">
				<div class="w-9 h-1 rounded-full bg-(--border)"></div>
			</div>
		{/if}
		{@render children()}
	</div>
</FixedOverlay>
