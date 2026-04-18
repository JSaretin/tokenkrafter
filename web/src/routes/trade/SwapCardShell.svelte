<script lang="ts">
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();
</script>

<div class="bg-(--bg-surface) border border-(--border) rounded-[20px] p-1 pb-3">
	{@render children()}
</div>
