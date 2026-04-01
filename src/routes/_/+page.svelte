<script lang="ts">
	import { getContext } from 'svelte';
	import { ethers } from 'ethers';
	import { enhance } from '$app/forms';
	import { FACTORY_ABI } from '$lib/tokenCrafter';
	import type { SupportedNetworks } from '$lib/structure';
	import { t } from '$lib/i18n';

	import DashboardTab from './lib/DashboardTab.svelte';
	import FactoryTab from './lib/FactoryTab.svelte';
	import LaunchpadTab from './lib/LaunchpadTab.svelte';
	import WithdrawalsTab from './lib/WithdrawalsTab.svelte';

	let { data, form } = $props();

	let connectWallet: () => Promise<boolean> = getContext('connectWallet');
	let getUserAddress: () => string | null = getContext('userAddress');
	let supportedNetworks: SupportedNetworks = getContext('supportedNetworks');
	let getNetworkProviders: () => Map<number, ethers.JsonRpcProvider> = getContext('networkProviders');
	let getProvidersReady: () => boolean = getContext('providersReady');

	let userAddress = $derived(getUserAddress());
	let providersReady = $derived(getProvidersReady());
	let loginPassword = $state('');

	let selectedNetworkIdx = $state(0);
	let selectedNetwork = $derived(supportedNetworks[selectedNetworkIdx]);

	type TabKey = 'dashboard' | 'factory' | 'launchpad' | 'withdrawals';
	let activeTab = $state<TabKey>('dashboard');

	// Auth check
	let isOwner = $state(false);
	let factoryOwner = $state('');
	let loading = $state(false);

	const tabKeys: { key: TabKey; i18n: string; label: string; icon: string }[] = [
		{ key: 'dashboard', i18n: 'admin.tabDashboard', label: 'Dashboard', icon: '◈' },
		{ key: 'factory', i18n: 'admin.tabFees', label: 'Token Factory', icon: '⬡' },
		{ key: 'launchpad', i18n: 'admin.tabLaunchpad', label: 'Launchpad', icon: '◉' },
		{ key: 'withdrawals', i18n: 'admin.tabWithdrawals', label: 'Withdrawals', icon: '₦' }
	];

	async function checkOwner() {
		if (!selectedNetwork?.platform_address || selectedNetwork.platform_address === '0x') return;
		loading = true;
		try {
			const providers = getNetworkProviders();
			const provider = providers.get(selectedNetwork.chain_id);
			if (!provider) return;

			const contract = new ethers.Contract(selectedNetwork.platform_address, FACTORY_ABI, provider);
			factoryOwner = await contract.owner();
			isOwner = userAddress ? userAddress.toLowerCase() === factoryOwner.toLowerCase() : false;
		} catch {
			factoryOwner = '';
			isOwner = false;
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		if (providersReady && selectedNetwork) {
			checkOwner();
		}
	});

	$effect(() => {
		if (userAddress && factoryOwner) {
			isOwner = userAddress.toLowerCase() === factoryOwner.toLowerCase();
		}
	});
</script>

<svelte:head>
	<title>{data.authenticated ? 'Admin Dashboard' : 'Login'} | TokenKrafter</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

{#if !data.authenticated}
	<!-- Login -->
	<div class="login-wrap">
		<div class="login-card">
			<h1 class="syne text-2xl font-bold text-white mb-6 text-center">Admin Access</h1>
			{#if form?.error}
				<div class="login-error">{form.error}</div>
			{/if}
			<form method="POST" action="?/login" use:enhance>
				<input
					type="password"
					name="password"
					class="input-field mb-4"
					placeholder="Enter admin password"
					bind:value={loginPassword}
					autocomplete="current-password"
				/>
				<button type="submit" class="btn-primary w-full py-3 text-sm cursor-pointer">
					Login
				</button>
			</form>
		</div>
	</div>
{:else}
<div class="page-wrap">
	<!-- Logout button -->
	<form method="POST" action="?/logout" use:enhance class="fixed top-20 right-4 z-50">
		<button type="submit" class="text-xs font-mono text-gray-600 hover:text-red-400 transition cursor-pointer">Logout</button>
	</form>

	<section class="max-w-6xl mx-auto px-4 sm:px-6 pt-10 pb-6">
		<h1 class="text-3xl sm:text-4xl font-bold text-white mb-2" style="font-family: 'Rajdhani', sans-serif; font-weight: 700;">{$t('admin.title')}</h1>
		<p class="text-gray-500 text-sm font-mono mb-6">{$t('admin.subtitle')}</p>

		<!-- Network selector -->
		<div class="flex flex-wrap items-center gap-3 mb-6">
			<label class="label-text mb-0">{$t('admin.network')}</label>
			<select class="input-field max-w-xs" bind:value={selectedNetworkIdx}>
				{#each supportedNetworks as net, i}
					{#if net.platform_address && net.platform_address !== '0x'}
						<option value={i}>{net.name} ({net.symbol})</option>
					{/if}
				{/each}
			</select>
			{#if !userAddress}
				<button onclick={connectWallet} class="btn-primary text-xs px-4 py-2 cursor-pointer">{$t('common.connectWallet')}</button>
			{/if}
		</div>

		{#if loading}
			<div class="flex items-center justify-center py-20">
				<div class="spinner w-10 h-10 rounded-full border-2 border-white/10 border-t-cyan-400"></div>
			</div>
		{:else if !selectedNetwork?.platform_address || selectedNetwork.platform_address === '0x'}
			<div class="card p-8 text-center">
				<p class="text-gray-400">{$t('admin.factoryNotDeployed').replace('{network}', selectedNetwork?.name || 'this network')}</p>
			</div>
		{:else if !isOwner && factoryOwner}
			<div class="card p-8 text-center">
				<p class="text-gray-400 mb-2">{$t('admin.ownerOnly')}</p>
				<p class="text-xs text-gray-600 font-mono">{$t('admin.ownerLabel')}: {factoryOwner}</p>
				{#if userAddress}
					<p class="text-xs text-gray-600 font-mono mt-1">{$t('admin.youLabel')}: {userAddress}</p>
				{/if}
			</div>
		{:else}
			<!-- Tabs -->
			<div class="tabs-row flex gap-2 mb-6">
				{#each tabKeys as tab}
					<button
						onclick={() => (activeTab = tab.key)}
						class="tab-btn-new transition cursor-pointer
						{activeTab === tab.key ? 'active' : ''}"
					>
						<span class="tab-icon">{tab.icon}</span>
						<span class="tab-text">{tab.label}</span>
					</button>
				{/each}
			</div>

			{#if activeTab === 'dashboard'}
				<DashboardTab />
			{:else if activeTab === 'factory'}
				<FactoryTab selectedNetwork={selectedNetwork} />
			{:else if activeTab === 'launchpad'}
				<LaunchpadTab selectedNetwork={selectedNetwork} />
			{:else if activeTab === 'withdrawals'}
				<WithdrawalsTab />
			{/if}
		{/if}
	</section>
</div>
{/if}

<style>
	.login-wrap {
		min-height: calc(100vh - 140px);
		display: flex; align-items: center; justify-content: center;
		padding: 20px;
	}
	.login-card {
		width: 100%; max-width: 360px;
		background: var(--bg-surface); border: 1px solid var(--border);
		border-radius: 16px; padding: 32px 24px;
	}
	.login-error {
		background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.2);
		color: #f87171; border-radius: 8px; padding: 10px 14px;
		font-family: 'Space Mono', monospace; font-size: 12px; margin-bottom: 16px;
	}
	.syne { font-family: 'Syne', sans-serif; }
	@font-face { font-family: 'Rajdhani'; font-weight: 300; font-display: swap; src: url('/fonts/rajdhani-300.woff2') format('woff2'); }
	@font-face { font-family: 'Rajdhani'; font-weight: 400; font-display: swap; src: url('/fonts/rajdhani-400.woff2') format('woff2'); }
	@font-face { font-family: 'Rajdhani'; font-weight: 500; font-display: swap; src: url('/fonts/rajdhani-500.woff2') format('woff2'); }
	@font-face { font-family: 'Rajdhani'; font-weight: 600; font-display: swap; src: url('/fonts/rajdhani-600.woff2') format('woff2'); }
	@font-face { font-family: 'Rajdhani'; font-weight: 700; font-display: swap; src: url('/fonts/rajdhani-700.woff2') format('woff2'); }

	.page-wrap { padding-bottom: 40px; font-family: 'Rajdhani', sans-serif; }

	.tab-btn-new {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 18px;
		background: var(--bg-surface);
		border: 1px solid var(--border);
		border-radius: 10px;
		color: #64748b;
		font-family: 'Rajdhani', sans-serif;
		font-size: 14px;
		font-weight: 500;
		letter-spacing: 0.03em;
	}
	.tab-btn-new:hover { background: var(--bg-surface-hover); color: var(--text); border-color: rgba(255,255,255,0.1); }
	.tab-btn-new.active {
		background: rgba(0,210,255,0.06);
		border-color: rgba(0,210,255,0.25);
		color: #00d2ff;
		font-weight: 600;
	}
	.tab-icon { font-size: 16px; line-height: 1; }
	.tab-text { line-height: 1; }

	select option { background: var(--select-bg); }

	.spinner {
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }
</style>
