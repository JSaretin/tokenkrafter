<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		show = $bindable(false),
		onclose,
		mobileSheet = true,
		children,
	}: {
		show: boolean;
		onclose?: () => void;
		mobileSheet?: boolean;
		children: Snippet;
	} = $props();

	function handleBackdropClick() {
		if (onclose) onclose();
		else show = false;
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
		<div class="contents" onclick={(e) => e.stopPropagation()}>
			{@render children()}
		</div>
	</div>
{/if}
