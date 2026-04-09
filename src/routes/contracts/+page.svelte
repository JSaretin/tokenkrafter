<script lang="ts">
	import { getContext } from 'svelte';
	import type { SupportedNetwork } from '$lib/structure';

	let _getNetworks: () => SupportedNetwork[] = getContext('supportedNetworks');
	let networks = $derived(_getNetworks());

	const CONTRACT_LABELS: Record<string, { name: string; desc: string }> = {
		platform_address: { name: 'Token Factory', desc: 'Creates all token contracts via EIP-1167 minimal proxies' },
		router_address: { name: 'Platform Router', desc: 'One-click token creation with tax, protection, and DEX listing' },
		launchpad_address: { name: 'Launchpad Factory', desc: 'Bonding curve launches with auto-graduation to DEX' },
		trade_router_address: { name: 'Trade Router', desc: 'Swap routing and fiat off-ramp escrow' },
		dex_router: { name: 'DEX Router', desc: 'PancakeSwap V2 Router (third-party)' },
		usdt_address: { name: 'USDT', desc: 'Tether USD stablecoin' },
		usdc_address: { name: 'USDC', desc: 'USD Coin stablecoin' },
	};

	const CONTRACT_KEYS = ['platform_address', 'router_address', 'launchpad_address', 'trade_router_address', 'dex_router', 'usdt_address', 'usdc_address'] as const;

	function explorerLink(network: SupportedNetwork, addr: string): string {
		const base = network.explorer_url || 'https://bscscan.com';
		return `${base}/address/${addr}`;
	}

	let copied = $state('');
	function copyAddr(addr: string) {
		navigator.clipboard.writeText(addr);
		copied = addr;
		setTimeout(() => { if (copied === addr) copied = ''; }, 2000);
	}
</script>

<svelte:head>
	<title>Contracts | TokenKrafter</title>
	<meta name="description" content="TokenKrafter smart contract addresses — verify on-chain." />
</svelte:head>

<div class="contracts-page">
	<div class="contracts-header">
		<h1 class="syne contracts-title">Contracts</h1>
		<p class="contracts-sub">All smart contracts are verified and publicly accessible on the blockchain.</p>
	</div>

	{#each networks as network}
		<div class="network-section">
			<div class="network-badge">
				<span class="network-dot"></span>
				<span class="network-name">{network.name}</span>
				<span class="network-chain">Chain ID: {network.chain_id}</span>
			</div>

			<div class="contracts-grid">
				{#each CONTRACT_KEYS as key}
					{@const addr = (network as any)[key]}
					{@const info = CONTRACT_LABELS[key]}
					{#if addr && addr !== '' && addr !== '0x'}
						<div class="contract-card">
							<div class="contract-header">
								<span class="contract-name">{info.name}</span>
								{#if key === 'dex_router' || key === 'usdt_address' || key === 'usdc_address'}
									<span class="contract-tag">Third-party</span>
								{:else}
									<span class="contract-tag contract-tag-own">TokenKrafter</span>
								{/if}
							</div>
							<p class="contract-desc">{info.desc}</p>
							<div class="contract-addr-full">{addr}</div>
							<div class="contract-btns">
								<button class="contract-btn" onclick={() => copyAddr(addr)}>
									{#if copied === addr}
										<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
										Copied
									{:else}
										<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
										Copy
									{/if}
								</button>
								<a class="contract-btn contract-btn-explorer" href={explorerLink(network, addr)} target="_blank" rel="noopener">
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
									View on Explorer
								</a>
							</div>
						</div>
					{/if}
				{/each}
			</div>
		</div>
	{/each}
</div>

<style>
	.contracts-page {
		max-width: 800px; margin: 0 auto; padding: 24px 16px 60px;
	}
	.contracts-header { margin-bottom: 32px; }
	.contracts-title { font-size: 28px; font-weight: 800; color: var(--text-heading); margin: 0 0 6px; }
	.contracts-sub { font-family: 'Space Mono', monospace; font-size: 13px; color: var(--text-muted); margin: 0; }

	.network-section { margin-bottom: 32px; }
	.network-badge {
		display: inline-flex; align-items: center; gap: 8px;
		margin-bottom: 14px;
	}
	.network-dot {
		width: 8px; height: 8px; border-radius: 50%; background: #10b981;
	}
	.network-name {
		font-family: 'Syne', sans-serif; font-size: 16px; font-weight: 700; color: var(--text-heading);
	}
	.network-chain {
		font-family: 'Space Mono', monospace; font-size: 11px; color: var(--text-dim);
		background: var(--bg-surface); padding: 2px 8px; border-radius: 4px;
	}

	.contracts-grid {
		display: grid; grid-template-columns: 1fr; gap: 10px;
	}
	@media (min-width: 640px) {
		.contracts-grid { grid-template-columns: 1fr 1fr; }
	}

	.contract-card {
		background: var(--bg-surface); border: 1px solid var(--border);
		border-radius: 12px; padding: 14px 16px;
	}
	.contract-header {
		display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;
	}
	.contract-name {
		font-family: 'Syne', sans-serif; font-size: 13px; font-weight: 700; color: var(--text-heading);
	}
	.contract-tag {
		font-family: 'Space Mono', monospace; font-size: 9px;
		color: var(--text-dim); background: var(--bg-surface-hover);
		padding: 2px 6px; border-radius: 4px;
	}
	.contract-tag-own {
		color: #00d2ff; background: rgba(0,210,255,0.08);
	}
	.contract-desc {
		font-family: 'Space Mono', monospace; font-size: 10px;
		color: var(--text-muted); margin: 0 0 10px; line-height: 1.5;
	}
	.contract-addr-full {
		font-family: 'Space Mono', monospace; font-size: 11px; color: #00d2ff;
		background: rgba(255,255,255,0.02); border-radius: 8px; padding: 8px 10px;
		word-break: break-all; line-height: 1.6; margin-bottom: 10px;
		border: 1px solid rgba(0,210,255,0.08);
	}
	.contract-btns { display: flex; gap: 6px; }
	.contract-btn {
		display: inline-flex; align-items: center; gap: 5px;
		font-family: 'Space Mono', monospace; font-size: 11px;
		padding: 6px 12px; border-radius: 6px; border: 1px solid var(--border);
		background: var(--bg-surface); color: var(--text-muted);
		cursor: pointer; transition: all 0.15s; text-decoration: none;
	}
	.contract-btn:hover { border-color: rgba(0,210,255,0.3); color: #00d2ff; }
	.contract-btn-explorer { color: var(--text-muted); }
	.contract-btn-explorer:hover { border-color: rgba(16,185,129,0.3); color: #10b981; }
</style>
