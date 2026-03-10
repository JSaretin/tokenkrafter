<script lang="ts">
	import { ethers } from 'ethers';
	import { getContext, onMount } from 'svelte';
	import type { SupportedNetworks } from '$lib/structure';
	import { FACTORY_ABI, ERC20_ABI, TOKEN_ABI } from '$lib/tokenCrafter';

	let getUserAddress: () => string | null = getContext('userAddress');
	let connectWallet: () => Promise<boolean> = getContext('connectWallet');
	const addFeedback = getContext<(f: { message: string; type: string }) => void>('addFeedback');
	const supportedNetworks: SupportedNetworks = getContext('supportedNetworks');
	let getNetworkProviders: () => Map<number, ethers.JsonRpcProvider> = getContext('networkProviders');

	let userAddress = $derived(getUserAddress());
	let networkProviders = $derived(getNetworkProviders());

	type TokenItem = {
		address: string;
		network: (typeof supportedNetworks)[0];
		name?: string;
		symbol?: string;
		isMintable?: boolean;
		isTaxable?: boolean;
		isPartner?: boolean;
	};

	let tokens: TokenItem[] = $state([]);
	let isLoading = $state(true);
	let hasLoaded = $state(false);

	async function loadTokens() {
		if (!userAddress) return;
		isLoading = true;
		tokens = [];

		for (const net of supportedNetworks) {
			if (!net.platform_address || net.platform_address === '0x') continue;
			try {
				const p = networkProviders.get(net.chain_id) ?? new ethers.JsonRpcProvider(net.rpc);
				const platform = new ethers.Contract(net.platform_address, FACTORY_ABI, p);
				const addrs: string[] = await platform.getCreatedTokens(userAddress);

				for (const addr of addrs) {
					try {
						const contract = new ethers.Contract(addr, ERC20_ABI, p);
						const [name, symbol, info] = await Promise.all([
							contract.name(),
							contract.symbol(),
							platform.getTokenInfo(addr)
						]);
						tokens = [...tokens, {
							address: addr, network: net, name, symbol,
							isMintable: info.isMintable,
							isTaxable: info.isTaxable,
							isPartner: info.isPartnership
						}];
					} catch {
						tokens = [...tokens, { address: addr, network: net }];
					}
				}
			} catch (e) {
				console.error(`Failed to load tokens for ${net.name}`, e);
			}
		}

		hasLoaded = true;
		isLoading = false;
	}

	onMount(async () => {
		if (userAddress) {
			await loadTokens();
		} else {
			isLoading = false;
		}
	});

	function shortAddr(addr: string) {
		return addr.slice(0, 8) + '...' + addr.slice(-6);
	}

	async function handleConnect() {
		const ok = await connectWallet();
		if (ok) await loadTokens();
	}
</script>

<svelte:head>
	<title>My Tokens | TokenKrafter</title>
	<meta name="description" content="Manage your deployed tokens. Mint, burn, configure taxes, add DEX liquidity, and set up anti-whale protection." />
</svelte:head>

<div class="max-w-5xl mx-auto px-4 sm:px-6 py-12">
	<!-- Header -->
	<div class="flex items-start justify-between flex-wrap gap-4 mb-8">
		<div>
			<h1 class="syne text-3xl sm:text-4xl font-bold text-white">My Tokens</h1>
			<p class="text-gray-400 font-mono text-sm mt-2">
				{#if userAddress}
					Tokens deployed by <span class="text-cyan-400">{shortAddr(userAddress)}</span>
				{:else}
					Connect your wallet to view deployed tokens.
				{/if}
			</p>
		</div>
		<a href="/create" class="create-link syne">+ Create New Token</a>
	</div>

	{#if !userAddress}
		<!-- Not connected -->
		<div class="empty-state">
			<div class="text-5xl mb-4">🔗</div>
			<h2 class="syne text-xl font-bold text-white mb-2">Wallet Not Connected</h2>
			<p class="text-gray-400 font-mono text-sm mb-6">Connect your wallet to see your deployed tokens.</p>
			<button onclick={handleConnect} class="connect-btn syne cursor-pointer">Connect Wallet</button>
		</div>
	{:else if isLoading}
		<div class="loading-grid">
			{#each [0,1,2] as _}
				<div class="skeleton-card card"></div>
			{/each}
		</div>
	{:else if tokens.length === 0}
		<div class="empty-state">
			<div class="text-5xl mb-4">🪙</div>
			<h2 class="syne text-xl font-bold text-white mb-2">No Tokens Yet</h2>
			<p class="text-gray-400 font-mono text-sm mb-6">You haven't deployed any tokens. Create your first one!</p>
			<a href="/create" class="connect-btn syne no-underline">Create Your First Token</a>
		</div>
	{:else}
		<div class="tokens-grid">
			{#each tokens as token (token.address + token.network.chain_id)}
				<a
					href="/manage-tokens/{token.network.symbol}/{token.address}"
					class="token-card card card-hover no-underline group"
				>
					<div class="token-card-header">
						<div class="token-avatar syne">
							{token.symbol ? token.symbol.slice(0, 2).toUpperCase() : '??'}
						</div>
						<div class="token-card-meta">
							<div class="syne font-bold text-white group-hover:text-cyan-300 transition">
								{token.name ?? 'Unknown Token'}
							</div>
							<div class="text-xs text-gray-500 font-mono">{token.symbol ?? '—'}</div>
						</div>
						<div class="ml-auto text-gray-600 group-hover:text-cyan-400 transition text-lg">→</div>
					</div>

					<div class="token-card-body">
						<div class="token-info-row">
							<span class="token-info-label">Network</span>
							<span class="badge badge-emerald">{token.network.name}</span>
						</div>
						<div class="token-info-row">
							<span class="token-info-label">Contract</span>
							<span class="token-info-val">{shortAddr(token.address)}</span>
						</div>
						{#if token.isMintable || token.isTaxable || token.isPartner}
							<div class="token-badges">
								{#if token.isMintable}<span class="badge badge-cyan">Mintable</span>{/if}
								{#if token.isTaxable}<span class="badge badge-amber">Taxable</span>{/if}
								{#if token.isPartner}<span class="badge badge-purple">Partner</span>{/if}
							</div>
						{/if}
					</div>
				</a>
			{/each}
		</div>

		<div class="mt-6 text-center">
			<button onclick={loadTokens} class="btn-secondary text-xs px-4 py-2 cursor-pointer font-mono">
				↻ Refresh
			</button>
		</div>
	{/if}
</div>

<style>
	.syne { font-family: 'Syne', sans-serif; }

	.create-link {
		display: inline-block;
		padding: 10px 20px;
		background: linear-gradient(135deg, #00d2ff, #3a7bd5);
		color: white;
		border-radius: 10px;
		font-weight: 700;
		font-size: 14px;
		text-decoration: none;
		transition: all 0.2s;
	}
	.create-link:hover {
		transform: translateY(-1px);
		box-shadow: 0 6px 24px rgba(0,210,255,0.3);
	}

	.empty-state {
		text-align: center;
		padding: 80px 20px;
	}

	.connect-btn {
		display: inline-block;
		padding: 12px 28px;
		background: linear-gradient(135deg, #00d2ff, #3a7bd5);
		color: white;
		border: none;
		border-radius: 10px;
		font-weight: 700;
		font-size: 14px;
		transition: all 0.2s;
	}
	.connect-btn:hover {
		transform: translateY(-1px);
		box-shadow: 0 6px 24px rgba(0,210,255,0.3);
	}

	.tokens-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
		gap: 16px;
	}

	.loading-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
		gap: 16px;
	}

	.skeleton-card {
		height: 140px;
		border-radius: 16px;
		animation: pulse 1.5s ease-in-out infinite;
	}
	@keyframes pulse {
		0%, 100% { opacity: 0.4; }
		50% { opacity: 0.7; }
	}

	.token-card {
		padding: 20px;
		border-radius: 16px;
		text-decoration: none;
		display: block;
		transition: all 0.2s;
	}
	.token-card:hover {
		transform: translateY(-2px);
		box-shadow: 0 12px 40px rgba(0,0,0,0.3);
	}

	.token-card-header {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-bottom: 16px;
	}

	.token-avatar {
		width: 44px; height: 44px;
		border-radius: 12px;
		background: linear-gradient(135deg, rgba(0,210,255,0.2), rgba(99,102,241,0.2));
		border: 1px solid rgba(255,255,255,0.1);
		display: flex; align-items: center; justify-content: center;
		font-size: 14px; font-weight: 800; color: white;
		flex-shrink: 0;
	}

	.token-card-body { display: flex; flex-direction: column; gap: 6px; }

	.token-info-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	.token-info-label { font-size: 11px; color: #6b7280; font-family: 'Space Mono', monospace; }
	.token-info-val { font-size: 12px; color: #94a3b8; font-family: 'Space Mono', monospace; }

	.no-underline { text-decoration: none; }
	a.no-underline { text-decoration: none; }

	.token-badges { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }

	.badge { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
	.badge-emerald { background: rgba(16,185,129,0.1); color: #10b981; border: 1px solid rgba(16,185,129,0.2); }
	.badge-cyan { background: rgba(0,210,255,0.1); color: #00d2ff; border: 1px solid rgba(0,210,255,0.2); }
	.badge-amber { background: rgba(245,158,11,0.1); color: #f59e0b; border: 1px solid rgba(245,158,11,0.2); }
	.badge-purple { background: rgba(139,92,246,0.1); color: #a78bfa; border: 1px solid rgba(139,92,246,0.2); }

	.card {
		background: rgba(255,255,255,0.03);
		border: 1px solid rgba(255,255,255,0.07);
	}
	.card-hover { transition: all 0.2s; }
	.card-hover:hover {
		border-color: rgba(0,210,255,0.2);
		background: rgba(0,210,255,0.03);
	}

	.btn-secondary {
		background: rgba(255,255,255,0.05);
		color: #e2e8f0;
		padding: 10px 20px;
		border-radius: 10px;
		border: 1px solid rgba(255,255,255,0.1);
		cursor: pointer;
		transition: all 0.2s;
		font-size: 13px;
	}
	.btn-secondary:hover { background: rgba(255,255,255,0.08); }
</style>
