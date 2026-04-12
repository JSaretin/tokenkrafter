<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import { ethers } from 'ethers';
	import type { SupportedNetworks } from '$lib/structure';
	import { t } from '$lib/i18n';

	import DashboardTab from './lib/DashboardTab.svelte';
	import FactoryTab from './lib/FactoryTab.svelte';
	import LaunchpadTab from './lib/LaunchpadTab.svelte';
	import PlatformRouterTab from './lib/PlatformRouterTab.svelte';
	import WithdrawalsTab from './lib/WithdrawalsTab.svelte';
	import TradeRouterTab from './lib/TradeRouterTab.svelte';
	import ConfigTab from './lib/ConfigTab.svelte';

	let getSigner: () => ethers.Signer | null = getContext('signer');
	let connectWallet: () => Promise<boolean> = getContext('connectWallet');
	let getUserAddress: () => string | null = getContext('userAddress');
	let _getNetworks: () => SupportedNetworks = getContext('supportedNetworks');
	let supportedNetworks = $derived(_getNetworks());
	const addFeedback = getContext<(f: { message: string; type: string }) => void>('addFeedback');

	let signer = $derived(getSigner());
	let userAddress = $derived(getUserAddress());

	let selectedNetworkIdx = $state(0);
	let selectedNetwork = $derived(supportedNetworks[selectedNetworkIdx]);

	type TabKey = 'dashboard' | 'factory' | 'launchpad' | 'platform-router' | 'withdrawals' | 'trade-router' | 'config';
	let activeTab = $state<TabKey>('dashboard');

	// Admin auth — wallet signature verified against ADMIN_WALLETS env
	let authenticated = $state(false);
	let authError = $state('');
	let authLoading = $state(false);
	let sessionChecked = $state(false);

	// Check existing session on page load
	onMount(async () => {
		try {
			const res = await fetch('/api/admin/verify');
			if (res.ok) {
				const data = await res.json();
				if (data.ok) authenticated = true;
			}
		} catch {}
		sessionChecked = true;
	});

	const tabKeys: { key: TabKey; i18n: string; label: string; icon: string }[] = [
		{ key: 'dashboard', i18n: 'admin.tabDashboard', label: 'Dashboard', icon: '◈' },
		{ key: 'factory', i18n: 'admin.tabFees', label: 'Token Factory', icon: '⬡' },
		{ key: 'launchpad', i18n: 'admin.tabLaunchpad', label: 'Launchpad', icon: '◉' },
		{ key: 'platform-router', i18n: 'admin.tabPlatformRouter', label: 'Platform Router', icon: '◎' },
		{ key: 'withdrawals', i18n: 'admin.tabWithdrawals', label: 'Withdrawals', icon: '₦' },
		{ key: 'trade-router', i18n: 'admin.tabTradeRouter', label: 'Trade Router', icon: '⇄' },
		{ key: 'config', i18n: 'admin.tabConfig', label: 'Config', icon: '⚙' }
	];

	async function authenticate() {
		if (!signer || !userAddress) {
			await connectWallet();
			return;
		}

		authLoading = true;
		authError = '';
		try {
			const timestamp = Date.now();
			const message = `TokenKrafter Admin\nAction: authenticate\nOrigin: ${window.location.origin}\nTimestamp: ${timestamp}`;
			const signature = await signer.signMessage(message);

			const res = await fetch('/api/admin/verify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ signature, signed_message: message })
			});

			if (!res.ok) {
				const err = await res.json().catch(() => ({ message: 'Not authorized' }));
				throw new Error(err.message || 'Not authorized');
			}

			authenticated = true;
			addFeedback({ message: 'Admin authenticated', type: 'success' });
		} catch (e: any) {
			authError = e.message || 'Authentication failed';
			authenticated = false;
		} finally {
			authLoading = false;
		}
	}

	async function logout() {
		await fetch('/api/admin/verify', { method: 'DELETE' });
		authenticated = false;
		authError = '';
	}
</script>

<svelte:head>
	<title>{authenticated ? 'Admin Dashboard' : 'Admin Login'} | TokenKrafter</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

{#if !sessionChecked}
	<!-- Checking session -->
	<div class="login-wrap">
		<div class="login-card" style="text-align: center;">
			<div class="auth-spinner" style="margin: 0 auto;"></div>
		</div>
	</div>
{:else if !authenticated}
	<!-- Authenticate with wallet -->
	<div class="login-wrap">
		<div class="login-card">
			<div class="login-icon">
				<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#00d2ff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
					<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M22 10H18a2 2 0 000 4h4"/><circle cx="18" cy="12" r="0.5" fill="#00d2ff"/>
				</svg>
			</div>
			<h1 class="login-title">Admin Access</h1>
			<p class="login-sub">Sign with your wallet to verify admin access</p>

			{#if authError}
				<div class="login-error">{authError}</div>
			{/if}

			{#if !userAddress}
				<button onclick={connectWallet} class="auth-btn">
					Connect Wallet
				</button>
			{:else}
				<div class="wallet-badge">
					<span class="wallet-dot"></span>
					{userAddress.slice(0, 6)}...{userAddress.slice(-4)}
				</div>
				<button onclick={authenticate} class="auth-btn" disabled={authLoading}>
					{#if authLoading}
						<div class="auth-spinner"></div>
						Verifying...
					{:else}
						Authenticate
					{/if}
				</button>
			{/if}
		</div>
	</div>
{:else}
	<div class="page-wrap">
		<!-- Logout -->
		<button onclick={logout} class="logout-btn">
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>
			Logout
		</button>

		<section class="max-w-6xl mx-auto px-4 sm:px-6 pt-10 pb-6">
			<h1 class="page-title">{$t('admin.title')}</h1>
			<p class="page-sub">{$t('admin.subtitle')}</p>

			{#if !userAddress}
				<!-- Session valid but wallet not connected yet -->
				<div class="card p-8 text-center">
					<p class="text-gray-400 mb-4">Connect your wallet to access the dashboard</p>
					<button onclick={connectWallet} class="auth-btn" style="max-width: 280px; margin: 0 auto;">Connect Wallet</button>
				</div>
			{:else}

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
				<span class="wallet-badge-sm">
					{userAddress.slice(0, 6)}...{userAddress.slice(-4)}
				</span>
			</div>

			<!-- Tabs -->
			<div class="tabs-row flex gap-2 mb-6 flex-wrap">
				{#each tabKeys as tab}
					<button
						onclick={() => (activeTab = tab.key)}
						class="tab-btn-new transition cursor-pointer {activeTab === tab.key ? 'active' : ''}"
					>
						<span class="tab-icon">{tab.icon}</span>
						<span class="tab-text">{tab.label}</span>
					</button>
				{/each}
			</div>

			{#if activeTab === 'dashboard'}
				<DashboardTab />
			{:else if activeTab === 'factory' && selectedNetwork}
				<FactoryTab selectedNetwork={selectedNetwork} />
			{:else if activeTab === 'launchpad' && selectedNetwork}
				<LaunchpadTab selectedNetwork={selectedNetwork} />
			{:else if activeTab === 'platform-router' && selectedNetwork}
				<PlatformRouterTab selectedNetwork={selectedNetwork} />
			{:else if activeTab === 'withdrawals'}
				<WithdrawalsTab />
			{:else if activeTab === 'trade-router' && selectedNetwork}
				<TradeRouterTab selectedNetwork={selectedNetwork} />
			{:else if activeTab === 'config'}
				<ConfigTab />
			{/if}

			{/if}
		</section>
	</div>
{/if}

<style>
	/* ═══ Login ═══ */
	.login-wrap {
		min-height: calc(100vh - 140px);
		display: flex; align-items: center; justify-content: center;
		padding: 20px;
	}
	.login-card {
		width: 100%; max-width: 380px;
		background: var(--bg-surface); border: 1px solid var(--border);
		border-radius: 20px; padding: 40px 28px; text-align: center;
	}
	.login-icon {
		width: 60px; height: 60px; border-radius: 16px; margin: 0 auto 16px;
		background: rgba(0,210,255,0.06); border: 1px solid rgba(0,210,255,0.15);
		display: flex; align-items: center; justify-content: center;
	}
	.login-title {
		font-family: 'Syne', sans-serif; font-size: 22px; font-weight: 800;
		color: var(--text-heading); margin: 0 0 6px;
	}
	.login-sub {
		font-family: 'Space Mono', monospace; font-size: 12px;
		color: var(--text-muted); margin: 0 0 24px;
	}
	.login-error {
		background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.2);
		color: #f87171; border-radius: 10px; padding: 10px 14px;
		font-family: 'Space Mono', monospace; font-size: 12px; margin-bottom: 16px;
		text-align: left;
	}
	.wallet-badge {
		display: inline-flex; align-items: center; gap: 8px;
		padding: 8px 16px; border-radius: 20px; margin-bottom: 16px;
		background: rgba(16,185,129,0.06); border: 1px solid rgba(16,185,129,0.15);
		font-family: 'Space Mono', monospace; font-size: 12px; color: #10b981; font-weight: 700;
	}
	.wallet-dot {
		width: 6px; height: 6px; border-radius: 50%; background: #10b981;
	}
	.auth-btn {
		width: 100%; padding: 14px 0; border-radius: 14px; border: none; cursor: pointer;
		background: linear-gradient(135deg, #00d2ff, #3a7bd5);
		color: white; font-family: 'Syne', sans-serif; font-size: 15px; font-weight: 700;
		transition: all 200ms; display: flex; align-items: center; justify-content: center; gap: 8px;
	}
	.auth-btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 6px 28px rgba(0,210,255,0.3); }
	.auth-btn:disabled { opacity: 0.6; cursor: not-allowed; }
	.auth-spinner {
		width: 16px; height: 16px; border: 2px solid rgba(255,255,255,0.3);
		border-top-color: white; border-radius: 50%; animation: spin 0.8s linear infinite;
	}

	/* ═══ Dashboard ═══ */
	.page-wrap { padding-bottom: 40px; font-family: 'Rajdhani', sans-serif; }
	.page-title {
		font-size: clamp(1.8rem, 4vw, 2.5rem); font-weight: 700; color: var(--text-heading);
		font-family: 'Rajdhani', sans-serif; margin: 0 0 4px;
	}
	.page-sub {
		color: var(--text-muted); font-size: 14px; font-family: 'Space Mono', monospace; margin: 0 0 24px;
	}
	.logout-btn {
		position: fixed; top: 76px; right: 16px; z-index: 50;
		display: flex; align-items: center; gap: 5px; padding: 6px 12px;
		border-radius: 8px; border: 1px solid var(--border); background: var(--bg-surface);
		color: var(--text-muted); font-family: 'Space Mono', monospace; font-size: 11px;
		cursor: pointer; transition: all 150ms;
	}
	.logout-btn:hover { color: #f87171; border-color: rgba(239,68,68,0.3); background: rgba(239,68,68,0.05); }
	.wallet-badge-sm {
		font-family: 'Space Mono', monospace; font-size: 11px; color: #10b981;
		background: rgba(16,185,129,0.06); border: 1px solid rgba(16,185,129,0.12);
		padding: 4px 10px; border-radius: 8px;
	}

	/* ═══ Tabs ═══ */
	.tab-btn-new {
		display: flex; align-items: center; gap: 8px; padding: 10px 18px;
		background: var(--bg-surface); border: 1px solid var(--border); border-radius: 10px;
		color: #64748b; font-family: 'Rajdhani', sans-serif; font-size: 14px;
		font-weight: 500; letter-spacing: 0.03em;
	}
	.tab-btn-new:hover { background: var(--bg-surface-hover); color: var(--text); border-color: rgba(255,255,255,0.1); }
	.tab-btn-new.active {
		background: rgba(0,210,255,0.06); border-color: rgba(0,210,255,0.25);
		color: #00d2ff; font-weight: 600;
	}
	.tab-icon { font-size: 16px; line-height: 1; }
	.tab-text { line-height: 1; }

	select option { background: var(--select-bg); }

	@font-face { font-family: 'Rajdhani'; font-weight: 300; font-display: swap; src: url('/fonts/rajdhani-300.woff2') format('woff2'); }
	@font-face { font-family: 'Rajdhani'; font-weight: 400; font-display: swap; src: url('/fonts/rajdhani-400.woff2') format('woff2'); }
	@font-face { font-family: 'Rajdhani'; font-weight: 500; font-display: swap; src: url('/fonts/rajdhani-500.woff2') format('woff2'); }
	@font-face { font-family: 'Rajdhani'; font-weight: 600; font-display: swap; src: url('/fonts/rajdhani-600.woff2') format('woff2'); }
	@font-face { font-family: 'Rajdhani'; font-weight: 700; font-display: swap; src: url('/fonts/rajdhani-700.woff2') format('woff2'); }

	@keyframes spin { to { transform: rotate(360deg); } }
</style>
