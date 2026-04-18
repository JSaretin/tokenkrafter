<script lang="ts">
	import { onMount } from 'svelte';
	import { chainSlug } from '$lib/structure';
	import { realtime, type LiveTransaction } from '$lib/realtime.svelte';

	let { maxItems = 15 }: { maxItems?: number } = $props();

	onMount(() => {
		realtime.connect();
		return () => {};
	});

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

	let visible = $derived(realtime.transactions.slice(0, maxItems));
</script>

<div class="bg-surface border border-line rounded-[14px] overflow-hidden max-h-[calc(100vh-100px)] flex flex-col">
	<!-- Header -->
	<div class="flex justify-between items-center px-4 py-3.5 border-b border-line">
		<div class="flex items-center gap-2 font-display text-sm font-bold text-heading">
			<span class="mf-dot w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]"></span>
			Recent Activity
		</div>
		{#if realtime.connected}
			<span class="text-[9px] font-bold font-mono tracking-[0.1em] text-emerald-500 bg-emerald-500/10 px-2 py-[3px] rounded border border-emerald-500/20">LIVE</span>
		{/if}
	</div>

	<!-- Transaction list -->
	<div class="mf-list flex-1 overflow-y-auto">
		{#each visible as tx (tx.id)}
			<a href="/launchpad/{chainSlug(tx.chain_id ?? 56)}/{tx.launch_address}" class="flex items-center gap-2.5 px-4 py-2.5 border-b border-line-subtle no-underline transition-[background] duration-150 hover:bg-surface">
				<div class="w-7 h-7 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center shrink-0">
					<span class="text-emerald-500 text-xs font-bold">↑</span>
				</div>
				<div class="flex-1 min-w-0">
					<div class="flex justify-between items-center mb-0.5">
						<span class="text-[11px] font-mono text-muted">{truncAddr(tx.buyer)}</span>
						<span class="text-[10px] text-dim font-mono">{timeAgo(tx.created_at)}</span>
					</div>
					<div class="text-xs font-mono">
						<span class="text-white font-semibold">{formatAmount(tx.base_amount, tx.base_decimals)} {tx.base_symbol}</span>
						<span class="text-gray-500"> → </span>
						<span class="text-cyan-400 font-semibold">{tx.token_symbol}</span>
					</div>
				</div>
			</a>
		{:else}
			<div class="px-4 py-10 text-center text-dim text-xs font-mono">No transactions yet</div>
		{/each}
	</div>
</div>

<style>
	.mf-dot { animation: pulse-dot 2s ease-in-out infinite; }
	@keyframes pulse-dot {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}
	.mf-list {
		scrollbar-width: thin;
		scrollbar-color: var(--bg-surface-hover) transparent;
	}
</style>
