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
			platform_address: '0xf8953948561d3047b15006915669d2814b9f0e5d',
			launchpad_address: '0x9a7c5e6a4343E881152d3D4A8709289B4f46E071',
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
	let showWalletPicker = $state(false);

	// EIP-6963 provider discovery — wallets announce themselves via events
	let eip6963Providers: Map<string, { provider: any; info: { rdns: string; name: string; icon: string; uuid: string } }> = $state(new Map());

	function initEIP6963() {
		if (typeof window === 'undefined') return;
		window.addEventListener('eip6963:announceProvider', ((event: any) => {
			const { provider, info } = event.detail;
			if (info?.rdns) {
				eip6963Providers = new Map(eip6963Providers).set(info.rdns, { provider, info });
			}
		}) as EventListener);
		// Request all providers to announce
		window.dispatchEvent(new Event('eip6963:requestProvider'));
	}

	function getEIP6963Provider(): any | null {
		// Prefer Trust Wallet, then any available provider
		const preferred = ['com.trustwallet.app', 'io.metamask', 'com.binance', 'com.safepal'];
		for (const rdns of preferred) {
			const entry = eip6963Providers.get(rdns);
			if (entry) return entry.provider;
		}
		// Fall back to any announced provider
		for (const entry of eip6963Providers.values()) {
			return entry.provider;
		}
		return null;
	}

	const WALLET_SVG = {
		metamask: '<svg viewBox="0 0 35 33" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M32.958 1l-13.134 9.718 2.442-5.727L32.958 1z" fill="#E17726" stroke="#E17726" stroke-width=".25" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.066 1l13.002 9.81L12.76 4.99 2.066 1zM28.229 23.533l-3.495 5.339 7.483 2.06 2.143-7.282-6.131-.117zM.624 23.65l2.13 7.282 7.47-2.06-3.481-5.339-6.12.117z" fill="#E27625" stroke="#E27625" stroke-width=".25" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.867 14.578l-2.079 3.136 7.405.337-.247-7.969-5.079 4.496zM25.157 14.578l-5.144-4.588-.17 8.06 7.393-.336-2.08-3.136zM10.224 28.872l4.476-2.164-3.862-3.012-.614 5.176zM20.325 26.708l4.463 2.164-.6-5.176-3.863 3.012z" fill="#E27625" stroke="#E27625" stroke-width=".25" stroke-linecap="round" stroke-linejoin="round"/><path d="M24.788 28.872l-4.463-2.164.365 2.903-.04 1.227 4.138-1.966zM10.224 28.872l4.151 1.966-.026-1.227.35-2.903-4.475 2.164z" fill="#D5BFB2" stroke="#D5BFB2" stroke-width=".25" stroke-linecap="round" stroke-linejoin="round"/><path d="M14.453 21.93l-3.726-1.097 2.63-1.205 1.096 2.302zM20.57 21.93l1.097-2.302 2.644 1.205-3.74 1.097z" fill="#233447" stroke="#233447" stroke-width=".25" stroke-linecap="round" stroke-linejoin="round"/><path d="M10.224 28.872l.64-5.339-4.12.117 3.48 5.222zM24.16 23.533l.628 5.339 3.48-5.222-4.108-.117zM27.237 17.714l-7.393.337.688 3.879 1.097-2.303 2.644 1.206 2.964-3.119zM10.727 20.833l2.63-1.206 1.096 2.303.689-3.88-7.354-.336 2.94 3.119z" fill="#CC6228" stroke="#CC6228" stroke-width=".25" stroke-linecap="round" stroke-linejoin="round"/><path d="M7.788 17.714l3.068 5.98-.104-2.86-2.964-3.12zM24.273 20.833l-.117 2.861 3.08-5.98-2.963 3.119zM15.193 18.051l-.689 3.879.87 4.496.195-5.922-.376-2.453zM19.844 18.051l-.363 2.44.182 5.935.87-4.496-.689-3.879z" fill="#E27525" stroke="#E27525" stroke-width=".25" stroke-linecap="round" stroke-linejoin="round"/><path d="M20.533 21.93l-.87 4.496.625.44 3.862-3.012.117-2.86-3.734.937zM10.727 20.833l.104 2.861 3.862 3.012.626-.44-.87-4.496-3.722-.937z" fill="#F5841F" stroke="#F5841F" stroke-width=".25" stroke-linecap="round" stroke-linejoin="round"/><path d="M20.598 30.838l.04-1.227-.338-.285h-5.575l-.325.285.026 1.227-4.151-1.966 1.452 1.189 2.943 2.035h5.667l2.957-2.035 1.438-1.189-4.134 1.966z" fill="#C0AC9D" stroke="#C0AC9D" stroke-width=".25" stroke-linecap="round" stroke-linejoin="round"/><path d="M20.325 26.708l-.626-.44h-4.373l-.626.44-.35 2.903.324-.285h5.576l.338.285-.263-2.903z" fill="#161616" stroke="#161616" stroke-width=".25" stroke-linecap="round" stroke-linejoin="round"/><path d="M33.517 11.353l1.114-5.36L32.958 1l-12.633 9.356 4.832 4.222 6.853 1.997 1.517-1.763-.66-.48 1.049-.956-.807-.622 1.049-.8-.689-.467zM.394 5.993l1.127 5.36-.72.467 1.063.8-.806.622 1.049.956-.66.48 1.504 1.763 6.852-1.997 4.833-4.222L2.066 1 .394 5.993z" fill="#763E1A" stroke="#763E1A" stroke-width=".25" stroke-linecap="round" stroke-linejoin="round"/><path d="M32.01 16.575l-6.853-1.997 2.08 3.136-3.081 5.98 4.069-.052h6.131l-2.346-7.067zM9.867 14.578L3.014 16.575.68 23.65h6.12l4.055.052-3.068-5.98 2.079-3.136v-.008zM19.844 18.051l.43-7.538 1.992-5.524H12.76l1.979 5.524.443 7.538.17 2.466.013 5.91h4.373l.026-5.91.182-2.466z" fill="#F5841F" stroke="#F5841F" stroke-width=".25" stroke-linecap="round" stroke-linejoin="round"/></svg>',
		trust: '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="tw" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse"><stop stop-color="#0500FF"/><stop offset="1" stop-color="#0500FF"/></linearGradient></defs><rect width="32" height="32" rx="6" fill="url(#tw)"/><path d="M16 6c3.2 2.4 6.8 3.6 10 3.2 0 6-1.2 13.2-10 17.2-8.8-4-10-11.2-10-17.2 3.2.4 6.8-.8 10-3.2z" stroke="white" stroke-width="1.5" fill="none"/></svg>',
		binance: '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><rect width="32" height="32" rx="6" fill="#F0B90B"/><path d="M16 7l2.5 2.5-4.8 4.8-2.5-2.5L16 7zm5.3 5.3l2.5 2.5-2.5 2.5-2.5-2.5 2.5-2.5zm-10.6 0l2.5 2.5-2.5 2.5-2.5-2.5 2.5-2.5zM16 17.6l2.5 2.5L16 22.6l-2.5-2.5L16 17.6zm0-5.3l2.5 2.5L16 17.3l-2.5-2.5L16 12.3z" fill="white"/></svg>',
		safepal: '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><rect width="32" height="32" rx="6" fill="#4A21EF"/><path d="M8 11h7v3H8v-3zm0 5h7v3H8v-3zm9-5h7v3h-7v-3zm0 5h7v3h-7v-3zm-9 5h16v3H8v-3z" fill="white"/></svg>',
		walletconnect: '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><rect width="32" height="32" rx="6" fill="#3B99FC"/><path d="M10.5 13.2c3-3 7.9-3 10.9 0l.4.4c.15.15.15.4 0 .5l-1.2 1.2c-.08.07-.2.07-.27 0l-.5-.5c-2.1-2.1-5.5-2.1-7.6 0l-.6.5c-.08.07-.2.07-.27 0l-1.2-1.2c-.15-.15-.15-.4 0-.5l.3-.4zm13.5 2.5l1.1 1.1c.15.15.15.4 0 .5l-4.8 4.7c-.15.15-.4.15-.55 0l-3.4-3.3c-.04-.04-.1-.04-.14 0l-3.4 3.3c-.15.15-.4.15-.55 0L7.4 17.3c-.15-.15-.15-.4 0-.5l1.1-1.1c.15-.15.4-.15.55 0l3.4 3.3c.04.04.1.04.14 0l3.4-3.3c.15-.15.4-.15.55 0l3.4 3.3c.04.04.1.04.14 0l3.4-3.3c.15-.15.4-.15.55 0z" fill="white"/></svg>'
	};

	function getWalletDeepLinks(): { name: string; icon: string; href: string }[] {
		const currentUrl = window.location.href;
		const stripped = currentUrl.replace(/^https?:\/\//, '');
		return [
			{ name: 'MetaMask', icon: WALLET_SVG.metamask, href: `https://metamask.app.link/dapp/${stripped}` },
			{ name: 'Trust Wallet', icon: WALLET_SVG.trust, href: `trust://open_url?coin_id=56&url=${encodeURIComponent(currentUrl)}` },
			{ name: 'Binance Wallet', icon: WALLET_SVG.binance, href: `https://app.binance.com/cedefi/dapp-web-view?dappUrl=${encodeURIComponent(currentUrl)}` },
			{ name: 'SafePal', icon: WALLET_SVG.safepal, href: `https://link.safepal.io/open_url?url=${encodeURIComponent(currentUrl)}` }
		];
	}

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
		// 1. Try EIP-6963 discovered providers first (most reliable)
		const eip6963 = getEIP6963Provider();
		if (eip6963) return eip6963;
		// 2. Fall back to legacy injected globals
		const w = window as any;
		return w.ethereum || w.trustwallet?.provider || w.BinanceChain || w.coinbaseWalletExtension;
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
		// If injected wallet available (extension or in-app DApp browser), use it directly
		let eth = getEthereum();

		// Some DApp browsers inject the provider after a short delay — wait up to 2s
		if (!eth) {
			for (let i = 0; i < 4; i++) {
				await new Promise(r => setTimeout(r, 500));
				window.dispatchEvent(new Event('eip6963:requestProvider'));
				eth = getEthereum();
				if (eth) break;
			}
		}

		if (eth) {
			isConnecting = true;
			try {
				provider = new ethers.BrowserProvider(eth);
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

		// No injected wallet — show wallet picker
		showWalletPicker = true;
		return false;
	}

	async function connectViaWalletConnect() {
		showWalletPicker = false;
		const kit = getAppKit();
		if (kit) {
			await kit.open();
		}
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
		// Initialize EIP-6963 provider discovery (Trust Wallet, MetaMask, etc.)
		initEIP6963();
		// Initialize providers in background
		initProviders();

		// Initialize AppKit (Reown) for wallet connections
		const kit = await initAppKit();
		if (kit) {
			kit.subscribeAccount(async (account: any) => {
				if (account.isConnected && account.address) {
					// Get the underlying provider (EIP-6963 first, then legacy)
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
	setContext('getEthereum', getEthereum);
	setContext('connectViaWalletConnect', connectViaWalletConnect);
	setContext('getWalletDeepLinks', getWalletDeepLinks);
	setContext('supportedNetworks', supportedNetworks);
	setContext('networkProviders', () => networkProviders);
	setContext('providersReady', () => providersReady);
	setContext('getPaymentOptions', getPaymentOptions);

	const navLinks = [
		{ href: '/', label: 'Home' },
		{ href: '/create', label: 'Create Token' },
		{ href: '/launchpad', label: 'Launchpad' },
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

<!-- Wallet Picker Modal -->
{#if showWalletPicker}
	<div
		class="fixed inset-0 z-[90] bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-4"
		role="dialog"
		aria-label="Choose wallet"
		onclick={() => (showWalletPicker = false)}
	>
		<div class="w-full max-w-sm rounded-2xl border border-white/10 bg-[#0d0d14] shadow-2xl overflow-hidden" onclick={(e) => e.stopPropagation()}>
			<div class="flex items-center justify-between p-4 border-b border-white/5">
				<h3 class="syne font-bold text-white">Connect Wallet</h3>
				<button onclick={() => (showWalletPicker = false)} class="text-gray-400 hover:text-white cursor-pointer text-lg">x</button>
			</div>
			<div class="p-4">
				<p class="text-xs text-gray-400 font-mono mb-4">Already in a wallet browser? Tap below, or open this page in your wallet:</p>
				<div class="flex flex-col gap-2">
					<!-- Browser wallet (for DApp browsers where ethereum was injected late) -->
					<button
						onclick={async () => {
							const eth = getEthereum();
							if (eth) {
								showWalletPicker = false;
								isConnecting = true;
								try {
									provider = new ethers.BrowserProvider(eth);
									await provider.send('eth_requestAccounts', []);
									signer = await provider.getSigner();
									userAddress = await signer.getAddress();
									addFeedback({ message: 'Wallet connected!', type: 'success' });
								} catch {
									addFeedback({ message: 'Connection failed. Try again.', type: 'error' });
								} finally {
									isConnecting = false;
								}
							} else {
								addFeedback({ message: 'No wallet detected. Open this page in your wallet app.', type: 'error' });
							}
						}}
						class="flex items-center gap-3 p-3 rounded-xl border border-cyan-500/20 bg-cyan-500/5 hover:border-cyan-500/40 hover:bg-cyan-500/10 transition text-white cursor-pointer w-full text-left"
					>
						<span class="w-8 h-8 flex-shrink-0 rounded-lg bg-gradient-to-br from-cyan-400 to-blue-600 flex items-center justify-center">
							<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><path d="M20 12V8H6a2 2 0 0 1-2-2c0-1.1.9-2 2-2h12v4"/><path d="M4 6v12c0 1.1.9 2 2 2h14v-4"/><circle cx="18" cy="16" r="2" fill="white"/></svg>
						</span>
						<span class="font-mono text-sm">Browser Wallet</span>
						<span class="ml-auto text-cyan-400 text-xs">Connect</span>
					</button>
					<div class="border-b border-white/5 my-1"></div>
					{#each getWalletDeepLinks() as wallet}
						<a
							href={wallet.href}
							class="flex items-center gap-3 p-3 rounded-xl border border-white/5 bg-white/3 hover:border-cyan-500/30 hover:bg-cyan-500/5 transition text-white no-underline"
						>
							<span class="w-8 h-8 flex-shrink-0">{@html wallet.icon}</span>
							<span class="font-mono text-sm">{wallet.name}</span>
							<span class="ml-auto text-gray-500 text-xs">Open</span>
						</a>
					{/each}
					<!-- WalletConnect option -->
					<button
						onclick={connectViaWalletConnect}
						class="flex items-center gap-3 p-3 rounded-xl border border-white/5 bg-white/3 hover:border-blue-500/30 hover:bg-blue-500/5 transition text-white cursor-pointer w-full text-left"
					>
						<span class="w-8 h-8 flex-shrink-0">{@html WALLET_SVG.walletconnect}</span>
						<span class="font-mono text-sm">WalletConnect</span>
						<span class="ml-auto text-gray-500 text-xs">QR Code</span>
					</button>
				</div>
			</div>
		</div>
	</div>
{/if}

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
