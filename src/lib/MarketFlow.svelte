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

<div class="market-flow">
	<!-- Header -->
	<div class="mf-header">
		<div class="mf-title">
			<span class="mf-dot"></span>
			Recent Activity
		</div>
		{#if realtime.connected}
			<span class="mf-live">LIVE</span>
		{/if}
	</div>

	<!-- Transaction list -->
	<div class="mf-list">
		{#each visible as tx (tx.id)}
			<a href="/launchpad/{chainSlug(tx.chain_id ?? 56)}/{tx.launch_address}" class="mf-item">
				<div class="mf-item-icon">
					<span class="mf-buy-arrow">↑</span>
				</div>
				<div class="mf-item-body">
					<div class="mf-item-top">
						<span class="mf-buyer">{truncAddr(tx.buyer)}</span>
						<span class="mf-time">{timeAgo(tx.created_at)}</span>
					</div>
					<div class="mf-item-detail">
						<span class="text-white font-semibold">{formatAmount(tx.base_amount, tx.base_decimals)} {tx.base_symbol}</span>
						<span class="text-gray-500"> → </span>
						<span class="text-cyan-400 font-semibold">{tx.token_symbol}</span>
					</div>
				</div>
			</a>
		{:else}
			<div class="mf-empty">No transactions yet</div>
		{/each}
	</div>
</div>

<style>
	.market-flow {
		background: var(--bg-surface);
		border: 1px solid var(--border);
		border-radius: 14px;
		overflow: hidden;
		max-height: calc(100vh - 100px);
		display: flex;
		flex-direction: column;
	}

	.mf-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 14px 16px;
		border-bottom: 1px solid var(--border);
	}

	.mf-title {
		display: flex;
		align-items: center;
		gap: 8px;
		font-family: 'Syne', sans-serif;
		font-size: 14px;
		font-weight: 700;
		color: var(--text-heading);
	}

	.mf-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: #10b981;
		box-shadow: 0 0 8px rgba(16, 185, 129, 0.5);
		animation: pulse-dot 2s ease-in-out infinite;
	}
	@keyframes pulse-dot {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}

	.mf-live {
		font-size: 9px;
		font-weight: 700;
		font-family: 'Space Mono', monospace;
		letter-spacing: 0.1em;
		color: #10b981;
		background: rgba(16, 185, 129, 0.1);
		padding: 3px 8px;
		border-radius: 4px;
		border: 1px solid rgba(16, 185, 129, 0.2);
	}


	.mf-list {
		flex: 1;
		overflow-y: auto;
		scrollbar-width: thin;
		scrollbar-color: rgba(255,255,255,0.05) transparent;
	}

	.mf-item {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 16px;
		border-bottom: 1px solid rgba(255,255,255,0.03);
		text-decoration: none;
		transition: background 0.15s;
	}
	.mf-item:hover {
		background: rgba(255,255,255,0.02);
	}

	.mf-item-icon {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		background: rgba(16, 185, 129, 0.1);
		border: 1px solid rgba(16, 185, 129, 0.2);
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}
	.mf-buy-arrow {
		color: #10b981;
		font-size: 12px;
		font-weight: 700;
	}

	.mf-item-body {
		flex: 1;
		min-width: 0;
	}
	.mf-item-top {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 2px;
	}
	.mf-buyer {
		font-size: 11px;
		font-family: 'Space Mono', monospace;
		color: #94a3b8;
	}
	.mf-time {
		font-size: 10px;
		color: #475569;
		font-family: 'Space Mono', monospace;
	}
	.mf-item-detail {
		font-size: 12px;
		font-family: 'Space Mono', monospace;
	}

	.mf-empty {
		padding: 40px 16px;
		text-align: center;
		color: #475569;
		font-size: 12px;
		font-family: 'Space Mono', monospace;
	}
</style>
