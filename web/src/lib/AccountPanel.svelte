<script lang="ts">
	import { goto } from '$app/navigation';
	import { ethers } from 'ethers';
	import { shortAddr } from '$lib/formatters';
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
	import SecretRevealSheet from './SecretRevealSheet.svelte';
	import AnimatedNumber from './AnimatedNumber.svelte';
	import { getKnownLogo, resolveTokenLogo } from './tokenLogo';
	import { balanceState } from './balancePoller';
	import type { WsProviderManager, EventSubscription } from './wsProvider';
	import { transferFilter, transferFromFilter } from './wsProvider';
	import { queryTradeLens } from './tradeLens';
	import { friendlyError } from './errorDecoder';
	import QrCode from './QrCode.svelte';
	import { t } from '$lib/i18n';
	import { ERC20Contract } from './tokenCrafter';
	import { userTokens, addUserToken, updateUserToken, removeUserToken, type UserToken } from './userTokens';
	import { hiddenAssets, toggleHidden } from './hiddenAssets';
	import { hideDust, DUST_USD_THRESHOLD } from './hideDust';
	import AssetSettingsModal from './AssetSettingsModal.svelte';
	import RowActionSheet from './RowActionSheet.svelte';
	import type { SupportedNetwork } from './structure';
	import { hasPasskey, isPasskeySupported, setupPasskey, disablePasskey } from './passkey';

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
		wsManager = null as WsProviderManager | null,
		sharedProviders = null as Map<number, ethers.JsonRpcProvider> | null,
		supportedNetworks = [] as SupportedNetwork[],
		onTotalUsdChange = (_v: number) => {},
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
		wsManager?: WsProviderManager | null;
		sharedProviders?: Map<number, ethers.JsonRpcProvider> | null;
		supportedNetworks?: SupportedNetwork[];
		onTotalUsdChange?: (v: number) => void;
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
		const hidden = $hiddenAssets;
		for (const t of tokens) {
			if (hidden.includes(t.address.toLowerCase())) continue;
			if (t.priceUsd) total += parseFloat(ethers.formatUnits(t.balance, t.decimals)) * t.priceUsd;
		}
		for (const t of importedTokens) {
			if (hidden.includes(t.address.toLowerCase())) continue;
			if (t.priceUsd && t.balance > 0n) total += parseFloat(ethers.formatUnits(t.balance, t.decimals)) * t.priceUsd;
		}
		return total;
	});

	// Total portfolio in native coin equivalent
	let totalNativeEquiv = $derived(nativePriceUsd > 0 ? totalUsd / nativePriceUsd : 0);

	// Push the total upstream so the nav wallet chip can render it. Keeps
	// the canonical USD math here in the panel where balances + prices
	// already live.
	$effect(() => { onTotalUsdChange(totalUsd); });

	// Pinned stablecoin addresses (always shown, even with zero balance)
	let pinnedStableAddrs = $derived.by(() => {
		const set = new Set<string>();
		if (usdtAddress) set.add(usdtAddress.toLowerCase());
		if (usdcAddress) set.add(usdcAddress.toLowerCase());
		return set;
	});

	// Pinned stablecoin rows — rendered right after native coin, always visible.
	// Hidden ones move to the "hidden" section at the bottom.
	let pinnedStables = $derived.by(() => {
		const rows: { address: string; symbol: string; name: string; balance: bigint; decimals: number; priceUsd?: number; logoUrl?: string; _bal: number; _usd: number }[] = [];
		const addEntry = (addr: string, symbol: string, name: string) => {
			if (!addr) return;
			const lower = addr.toLowerCase();
			if ($hiddenAssets.includes(lower)) return;
			const match = [...tokens, ...importedTokens].find(t => t.address.toLowerCase() === lower);
			const decimals = match?.decimals ?? 18;
			const balance = match?.balance ?? 0n;
			const priceUsd = match?.priceUsd ?? 1; // stablecoins peg ≈ $1
			const bal = parseFloat(ethers.formatUnits(balance, decimals));
			rows.push({
				address: lower,
				symbol: match?.symbol || symbol,
				name: match?.name || name,
				balance, decimals, priceUsd,
				logoUrl: (match as any)?.logoUrl || '',
				_bal: bal,
				_usd: bal * priceUsd,
			});
		};
		addEntry(usdtAddress, 'USDT', 'Tether USD');
		addEntry(usdcAddress, 'USDC', 'USD Coin');
		return rows;
	});

	// All displayable tokens sorted by USD value (highest first, hide zero balance)
	// Excludes pinned stablecoins and user-hidden assets. When hideDust is on,
	// also filters out priced tokens worth less than DUST_USD_THRESHOLD — but
	// only when we have a price (otherwise we'd hide every freshly imported
	// token until prices populate). Unpriced rows still surface so users can
	// see them; the dust gate strictly relies on a positive USD value.
	let sortedTokens = $derived.by(() => {
		const dust = $hideDust;
		const all = [...tokens, ...importedTokens]
			.filter(t => t.balance > 0n && !pinnedStableAddrs.has(t.address.toLowerCase()) && !$hiddenAssets.includes(t.address.toLowerCase()))
			.map(t => {
				const bal = parseFloat(ethers.formatUnits(t.balance, t.decimals));
				const usd = t.priceUsd ? bal * t.priceUsd : 0;
				return { ...t, _bal: bal, _usd: usd };
			})
			.filter(t => !(dust && t.priceUsd && t._usd < DUST_USD_THRESHOLD));
		return all.sort((a, b) => b._usd - a._usd);
	});

	// Hidden assets — shown in a collapsible section so users can unhide.
	let hiddenRows = $derived.by(() => {
		const out: { address: string; symbol: string; name: string; balance: bigint; decimals: number; priceUsd?: number; logoUrl?: string; _bal: number; _usd: number }[] = [];
		const seen = new Set<string>();
		const addRow = (addr: string, fallbackSymbol: string, fallbackName: string) => {
			const lower = addr.toLowerCase();
			if (!$hiddenAssets.includes(lower) || seen.has(lower)) return;
			seen.add(lower);
			const match = [...tokens, ...importedTokens].find(t => t.address.toLowerCase() === lower);
			const decimals = match?.decimals ?? 18;
			const balance = match?.balance ?? 0n;
			const priceUsd = match?.priceUsd ?? 0;
			const bal = parseFloat(ethers.formatUnits(balance, decimals));
			out.push({
				address: lower,
				symbol: match?.symbol || fallbackSymbol,
				name: match?.name || fallbackName,
				balance, decimals, priceUsd,
				logoUrl: (match as any)?.logoUrl || '',
				_bal: bal,
				_usd: bal * priceUsd,
			});
		};
		if (usdtAddress) addRow(usdtAddress, 'USDT', 'Tether USD');
		if (usdcAddress) addRow(usdcAddress, 'USDC', 'USD Coin');
		for (const t of [...tokens, ...importedTokens]) addRow(t.address, t.symbol, t.name);
		return out;
	});

	// ── UI state ──
	// 'export-key' / 'export-seed' used to be inline views; they're now
	// rendered by SecretRevealSheet (80vh bottom-up modal with an ack
	// list, PIN gate, and long-press reveal + QR). Kept as legacy values
	// for the type alias so any deprecated references still compile.
	type View = 'main' | 'receive' | 'security' | 'export-key' | 'export-seed';
	let view = $state<View>('main');
	let showSecretSheet = $state(false);
	let secretSheetKind = $state<'seed' | 'key'>('seed');
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

	// Passkey enable/disable. Reactive to walletState so the toggle reflects
	// the freshest registration status (e.g. after an enable round trip).
	let passkeyEnabled = $derived.by(() => {
		const uid = walletState?.userId;
		return !!uid && hasPasskey(uid);
	});
	let passkeyPin = $state('');
	let passkeyEnabling = $state(false);
	let passkeyError = $state('');
	let passkeyShowPin = $state(false);

	async function enablePasskey() {
		passkeyError = '';
		const uid = walletState?.userId;
		const email = walletState?.email || 'wallet@tokenkrafter.com';
		if (!uid) { passkeyError = 'No active session'; return; }
		if (!passkeyPin) { passkeyError = 'Enter your PIN to confirm'; return; }
		if (!(await unlockWallet(passkeyPin))) {
			passkeyError = 'Wrong PIN';
			return;
		}
		passkeyEnabling = true;
		const r = await setupPasskey({
			userId: uid,
			userEmail: email,
			displayName: email.split('@')[0] || 'TokenKrafter user',
			pin: passkeyPin,
		});
		passkeyEnabling = false;
		if (!r.ok) {
			passkeyError = r.reason;
			return;
		}
		passkeyPin = '';
		passkeyShowPin = false;
		onAddFeedback({ message: 'Passkey enabled — unlock with FaceID/TouchID next time', type: 'success' });
	}

	function disablePasskeyForUser() {
		const uid = walletState?.userId;
		if (!uid) return;
		disablePasskey(uid);
		onAddFeedback({ message: 'Passkey disabled', type: 'success' });
	}

	// Send
	let sendTo = $state('');
	let sendAmount = $state('');
	let sending = $state(false);
	let sendAsset = $state<'native' | string>('native'); // 'native' or token address
	// MAX-send state for native: when user clicks MAX we both deduct
	// the exact gas estimate (no safety margin → no dust) AND lock the
	// gasPrice we used. At submit time we pass that gasPrice + a fixed
	// 21,000 gasLimit explicitly so the tx drains the wallet to zero.
	// Without locking, a between-click-and-submit gas spike would leave
	// the tx underfunded; without explicit gasLimit, ethers' default
	// estimateGas could pick a higher number than we reserved for.
	let sendingMax = $state(false);
	let maxLockedGasPrice = $state<bigint | null>(null);
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
		return [...tokens, ...importedTokens, ...pinnedStables].find((t) => t.address?.toLowerCase() === target) || null;
	});

	let sendAssetInfo: { symbol: string; decimals: number; balance: bigint; priceUsd: number } = $derived.by(() => {
		if (sendAssetTok) {
			return {
				symbol: sendAssetTok.symbol || '???',
				decimals: sendAssetTok.decimals ?? 18,
				balance: sendAssetTok.balance ?? 0n,
				priceUsd: sendAssetTok.priceUsd || 0,
			};
		}
		return {
			symbol: nativeCoin || 'BNB',
			decimals: nativeDecimals || 18,
			balance: nativeBalance ?? 0n,
			priceUsd: nativePriceUsd || 0,
		};
	});

	// Preview derived values — lifted out of {@const} inside the
	// {#if sendStep === 'preview'} block because the block's local
	// deriveds were getting destroyed mid-flight during fly-out
	// transitions and throwing "$.get(...) is undefined".
	let previewUsd = $derived(parseFloat(sendAmount || '0') * (sendAssetInfo?.priceUsd || 0));
	let previewBookLabel = $derived(matchBookLabel(sendTo));

	// Asset-settings modal toggle (import + hide-dust + future filters)
	let showImport = $state(false);

	// Local runtime mirror of user tokens (adds balance/price on top of the
	// shared userTokens store). The store is the source of truth for which
	// tokens to show + their metadata; balances/prices are runtime state.
	let importedTokens = $state<{ address: string; symbol: string; name: string; balance: bigint; decimals: number; priceUsd?: number; logoUrl?: string }[]>([]);

	// On account switch, drop the runtime balance/price mirror. The
	// reconciler keys by token address, so without this reset USDT/USDC
	// rows on a freshly-switched-to account inherit the prior account's
	// balance until refreshTokenBalances finishes — exactly the "new
	// account shows tokens it doesn't own" bug.
	let _mirrorAddr = '';
	$effect(() => {
		if (userAddress !== _mirrorAddr) {
			_mirrorAddr = userAddress;
			importedTokens = [];
			autoImportDone = '';
			nativeBalance = 0n;
			nativePriceUsd = 0;
		}
	});

	// Reconcile local mirror with the shared store whenever the store changes.
	// Preserves existing balance/price for tokens already in the mirror —
	// reset above on userAddress change handles cross-account safety.
	$effect(() => {
		const chainList = $userTokens.filter(t => t.chainId === chainId);
		const byAddr = new Map(importedTokens.map(t => [t.address.toLowerCase(), t]));
		const next = chainList.map(st => {
			const existing = byAddr.get(st.address);
			return {
				address: st.address,
				symbol: st.symbol,
				name: st.name,
				decimals: st.decimals,
				logoUrl: st.logoUrl || existing?.logoUrl || '',
				balance: existing?.balance ?? 0n,
				priceUsd: existing?.priceUsd,
			};
		});
		// Only assign when the identity set changed, to avoid unnecessary churn.
		const changed = next.length !== importedTokens.length
			|| next.some((t, i) => t.address !== importedTokens[i].address
				|| t.symbol !== importedTokens[i].symbol
				|| t.logoUrl !== importedTokens[i].logoUrl);
		if (changed) importedTokens = next;
	});

	// Auto-import tokens the user created on the platform — persists to store
	// so they appear across all selectors (create, trade, launchpad, wallet).
	let autoImportDone = $state<string>('');
	async function autoImportCreatedTokens() {
		if (!userAddress || autoImportDone === userAddress) return;
		autoImportDone = userAddress;
		try {
			const res = await fetch(`/api/created-tokens?creator=${userAddress}&limit=50`);
			if (!res.ok) return;
			const rows = await res.json();
			if (!rows?.length) return;

			let added = false;
			for (const r of rows) {
				const addr = r.address?.toLowerCase();
				if (!addr) continue;
				const before = $userTokens.length;
				addUserToken({
					address: addr,
					symbol: r.symbol || '???',
					name: r.name || 'Unknown',
					decimals: r.decimals || 18,
					logoUrl: r.logo_url || '',
					chainId,
				});
				if ($userTokens.length !== before) added = true;
			}
			if (added && walletType === 'embedded') pushPreferences();
		} catch {}
	}

	// Auto-pin stablecoins (USDT / USDC) so they're queried for balances and
	// appear as payment options across all selectors.
	function autoPinStablecoins() {
		const pin = (addr: string, symbol: string, name: string) => {
			if (!addr) return;
			addUserToken({
				address: addr.toLowerCase(),
				symbol, name,
				decimals: 18,
				logoUrl: '',
				chainId,
			});
		};
		pin(usdtAddress, 'USDT', 'Tether USD');
		pin(usdcAddress, 'USDC', 'USD Coin');
	}

	// Refresh balances + auto-import when address changes
	$effect(() => {
		if (!userAddress) return;
		autoPinStablecoins();
		autoImportCreatedTokens();
		if (importedTokens.length === 0) return;
		refreshTokenBalances();
		// Fetch missing logos via shared cache → write back to store
		for (const tok of importedTokens) {
			if (!tok.logoUrl && tok.address) {
				resolveTokenLogo(tok.address, chainId).then(url => {
					if (url) updateUserToken(tok.address, chainId, { logoUrl: url });
				});
			}
		}
		// Self-heal placeholder names. Tokens that came in via the
		// indexer with empty symbol/name fields land in the store as
		// '???' / 'Unknown'. Re-query the chain to fix them so users
		// don't stare at "???" forever. Once-per-session — repeat
		// passes were thrashing the public RPC and competing with
		// in-flight tx broadcasts.
		if (!_healDoneFor.has(userAddress.toLowerCase())) {
			_healDoneFor.add(userAddress.toLowerCase());
			healPlaceholderTokens();
		}
	});

	let _healInFlight = new Set<string>();
	let _healDoneFor = new Set<string>();
	async function healPlaceholderTokens() {
		const provider = getProvider();
		if (!provider) return;
		for (const tok of importedTokens) {
			const needsSymbol = !tok.symbol || tok.symbol === '???';
			const needsName = !tok.name || tok.name === 'Unknown' || tok.name === tok.symbol;
			if (!needsSymbol && !needsName) continue;
			const key = `${chainId}:${tok.address.toLowerCase()}`;
			if (_healInFlight.has(key)) continue;
			_healInFlight.add(key);
			try {
				const erc20 = new ERC20Contract(tok.address, provider.provider);
				const meta = await erc20.getMetadata();
				const patch: { symbol?: string; name?: string } = {};
				if (needsSymbol && meta.symbol) patch.symbol = meta.symbol.slice(0, 32);
				if (needsName && meta.name) patch.name = meta.name.slice(0, 64);
				if (patch.symbol || patch.name) {
					updateUserToken(tok.address, chainId, patch);
				}
			} catch {}
			finally {
				_healInFlight.delete(key);
			}
		}
	}

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

	// Prefer the shared, warmed provider from the layout's networkProviders
	// map (already has staticNetwork: true + connection pooling). Falling
	// back to a fresh JsonRpcProvider is risky — without staticNetwork the
	// first call hangs on chain-id auto-detect, which is what makes
	// "send is stuck" + "balance not detected" appear after a burst of
	// RPC calls on wallet-connect. The shared provider is already ready.
	function getProvider(): { provider: ethers.JsonRpcProvider } | null {
		const shared = sharedProviders?.get?.(chainId);
		if (shared) return { provider: shared };
		try {
			return { provider: new ethers.JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true }) };
		} catch {
			return null;
		}
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

	// WS-driven portfolio refresh when panel is open, with polling fallback
	let _panelSubs: EventSubscription[] = [];
	let _panelDebounce: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		if (!open || !userAddress || !dexRouter || showSwitcher) return;
		refreshTokenBalances();

		for (const s of _panelSubs) s.unsubscribe();
		_panelSubs = [];

		let interval: ReturnType<typeof setInterval>;

		if (wsManager) {
			const inSub = wsManager.subscribeLogs(chainId, transferFilter(userAddress), () => {
				if (_panelDebounce) clearTimeout(_panelDebounce);
				_panelDebounce = setTimeout(() => { _panelDebounce = null; refreshTokenBalances(); }, 500);
			});
			_panelSubs.push(inSub);
			const outSub = wsManager.subscribeLogs(chainId, transferFromFilter(userAddress), () => {
				if (_panelDebounce) clearTimeout(_panelDebounce);
				_panelDebounce = setTimeout(() => { _panelDebounce = null; refreshTokenBalances(); }, 500);
			});
			_panelSubs.push(outSub);
			interval = setInterval(refreshTokenBalances, 120_000);
		} else {
			interval = setInterval(refreshTokenBalances, 10000);
		}

		return () => {
			clearInterval(interval);
			if (_panelDebounce) { clearTimeout(_panelDebounce); _panelDebounce = null; }
			for (const s of _panelSubs) s.unsubscribe();
			_panelSubs = [];
		};
	});

	// ── Long-press → action sheet ──
	// Press-and-hold a token row for LONG_PRESS_MS opens RowActionSheet
	// (Hide / Delete / Cancel). Movement >LONG_PRESS_TOL_PX cancels so
	// scroll-drags don't trigger the sheet. No on-row progress UI — the
	// haptic + sheet appearance is the feedback.
	const LONG_PRESS_MS = 500;
	const LONG_PRESS_TOL_PX = 8;
	let _lpTimer: ReturnType<typeof setTimeout> | null = null;
	let _lpStart: { x: number; y: number } | null = null;
	let _lpToken: { address: string; symbol: string; name: string; logoUrl?: string } | null = null;
	// Reactive flag for the "currently being held" row — drives a subtle
	// scale-down so users know their hold registered before the sheet pops.
	let longPressKey = $state<string | null>(null);

	let showRowSheet = $state(false);
	let rowSheetToken = $state<{ address: string; symbol: string; name: string; logoUrl?: string } | null>(null);

	function _lpClear() {
		if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; }
		_lpStart = null;
		longPressKey = null;
	}

	function lpStart(rowKey: string, tok: { address: string; symbol: string; name: string; logoUrl?: string }, e: PointerEvent) {
		if (e.button && e.button !== 0) return;
		_lpClear();
		_lpToken = tok;
		_lpStart = { x: e.clientX, y: e.clientY };
		longPressKey = rowKey;
		_lpTimer = setTimeout(() => {
			_lpTimer = null;
			longPressKey = null;
			try { (navigator as any).vibrate?.(15); } catch {}
			rowSheetToken = _lpToken;
			showRowSheet = true;
		}, LONG_PRESS_MS);
	}

	function lpMove(e: PointerEvent) {
		if (!_lpStart) return;
		const dx = e.clientX - _lpStart.x;
		const dy = e.clientY - _lpStart.y;
		if (dx * dx + dy * dy > LONG_PRESS_TOL_PX * LONG_PRESS_TOL_PX) _lpClear();
	}

	function lpEnd() { _lpClear(); }

	// Desktop right-click → same action sheet as mobile long-press. Mirrors
	// the WalletSwitcher's ctxWallet / ctxAccount handlers so the
	// interaction feels consistent across asset rows, wallets and accounts.
	function ctxToken(tok: { address: string; symbol: string; name: string; logoUrl?: string }, e: MouseEvent) {
		e.preventDefault();
		_lpClear();
		rowSheetToken = tok;
		showRowSheet = true;
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
		sendingMax = false;
		maxLockedGasPrice = null;
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
		// Allow 0 — useful for "ping" txs (e.g. activating an account, calling
		// a contract with no value) and matches Trust Wallet behaviour.
		if (isNaN(amt) || amt < 0) { onAddFeedback({ message: 'Invalid amount', type: 'error' }); return; }

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
				// MAX-send path: pin gasLimit + gasPrice to the exact
				// values used to compute the reserve so the tx drains
				// to zero. Anything else (ethers picking a fresh
				// gasPrice or higher gasLimit) would either underfund
				// the tx or leave dust.
				const txReq: ethers.TransactionRequest = {
					to: sendTo,
					value: ethers.parseUnits(sanitized, nativeDecimals),
				};
				if (sendingMax && maxLockedGasPrice && maxLockedGasPrice > 0n) {
					txReq.gasLimit = 21000n;
					txReq.gasPrice = maxLockedGasPrice;
				}
				const tx = await wallet.sendTransaction(txReq);
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
		return fmtBalNumber(v);
	}

	/** Number-flavored variant of fmtBal — used by AnimatedNumber whose
	 *  tween runs in number-space (so we can't reach for the original wei). */
	function fmtBalNumber(v: number): string {
		if (!isFinite(v) || v === 0) return '0';
		const abs = Math.abs(v);
		if (abs >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
		if (abs >= 1) return v.toFixed(4);
		if (abs >= 0.0001) return v.toFixed(6);
		if (abs >= 0.00000001) return v.toFixed(8).replace(/\.?0+$/, '');
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
<div class="absolute inset-0 z-[9998] bg-black/60 backdrop-blur-[3px]" onclick={close} role="presentation"></div>

<div class="ap" class:ap-closing={!open} role="dialog" aria-label="Account panel">
	<!-- ═══ HEADER ═══ -->
	<div class="flex items-center gap-2 pt-3.5 px-4 pb-2.5 relative min-h-[52px]">
		{#if view !== 'main'}
			<button aria-label="Back" class="w-[30px] h-[30px] rounded-lg border-none bg-(--bg-surface-input) text-(--text-muted) cursor-pointer flex items-center justify-center transition-all duration-100 shrink-0 hover:bg-(--bg-surface-hover) hover:text-(--text-heading)" onclick={() => { view = 'main'; resetExport(); }}>
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
			</button>
			<span class="font-display text-sm font-bold text-(--text) flex-1">
				{view === 'receive' ? $t('account.receive') : view === 'security' ? $t('account.security') : view === 'export-key' ? $t('account.privateKey') : $t('account.recoveryPhrase')}
			</span>
		{:else}
			<!-- Unified wallet+account chip — opens WalletSwitcher sheet -->
			<button class="flex items-center gap-2.5 flex-1 min-w-0 bg-(--bg-surface) border border-(--border) rounded-[10px] py-[7px] px-3 cursor-pointer text-inherit font-inherit transition-colors duration-150 hover:border-[rgba(0,210,255,0.25)] hover:bg-[rgba(0,210,255,0.04)]" onclick={() => { showSwitcher = true; }}>
				<div class="w-7 h-7 rounded-full shrink-0 bg-gradient-to-br from-[rgba(0,210,255,0.16)] to-[rgba(58,123,213,0.16)] border border-[rgba(0,210,255,0.25)] flex items-center justify-center font-display text-xs2 font-extrabold text-[#00d2ff]">
					{#if walletType === 'embedded'}
						{#if acctAvatar(activeIndex)}
							<span class="text-15 leading-none">{acctAvatar(activeIndex)}</span>
						{:else}
							{activeIndex + 1}
						{/if}
					{:else}
						◆
					{/if}
				</div>
				<div class="flex-1 min-w-0 flex flex-col gap-px overflow-hidden">
					<span class="flex items-center gap-[5px] min-w-0 font-display text-xs2 font-bold text-(--text) whitespace-nowrap overflow-hidden text-ellipsis">
						{#if walletType === 'embedded' && activeWallet}
							<span class="text-(--text)">{activeWallet.name}</span>
							<span class="text-(--text-dim)">•</span>
							<span class="text-(--text-muted) font-semibold">{acctName(activeIndex)}</span>
						{:else}
							{$t('account.externalWallet')}
						{/if}
					</span>
					<span class="font-mono text-4xs text-(--text-dim)">{shortAddr(userAddress)}</span>
				</div>
				<svg class="text-(--text-dim) shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
			</button>
		{/if}

		<button aria-label="Close" class="w-7 h-7 rounded-lg border-none bg-(--bg-surface-input) text-(--text-dim) cursor-pointer flex items-center justify-center transition-all duration-100 shrink-0 ml-auto hover:bg-(--bg-surface-hover) hover:text-(--text-heading)" onclick={close}>
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
			onExportSeed={() => { secretSheetKind = 'seed'; showSecretSheet = true; }}
			onExportKey={() => { secretSheetKind = 'key'; showSecretSheet = true; }}
			onDisconnect={onDisconnect}
			onLock={() => { close(); }}
			onAccountMetaChanged={bumpMeta}
		/>
	{/if}

	<!-- ═══ MAIN VIEW ═══ -->
	{#if view === 'main'}
		<!-- Network -->
		<div class="flex items-center gap-[5px] px-4 pb-1 text-xs4 text-(--text-dim) font-mono"><span class="w-[5px] h-[5px] rounded-full bg-[#10b981]"></span>{networkName}</div>

		<!-- Balance -->
		<div class="ap-bal text-center pt-4 px-4 pb-5">
			<span class="ap-bal-total block font-numeric font-bold text-(--text-heading) leading-[1.1] tabular-nums tracking-[-0.02em] max-w-full overflow-hidden text-ellipsis whitespace-nowrap"><AnimatedNumber value={totalUsd} format={fmtUsd} duration={400} />{#if portfolioLoading && totalUsd === 0} <span class="text-2xl text-(--text-dim) animate-[blink_1s_infinite]">...</span>{/if}</span>
			<span class="block font-numeric text-base font-medium text-(--text-muted) mt-1.5 tabular-nums max-w-full overflow-hidden text-ellipsis whitespace-nowrap px-2">
				{#if totalNativeEquiv > 0}
					≈ <AnimatedNumber value={totalNativeEquiv} decimals={2} suffix={' ' + nativeCoin} duration={400} />
				{:else}
					<AnimatedNumber value={nativeBalFormatted} format={fmtBalNumber} suffix={' ' + nativeCoin} duration={400} />
				{/if}
			</span>
		</div>

		<!-- Actions -->
		<div class="flex justify-center gap-[18px] px-4 pb-3.5">
			<button class="group/act flex flex-col items-center gap-[5px] bg-none border-none cursor-pointer text-(--text-muted) font-mono text-xs4 transition-colors duration-100 hover:text-[#00d2ff]" onclick={() => { close(); goto('/trade'); }}>
				<div class="w-10 h-10 rounded-full bg-[rgba(0,210,255,0.05)] border border-[rgba(0,210,255,0.1)] flex items-center justify-center transition-all duration-150 group-hover/act:bg-[rgba(0,210,255,0.1)] group-hover/act:border-[rgba(0,210,255,0.25)] group-hover/act:-translate-y-0.5 group-hover/act:shadow-[0_4px_12px_rgba(0,210,255,0.1)]"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg></div>
				<span>{$t('account.buy')}</span>
			</button>
			<button class="group/act flex flex-col items-center gap-[5px] bg-none border-none cursor-pointer text-(--text-muted) font-mono text-xs4 transition-colors duration-100 hover:text-[#00d2ff]" onclick={() => showSend = true}>
				<div class="w-10 h-10 rounded-full bg-[rgba(0,210,255,0.05)] border border-[rgba(0,210,255,0.1)] flex items-center justify-center transition-all duration-150 group-hover/act:bg-[rgba(0,210,255,0.1)] group-hover/act:border-[rgba(0,210,255,0.25)] group-hover/act:-translate-y-0.5 group-hover/act:shadow-[0_4px_12px_rgba(0,210,255,0.1)]"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg></div>
				<span>{$t('account.send')}</span>
			</button>
			<button class="group/act flex flex-col items-center gap-[5px] bg-none border-none cursor-pointer text-(--text-muted) font-mono text-xs4 transition-colors duration-100 hover:text-[#00d2ff]" onclick={() => view = 'receive'}>
				<div class="w-10 h-10 rounded-full bg-[rgba(0,210,255,0.05)] border border-[rgba(0,210,255,0.1)] flex items-center justify-center transition-all duration-150 group-hover/act:bg-[rgba(0,210,255,0.1)] group-hover/act:border-[rgba(0,210,255,0.25)] group-hover/act:-translate-y-0.5 group-hover/act:shadow-[0_4px_12px_rgba(0,210,255,0.1)]"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg></div>
				<span>{$t('account.receive')}</span>
			</button>
			<button class="group/act flex flex-col items-center gap-[5px] bg-none border-none cursor-pointer text-(--text-muted) font-mono text-xs4 transition-colors duration-100 hover:text-[#00d2ff]" onclick={() => { close(); goto('/trade'); }}>
				<div class="w-10 h-10 rounded-full bg-[rgba(0,210,255,0.05)] border border-[rgba(0,210,255,0.1)] flex items-center justify-center transition-all duration-150 group-hover/act:bg-[rgba(0,210,255,0.1)] group-hover/act:border-[rgba(0,210,255,0.25)] group-hover/act:-translate-y-0.5 group-hover/act:shadow-[0_4px_12px_rgba(0,210,255,0.1)]"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg></div>
				<span>{$t('account.swap')}</span>
			</button>
		</div>

		<!-- Empty-state CTA: shown the first time a user opens an empty wallet.
		     Replaces the "navigate away to /trade" friction with a one-tap path
		     to the receive view + native faucet hint. -->
		{#if totalUsd === 0 && nativeBalance === 0n && sortedTokens.length === 0 && !portfolioLoading}
			<div class="flex flex-col gap-2.5 mx-4 mb-3 p-4 bg-gradient-to-br from-[rgba(0,210,255,0.06)] to-[rgba(58,123,213,0.04)] border border-[rgba(0,210,255,0.18)] rounded-xl">
				<div class="w-[38px] h-[38px] rounded-full bg-[rgba(0,210,255,0.12)] border border-[rgba(0,210,255,0.25)] flex items-center justify-center text-[#00d2ff]">
					<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>
				</div>
				<div>
					<strong class="block font-display text-13 text-(--text-heading) mb-[3px]">{$t('account.fundWallet')}</strong>
					<p class="m-0 font-mono text-3xs text-(--text-muted) leading-[1.5]">Receive {nativeCoin}, USDT or any token on {networkName} at your address.</p>
				</div>
				<div class="flex gap-2">
					<button class="ap-btn ap-btn-primary flex-1 px-2.5 py-2 text-3xs" onclick={() => view = 'receive'}>{$t('account.showAddress')}</button>
					<button class="ap-btn flex-1 px-2.5 py-2 text-3xs" onclick={() => { close(); goto('/trade'); }}>{$t('account.buyWithCard')}</button>
				</div>
			</div>
		{/if}

		<!-- Assets header with settings/import icon on the right -->
		<div class="pt-2 px-4 pb-1 flex items-center justify-between gap-2">
			<span class="font-display text-xs font-bold text-(--text-dim) uppercase tracking-[0.04em]">{$t('account.assets')}</span>
			<button
				type="button"
				class="p-1.5 rounded-lg text-(--text-dim) transition-all hover:text-(--text-heading) hover:bg-(--bg-surface-hover)"
				onclick={() => (showImport = true)}
				aria-label="Asset settings — import token, hide small balances"
				title="Asset settings"
			>
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
			</button>
		</div>

		{#if true}
			{@const nativeCompact = compactRows.has('native')}
			<div class="flex-1 overflow-y-auto overflow-x-hidden py-1.5">
				<!-- Native -->
				<div class="flex items-center gap-3 py-3 px-4 transition-colors duration-100 hover:bg-(--bg-surface)">
					{#if getKnownLogo(nativeCoin)}
						<img src={getKnownLogo(nativeCoin)} alt={nativeCoin} class="w-10 h-10 rounded-full object-cover shrink-0 border border-(--border)" />
					{:else}
						<div class="w-10 h-10 rounded-full bg-[rgba(245,158,11,0.08)] border border-[rgba(245,158,11,0.15)] flex items-center justify-center font-display text-sm font-extrabold text-[#f59e0b] shrink-0">{nativeCoin.charAt(0)}</div>
					{/if}
					<div class="flex-1 min-w-0">
						<span class="block text-base text-(--text-heading) font-display font-bold leading-[1.3]">{nativeCoin}</span>
						<span class="block text-xs text-(--text-dim) font-mono mt-0.5">{$t('account.native')}</span>
					</div>
					<button class="ap-row-right" type="button" onclick={() => toggleRowCompact('native')} title={nativeCompact ? 'Tap to expand' : 'Tap to shrink'}>
						<span class="block text-base text-(--text-heading) font-numeric font-bold tabular-nums leading-[1.3] max-w-full overflow-hidden text-ellipsis whitespace-nowrap"><AnimatedNumber value={nativeBalFormatted} format={fmtBalNumber} duration={400} /></span>
						<span class="block text-13 text-(--text-dim) font-numeric font-medium tabular-nums mt-0.5 max-w-full overflow-hidden text-ellipsis whitespace-nowrap"><AnimatedNumber value={nativeUsd} format={nativeCompact ? fmtCompactUsd : fmtUsd} duration={400} /></span>
					</button>
				</div>

				<!-- Pinned stablecoins (always visible, even with zero balance) -->
				{#each pinnedStables as tok}
					{@const logo = getTokenLogo(tok as any) || getKnownLogo(tok.symbol)}
					{@const rowKey = tok.address}
					{@const isCompact = compactRows.has(rowKey)}
					<div
						class="ap-row group relative flex items-center gap-3 py-3 px-4 transition-colors duration-100 hover:bg-(--bg-surface)"
						class:ap-pressing={longPressKey === rowKey}
						onpointerdown={(e) => lpStart(rowKey, { address: tok.address, symbol: tok.symbol, name: tok.name, logoUrl: tok.logoUrl }, e)}
						onpointermove={lpMove}
						onpointerup={lpEnd}
						onpointercancel={lpEnd}
						onpointerleave={lpEnd}
						oncontextmenu={(e) => ctxToken({ address: tok.address, symbol: tok.symbol, name: tok.name, logoUrl: tok.logoUrl }, e)}
					>
						{#if logo}
							<img src={logo} alt={tok.symbol} class="w-10 h-10 rounded-full object-cover shrink-0 border border-(--border)" />
						{:else}
							<div class="w-10 h-10 rounded-full bg-(--bg-surface-input) border border-(--border) flex items-center justify-center font-display text-sm font-extrabold text-(--text-muted) shrink-0">{tok.symbol.charAt(0)}</div>
						{/if}
						<div class="flex-1 min-w-0">
							<span class="block text-base text-(--text-heading) font-display font-bold leading-[1.3]">{tok.symbol}</span>
							<span class="block text-xs text-(--text-dim) font-mono mt-0.5">{tok.name}</span>
						</div>
						<button class="ap-row-right" type="button" onclick={() => toggleRowCompact(rowKey)} title={isCompact ? 'Tap to expand' : 'Tap to shrink'}>
							<span class="block text-base text-(--text-heading) font-numeric font-bold tabular-nums leading-[1.3] max-w-full overflow-hidden text-ellipsis whitespace-nowrap"><AnimatedNumber value={tok._bal} format={isCompact ? fmtCompactAmount : fmtBalNumber} duration={400} /></span>
							<span class="block text-13 text-(--text-dim) font-numeric font-medium tabular-nums mt-0.5 max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{#if tok._usd > 0}<AnimatedNumber value={tok._usd} format={isCompact ? fmtCompactUsd : fmtUsd} duration={400} />{/if}</span>
						</button>
					</div>
				{/each}

				<!-- Tokens sorted by USD value -->
				{#each sortedTokens as tok}
					{@const usd = tok._usd}
					{@const logo = getTokenLogo(tok)}
					{@const rowKey = (tok.address || tok.symbol).toLowerCase()}
					{@const isCompact = compactRows.has(rowKey)}
					<div
						class="ap-row group relative flex items-center gap-3 py-3 px-4 transition-colors duration-100 hover:bg-(--bg-surface)"
						class:ap-pressing={longPressKey === rowKey}
						onpointerdown={(e) => lpStart(rowKey, { address: tok.address, symbol: tok.symbol, name: tok.name, logoUrl: (tok as any).logoUrl }, e)}
						onpointermove={lpMove}
						onpointerup={lpEnd}
						onpointercancel={lpEnd}
						onpointerleave={lpEnd}
						oncontextmenu={(e) => ctxToken({ address: tok.address, symbol: tok.symbol, name: tok.name, logoUrl: (tok as any).logoUrl }, e)}
					>
					{#if logo}
						<img src={logo} alt={tok.symbol} class="w-10 h-10 rounded-full object-cover shrink-0 border border-(--border)" />
					{:else}
						<div class="w-10 h-10 rounded-full bg-(--bg-surface-input) border border-(--border) flex items-center justify-center font-display text-sm font-extrabold text-(--text-muted) shrink-0">{tok.symbol.charAt(0)}</div>
					{/if}
						<div class="flex-1 min-w-0">
							<span class="block text-base text-(--text-heading) font-display font-bold leading-[1.3]">{tok.symbol}</span>
							<span class="block text-xs text-(--text-dim) font-mono mt-0.5">{tok.name}</span>
						</div>
						<button class="ap-row-right" type="button" onclick={() => toggleRowCompact(rowKey)} title={isCompact ? 'Tap to expand' : 'Tap to shrink'}>
							<span class="block text-base text-(--text-heading) font-numeric font-bold tabular-nums leading-[1.3] max-w-full overflow-hidden text-ellipsis whitespace-nowrap"><AnimatedNumber value={tok._bal} format={isCompact ? fmtCompactAmount : fmtBalNumber} duration={400} /></span>
							<span class="block text-13 text-(--text-dim) font-numeric font-medium tabular-nums mt-0.5 max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{#if usd > 0}<AnimatedNumber value={usd} format={isCompact ? fmtCompactUsd : fmtUsd} duration={400} />{/if}</span>
						</button>
					</div>
				{/each}

				{#if tokens.length === 0 && importedTokens.length === 0}
					<p class="text-center py-6 text-13 text-(--text-dim) font-mono">{$t('account.noImportedTokens')}</p>
				{/if}
			</div>

		{/if}

	<!-- ═══ RECEIVE VIEW ═══ -->
	{:else if view === 'receive'}
		<div class="flex-1 p-4 flex flex-col gap-3 overflow-y-auto items-center">
			<p class="text-3xs text-(--text-dim) font-mono m-0 leading-[1.5]">Send only {nativeCoin} and tokens on {networkName} to this address.</p>
			<div class="p-4 bg-(--bg-surface) border border-(--border) rounded-xl">
				<QrCode data={userAddress} width={180} />
			</div>
			<div
				class="p-4 bg-(--bg-surface) border border-(--border) rounded-[10px] text-center cursor-pointer transition-colors duration-150 hover:border-[rgba(0,210,255,0.2)]"
				onclick={() => { copyText(userAddress); onAddFeedback({ message: $t('account.addressCopied'), type: 'success' }); }}
				onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copyText(userAddress); onAddFeedback({ message: $t('account.addressCopied'), type: 'success' }); } }}
				role="button"
				tabindex="0"
			>
				<span class="ap-selectable block font-mono text-3xs text-(--text-muted) break-all leading-[1.6]">{userAddress}</span>
				<span class="block text-xs4 text-[#00d2ff] mt-1.5 font-mono">{copiedAddr ? $t('account.copied') : $t('account.tapToCopy')}</span>
			</div>
			<!-- Buy-crypto deep link to /trade?mode=buy. Shortcut for users
			     who landed on Receive expecting a way to fund the wallet
			     and don't already hold crypto on another chain to send in. -->
			<a
				href="/trade?mode=buy"
				class="w-full mt-1 inline-flex items-center justify-center gap-2 px-4 py-3 rounded-[10px] no-underline transition-all duration-150 cursor-pointer bg-gradient-to-br from-[rgba(0,210,255,0.12)] to-[rgba(59,130,246,0.12)] border border-[rgba(0,210,255,0.2)] text-[#00d2ff] font-mono text-3xs font-bold hover:from-[rgba(0,210,255,0.2)] hover:to-[rgba(59,130,246,0.2)] hover:border-[rgba(0,210,255,0.35)]"
			>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<rect x="2" y="6" width="20" height="14" rx="2"/><path d="M2 10h20"/><path d="M6 16h4"/>
				</svg>
				<span>Buy crypto with bank transfer</span>
			</a>
		</div>

	<!-- ═══ SECURITY VIEW ═══ -->
	{:else if view === 'security'}
		<div class="flex-1 p-4 flex flex-col gap-3 overflow-y-auto">
			<div class="flex gap-2.5 p-3 rounded-[10px] bg-[rgba(245,158,11,0.04)] border border-[rgba(245,158,11,0.1)]">
				<svg class="shrink-0 mt-0.5" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
				<p class="m-0 text-3xs text-[#f59e0b] font-mono leading-[1.5]">{$t('account.securityWarn')}</p>
			</div>

			<!-- Passkey unlock — opt-in. Encrypts the PIN locally with a key
			     derived from the passkey's PRF output, so unlocking with
			     FaceID/TouchID resolves to the cached PIN without typing.
			     Server never sees the PRF output or the PIN. -->
			{#if isPasskeySupported()}
				<div class="p-3 rounded-[10px] border border-(--border-subtle) bg-(--bg-surface) flex flex-col gap-2.5">
					<div class="flex items-center gap-2.5">
						<svg class="shrink-0" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00d2ff" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg>
						<div class="flex-1 min-w-0">
							<span class="block font-display text-13 font-bold text-(--text-heading) leading-[1.3]">Passkey unlock</span>
							<span class="block font-mono text-3xs text-(--text-dim) mt-0.5">{passkeyEnabled ? 'Enabled — unlock with FaceID/TouchID' : 'Skip the PIN with biometrics on this device'}</span>
						</div>
						{#if passkeyEnabled}
							<button class="px-2.5 py-1.5 rounded-md border border-[rgba(248,113,113,0.2)] bg-transparent text-[#f87171] font-mono text-3xs cursor-pointer transition hover:bg-[rgba(248,113,113,0.06)]" onclick={disablePasskeyForUser}>Disable</button>
						{:else if !passkeyShowPin}
							<button class="px-2.5 py-1.5 rounded-md border border-[rgba(0,210,255,0.25)] bg-[rgba(0,210,255,0.05)] text-[#00d2ff] font-mono text-3xs font-bold cursor-pointer transition hover:bg-[rgba(0,210,255,0.1)]" onclick={() => { passkeyShowPin = true; passkeyError = ''; }}>Enable</button>
						{/if}
					</div>
					{#if passkeyShowPin && !passkeyEnabled}
						<div class="flex flex-col gap-1.5">
							<input class="ap-input" type="tel" inputmode="numeric" style="-webkit-text-security: disc; text-security: disc;" placeholder="Confirm with PIN" bind:value={passkeyPin} {...INPUT_ATTRS}
								onkeydown={(e) => { if (e.key === 'Enter') enablePasskey(); }} />
							{#if passkeyError}<p class="text-3xs text-[#f87171] font-mono m-0">{passkeyError}</p>{/if}
							<div class="flex gap-1.5 justify-end">
								<button class="ap-btn-s" onclick={() => { passkeyShowPin = false; passkeyPin = ''; passkeyError = ''; }}>Cancel</button>
								<button class="ap-btn-s ap-btn-primary" disabled={passkeyEnabling || !passkeyPin} onclick={enablePasskey}>{passkeyEnabling ? 'Setting up…' : 'Confirm'}</button>
							</div>
						</div>
					{/if}
				</div>
			{/if}
			<button class="flex items-center gap-2.5 w-full px-4 py-3 border-none bg-transparent text-(--text-muted) cursor-pointer font-mono text-xs2 transition-all duration-100 text-left hover:bg-(--bg-surface) hover:text-(--text)" onclick={() => { secretSheetKind = 'key'; showSecretSheet = true; }}>
				<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
				<span>{$t('account.exportPrivateKey')}</span>
				<svg class="ml-auto text-(--text-dim)" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
			</button>
			<button class="flex items-center gap-2.5 w-full px-4 py-3 border-none bg-transparent text-(--text-muted) cursor-pointer font-mono text-xs2 transition-all duration-100 text-left hover:bg-(--bg-surface) hover:text-(--text)" onclick={() => { secretSheetKind = 'seed'; showSecretSheet = true; }}>
				<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
				<span>{$t('account.exportRecoveryPhrase')}</span>
				<svg class="ml-auto text-(--text-dim)" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
			</button>
		</div>

	{/if}

	<!-- Secret-reveal sheet — replaces the inline export-key /
	     export-seed views. 80vh bottom-up modal with a 5-item ack
	     gauntlet, PIN gate, and long-press reveal + QR. -->
	<SecretRevealSheet
		bind:open={showSecretSheet}
		kind={secretSheetKind}
		accountIndex={activeIndex}
		accountAddress={userAddress || ''}
		walletName={walletState.wallets.find((w) => w.id === walletState.activeWalletId)?.name || ''}
	/>

	<!-- ═══ SEND SHEET — slides up from bottom, main wallet panel stays visible behind it ═══ -->
	{#if showSend}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div class="ap-picker-overlay" transition:fade={{ duration: 150 }} onclick={(e) => { if (e.target === e.currentTarget && !sending) resetSend(); }}>
			<div class="ap-picker ap-send-sheet" transition:fly={{ y: 400, duration: 220 }}>
				<div class="ap-picker-header">
					<span class="ap-picker-title">{$t('account.send')}</span>
					<button aria-label="Close" class="ap-picker-close" type="button" disabled={sending} onclick={resetSend}>
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
					</button>
				</div>
				<div class="ap-send-body">
					<span class="ap-label">{$t('account.asset')}</span>
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

					<label for="ap-send-to" class="ap-label">{$t('account.recipient')}</label>
					<div class="ap-recipient-row">
						<input id="ap-send-to" class="ap-input ap-recipient-input" type="text" placeholder="0x…" bind:value={sendTo} {...INPUT_ATTRS} />
						{#if walletType === 'embedded' && addressBookEntries.length > 0}
							<button class="ap-book-btn" type="button" title="My addresses" onclick={() => showAddressBook = !showAddressBook}>
								<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
									<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
								</svg>
							</button>
						{/if}
					</div>

					<label for="ap-send-amount" class="ap-label">{$t('account.amount')}</label>
					<!-- Amount input with inset MAX pill — mirrors the recipient
					     row's address-book icon for structural consistency. -->
					<div class="ap-recipient-row">
						<input
							id="ap-send-amount"
							class="ap-input ap-recipient-input"
							type="text"
							inputmode="decimal"
							placeholder="0.0"
							bind:value={sendAmount}
							oninput={() => {
								// User typing → drop the MAX lock. We only want the
								// pinned gas params to apply to the exact value MAX
								// computed; anything else should use the wallet's
								// default gas estimation.
								if (sendingMax) {
									sendingMax = false;
									maxLockedGasPrice = null;
								}
							}}
							{...INPUT_ATTRS}
						/>
						<button
							class="ap-max-btn"
							type="button"
							title="Use max balance"
							onclick={async () => {
								const dec = sendAsset === 'native' ? nativeDecimals : sendAssetInfo.decimals;
								if (sendAsset !== 'native') {
									// ERC20: gas is paid in the native coin separately,
									// so MAX just means full token balance.
									sendingMax = false;
									maxLockedGasPrice = null;
									sendAmount = ethers.formatUnits(sendAssetInfo.balance, dec);
									return;
								}
								// Native: drain to exactly zero. We lock the gasPrice
								// we read here so the submit path can reuse it as an
								// explicit tx field — otherwise a network spike
								// between click + send could leave the tx underfunded
								// or leave dust if the wallet later picks lower gas.
								let gasPrice: bigint | null = null;
								try {
									const net = getProvider();
									if (net?.provider) {
										const feeData = await (net.provider as any).getFeeData();
										gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? null;
									}
								} catch {}
								if (gasPrice && gasPrice > 0n) {
									const reserve = 21000n * gasPrice; // exact, no margin
									const max = sendAssetInfo.balance > reserve ? sendAssetInfo.balance - reserve : 0n;
									sendAmount = ethers.formatUnits(max, dec);
									sendingMax = true;
									maxLockedGasPrice = gasPrice;
								} else {
									// RPC unreachable — fall back to a small fixed
									// reserve so the user isn't blocked from sending.
									// Won't drain to zero in this branch, but it's an
									// extremely rare path.
									const reserve = ethers.parseUnits('0.0005', dec);
									const max = sendAssetInfo.balance > reserve ? sendAssetInfo.balance - reserve : 0n;
									sendAmount = ethers.formatUnits(max, dec);
									sendingMax = false;
									maxLockedGasPrice = null;
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
					<button class="ap-btn-big" disabled={!sendTo || !sendAmount} onclick={reviewSend}>
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
						<button aria-label="Close" class="ap-picker-close" type="button" onclick={() => showAssetPicker = false}>
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
						{#each [...pinnedStables, ...sortedTokens] as tok}
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
						<button aria-label="Close" class="ap-picker-close" type="button" onclick={() => { showAddressBook = false; addressBookQuery = ''; }}>
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
						<button aria-label="Back" class="ap-picker-close" type="button" disabled={sending} onclick={() => { sendStep = 'form'; sendFeeEst = ''; }}>
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
						</button>
					</div>
					<div class="ap-preview-body">
						<!-- Amount hero -->
						<div class="ap-preview-hero">
							{#if sendAsset === 'native' && getKnownLogo(nativeCoin)}
								<img src={getKnownLogo(nativeCoin)} alt="" class="ap-preview-icon" />
							{:else if sendAssetTok}
								{#if getTokenLogo(sendAssetTok)}
									<img src={getTokenLogo(sendAssetTok)} alt="" class="ap-preview-icon" />
								{:else}
									<span class="ap-preview-icon-fb">{sendAssetInfo.symbol.charAt(0)}</span>
								{/if}
							{:else}
								<span class="ap-preview-icon-fb">{sendAssetInfo.symbol.charAt(0)}</span>
							{/if}
							<div class="ap-preview-big">
								<span class="ap-preview-big-num">{sendAmount}</span>
								<span class="ap-preview-big-sym">{sendAssetInfo.symbol}</span>
							</div>
							{#if previewUsd > 0}
								<div class="ap-preview-usd">≈ {fmtUsd(previewUsd)}</div>
							{/if}
						</div>

						<!-- Transfer flow -->
						<div class="ap-preview-flow">
							<div class="ap-preview-addr-card">
								<span class="ap-preview-addr-label">From</span>
								<span class="ap-preview-addr-val">{userAddress.slice(0, 6)}…{userAddress.slice(-4)}</span>
							</div>
							<div class="ap-preview-arrow">
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" stroke-width="2.5"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>
							</div>
							<div class="ap-preview-addr-card">
								<span class="ap-preview-addr-label">To</span>
								<span class="ap-preview-addr-val">{sendTo.slice(0, 6)}…{sendTo.slice(-4)}</span>
							</div>
						</div>

						<!-- Details card -->
						<div class="ap-preview-details">
							<div class="ap-preview-row">
								<span class="ap-preview-k">Asset</span>
								<span class="ap-preview-v">{sendAssetInfo.symbol}</span>
							</div>
							<div class="ap-preview-row">
								<span class="ap-preview-k">Network fee</span>
								<span class="ap-preview-v">
									{#if sendFeeLoading}estimating...
									{:else if sendFeeEst}~{sendFeeEst} {nativeCoin}
									{:else}—{/if}
								</span>
							</div>
						</div>
					</div>
					<div class="ap-preview-btns">
						<button class="ap-btn-big" disabled={sending} onclick={executeSend}>
							{sending ? $t('account.sending') : $t('account.confirmSend')}
						</button>
					</div>
				</div>
			</div>
		{/if}
	{/if}

	<!-- All in-panel modals render as absolute overlays inside .ap so they
	     stay visually contained to the wallet (Trust Wallet feel) and
	     inherit the panel's user-select: none. Mounting at body-level
	     made them feel like full-site dialogs and bypassed the wallet's
	     no-select rule. -->
	<AssetSettingsModal
		bind:open={showImport}
		networks={supportedNetworks}
		defaultChainId={chainId}
		{walletType}
		{sharedProviders}
		hiddenTokens={hiddenRows}
		onFeedback={onAddFeedback}
	/>

	<RowActionSheet
		bind:open={showRowSheet}
		token={rowSheetToken}
		{chainId}
		{walletType}
		onFeedback={onAddFeedback}
	/>
</div>
{/if}

<style>
	/* Slide-in panel — keyframe + container-width based on viewport */
	.ap {
		position: fixed; top: 0; right: 0; bottom: 0; z-index: 9999;
		width: 360px; background: var(--bg);
		border-left: 1px solid var(--border-subtle);
		display: flex; flex-direction: column;
		animation: apSlide 0.2s ease-out;
	}
	@keyframes apSlide { from { transform: translateX(100%); } }
	@keyframes blink { 0%,100% { opacity: 0.3; } 50% { opacity: 1; } }
	@media (max-width: 480px) { .ap { width: 100vw; border-left: none; } }

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
		flex: 1; overflow-y: auto; padding: 20px 16px 16px;
		display: flex; flex-direction: column; gap: 16px;
	}
	.ap-preview-hero {
		display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 8px 0 4px;
	}
	.ap-preview-icon {
		width: 44px; height: 44px; border-radius: 50%; object-fit: cover;
		border: 2px solid var(--border); margin-bottom: 6px;
	}
	.ap-preview-icon-fb {
		width: 44px; height: 44px; border-radius: 50%;
		display: flex; align-items: center; justify-content: center;
		background: rgba(0,210,255,0.1); color: #00d2ff; border: 2px solid rgba(0,210,255,0.2);
		font-family: 'Syne', sans-serif; font-size: 18px; font-weight: 800; margin-bottom: 6px;
	}
	.ap-preview-big {
		display: flex; align-items: baseline; gap: 8px; justify-content: center;
	}
	.ap-preview-big-num {
		font-family: 'Rajdhani', sans-serif; font-size: 32px; font-weight: 700;
		color: var(--text-heading); font-variant-numeric: tabular-nums; line-height: 1;
	}
	.ap-preview-big-sym {
		font-family: 'Syne', sans-serif; font-size: 16px; font-weight: 700; color: var(--text-muted);
	}
	.ap-preview-flow {
		display: flex; flex-direction: column; align-items: center; gap: 0;
		background: var(--bg-surface); border: 1px solid var(--border-subtle);
		border-radius: 12px; padding: 12px; margin: 0 -4px;
	}
	.ap-preview-arrow {
		display: flex; align-items: center; justify-content: center;
		width: 28px; height: 28px; border-radius: 50%;
		background: var(--bg); border: 1px solid var(--border);
		margin: -6px 0; z-index: 1;
	}
	.ap-preview-addr-card {
		width: 100%; display: flex; align-items: center; gap: 8px;
		padding: 8px 10px;
	}
	.ap-preview-addr-label {
		font-family: 'Space Mono', monospace; font-size: 9px; color: var(--text-dim);
		text-transform: uppercase; letter-spacing: 0.05em; min-width: 32px;
	}
	.ap-preview-addr-val {
		font-family: 'Space Mono', monospace; font-size: 12px; color: var(--text);
		margin-left: auto;
	}
	.ap-preview-details {
		display: flex; flex-direction: column; gap: 8px;
		padding: 12px; border-radius: 10px;
		background: var(--bg-surface); border: 1px solid var(--border-subtle);
		margin: 0 -4px;
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

	/* Balance hero — container-query + clamp aren't expressible as utilities */
	.ap-bal { container-type: inline-size; }
	.ap-bal-total {
		/* Fluid: clamp against the container's inline size so meme portfolios
		   (e.g. $73B of shitcoin) shrink to fit instead of overflowing. */
		font-size: clamp(28px, 11cqw, 44px);
	}

	/* Right-hand tap-target column of a token row — button reset + width cap
	   kept here because 55%-max-width needs the flex-column context. */
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

	/* Wallet panel is non-selectable by default — chrome text (balances,
	   labels, button text) shouldn't be selectable on long-press. We then
	   opt-in selection on the few places where the user genuinely needs
	   to copy: input fields (default), the receive address, and the
	   private-key / seed-phrase reveal blocks (.ap-secret). */
	.ap {
		user-select: none;
		-webkit-user-select: none;
		-webkit-touch-callout: none;
	}
	.ap input, .ap textarea,
	.ap .ap-selectable, .ap .ap-secret {
		user-select: text;
		-webkit-user-select: text;
		-webkit-touch-callout: default;
	}
	/* Touch-action stays on rows so vertical scroll still works during a
	   pending long-press timer. Press scale gives users feedback that
	   their hold registered — cleared the moment the sheet pops or
	   movement cancels. */
	.ap-row {
		touch-action: pan-y;
		transition: transform 0.18s ease, background-color 0.1s;
	}
	.ap-row.ap-pressing { transform: scale(0.97); }

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
	/* Big-bold primary CTA — matches the asset-settings / import-token
	   modal pattern. Used for the send sheet's Review and Confirm. */
	.ap-btn-big {
		width: 100%;
		padding: 14px 16px;
		border-radius: 12px;
		border: none;
		background: linear-gradient(135deg, #00d2ff, #3a7bd5);
		color: white;
		font-family: 'Syne', sans-serif;
		font-size: 14px;
		font-weight: 700;
		letter-spacing: 0.01em;
		cursor: pointer;
		transition: transform 0.12s, box-shadow 0.12s, opacity 0.12s;
	}
	.ap-btn-big:hover:not(:disabled) {
		transform: translateY(-1px);
		box-shadow: 0 6px 20px rgba(0,210,255,0.3);
	}
	.ap-btn-big:disabled { opacity: 0.4; cursor: not-allowed; }
	.ap-btn-danger { background: rgba(248,113,113,0.1); border: 1px solid rgba(248,113,113,0.2); color: #f87171; font-family: 'Syne', sans-serif; font-weight: 700; }
	.ap-btn-danger:hover { background: rgba(248,113,113,0.15); }
	.ap-btn-full { width: 100%; }
</style>
