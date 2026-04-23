<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { setContext, onMount } from 'svelte';
	import { navigating } from '$app/state';
	import { createMode } from '$lib/createModeStore';
	import { ethers } from 'ethers';
	import { initAppKit, getAppKit } from '$lib/wagmiConfig';
	import type { SupportedNetworks, SupportedNetwork, PaymentOption } from '$lib/structure';
	import { page } from '$app/state';
	import { t } from '$lib/i18n';
	import LanguageSwitcher from '$lib/LanguageSwitcher.svelte';
	import { supabase } from '$lib/supabaseClient';
	import { initApiFetch } from '$lib/apiFetch';
	import WalletModal from '$lib/WalletModal.svelte';
	import AccountPanel from '$lib/AccountPanel.svelte';
	import { getSigner as getEmbeddedSigner, signOut, lockWallet, getWalletState, checkAuthReturn, hasVault, autoReconnect, onWalletStateChange, pushPreferences } from '$lib/embeddedWallet';
	import { startBalancePoller, stopBalancePoller, updatePollerAddress, balanceState, refreshBalancesNow, setWsManager, onTokenDiscovered } from '$lib/balancePoller';
	import { createWsProviderManager, type WsProviderManager } from '$lib/wsProvider';
	import { ROUTER_ABI_LITE } from '$lib/commonABIs';

	let { children, data }: { children: any; data: any } = $props();
	let isAdmin = $derived(data?.isAdmin || false);

	let showWalletModal = $state(false);
	let showAccountPanel = $state(false);
	let walletLoading = $state(true);
	// True while we're resolving a Google OAuth redirect. Separate from
	// walletLoading because we want to keep showing "Signing in..." until
	// the PIN modal pops — the user is still in the auth flow even after
	// the page reloads from Google's redirect.
	let oauthPending = $state(false);
	let walletModalRef: WalletModal | undefined = $state();
	let nativeBalance = $state(0n);
	let nativePriceUsd = $state(0);
	let walletType: 'embedded' | 'external' | null = $state(null);

	// Networks loaded from DB (admin-managed)
	let supportedNetworks: SupportedNetworks = $state([]);

	// Network providers initialized in background
	let networkProviders: Map<number, ethers.JsonRpcProvider> = $state(new Map());
	let wsManager: WsProviderManager | null = $state(null);
	let providersReady = $state(false);

	function getPaymentOptions(network: SupportedNetwork): PaymentOption[] {
		const options: PaymentOption[] = [];
		// Derive from default_bases (DB-driven, per-chain), but skip the
		// wrapped native coin (WBNB/WETH) since native BNB/ETH is listed
		// separately as a convenience — having both is confusing. The
		// wrapped native stays in default_bases for pool pre-registration.
		const wrappedSymbols = new Set(['WBNB', 'WETH', 'WMATIC', 'WAVAX']);
		for (const b of network.default_bases ?? []) {
			if (!b.address) continue;
			if (wrappedSymbols.has(b.symbol.toUpperCase())) continue;
			options.push({
				symbol: b.symbol,
				name: b.name || b.symbol,
				address: b.address,
				decimals: network.chain_id === 56 ? 18 : 6,
			});
		}
		// Always include native coin
		const nativeSymbol = network.native_coin;
		options.push({
			symbol: nativeSymbol,
			name: `${nativeSymbol} (Native)`,
			address: '0x0000000000000000000000000000000000000000',
			decimals: 18,
		});
		return options;
	}

	let feedbacks: { message: string; type: string; id: number }[] = $state([]);
	let feedbackCounter = 0;

	// PWA install prompt
	let installPrompt: any = $state(null);
	let showInstallBanner = $state(false);

	// Offline indicator
	let isOffline = $state(false);

	let provider: ethers.BrowserProvider | null = $state(null);
	let signer: ethers.Signer | null = $state(null);
	let userAddress: string | null = $state(null);
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
		// If the embedded wallet is already authenticated but just needs
		// a PIN (session exists, signer is null), go straight to the PIN
		// prompt instead of the full connect modal.
		if (walletType === 'embedded' && userAddress && !signer && walletModalRef) {
			walletModalRef.openAt('pin-enter');
			return false;
		}
		showWalletModal = true;
		return false;
	}

	// Clear wallet loading if PIN modal is dismissed without connecting.
	// Skip this during OAuth return — we want to keep the loading state
	// until the PIN modal actually opens (or auth times out).
	$effect(() => {
		if (!showWalletModal && walletLoading && !userAddress && !oauthPending) {
			walletLoading = false;
		}
	});

	function openWalletConnect() {
		const kit = getAppKit();
		if (kit) kit.open();
	}


	async function disconnectWallet() {
		// Optimistic UI — clear state instantly, cleanup in background
		const wasEmbedded = walletType === 'embedded';
		userAddress = null;
		signer = null;
		provider = null;
		nativeBalance = 0n;
		nativePriceUsd = 0;
		walletType = null;
		stopBalancePoller();

		// Close any wallet UI immediately so the user sees the disconnect.
		// AccountPanel reads `walletType` and `userAddress` directly, so
		// without this it would linger with stale state until manually closed.
		showAccountPanel = false;

		// Background cleanup
		if (wasEmbedded) {
			lockWallet();
			localStorage.removeItem('_wp');
			localStorage.removeItem('_active_acct');
			localStorage.removeItem('_active_wallet');
			signOut().catch(() => {});
		} else {
			const kit = getAppKit();
			if (kit) kit.disconnect?.().catch(() => {});
		}
	}

	// Fetch native balance + price when address or network changes
	$effect(() => {
		if (!userAddress || supportedNetworks.length === 0) { nativeBalance = 0n; nativePriceUsd = 0; return; }
		const net = supportedNetworks[0];
		const prov = networkProviders.get(net?.chain_id);
		if (!prov) return;
		prov.getBalance(userAddress).then(b => nativeBalance = b).catch(() => {});

		// Fetch native price via DEX router
		if (net.dex_router && net.usdt_address) {
			const router = new ethers.Contract(net.dex_router, ROUTER_ABI_LITE, prov);
			(async () => {
				try {
					const weth = await router.WETH();
					const amounts = await router.getAmountsOut(ethers.parseEther('1'), [weth, net.usdt_address]);
					nativePriceUsd = parseFloat(ethers.formatUnits(amounts[1], 18));
				} catch {}
			})();
		}
	});

	// Sync balance poller state to layout state (for embedded wallet)
	const unsubBalance = balanceState.subscribe((state) => {
		if (state.lastUpdated > 0 && walletType === 'embedded') {
			nativeBalance = state.nativeBalance;
		}
	});

	function handleWalletConnected(address: string, type: 'embedded' | 'external') {
		userAddress = address;
		walletType = type;
		walletLoading = false;
		if (type === 'embedded') {
			// Use embedded wallet signer
			const net = supportedNetworks[0];
			if (net?.rpc) {
				const rpcProvider = new ethers.JsonRpcProvider(net.rpc, net.chain_id, { staticNetwork: true });
				const embeddedSigner = getEmbeddedSigner(rpcProvider);
				if (embeddedSigner) {
					signer = embeddedSigner;
					provider = null; // no BrowserProvider for embedded wallet
				}
				// Start background balance polling
				startBalancePoller(rpcProvider, address, net.chain_id, 30_000, wsManager);
			}
		}
	}

	function initProviders() {
		const map = new Map<number, ethers.JsonRpcProvider>();
		for (const n of supportedNetworks) {
			if (!n.rpc) continue;
			const p = new ethers.JsonRpcProvider(n.rpc, n.chain_id, { staticNetwork: true });
			map.set(n.chain_id, p);
		}
		networkProviders = map;
		if (wsManager) wsManager.close();
		wsManager = createWsProviderManager(supportedNetworks, map);
		setWsManager(wsManager);
		onTokenDiscovered((token) => {
			addFeedback({ message: `New token received: ${token.symbol}`, type: 'info' });
			pushPreferences();
		});
		providersReady = true;
	}

	// ── Deferred signer creation ─────────────────────────────────
	// autoReconnect and onWalletStateChange both fire before the network
	// config is loaded from the DB, so supportedNetworks[0] is undefined
	// and the signer never gets created. This effect retries once
	// providers are ready and the wallet is unlocked but signer is still null.
	$effect(() => {
		if (providersReady && walletType === 'embedded' && !signer && userAddress) {
			const state = getWalletState();
			if (state.activeAccount && state.isUnlocked) {
				const net = supportedNetworks[0];
				if (net?.rpc) {
					const rpcProvider = new ethers.JsonRpcProvider(net.rpc, net.chain_id, { staticNetwork: true });
					signer = getEmbeddedSigner(rpcProvider);
					startBalancePoller(rpcProvider, state.activeAccount.address, net.chain_id);
				}
			}
		}
	});

	// ── Admin realtime notifications (daemon-confirmed events) ──
	let adminChannel: any = null;
	$effect(() => {
		if (!isAdmin) return;
		adminChannel = supabase
			.channel('admin-activity')
			// Token confirmed by daemon (pre-saves use name='Pending'; daemon upserts real name)
			.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'created_tokens' }, (payload: any) => {
				const prev = payload.old;
				const curr = payload.new;
				if (prev.name === 'Pending' && curr.name && curr.name !== 'Pending') {
					const fee = curr.is_partner ? 'Partner' : curr.is_taxable ? 'Taxable' : curr.is_mintable ? 'Mintable' : 'Basic';
					addFeedback({ message: `Token confirmed: ${curr.name} (${curr.symbol}) — ${fee}`, type: 'success' });
				}
			})
			// New token created (INSERT from daemon only — skip frontend pre-saves with name='Pending')
			.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'created_tokens' }, (payload: any) => {
				const t = payload.new;
				if (t.name && t.name !== 'Pending') {
					const fee = t.is_partner ? 'Partner' : t.is_taxable ? 'Taxable' : t.is_mintable ? 'Mintable' : 'Basic';
					addFeedback({ message: `New token: ${t.name} (${t.symbol}) — ${fee}`, type: 'success' });
				}
			})
			// Launch state changes (daemon syncs state 0→1, 1→2)
			.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'launches' }, (payload: any) => {
				const prev = payload.old;
				const curr = payload.new;
				if (prev.state !== curr.state) {
					const states: Record<number, string> = { 0: 'Pending', 1: 'Active', 2: 'Graduated', 3: 'Refunding' };
					addFeedback({ message: `Launch ${curr.token_symbol || curr.address?.slice(0, 10)}: ${states[prev.state] || '?'} → ${states[curr.state] || '?'}`, type: 'info' });
				}
				// New buy detected (total_base_raised increased)
				if (prev.total_base_raised !== curr.total_base_raised && curr.total_base_raised !== '0') {
					const raised = parseFloat(curr.total_base_raised) / 1e18;
					const prevRaised = parseFloat(prev.total_base_raised || '0') / 1e18;
					const delta = raised - prevRaised;
					if (delta > 0) {
						addFeedback({ message: `Launch buy: +$${delta.toFixed(2)} → ${curr.token_symbol || '???'} ($${raised.toFixed(2)} total)`, type: 'info' });
					}
				}
			})
			// Withdrawal status changes
			.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'withdrawals' }, (payload: any) => {
				const w = payload.new;
				addFeedback({ message: `New withdrawal: $${(parseFloat(w.gross_amount || '0') / 1e18).toFixed(2)} → Bank`, type: 'info' });
			})
			.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'withdrawals' }, (payload: any) => {
				const prev = payload.old;
				const curr = payload.new;
				if (prev.status !== curr.status) {
					const statuses: Record<number, string> = { 0: 'Pending', 1: 'Processing', 2: 'Completed', 3: 'Cancelled', 4: 'Timeout' };
					addFeedback({ message: `Withdrawal ${statuses[prev.status] || '?'} → ${statuses[curr.status] || '?'}: $${(parseFloat(curr.gross_amount || '0') / 1e18).toFixed(2)}`, type: curr.status === 2 ? 'success' : 'info' });
				}
			})
			.subscribe();

		return () => {
			if (adminChannel) supabase.removeChannel(adminChannel);
			adminChannel = null;
		};
	});

	onMount(() => {
		// Single source of truth: keep the layout's signer/userAddress runes in sync
		// with the embedded-wallet module state. Every path that mutates _state
		// (unlock, setActiveAccount, addAccount, lockWallet, signOut) goes through
		// _notify(), so subscribing here guarantees the UI, signer context, and
		// route guards all react consistently — fixing the "stale signer requires
		// reload" and "manage-tokens doesn't react to account switch" bugs.
		const unsubWalletState = onWalletStateChange((state) => {
			if (state.activeAccount && state.isUnlocked) {
				userAddress = state.activeAccount.address;
				walletType = 'embedded';
				const net = supportedNetworks[0];
				if (net?.rpc) {
					const rpcProvider = new ethers.JsonRpcProvider(net.rpc, net.chain_id, { staticNetwork: true });
					signer = getEmbeddedSigner(rpcProvider);
				}
			} else if (!state.isUnlocked) {
				signer = null;
			}
		});

		// Restore theme from localStorage
		const saved = localStorage.getItem('theme') as 'dark' | 'light' | null;
		if (saved === 'light') applyTheme('light');

		// PWA install prompt
		const dismissed = localStorage.getItem('pwa_install_dismissed');
		window.addEventListener('beforeinstallprompt', (e: any) => {
			e.preventDefault();
			installPrompt = e;
			if (!dismissed) showInstallBanner = true;
		});

		// Offline detection
		isOffline = !navigator.onLine;
		window.addEventListener('online', () => { isOffline = false; });
		window.addEventListener('offline', () => { isOffline = true; });
		navigator.serviceWorker?.addEventListener('message', (e) => {
			if (e.data?.type === 'offline') isOffline = true;
			if (e.data?.type === 'online') isOffline = false;
		});

		// Mark OAuth-return early and open the "Signing in..." modal so
		// the user sees continuous feedback (not the bare page with a
		// disabled button) until the PIN prompt comes up.
		try {
			if (sessionStorage.getItem('wallet_pending') === 'true') {
				oauthPending = true;
			}
		} catch {}

		// Auto-reconnect wallet on page load
		(async () => {
			try {
				// First check if returning from Google OAuth redirect
				if (oauthPending && walletModalRef) {
					// Show continuous spinner modal — seamless from the
					// pre-redirect "Redirecting to Google..." screen.
					walletModalRef.openAt('completing-signin');
				}

				const authReturned = await checkAuthReturn();
				if (authReturned && walletModalRef) {
					const exists = await hasVault();
					if (exists) {
						// Pre-populate userAddress from the already-fetched wallet
						// state so the nav shows a connected (locked) indicator
						// before the user even enters their PIN.
						const state = getWalletState();
						const active = state.wallets.find((w) => w.id === state.activeWalletId);
						if (active?.defaultAddress) {
							userAddress = active.defaultAddress;
							walletType = 'embedded';
						}
					}
					walletModalRef.openAt(exists ? 'pin-enter' : 'pin-setup');
					oauthPending = false;
					return;
				}
				// OAuth returned but no session — auth failed silently
				if (oauthPending) {
					oauthPending = false;
					walletModalRef?.forceClose?.();
				}

				// Try auto-reconnect (session + cached PIN = silent unlock)
				const result = await autoReconnect();
				if (result === 'connected') {
					const state = getWalletState();
					if (state.activeAccount) {
						userAddress = state.activeAccount.address;
						walletType = 'embedded';
						// Connect signer to first available network
						const net = supportedNetworks[0];
						if (net?.rpc) {
							const rpcProvider = new ethers.JsonRpcProvider(net.rpc, net.chain_id, { staticNetwork: true });
							signer = getEmbeddedSigner(rpcProvider);
							// Start background balance polling
							startBalancePoller(rpcProvider, state.activeAccount.address, net.chain_id);
						}
					}
				} else if (result === 'needs-pin') {
					// Session exists but PIN not cached. autoReconnect already
					// populated the wallet list + active wallet, so we can pull
					// the default address straight from the in-memory store —
					// no extra HTTP roundtrip needed.
					const state = getWalletState();
					const active = state.wallets.find((w) => w.id === state.activeWalletId);
					if (active?.defaultAddress) {
						userAddress = active.defaultAddress;
						walletType = 'embedded';
					}
				}
			} catch {}
			walletLoading = false;
		})();

		// Load networks from DB, then init providers + AppKit.
		// Supabase's query builder returns a PromiseLike without .catch, so wrap
		// in an async IIFE and use try/catch.
		(async () => {
			try {
				const { data } = await supabase
					.from('platform_config')
					.select('value')
					.eq('key', 'networks')
					.single();
				if (data?.value && Array.isArray(data.value) && data.value.length > 0) {
					supportedNetworks = data.value;
				}
				initProviders();
				const kit = await initAppKit(supportedNetworks);
				if (kit) setupWalletKit(kit);
			} catch {
				initProviders();
				const kit = await initAppKit();
				if (kit) setupWalletKit(kit);
			}
		})();

		// Subscribe to config changes (admin updates networks live)
		const configChannel = supabase
			.channel('platform-config')
			.on('postgres_changes', {
				event: 'UPDATE', schema: 'public', table: 'platform_config',
				filter: 'key=eq.networks'
			}, (payload: any) => {
				if (payload.new?.value && Array.isArray(payload.new.value)) {
					supportedNetworks = payload.new.value;
					initProviders();
				}
			})
			.subscribe();

		// Wallet kit setup helper
		function setupWalletKit(kit: any) {
			if (theme === 'light') kit.setThemeMode('light');
			kit.subscribeAccount(async (account: any) => {
				if (account.isConnected && account.address) {
					// Only set external wallet if not already connected via embedded
					if (walletType !== 'embedded' || !userAddress) {
						walletType = 'external';
						const walletProvider = kit.getWalletProvider();
						if (walletProvider) {
							await setupEthersFromProvider(walletProvider);
						}
					}
				} else if (!account.isConnected && walletType === 'external') {
					provider = null;
					signer = null;
					userAddress = null;
					walletType = null;
				}
			});

			// Check if already connected on page load (only if no embedded wallet)
			if (!userAddress) {
				try {
					const walletProvider = kit.getWalletProvider();
					if (walletProvider) {
						walletType = 'external';
						setupEthersFromProvider(walletProvider);
					}
				} catch {}
			}
		}

		// Capture referral from URL (address or alias)
		const params = new URLSearchParams(window.location.search);
		const ref = params.get('ref');
		if (ref && !localStorage.getItem('referral')) {
			if (ethers.isAddress(ref)) {
				localStorage.setItem('referral', ref);
			} else {
				fetch(`/api/referral?alias=${encodeURIComponent(ref)}`)
					.then(r => r.json())
					.then(data => {
						if (data.address) localStorage.setItem('referral', data.address);
					})
					.catch(() => {});
			}
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
			unsubWalletState();
			unsubBalance();
			supabase.removeChannel(configChannel);
			wsManager?.close();
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
	initApiFetch(() => userAddress, () => signer);
	setContext('connectWallet', connectWallet);
	setContext('supportedNetworks', () => supportedNetworks);
	setContext('networkProviders', () => networkProviders);
	setContext('wsManager', () => wsManager);
	setContext('providersReady', () => providersReady);
	setContext('getPaymentOptions', getPaymentOptions);

	// Primary nav — only the core pages users need
	const navLinks: { href: string; key: import('$lib/i18n').TranslationKey }[] = [
		{ href: '/explore', key: 'nav.explore' },
		{ href: '/launchpad', key: 'nav.launchpad' },
		{ href: '/trade', key: 'nav.trade' },
		{ href: '/create', key: 'nav.createToken' },
	];

	// Secondary nav — shown in mobile drawer and footer only
	const secondaryLinks: { href: string; key: import('$lib/i18n').TranslationKey }[] = [
		{ href: '/manage-tokens', key: 'nav.manageTokens' },
		{ href: '/affiliate', key: 'nav.affiliate' },
	];

	// Mobile "More" tab is active when on any page that isn't the home page
	// or one of the primary bottom-tab destinations.
	const primaryTabHrefs = ['/explore', '/launchpad', '/trade', '/create'];
	const moreTabActive = $derived(
		page.url.pathname !== '/' &&
			!primaryTabHrefs.some((p) => page.url.pathname.startsWith(p))
	);

	// Nav search state
	let navSearch = $state('');
	function handleNavSearch(e: KeyboardEvent) {
		if (e.key === 'Enter' && navSearch.trim()) {
			window.location.href = `/explore?q=${encodeURIComponent(navSearch.trim())}`;
		}
	}

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
		href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@400;600;700;800&family=Rajdhani:wght@400;500;600;700&display=swap"
		rel="stylesheet"
	/>
</svelte:head>

<!-- Skip to content -->
<a
	href="#main-content"
	class="absolute -left-[9999px] top-auto w-px h-px overflow-hidden focus:fixed focus:top-2 focus:left-2 focus:w-auto focus:h-auto focus:py-2 focus:px-4 focus:bg-surface focus:text-foreground focus:border focus:border-line focus:rounded-lg focus:z-[200] focus:font-mono focus:text-[13px]"
>Skip to main content</a>


<!-- Navigation loading bar -->
{#if navigating.to}
	<div class="fixed top-0 left-0 right-0 h-0.5 z-[9999] bg-transparent overflow-hidden"><div class="h-full origin-left animate-[nav-load_1.5s_ease-in-out_infinite]" style="background: linear-gradient(90deg, #00d2ff, #3a7bd5);"></div></div>
{/if}

<!-- Offline Banner -->
{#if isOffline}
	<div class="fixed top-0 left-0 right-0 z-[110] flex items-center justify-center gap-1.5 py-1.5 px-3 font-mono text-[11px] font-semibold animate-[slideDown_0.3s_ease-out]" style="background: #7f1d1d; color: #fca5a5;">
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.56 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>
		<span>You're offline</span>
	</div>
{/if}

<!-- PWA Install Banner -->
{#if showInstallBanner}
	<div class="fixed bottom-0 left-0 right-0 z-[90] flex items-center justify-between gap-3 px-4 py-3 bg-surface border-t border-cyan-400/15 shadow-[0_-4px_24px_rgba(0,0,0,0.4)] animate-[slideUpBanner_0.3s_ease-out]">
		<div class="flex items-center gap-2.5 flex-1 min-w-0">
			<div class="w-9 h-9 rounded-[10px] shrink-0 flex items-center justify-center bg-cyan-400/10 text-cyan-400">
				<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
			</div>
			<div class="flex flex-col gap-px min-w-0">
				<span class="syne text-[13px] font-bold text-white">Install TokenKrafter</span>
				<span class="text-[11px] text-dim">Add to home screen for a faster experience</span>
			</div>
		</div>
		<div class="flex items-center gap-2 shrink-0">
			<button class="syne text-xs font-bold text-white border-none rounded-lg px-4 py-2 cursor-pointer transition-all duration-150 hover:shadow-[0_4px_16px_rgba(0,210,255,0.3)]" style="background: linear-gradient(135deg, #00d2ff, #3a7bd5);" onclick={async () => {
				if (installPrompt) {
					installPrompt.prompt();
					const result = await installPrompt.userChoice;
					if (result.outcome === 'accepted') {
						showInstallBanner = false;
					}
					installPrompt = null;
				}
			}}>Install</button>
			<button aria-label="Dismiss install prompt" class="bg-transparent border-none text-dim cursor-pointer p-1 rounded-md transition-all duration-150 hover:text-white hover:bg-surface-hover" onclick={() => {
				showInstallBanner = false;
				localStorage.setItem('pwa_install_dismissed', '1');
			}}>
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
			</button>
		</div>
	</div>
{/if}

<!-- Toast Notifications -->
<div class="fixed top-4 right-4 z-[100] flex flex-col gap-2 max-w-[380px] w-[calc(100%-32px)] pointer-events-none">
	{#each feedbacks as feedback (feedback.id)}
		<div class="toast toast-{feedback.type} pointer-events-auto relative overflow-hidden flex items-start gap-2.5 py-3 px-3.5 rounded-xl bg-surface border border-line animate-[toastIn_0.3s_ease-out]" style="box-shadow: 0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px rgba(0,0,0,0.2);">
			<div class="toast-icon w-7 h-7 rounded-lg shrink-0 flex items-center justify-center">
				{#if feedback.type === 'success'}
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M20 6L9 17l-5-5"/></svg>
				{:else if feedback.type === 'error'}
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
				{:else}
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
				{/if}
			</div>
			<span class="flex-1 font-mono text-xs text-foreground leading-normal pt-1">{feedback.message}</span>
			<button class="shrink-0 bg-transparent border-none cursor-pointer text-dim p-0.5 rounded transition-all duration-150 hover:text-muted hover:bg-surface-hover" onclick={() => hideFeedback(feedback.id)} aria-label="Dismiss">
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
			</button>
			<div class="toast-progress absolute bottom-0 left-0 h-0.5 animate-[toastProgress_5s_linear_forwards]"></div>
		</div>
	{/each}
</div>

<!-- AppKit handles the wallet modal -->

<!-- App Shell — flex column, viewport height -->
<div class="app-shell flex flex-col w-full min-h-screen md:h-screen md:overflow-hidden">
	<div class="grid-bg fixed inset-0 pointer-events-none z-0"></div>
	<div class="glow-orb fixed top-[-20%] left-[30%] w-[700px] h-[700px] pointer-events-none z-0"></div>
	<div class="glow-orb-2 fixed bottom-[-20%] right-[10%] w-[500px] h-[500px] pointer-events-none z-0"></div>

	<!-- Navbar -->
	<nav class="nav-bar sticky top-0 z-50 flex-shrink-0 border-b backdrop-blur-xl" style="border-color: var(--border-subtle)">
		<div class="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
			<!-- Logo: icon-only on mobile, wide lockup on tablet+ -->
			<a href="/" class="flex items-center flex-shrink-0 group" aria-label="TokenKrafter">
				<img src="/brand/icon.svg" alt="" class="w-11 h-11 sm:hidden transition group-hover:drop-shadow-[0_0_8px_rgba(0,188,212,0.5)]" />
				<img src="/brand/logo-wide.svg" alt="TokenKrafter" class="hidden sm:block nav-logo-wide transition group-hover:drop-shadow-[0_0_10px_rgba(0,188,212,0.5)]" />
			</a>

			<!-- Center nav links -->
			<div class="hidden md:flex items-center gap-0.5">
				{#each navLinks as link}
					<a
						href={link.href}
						onclick={() => { if (link.href === '/create') createMode.set(null); }}
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
				{#if isAdmin}
					<a
						href="/_"
						class="nav-link px-3 py-1.5 rounded-md text-[13px] transition font-mono
						{page.url.pathname.startsWith('/_')
							? 'text-cyan-400 bg-cyan-400/10'
							: 'text-gray-400 hover:text-white hover:bg-white/5'}"
					>{$t('nav.admin')}</a>
				{/if}
			</div>

			<!-- Right side: actions -->
			<div class="flex items-center gap-2">
				<!-- Nav search -->
				<div class="nav-search hidden md:flex items-center gap-1.5 py-[5px] px-2.5 rounded-lg bg-surface border border-line transition-colors duration-150 focus-within:border-cyan-400/30">
					<svg class="text-dim shrink-0" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
					<input
						type="text"
						class="bg-transparent border-none outline-none text-foreground font-mono text-[11px] w-[120px] focus:w-[180px] transition-[width] duration-200 placeholder:text-dim"
						placeholder="Search tokens..."
						bind:value={navSearch}
						onkeydown={handleNavSearch}
					/>
				</div>

				<!-- Theme toggle -->
				<button
					class="flex items-center justify-center w-8 h-8 rounded-lg bg-transparent border border-line text-dim cursor-pointer transition-all duration-150 hover:border-cyan-400/30 hover:text-cyan-400 hover:bg-cyan-400/5"
					onclick={toggleTheme}
					title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
					aria-label="Toggle theme"
				>
					{#if theme === 'dark'}
						<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
					{:else}
						<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
					{/if}
				</button>

				<div class="lang-desktop"><LanguageSwitcher /></div>
				{#if walletLoading || oauthPending}
					<div class="wallet-btn wallet-skeleton"><span class="skeleton-bar"></span></div>
				{:else if userAddress}
					<button class="wallet-btn" onclick={() => {
						if (walletType === 'external') { const kit = getAppKit(); if (kit) kit.open(); }
						else if (walletType === 'embedded' && !signer && walletModalRef) { walletModalRef.openAt('pin-enter'); }
						else if (walletType === 'embedded') { showAccountPanel = true; }
						else { showWalletModal = true; }
					}}>
						<span class="wallet-dot" class:wallet-dot-locked={walletType === 'embedded' && !signer}></span>
						{userAddress.slice(0, 6)}...{userAddress.slice(-4)}
					</button>
				{:else}
					<button class="wallet-btn wallet-btn-connect" onclick={() => showWalletModal = true}>
						<span class="hide-mobile">Connect Wallet</span><span class="show-mobile">Connect</span>
					</button>
				{/if}
			</div>
		</div>
	</nav>

	<!-- Mobile Menu Overlay + Drawer -->
	{#if mobileMenuOpen}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="fixed inset-0 z-40 md:hidden bg-black/60 backdrop-blur-[4px] animate-[fadeIn_0.25s_ease-out]"
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
				{#each navLinks as link}
					<a
						href={link.href}
						onclick={() => { mobileMenuOpen = false; if (link.href === '/create') createMode.set(null); }}
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
				{#if isAdmin}
					<a
						href="/_"
						onclick={() => (mobileMenuOpen = false)}
						class="mobile-nav-link px-4 py-2.5 rounded-lg text-xs transition font-mono flex items-center
						{page.url.pathname.startsWith('/_')
							? 'text-cyan-400 bg-cyan-400/10'
							: 'text-gray-500 hover:text-white hover:bg-white/5'}"
					>{$t('nav.admin')}</a>
				{/if}
			</nav>

			<!-- Bottom actions -->
			<div class="px-4 py-5 border-t flex flex-col gap-3" style="border-color: var(--border-subtle)">
				<div class="flex items-center justify-between">
					<span class="text-xs font-mono uppercase tracking-wider" style="color: var(--text-dim)">Language</span>
					<LanguageSwitcher direction="up" />
				</div>
				{#if walletLoading || oauthPending}
					<div class="wallet-btn wallet-skeleton"><span class="skeleton-bar"></span></div>
				{:else if userAddress}
					<button class="wallet-btn wallet-btn-sm" onclick={() => {
						mobileMenuOpen = false;
						if (walletType === 'external') { const kit = getAppKit(); if (kit) kit.open(); }
						else if (walletType === 'embedded' && !signer && walletModalRef) { walletModalRef.openAt('pin-enter'); }
						else if (walletType === 'embedded') { showAccountPanel = true; }
						else { showWalletModal = true; }
					}}>
						<span class="wallet-dot" class:wallet-dot-locked={walletType === 'embedded' && !signer}></span>
						{userAddress.slice(0, 6)}...{userAddress.slice(-4)}
					</button>
				{:else}
					<button class="wallet-btn wallet-btn-connect" onclick={() => { showWalletModal = true; mobileMenuOpen = false; }}>
						<span class="hide-mobile">Connect Wallet</span><span class="show-mobile">Connect</span>
					</button>
				{/if}
			</div>
		</div>
	</div>

	<div id="scroll-container" class="flex-1 md:overflow-y-auto overflow-x-hidden pb-16 md:pb-0 pt-14 md:pt-0">
	<main id="main-content" class="min-h-screen">
		{@render children?.()}
	</main>

	<!-- Footer -->
	<footer class="bg-footer border-t mt-auto" style="border-color: var(--border-subtle)">
		<div class="max-w-7xl mx-auto px-4 sm:px-6 py-12">
			<div class="grid grid-cols-1 sm:grid-cols-3 gap-10 sm:gap-8">
				<!-- Brand -->
				<div>
					<a href="/" class="inline-flex items-center mb-4 group" aria-label="TokenKrafter">
						<img src="/brand/logo-wide.svg" alt="TokenKrafter" class="footer-logo-wide transition group-hover:drop-shadow-[0_0_10px_rgba(0,188,212,0.5)]" />
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
						<a href="/privacy" class="text-sm text-gray-400 hover:text-cyan-400 transition font-mono">Privacy Policy</a>
						<a href="/contracts" class="text-sm text-gray-400 hover:text-cyan-400 transition font-mono">Contracts</a>
						<a href="/team" class="text-sm text-gray-400 hover:text-cyan-400 transition font-mono">Team</a>
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
								class="no-underline flex items-center gap-2 px-3 py-2 rounded-lg border border-white/7 bg-white/3 hover:border-cyan-500/30 hover:bg-cyan-500/5 transition text-sm font-mono text-gray-400 hover:text-cyan-400"
								title={social.label}
								aria-label={social.label}
							>
								<svg class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="currentColor">{@html social.svg}</svg>
								<span class="hidden sm:inline">{social.label}</span>
							</a>
						{/each}
					</div>
				</div>
			</div>

			<hr class="divider mt-10 mb-6" />

			<div class="flex flex-col sm:flex-row items-center justify-between gap-4">
				<p class="text-xs font-mono" style="color: var(--text-dim)">&copy; {new Date().getFullYear()} TokenKrafter. {$t('footer.allRightsReserved')}.</p>
			</div>
		</div>
	</footer>
	</div>

	<!-- Mobile Bottom Tab Bar -->
	<div class="fixed bottom-0 left-0 right-0 z-40 md:hidden flex items-stretch h-[60px] bg-background border-t border-line" style="padding-bottom: env(safe-area-inset-bottom, 0px);">
		<a href="/explore" aria-current={page.url.pathname.startsWith('/explore') ? 'page' : undefined} class="bottom-tab relative flex-1 flex flex-col items-center justify-center gap-0.5 border-none bg-none no-underline font-mono text-[10px] cursor-pointer transition-colors duration-150 hover:text-foreground active:text-foreground {page.url.pathname.startsWith('/explore') ? 'text-cyan-400 font-bold bg-cyan-400/5' : 'text-dim'}">
			<span aria-hidden="true" class="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-[3px] rounded-b-full bg-cyan-400 transition-opacity duration-150 {page.url.pathname.startsWith('/explore') ? 'opacity-100' : 'opacity-0'}"></span>
			<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
			<span>Explore</span>
		</a>
		<a href="/launchpad" aria-current={page.url.pathname.startsWith('/launchpad') ? 'page' : undefined} class="bottom-tab relative flex-1 flex flex-col items-center justify-center gap-0.5 border-none bg-none no-underline font-mono text-[10px] cursor-pointer transition-colors duration-150 hover:text-foreground active:text-foreground {page.url.pathname.startsWith('/launchpad') ? 'text-cyan-400 font-bold bg-cyan-400/5' : 'text-dim'}">
			<span aria-hidden="true" class="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-[3px] rounded-b-full bg-cyan-400 transition-opacity duration-150 {page.url.pathname.startsWith('/launchpad') ? 'opacity-100' : 'opacity-0'}"></span>
			<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
			<span>Launchpad</span>
		</a>
		<a href="/trade" aria-current={page.url.pathname.startsWith('/trade') ? 'page' : undefined} class="bottom-tab relative flex-1 flex flex-col items-center justify-center gap-0.5 border-none bg-none no-underline font-mono text-[10px] cursor-pointer transition-colors duration-150 hover:text-foreground active:text-foreground {page.url.pathname.startsWith('/trade') ? 'text-cyan-400 font-bold bg-cyan-400/5' : 'text-dim'}">
			<span aria-hidden="true" class="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-[3px] rounded-b-full bg-cyan-400 transition-opacity duration-150 {page.url.pathname.startsWith('/trade') ? 'opacity-100' : 'opacity-0'}"></span>
			<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4"/></svg>
			<span>Trade</span>
		</a>
		<a href="/create" onclick={() => createMode.set(null)} aria-current={page.url.pathname.startsWith('/create') ? 'page' : undefined} class="bottom-tab relative flex-1 flex flex-col items-center justify-center gap-0.5 border-none bg-none no-underline font-mono text-[10px] cursor-pointer transition-colors duration-150 hover:text-foreground active:text-foreground {page.url.pathname.startsWith('/create') ? 'text-cyan-400 font-bold bg-cyan-400/5' : 'text-dim'}">
			<span aria-hidden="true" class="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-[3px] rounded-b-full bg-cyan-400 transition-opacity duration-150 {page.url.pathname.startsWith('/create') ? 'opacity-100' : 'opacity-0'}"></span>
			<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
			<span>Create</span>
		</a>
		<button aria-current={moreTabActive ? 'page' : undefined} class="relative flex-1 flex flex-col items-center justify-center gap-0.5 border-none bg-none font-mono text-[10px] cursor-pointer transition-colors duration-150 hover:text-foreground active:text-foreground {moreTabActive ? 'text-cyan-400 font-bold bg-cyan-400/5' : 'text-dim'}" onclick={() => (mobileMenuOpen = !mobileMenuOpen)}>
			<span aria-hidden="true" class="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-[3px] rounded-b-full bg-cyan-400 transition-opacity duration-150 {moreTabActive ? 'opacity-100' : 'opacity-0'}"></span>
			<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
			<span>More</span>
		</button>
	</div>
</div>

<WalletModal
	bind:open={showWalletModal}
	bind:this={walletModalRef}
	onConnected={handleWalletConnected}
	onWalletConnect={openWalletConnect}
	onDisconnect={disconnectWallet}
/>

{#if showAccountPanel}
<AccountPanel
	bind:open={showAccountPanel}
	userAddress={userAddress || ''}
	walletType={walletType ?? 'embedded'}
	networkName={supportedNetworks[0]?.name || 'BNB Smart Chain'}
	nativeCoin={supportedNetworks[0]?.native_coin || 'BNB'}
	{nativeBalance}
	nativeDecimals={18}
	{nativePriceUsd}
	rpcUrl={supportedNetworks[0]?.rpc || 'https://bsc-rpc.publicnode.com'}
	dexRouter={supportedNetworks[0]?.dex_router || ''}
	usdtAddress={supportedNetworks[0]?.usdt_address || ''}
	usdcAddress={supportedNetworks[0]?.usdc_address || ''}
	chainId={supportedNetworks[0]?.chain_id || 56}
	{wsManager}
	tokens={[]}
	onDisconnect={disconnectWallet}
	onAddFeedback={addFeedback}
	onAccountSwitch={(addr) => {
		userAddress = addr;
		const net = supportedNetworks[0];
		if (net?.rpc && walletType === 'embedded') {
			const rpcProvider = new ethers.JsonRpcProvider(net.rpc, net.chain_id, { staticNetwork: true });
			signer = getEmbeddedSigner(rpcProvider);
		}
		updatePollerAddress(addr);
	}}
	onRefreshBalance={() => {
		refreshBalancesNow();
	}}
/>
{/if}

<style>
	:global(*) { box-sizing: border-box; }
	:global(body) {
		background: var(--bg);
		color: var(--text);
		font-family: 'Space Mono', monospace;
		margin: 0;
	}
	:global(.syne) { font-family: 'Syne', sans-serif; }

	/* Keyframes — referenced via `animate-[name_...]` utilities in markup */
	@keyframes nav-load {
		0% { transform: scaleX(0) translateX(0); }
		50% { transform: scaleX(0.6) translateX(20%); }
		100% { transform: scaleX(0) translateX(100%); }
	}
	@keyframes slideDown { from { transform: translateY(-100%); } to { transform: translateY(0); } }
	@keyframes slideUpBanner { from { transform: translateY(100%); } to { transform: translateY(0); } }
	@keyframes toastIn {
		from { opacity: 0; transform: translateY(-8px) scale(0.96); }
		to   { opacity: 1; transform: translateY(0) scale(1); }
	}
	@keyframes toastProgress {
		from { width: 100%; }
		to { width: 0%; }
	}
	@keyframes spin { to { transform: rotate(360deg); } }
	@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
	@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

	/* Toast type-colors — attribute-keyed variants keep tight scoping */
	.toast-success .toast-icon { background: rgba(16,185,129,0.12); color: #10b981; }
	.toast-error .toast-icon { background: rgba(239,68,68,0.12); color: #ef4444; }
	.toast-info .toast-icon { background: rgba(0,210,255,0.12); color: #00d2ff; }
	.toast-success .toast-progress { background: #10b981; }
	.toast-error .toast-progress { background: #ef4444; }
	.toast-info .toast-progress { background: #00d2ff; }

	/* Background decoration layers (radial gradients from CSS vars) */
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
	.nav-logo-wide { height: 56px; width: auto; }
	.footer-logo-wide { height: 64px; width: auto; display: block; }
	/* On mobile, force fixed positioning so the nav never scrolls away.
	   sticky can break when ancestor elements have overflow/transform. */
	@media (max-width: 767px) {
		.nav-bar { position: fixed !important; left: 0; right: 0; }
	}

	/* Wallet button — base + variants. Kept as named class because it's
	   referenced from many template branches. */
	.wallet-btn {
		display: inline-flex; align-items: center; gap: 6px;
		padding: 6px 12px; border-radius: 8px;
		background: var(--bg-surface, rgba(255,255,255,0.05));
		border: 1px solid var(--border, rgba(255,255,255,0.08));
		color: var(--text, #e2e8f0); font-family: 'Space Mono', monospace; font-size: 12px;
		cursor: pointer; transition: all 0.15s;
	}
	.wallet-btn:hover { border-color: rgba(0,210,255,0.3); background: var(--bg-surface-hover, rgba(255,255,255,0.08)); }
	.wallet-btn-connect {
		background: linear-gradient(135deg, #0891b2, #1d4ed8); border: none;
		color: white; font-family: 'Syne', sans-serif; font-weight: 700; font-size: 13px;
		padding: 8px 16px; border-radius: 10px;
		box-shadow: 0 2px 8px rgba(8,145,178,0.3);
	}
	.wallet-btn-connect:hover { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(8,145,178,0.4); background: linear-gradient(135deg, #0e7490, #1e40af); }
	.wallet-btn-sm { font-size: 11px; padding: 5px 10px; }
	.show-mobile { display: none; }
	@media (max-width: 640px) { .hide-mobile { display: none; } .show-mobile { display: inline; } }
	.wallet-skeleton { width: 100px; cursor: default; }
	.skeleton-bar {
		display: block; width: 100%; height: 10px; border-radius: 4px;
		background: linear-gradient(90deg, rgba(255,255,255,0.03) 25%, rgba(255,255,255,0.06) 50%, rgba(255,255,255,0.03) 75%);
		background-size: 200% 100%; animation: shimmer 1.5s infinite;
	}
	.wallet-dot {
		width: 7px; height: 7px; border-radius: 50%; background: #10b981; flex-shrink: 0;
	}
	.wallet-dot-locked { background: #fbbf24; }

	/* Lang/wallet desktop visibility toggles */
	.lang-desktop, .wallet-desktop { display: none; }
	@media (min-width: 768px) {
		.lang-desktop { display: block; }
		.wallet-desktop { display: block; }
	}

	/* Mobile drawer — translateX transition, can't cleanly express the
	   preset cubic-bezier as a Tailwind arbitrary, so kept custom. */
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
	.mobile-nav-link { font-family: 'Space Mono', monospace; }
</style>
