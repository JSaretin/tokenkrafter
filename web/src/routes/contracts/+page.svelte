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

<div class="max-w-[800px] mx-auto px-4 pt-6 pb-[60px]">
	<div class="mb-8">
		<h1 class="font-display text-[28px] font-extrabold text-heading m-0 mb-1.5">Contracts</h1>
		<p class="font-mono text-[13px] text-muted m-0">All smart contracts are verified and publicly accessible on the blockchain.</p>
	</div>

	{#each networks as network}
		<div class="mb-8">
			<div class="inline-flex items-center gap-2 mb-3.5">
				<span class="w-2 h-2 rounded-full bg-emerald-500"></span>
				<span class="font-display text-base font-bold text-heading">{network.name}</span>
				<span class="font-mono text-[11px] text-dim bg-surface px-2 py-0.5 rounded">Chain ID: {network.chain_id}</span>
			</div>

			<div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
				{#each CONTRACT_KEYS as key}
					{@const addr = (network as any)[key]}
					{@const info = CONTRACT_LABELS[key]}
					{#if addr && addr !== '' && addr !== '0x'}
						<div class="bg-surface border border-line rounded-xl px-4 py-3.5">
							<div class="flex justify-between items-center mb-1">
								<span class="font-display text-[13px] font-bold text-heading">{info.name}</span>
								{#if key === 'dex_router' || key === 'usdt_address' || key === 'usdc_address'}
									<span class="font-mono text-[9px] text-dim bg-surface-hover px-1.5 py-0.5 rounded">Third-party</span>
								{:else}
									<span class="font-mono text-[9px] text-[#00d2ff] bg-[rgba(0,210,255,0.08)] px-1.5 py-0.5 rounded">TokenKrafter</span>
								{/if}
							</div>
							<p class="font-mono text-[10px] text-muted m-0 mb-2.5 leading-[1.5]">{info.desc}</p>
							<div class="font-mono text-[11px] text-[#00d2ff] bg-surface rounded-lg px-2.5 py-2 break-all leading-[1.6] mb-2.5 border border-[rgba(0,210,255,0.08)]">{addr}</div>
							<div class="flex gap-1.5">
								<button class="inline-flex items-center gap-1 font-mono text-[11px] px-3 py-1.5 rounded-md border border-line bg-surface text-muted cursor-pointer transition-all duration-150 no-underline hover:border-[rgba(0,210,255,0.3)] hover:text-[#00d2ff]" onclick={() => copyAddr(addr)}>
									{#if copied === addr}
										<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
										Copied
									{:else}
										<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
										Copy
									{/if}
								</button>
								<a class="inline-flex items-center gap-1 font-mono text-[11px] px-3 py-1.5 rounded-md border border-line bg-surface text-muted cursor-pointer transition-all duration-150 no-underline hover:border-[rgba(16,185,129,0.3)] hover:text-emerald-500" href={explorerLink(network, addr)} target="_blank" rel="noopener">
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
