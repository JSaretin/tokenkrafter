<script lang="ts">
	import type { SupportedNetworks } from '$lib/structure';
	import { getContext } from 'svelte';
	const supportedNetworks: SupportedNetworks = getContext('supportedNetworks');
</script>

<svelte:head>
	<title>Explore Tokens | TokenKrafter</title>
	<meta name="description" content="Browse and explore tokens deployed on Ethereum, BSC, and other supported networks through TokenKrafter." />
</svelte:head>

<div class="max-w-5xl mx-auto px-4 sm:px-6 py-12">
	<h1 class="syne text-3xl sm:text-4xl font-bold text-white mb-2">Explore Tokens</h1>
	<p class="text-gray-400 font-mono text-sm mb-8">Browse tokens deployed on supported networks.</p>

	<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
		{#each supportedNetworks as net}
			<a href="/tokens/{net.symbol}" class="network-card card card-hover no-underline group p-6">
				<div class="flex items-center gap-4">
					<div class="net-icon syne">{net.symbol.slice(0,2)}</div>
					<div>
						<div class="syne font-bold text-white group-hover:text-cyan-300 transition">{net.name}</div>
						<div class="text-xs text-gray-500 font-mono mt-0.5">Chain ID: {net.chain_id}</div>
					</div>
					<div class="ml-auto text-gray-600 group-hover:text-cyan-400 transition text-lg">→</div>
				</div>
			</a>
		{/each}
	</div>
</div>

<style>
	.syne { font-family: 'Syne', sans-serif; }
	.no-underline { text-decoration: none; }
	a.no-underline { text-decoration: none; }
	.card { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07); border-radius: 16px; }
	.card-hover:hover { border-color: rgba(0,210,255,0.2); background: rgba(0,210,255,0.03); transform: translateY(-2px); }
	.net-icon {
		width: 48px; height: 48px; border-radius: 12px;
		background: linear-gradient(135deg, rgba(0,210,255,0.2), rgba(99,102,241,0.2));
		border: 1px solid rgba(255,255,255,0.1);
		display: flex; align-items: center; justify-content: center;
		font-size: 14px; font-weight: 800; color: white;
	}
</style>
