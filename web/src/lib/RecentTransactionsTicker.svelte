<script lang="ts">
	import { onMount } from 'svelte';
	import { chainSlug } from '$lib/structure';
	import { realtime } from '$lib/realtime.svelte';

	let currentIndex = $state(0);
	let tickerInterval: ReturnType<typeof setInterval> | null = null;

	let {
		chainId = undefined,
		launchAddress = undefined,
		limit = 20,
		rotateMs = 4000
	}: {
		chainId?: number;
		launchAddress?: string;
		limit?: number;
		rotateMs?: number;
	} = $props();

	onMount(() => {
		realtime.connect();
		tickerInterval = setInterval(() => {
			if (filtered.length > 0) {
				currentIndex = (currentIndex + 1) % filtered.length;
			}
		}, rotateMs);
		return () => { if (tickerInterval) clearInterval(tickerInterval); };
	});

	let filtered = $derived.by(() => {
		let txs = realtime.transactions;
		if (chainId) txs = txs.filter(t => t.chain_id === chainId);
		if (launchAddress) txs = txs.filter(t => t.launch_address === launchAddress);
		return txs.slice(0, limit);
	});

	let current = $derived(filtered[currentIndex % Math.max(filtered.length, 1)]);

	function truncAddr(addr: string): string {
		if (!addr || addr.length < 10) return addr;
		return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
	}

	function formatAmount(raw: string, decimals: number): string {
		const num = Number(BigInt(raw || '0')) / Math.pow(10, decimals);
		if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
		if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
		return num.toFixed(num < 1 ? 4 : 2);
	}

	function timeAgo(isoDate: string): string {
		const ms = Date.now() - new Date(isoDate).getTime();
		const mins = Math.floor(ms / 60_000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		const hours = Math.floor(mins / 60);
		if (hours < 24) return `${hours}h ago`;
		return `${Math.floor(hours / 24)}d ago`;
	}
</script>

{#if current}
	{#key currentIndex}
		<div class="w-full overflow-hidden rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-4 py-2.5">
			<div class="flex items-center gap-2 text-sm ticker-fade">
				<span class="h-2 w-2 flex-shrink-0 rounded-full bg-emerald-400 animate-pulse"></span>
				<span class="flex-1 truncate">
					<span class="font-mono text-emerald-300">{truncAddr(current.buyer)}</span>
					<span class="text-gray-400"> bought </span>
					<span class="font-bold text-white">{formatAmount(current.tokens_amount, current.token_decimals)}</span>
					<span class="font-bold text-emerald-300"> {current.token_symbol}</span>
					<span class="text-gray-400"> for </span>
					<span class="font-bold text-white">{formatAmount(current.base_amount, current.base_decimals)}</span>
					<span class="text-gray-400"> {current.base_symbol}</span>
				</span>
				<span class="flex-shrink-0 text-xs text-gray-500">{timeAgo(current.created_at)}</span>
				<a
					href="/launchpad/{chainSlug(current.chain_id ?? 56)}/{current.launch_address}"
					class="flex-shrink-0 rounded bg-emerald-500/20 px-2 py-0.5 text-xs font-medium text-emerald-400 hover:bg-emerald-500/30 transition-colors"
				>View</a>
			</div>
		</div>
	{/key}
{/if}

<style>
	.ticker-fade { animation: ticker-in 0.4s ease-out; }
	@keyframes ticker-in {
		0% { opacity: 0; transform: translateY(8px); }
		100% { opacity: 1; transform: translateY(0); }
	}
</style>
