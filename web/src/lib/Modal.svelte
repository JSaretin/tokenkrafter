<script lang="ts">
	import type { Snippet } from 'svelte';
	import FixedOverlay from './FixedOverlay.svelte';

	let {
		show = $bindable(false),
		maxWidth = 'max-w-110',
		onclose,
		children,
		mobileSheet = true,
	}: {
		show: boolean;
		maxWidth?: string;
		onclose?: () => void;
		children: Snippet;
		mobileSheet?: boolean;
	} = $props();
</script>

<FixedOverlay bind:show {onclose} {mobileSheet}>
	<div
		class={"w-full " + maxWidth + " bg-(--bg) border border-(--border) rounded-[20px] overflow-hidden shadow-[0_24px_80px_rgba(0,0,0,0.5)] animate-modal-in " + (mobileSheet ? "max-sm:max-w-full max-sm:rounded-t-[20px] max-sm:rounded-b-none max-sm:h-[85vh] max-sm:flex max-sm:flex-col" : "")}
	>
		{@render children()}
	</div>
</FixedOverlay>
