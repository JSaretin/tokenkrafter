<script lang="ts">
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();
</script>

<div class="my-2.5 mb-3 py-2.5 px-3 border border-(--border) rounded-[10px]">
	{@render children()}
</div>
