<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { setContext, onMount } from 'svelte';
	import { ethers } from 'ethers';
	import { initAppKit, getAppKit } from '$lib/wagmiConfig';
	import type { SupportedNetworks, SupportedNetwork, PaymentOption } from '$lib/structure';
	import { page } from '$app/state';
	import { t } from '$lib/i18n';
	import LanguageSwitcher from '$lib/LanguageSwitcher.svelte';

	let { children } = $props();

	const supportedNetworks: SupportedNetworks = [
		{
			chain_id: 31337,
			name: 'Localhost',
			symbol: 'LOCAL',
			native_coin: 'ETH',
			usdt_address: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
			usdc_address: '',
			platform_address: '0x0B306BF915C4d645ff596e518fAf3F9669b97016',
			launchpad_address: '0x959922bE3CAee4b8Cd9a407cc3ac1C251C2007B1',
			router_address: '0x7a2088a1bFc9d81c55368AE168C2C02570cB814F',
			dex_router: '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9',
			trade_router_address: '0x09635F643e140090A9A8Dcd712eD6285858ceBef',
			rpc: 'http://127.0.0.1:8545'
		}
		// {
		// 	chain_id: 1,
		// 	name: 'Ethereum',
		// 	symbol: 'ETH',
		// 	native_coin: 'ETH',
		// 	usdt_address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
		// 	usdc_address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
		// 	platform_address: '0x',
		// 	launchpad_address: '0x',
		// 	dex_router: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
		// 	rpc: 'https://eth.llamarpc.com'
		// },
		// {
		// 	chain_id: 56,
		// 	name: 'Binance Smart Chain',
		// 	symbol: 'BSC',
		// 	native_coin: 'BNB',
		// 	usdt_address: '0x55d398326f99059ff775485246999027b3197955',
		// 	usdc_address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
		// 	platform_address: '0xf8953948561d3047b15006915669d2814b9f0e5d',
		// 	launchpad_address: '0x9a7c5e6a4343E881152d3D4A8709289B4f46E071',
		// 	dex_router: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
		// 	rpc: 'https://bsc-dataseed.binance.org/'
		// },
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
	let isLoading = $state(true);
	let mobileMenuOpen = $state(false);
	let mobileMenuEl: HTMLElement | undefined = $state(undefined);
	let hamburgerEl: HTMLElement | undefined = $state(undefined);
	let theme: 'dark' | 'light' = $state('dark');

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

	function applyTheme(t: 'dark' | 'light') {
		theme = t;
		document.documentElement.classList.toggle('light', t === 'light');
		localStorage.setItem('theme', t);
		const kit = getAppKit();
		if (kit) kit.setThemeMode(t);
	}

	function toggleTheme() {
		applyTheme(theme === 'dark' ? 'light' : 'dark');
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
		if (kit) {
			await kit.open();
		}
		return false;
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
		// Restore theme from localStorage
		const saved = localStorage.getItem('theme') as 'dark' | 'light' | null;
		if (saved === 'light') applyTheme('light');

		// Initialize providers in background
		initProviders();

		// Initialize AppKit (Reown) for wallet connections
		const kit = await initAppKit();
		if (kit) {
			if (theme === 'light') kit.setThemeMode('light');
			kit.subscribeAccount(async (account: any) => {
				if (account.isConnected && account.address) {
					const walletProvider = kit.getWalletProvider();
					if (walletProvider) {
						await setupEthersFromProvider(walletProvider);
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

		// Close mobile menu when clicking outside
		function handleClickOutside(e: MouseEvent) {
			if (
				mobileMenuOpen &&
				mobileMenuEl &&
				!mobileMenuEl.contains(e.target as Node) &&
				hamburgerEl &&
				!hamburgerEl.contains(e.target as Node)
			) {
				mobileMenuOpen = false;
			}
		}
		document.addEventListener('click', handleClickOutside);

		return () => {
			document.removeEventListener('click', handleClickOutside);
		};
	});

	$effect(() => {
		if (typeof document !== 'undefined') {
			document.body.style.overflow = mobileMenuOpen ? 'hidden' : '';
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

	// Primary nav — only the core pages users need
	const navLinks: { href: string; key: import('$lib/i18n').TranslationKey }[] = [
		{ href: '/launchpad', key: 'nav.launchpad' },
		{ href: '/trade', key: 'nav.trade' },
		{ href: '/create', key: 'nav.createToken' },
		{ href: '/tokens', key: 'nav.explore' },
	];

	// Secondary nav — shown in mobile drawer and footer only
	const secondaryLinks: { href: string; key: import('$lib/i18n').TranslationKey }[] = [
		{ href: '/manage-tokens', key: 'nav.manageTokens' },
		{ href: '/affiliate', key: 'nav.affiliate' },
		{ href: '/admin', key: 'nav.admin' },
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
	{@html '<script>try{if(localStorage.getItem("theme")==="light")document.documentElement.classList.add("light")}catch(e){}</script>'}
	<link rel="icon" href={favicon} />
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
	<link
		href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@400;600;700;800&display=swap"
		rel="stylesheet"
	/>
</svelte:head>

<!-- Skip to content -->
<a
	href="#main-content"
	class="skip-to-content"
>Skip to main content</a>

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
				aria-label="Dismiss notification"
			>x</button>
		</div>
	{/each}
</div>

<!-- AppKit handles the wallet modal -->

<!-- App Shell — flex column, viewport height -->
<div class="app-shell flex flex-col h-screen w-full overflow-hidden">
	<div class="grid-bg fixed inset-0 pointer-events-none z-0"></div>
	<div class="glow-orb fixed top-[-20%] left-[30%] w-[700px] h-[700px] pointer-events-none z-0"></div>
	<div class="glow-orb-2 fixed bottom-[-20%] right-[10%] w-[500px] h-[500px] pointer-events-none z-0"></div>

	<!-- Navbar -->
	<nav class="nav-bar sticky top-0 z-50 flex-shrink-0 border-b backdrop-blur-xl" style="border-color: var(--border-subtle)">
		<div class="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-3">
			<!-- Logo -->
			<a href="/" class="flex items-center gap-2 flex-shrink-0 group">
				<div class="w-7 h-7 rounded-lg bg-gradient-to-br from-cyan-400 to-blue-600 flex items-center justify-center group-hover:shadow-lg group-hover:shadow-cyan-500/30 transition">
					<span class="text-black font-bold text-[10px]">TK</span>
				</div>
				<span class="syne font-bold text-base hidden sm:block tracking-tight">TokenKrafter</span>
			</a>

			<!-- Center nav links -->
			<div class="hidden md:flex items-center gap-0.5">
				{#each navLinks as link}
					<a
						href={link.href}
						class="nav-link px-3 py-1.5 rounded-md text-[13px] transition font-mono
						{page.url.pathname === link.href || (link.href !== '/' && page.url.pathname.startsWith(link.href))
							? 'text-cyan-400 bg-cyan-400/10'
							: 'text-gray-400 hover:text-white hover:bg-white/5'}"
					>{$t(link.key)}</a>
				{/each}
				{#if userAddress}
					<a
						href="/manage-tokens"
						class="nav-link px-3 py-1.5 rounded-md text-[13px] transition font-mono
						{page.url.pathname.startsWith('/manage-tokens')
							? 'text-cyan-400 bg-cyan-400/10'
							: 'text-gray-400 hover:text-white hover:bg-white/5'}"
					>{$t('nav.manageTokens')}</a>
				{/if}
			</div>

			<!-- Right side: actions -->
			<div class="flex items-center gap-2">
				<a href="/create" class="hidden md:inline-flex nav-cta no-underline">
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
					Launch
				</a>
				<div class="hidden md:block"><LanguageSwitcher /></div>
				<div class="hidden md:block"><appkit-button size="sm"></appkit-button></div>

				<button
					bind:this={hamburgerEl}
					onclick={() => (mobileMenuOpen = !mobileMenuOpen)}
					class="md:hidden p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/5 transition cursor-pointer"
					aria-label="Toggle menu"
					aria-expanded={mobileMenuOpen}
				>
					{#if mobileMenuOpen}
						<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
					{:else}
						<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
					{/if}
				</button>
			</div>
		</div>
	</nav>

	<!-- Mobile Menu Overlay + Drawer -->
	{#if mobileMenuOpen}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="mobile-backdrop fixed inset-0 z-40 md:hidden"
			onclick={() => (mobileMenuOpen = false)}
			onkeydown={(e) => { if (e.key === 'Escape') mobileMenuOpen = false; }}
		></div>
	{/if}
	<div
		bind:this={mobileMenuEl}
		class="mobile-drawer fixed top-0 right-0 z-50 h-full md:hidden"
		class:mobile-drawer-open={mobileMenuOpen}
	>
		<div class="flex flex-col h-full">
			<!-- Drawer header -->
			<div class="flex items-center justify-between px-5 h-16 border-b" style="border-color: var(--border-subtle)">
				<span class="syne font-bold text-base tracking-tight">Menu</span>
				<button
					onclick={() => (mobileMenuOpen = false)}
					class="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/5 transition cursor-pointer"
					aria-label="Close menu"
				>
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
				</button>
			</div>

			<!-- Nav links -->
			<nav class="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-1">
				<!-- Launch CTA in drawer -->
				<a
					href="/create"
					onclick={() => (mobileMenuOpen = false)}
					class="nav-cta no-underline mb-3 justify-center"
				>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
					Launch
				</a>

				{#each navLinks as link}
					<a
						href={link.href}
						onclick={() => (mobileMenuOpen = false)}
						class="mobile-nav-link px-4 py-3 rounded-lg text-sm transition font-mono flex items-center
						{page.url.pathname === link.href || (link.href !== '/' && page.url.pathname.startsWith(link.href))
							? 'text-cyan-400 bg-cyan-400/10'
							: 'text-gray-400 hover:text-white hover:bg-white/5'}"
					>{$t(link.key)}</a>
				{/each}

				<hr class="divider my-2" />
				<span class="text-[10px] font-mono uppercase tracking-wider px-4 mb-1" style="color: var(--text-dim)">More</span>
				{#each secondaryLinks as link}
					<a
						href={link.href}
						onclick={() => (mobileMenuOpen = false)}
						class="mobile-nav-link px-4 py-2.5 rounded-lg text-xs transition font-mono flex items-center
						{page.url.pathname.startsWith(link.href)
							? 'text-cyan-400 bg-cyan-400/10'
							: 'text-gray-500 hover:text-white hover:bg-white/5'}"
					>{$t(link.key)}</a>
				{/each}
			</nav>

			<!-- Bottom actions -->
			<div class="px-4 py-5 border-t flex flex-col gap-3" style="border-color: var(--border-subtle)">
				<div class="flex items-center justify-between">
					<span class="text-xs font-mono uppercase tracking-wider" style="color: var(--text-dim)">Language</span>
					<LanguageSwitcher />
				</div>
				<appkit-button size="sm"></appkit-button>
			</div>
		</div>
	</div>

	<div id="scroll-container" class="flex-1 overflow-y-auto overflow-x-hidden">
	<main id="main-content" class="min-h-screen">
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
	<footer class="footer border-t mt-auto" style="border-color: var(--border-subtle)">
		<div class="max-w-7xl mx-auto px-4 sm:px-6 py-12">
			<div class="grid grid-cols-1 sm:grid-cols-3 gap-10 sm:gap-8">
				<!-- Brand -->
				<div>
					<a href="/" class="flex items-center gap-2 mb-4 group">
						<div class="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-400 to-blue-600 flex items-center justify-center group-hover:shadow-lg group-hover:shadow-cyan-500/30 transition">
							<span class="text-black font-bold text-xs">TK</span>
						</div>
						<span class="syne font-bold text-lg tracking-tight">TokenKrafter</span>
					</a>
					<p class="text-sm text-gray-500 font-mono leading-relaxed max-w-xs">
						{$t('footer.tagline')}
					</p>
				</div>

				<!-- Quick Links -->
				<div>
					<h4 class="syne font-bold text-sm mb-4">{$t('footer.quickLinks')}</h4>
					<div class="flex flex-col gap-2">
						{#each [...navLinks, ...secondaryLinks] as link}
							<a href={link.href} class="text-sm text-gray-400 hover:text-cyan-400 transition font-mono">{$t(link.key)}</a>
						{/each}
						<a href="/terms" class="text-sm text-gray-400 hover:text-cyan-400 transition font-mono">{$t('footer.termsOfService')}</a>
					</div>
				</div>

				<!-- Community -->
				<div>
					<h4 class="syne font-bold text-sm mb-4">{$t('footer.community')}</h4>
					<div class="flex flex-wrap gap-2">
						{#each socials as social}
							<a
								href={social.href}
								target="_blank"
								rel="noopener noreferrer"
								class="social-link flex items-center gap-2 px-3 py-2 rounded-lg border border-white/7 bg-white/3 hover:border-cyan-500/30 hover:bg-cyan-500/5 transition text-sm font-mono text-gray-400 hover:text-cyan-400"
								title={social.label}
								aria-label={social.label}
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
				<p class="text-xs font-mono" style="color: var(--text-dim)">&copy; {new Date().getFullYear()} TokenKrafter. {$t('footer.allRightsReserved')}.</p>
				<div class="flex items-center gap-4">
					<button
						onclick={toggleTheme}
						class="theme-toggle"
						title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
						aria-label="Toggle dark/light theme"
					>
						{#if theme === 'dark'}
							<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
						{:else}
							<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
						{/if}
						<span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
					</button>
					<div class="flex items-center gap-3">
						{#each socials as social}
							<a
								href={social.href}
								target="_blank"
								rel="noopener noreferrer"
								class="footer-social-icon"
								title={social.label}
								aria-label={social.label}
							><svg class="social-svg-sm" viewBox="0 0 24 24" fill="currentColor">{@html social.svg}</svg></a>
						{/each}
					</div>
				</div>
			</div>
		</div>
	</footer>
	</div>
</div>

<style>
	:global(*) { box-sizing: border-box; }
	:global(body) {
		background: var(--bg);
		color: var(--text);
		font-family: 'Space Mono', monospace;
		margin: 0;
	}
	.syne { font-family: 'Syne', sans-serif; }
	:global(.syne) { font-family: 'Syne', sans-serif; }

	.grid-bg {
		background-image:
			linear-gradient(var(--grid-line) 1px, transparent 1px),
			linear-gradient(90deg, var(--grid-line) 1px, transparent 1px);
		background-size: 60px 60px;
	}
	.glow-orb {
		background: radial-gradient(circle, var(--glow-1) 0%, transparent 70%);
		border-radius: 50%;
	}
	.glow-orb-2 {
		background: radial-gradient(circle, var(--glow-2) 0%, transparent 70%);
		border-radius: 50%;
	}
	.nav-bar { background: var(--bg-nav); }
	.nav-cta {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		background: linear-gradient(135deg, #00d2ff, #3a7bd5);
		color: white;
		font-weight: 600;
		padding: 6px 14px;
		border-radius: 8px;
		border: none;
		cursor: pointer;
		transition: all 0.2s;
		font-family: 'Syne', sans-serif;
		font-size: 13px;
	}
	.nav-cta:hover {
		transform: translateY(-1px);
		box-shadow: 0 4px 16px rgba(0, 210, 255, 0.3);
	}
	.toast { animation: slideIn 0.3s ease-out; }
	@keyframes slideIn {
		from { opacity: 0; transform: translateX(20px); }
		to   { opacity: 1; transform: translateX(0); }
	}
	.spinner { animation: spin 0.8s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }

	.footer { background: var(--bg-footer); }
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
	.theme-toggle {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 5px 12px;
		border-radius: 8px;
		border: 1px solid var(--border);
		background: var(--bg-surface);
		color: var(--text-muted);
		font-family: 'Space Mono', monospace;
		font-size: 12px;
		cursor: pointer;
		transition: all 0.2s;
	}
	.theme-toggle:hover {
		border-color: rgba(0,210,255,0.3);
		color: #00d2ff;
		background: rgba(0,210,255,0.05);
	}
	.footer-social-icon {
		color: var(--text-dim);
		transition: color 0.2s;
	}
	.footer-social-icon:hover {
		color: #00d2ff;
	}

	/* ─── Mobile Drawer ─── */
	.mobile-backdrop {
		background: rgba(0, 0, 0, 0.6);
		backdrop-filter: blur(4px);
		animation: fadeIn 0.25s ease-out;
	}
	@keyframes fadeIn {
		from { opacity: 0; }
		to   { opacity: 1; }
	}
	.mobile-drawer {
		width: 280px;
		max-width: 85vw;
		background: var(--bg-mobile-menu);
		border-left: 1px solid var(--border-subtle);
		backdrop-filter: blur(20px);
		transform: translateX(100%);
		transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
		pointer-events: none;
	}
	.mobile-drawer-open {
		transform: translateX(0);
		pointer-events: auto;
	}
	.mobile-nav-link {
		font-family: 'Space Mono', monospace;
	}
	.skip-to-content {
		position: absolute;
		left: -9999px;
		top: auto;
		width: 1px;
		height: 1px;
		overflow: hidden;
	}
	.skip-to-content:focus {
		position: fixed;
		top: 8px;
		left: 8px;
		width: auto;
		height: auto;
		padding: 8px 16px;
		background: var(--bg-surface);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 8px;
		z-index: 200;
		font-family: 'Space Mono', monospace;
		font-size: 13px;
	}
</style>
