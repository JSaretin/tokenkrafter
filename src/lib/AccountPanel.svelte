<script lang="ts">
	import { goto } from '$app/navigation';
	import { ethers } from 'ethers';
	import {
		getWalletState,
		exportPrivateKey,
		exportSeedPhrase,
		setActiveAccount,
		addAccount,
		unlockWallet,
		onWalletStateChange,
		getSigner,
		pushPreferences,
		createNewWallet,
		importWallet,
		switchWallet,
		renameWallet,
		deleteWallet,
		setPrimaryWallet,
		type WalletState,
		type WalletContext,
	} from './embeddedWallet';
	import { getKnownLogo, resolveTokenLogo } from './tokenLogo';
	import { balanceState } from './balancePoller';
	import { queryTradeLens } from './tradeLens';
	import { friendlyError } from './errorDecoder';

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
	type View = 'main' | 'receive' | 'send' | 'security' | 'export-key' | 'export-seed';
	let view = $state<View>('main');
	let showAccountDropdown = $state(false);
	let renamingIndex = $state<number | null>(null);
	let renameValue = $state('');

	// ── Multi-wallet UI state ──
	let wallets = $derived<WalletContext[]>(walletState.wallets || []);
	let activeWalletId = $derived(walletState.activeWalletId);
	let activeWallet = $derived(wallets.find((w) => w.id === activeWalletId) || null);
	let addWalletMode = $state<'create' | 'import' | null>(null);
	let newWalletName = $state('');
	let newWalletPin = $state('');
	let importMnemonic = $state('');
	let importAck = $state(false);
	let addWalletError = $state('');
	let addWalletLoading = $state(false);
	let addWalletCodes = $state<string[]>([]);
	let renamingWalletId = $state<string | null>(null);
	let renamingWalletValue = $state('');
	let switchingWalletId = $state<string | null>(null);

	function resetAddWalletForm() {
		addWalletMode = null;
		newWalletName = '';
		newWalletPin = '';
		importMnemonic = '';
		importAck = false;
		addWalletError = '';
		addWalletLoading = false;
		addWalletCodes = [];
	}

	async function handleSwitchWallet(walletId: string) {
		if (walletId === activeWalletId) { showAccountDropdown = false; return; }
		switchingWalletId = walletId;
		try {
			const ok = await switchWallet(walletId);
			if (!ok) {
				onAddFeedback({ message: 'Wallet locked — PIN required', type: 'error' });
				return;
			}
			// Update parent's userAddress to the newly-active wallet's default account
			const next = getWalletState();
			if (next.activeAccount?.address) {
				userAddress = next.activeAccount.address;
				onAccountSwitch(next.activeAccount.address);
			}
			showAccountDropdown = false;
		} catch (e) {
			onAddFeedback({ message: friendlyError(e), type: 'error' });
		} finally {
			switchingWalletId = null;
		}
	}

	async function handleCreateWalletSubmit() {
		addWalletError = '';
		if (!newWalletName.trim()) { addWalletError = 'Name required'; return; }
		// For the first wallet the user sets their PIN; for subsequent wallets
		// we reuse the cached PIN so no PIN input needed. But we don't know
		// which case we're in without hitting state — createNewWallet needs a
		// pin either way, so on subsequent calls we pass an empty placeholder
		// and let the flow error if unexpected.
		const hasExistingWallet = wallets.length > 0;
		let pinToUse = newWalletPin;
		if (hasExistingWallet) {
			// The shared PIN cache inside embeddedWallet handles this — but
			// createNewWallet takes a PIN argument, so we need to ask.
			if (!newWalletPin || newWalletPin.length < 4) {
				addWalletError = 'Enter your existing PIN to encrypt the new wallet';
				return;
			}
			pinToUse = newWalletPin;
		} else if (!newWalletPin || newWalletPin.length < 4) {
			addWalletError = 'PIN must be at least 4 digits';
			return;
		}

		addWalletLoading = true;
		try {
			const result = await createNewWallet(newWalletName.trim(), pinToUse);
			addWalletCodes = result.recoveryCodes;
			onAddFeedback({ message: `Wallet "${result.wallet.name}" created`, type: 'success' });
			// Switch to it
			await handleSwitchWallet(result.wallet.id);
		} catch (e) {
			addWalletError = friendlyError(e);
		} finally {
			addWalletLoading = false;
		}
	}

	async function handleImportWalletSubmit() {
		addWalletError = '';
		if (!newWalletName.trim()) { addWalletError = 'Name required'; return; }
		if (!importMnemonic.trim()) { addWalletError = 'Recovery phrase required'; return; }
		if (!importAck) { addWalletError = 'Acknowledge the warning'; return; }

		addWalletLoading = true;
		try {
			const ctx = await importWallet(newWalletName.trim(), importMnemonic);
			onAddFeedback({ message: `Wallet "${ctx.name}" imported`, type: 'success' });
			resetAddWalletForm();
			await handleSwitchWallet(ctx.id);
		} catch (e) {
			addWalletError = friendlyError(e);
		} finally {
			addWalletLoading = false;
		}
	}

	async function handleRenameWallet(id: string) {
		const name = renamingWalletValue.trim();
		if (!name) { renamingWalletId = null; return; }
		try {
			await renameWallet(id, name);
			onAddFeedback({ message: 'Renamed', type: 'success' });
		} catch (e) {
			onAddFeedback({ message: friendlyError(e), type: 'error' });
		} finally {
			renamingWalletId = null;
			renamingWalletValue = '';
		}
	}

	async function handleDeleteWallet(id: string, name: string) {
		if (!confirm(`Delete wallet "${name}"? This removes the encrypted seed from the server. Make sure you have your own backup if it's an imported wallet.`)) return;
		try {
			await deleteWallet(id);
			onAddFeedback({ message: `Wallet "${name}" deleted`, type: 'success' });
		} catch (e) {
			onAddFeedback({ message: friendlyError(e), type: 'error' });
		}
	}

	async function handleSetPrimary(id: string) {
		try {
			await setPrimaryWallet(id);
			onAddFeedback({ message: 'Primary wallet updated', type: 'success' });
		} catch (e) {
			onAddFeedback({ message: friendlyError(e), type: 'error' });
		}
	}

	// Well-known token logos (native + major stables)
	function getTokenLogo(tok: { symbol: string; logoUrl?: string; address?: string }): string {
		if (tok.logoUrl) return tok.logoUrl;
		return getKnownLogo(tok.symbol || '');
	}
	let accountNames = $state<Record<number, string>>({});

	// Load saved names from localStorage
	$effect(() => {
		try {
			const saved = localStorage.getItem('account_names');
			if (saved) accountNames = JSON.parse(saved);
		} catch {}
	});

	function getAccountName(idx: number): string {
		return accountNames[idx] || `Account ${idx + 1}`;
	}

	function saveAccountName(idx: number, name: string) {
		accountNames[idx] = name;
		localStorage.setItem('account_names', JSON.stringify(accountNames));
		renamingIndex = null;
		renameValue = '';
		if (walletType === 'embedded') pushPreferences();
	}
	let creatingAccount = $state(false);
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
	let showContactBook = $state(false);

	let sendAssetInfo = $derived.by(() => {
		if (sendAsset === 'native') return { symbol: nativeCoin, decimals: nativeDecimals, balance: nativeBalance, priceUsd: nativePriceUsd };
		const tok = [...tokens, ...importedTokens].find(t => t.address.toLowerCase() === sendAsset.toLowerCase());
		return tok ? { symbol: tok.symbol, decimals: tok.decimals, balance: tok.balance, priceUsd: tok.priceUsd || 0 } : { symbol: nativeCoin, decimals: nativeDecimals, balance: nativeBalance, priceUsd: nativePriceUsd };
	});

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
			const provider = new ethers.JsonRpcProvider(rpcUrl);
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

	// Auto-refresh portfolio every 10s when panel is open (pause when account dropdown is open)
	$effect(() => {
		if (!open || !userAddress || !dexRouter || showAccountDropdown) return;
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
	function close() { open = false; view = 'main'; resetExport(); showAccountDropdown = false; renamingIndex = null; }

	function resetExport() { exportPin = ''; exportedValue = ''; exportError = ''; }

	function copyText(text: string) {
		navigator.clipboard.writeText(text);
		copiedAddr = true;
		setTimeout(() => copiedAddr = false, 2000);
	}

	function fmtBal(bal: bigint, dec: number): string {
		const v = parseFloat(ethers.formatUnits(bal, dec));
		if (v === 0) return '0';
		if (v >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
		if (v >= 1) return v.toFixed(4);
		if (v >= 0.0001) return v.toFixed(6);
		return v.toExponential(2);
	}

	function fmtUsd(val: number): string {
		if (val === 0) return '$0.00';
		if (val < 0.01) return '<$0.01';
		return `$${val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
	}

	function shortAddr(addr: string): string {
		if (!addr || addr.length < 12) return addr || '';
		return addr.slice(0, 8) + '...' + addr.slice(-6);
	}

	// ── Actions ──
	async function handleAddAccount() {
		creatingAccount = true;
		try {
			const acc = await addAccount();
			setActiveAccount(acc.index);
			onAccountSwitch(acc.address);
			onAddFeedback({ message: `Account ${acc.index + 1} created`, type: 'success' });
			showAccountDropdown = false;
		} catch (e: any) {
			onAddFeedback({ message: e.message || 'Failed to create account', type: 'error' });
		} finally {
			creatingAccount = false;
		}
	}

	function handleSwitchAccount(idx: number) {
		setActiveAccount(idx);
		const acc = accounts.find(a => a.index === idx);
		if (acc) onAccountSwitch(acc.address);
		showAccountDropdown = false;

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

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') { if (view !== 'main') view = 'main'; else close(); } }} />

{#if open}
<div class="ap-backdrop" onclick={close} role="presentation"></div>

<div class="ap" class:ap-closing={!open}>
	<!-- ═══ HEADER ═══ -->
	<div class="ap-head">
		{#if view !== 'main'}
			<button class="ap-back" onclick={() => { view = 'main'; resetExport(); }}>
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
			</button>
			<span class="ap-head-title">
				{view === 'receive' ? 'Receive' : view === 'send' ? 'Send' : view === 'security' ? 'Security' : view === 'export-key' ? 'Private Key' : 'Recovery Phrase'}
			</span>
		{:else}
			<!-- Account picker -->
			<button class="ap-acct-btn" onclick={(e) => { e.stopPropagation(); showAccountDropdown = !showAccountDropdown; }}>
				<div class="ap-avatar">{activeIndex + 1}</div>
				<div class="ap-acct-meta">
					<span class="ap-acct-name">{getAccountName(activeIndex)}</span>
					<span class="ap-acct-addr">{shortAddr(userAddress)}</span>
				</div>
				<svg class="ap-chev" class:ap-chev-flip={showAccountDropdown} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
			</button>

			{#if showAccountDropdown}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="ap-dd" onclick={(e) => e.stopPropagation()}>
					<!-- ═══ WALLETS ═══ -->
					{#if walletType === 'embedded' && wallets.length > 0}
						<div class="ap-dd-section-label">Wallets</div>
						{#each wallets as w (w.id)}
							<div class="ap-dd-row ap-dd-wallet-row">
								{#if renamingWalletId === w.id}
									<input class="ap-dd-rename" bind:value={renamingWalletValue} placeholder={w.name}
										onkeydown={(e) => { if (e.key === 'Enter') handleRenameWallet(w.id); if (e.key === 'Escape') { renamingWalletId = null; renamingWalletValue = ''; } }}
										{...INPUT_ATTRS} />
									<button class="ap-dd-gear" onclick={() => handleRenameWallet(w.id)} title="Save">
										<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
									</button>
								{:else}
									<button class="ap-dd-item" class:ap-dd-active={w.id === activeWalletId} onclick={() => handleSwitchWallet(w.id)} disabled={switchingWalletId === w.id}>
										<div class="ap-avatar ap-avatar-sm ap-avatar-wallet">{w.name.charAt(0).toUpperCase()}</div>
										<span class="ap-dd-name">
											{w.name}
											{#if w.isPrimary}<span class="ap-dd-badge ap-dd-badge-primary">primary</span>{/if}
											{#if w.isImported}<span class="ap-dd-badge ap-dd-badge-imported">imported</span>{/if}
										</span>
										<span class="ap-dd-addr">{w.accountCount} acc</span>
										<span class="ap-dd-check">
											{#if switchingWalletId === w.id}
												<span class="ap-dd-spinner"></span>
											{:else if w.id === activeWalletId}
												&#10003;
											{/if}
										</span>
									</button>
									<button class="ap-dd-gear" title="Rename wallet" onclick={(e) => { e.stopPropagation(); renamingWalletId = w.id; renamingWalletValue = w.name; }}>
										<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
									</button>
									{#if !w.isPrimary}
										<button class="ap-dd-gear" title="Set as primary" onclick={(e) => { e.stopPropagation(); handleSetPrimary(w.id); }}>
											<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
										</button>
									{/if}
									{#if wallets.length > 1 && !w.isPrimary}
										<button class="ap-dd-gear" title="Delete wallet" onclick={(e) => { e.stopPropagation(); handleDeleteWallet(w.id, w.name); }}>
											<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
										</button>
									{/if}
								{/if}
							</div>
						{/each}

						<!-- Add wallet form -->
						{#if addWalletMode === null}
							<div class="ap-dd-wallet-actions">
								<button class="ap-dd-item ap-dd-add" onclick={() => { resetAddWalletForm(); addWalletMode = 'create'; newWalletName = `Wallet ${wallets.length + 1}`; }}>
									<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
									New wallet
								</button>
								<button class="ap-dd-item ap-dd-add" onclick={() => { resetAddWalletForm(); addWalletMode = 'import'; newWalletName = `Imported ${wallets.length + 1}`; }}>
									<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
									Import wallet
								</button>
							</div>
						{:else if addWalletMode === 'create' && addWalletCodes.length === 0}
							<div class="ap-dd-form">
								<div class="ap-dd-form-title">Create new wallet</div>
								<input class="ap-input" type="text" placeholder="Wallet name" bind:value={newWalletName} maxlength="40" {...INPUT_ATTRS} />
								<input class="ap-input" type="password" placeholder="Your PIN" bind:value={newWalletPin} {...INPUT_ATTRS} />
								{#if addWalletError}<p class="ap-dd-error">{addWalletError}</p>{/if}
								<div class="ap-dd-form-btns">
									<button class="ap-btn-s" onclick={() => resetAddWalletForm()}>Cancel</button>
									<button class="ap-btn-s ap-btn-primary" disabled={addWalletLoading} onclick={handleCreateWalletSubmit}>
										{addWalletLoading ? 'Creating...' : 'Create'}
									</button>
								</div>
							</div>
						{:else if addWalletMode === 'create' && addWalletCodes.length > 0}
							<div class="ap-dd-form">
								<div class="ap-dd-form-title">Recovery codes</div>
								<p class="ap-dd-form-hint">Save these. Each can unlock this wallet if you forget your PIN. They won't be shown again.</p>
								<div class="ap-dd-codes">
									{#each addWalletCodes as code, i}
										<div class="ap-dd-code">{i + 1}. {code}</div>
									{/each}
								</div>
								<button class="ap-btn-s ap-btn-primary" onclick={() => resetAddWalletForm()}>Done</button>
							</div>
						{:else if addWalletMode === 'import'}
							<div class="ap-dd-form">
								<div class="ap-dd-form-title">Import existing wallet</div>
								<input class="ap-input" type="text" placeholder="Wallet name" bind:value={newWalletName} maxlength="40" {...INPUT_ATTRS} />
								<textarea class="ap-input ap-dd-textarea" rows="3" placeholder="12 or 24 word recovery phrase" bind:value={importMnemonic} {...INPUT_ATTRS}></textarea>
								<label class="ap-dd-ack">
									<input type="checkbox" bind:checked={importAck} />
									<span>Imported wallets have no platform recovery — I have my own backup.</span>
								</label>
								{#if addWalletError}<p class="ap-dd-error">{addWalletError}</p>{/if}
								<div class="ap-dd-form-btns">
									<button class="ap-btn-s" onclick={() => resetAddWalletForm()}>Cancel</button>
									<button class="ap-btn-s ap-btn-primary" disabled={addWalletLoading} onclick={handleImportWalletSubmit}>
										{addWalletLoading ? 'Importing...' : 'Import'}
									</button>
								</div>
							</div>
						{/if}

						<div class="ap-set-divider"></div>
					{/if}

					<!-- ═══ ACCOUNTS (in active wallet) ═══ -->
					{#if walletType === 'embedded' && activeWallet}
						<div class="ap-dd-section-label">Accounts in {activeWallet.name}</div>
					{/if}
					{#each accounts as acc, i}
						<div class="ap-dd-row">
							{#if renamingIndex === i}
								<input class="ap-dd-rename" bind:value={renameValue} placeholder={getAccountName(i)}
									onkeydown={(e) => { if (e.key === 'Enter') saveAccountName(i, renameValue || getAccountName(i)); if (e.key === 'Escape') renamingIndex = null; }}
									{...INPUT_ATTRS} />
								<button class="ap-dd-gear" onclick={() => saveAccountName(i, renameValue || getAccountName(i))} title="Save">
									<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
								</button>
							{:else}
								<button class="ap-dd-item" class:ap-dd-active={i === activeIndex} onclick={() => handleSwitchAccount(i)}>
									<div class="ap-avatar ap-avatar-sm">{i + 1}</div>
									<span class="ap-dd-name">{getAccountName(i)}</span>
									<span class="ap-dd-addr">{acc.address.slice(0, 6)}...{acc.address.slice(-4)}</span>
									<span class="ap-dd-check">{#if i === activeIndex}&#10003;{/if}</span>
								</button>
								<button class="ap-dd-gear" title="Rename" onclick={(e) => { e.stopPropagation(); renamingIndex = i; renameValue = getAccountName(i); }}>
									<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
								</button>
								{#if walletType === 'embedded'}
									<button class="ap-dd-gear" title="Security" onclick={(e) => { e.stopPropagation(); setActiveAccount(i); onAccountSwitch(acc.address); showAccountDropdown = false; view = 'security'; }}>
										<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
									</button>
								{/if}
							{/if}
						</div>
					{/each}
					{#if walletType === 'embedded'}
						<button class="ap-dd-item ap-dd-add" onclick={handleAddAccount} disabled={creatingAccount}>
							<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
							{creatingAccount ? 'Creating...' : 'New Account'}
						</button>
					{/if}
					<div class="ap-set-divider"></div>
					<button class="ap-dd-item ap-dd-disconnect" onclick={() => { onDisconnect(); close(); }}>
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
						Disconnect
					</button>
				</div>
			{/if}
		{/if}

		<button class="ap-x" onclick={close}>
			<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
		</button>
	</div>

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
				<span>Buy</span>
			</button>
			<button class="ap-act" onclick={() => view = 'send'}>
				<div class="ap-act-circle"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg></div>
				<span>Send</span>
			</button>
			<button class="ap-act" onclick={() => view = 'receive'}>
				<div class="ap-act-circle"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg></div>
				<span>Receive</span>
			</button>
			<button class="ap-act" onclick={() => { close(); goto('/trade'); }}>
				<div class="ap-act-circle"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg></div>
				<span>Swap</span>
			</button>
		</div>

		<!-- Assets header -->
		<div class="ap-section-head">Assets</div>


		{#if true}
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
						<span class="ap-row-sub">Native</span>
					</div>
					<div class="ap-row-right">
						<span class="ap-row-amt">{fmtBal(nativeBalance, nativeDecimals)}</span>
						<span class="ap-row-usd">{fmtUsd(nativeUsd)}</span>
					</div>
				</div>

				<!-- Tokens sorted by USD value -->
				{#each sortedTokens as tok}
					{@const usd = tok._usd}
					{@const logo = getTokenLogo(tok)}
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
						<div class="ap-row-right">
							<span class="ap-row-amt">{fmtBal(tok.balance, tok.decimals)}</span>
							<span class="ap-row-usd">{usd > 0 ? fmtUsd(usd) : ''}</span>
						</div>
					</div>
				{/each}

				{#if tokens.length === 0 && importedTokens.length === 0}
					<p class="ap-empty">No imported tokens</p>
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
						Import Token
					</button>
				{/if}
			</div>

		{/if}

		<!-- Disconnect footer -->
		<button class="ap-disconnect" onclick={() => { onDisconnect(); close(); }}>
			<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
			Disconnect
		</button>

	<!-- ═══ RECEIVE VIEW ═══ -->
	{:else if view === 'receive'}
		<div class="ap-view-content ap-receive">
			<p class="ap-hint">Send only {nativeCoin} and tokens on {networkName} to this address.</p>
			<div class="ap-qr">
				<img
					src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&bgcolor=0a0b10&color=ffffff&data={encodeURIComponent(userAddress)}"
					alt="QR Code"
					width="180"
					height="180"
					class="ap-qr-img"
				/>
			</div>
			<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
			<div class="ap-addr-box" onclick={() => { copyText(userAddress); onAddFeedback({ message: 'Address copied', type: 'success' }); }}>
				<span class="ap-addr-full">{userAddress}</span>
				<span class="ap-addr-tap">{copiedAddr ? 'Copied!' : 'Tap to copy'}</span>
			</div>
		</div>

	<!-- ═══ SEND VIEW ═══ -->
	{:else if view === 'send'}
		<div class="ap-view-content">
			<label class="ap-label">Asset</label>
			<button class="ap-asset-btn" type="button" onclick={() => showAssetPicker = true}>
				{#if sendAsset === 'native'}
					{#if getKnownLogo(nativeCoin)}
						<img src={getKnownLogo(nativeCoin)} alt="" class="ap-asset-logo" />
					{:else}
						<span class="ap-asset-letter">{nativeCoin.charAt(0)}</span>
					{/if}
					<span class="ap-asset-name">{nativeCoin}</span>
					<span class="ap-asset-bal">{fmtBal(nativeBalance, nativeDecimals)}</span>
				{:else}
					{@const tok = [...tokens, ...importedTokens].find(t => t.address.toLowerCase() === sendAsset.toLowerCase())}
					{#if tok}
						{#if getTokenLogo(tok)}
							<img src={getTokenLogo(tok)} alt="" class="ap-asset-logo" />
						{:else}
							<span class="ap-asset-letter">{tok.symbol.charAt(0)}</span>
						{/if}
						<span class="ap-asset-name">{tok.symbol}</span>
						<span class="ap-asset-bal">{fmtBal(tok.balance, tok.decimals)}</span>
					{/if}
				{/if}
				<svg class="ap-asset-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
			</button>

			{#if showAssetPicker}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<div class="ap-picker-overlay" onclick={(e) => { if (e.target === e.currentTarget) showAssetPicker = false; }}>
					<div class="ap-picker">
						<div class="ap-picker-header">
							<span class="ap-picker-title">Select Asset</span>
							<button class="ap-picker-close" type="button" onclick={() => showAssetPicker = false}>
								<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
							</button>
						</div>
						<div class="ap-picker-list">
							<!-- Native coin (always first if has balance) -->
							{#if nativeBalance > 0n}
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
							{/if}
							<!-- Tokens sorted by USD value, hide zero balance -->
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

			<label class="ap-label">To</label>
			<div class="ap-to-wrap">
				<input class="ap-input" style="padding-right: 40px;" type="text" placeholder="Recipient (0x...)" bind:value={sendTo} {...INPUT_ATTRS} />
				{#if walletType === 'embedded' && accounts.length > 1}
					<button class="ap-book-btn" type="button" title="My accounts" onclick={() => showContactBook = !showContactBook}>
						<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/><path d="M8 7h6"/><path d="M8 11h4"/></svg>
					</button>
				{/if}
			</div>

			{#if showContactBook}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<div class="ap-book-overlay" onclick={() => showContactBook = false}>
					<div class="ap-book-modal" onclick={(e) => e.stopPropagation()}>
						<div class="ap-book-header">
							<span class="ap-book-title">My Accounts</span>
							<button class="ap-book-close" type="button" onclick={() => showContactBook = false}>
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
							</button>
						</div>
						{#each accounts.filter(a => a.address.toLowerCase() !== userAddress.toLowerCase()) as acc}
							{@const cached = (() => { try { const c = JSON.parse(localStorage.getItem(cacheKey(acc.address)) || '{}'); return c.nativeBalance ? parseFloat(ethers.formatEther(BigInt(c.nativeBalance))).toFixed(4) : '0'; } catch { return '0'; } })()}
							<button class="ap-book-item" type="button" onclick={() => { sendTo = acc.address; showContactBook = false; }}>
								<div class="ap-book-avatar">{(accountNames[acc.index] || `A${acc.index + 1}`).charAt(0)}</div>
								<div class="ap-book-info">
									<span class="ap-book-name">{accountNames[acc.index] || `Account ${acc.index + 1}`}</span>
									<span class="ap-book-addr">{acc.address.slice(0, 8)}...{acc.address.slice(-6)}</span>
								</div>
								<span class="ap-book-bal">{cached} {nativeCoin}</span>
							</button>
						{/each}
					</div>
				</div>
			{/if}

			<label class="ap-label">Amount</label>
			<input class="ap-input" type="text" inputmode="decimal" placeholder="0.0" bind:value={sendAmount} {...INPUT_ATTRS} />
			{#if sendAmount && sendAssetInfo.priceUsd > 0}
				{@const sendUsdEstimate = parseFloat(sendAmount || '0') * sendAssetInfo.priceUsd}
				{#if sendUsdEstimate > 0}
					<div class="ap-send-estimate">≈ {fmtUsd(sendUsdEstimate)}</div>
				{/if}
			{/if}
			<div class="ap-send-info">
				<span>Balance: {fmtBal(sendAssetInfo.balance, sendAssetInfo.decimals)} {sendAssetInfo.symbol}</span>
				<button class="ap-link" onclick={() => {
					const dec = sendAsset === 'native' ? nativeDecimals : sendAssetInfo.decimals;
					if (sendAsset === 'native') {
						const reserve = ethers.parseUnits('0.001', dec);
						const max = sendAssetInfo.balance > reserve ? sendAssetInfo.balance - reserve : 0n;
						sendAmount = ethers.formatUnits(max, dec);
					} else {
						sendAmount = ethers.formatUnits(sendAssetInfo.balance, dec);
					}
				}}>MAX</button>
			</div>

			<button class="ap-btn ap-btn-primary ap-btn-full" disabled={sending || !sendTo || !sendAmount} onclick={async () => {
				if (!ethers.isAddress(sendTo)) { onAddFeedback({ message: 'Invalid recipient address', type: 'error' }); return; }
				const amt = parseFloat(sendAmount);
				if (isNaN(amt) || amt <= 0) { onAddFeedback({ message: 'Invalid amount', type: 'error' }); return; }

				sending = true;
				try {
					const net = getProvider();
					if (!net) throw new Error('No provider');
					const wallet = getSigner(net.provider as any);
					if (!wallet) throw new Error('Wallet locked — unlock first');

					// Truncate decimals to token's precision
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

					sendTo = ''; sendAmount = ''; sendAsset = 'native'; view = 'main';
					// Refresh balances
					onRefreshBalance();
					refreshTokenBalances();
				} catch (e: any) {
					const msg = friendlyError(e);
					onAddFeedback({ message: msg.slice(0, 80), type: 'error' });
				} finally {
					sending = false;
				}
			}}>
				{sending ? 'Sending...' : `Send ${sendAssetInfo.symbol}`}
			</button>
		</div>

	<!-- ═══ SECURITY VIEW ═══ -->
	{:else if view === 'security'}
		<div class="ap-view-content">
			<div class="ap-sec-warn">
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
				<p>These options expose sensitive data. Never share your private key or recovery phrase with anyone.</p>
			</div>
			<button class="ap-set-item" onclick={() => { resetExport(); view = 'export-key'; }}>
				<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
				<span>Export Private Key</span>
				<svg class="ap-set-arrow" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
			</button>
			<button class="ap-set-item" onclick={() => { resetExport(); view = 'export-seed'; }}>
				<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
				<span>Export Recovery Phrase</span>
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
						<p>{view === 'export-key' ? 'Your private key gives full control of this account. Anyone with it can steal all your funds.' : 'Your recovery phrase controls ALL accounts in this wallet. Guard it with your life.'}</p>
					</div>
				</div>

				<label class="ap-label">Enter PIN to continue</label>
				<input class="ap-input" type="tel" inputmode="numeric" style="-webkit-text-security: disc; text-security: disc;" placeholder="PIN" bind:value={exportPin}
					{...INPUT_ATTRS}
					onkeydown={(e) => { if (e.key === 'Enter') handleExport(view === 'export-key' ? 'key' : 'seed'); }} />

				{#if exportError}<p class="ap-error">{exportError}</p>{/if}

				<button class="ap-btn ap-btn-danger ap-btn-full" onclick={() => handleExport(view === 'export-key' ? 'key' : 'seed')}>
					Reveal {view === 'export-key' ? 'Private Key' : 'Recovery Phrase'}
				</button>
			{:else}
				<div class="ap-revealed" onclick={() => { navigator.clipboard.writeText(exportedValue); onAddFeedback({ message: 'Copied to clipboard', type: 'info' }); }}>
					{exportedValue}
				</div>
				<p class="ap-revealed-hint">Tap to copy. Do not share this with anyone.</p>
				<button class="ap-btn ap-btn-full" onclick={() => { view = 'security'; resetExport(); }}>Done</button>
			{/if}
		</div>
	{/if}
</div>
{/if}

<style>
	.ap-backdrop { position: fixed; inset: 0; z-index: 9998; background: rgba(0,0,0,0.6); backdrop-filter: blur(3px); }

	.ap {
		position: fixed; top: 0; right: 0; bottom: 0; z-index: 9999;
		width: 360px; background: #0a0b10;
		border-left: 1px solid rgba(255,255,255,0.05);
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
		background: rgba(255,255,255,0.04); color: #94a3b8; cursor: pointer;
		display: flex; align-items: center; justify-content: center;
		transition: all 0.12s; flex-shrink: 0;
	}
	.ap-back:hover { background: rgba(255,255,255,0.08); color: #fff; }
	.ap-head-title {
		font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 700; color: #e2e8f0; flex: 1;
	}
	.ap-x {
		width: 28px; height: 28px; border-radius: 8px; border: none;
		background: rgba(255,255,255,0.04); color: #64748b; cursor: pointer;
		display: flex; align-items: center; justify-content: center;
		transition: all 0.12s; flex-shrink: 0; margin-left: auto;
	}
	.ap-x:hover { background: rgba(255,255,255,0.08); color: #fff; }

	/* Account picker */
	.ap-acct-btn {
		display: flex; align-items: center; gap: 10px; flex: 1;
		background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);
		border-radius: 10px; padding: 7px 12px; cursor: pointer;
		color: inherit; font-family: inherit; transition: border-color 0.15s;
	}
	.ap-acct-btn:hover { border-color: rgba(0,210,255,0.2); }
	.ap-avatar {
		width: 26px; height: 26px; border-radius: 50%;
		background: linear-gradient(135deg, rgba(0,210,255,0.12), rgba(58,123,213,0.12));
		border: 1px solid rgba(0,210,255,0.2);
		display: flex; align-items: center; justify-content: center;
		font-family: 'Syne', sans-serif; font-size: 10px; font-weight: 800;
		color: #00d2ff; flex-shrink: 0;
	}
	.ap-avatar-sm { width: 20px; height: 20px; font-size: 8px; }
	.ap-acct-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0; }
	.ap-acct-name { font-family: 'Syne', sans-serif; font-size: 11px; font-weight: 700; color: #e2e8f0; }
	.ap-acct-addr { font-family: 'Space Mono', monospace; font-size: 8px; color: #475569; }
	.ap-chev { color: #475569; flex-shrink: 0; transition: transform 0.15s; }
	.ap-chev-flip { transform: rotate(180deg); }

	/* Dropdown */
	.ap-dd {
		position: absolute; top: 58px; left: 16px; right: 50px; z-index: 10;
		background: #0f1118; border: 1px solid rgba(255,255,255,0.08);
		border-radius: 10px; padding: 4px; box-shadow: 0 8px 24px rgba(0,0,0,0.5);
	}
	.ap-dd-item {
		display: flex; align-items: center; gap: 8px; width: 100%;
		padding: 8px 10px; border-radius: 7px; border: none;
		background: transparent; color: #94a3b8; cursor: pointer;
		font-family: 'Space Mono', monospace; font-size: 10px; transition: all 0.1s;
	}
	.ap-dd-item:hover { background: rgba(255,255,255,0.04); color: #fff; }
	.ap-dd-active { color: #00d2ff; }
	.ap-dd-row { display: flex; align-items: center; gap: 0; }
	.ap-dd-row .ap-dd-item { flex: 1; min-width: 0; }
	.ap-dd-name { font-family: 'Syne', sans-serif; font-weight: 600; font-size: 11px; white-space: nowrap; }
	.ap-dd-addr { font-size: 8px; color: #374151; margin-left: auto; white-space: nowrap; }
	.ap-dd-check { color: #10b981; font-size: 11px; width: 16px; text-align: center; flex-shrink: 0; }
	.ap-dd-gear {
		width: 28px; height: 28px; border-radius: 6px; border: none;
		background: transparent; color: #374151; cursor: pointer;
		display: flex; align-items: center; justify-content: center;
		transition: all 0.12s; flex-shrink: 0;
	}
	.ap-dd-gear:hover { background: rgba(255,255,255,0.04); color: #94a3b8; }
	.ap-dd-rename {
		flex: 1; padding: 6px 10px; border-radius: 6px;
		background: rgba(255,255,255,0.04); border: 1px solid rgba(0,210,255,0.3);
		color: #fff; font-family: 'Syne', sans-serif; font-size: 11px; font-weight: 600;
		outline: none;
	}
	.ap-dd-add { color: #00d2ff; border-top: 1px solid rgba(255,255,255,0.04); margin-top: 2px; }
	.ap-dd-disconnect { color: #f87171; border-top: 1px solid rgba(255,255,255,0.04); margin-top: 2px; }
	.ap-dd-disconnect:hover { background: rgba(248,113,113,0.06); color: #f87171; }

	/* Multi-wallet: section labels, wallet badges, add-wallet form */
	.ap-dd-section-label {
		font-family: 'Space Mono', monospace; font-size: 8px; font-weight: 700;
		color: #475569; text-transform: uppercase; letter-spacing: 0.08em;
		padding: 6px 16px 2px;
	}
	.ap-dd-wallet-row .ap-dd-item { padding-right: 4px; }
	.ap-avatar-wallet { background: rgba(0,210,255,0.12); color: #00d2ff; }
	.ap-dd-badge {
		display: inline-block; margin-left: 6px;
		font-family: 'Space Mono', monospace; font-size: 7px; font-weight: 700;
		padding: 1px 5px; border-radius: 3px; text-transform: uppercase;
		letter-spacing: 0.05em; vertical-align: middle;
	}
	.ap-dd-badge-primary { background: rgba(16,185,129,0.12); color: #10b981; }
	.ap-dd-badge-imported { background: rgba(251,191,36,0.12); color: #fbbf24; }
	.ap-dd-spinner {
		display: inline-block; width: 10px; height: 10px; border-radius: 50%;
		border: 1.5px solid rgba(255,255,255,0.1); border-top-color: #00d2ff;
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }
	.ap-dd-wallet-actions { display: flex; gap: 4px; padding: 0 8px; }
	.ap-dd-wallet-actions .ap-dd-add { flex: 1; justify-content: center; text-align: center; padding: 8px; border-top: none; border: 1px solid rgba(0,210,255,0.15); border-radius: 6px; margin-top: 4px; }
	.ap-dd-form {
		padding: 10px 16px; display: flex; flex-direction: column; gap: 8px;
		background: rgba(0,210,255,0.03); border-top: 1px solid rgba(0,210,255,0.08);
		border-bottom: 1px solid rgba(0,210,255,0.08);
	}
	.ap-dd-form-title {
		font-family: 'Syne', sans-serif; font-size: 11px; font-weight: 700; color: #fff;
	}
	.ap-dd-form-hint {
		font-family: 'Space Mono', monospace; font-size: 9px; color: #64748b;
		margin: 0; line-height: 1.5;
	}
	.ap-dd-form-btns { display: flex; gap: 8px; justify-content: flex-end; }
	.ap-dd-textarea {
		width: 100%; resize: vertical; font-family: 'Space Mono', monospace; font-size: 11px;
		line-height: 1.5;
	}
	.ap-dd-ack {
		display: flex; align-items: flex-start; gap: 6px;
		font-family: 'Space Mono', monospace; font-size: 9px; color: #94a3b8;
		line-height: 1.4; cursor: pointer;
	}
	.ap-dd-ack input { accent-color: #00d2ff; flex-shrink: 0; margin-top: 1px; }
	.ap-dd-error {
		font-family: 'Space Mono', monospace; font-size: 10px; color: #f87171;
		margin: 0; padding: 4px 8px; background: rgba(248,113,113,0.06); border-radius: 4px;
	}
	.ap-dd-codes {
		display: flex; flex-direction: column; gap: 4px;
		padding: 8px; background: rgba(16,185,129,0.06);
		border: 1px solid rgba(16,185,129,0.15); border-radius: 6px;
	}
	.ap-dd-code {
		font-family: 'Space Mono', monospace; font-size: 11px; color: #10b981;
		letter-spacing: 0.03em;
	}

	/* Network */
	.ap-net { display: flex; align-items: center; gap: 5px; padding: 0 16px 4px; font-size: 9px; color: #475569; font-family: 'Space Mono', monospace; }
	.ap-net-dot { width: 5px; height: 5px; border-radius: 50%; background: #10b981; }

	/* Balance */
	.ap-bal { text-align: center; padding: 16px 16px 20px; }
	.ap-bal-total {
		display: block; font-family: 'Rajdhani', sans-serif; font-size: 44px;
		font-weight: 700; color: #fff; line-height: 1.1; font-variant-numeric: tabular-nums;
		letter-spacing: -0.02em;
	}
	.ap-bal-loading { font-size: 24px; color: #475569; animation: blink 1s infinite; }
	.ap-bal-equiv { font-size: 14px; color: #475569; margin-left: 6px; }
	@keyframes blink { 0%,100% { opacity: 0.3; } 50% { opacity: 1; } }
	.ap-bal-native {
		display: block; font-family: 'Rajdhani', sans-serif; font-size: 16px;
		font-weight: 500; color: #94a3b8; margin-top: 6px; font-variant-numeric: tabular-nums;
	}

	/* Action buttons */
	.ap-acts { display: flex; justify-content: center; gap: 18px; padding: 0 16px 14px; }
	.ap-act {
		display: flex; flex-direction: column; align-items: center; gap: 5px;
		background: none; border: none; cursor: pointer; color: #94a3b8;
		font-family: 'Space Mono', monospace; font-size: 9px; transition: color 0.12s;
	}
	.ap-act:hover { color: #00d2ff; }
	.ap-act-circle {
		width: 40px; height: 40px; border-radius: 50%;
		background: rgba(0,210,255,0.05); border: 1px solid rgba(0,210,255,0.1);
		display: flex; align-items: center; justify-content: center; transition: all 0.15s;
	}
	.ap-act:hover .ap-act-circle { background: rgba(0,210,255,0.1); border-color: rgba(0,210,255,0.25); transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,210,255,0.1); }

	/* Tabs */
	.ap-tabs { display: flex; border-bottom: 1px solid rgba(255,255,255,0.04); padding: 0 16px; }
	.ap-tab {
		flex: 1; padding: 9px; text-align: center; border: none; background: none;
		cursor: pointer; font-family: 'Space Mono', monospace; font-size: 10px;
		color: #475569; position: relative; transition: color 0.12s;
	}
	.ap-tab:hover { color: #94a3b8; }
	.ap-tab.active { color: #00d2ff; }
	.ap-tab.active::after { content: ''; position: absolute; bottom: -1px; left: 20%; right: 20%; height: 2px; background: #00d2ff; border-radius: 1px; }

	/* Section head */
	.ap-section-head {
		padding: 8px 16px 4px; font-family: 'Syne', sans-serif; font-size: 12px;
		font-weight: 700; color: #475569; text-transform: uppercase; letter-spacing: 0.04em;
	}

	/* Scrollable content area */
	.ap-scroll { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 6px 0; }

	/* Token rows */
	.ap-row { display: flex; align-items: center; gap: 12px; padding: 12px 16px; transition: background 0.1s; }
	.ap-row:hover { background: rgba(255,255,255,0.025); }
	.ap-row-icon {
		width: 40px; height: 40px; border-radius: 50%;
		background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06);
		display: flex; align-items: center; justify-content: center;
		font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 800; color: #94a3b8; flex-shrink: 0;
	}
	.ap-row-native { background: rgba(245,158,11,0.08); border-color: rgba(245,158,11,0.15); color: #f59e0b; }
	.ap-row-logo { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; flex-shrink: 0; border: 1px solid rgba(255,255,255,0.06); }
	.ap-row-meta { flex: 1; min-width: 0; }
	.ap-row-name { display: block; font-size: 16px; color: #fff; font-family: 'Syne', sans-serif; font-weight: 700; line-height: 1.3; }
	.ap-row-sub { display: block; font-size: 12px; color: #64748b; font-family: 'Space Mono', monospace; margin-top: 2px; }
	.ap-row-right { text-align: right; flex-shrink: 0; }
	.ap-row-amt { display: block; font-size: 16px; color: #fff; font-family: 'Rajdhani', sans-serif; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.3; }
	.ap-row-usd { display: block; font-size: 13px; color: #64748b; font-family: 'Rajdhani', sans-serif; font-weight: 500; font-variant-numeric: tabular-nums; margin-top: 2px; }
	.ap-empty { text-align: center; padding: 24px; font-size: 13px; color: #64748b; font-family: 'Space Mono', monospace; }

	/* Import */
	.ap-import-form { padding: 6px 16px; display: flex; flex-direction: column; gap: 6px; }
	.ap-import-btns { display: flex; gap: 6px; justify-content: flex-end; }
	.ap-import-btn {
		display: flex; align-items: center; justify-content: center; gap: 5px;
		margin: 4px 16px; padding: 9px; border: 1px dashed rgba(255,255,255,0.06);
		border-radius: 8px; background: transparent; color: #374151; cursor: pointer;
		font-family: 'Space Mono', monospace; font-size: 10px; transition: all 0.15s;
	}
	.ap-import-btn:hover { border-color: rgba(0,210,255,0.15); color: #00d2ff; }

	/* Settings items */
	.ap-set-item {
		display: flex; align-items: center; gap: 10px; width: 100%;
		padding: 12px 16px; border: none; background: transparent;
		color: #94a3b8; cursor: pointer; font-family: 'Space Mono', monospace;
		font-size: 11px; transition: all 0.1s; text-align: left;
	}
	.ap-set-item:hover { background: rgba(255,255,255,0.02); color: #e2e8f0; }
	.ap-set-arrow { margin-left: auto; color: #1e293b; }
	.ap-set-danger { color: #f87171; }
	.ap-set-danger:hover { background: rgba(248,113,113,0.04); }
	.ap-set-divider { height: 1px; background: rgba(255,255,255,0.03); margin: 4px 16px; }

	/* Disconnect footer — subtle, always visible at bottom */
	.ap-disconnect {
		display: flex; align-items: center; justify-content: center; gap: 6px;
		padding: 10px 16px; margin: 4px 16px 12px; border-radius: 8px;
		border: 1px solid rgba(255,255,255,0.04); background: transparent;
		color: #374151; cursor: pointer; font-family: 'Space Mono', monospace;
		font-size: 10px; transition: all 0.12s; flex-shrink: 0;
	}
	.ap-disconnect:hover { color: #f87171; border-color: rgba(248,113,113,0.15); background: rgba(248,113,113,0.04); }

	/* Sub-views content */
	.ap-view-content { flex: 1; padding: 16px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }

	/* Receive */
	.ap-receive { align-items: center; }
	.ap-qr {
		padding: 16px; background: rgba(255,255,255,0.02);
		border: 1px solid rgba(255,255,255,0.06); border-radius: 12px;
	}
	.ap-qr-img { display: block; border-radius: 4px; image-rendering: pixelated; }
	.ap-addr-box {
		padding: 16px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06);
		border-radius: 10px; text-align: center; cursor: pointer; transition: border-color 0.15s;
	}
	.ap-addr-box:hover { border-color: rgba(0,210,255,0.2); }
	.ap-addr-full { display: block; font-family: 'Space Mono', monospace; font-size: 10px; color: #94a3b8; word-break: break-all; line-height: 1.6; }
	.ap-addr-tap { display: block; font-size: 9px; color: #00d2ff; margin-top: 6px; font-family: 'Space Mono', monospace; }

	/* Send */
	.ap-send-info { display: flex; justify-content: space-between; font-size: 10px; color: #374151; font-family: 'Space Mono', monospace; }
	.ap-label { font-size: 9px; color: #475569; font-family: 'Space Mono', monospace; text-transform: uppercase; letter-spacing: 0.05em; }
	.ap-link { background: none; border: none; color: #00d2ff; cursor: pointer; font-family: 'Space Mono', monospace; font-size: 10px; }

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
	.ap-danger-box p { margin: 0; font-size: 10px; color: #94a3b8; font-family: 'Space Mono', monospace; line-height: 1.5; }
	.ap-revealed {
		padding: 14px; background: rgba(248,113,113,0.04); border: 1px solid rgba(248,113,113,0.12);
		border-radius: 10px; font-family: 'Space Mono', monospace; font-size: 10px;
		color: #f87171; word-break: break-all; line-height: 1.7; cursor: pointer; transition: background 0.12s;
	}
	.ap-revealed:hover { background: rgba(248,113,113,0.08); }
	.ap-revealed-hint { text-align: center; font-size: 9px; color: #475569; font-family: 'Space Mono', monospace; margin: 0; }
	.ap-error { font-size: 10px; color: #f87171; font-family: 'Space Mono', monospace; margin: 0; padding: 4px 8px; background: rgba(248,113,113,0.04); border-radius: 4px; }
	.ap-hint { font-size: 10px; color: #475569; font-family: 'Space Mono', monospace; margin: 0; line-height: 1.5; }

	/* Shared inputs/buttons */
	.ap-input {
		width: 100%; padding: 10px 12px; border-radius: 8px;
		background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);
		color: #fff; font-family: 'Space Mono', monospace; font-size: 13px;
		outline: none; transition: border-color 0.12s;
	}
	.ap-input:focus { border-color: rgba(0,210,255,0.3); }
	.ap-input::placeholder { color: #1e293b; }
	/* Asset picker button */
	.ap-asset-btn {
		display: flex; align-items: center; gap: 10px; width: 100%;
		padding: 10px 12px; border-radius: 10px; cursor: pointer;
		background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08);
		color: #e2e8f0; font-family: 'Space Mono', monospace; font-size: 13px;
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
	.ap-asset-bal { color: rgba(255,255,255,0.35); font-size: 11px; }
	.ap-asset-chevron { flex-shrink: 0; color: rgba(255,255,255,0.3); }

	/* Asset picker modal — contained within wallet panel */
	.ap-picker-overlay {
		position: absolute; inset: 0; z-index: 10;
		background: rgba(0,0,0,0.5); backdrop-filter: blur(4px);
		display: flex; align-items: flex-end; justify-content: center;
		border-radius: inherit;
	}
	.ap-picker {
		background: #0d1117; border-top: 1px solid rgba(255,255,255,0.08);
		border-radius: 16px 16px 0 0; width: 100%;
		max-height: 70%; display: flex; flex-direction: column;
		animation: slideUp 0.2s ease-out;
	}
	@keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
	.ap-picker-header {
		display: flex; justify-content: space-between; align-items: center;
		padding: 16px 16px 12px; border-bottom: 1px solid rgba(255,255,255,0.06);
	}
	.ap-picker-title { font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 700; color: white; }
	.ap-picker-close { background: none; border: none; color: rgba(255,255,255,0.4); cursor: pointer; padding: 4px; border-radius: 6px; }
	.ap-picker-close:hover { color: white; background: rgba(255,255,255,0.06); }
	.ap-picker-list { overflow-y: auto; padding: 8px; }
	.ap-picker-item {
		display: flex; align-items: center; gap: 10px; width: 100%;
		padding: 10px 8px; border-radius: 10px; cursor: pointer;
		background: none; border: none; color: #e2e8f0;
		font-family: 'Space Mono', monospace; transition: background 0.1s;
	}
	.ap-picker-item:hover { background: rgba(255,255,255,0.04); }
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
	.ap-picker-name { font-size: 10px; color: rgba(255,255,255,0.3); }
	.ap-picker-right { display: flex; flex-direction: column; align-items: flex-end; gap: 1px; }
	.ap-picker-bal { font-size: 12px; color: rgba(255,255,255,0.4); font-family: 'Space Mono', monospace; }
	.ap-picker-usd { font-size: 10px; color: #374151; font-family: 'Rajdhani', sans-serif; font-variant-numeric: tabular-nums; }
	.ap-send-estimate { font-family: 'Rajdhani', sans-serif; font-size: 13px; color: #475569; margin: -4px 0 4px; font-variant-numeric: tabular-nums; }

	/* To input with book button */
	.ap-to-wrap { position: relative; }
	.ap-book-btn {
		position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
		width: 28px; height: 28px; border-radius: 6px;
		border: none; background: rgba(255,255,255,0.05);
		color: #475569; cursor: pointer; transition: all 0.15s;
		display: flex; align-items: center; justify-content: center;
	}
	.ap-book-btn:hover { color: #00d2ff; background: rgba(0,210,255,0.1); }

	/* Contact book modal */
	.ap-book-overlay {
		position: absolute; inset: 0; z-index: 20;
		background: rgba(0,0,0,0.5); backdrop-filter: blur(2px);
		display: flex; align-items: center; justify-content: center; padding: 20px;
	}
	.ap-book-modal {
		width: 100%; max-width: 320px; border-radius: 14px;
		background: var(--bg, #07070d); border: 1px solid rgba(255,255,255,0.08);
		box-shadow: 0 16px 48px rgba(0,0,0,0.4); overflow: hidden;
	}
	.ap-book-header {
		display: flex; align-items: center; justify-content: space-between;
		padding: 14px 16px; border-bottom: 1px solid rgba(255,255,255,0.06);
	}
	.ap-book-title { font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 700; color: #fff; }
	.ap-book-close {
		width: 28px; height: 28px; border-radius: 6px; border: none;
		background: rgba(255,255,255,0.05); color: #64748b;
		display: flex; align-items: center; justify-content: center; cursor: pointer;
	}
	.ap-book-close:hover { background: rgba(255,255,255,0.1); color: #fff; }
	.ap-book-item {
		display: flex; align-items: center; gap: 10px; width: 100%;
		padding: 12px 16px; border: none; background: transparent;
		cursor: pointer; transition: background 0.12s; color: inherit;
	}
	.ap-book-item:hover { background: rgba(0,210,255,0.05); }
	.ap-book-avatar {
		width: 32px; height: 32px; border-radius: 50%; flex-shrink: 0;
		background: linear-gradient(135deg, rgba(0,210,255,0.15), rgba(139,92,246,0.15));
		border: 1px solid rgba(0,210,255,0.2);
		display: flex; align-items: center; justify-content: center;
		font-family: 'Syne', sans-serif; font-size: 12px; font-weight: 800; color: #00d2ff;
	}
	.ap-book-info { flex: 1; min-width: 0; text-align: left; }
	.ap-book-name { display: block; font-family: 'Syne', sans-serif; font-size: 13px; font-weight: 600; color: #e2e8f0; }
	.ap-book-addr { display: block; font-family: 'Space Mono', monospace; font-size: 9px; color: #475569; }
	.ap-book-bal { font-family: 'Rajdhani', sans-serif; font-size: 12px; color: #374151; font-variant-numeric: tabular-nums; flex-shrink: 0; }
	.ap-btn {
		padding: 10px 16px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.06);
		background: rgba(255,255,255,0.03); color: #94a3b8; cursor: pointer;
		font-family: 'Space Mono', monospace; font-size: 11px; transition: all 0.12s;
	}
	.ap-btn:hover { background: rgba(255,255,255,0.06); color: #fff; }
	.ap-btn-s { padding: 6px 10px; font-size: 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.06); background: rgba(255,255,255,0.03); color: #94a3b8; cursor: pointer; font-family: 'Space Mono', monospace; transition: all 0.12s; }
	.ap-btn-s:hover { background: rgba(255,255,255,0.06); color: #fff; }
	.ap-btn-primary { background: linear-gradient(135deg, #00d2ff, #3a7bd5); border: none; color: white; font-family: 'Syne', sans-serif; font-weight: 700; }
	.ap-btn-primary:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(0,210,255,0.2); }
	.ap-btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
	.ap-btn-danger { background: rgba(248,113,113,0.1); border: 1px solid rgba(248,113,113,0.2); color: #f87171; font-family: 'Syne', sans-serif; font-weight: 700; }
	.ap-btn-danger:hover { background: rgba(248,113,113,0.15); }
	.ap-btn-full { width: 100%; }
</style>
