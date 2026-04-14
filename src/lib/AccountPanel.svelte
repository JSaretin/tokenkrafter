<script lang="ts">
	import { goto } from '$app/navigation';
	import { ethers } from 'ethers';
	import { fly, fade } from 'svelte/transition';
	import {
		getWalletState,
		exportPrivateKey,
		exportSeedPhrase,
		setActiveAccount,
		unlockWallet,
		onWalletStateChange,
		getSigner,
		pushPreferences,
		getAccountName,
		setAccountMeta,
		getAccountMeta,
		getAllAccountMeta,
		extendSession,
		type WalletState,
		type WalletContext,
	} from './embeddedWallet';
	import WalletSwitcher from './WalletSwitcher.svelte';
	import { getKnownLogo, resolveTokenLogo } from './tokenLogo';
	import { balanceState } from './balancePoller';
	import { queryTradeLens } from './tradeLens';
	import { friendlyError } from './errorDecoder';
	import QrCode from './QrCode.svelte';
	import { t } from '$lib/i18n';

	let {
		open = $bindable(false),
		userAddress = $bindable(''),
		walletType = 'embedded' as 'embedded' | 'external',
		networkName = 'BNB Smart Chain',
		nativeCoin = 'BNB',
		nativeBalance = 0n,
		nativeDecimals = 18,
		nativePriceUsd = 0,
		rpcUrl = 'https://bsc-rpc.publicnode.com',
		dexRouter = '',
		usdtAddress = '',
		usdcAddress = '',
		chainId = 56,
		tokens = [] as { address: string; symbol: string; name: string; balance: bigint; decimals: number; priceUsd?: number }[],
		onDisconnect = () => {},
		onAddFeedback = (_: { message: string; type: string }) => {},
		onAccountSwitch = (_addr: string) => {},
		onRefreshBalance = () => {},
	}: {
		open: boolean;
		userAddress: string;
		walletType: 'embedded' | 'external';
		networkName: string;
		nativeCoin: string;
		nativeBalance: bigint;
		nativeDecimals: number;
		nativePriceUsd: number;
		rpcUrl: string;
		dexRouter: string;
		usdtAddress: string;
		usdcAddress: string;
		chainId: number;
		tokens: { address: string; symbol: string; name: string; balance: bigint; decimals: number; priceUsd?: number }[];
		onDisconnect: () => void;
		onAddFeedback: (f: { message: string; type: string }) => void;
		onAccountSwitch: (addr: string) => void;
		onRefreshBalance: () => void;
	} = $props();

	// ── Reactive wallet state (re-renders on account switch, add, etc.) ──
	let walletState = $state<WalletState>(getWalletState());
	$effect(() => {
		const unsub = onWalletStateChange((s) => {
			walletState = s;
			// Update parent's userAddress when active account changes
			if (s.activeAccount?.address && s.activeAccount.address !== userAddress) {
				userAddress = s.activeAccount.address;
			}
		});
		return unsub;
	});

	// Auto-close the panel on disconnect — defends against any path that
	// clears userAddress without explicitly closing the panel. Without this
	// the chip lingers with stale "Account 4" state because the wallet
	// store has been reset but the parent never closed the panel.
	$effect(() => {
		if (open && walletType === 'embedded' && !userAddress) {
			close();
		}
	});

	let accounts = $derived(walletState.accounts || []);
	let activeIndex = $derived(walletState.activeAccount?.index ?? 0);

	let nativeBalFormatted = $derived(parseFloat(ethers.formatUnits(nativeBalance, nativeDecimals)));
	let nativeUsd = $derived(nativeBalFormatted * nativePriceUsd);
	let totalUsd = $derived.by(() => {
		let total = nativeUsd;
		for (const t of tokens) {
			if (t.priceUsd) total += parseFloat(ethers.formatUnits(t.balance, t.decimals)) * t.priceUsd;
		}
		for (const t of importedTokens) {
			if (t.priceUsd && t.balance > 0n) total += parseFloat(ethers.formatUnits(t.balance, t.decimals)) * t.priceUsd;
		}
		return total;
	});

	// Total portfolio in native coin equivalent
	let totalNativeEquiv = $derived(nativePriceUsd > 0 ? totalUsd / nativePriceUsd : 0);

	// All displayable tokens sorted by USD value (highest first, hide zero balance)
	let sortedTokens = $derived.by(() => {
		const all = [...tokens, ...importedTokens]
			.filter(t => t.balance > 0n)
			.map(t => {
				const bal = parseFloat(ethers.formatUnits(t.balance, t.decimals));
				const usd = t.priceUsd ? bal * t.priceUsd : 0;
				return { ...t, _bal: bal, _usd: usd };
			});
		return all.sort((a, b) => b._usd - a._usd);
	});

	// ── UI state ──
	type View = 'main' | 'receive' | 'security' | 'export-key' | 'export-seed';
	let view = $state<View>('main');
	// Send is a bottom-up sheet overlaid on the main wallet panel, not a
	// full-view swap — keeps the user's balance / account chrome visible
	// behind the form (MetaMask-style).
	let showSend = $state(false);
	let showSwitcher = $state(false);

	// ── Multi-wallet derived state (for switcher chip + send tab) ──
	let wallets = $derived<WalletContext[]>(walletState.wallets || []);
	let activeWalletId = $derived(walletState.activeWalletId);
	let activeWallet = $derived(wallets.find((w) => w.id === activeWalletId) || null);

	function handleSwitcherAccountSwitched(addr: string) {
		userAddress = addr;
		onAccountSwitch(addr);
		// Restore cached portfolio for the new account
		lastRestoredAddr = addr;
		restoreWalletCache(addr);
	}

	// Well-known token logos (native + major stables).
	// Accepts null/undefined because Svelte 5 evaluates `{@const}` + child
	// `{#if}` deriveds inside an `{:else}` branch regardless of whether that
	// branch is currently rendered — an unguarded `tok.logoUrl` crashes the
	// whole effect graph when `sendAsset === 'native'` and no token matches.
	function getTokenLogo(tok: { symbol: string; logoUrl?: string; address?: string } | null | undefined): string {
		if (!tok) return '';
		if (tok.logoUrl) return tok.logoUrl;
		return getKnownLogo(tok.symbol || '');
	}

	// ── Per-wallet account name resolution (re-reads from store when wallet
	//    or wallet metadata changes; uses a tick counter so renames bust the
	//    derived caches without needing to re-derive every paint).
	let metaTick = $state(0);
	function bumpMeta() { metaTick++; pushPreferences().catch(() => {}); }

	function acctName(idx: number): string {
		void metaTick;
		if (!activeWalletId) return `Account ${idx + 1}`;
		return getAccountName(activeWalletId, idx);
	}

	function acctAvatar(idx: number): string {
		void metaTick;
		if (!activeWalletId) return '';
		const map = getAllAccountMeta(activeWalletId);
		return map[String(idx)]?.avatar || '';
	}

	let copiedAddr = $state(false);


	// Export
	let exportPin = $state('');
	let exportedValue = $state('');
	let exportError = $state('');

	// Send
	let sendTo = $state('');
	let sendAmount = $state('');
	let sending = $state(false);
	let sendAsset = $state<'native' | string>('native'); // 'native' or token address
	let showAssetPicker = $state(false);
	// Two-step send: user fills the form, then sees a preview card summarising
	// recipient / amount / estimated fee before the tx actually signs. The
	// preview step is what the user explicitly approves — the form's button
	// only *advances* to it.
	let sendStep = $state<'form' | 'preview'>('form');
	let sendFeeEst = $state<string>(''); // human-readable native-coin fee, empty if unknown
	let sendFeeLoading = $state(false);
	// Preview amount display: false = full precision (default), true = compact
	// (B/T/M) for fast legibility of huge numbers. Toggles on tap. Reset per
	// Send session so the first view is always the precise value.
	let previewCompact = $state(false);

	// Per-row compact toggle on the home token list. Rows default to full
	// precision (matches the Send preview); tapping a row's USD "worth"
	// toggles it into compact form. Keyed by lowercased address — or the
	// literal string 'native' for the native-coin row.
	let compactRows = $state<Set<string>>(new Set());
	function toggleRowCompact(key: string) {
		const next = new Set(compactRows);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		compactRows = next;
	}

	// Address book picker — opened via the book icon on the recipient field.
	// Lists the user's own addresses across every wallet, with the current
	// wallet's accounts pinned to the top (most common case: moving between
	// hot/cold accounts you already control).
	let showAddressBook = $state(false);
	let addressBookQuery = $state('');

	type BookEntry = {
		address: string;
		label: string;
		sublabel: string;
		avatar: string;
		group: 'current' | 'other';
	};

	// Locked wallets only expose their default_address (account 0); we don't
	// have derivation paths for index>0 until unlock. So for non-active
	// wallets we surface just the primary account — good enough for the
	// "send to my other wallet" use case.
	let addressBookEntries = $derived.by<BookEntry[]>(() => {
		void metaTick;
		const entries: BookEntry[] = [];
		const activeAddrLower = (userAddress || '').toLowerCase();

		if (activeWallet) {
			for (const acc of activeWallet.accounts || []) {
				if (acc.address.toLowerCase() === activeAddrLower) continue;
				const meta = getAccountMeta(activeWallet.id, acc.index);
				entries.push({
					address: acc.address,
					label: meta.name || `Account ${acc.index + 1}`,
					sublabel: `${activeWallet.name} · ${acc.address.slice(0, 6)}…${acc.address.slice(-4)}`,
					avatar: meta.avatar || '',
					group: 'current',
				});
			}
		}

		for (const w of wallets) {
			if (w.id === activeWalletId) continue;
			if (!w.defaultAddress) continue;
			if (w.defaultAddress.toLowerCase() === activeAddrLower) continue;
			const meta = getAccountMeta(w.id, 0);
			entries.push({
				address: w.defaultAddress,
				label: w.name || 'Wallet',
				sublabel: `${meta.name || 'Account 1'} · ${w.defaultAddress.slice(0, 6)}…${w.defaultAddress.slice(-4)}`,
				avatar: meta.avatar || '',
				group: 'other',
			});
		}

		return entries;
	});

	// Filter the book by the search query. Matches label, sublabel, or the
	// full address — so the user can paste/type part of any to narrow.
	let filteredBookEntries = $derived.by<BookEntry[]>(() => {
		const q = addressBookQuery.trim().toLowerCase();
		if (!q) return addressBookEntries;
		return addressBookEntries.filter(
			(e) =>
				e.label.toLowerCase().includes(q) ||
				e.sublabel.toLowerCase().includes(q) ||
				e.address.toLowerCase().includes(q)
		);
	});

	// Resolved token for the current sendAsset selection. `null` when
	// sendAsset === 'native' OR no match. Lifted to script level so the
	// template can branch on it directly instead of using `{@const}`
	// inside `{:else}` — the latter tickles a Svelte 5 reactivity bug
	// where descendant deriveds evaluate before the `{#if tok}` guard
	// and crash on `tok.symbol`.
	let sendAssetTok = $derived.by(() => {
		if (sendAsset === 'native') return null;
		const target = sendAsset.toLowerCase();
		return [...tokens, ...importedTokens].find((t) => t.address.toLowerCase() === target) || null;
	});

	let sendAssetInfo = $derived(
		sendAssetTok
			? { symbol: sendAssetTok.symbol, decimals: sendAssetTok.decimals, balance: sendAssetTok.balance, priceUsd: sendAssetTok.priceUsd || 0 }
			: { symbol: nativeCoin, decimals: nativeDecimals, balance: nativeBalance, priceUsd: nativePriceUsd }
	);

	// Preview derived values — lifted out of {@const} inside the
	// {#if sendStep === 'preview'} block because the block's local
	// deriveds were getting destroyed mid-flight during fly-out
	// transitions and throwing "$.get(...) is undefined".
	let previewUsd = $derived(parseFloat(sendAmount || '0') * (sendAssetInfo?.priceUsd || 0));
	let previewBookLabel = $derived(matchBookLabel(sendTo));

	// Import
	let importAddress = $state('');
	let showImport = $state(false);
	let importLoading = $state(false);
	let importedTokens = $state<{ address: string; symbol: string; name: string; balance: bigint; decimals: number; priceUsd?: number; logoUrl?: string }[]>([]);

	// Load imported tokens from localStorage on mount
	$effect(() => {
		try {
			const saved = localStorage.getItem('imported_tokens');
			if (saved) {
				const parsed = JSON.parse(saved);
				importedTokens = parsed.map((t: any) => ({ ...t, balance: 0n, logoUrl: t.logoUrl || '' }));
			}
		} catch {}
	});

	// Auto-import tokens the user created on the platform
	let autoImportDone = $state<string>('');
	async function autoImportCreatedTokens() {
		if (!userAddress || autoImportDone === userAddress) return;
		autoImportDone = userAddress;
		try {
			const res = await fetch(`/api/created-tokens?creator=${userAddress}&limit=50`);
			if (!res.ok) return;
			const rows = await res.json();
			if (!rows?.length) return;

			let changed = false;
			for (const r of rows) {
				const addr = r.address?.toLowerCase();
				if (!addr) continue;
				if (importedTokens.some(t => t.address.toLowerCase() === addr)) continue;
				importedTokens.push({
					address: addr,
					symbol: r.symbol || '???',
					name: r.name || 'Unknown',
					decimals: r.decimals || 18,
					balance: 0n,
					logoUrl: r.logo_url || '',
				});
				changed = true;
			}
			if (changed) {
				importedTokens = [...importedTokens];
				const toSave = importedTokens.map(t => ({ address: t.address, name: t.name, symbol: t.symbol, decimals: t.decimals, logoUrl: t.logoUrl || '' }));
				localStorage.setItem('imported_tokens', JSON.stringify(toSave));
				pushPreferences();
			}
		} catch {}
	}

	// Refresh balances + auto-import when address changes
	$effect(() => {
		if (!userAddress) return;
		autoImportCreatedTokens();
		if (importedTokens.length === 0) return;
		refreshTokenBalances();
		// Fetch missing logos via shared cache
		for (const tok of importedTokens) {
			if (!tok.logoUrl && tok.address) {
				resolveTokenLogo(tok.address, 56).then(url => {
					if (url) {
						tok.logoUrl = url;
						importedTokens = [...importedTokens];
						const toSave = importedTokens.map(t => ({ address: t.address, name: t.name, symbol: t.symbol, decimals: t.decimals, logoUrl: t.logoUrl || '' }));
						localStorage.setItem('imported_tokens', JSON.stringify(toSave));
					}
				});
			}
		}
	});

	// Sync balances from background poller
	const unsubPoller = balanceState.subscribe((state) => {
		if (state.lastUpdated === 0 || importedTokens.length === 0) return;
		let changed = false;
		for (const tok of importedTokens) {
			const polled = state.tokens.find(t => t.address.toLowerCase() === tok.address.toLowerCase());
			if (polled && polled.balance !== tok.balance) {
				tok.balance = polled.balance;
				changed = true;
			}
		}
		if (changed) importedTokens = [...importedTokens];
	});

	let portfolioLoading = $state(false);
	let portfolioPolling = $state(false);

	function getProvider(): { provider: ethers.JsonRpcProvider } | null {
		try { return { provider: new ethers.JsonRpcProvider(rpcUrl) }; } catch { return null; }
	}

	// ── Wallet cache (per address, localStorage) ──
	function cacheKey(addr: string) { return `wc_${addr.toLowerCase()}`; }


	function restoreWalletCache(addr: string): boolean {
		try {
			const raw = localStorage.getItem(cacheKey(addr));
			if (!raw) return false;
			const cache = JSON.parse(raw);
			if (!cache.updatedAt) return false;

			nativeBalance = BigInt(cache.nativeBalance || '0');
			nativePriceUsd = cache.nativePriceUsd || 0;

			for (const cached of cache.tokens || []) {
				const tok = importedTokens.find(t => t.address.toLowerCase() === cached.address.toLowerCase());
				if (tok) {
					tok.balance = BigInt(cached.balance || '0');
					tok.priceUsd = cached.priceUsd || 0;
					if (cached.logoUrl && !(tok as any).logoUrl) (tok as any).logoUrl = cached.logoUrl;
				}
			}
			importedTokens = [...importedTokens];
			return true;
		} catch { return false; }
	}

	async function refreshTokenBalances() {
		if (!userAddress || !dexRouter) return;
		if (portfolioPolling) return;
		portfolioPolling = true;
		portfolioLoading = true;

		try {
			const provider = new ethers.JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
			const tokenAddrs = importedTokens.map(t => t.address).filter(a => a);

			const queryTokens = [...tokenAddrs];
			if (usdtAddress && !queryTokens.find(a => a.toLowerCase() === usdtAddress.toLowerCase())) {
				queryTokens.push(usdtAddress);
			}

			if (queryTokens.length === 0) { portfolioLoading = false; portfolioPolling = false; return; }

			// Query all wallet accounts at once
			const allAddresses = accounts.map(a => a.address).filter(a => a);
			const bases = [usdtAddress, usdcAddress].filter(a => a);
			const result = await queryTradeLens(provider, dexRouter, queryTokens, ethers.ZeroAddress, 0n, allAddresses, chainId, bases);

			// ── Calculate WETH price ──
			const weth = result.weth.toLowerCase();
			const usdtLower = usdtAddress.toLowerCase();
			let wethPriceUsdt = 0;
			const usdtResult = result.tokens.find(t => t.token.toLowerCase() === usdtLower);
			if (usdtResult) {
				const usdtWethPool = usdtResult.pools.find(p => p.base.toLowerCase() === weth && p.hasLiquidity);
				if (usdtWethPool && usdtWethPool.reserveBase > 0n) {
					wethPriceUsdt = Number(usdtWethPool.reserveToken) / Number(usdtWethPool.reserveBase);
				}
			}

			// ── Calculate token prices (shared across accounts) ──
			const tokenPrices: Record<string, number> = {};
			for (const lensToken of result.tokens) {
				const addr = lensToken.token.toLowerCase();
				if (wethPriceUsdt > 0) {
					const wethPool = lensToken.pools.find(p => p.base.toLowerCase() === weth && p.hasLiquidity);
					if (wethPool && wethPool.reserveToken > 0n) {
						tokenPrices[addr] = (Number(wethPool.reserveBase) / Number(wethPool.reserveToken)) * wethPriceUsdt;
					} else {
						const usdtPool = lensToken.pools.find(p => p.base.toLowerCase() === usdtLower && p.hasLiquidity);
						if (usdtPool && usdtPool.reserveToken > 0n) {
							tokenPrices[addr] = Number(usdtPool.reserveBase) / Number(usdtPool.reserveToken);
						}
					}
				}
			}

			// ── Save cache for ALL accounts ──
			for (let acctIdx = 0; acctIdx < allAddresses.length; acctIdx++) {
				const addr = allAddresses[acctIdx];
				const userResult = result.users[acctIdx];
				const cachedTokens = importedTokens.map(tok => {
					const lensToken = result.tokens.find(t => t.token.toLowerCase() === tok.address.toLowerCase());
					const bal = lensToken?.balances[acctIdx] ?? 0n;
					return {
						address: tok.address, symbol: tok.symbol, name: tok.name,
						decimals: tok.decimals, balance: bal.toString(),
						priceUsd: tokenPrices[tok.address.toLowerCase()] || 0,
						logoUrl: (tok as any).logoUrl || '',
					};
				});
				try {
					localStorage.setItem(cacheKey(addr), JSON.stringify({
						nativeBalance: (userResult?.nativeBalance ?? 0n).toString(),
						nativePriceUsd: wethPriceUsdt > 0 ? wethPriceUsdt : nativePriceUsd,
						tokens: cachedTokens,
						updatedAt: Date.now(),
					}));
				} catch {}
			}

			// ── Update current account state (single batch) ──
			const activeIdx = allAddresses.findIndex(a => a.toLowerCase() === userAddress.toLowerCase());
			const activeUserInfo = activeIdx >= 0 ? result.users[activeIdx] : null;
			const newNativeBalance = activeUserInfo?.nativeBalance ?? nativeBalance;
			const newNativePriceUsd = wethPriceUsdt > 0 ? wethPriceUsdt : nativePriceUsd;

			const updatedTokens = importedTokens.map(tok => {
				const lensToken = result.tokens.find(t => t.token.toLowerCase() === tok.address.toLowerCase());
				const bal = activeIdx >= 0 && lensToken ? (lensToken.balances[activeIdx] ?? 0n) : tok.balance;
				const price = tokenPrices[tok.address.toLowerCase()] ?? tok.priceUsd ?? 0;
				return { ...tok, balance: bal, priceUsd: price };
			});

			nativeBalance = newNativeBalance;
			nativePriceUsd = newNativePriceUsd;
			importedTokens = updatedTokens;
		} catch (e) {
			console.warn('Portfolio refresh failed:', (e as Error).message?.slice(0, 80));
		} finally {
			portfolioLoading = false;
			portfolioPolling = false;
		}
	}

	// Restore cache when panel opens (one-time, not reactive on balance changes)
	let lastRestoredAddr = '';
	$effect(() => {
		if (open && userAddress && userAddress !== lastRestoredAddr) {
			lastRestoredAddr = userAddress;
			restoreWalletCache(userAddress);
		}
	});

	// Auto-refresh portfolio every 10s when panel is open (pause when switcher is open)
	$effect(() => {
		if (!open || !userAddress || !dexRouter || showSwitcher) return;
		refreshTokenBalances();
		const interval = setInterval(refreshTokenBalances, 10000);
		return () => clearInterval(interval);
	});

	async function handleImportToken() {
		if (!importAddress || !ethers.isAddress(importAddress)) {
			onAddFeedback({ message: 'Invalid address', type: 'error' });
			return;
		}

		// Check if already imported
		if (importedTokens.some(t => t.address.toLowerCase() === importAddress.toLowerCase())) {
			onAddFeedback({ message: 'Token already imported', type: 'error' });
			return;
		}

		importLoading = true;
		try {
			const net = getProvider();
			if (!net) throw new Error('No provider');

			const c = new ethers.Contract(importAddress, [
				'function name() view returns (string)',
				'function symbol() view returns (string)',
				'function decimals() view returns (uint8)',
				'function balanceOf(address) view returns (uint256)',
			], net.provider);

			const [name, symbol, decimals, balance] = await Promise.all([
				c.name().catch(() => 'Unknown'),
				c.symbol().catch(() => '???'),
				c.decimals().catch(() => 18),
				userAddress ? c.balanceOf(userAddress).catch(() => 0n) : Promise.resolve(0n),
			]);

			// Fetch logo
			const logoUrl = getKnownLogo(symbol) || await resolveTokenLogo(importAddress, 56);

			const token = { address: importAddress, name, symbol, decimals: Number(decimals), balance, logoUrl };
			importedTokens = [...importedTokens, token];

			// Persist to localStorage (without balance — re-fetched on load)
			const toSave = importedTokens.map(t => ({ address: t.address, name: t.name, symbol: t.symbol, decimals: t.decimals, logoUrl: (t as any).logoUrl || '' }));
			localStorage.setItem('imported_tokens', JSON.stringify(toSave));
			if (walletType === 'embedded') pushPreferences();

			onAddFeedback({ message: `${symbol} imported`, type: 'success' });
			showImport = false;
			importAddress = '';
		} catch (e: any) {
			onAddFeedback({ message: e.message || 'Failed to fetch token', type: 'error' });
		} finally {
			importLoading = false;
		}
	}

	// ── Helpers ──

	/** Discard all pending send-transaction state. Called from every path
	 *  that dismisses the Send sheet (X button, backdrop click, Escape, or
	 *  the whole panel closing) so the next Send starts clean. */
	function resetSend() {
		showSend = false;
		sendStep = 'form';
		sendFeeEst = '';
		sendTo = '';
		sendAmount = '';
		sendAsset = 'native';
		showAssetPicker = false;
		showAddressBook = false;
		addressBookQuery = '';
		previewCompact = false;
	}

	function close() {
		open = false;
		view = 'main';
		resetExport();
		showSwitcher = false;
		resetSend();
	}

	// Per-address cached native balance, pulled from the same localStorage
	// cache the wallet uses for instant-restore on reload. Users recognise
	// their own accounts by balance more than by address, so showing it in
	// the book is a real usability lift.
	function cachedNativeBalance(addr: string): string {
		try {
			const raw = localStorage.getItem(cacheKey(addr));
			if (!raw) return '';
			const c = JSON.parse(raw);
			if (!c.nativeBalance) return '';
			return parseFloat(ethers.formatEther(BigInt(c.nativeBalance))).toFixed(4);
		} catch {
			return '';
		}
	}

	function matchBookLabel(addr: string): string {
		if (!addr) return '';
		const e = addressBookEntries.find((x) => x.address.toLowerCase() === addr.toLowerCase());
		return e ? `${e.label} — ${e.sublabel}` : '';
	}

	// Validate → estimate gas → advance to preview. We don't block on fee
	// estimation: if it fails (no provider, RPC hiccup), the preview still
	// opens with fee shown as "—" so the user isn't stuck.
	async function reviewSend() {
		if (!ethers.isAddress(sendTo)) { onAddFeedback({ message: 'Invalid recipient address', type: 'error' }); return; }
		const amt = parseFloat(sendAmount);
		if (isNaN(amt) || amt <= 0) { onAddFeedback({ message: 'Invalid amount', type: 'error' }); return; }

		sendStep = 'preview';
		sendFeeEst = '';
		sendFeeLoading = true;
		try {
			const net = getProvider();
			if (!net) throw new Error('No provider');
			const provider = net.provider as any;
			const dec = sendAsset === 'native' ? nativeDecimals : sendAssetInfo.decimals;
			const parts = sendAmount.split('.');
			const sanitized = parts.length > 1 ? `${parts[0]}.${parts[1].slice(0, dec)}` : sendAmount;

			let gasLimit: bigint;
			if (sendAsset === 'native') {
				gasLimit = await provider.estimateGas({
					from: userAddress,
					to: sendTo,
					value: ethers.parseUnits(sanitized, nativeDecimals),
				});
			} else {
				const iface = new ethers.Interface(['function transfer(address to, uint256 amount) returns (bool)']);
				const data = iface.encodeFunctionData('transfer', [sendTo, ethers.parseUnits(sanitized, sendAssetInfo.decimals)]);
				gasLimit = await provider.estimateGas({ from: userAddress, to: sendAsset, data });
			}
			const feeData = await provider.getFeeData();
			const gasPrice: bigint = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
			if (gasPrice > 0n) {
				const weiFee = gasLimit * gasPrice;
				sendFeeEst = parseFloat(ethers.formatEther(weiFee)).toFixed(6);
			}
		} catch {
			sendFeeEst = '';
		} finally {
			sendFeeLoading = false;
		}
	}

	async function executeSend() {
		sending = true;
		try {
			const net = getProvider();
			if (!net) throw new Error('No provider');
			const wallet = getSigner(net.provider as any);
			if (!wallet) throw new Error('Wallet locked — unlock first');

			const dec = sendAsset === 'native' ? nativeDecimals : sendAssetInfo.decimals;
			const parts = sendAmount.split('.');
			const sanitized = parts.length > 1 ? `${parts[0]}.${parts[1].slice(0, dec)}` : sendAmount;

			if (sendAsset === 'native') {
				const tx = await wallet.sendTransaction({
					to: sendTo,
					value: ethers.parseUnits(sanitized, nativeDecimals),
				});
				await tx.wait();
				onAddFeedback({ message: `Sent ${sanitized} ${nativeCoin}`, type: 'success' });
			} else {
				const erc20 = new ethers.Contract(sendAsset, [
					'function transfer(address to, uint256 amount) returns (bool)',
				], wallet);
				const tx = await erc20.transfer(sendTo, ethers.parseUnits(sanitized, sendAssetInfo.decimals));
				await tx.wait();
				onAddFeedback({ message: `Sent ${sanitized} ${sendAssetInfo.symbol}`, type: 'success' });
			}

			resetSend();
			onRefreshBalance();
			refreshTokenBalances();
		} catch (e: any) {
			const msg = friendlyError(e);
			onAddFeedback({ message: msg.slice(0, 80), type: 'error' });
		} finally {
			sending = false;
		}
	}

	function resetExport() { exportPin = ''; exportedValue = ''; exportError = ''; }

	function copyText(text: string) {
		navigator.clipboard.writeText(text);
		copiedAddr = true;
		setTimeout(() => copiedAddr = false, 2000);
	}

	function fmtBal(bal: bigint, dec: number): string {
		if (bal === 0n) return '0';
		const v = parseFloat(ethers.formatUnits(bal, dec));
		if (v >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
		if (v >= 1) return v.toFixed(4);
		if (v >= 0.0001) return v.toFixed(6);
		if (v >= 0.00000001) return v.toFixed(8).replace(/\.?0+$/, '');
		// Truly dust amounts — show "< 0.00000001" instead of scientific notation
		return '< 0.00000001';
	}

	function fmtUsd(val: number): string {
		if (val === 0) return '$0.00';
		if (val < 0.01) return '<$0.01';
		return `$${val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
	}

	/** Compact amount display for tap-to-shrink: "1041644.53..." → "1.04M",
	 *  "73241648253446" → "73.24T". Under 1M returns a decimal-capped
	 *  locale string (nothing to compact). Beyond 1e21 falls back to
	 *  scientific notation. Operates on a string so we don't lose the
	 *  precision of the raw sendAmount. */
	function fmtCompactAmount(s: string | number): string {
		const n = typeof s === 'number' ? s : parseFloat(s || '0');
		if (!isFinite(n) || n === 0) return '0';
		const abs = Math.abs(n);
		if (abs < 1e6) {
			return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 4 });
		}
		if (abs >= 1e21) return n.toExponential(2).replace('e+', 'e');
		const units: Array<[number, string]> = [
			[1e18, 'Qn'],
			[1e15, 'Qa'],
			[1e12, 'T'],
			[1e9, 'B'],
			[1e6, 'M'],
		];
		for (const [base, suffix] of units) {
			if (abs >= base) {
				return (n / base).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + suffix;
			}
		}
		return n.toLocaleString();
	}

	/** USD-prefixed variant of fmtCompactAmount for the token row USD column. */
	function fmtCompactUsd(val: number): string {
		if (val === 0) return '$0.00';
		if (val < 0.01) return '<$0.01';
		if (val < 1e6) return fmtUsd(val);
		return '$' + fmtCompactAmount(val);
	}

	function shortAddr(addr: string): string {
		if (!addr || addr.length < 12) return addr || '';
		return addr.slice(0, 8) + '...' + addr.slice(-6);
	}

	// ── Actions ──
	function handleSwitchAccount(idx: number) {
		setActiveAccount(idx);
		const acc = accounts.find(a => a.index === idx);
		if (acc) onAccountSwitch(acc.address);

		// Restore from cache (already populated by polling all accounts)
		if (acc) {
			lastRestoredAddr = acc.address;
			restoreWalletCache(acc.address);
		}
	}

	async function handleExport(type: 'key' | 'seed') {
		exportError = '';
		const ok = await unlockWallet(exportPin);
		if (!ok) { exportError = 'Wrong PIN'; return; }
		if (type === 'key') {
			const pk = exportPrivateKey(activeIndex);
			exportedValue = pk || '';
		} else {
			const seed = exportSeedPhrase();
			exportedValue = seed || '';
		}
		if (!exportedValue) exportError = 'Failed to export';
	}

	const INPUT_ATTRS = {
		autocomplete: 'one-time-code',
		autocorrect: 'off',
		autocapitalize: 'off',
		spellcheck: false,
		'data-lpignore': 'true',
		'data-1p-ignore': 'true',
		'data-form-type': 'other',
		'data-protonpass-ignore': 'true',
	} as const;
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') { if (showSend) { resetSend(); } else if (view !== 'main') view = 'main'; else close(); } }}
	onpointerdown={() => { if (open && walletType === 'embedded') extendSession(); }} />

{#if open}
<div class="ap-backdrop" onclick={close} role="presentation"></div>

<div class="ap" class:ap-closing={!open} role="dialog" aria-label="Account panel">
	<!-- ═══ HEADER ═══ -->
	<div class="ap-head">
		{#if view !== 'main'}
			<button class="ap-back" onclick={() => { view = 'main'; resetExport(); }}>
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
			</button>
			<span class="ap-head-title">
				{view === 'receive' ? $t('account.receive') : view === 'security' ? $t('account.security') : view === 'export-key' ? $t('account.privateKey') : $t('account.recoveryPhrase')}
			</span>
		{:else}
			<!-- Unified wallet+account chip — opens WalletSwitcher sheet -->
			<button class="ap-chip" onclick={() => { showSwitcher = true; }}>
				<div class="ap-chip-icon">
					{#if walletType === 'embedded'}
						{#if acctAvatar(activeIndex)}
							<span class="ap-chip-emoji">{acctAvatar(activeIndex)}</span>
						{:else}
							{activeIndex + 1}
						{/if}
					{:else}
						◆
					{/if}
				</div>
				<div class="ap-chip-meta">
					<span class="ap-chip-line1">
						{#if walletType === 'embedded' && activeWallet}
							<span class="ap-chip-wallet">{activeWallet.name}</span>
							<span class="ap-chip-sep">•</span>
							<span class="ap-chip-acct">{acctName(activeIndex)}</span>
						{:else}
							{$t('account.externalWallet')}
						{/if}
					</span>
					<span class="ap-chip-line2">{shortAddr(userAddress)}</span>
				</div>
				<svg class="ap-chip-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
			</button>
		{/if}

		<button class="ap-x" onclick={close}>
			<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
		</button>
	</div>

	<!-- Unified wallet/account switcher sheet (overlay above panel).
	     Reads its own state directly from the wallet store — no need to
	     pipe wallets/accounts/activeWalletId through props. -->
	{#if walletType === 'embedded'}
		<WalletSwitcher
			bind:open={showSwitcher}
			onAccountSwitched={(addr) => { handleSwitcherAccountSwitched(addr); bumpMeta(); }}
			onFeedback={onAddFeedback}
			onExportSeed={() => { resetExport(); view = 'export-seed'; }}
			onExportKey={() => { resetExport(); view = 'export-key'; }}
			onDisconnect={onDisconnect}
			onLock={() => { close(); }}
			onAccountMetaChanged={bumpMeta}
		/>
	{/if}

	<!-- ═══ MAIN VIEW ═══ -->
	{#if view === 'main'}
		<!-- Network -->
		<div class="ap-net"><span class="ap-net-dot"></span>{networkName}</div>

		<!-- Balance -->
		<div class="ap-bal">
			<span class="ap-bal-total">{fmtUsd(totalUsd)}{#if portfolioLoading && totalUsd === 0} <span class="ap-bal-loading">...</span>{/if}</span>
			<span class="ap-bal-native">
				{#if totalNativeEquiv > 0}
					≈ {totalNativeEquiv.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {nativeCoin}
				{:else}
					{fmtBal(nativeBalance, nativeDecimals)} {nativeCoin}
				{/if}
			</span>
		</div>

		<!-- Actions -->
		<div class="ap-acts">
			<button class="ap-act" onclick={() => { close(); goto('/trade'); }}>
				<div class="ap-act-circle"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg></div>
				<span>{$t('account.buy')}</span>
			</button>
			<button class="ap-act" onclick={() => showSend = true}>
				<div class="ap-act-circle"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg></div>
				<span>{$t('account.send')}</span>
			</button>
			<button class="ap-act" onclick={() => view = 'receive'}>
				<div class="ap-act-circle"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg></div>
				<span>{$t('account.receive')}</span>
			</button>
			<button class="ap-act" onclick={() => { close(); goto('/trade'); }}>
				<div class="ap-act-circle"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg></div>
				<span>{$t('account.swap')}</span>
			</button>
		</div>

		<!-- Empty-state CTA: shown the first time a user opens an empty wallet.
		     Replaces the "navigate away to /trade" friction with a one-tap path
		     to the receive view + native faucet hint. -->
		{#if totalUsd === 0 && nativeBalance === 0n && sortedTokens.length === 0 && !portfolioLoading}
			<div class="ap-empty-cta">
				<div class="ap-empty-cta-icon">
					<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>
				</div>
				<div class="ap-empty-cta-text">
					<strong>{$t('account.fundWallet')}</strong>
					<p>Receive {nativeCoin}, USDT or any token on {networkName} at your address.</p>
				</div>
				<div class="ap-empty-cta-btns">
					<button class="ap-btn ap-btn-primary" onclick={() => view = 'receive'}>{$t('account.showAddress')}</button>
					<button class="ap-btn" onclick={() => { close(); goto('/trade'); }}>{$t('account.buyWithCard')}</button>
				</div>
			</div>
		{/if}

		<!-- Assets header -->
		<div class="ap-section-head">{$t('account.assets')}</div>


		{#if true}
			{@const nativeCompact = compactRows.has('native')}
			<div class="ap-scroll">
				<!-- Native -->
				<div class="ap-row">
					{#if getKnownLogo(nativeCoin)}
						<img src={getKnownLogo(nativeCoin)} alt={nativeCoin} class="ap-row-logo" />
					{:else}
						<div class="ap-row-icon ap-row-native">{nativeCoin.charAt(0)}</div>
					{/if}
					<div class="ap-row-meta">
						<span class="ap-row-name">{nativeCoin}</span>
						<span class="ap-row-sub">{$t('account.native')}</span>
					</div>
					<button class="ap-row-right" type="button" onclick={() => toggleRowCompact('native')} title={nativeCompact ? 'Tap to expand' : 'Tap to shrink'}>
						<span class="ap-row-amt">{fmtBal(nativeBalance, nativeDecimals)}</span>
						<span class="ap-row-usd">{nativeCompact ? fmtCompactUsd(nativeUsd) : fmtUsd(nativeUsd)}</span>
					</button>
				</div>

				<!-- Tokens sorted by USD value -->
				{#each sortedTokens as tok}
					{@const usd = tok._usd}
					{@const logo = getTokenLogo(tok)}
					{@const rowKey = (tok.address || tok.symbol).toLowerCase()}
					{@const isCompact = compactRows.has(rowKey)}
					<div class="ap-row">
					{#if logo}
						<img src={logo} alt={tok.symbol} class="ap-row-logo" />
					{:else}
						<div class="ap-row-icon">{tok.symbol.charAt(0)}</div>
					{/if}
						<div class="ap-row-meta">
							<span class="ap-row-name">{tok.symbol}</span>
							<span class="ap-row-sub">{tok.name}</span>
						</div>
						<button class="ap-row-right" type="button" onclick={() => toggleRowCompact(rowKey)} title={isCompact ? 'Tap to expand' : 'Tap to shrink'}>
							<span class="ap-row-amt">{isCompact ? fmtCompactAmount(parseFloat(ethers.formatUnits(tok.balance, tok.decimals))) : fmtBal(tok.balance, tok.decimals)}</span>
							<span class="ap-row-usd">{usd > 0 ? (isCompact ? fmtCompactUsd(usd) : fmtUsd(usd)) : ''}</span>
						</button>
					</div>
				{/each}

				{#if tokens.length === 0 && importedTokens.length === 0}
					<p class="ap-empty">{$t('account.noImportedTokens')}</p>
				{/if}

				{#if showImport}
					<div class="ap-import-form">
						<input class="ap-input" type="text" placeholder="Token address (0x...)" bind:value={importAddress} {...INPUT_ATTRS} />
						<div class="ap-import-btns">
							<button class="ap-btn-s" onclick={() => { showImport = false; importAddress = ''; }}>Cancel</button>
							<button class="ap-btn-s ap-btn-primary" disabled={importLoading} onclick={() => handleImportToken()}>
								{importLoading ? 'Loading...' : 'Import'}
							</button>
						</div>
					</div>
				{:else}
					<button class="ap-import-btn" onclick={() => showImport = true}>
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
						{$t('account.importToken')}
					</button>
				{/if}
			</div>

		{/if}

		<!-- Disconnect footer -->
		<button class="ap-disconnect" onclick={() => { onDisconnect(); close(); }}>
			<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
			{$t('account.disconnect')}
		</button>

	<!-- ═══ RECEIVE VIEW ═══ -->
	{:else if view === 'receive'}
		<div class="ap-view-content ap-receive">
			<p class="ap-hint">Send only {nativeCoin} and tokens on {networkName} to this address.</p>
			<div class="ap-qr">
				<QrCode data={userAddress} width={180} />
			</div>
			<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
			<div class="ap-addr-box" onclick={() => { copyText(userAddress); onAddFeedback({ message: $t('account.addressCopied'), type: 'success' }); }}>
				<span class="ap-addr-full">{userAddress}</span>
				<span class="ap-addr-tap">{copiedAddr ? $t('account.copied') : $t('account.tapToCopy')}</span>
			</div>
		</div>

	<!-- ═══ SECURITY VIEW ═══ -->
	{:else if view === 'security'}
		<div class="ap-view-content">
			<div class="ap-sec-warn">
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
				<p>{$t('account.securityWarn')}</p>
			</div>
			<button class="ap-set-item" onclick={() => { resetExport(); view = 'export-key'; }}>
				<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
				<span>{$t('account.exportPrivateKey')}</span>
				<svg class="ap-set-arrow" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
			</button>
			<button class="ap-set-item" onclick={() => { resetExport(); view = 'export-seed'; }}>
				<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
				<span>{$t('account.exportRecoveryPhrase')}</span>
				<svg class="ap-set-arrow" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
			</button>
		</div>

	<!-- ═══ EXPORT VIEW (key or seed) ═══ -->
	{:else if view === 'export-key' || view === 'export-seed'}
		<div class="ap-view-content">
			{#if !exportedValue}
				<div class="ap-danger-box">
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
					<div>
						<strong>Warning</strong>
						<p>{view === 'export-key' ? $t('account.warningKey') : $t('account.warningPhrase')}</p>
					</div>
				</div>

				<label class="ap-label">{$t('account.enterPinContinue')}</label>
				<input class="ap-input" type="tel" inputmode="numeric" style="-webkit-text-security: disc; text-security: disc;" placeholder="PIN" bind:value={exportPin}
					{...INPUT_ATTRS}
					onkeydown={(e) => { if (e.key === 'Enter') handleExport(view === 'export-key' ? 'key' : 'seed'); }} />

				{#if exportError}<p class="ap-error">{exportError}</p>{/if}

				<button class="ap-btn ap-btn-danger ap-btn-full" onclick={() => handleExport(view === 'export-key' ? 'key' : 'seed')}>
					{view === 'export-key' ? $t('account.revealKey') : $t('account.revealPhrase')}
				</button>
			{:else}
				<div class="ap-revealed" onclick={() => { navigator.clipboard.writeText(exportedValue); setTimeout(() => { try { navigator.clipboard.writeText(''); } catch {} }, 30000); onAddFeedback({ message: $t('account.copiedClipboard'), type: 'info' }); }}>
					{exportedValue}
				</div>
				<p class="ap-revealed-hint">{$t('account.doNotShare')}</p>
				<button class="ap-btn ap-btn-full" onclick={() => { view = 'security'; resetExport(); }}>Done</button>
			{/if}
		</div>
	{/if}

	<!-- ═══ SEND SHEET — slides up from bottom, main wallet panel stays visible behind it ═══ -->
	{#if showSend}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div class="ap-picker-overlay" transition:fade={{ duration: 150 }} onclick={(e) => { if (e.target === e.currentTarget && !sending) resetSend(); }}>
			<div class="ap-picker ap-send-sheet" transition:fly={{ y: 400, duration: 220 }}>
				<div class="ap-picker-header">
					<span class="ap-picker-title">{$t('account.send')}</span>
					<button class="ap-picker-close" type="button" disabled={sending} onclick={resetSend}>
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
					</button>
				</div>
				<div class="ap-send-body">
					<label class="ap-label">{$t('account.asset')}</label>
					<button class="ap-asset-btn" type="button" onclick={() => showAssetPicker = true}>
						{#if sendAsset === 'native'}
							{#if getKnownLogo(nativeCoin)}
								<img src={getKnownLogo(nativeCoin)} alt="" class="ap-asset-logo" />
							{:else}
								<span class="ap-asset-letter">{nativeCoin.charAt(0)}</span>
							{/if}
							<span class="ap-asset-name">{nativeCoin}</span>
							<span class="ap-asset-bal">{fmtBal(nativeBalance, nativeDecimals)}</span>
						{:else if sendAssetTok}
							{#if getTokenLogo(sendAssetTok)}
								<img src={getTokenLogo(sendAssetTok)} alt="" class="ap-asset-logo" />
							{:else}
								<span class="ap-asset-letter">{sendAssetTok.symbol.charAt(0)}</span>
							{/if}
							<span class="ap-asset-name">{sendAssetTok.symbol}</span>
							<span class="ap-asset-bal">{fmtBal(sendAssetTok.balance, sendAssetTok.decimals)}</span>
						{/if}
						<svg class="ap-asset-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
					</button>

					<label class="ap-label">{$t('account.recipient')}</label>
					<div class="ap-recipient-row">
						<input class="ap-input ap-recipient-input" type="text" placeholder="0x…" bind:value={sendTo} {...INPUT_ATTRS} />
						{#if walletType === 'embedded' && addressBookEntries.length > 0}
							<button class="ap-book-btn" type="button" title="My addresses" onclick={() => showAddressBook = !showAddressBook}>
								<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
									<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
								</svg>
							</button>
						{/if}
					</div>

					<label class="ap-label">{$t('account.amount')}</label>
					<!-- Amount input with inset MAX pill — mirrors the recipient
					     row's address-book icon for structural consistency. -->
					<div class="ap-recipient-row">
						<input class="ap-input ap-recipient-input" type="text" inputmode="decimal" placeholder="0.0" bind:value={sendAmount} {...INPUT_ATTRS} />
						<button
							class="ap-max-btn"
							type="button"
							title="Use max balance"
							onclick={() => {
								const dec = sendAsset === 'native' ? nativeDecimals : sendAssetInfo.decimals;
								if (sendAsset === 'native') {
									const reserve = ethers.parseUnits('0.001', dec);
									const max = sendAssetInfo.balance > reserve ? sendAssetInfo.balance - reserve : 0n;
									sendAmount = ethers.formatUnits(max, dec);
								} else {
									sendAmount = ethers.formatUnits(sendAssetInfo.balance, dec);
								}
							}}
						>
							MAX
						</button>
					</div>
					{#if sendAmount && sendAssetInfo.priceUsd > 0}
						{@const sendUsdEstimate = parseFloat(sendAmount || '0') * sendAssetInfo.priceUsd}
						{#if sendUsdEstimate > 0}
							<div class="ap-send-estimate">≈ {fmtUsd(sendUsdEstimate)}</div>
						{/if}
					{/if}
					<div class="ap-send-info">
						<span>{$t('account.balance')}: {fmtBal(sendAssetInfo.balance, sendAssetInfo.decimals)} {sendAssetInfo.symbol}</span>
					</div>
				</div>
				<div class="ap-send-footer">
					<button class="ap-btn ap-btn-primary ap-btn-full" disabled={!sendTo || !sendAmount} onclick={reviewSend}>
						{$t('account.review')}
					</button>
				</div>
			</div>
		</div>

		<!-- Asset picker — stacked above the send sheet -->
		{#if showAssetPicker}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<div class="ap-picker-overlay" transition:fade={{ duration: 150 }} onclick={(e) => { if (e.target === e.currentTarget) showAssetPicker = false; }}>
				<div class="ap-picker" transition:fly={{ y: 400, duration: 220 }}>
					<div class="ap-picker-header">
						<span class="ap-picker-title">{$t('account.selectAsset')}</span>
						<button class="ap-picker-close" type="button" onclick={() => showAssetPicker = false}>
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
						</button>
					</div>
					<div class="ap-picker-list">
						<button class="ap-picker-item" class:active={sendAsset === 'native'} onclick={() => { sendAsset = 'native'; showAssetPicker = false; }}>
							{#if getKnownLogo(nativeCoin)}
								<img src={getKnownLogo(nativeCoin)} alt="" class="ap-picker-logo" />
							{:else}
								<span class="ap-picker-letter">{nativeCoin.charAt(0)}</span>
							{/if}
							<div class="ap-picker-info">
								<span class="ap-picker-symbol">{nativeCoin}</span>
								<span class="ap-picker-name">Native</span>
							</div>
							<div class="ap-picker-right">
								<span class="ap-picker-bal">{fmtBal(nativeBalance, nativeDecimals)}</span>
								{#if nativeUsd > 0}<span class="ap-picker-usd">{fmtUsd(nativeUsd)}</span>{/if}
							</div>
						</button>
						{#each sortedTokens as tok}
							{@const logo = getTokenLogo(tok)}
							<button class="ap-picker-item" class:active={sendAsset.toLowerCase() === tok.address?.toLowerCase()} onclick={() => { sendAsset = tok.address; showAssetPicker = false; }}>
								{#if logo}
									<img src={logo} alt="" class="ap-picker-logo" />
								{:else}
									<span class="ap-picker-letter">{tok.symbol.charAt(0)}</span>
								{/if}
								<div class="ap-picker-info">
									<span class="ap-picker-symbol">{tok.symbol}</span>
									<span class="ap-picker-name">{tok.name || tok.symbol}</span>
								</div>
								<div class="ap-picker-right">
									<span class="ap-picker-bal">{fmtBal(tok.balance, tok.decimals)}</span>
									{#if tok._usd > 0}<span class="ap-picker-usd">{fmtUsd(tok._usd)}</span>{/if}
								</div>
							</button>
						{/each}
					</div>
				</div>
			</div>
		{/if}

		<!-- Address book picker — stacked above the send sheet -->
		{#if showAddressBook && addressBookEntries.length > 0}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<div class="ap-picker-overlay" transition:fade={{ duration: 150 }} onclick={(e) => { if (e.target === e.currentTarget) { showAddressBook = false; addressBookQuery = ''; } }}>
				<div class="ap-picker" transition:fly={{ y: 400, duration: 220 }}>
					<div class="ap-picker-header">
						<span class="ap-picker-title">{$t('account.myAddresses')}</span>
						<button class="ap-picker-close" type="button" onclick={() => { showAddressBook = false; addressBookQuery = ''; }}>
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
						</button>
					</div>
					<div class="ap-book-search">
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
							<circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
						</svg>
						<input
							class="ap-book-search-input"
							type="text"
							placeholder={$t('account.searchAddresses')}
							bind:value={addressBookQuery}
							{...INPUT_ATTRS}
						/>
						{#if addressBookQuery}
							<button class="ap-book-search-clear" type="button" onclick={() => addressBookQuery = ''}>×</button>
						{/if}
					</div>
					<div class="ap-book-list">
						{#each filteredBookEntries as entry, i (entry.address)}
							{#if i === 0 || filteredBookEntries[i - 1].group !== entry.group}
								<div class="ap-book-header">
									{entry.group === 'current' ? $t('account.thisWallet') : $t('account.otherWallets')}
								</div>
							{/if}
							{@const bal = cachedNativeBalance(entry.address)}
							<button
								class="ap-book-item"
								type="button"
								class:selected={sendTo.toLowerCase() === entry.address.toLowerCase()}
								onclick={() => { sendTo = entry.address; showAddressBook = false; addressBookQuery = ''; }}
							>
								<div class="ap-book-avatar">
									{#if entry.avatar}<span style="font-size:15px">{entry.avatar}</span>{:else}{entry.label.slice(0, 1).toUpperCase()}{/if}
								</div>
								<div class="ap-book-info">
									<span class="ap-book-name">{entry.label}</span>
									<span class="ap-book-sub">{entry.sublabel}</span>
								</div>
								{#if bal}
									<span class="ap-book-bal">{bal} {nativeCoin}</span>
								{/if}
							</button>
						{/each}
						{#if filteredBookEntries.length === 0}
							<p class="ap-book-empty">{$t('account.noMatches')}</p>
						{/if}
					</div>
				</div>
			</div>
		{/if}

		<!-- Confirm preview — stacked above the send sheet -->
		{#if sendStep === 'preview'}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<div class="ap-picker-overlay" transition:fade={{ duration: 150 }} onclick={(e) => { if (e.target === e.currentTarget && !sending) { sendStep = 'form'; sendFeeEst = ''; } }}>
				<div class="ap-picker" transition:fly={{ y: 400, duration: 220 }}>
					<div class="ap-picker-header">
						<span class="ap-picker-title">{$t('account.confirmTransaction')}</span>
						<button class="ap-picker-close" type="button" disabled={sending} onclick={() => { sendStep = 'form'; sendFeeEst = ''; }}>
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
						</button>
					</div>
					<div class="ap-preview-body">
						<!-- Tap the number to toggle between full precision and compact
						     (B/T/M) display. Default is full — the compact view is the
						     opt-in "quick scan" mode. -->
						<button
							type="button"
							class="ap-preview-amount"
							onclick={() => previewCompact = !previewCompact}
							title={previewCompact ? 'Tap to show full amount' : 'Tap to shrink'}
							style="--char-count: {(previewCompact ? fmtCompactAmount(sendAmount) : sendAmount).length}"
						>
							<span class="ap-preview-num">{previewCompact ? fmtCompactAmount(sendAmount) : sendAmount}</span>
							<span class="ap-preview-sym">{sendAssetInfo.symbol}</span>
						</button>
						{#if previewUsd > 0}
							<div class="ap-preview-usd">≈ {fmtUsd(previewUsd)}</div>
						{/if}

						<div class="ap-preview-rows">
							<div class="ap-preview-row">
								<span class="ap-preview-k">{$t('account.from')}</span>
								<span class="ap-preview-v">{userAddress.slice(0, 8)}…{userAddress.slice(-6)}</span>
							</div>
							<div class="ap-preview-row">
								<span class="ap-preview-k">{$t('account.to')}</span>
								<span class="ap-preview-v">
									{#if previewBookLabel}<span class="ap-preview-tag">{previewBookLabel}</span>{/if}
									{sendTo.slice(0, 8)}…{sendTo.slice(-6)}
								</span>
							</div>
							<div class="ap-preview-row">
								<span class="ap-preview-k">{$t('account.asset')}</span>
								<span class="ap-preview-v">{sendAssetInfo.symbol}</span>
							</div>
							<div class="ap-preview-row">
								<span class="ap-preview-k">{$t('account.networkFee')}</span>
								<span class="ap-preview-v">
									{#if sendFeeLoading}{$t('account.estimating')}
									{:else if sendFeeEst}~{sendFeeEst} {nativeCoin}
									{:else}—{/if}
								</span>
							</div>
						</div>
					</div>
					<div class="ap-preview-btns">
						<button class="ap-btn ap-btn-primary ap-btn-full" disabled={sending} onclick={executeSend}>
							{sending ? $t('account.sending') : $t('account.confirmSend')}
						</button>
					</div>
				</div>
			</div>
		{/if}
	{/if}
</div>
{/if}

<style>
	.ap-backdrop { position: fixed; inset: 0; z-index: 9998; background: rgba(0,0,0,0.6); backdrop-filter: blur(3px); }

	.ap {
		position: fixed; top: 0; right: 0; bottom: 0; z-index: 9999;
		width: 360px; background: var(--bg);
		border-left: 1px solid var(--border-subtle);
		display: flex; flex-direction: column;
		animation: apSlide 0.2s ease-out;
	}
	@keyframes apSlide { from { transform: translateX(100%); } }
	@media (max-width: 480px) { .ap { width: 100vw; border-left: none; } }

	/* ── Header ── */
	.ap-head {
		display: flex; align-items: center; gap: 8px;
		padding: 14px 16px 10px; position: relative; min-height: 52px;
	}
	.ap-back {
		width: 30px; height: 30px; border-radius: 8px; border: none;
		background: var(--bg-surface-input); color: var(--text-muted); cursor: pointer;
		display: flex; align-items: center; justify-content: center;
		transition: all 0.12s; flex-shrink: 0;
	}
	.ap-back:hover { background: var(--bg-surface-hover); color: var(--text-heading); }
	.ap-head-title {
		font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 700; color: var(--text); flex: 1;
	}
	.ap-x {
		width: 28px; height: 28px; border-radius: 8px; border: none;
		background: var(--bg-surface-input); color: var(--text-dim); cursor: pointer;
		display: flex; align-items: center; justify-content: center;
		transition: all 0.12s; flex-shrink: 0; margin-left: auto;
	}
	.ap-x:hover { background: var(--bg-surface-hover); color: var(--text-heading); }

	/* Wallet/account chip — single button, opens WalletSwitcher sheet */
	.ap-chip {
		display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0;
		background: var(--bg-surface); border: 1px solid var(--border);
		border-radius: 10px; padding: 7px 12px; cursor: pointer;
		color: inherit; font-family: inherit; transition: border-color 0.15s;
	}
	.ap-chip:hover { border-color: rgba(0,210,255,0.25); background: rgba(0,210,255,0.04); }
	.ap-chip-icon {
		width: 28px; height: 28px; border-radius: 50%; flex-shrink: 0;
		background: linear-gradient(135deg, rgba(0,210,255,0.16), rgba(58,123,213,0.16));
		border: 1px solid rgba(0,210,255,0.25);
		display: flex; align-items: center; justify-content: center;
		font-family: 'Syne', sans-serif; font-size: 11px; font-weight: 800; color: #00d2ff;
	}
	.ap-chip-emoji { font-size: 15px; line-height: 1; }
	.ap-chip-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; overflow: hidden; }
	.ap-chip-line1 {
		display: flex; align-items: center; gap: 5px; min-width: 0;
		font-family: 'Syne', sans-serif; font-size: 11px; font-weight: 700; color: var(--text);
		white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	}
	.ap-chip-wallet { color: var(--text); }
	.ap-chip-acct { color: var(--text-muted); font-weight: 600; }
	.ap-chip-sep { color: var(--text-dim); }
	.ap-chip-line2 { font-family: 'Space Mono', monospace; font-size: 8px; color: var(--text-dim); }
	.ap-chip-chev { color: var(--text-dim); flex-shrink: 0; }

	/* Empty-state CTA card (shown when wallet is empty) */
	.ap-empty-cta {
		display: flex; flex-direction: column; gap: 10px;
		margin: 0 16px 12px; padding: 16px;
		background: linear-gradient(135deg, rgba(0,210,255,0.06), rgba(58,123,213,0.04));
		border: 1px solid rgba(0,210,255,0.18); border-radius: 12px;
	}
	.ap-empty-cta-icon {
		width: 38px; height: 38px; border-radius: 50%;
		background: rgba(0,210,255,0.12); border: 1px solid rgba(0,210,255,0.25);
		display: flex; align-items: center; justify-content: center;
		color: #00d2ff;
	}
	.ap-empty-cta-text strong {
		display: block; font-family: 'Syne', sans-serif; font-size: 13px;
		color: var(--text-heading); margin-bottom: 3px;
	}
	.ap-empty-cta-text p {
		margin: 0; font-family: 'Space Mono', monospace; font-size: 10px;
		color: var(--text-muted); line-height: 1.5;
	}
	.ap-empty-cta-btns { display: flex; gap: 8px; }
	.ap-empty-cta-btns .ap-btn { flex: 1; padding: 8px 10px; font-size: 10px; }

	/* Send: recipient row — one bordered container holds both the input and
	   the book icon. Input is borderless + flex-1 so the full address stays
	   visible; icon is a plain button inside the same border. */
	.ap-recipient-row {
		display: flex; align-items: center;
		background: var(--bg-surface); border: 1px solid var(--border);
		border-radius: 8px; transition: border-color 0.12s;
	}
	.ap-recipient-row:focus-within { border-color: rgba(0,210,255,0.3); }
	.ap-recipient-input {
		flex: 1; min-width: 0;
		background: transparent !important; border: none !important;
		padding: 10px 12px;
	}
	.ap-recipient-input:focus { border: none !important; }
	.ap-book-btn {
		width: 32px; height: 32px; padding: 0; margin-right: 4px; border-radius: 6px;
		flex-shrink: 0; background: transparent; border: none;
		color: #00d2ff; cursor: pointer;
		display: flex; align-items: center; justify-content: center; transition: all 0.12s;
	}
	.ap-book-btn:hover { background: rgba(0,210,255,0.12); }

	/* Inset MAX pill on the Amount input — matches .ap-book-btn sizing so
	   the two fields share a visual rhythm, with slightly different padding
	   because the label is text not an icon. */
	.ap-max-btn {
		height: 26px; padding: 0 10px; margin-right: 6px; border-radius: 6px;
		flex-shrink: 0; background: rgba(0,210,255,0.1); border: 1px solid rgba(0,210,255,0.25);
		color: #00d2ff; cursor: pointer;
		font-family: 'Space Mono', monospace; font-size: 10px; font-weight: 700;
		letter-spacing: 0.05em;
		display: flex; align-items: center; justify-content: center;
		transition: all 0.12s;
	}
	.ap-max-btn:hover { background: rgba(0,210,255,0.2); border-color: rgba(0,210,255,0.45); }
	.ap-max-btn:active { background: rgba(0,210,255,0.3); }

	.ap-book-search {
		display: flex; align-items: center; gap: 8px;
		padding: 8px 12px; margin: 12px 12px 0;
		background: var(--bg-surface); border: 1px solid var(--border); border-radius: 8px;
		color: var(--text-dim);
	}
	.ap-book-search:focus-within { border-color: rgba(0,210,255,0.3); color: var(--text-muted); }
	.ap-book-search-input {
		flex: 1; background: transparent; border: none; outline: none;
		color: var(--text); font-family: 'Space Mono', monospace; font-size: 11px;
	}
	.ap-book-search-input::placeholder { color: var(--text-dim); }
	.ap-book-search-clear {
		width: 18px; height: 18px; padding: 0; border: none; border-radius: 50%;
		background: var(--bg-surface-hover); color: var(--text-muted);
		font-size: 14px; line-height: 1; cursor: pointer; flex-shrink: 0;
	}
	.ap-book-search-clear:hover { background: rgba(255,255,255,0.12); color: var(--text-heading); }
	.ap-book-empty {
		text-align: center; padding: 24px; font-size: 10px; color: var(--text-dim);
		font-family: 'Space Mono', monospace; margin: 0;
	}

	.ap-book-list {
		display: flex; flex-direction: column; gap: 4px;
		flex: 1; overflow-y: auto; padding: 4px 12px 12px;
	}
	.ap-book-header {
		font-family: 'Space Mono', monospace; font-size: 9px; color: var(--text-dim);
		text-transform: uppercase; letter-spacing: 0.5px; padding: 6px 4px 2px;
	}
	.ap-book-item {
		display: flex; align-items: center; gap: 10px; width: 100%;
		padding: 9px 10px; border-radius: 9px;
		background: var(--bg-surface); border: 1px solid var(--border-subtle);
		cursor: pointer; transition: all 0.12s; color: inherit; text-align: left;
	}
	.ap-book-item:hover { background: rgba(0,210,255,0.04); border-color: rgba(0,210,255,0.18); }
	.ap-book-item.selected {
		background: rgba(0,210,255,0.08); border-color: rgba(0,210,255,0.35);
		box-shadow: 0 0 0 1px rgba(0,210,255,0.25);
	}
	.ap-book-avatar {
		width: 30px; height: 30px; border-radius: 50%; flex-shrink: 0;
		background: linear-gradient(135deg, rgba(0,210,255,0.18), rgba(58,123,213,0.18));
		border: 1px solid rgba(0,210,255,0.25);
		display: flex; align-items: center; justify-content: center;
		font-family: 'Syne', sans-serif; font-size: 11px; font-weight: 800; color: #00d2ff;
	}
	.ap-book-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
	.ap-book-name { font-family: 'Syne', sans-serif; font-size: 12px; font-weight: 700; color: var(--text); }
	.ap-book-sub { font-family: 'Space Mono', monospace; font-size: 9px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.ap-book-bal {
		font-family: 'Rajdhani', sans-serif; font-size: 11px; color: var(--text-dim);
		font-variant-numeric: tabular-nums; flex-shrink: 0;
	}

	/* Send sheet — uses the same .ap-picker 80vh chrome as the confirm modal,
	   with a scrollable body and a sticky footer button. */
	.ap-send-body {
		flex: 1; overflow-y: auto; padding: 16px;
		display: flex; flex-direction: column; gap: 12px;
	}
	.ap-send-footer {
		padding: 12px 16px 16px; border-top: 1px solid var(--border);
		flex-shrink: 0;
	}

	/* Send preview modal body — fills the 80vh picker chrome so the confirm
	   buttons sit at the bottom of the sheet. */
	.ap-preview-body {
		flex: 1; overflow-y: auto; padding: 24px 16px 16px;
		display: flex; flex-direction: column; gap: 16px;
	}
	/* Tappable amount button: background-less, fluid font.
	   Font scales from `--char-count` so the full number always fits the
	   container (no ellipsis) — Rajdhani tabular digit width ≈ 0.56em, so
	   container_width / (chars * 0.56) = max font size that still fits. */
	.ap-preview-amount {
		display: flex; align-items: baseline; gap: 6px; justify-content: center;
		max-width: 100%; padding: 4px 12px; margin: 0 auto;
		background: none; border: none; cursor: pointer;
		container-type: inline-size;
		border-radius: 8px;
		transition: background 0.15s;
	}
	.ap-preview-amount:hover { background: var(--bg-surface); }
	.ap-preview-amount:active { background: var(--bg-surface-hover); }
	.ap-preview-num {
		font-family: 'Rajdhani', sans-serif; font-weight: 700;
		color: var(--text); font-variant-numeric: tabular-nums;
		font-size: clamp(14px, calc(92cqw / max(var(--char-count, 10), 5) / 0.56), 32px);
		white-space: nowrap;
	}
	.ap-preview-sym {
		font-family: 'Syne', sans-serif; font-size: 13px; font-weight: 700; color: var(--text-muted);
		flex-shrink: 0;
	}
	.ap-preview-usd {
		text-align: center; font-family: 'Space Mono', monospace; font-size: 11px; color: var(--text-dim);
		margin-top: -8px;
	}
	.ap-preview-rows {
		display: flex; flex-direction: column; gap: 8px;
		padding-top: 10px; border-top: 1px solid var(--border-subtle);
	}
	.ap-preview-row {
		display: flex; justify-content: space-between; align-items: center; gap: 8px;
	}
	.ap-preview-k { font-family: 'Space Mono', monospace; font-size: 10px; color: var(--text-dim); }
	.ap-preview-v {
		font-family: 'Space Mono', monospace; font-size: 11px; color: var(--text);
		text-align: right; min-width: 0;
	}
	.ap-preview-tag {
		display: inline-block; margin-right: 6px; padding: 1px 6px; border-radius: 4px;
		background: rgba(0,210,255,0.12); color: #00d2ff; font-family: 'Syne', sans-serif;
		font-size: 9px; font-weight: 700;
	}
	.ap-preview-btns {
		display: flex; gap: 8px; padding: 12px 16px 16px;
		border-top: 1px solid var(--border); flex-shrink: 0;
	}
	.ap-preview-btns .ap-btn { flex: 1; }

	/* Network */
	.ap-net { display: flex; align-items: center; gap: 5px; padding: 0 16px 4px; font-size: 9px; color: var(--text-dim); font-family: 'Space Mono', monospace; }
	.ap-net-dot { width: 5px; height: 5px; border-radius: 50%; background: #10b981; }

	/* Balance */
	.ap-bal {
		text-align: center; padding: 16px 16px 20px;
		container-type: inline-size;
	}
	.ap-bal-total {
		display: block; font-family: 'Rajdhani', sans-serif;
		/* Fluid: clamp against the container's inline size so meme portfolios
		   (e.g. $73B of shitcoin) shrink to fit instead of overflowing. */
		font-size: clamp(28px, 11cqw, 44px);
		font-weight: 700; color: var(--text-heading); line-height: 1.1; font-variant-numeric: tabular-nums;
		letter-spacing: -0.02em;
		max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	}
	.ap-bal-loading { font-size: 24px; color: var(--text-dim); animation: blink 1s infinite; }
	@keyframes blink { 0%,100% { opacity: 0.3; } 50% { opacity: 1; } }
	.ap-bal-native {
		display: block; font-family: 'Rajdhani', sans-serif; font-size: 16px;
		font-weight: 500; color: var(--text-muted); margin-top: 6px; font-variant-numeric: tabular-nums;
		max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		padding: 0 8px;
	}

	/* Action buttons */
	.ap-acts { display: flex; justify-content: center; gap: 18px; padding: 0 16px 14px; }
	.ap-act {
		display: flex; flex-direction: column; align-items: center; gap: 5px;
		background: none; border: none; cursor: pointer; color: var(--text-muted);
		font-family: 'Space Mono', monospace; font-size: 9px; transition: color 0.12s;
	}
	.ap-act:hover { color: #00d2ff; }
	.ap-act-circle {
		width: 40px; height: 40px; border-radius: 50%;
		background: rgba(0,210,255,0.05); border: 1px solid rgba(0,210,255,0.1);
		display: flex; align-items: center; justify-content: center; transition: all 0.15s;
	}
	.ap-act:hover .ap-act-circle { background: rgba(0,210,255,0.1); border-color: rgba(0,210,255,0.25); transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,210,255,0.1); }

	/* Section head */
	.ap-section-head {
		padding: 8px 16px 4px; font-family: 'Syne', sans-serif; font-size: 12px;
		font-weight: 700; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em;
	}

	/* Scrollable content area */
	.ap-scroll { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 6px 0; }

	/* Token rows */
	.ap-row { display: flex; align-items: center; gap: 12px; padding: 12px 16px; transition: background 0.1s; }
	.ap-row:hover { background: var(--bg-surface); }
	.ap-row-icon {
		width: 40px; height: 40px; border-radius: 50%;
		background: var(--bg-surface-input); border: 1px solid var(--border);
		display: flex; align-items: center; justify-content: center;
		font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 800; color: var(--text-muted); flex-shrink: 0;
	}
	.ap-row-native { background: rgba(245,158,11,0.08); border-color: rgba(245,158,11,0.15); color: #f59e0b; }
	.ap-row-logo { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; flex-shrink: 0; border: 1px solid var(--border); }
	.ap-row-meta { flex: 1; min-width: 0; }
	.ap-row-name { display: block; font-size: 16px; color: var(--text-heading); font-family: 'Syne', sans-serif; font-weight: 700; line-height: 1.3; }
	.ap-row-sub { display: block; font-size: 12px; color: var(--text-dim); font-family: 'Space Mono', monospace; margin-top: 2px; }
	/* Right-hand column of a token row is a tap target that toggles
	   full ↔ compact. Reset button-default styling; cap max-width so long
	   numbers don't push the row into overflow; right-align the inner lines. */
	.ap-row-right {
		text-align: right; flex-shrink: 0;
		background: none; border: none; padding: 4px 6px; margin: -4px -6px;
		cursor: pointer; color: inherit; font-family: inherit;
		display: flex; flex-direction: column; align-items: flex-end; gap: 2px;
		max-width: 55%; min-width: 0; border-radius: 6px;
		transition: background 0.12s;
	}
	.ap-row-right:hover { background: var(--bg-surface-input); }
	.ap-row-right:active { background: var(--bg-surface-hover); }
	.ap-row-amt {
		display: block; font-size: 16px; color: var(--text-heading); font-family: 'Rajdhani', sans-serif;
		font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.3;
		max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	}
	.ap-row-usd {
		display: block; font-size: 13px; color: var(--text-dim); font-family: 'Rajdhani', sans-serif;
		font-weight: 500; font-variant-numeric: tabular-nums; margin-top: 2px;
		max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	}
	.ap-empty { text-align: center; padding: 24px; font-size: 13px; color: var(--text-dim); font-family: 'Space Mono', monospace; }

	/* Import */
	.ap-import-form { padding: 6px 16px; display: flex; flex-direction: column; gap: 6px; }
	.ap-import-btns { display: flex; gap: 6px; justify-content: flex-end; }
	.ap-import-btn {
		display: flex; align-items: center; justify-content: center; gap: 5px;
		margin: 4px 16px; padding: 9px; border: 1px dashed var(--border);
		border-radius: 8px; background: transparent; color: var(--text-dim); cursor: pointer;
		font-family: 'Space Mono', monospace; font-size: 10px; transition: all 0.15s;
	}
	.ap-import-btn:hover { border-color: rgba(0,210,255,0.15); color: #00d2ff; }

	/* Settings items */
	.ap-set-item {
		display: flex; align-items: center; gap: 10px; width: 100%;
		padding: 12px 16px; border: none; background: transparent;
		color: var(--text-muted); cursor: pointer; font-family: 'Space Mono', monospace;
		font-size: 11px; transition: all 0.1s; text-align: left;
	}
	.ap-set-item:hover { background: var(--bg-surface); color: var(--text); }
	.ap-set-arrow { margin-left: auto; color: var(--text-dim); }
	.ap-set-danger { color: #f87171; }
	.ap-set-danger:hover { background: rgba(248,113,113,0.04); }
	.ap-set-divider { height: 1px; background: var(--bg-surface); margin: 4px 16px; }

	/* Disconnect footer — subtle, always visible at bottom */
	.ap-disconnect {
		display: flex; align-items: center; justify-content: center; gap: 6px;
		padding: 10px 16px; margin: 4px 16px 12px; border-radius: 8px;
		border: 1px solid var(--border-subtle); background: transparent;
		color: var(--text-dim); cursor: pointer; font-family: 'Space Mono', monospace;
		font-size: 10px; transition: all 0.12s; flex-shrink: 0;
	}
	.ap-disconnect:hover { color: #f87171; border-color: rgba(248,113,113,0.15); background: rgba(248,113,113,0.04); }

	/* Sub-views content */
	.ap-view-content { flex: 1; padding: 16px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }

	/* Receive */
	.ap-receive { align-items: center; }
	.ap-qr {
		padding: 16px; background: var(--bg-surface);
		border: 1px solid var(--border); border-radius: 12px;
	}
	.ap-qr-img { display: block; border-radius: 4px; image-rendering: pixelated; }
	.ap-addr-box {
		padding: 16px; background: var(--bg-surface); border: 1px solid var(--border);
		border-radius: 10px; text-align: center; cursor: pointer; transition: border-color 0.15s;
	}
	.ap-addr-box:hover { border-color: rgba(0,210,255,0.2); }
	.ap-addr-full { display: block; font-family: 'Space Mono', monospace; font-size: 10px; color: var(--text-muted); word-break: break-all; line-height: 1.6; }
	.ap-addr-tap { display: block; font-size: 9px; color: #00d2ff; margin-top: 6px; font-family: 'Space Mono', monospace; }

	/* Send */
	.ap-send-info { display: flex; justify-content: space-between; font-size: 10px; color: var(--text-dim); font-family: 'Space Mono', monospace; }
	.ap-label { font-size: 9px; color: var(--text-dim); font-family: 'Space Mono', monospace; text-transform: uppercase; letter-spacing: 0.05em; }

	/* Security */
	.ap-sec-warn {
		display: flex; gap: 10px; padding: 12px; border-radius: 10px;
		background: rgba(245,158,11,0.04); border: 1px solid rgba(245,158,11,0.1);
	}
	.ap-sec-warn svg { flex-shrink: 0; margin-top: 2px; }
	.ap-sec-warn p { margin: 0; font-size: 10px; color: #f59e0b; font-family: 'Space Mono', monospace; line-height: 1.5; }

	/* Export danger */
	.ap-danger-box {
		display: flex; gap: 10px; padding: 14px; border-radius: 10px;
		background: rgba(248,113,113,0.04); border: 1px solid rgba(248,113,113,0.12);
	}
	.ap-danger-box svg { flex-shrink: 0; margin-top: 2px; }
	.ap-danger-box strong { display: block; font-family: 'Syne', sans-serif; font-size: 12px; color: #f87171; margin-bottom: 4px; }
	.ap-danger-box p { margin: 0; font-size: 10px; color: var(--text-muted); font-family: 'Space Mono', monospace; line-height: 1.5; }
	.ap-revealed {
		padding: 14px; background: rgba(248,113,113,0.04); border: 1px solid rgba(248,113,113,0.12);
		border-radius: 10px; font-family: 'Space Mono', monospace; font-size: 10px;
		color: #f87171; word-break: break-all; line-height: 1.7; cursor: pointer; transition: background 0.12s;
	}
	.ap-revealed:hover { background: rgba(248,113,113,0.08); }
	.ap-revealed-hint { text-align: center; font-size: 9px; color: var(--text-dim); font-family: 'Space Mono', monospace; margin: 0; }
	.ap-error { font-size: 10px; color: #f87171; font-family: 'Space Mono', monospace; margin: 0; padding: 4px 8px; background: rgba(248,113,113,0.04); border-radius: 4px; }
	.ap-hint { font-size: 10px; color: var(--text-dim); font-family: 'Space Mono', monospace; margin: 0; line-height: 1.5; }

	/* Shared inputs/buttons */
	.ap-input {
		width: 100%; padding: 10px 12px; border-radius: 8px;
		background: var(--bg-surface); border: 1px solid var(--border);
		color: var(--text-heading); font-family: 'Space Mono', monospace; font-size: 13px;
		outline: none; transition: border-color 0.12s;
	}
	.ap-input:focus { border-color: rgba(0,210,255,0.3); }
	.ap-input::placeholder { color: var(--text-dim); }
	/* Asset picker button */
	.ap-asset-btn {
		display: flex; align-items: center; gap: 10px; width: 100%;
		padding: 10px 12px; border-radius: 10px; cursor: pointer;
		background: var(--bg-surface); border: 1px solid var(--border);
		color: var(--text); font-family: 'Space Mono', monospace; font-size: 13px;
		transition: border-color 0.15s;
	}
	.ap-asset-btn:hover { border-color: rgba(0,210,255,0.3); }
	.ap-asset-logo { width: 24px; height: 24px; border-radius: 50%; object-fit: cover; flex-shrink: 0; }
	.ap-asset-letter {
		width: 24px; height: 24px; border-radius: 50%; flex-shrink: 0;
		display: flex; align-items: center; justify-content: center;
		background: rgba(0,210,255,0.15); color: #00d2ff;
		font-size: 11px; font-weight: 700;
	}
	.ap-asset-name { flex: 1; text-align: left; font-weight: 600; }
	.ap-asset-bal { color: var(--text-dim); font-size: 11px; }
	.ap-asset-chevron { flex-shrink: 0; color: var(--text-dim); }

	/* Asset picker modal — contained within wallet panel */
	.ap-picker-overlay {
		position: absolute; inset: 0; z-index: 10;
		background: rgba(0,0,0,0.5); backdrop-filter: blur(4px);
		display: flex; align-items: flex-end; justify-content: center;
		border-radius: inherit;
	}
	.ap-picker {
		background: var(--bg); border-top: 1px solid var(--border);
		border-radius: 16px 16px 0 0; width: 100%;
		height: 80vh; max-height: 80%; display: flex; flex-direction: column;
	}
	.ap-picker-header {
		display: flex; justify-content: space-between; align-items: center;
		padding: 16px 16px 12px; border-bottom: 1px solid var(--border);
	}
	.ap-picker-title { font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 700; color: white; }
	.ap-picker-close { background: none; border: none; color: var(--text-dim); cursor: pointer; padding: 4px; border-radius: 6px; }
	.ap-picker-close:hover { color: white; background: var(--bg-surface-hover); }
	.ap-picker-list { overflow-y: auto; padding: 8px; flex: 1; }
	.ap-picker-item {
		display: flex; align-items: center; gap: 10px; width: 100%;
		padding: 10px 8px; border-radius: 10px; cursor: pointer;
		background: none; border: none; color: var(--text);
		font-family: 'Space Mono', monospace; transition: background 0.1s;
	}
	.ap-picker-item:hover { background: var(--bg-surface-input); }
	.ap-picker-item.active { background: rgba(0,210,255,0.08); }
	.ap-picker-logo { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; flex-shrink: 0; }
	.ap-picker-letter {
		width: 32px; height: 32px; border-radius: 50%; flex-shrink: 0;
		display: flex; align-items: center; justify-content: center;
		background: rgba(0,210,255,0.12); color: #00d2ff;
		font-size: 13px; font-weight: 700;
	}
	.ap-picker-info { flex: 1; text-align: left; display: flex; flex-direction: column; gap: 1px; }
	.ap-picker-symbol { font-size: 13px; font-weight: 600; color: white; }
	.ap-picker-name { font-size: 10px; color: var(--text-dim); }
	.ap-picker-right { display: flex; flex-direction: column; align-items: flex-end; gap: 1px; }
	.ap-picker-bal { font-size: 12px; color: var(--text-dim); font-family: 'Space Mono', monospace; }
	.ap-picker-usd { font-size: 10px; color: var(--text-dim); font-family: 'Rajdhani', sans-serif; font-variant-numeric: tabular-nums; }
	.ap-send-estimate { font-family: 'Rajdhani', sans-serif; font-size: 13px; color: var(--text-dim); margin: -4px 0 4px; font-variant-numeric: tabular-nums; }

	.ap-btn {
		padding: 10px 16px; border-radius: 8px; border: 1px solid var(--border);
		background: var(--bg-surface); color: var(--text-muted); cursor: pointer;
		font-family: 'Space Mono', monospace; font-size: 11px; transition: all 0.12s;
	}
	.ap-btn:hover { background: var(--bg-surface-hover); color: var(--text-heading); }
	.ap-btn-s { padding: 6px 10px; font-size: 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-surface); color: var(--text-muted); cursor: pointer; font-family: 'Space Mono', monospace; transition: all 0.12s; }
	.ap-btn-s:hover { background: var(--bg-surface-hover); color: var(--text-heading); }
	.ap-btn-primary { background: linear-gradient(135deg, #00d2ff, #3a7bd5); border: none; color: white; font-family: 'Syne', sans-serif; font-weight: 700; }
	.ap-btn-primary:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(0,210,255,0.2); }
	.ap-btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
	.ap-btn-danger { background: rgba(248,113,113,0.1); border: 1px solid rgba(248,113,113,0.2); color: #f87171; font-family: 'Syne', sans-serif; font-weight: 700; }
	.ap-btn-danger:hover { background: rgba(248,113,113,0.15); }
	.ap-btn-full { width: 100%; }
</style>
