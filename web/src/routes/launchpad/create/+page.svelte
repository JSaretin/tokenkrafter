<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';

	onMount(() => {
		// Forward any query params (e.g. ?token=0x...&chain=BSC)
		const params = new URLSearchParams(page.url.searchParams);
		params.set('launch', 'true');
		goto(`/create?${params.toString()}`, { replaceState: true });
	});
</script>

<div class="page-wrap max-w-3xl mx-auto px-4 sm:px-6 py-12 text-center">
	<div class="spinner w-10 h-10 rounded-full border-2 border-white/10 border-t-cyan-400 mx-auto mb-4"></div>
	<p class="text-gray-500 text-sm font-mono">Redirecting to token creator...</p>
</div>
