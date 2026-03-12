<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { setContext, onMount } from 'svelte';
	import { ethers } from 'ethers';
	import { initAppKit, getAppKit } from '$lib/wagmiConfig';
	import type { SupportedNetworks, SupportedNetwork, PaymentOption } from '$lib/structure';
	import { page } from '$app/state';

	let { children } = $props();

	const supportedNetworks: SupportedNetworks = [
		{
			chain_id: 1,
			name: 'Ethereum',
			symbol: 'ETH',
			native_coin: 'ETH',
			usdt_address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
			usdc_address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
			platform_address: '0x',
			launchpad_address: '0x',
			dex_router: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
			rpc: 'https://eth.llamarpc.com'
		},
		{
			chain_id: 56,
			name: 'Binance Smart Chain',
			symbol: 'BSC',
			native_coin: 'BNB',
			usdt_address: '0x55d398326f99059ff775485246999027b3197955',
			usdc_address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
			platform_address: '0x292ec5eEF8f0f5805574cD613b0C210936469Ba3',
			launchpad_address: '0xf2f50D4CD7Ad9c27e2033F289bD6bf0a2880F2d8',
			dex_router: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
			rpc: 'https://bsc-dataseed.binance.org/'
		}
	];

	// Network providers initialized in background
	let networkProviders: Map<number, ethers.JsonRpcProvider> = $state(new Map());
	let providersReady = $state(false);

	function getPaymentOptions(network: SupportedNetwork): PaymentOption[] {
		const nativeSymbol = network.native_coin;
		return [
			{ symbol: 'USDT', name: 'Tether USDT', address: network.usdt_address, decimals: network.chain_id === 56 ? 18 : 6 },
			{ symbol: 'USDC', name: 'USD Coin USDC', address: network.usdc_address, decimals: network.chain_id === 56 ? 18 : 6 },
			{ symbol: nativeSymbol, name: `${nativeSymbol} (Native)`, address: '0x0000000000000000000000000000000000000000', decimals: 18 }
		];
	}

	let feedbacks: { message: string; type: string; id: number }[] = $state([]);
	let feedbackCounter = 0;

	let provider: ethers.BrowserProvider | null = $state(null);
	let signer: ethers.Signer | null = $state(null);
	let userAddress: string | null = $state(null);
	let isConnecting = $state(false);
	let isLoading = $state(true);
	let mobileMenuOpen = $state(false);

	function addFeedback(feedback: { message: string; type: string }) {
		const id = feedbackCounter++;
		feedbacks = [...feedbacks, { ...feedback, id }];
		setTimeout(() => {
			feedbacks = feedbacks.filter((f) => f.id !== id);
		}, 5000);
	}

	function hideFeedback(id: number) {
		feedbacks = feedbacks.filter((f) => f.id !== id);
	}

	function getEthereum() {
		return (window as any).ethereum;
	}

	function formatAddress(addr: string) {
		return addr.slice(0, 6) + '...' + addr.slice(-4);
	}

	async function setupEthersFromProvider(ethProvider: any) {
		try {
			provider = new ethers.BrowserProvider(ethProvider);
			signer = await provider.getSigner();
			userAddress = await signer.getAddress();
		} catch (e) {
			console.error('Failed to setup ethers provider:', e);
		}
	}

	async function connectWallet() {
		const kit = getAppKit();
		if (!kit) {
			// Fallback to direct MetaMask if AppKit not initialized
			if (!getEthereum()) {
				addFeedback({ message: 'No wallet detected. Please install MetaMask.', type: 'error' });
				return false;
			}
			isConnecting = true;
			try {
				provider = new ethers.BrowserProvider(getEthereum());
				await provider.send('eth_requestAccounts', []);
				signer = await provider.getSigner();
				userAddress = await signer.getAddress();
				addFeedback({ message: 'Wallet connected!', type: 'success' });
				return true;
			} catch {
				addFeedback({ message: 'Connection failed. Try again.', type: 'error' });
				return false;
			} finally {
				isConnecting = false;
			}
		}
		await kit.open();
		return false;
	}

	function disconnectWallet() {
		const kit = getAppKit();
		if (kit) {
			kit.disconnect();
		}
		provider = null;
		signer = null;
		userAddress = null;
		addFeedback({ message: 'Wallet disconnected.', type: 'info' });
	}

	function initProviders() {
		const map = new Map<number, ethers.JsonRpcProvider>();
		for (const n of supportedNetworks) {
			if (!n.rpc) continue;
			const p = new ethers.JsonRpcProvider(n.rpc, n.chain_id, { staticNetwork: true });
			map.set(n.chain_id, p);
		}
		networkProviders = map;
		providersReady = true;
	}

	onMount(async () => {
		isLoading = false;
		// Initialize providers in background
		initProviders();

		// Initialize AppKit (Reown) for wallet connections
		const kit = await initAppKit();
		if (kit) {
			kit.subscribeAccount(async (account: any) => {
				if (account.isConnected && account.address) {
					// Get the underlying provider from AppKit
					const ethProvider = getEthereum();
					if (ethProvider) {
						await setupEthersFromProvider(ethProvider);
					}
				} else if (!account.isConnected) {
					provider = null;
					signer = null;
					userAddress = null;
				}
			});
		}

		// Capture referral from URL if not already stored
		const params = new URLSearchParams(window.location.search);
		const ref = params.get('ref');
		if (ref && ethers.isAddress(ref) && !localStorage.getItem('referral')) {
			localStorage.setItem('referral', ref);
		}
	});

	setContext('addFeedback', addFeedback);
	setContext('provider', () => provider);
	setContext('signer', () => signer);
	setContext('userAddress', () => userAddress);
	setContext('connectWallet', connectWallet);
	setContext('supportedNetworks', supportedNetworks);
	setContext('networkProviders', () => networkProviders);
	setContext('providersReady', () => providersReady);
	setContext('getPaymentOptions', getPaymentOptions);

	const navLinks = [
		{ href: '/', label: 'Home' },
		{ href: '/create', label: 'Create Token' },
		{ href: '/manage-tokens', label: 'My Tokens' },
		{ href: '/tokens', label: 'Explore' },
		{ href: '/affiliate', label: 'Affiliate' }
	];

	const socials = [
		{ label: 'X', href: 'https://x.com/TokenKrafter', svg: '<path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>' },
		{ label: 'Telegram Group', href: 'https://t.me/TokenKrafterGroup', svg: '<path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>' },
		{ label: 'Telegram Channel', href: 'https://t.me/TokenKrafterChannel', svg: '<path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>' },
		{ label: 'Discord', href: 'https://discord.gg/TokenKrafter', svg: '<path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189z"/>' },
		{ label: 'Facebook', href: 'https://facebook.com/TokenKrafter', svg: '<path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>' },
		{ label: 'YouTube', href: 'https://youtube.com/@TokenKrafter', svg: '<path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>' }
	];
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
	<link
		href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@400;600;700;800&display=swap"
		rel="stylesheet"
	/>
</svelte:head>

<!-- Toast Notifications -->
<div class="fixed top-4 right-4 z-[100] flex flex-col gap-2 max-w-sm w-full pointer-events-none px-4">
	{#each feedbacks as feedback (feedback.id)}
		<div
			class="toast pointer-events-auto flex items-start gap-3 p-4 rounded-lg border backdrop-blur-md
			{feedback.type === 'success'
				? 'bg-emerald-950/90 border-emerald-500/40 text-emerald-300'
				: feedback.type === 'error'
					? 'bg-red-950/90 border-red-500/40 text-red-300'
					: 'bg-cyan-950/90 border-cyan-500/40 text-cyan-300'}"
		>
			<span class="text-lg flex-shrink-0">
				{feedback.type === 'success' ? '✓' : feedback.type === 'error' ? '✕' : 'i'}
			</span>
			<span class="text-sm font-mono flex-1">{feedback.message}</span>
			<button
				onclick={() => hideFeedback(feedback.id)}
				class="text-current opacity-50 hover:opacity-100 transition ml-2 flex-shrink-0 cursor-pointer"
			>x</button>
		</div>
	{/each}
</div>

<!-- AppKit handles the wallet modal -->

<!-- App Shell -->
<div class="app-shell min-h-screen w-full overflow-x-hidden">
	<div class="grid-bg fixed inset-0 pointer-events-none z-0"></div>
	<div class="glow-orb fixed top-[-20%] left-[30%] w-[700px] h-[700px] pointer-events-none z-0"></div>
	<div class="glow-orb-2 fixed bottom-[-20%] right-[10%] w-[500px] h-[500px] pointer-events-none z-0"></div>

	<!-- Navbar -->
	<nav class="nav-bar fixed top-0 left-0 right-0 z-50 border-b border-white/5 backdrop-blur-xl">
		<div class="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
			<a href="/" class="flex items-center gap-2 flex-shrink-0 group">
				<div class="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-400 to-blue-600 flex items-center justify-center group-hover:shadow-lg group-hover:shadow-cyan-500/30 transition">
					<span class="text-black font-bold text-xs">TK</span>
				</div>
				<span class="syne font-bold text-white text-lg hidden sm:block tracking-tight">TokenKrafter</span>
			</a>

			<div class="hidden md:flex items-center gap-1">
				{#each navLinks as link}
					<a
						href={link.href}
						class="px-3 py-2 rounded-lg text-sm transition font-mono
						{page.url.pathname === link.href
							? 'text-cyan-400 bg-cyan-400/10'
							: 'text-gray-400 hover:text-white hover:bg-white/5'}"
					>{link.label}</a>
				{/each}
			</div>

			<div class="flex items-center gap-2">
				{#if userAddress}
					<div class="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
						<div class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></div>
						<span class="text-emerald-300 text-sm font-mono">{formatAddress(userAddress)}</span>
					</div>
					<button
						onclick={disconnectWallet}
						class="px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-red-400 hover:bg-red-500/10 border border-transparent hover:border-red-500/20 transition cursor-pointer font-mono"
					>Disconnect</button>
				{:else}
					<button
						onclick={connectWallet}
						class="connect-btn px-4 py-2 rounded-lg text-sm font-semibold cursor-pointer syne"
					>Connect Wallet</button>
				{/if}

				<button
					onclick={() => (mobileMenuOpen = !mobileMenuOpen)}
					class="md:hidden p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/5 transition cursor-pointer"
				>{#if mobileMenuOpen}x{:else}={/if}</button>
			</div>
		</div>

		{#if mobileMenuOpen}
			<div class="md:hidden border-t border-white/5 bg-[#0a0a0f]/95 backdrop-blur-xl">
				<div class="px-4 py-3 flex flex-col gap-1">
					{#each navLinks as link}
						<a
							href={link.href}
							onclick={() => (mobileMenuOpen = false)}
							class="px-3 py-2 rounded-lg text-sm transition font-mono
							{page.url.pathname === link.href
								? 'text-cyan-400 bg-cyan-400/10'
								: 'text-gray-400 hover:text-white hover:bg-white/5'}"
						>{link.label}</a>
					{/each}
					{#if userAddress}
						<div class="px-3 py-2 text-sm text-emerald-400 font-mono flex items-center gap-2">
							<div class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></div>
							{formatAddress(userAddress)}
						</div>
					{/if}
				</div>
			</div>
		{/if}
	</nav>

	<main class="pt-16 min-h-screen">
		{#if isLoading}
			<div class="flex items-center justify-center min-h-[80vh]">
				<div class="flex flex-col items-center gap-4">
					<div class="spinner w-12 h-12 rounded-full border-2 border-white/10 border-t-cyan-400"></div>
					<p class="text-gray-500 text-sm font-mono">Initializing...</p>
				</div>
			</div>
		{:else}
			{@render children?.()}
		{/if}
	</main>

	<!-- Footer -->
	<footer class="footer border-t border-white/5 mt-auto">
		<div class="max-w-7xl mx-auto px-4 sm:px-6 py-12">
			<div class="grid grid-cols-1 sm:grid-cols-3 gap-10 sm:gap-8">
				<!-- Brand -->
				<div>
					<a href="/" class="flex items-center gap-2 mb-4 group">
						<div class="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-400 to-blue-600 flex items-center justify-center group-hover:shadow-lg group-hover:shadow-cyan-500/30 transition">
							<span class="text-black font-bold text-xs">TK</span>
						</div>
						<span class="syne font-bold text-white text-lg tracking-tight">TokenKrafter</span>
					</a>
					<p class="text-sm text-gray-500 font-mono leading-relaxed max-w-xs">
						Deploy custom ERC-20 tokens across multiple chains. No coding required.
					</p>
				</div>

				<!-- Quick Links -->
				<div>
					<h4 class="syne font-bold text-white text-sm mb-4">Quick Links</h4>
					<div class="flex flex-col gap-2">
						{#each navLinks as link}
							<a href={link.href} class="text-sm text-gray-400 hover:text-cyan-400 transition font-mono">{link.label}</a>
						{/each}
					</div>
				</div>

				<!-- Community -->
				<div>
					<h4 class="syne font-bold text-white text-sm mb-4">Community</h4>
					<div class="flex flex-wrap gap-2">
						{#each socials as social}
							<a
								href={social.href}
								target="_blank"
								rel="noopener noreferrer"
								class="social-link flex items-center gap-2 px-3 py-2 rounded-lg border border-white/7 bg-white/3 hover:border-cyan-500/30 hover:bg-cyan-500/5 transition text-sm font-mono text-gray-400 hover:text-cyan-400"
								title={social.label}
							>
								<svg class="social-svg" viewBox="0 0 24 24" fill="currentColor">{@html social.svg}</svg>
								<span class="hidden sm:inline">{social.label}</span>
							</a>
						{/each}
					</div>
				</div>
			</div>

			<hr class="divider mt-10 mb-6" />

			<div class="flex flex-col sm:flex-row items-center justify-between gap-4">
				<p class="text-xs text-gray-600 font-mono">&copy; {new Date().getFullYear()} TokenKrafter. All rights reserved.</p>
				<div class="flex items-center gap-3">
					{#each socials as social}
						<a
							href={social.href}
							target="_blank"
							rel="noopener noreferrer"
							class="text-gray-600 hover:text-cyan-400 transition"
							title={social.label}
						><svg class="social-svg-sm" viewBox="0 0 24 24" fill="currentColor">{@html social.svg}</svg></a>
					{/each}
				</div>
			</div>
		</div>
	</footer>
</div>

<style>
	:global(*) { box-sizing: border-box; }
	:global(body) {
		background: #07070d;
		color: #e2e8f0;
		font-family: 'Space Mono', monospace;
		margin: 0;
	}
	.syne { font-family: 'Syne', sans-serif; }
	:global(.syne) { font-family: 'Syne', sans-serif; }

	.grid-bg {
		background-image:
			linear-gradient(rgba(0,255,255,0.018) 1px, transparent 1px),
			linear-gradient(90deg, rgba(0,255,255,0.018) 1px, transparent 1px);
		background-size: 60px 60px;
	}
	.glow-orb {
		background: radial-gradient(circle, rgba(0,210,255,0.07) 0%, transparent 70%);
		border-radius: 50%;
	}
	.glow-orb-2 {
		background: radial-gradient(circle, rgba(99,102,241,0.06) 0%, transparent 70%);
		border-radius: 50%;
	}
	.nav-bar { background: rgba(7,7,13,0.85); }
	.connect-btn {
		background: linear-gradient(135deg, #00d2ff, #3a7bd5);
		color: white;
		transition: all 0.2s;
	}
	.connect-btn:hover {
		opacity: 0.9;
		transform: translateY(-1px);
		box-shadow: 0 4px 24px rgba(0,210,255,0.35);
	}
	.toast { animation: slideIn 0.3s ease-out; }
	@keyframes slideIn {
		from { opacity: 0; transform: translateX(20px); }
		to   { opacity: 1; transform: translateX(0); }
	}
	.spinner { animation: spin 0.8s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }

	.footer { background: rgba(7,7,13,0.9); }
	.social-link {
		text-decoration: none;
	}
	.social-svg {
		width: 16px;
		height: 16px;
		flex-shrink: 0;
	}
	.social-svg-sm {
		width: 14px;
		height: 14px;
	}
</style>
