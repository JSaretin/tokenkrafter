<script lang="ts">
	/**
	 * Unified Wallet Switcher
	 *
	 * One sheet that replaces the old wallet dropdown + account dropdown +
	 * security entry points. Shows the full tree (wallets → accounts) with
	 * search, accordion, inline rename, hold-to-delete, and a "+ New / Import"
	 * footer. Hosts the create/import forms inline so the user never has to
	 * leave the sheet to add a wallet.
	 *
	 * Designed as a controlled component: parent owns wallet/account state
	 * via embeddedWallet store, this component just renders + emits intents.
	 */

	import {
		switchWallet,
		renameWallet,
		deleteWallet,
		setPrimaryWallet,
		createNewWallet,
		importWallet,
		changePin,
		addAccount,
		setActiveAccount,
		setAccountMeta,
		getAccountMeta,
		getAllAccountMeta,
		getWalletState,
		onWalletStateChange,
		lockWallet,
		unlockWallet,
		getSessionPolicy,
		setSessionPolicy,
		type WalletState,
	} from './embeddedWallet';
	import { friendlyError } from './errorDecoder';
	import { shortAddr } from '$lib/formatters';
	import { t } from '$lib/i18n';
	import ActionSheet from './ActionSheet.svelte';
	import type { ActionItem } from './actionSheetTypes';

	let {
		open = $bindable(false),
		usdByAccount = {} as Record<string, number>,
		onAccountSwitched = (_addr: string) => {},
		onFeedback = (_: { message: string; type: string }) => {},
		onExportSeed = () => {},
		onExportKey = () => {},
		onDisconnect = () => {},
		onLock = () => {},
		onAccountMetaChanged = () => {},
	}: {
		open: boolean;
		/** Optional USD totals per address (lowercase) for at-a-glance value. */
		usdByAccount?: Record<string, number>;
		onAccountSwitched: (addr: string) => void;
		onFeedback: (f: { message: string; type: string }) => void;
		/** Called when the user picks "Export recovery phrase" from the cog menu.
		 *  Parent is responsible for ensuring the target wallet is active and
		 *  navigating to the export-seed view. */
		onExportSeed: () => void;
		/** Called when the user picks "Export private key" from the cog menu.
		 *  Operates on the active account in the active wallet. */
		onExportKey: () => void;
		onDisconnect: () => void;
		/** Called when the user taps Lock — clears PIN cache + seeds but keeps
		 *  the session so the user can re-enter PIN without re-authenticating. */
		onLock: () => void;
		/** Called after local account metadata (name, avatar, hidden) changes
		 *  so the parent can invalidate its own derived reads that depend on
		 *  localStorage (e.g. the account chip in the panel header). */
		onAccountMetaChanged?: () => void;
	} = $props();

	// Subscribe directly to the wallet store. Avoids any prop-staleness
	// issues when the parent's $derived snapshots return the same array
	// reference and Svelte 5 short-circuits the update — the user reported
	// only seeing one account in the list while the chip showed account 4,
	// which is the symptom of exactly that staleness.
	let walletState = $state<WalletState>(getWalletState());
	$effect(() => {
		const unsub = onWalletStateChange((s) => {
			walletState = s;
		});
		return unsub;
	});

	let wallets = $derived(walletState.wallets || []);
	let activeWalletId = $derived(walletState.activeWalletId);
	let accounts = $derived(walletState.accounts || []);
	let activeAccountIndex = $derived(walletState.activeAccount?.index ?? 0);

	// ── Local UI state ─────────────────────────────────────────────────
	let search = $state('');
	let expandedWallets = $state<Record<string, boolean>>({});
	let renamingWalletId = $state<string | null>(null);
	let renameWalletValue = $state('');
	let renamingAcct = $state<{ walletId: string; index: number } | null>(null);
	let renameAcctValue = $state('');
	let switchingId = $state<string | null>(null);
	let creatingAccount = $state(false);

	// Delete-wallet confirm flow state. Two-step UX: first the user
	// types the wallet name to confirm intent, then a separate screen
	// asks for the device PIN. The friction is intentional — wallet
	// deletion is irreversible without the recovery phrase.
	let deletingTarget = $state<{ id: string; name: string } | null>(null);
	let deleteStep = $state<'name' | 'pin'>('name');
	let deleteTypedName = $state('');
	let deletePin = $state('');
	let deleteError = $state('');
	let deleting = $state(false);

	// Add-wallet form state
	let addMode = $state<'create' | 'import' | 'change-pin' | 'settings' | null>(null);

	// Auto-lock settings — preloaded from localStorage
	const AUTO_LOCK_OPTIONS = [
		{ label: '5 min', idleMs: 5 * 60_000 },
		{ label: '15 min', idleMs: 15 * 60_000 },
		{ label: '30 min', idleMs: 30 * 60_000 },
		{ label: '1 hour', idleMs: 60 * 60_000 },
		{ label: '4 hours', idleMs: 4 * 60 * 60_000 },
		{ label: '8 hours', idleMs: 8 * 60 * 60_000 },
	];
	let selectedIdleMs = $state(getSessionPolicy().idleMs);
	let newName = $state('');
	let newPin = $state('');
	let importMnemonic = $state('');
	let importAck = $state(false);
	let addError = $state('');
	let addLoading = $state(false);
	let createdCodes = $state<string[]>([]);

	// Change-PIN form state (separate inputs from the create/import PIN)
	let currentPinInput = $state('');
	let newPinInput = $state('');
	let newPinConfirm = $state('');
	let pinChangeConfirm = $state(false);

	// Avatar picker
	let avatarPickerFor = $state<{ walletId: string; index: number } | null>(null);
	const AVATAR_OPTIONS = ['🦊', '🦄', '🐳', '🚀', '⚡', '🔥', '💎', '🌙', '🪐', '🎯', '🦁', '🐺'];

	// ── Long-press → action sheet (wallet + account) ──
	// Replaces the inline rename/cog/export icons with a single press-and-hold
	// gesture. Sheet content is built per-row when the timer fires so the
	// actions array always reflects the current wallet/account state.
	const LONG_PRESS_MS = 500;
	const LONG_PRESS_TOL_PX = 8;
	let _lpTimer: ReturnType<typeof setTimeout> | null = null;
	let _lpStart: { x: number; y: number } | null = null;
	// Press-feedback key: drives a 0.97x scale on the held row.
	let pressingKey = $state<string | null>(null);

	let walletSheetOpen = $state(false);
	let walletSheetTarget = $state<{ id: string; name: string; isPrimary: boolean; isImported: boolean; isActive: boolean } | null>(null);

	let accountSheetOpen = $state(false);
	let accountSheetTarget = $state<{ walletId: string; index: number; address: string; name: string; avatar: string } | null>(null);

	// Global settings sheet — actions that apply across the whole
	// device (PIN, auto-lock, adding a new wallet) rather than to a
	// specific wallet. Opened from the gear button in the footer.
	let globalSheetOpen = $state(false);

	function _lpClear() {
		if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; }
		_lpStart = null;
		pressingKey = null;
	}

	function lpMove(e: PointerEvent) {
		if (!_lpStart) return;
		const dx = e.clientX - _lpStart.x;
		const dy = e.clientY - _lpStart.y;
		if (dx * dx + dy * dy > LONG_PRESS_TOL_PX * LONG_PRESS_TOL_PX) _lpClear();
	}
	function lpEnd() { _lpClear(); }

	function openWalletSheet(w: (typeof wallets)[number]) {
		walletSheetTarget = {
			id: w.id,
			name: w.name,
			isPrimary: !!w.isPrimary,
			isImported: !!w.isImported,
			isActive: w.id === activeWalletId,
		};
		walletSheetOpen = true;
	}

	function openAccountSheet(walletId: string, acc: (typeof accounts)[number]) {
		accountSheetTarget = {
			walletId,
			index: acc.index,
			address: acc.address,
			name: acctName(walletId, acc.index),
			avatar: acctAvatar(walletId, acc.index) || String(acc.index + 1),
		};
		accountSheetOpen = true;
	}

	function lpStartWallet(w: (typeof wallets)[number], e: PointerEvent) {
		if (e.button && e.button !== 0) return;
		_lpClear();
		_lpStart = { x: e.clientX, y: e.clientY };
		pressingKey = `w:${w.id}`;
		_lpTimer = setTimeout(() => {
			_lpTimer = null;
			pressingKey = null;
			try { (navigator as any).vibrate?.(15); } catch {}
			openWalletSheet(w);
		}, LONG_PRESS_MS);
	}

	function lpStartAccount(walletId: string, acc: (typeof accounts)[number], e: PointerEvent) {
		if (e.button && e.button !== 0) return;
		_lpClear();
		_lpStart = { x: e.clientX, y: e.clientY };
		pressingKey = `a:${walletId}:${acc.index}`;
		_lpTimer = setTimeout(() => {
			_lpTimer = null;
			pressingKey = null;
			try { (navigator as any).vibrate?.(15); } catch {}
			openAccountSheet(walletId, acc);
		}, LONG_PRESS_MS);
	}

	// Desktop: right-click opens the same action sheet a long-press would.
	// Touch devices keep the long-press; mouse users get the conventional
	// context-menu gesture instead of having to discover hold-left-click.
	function ctxWallet(w: (typeof wallets)[number], e: MouseEvent) {
		e.preventDefault();
		_lpClear();
		openWalletSheet(w);
	}
	function ctxAccount(walletId: string, acc: (typeof accounts)[number], e: MouseEvent) {
		e.preventDefault();
		_lpClear();
		openAccountSheet(walletId, acc);
	}

	let walletActions = $derived.by<ActionItem[]>(() => {
		const w = walletSheetTarget;
		if (!w) return [];
		const list: ActionItem[] = [
			{
				title: 'Rename',
				sub: 'Change wallet display name',
				iconColor: '#00d2ff',
				iconSvg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
				onClick: () => { renamingWalletId = w.id; renameWalletValue = w.name; },
			},
			{
				title: 'Add account',
				sub: 'Derive a new account in this wallet',
				iconColor: '#10b981',
				disabled: !w.isActive,
				iconSvg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
				onClick: () => { if (w.isActive) handleAddAccount(); },
			},
			{
				title: 'Export recovery phrase',
				sub: w.isActive ? 'Reveal the seed phrase for this wallet' : 'Switch to this wallet first',
				iconColor: '#f59e0b',
				disabled: !w.isActive,
				iconSvg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
				onClick: () => { onExportSeed(); close(); },
			},
		];
		if (!w.isPrimary) {
			list.push({
				title: 'Set as primary',
				sub: 'Default wallet on next login',
				iconColor: '#00d2ff',
				iconSvg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15 8.5 22 9.3 17 14.1 18.2 21 12 17.8 5.8 21 7 14.1 2 9.3 9 8.5 12 2"/></svg>',
				onClick: () => { handleSetPrimary(w.id); },
			});
		}
		if (wallets.length > 1) {
			list.push({
				title: 'Delete wallet',
				sub: 'Removes this wallet from this device',
				danger: true,
				iconSvg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>',
				onClick: () => { openDeleteConfirm(w.id, w.name); },
			});
		}
		return list;
	});

	// Global settings actions — these apply across every wallet on
	// this device, so they live in a single device-wide sheet rather
	// than the per-wallet long-press menu.
	let globalSettingsActions = $derived.by<ActionItem[]>(() => [
		{
			title: 'Create new wallet',
			sub: 'Generate a fresh seed phrase on this device',
			iconColor: '#10b981',
			iconSvg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
			onClick: () => { resetAddForm(); addMode = 'create'; collapseAllWallets(); },
		},
		{
			title: 'Import existing wallet',
			sub: 'Restore from a recovery phrase',
			iconColor: '#00d2ff',
			iconSvg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
			onClick: () => { resetAddForm(); addMode = 'import'; collapseAllWallets(); },
		},
		{
			title: 'Change PIN',
			sub: 'Re-encrypts every wallet on this device',
			iconColor: '#a78bfa',
			iconSvg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
			onClick: () => { resetAddForm(); addMode = 'change-pin'; collapseAllWallets(); },
		},
		{
			title: 'Auto-lock',
			sub: 'How long until your wallet locks after inactivity',
			iconColor: '#f59e0b',
			iconSvg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
			onClick: () => { resetAddForm(); addMode = 'settings'; collapseAllWallets(); },
		},
	]);

	let accountActions = $derived.by<ActionItem[]>(() => {
		const a = accountSheetTarget;
		if (!a) return [];
		return [
			{
				title: 'Rename',
				sub: 'Change account display name',
				iconColor: '#00d2ff',
				iconSvg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
				onClick: () => { renamingAcct = { walletId: a.walletId, index: a.index }; renameAcctValue = a.name; },
			},
			{
				title: 'Change avatar',
				sub: 'Pick an emoji for this account',
				iconColor: '#a78bfa',
				iconSvg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>',
				onClick: () => { avatarPickerFor = { walletId: a.walletId, index: a.index }; },
			},
			{
				title: 'Copy address',
				sub: a.address,
				iconColor: '#10b981',
				iconSvg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
				onClick: () => {
					try { navigator.clipboard?.writeText(a.address); onFeedback({ message: 'Address copied', type: 'success' }); } catch {}
				},
			},
			{
				title: 'Export private key',
				sub: 'Reveal the private key for this account',
				iconColor: '#f59e0b',
				iconSvg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
				onClick: () => { setActiveAccount(a.index); onExportKey(); close(); },
			},
		];
	});

	// Bump when localStorage-backed account metadata (name, avatar) changes.
	// Referenced inside acctName()/acctAvatar() so Svelte re-runs the derived
	// reads on mutation. Parent is also notified via onAccountMetaChanged.
	let metaTick = $state(0);
	function bumpMeta() {
		metaTick++;
		onAccountMetaChanged();
	}

	// Every input in this component opts out of password-manager autofill.
	// Mnemonics + PINs must never be suggested, saved, or decorated by
	// 1Password / LastPass / Bitwarden / ProtonPass.
	const INPUT_ATTRS = {
		autocomplete: 'off',
		autocorrect: 'off',
		autocapitalize: 'off',
		spellcheck: false,
		'data-lpignore': 'true',
		'data-1p-ignore': 'true',
		'data-bwignore': 'true',
		'data-protonpass-ignore': 'true',
		'data-form-type': 'other',
	} as const;

	// ── Auto-expand the active wallet on open ──────────────────────────
	$effect(() => {
		if (open && activeWalletId && expandedWallets[activeWalletId] === undefined) {
			expandedWallets = { ...expandedWallets, [activeWalletId]: true };
		}
	});

	function close() {
		open = false;
		search = '';
		addMode = null;
		renamingWalletId = null;
		renamingAcct = null;
		avatarPickerFor = null;
		resetAddForm();
	}

	function resetAddForm() {
		newName = '';
		newPin = '';
		importMnemonic = '';
		importAck = false;
		addError = '';
		addLoading = false;
		createdCodes = [];
		currentPinInput = '';
		newPinInput = '';
		newPinConfirm = '';
		pinChangeConfirm = false;
	}

	// ── Derived: search filter ─────────────────────────────────────────
	//
	// The filter narrows *both* the wallet list AND the accounts shown
	// inside each wallet. If the user types "main" and only one account
	// matches, we show that account alone — not every account in the
	// same wallet. Wallet-name matches still keep the wallet visible.
	function accountMatches(walletId: string, acc: (typeof accounts)[number], q: string): boolean {
		const meta = getAllAccountMeta(walletId);
		const name = (meta[String(acc.index)]?.name || `Account ${acc.index + 1}`).toLowerCase();
		return name.includes(q) || acc.address.toLowerCase().includes(q);
	}

	function accountsForWallet(w: (typeof wallets)[number]): typeof accounts {
		// Only the active wallet has decrypted accounts in memory. Other
		// wallets render a "switch to view" placeholder row.
		if (w.id !== activeWalletId) return [];
		const q = search.trim().toLowerCase();
		if (!q) return accounts;

		const matching = accounts.filter((a) => accountMatches(w.id, a, q));
		// If nothing in the account list matched but the wallet name does,
		// keep the full list visible — the user's search targets the wallet,
		// not a specific account.
		if (matching.length === 0 && w.name.toLowerCase().includes(q)) return accounts;
		return matching;
	}

	let filteredWallets = $derived.by(() => {
		const q = search.trim().toLowerCase();
		if (!q) return wallets;
		return wallets.filter((w) => {
			if (w.name.toLowerCase().includes(q)) return true;
			if (w.defaultAddress?.toLowerCase().includes(q)) return true;
			if (w.id === activeWalletId && accounts.some((a) => accountMatches(w.id, a, q))) return true;
			return false;
		});
	});

	// ── Account meta helpers ───────────────────────────────────────────
	// Both helpers touch `metaTick` so Svelte re-runs them after a rename
	// or avatar change invalidates the underlying localStorage entry.
	function acctName(walletId: string, index: number): string {
		void metaTick;
		const m = getAccountMeta(walletId, index);
		return m.name || `Account ${index + 1}`;
	}

	function acctAvatar(walletId: string, index: number): string {
		void metaTick;
		const m = getAccountMeta(walletId, index);
		return m.avatar || '';
	}

	// ── Switch / rename / primary / delete ─────────────────────────────
	async function handleSwitch(walletId: string) {
		if (walletId === activeWalletId) {
			// Tapping the already-active wallet toggles its account list.
			// This matches the intuition that the big wallet row is the
			// obvious target — the chevron is still there for users who
			// prefer it, but it no longer has to carry the whole affordance.
			toggleExpanded(walletId);
			return;
		}
		switchingId = walletId;
		try {
			const ok = await switchWallet(walletId);
			if (!ok) {
				onFeedback({ message: 'Wallet locked — PIN required', type: 'error' });
				return;
			}
			// Success: auto-close the switcher.
			close();
		} catch (e) {
			onFeedback({ message: friendlyError(e), type: 'error' });
		} finally {
			switchingId = null;
		}
	}

	// Optimistic rename: dismiss the rename input instantly, update local
	// state via renameWallet() (which writes the new name before the
	// server responds), and only surface a toast if the server rejects.
	function commitRenameWallet(id: string) {
		const v = renameWalletValue.trim();
		renamingWalletId = null;
		renameWalletValue = '';
		if (!v) return;
		renameWallet(id, v).catch((e) => {
			onFeedback({ message: friendlyError(e), type: 'error' });
		});
	}

	async function handleSetPrimary(id: string) {
		try {
			await setPrimaryWallet(id);
			onFeedback({ message: 'Primary wallet updated', type: 'success' });
		} catch (e) {
			onFeedback({ message: friendlyError(e), type: 'error' });
		}
	}

	function openDeleteConfirm(id: string, name: string) {
		deletingTarget = { id, name };
		deleteStep = 'name';
		deleteTypedName = '';
		deletePin = '';
		deleteError = '';
	}

	function dismissDeleteConfirm() {
		if (deleting) return;
		deletingTarget = null;
		deleteStep = 'name';
		deleteTypedName = '';
		deletePin = '';
		deleteError = '';
	}

	function advanceToPinStep() {
		if (!deletingTarget) return;
		if (deleteTypedName !== deletingTarget.name) {
			deleteError = `Type "${deletingTarget.name}" exactly to confirm`;
			return;
		}
		deleteError = '';
		deleteStep = 'pin';
	}

	function backToNameStep() {
		if (deleting) return;
		deleteStep = 'name';
		deletePin = '';
		deleteError = '';
	}

	async function confirmDelete() {
		if (!deletingTarget) return;
		const target = deletingTarget;
		// Defence-in-depth re-check on the name even though step 1
		// already gated it — a script could skip ahead via state edit.
		if (deleteTypedName !== target.name) {
			deleteError = `Type "${target.name}" exactly to confirm`;
			deleteStep = 'name';
			return;
		}
		if (!deletePin) {
			deleteError = 'Enter your PIN';
			return;
		}
		deleting = true;
		deleteError = '';
		try {
			// Verify PIN before destruction. The PIN is shared device-wide
			// (changePin re-encrypts every wallet on this device), so
			// unlockWallet against the active wallet is the canonical
			// check — no need to target the wallet being deleted.
			const ok = await unlockWallet(deletePin);
			if (!ok) {
				deleteError = 'Incorrect PIN';
				deleting = false;
				return;
			}
			await deleteWallet(target.id);
			onFeedback({ message: `Wallet "${target.name}" deleted`, type: 'success' });
			deletingTarget = null;
			deleteStep = 'name';
			deleteTypedName = '';
			deletePin = '';
		} catch (e) {
			deleteError = friendlyError(e);
		} finally {
			deleting = false;
		}
	}

	// ── Account actions ────────────────────────────────────────────────
	function handleSwitchAccount(idx: number) {
		setActiveAccount(idx);
		const acc = accounts.find((a) => a.index === idx);
		if (acc) onAccountSwitched(acc.address);
		// Auto-close on account selection for the same reason as wallet
		// switching: a tap in the list is a commit.
		close();
	}

	async function handleAddAccount() {
		creatingAccount = true;
		try {
			const acc = await addAccount();
			setActiveAccount(acc.index);
			onAccountSwitched(acc.address);
			onFeedback({ message: `Account ${acc.index + 1} created`, type: 'success' });
		} catch (e) {
			onFeedback({ message: friendlyError(e), type: 'error' });
		} finally {
			creatingAccount = false;
		}
	}

	function commitRenameAccount() {
		if (!renamingAcct) return;
		const { walletId, index } = renamingAcct;
		const v = renameAcctValue.trim();
		// Dismiss the input immediately — account meta is localStorage-backed
		// so the write is synchronous and bumpMeta triggers the re-render.
		renamingAcct = null;
		renameAcctValue = '';
		if (v) {
			setAccountMeta(walletId, index, { name: v });
			bumpMeta();
		}
	}

	function pickAvatar(emoji: string) {
		if (!avatarPickerFor) return;
		setAccountMeta(avatarPickerFor.walletId, avatarPickerFor.index, { avatar: emoji });
		avatarPickerFor = null;
		bumpMeta();
	}

	function clearAvatar() {
		if (!avatarPickerFor) return;
		setAccountMeta(avatarPickerFor.walletId, avatarPickerFor.index, { avatar: '' });
		avatarPickerFor = null;
		bumpMeta();
	}

	// ── Add wallet flow ────────────────────────────────────────────────
	async function submitCreate() {
		addError = '';
		if (!newName.trim()) {
			addError = 'Name required';
			return;
		}
		const hasExisting = wallets.length > 0;
		if (!newPin || newPin.length < 6) {
			addError = hasExisting ? 'Enter your PIN to encrypt' : 'PIN must be at least 6 digits';
			return;
		}
		addLoading = true;
		try {
			const result = await createNewWallet(newName.trim(), newPin);
			createdCodes = result.recoveryCodes;
			onFeedback({ message: `Wallet "${result.wallet.name}" created`, type: 'success' });
			expandedWallets = { ...expandedWallets, [result.wallet.id]: true };
			await handleSwitch(result.wallet.id);
		} catch (e) {
			addError = friendlyError(e);
		} finally {
			addLoading = false;
		}
	}

	async function submitImport() {
		addError = '';
		if (!newName.trim()) {
			addError = 'Name required';
			return;
		}
		if (!importMnemonic.trim()) {
			addError = 'Recovery phrase required';
			return;
		}
		if (!importAck) {
			addError = 'Acknowledge the warning';
			return;
		}
		addLoading = true;
		try {
			const ctx = await importWallet(newName.trim(), importMnemonic);
			onFeedback({ message: `Wallet "${ctx.name}" imported`, type: 'success' });
			expandedWallets = { ...expandedWallets, [ctx.id]: true };
			addMode = null;
			resetAddForm();
			await handleSwitch(ctx.id);
		} catch (e) {
			addError = friendlyError(e);
		} finally {
			addLoading = false;
		}
	}

	async function submitChangePin() {
		addError = '';
		if (!currentPinInput) {
			addError = 'Enter your current PIN';
			return;
		}
		if (!newPinInput || newPinInput.length < 6) {
			addError = 'New PIN must be at least 6 digits';
			return;
		}
		if (newPinInput !== newPinConfirm) {
			addError = 'New PINs do not match';
			return;
		}
		if (newPinInput === currentPinInput) {
			addError = 'New PIN must be different from current PIN';
			return;
		}
		// Two-step confirmation: the PIN is shared across every wallet, so
		// a single update re-encrypts all of them. First click validates
		// and arms the confirm; second click actually runs.
		if (!pinChangeConfirm) {
			pinChangeConfirm = true;
			return;
		}
		addLoading = true;
		try {
			await changePin(currentPinInput, newPinInput);
			onFeedback({ message: 'PIN updated', type: 'success' });
			addMode = null;
			resetAddForm();
		} catch (e) {
			addError = friendlyError(e);
		} finally {
			addLoading = false;
		}
	}

	function fmtUsd(n: number): string {
		if (!n) return '';
		if (n < 0.01) return '<$0.01';
		return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
	}


	function toggleExpanded(id: string) {
		expandedWallets = { ...expandedWallets, [id]: !expandedWallets[id] };
	}

	/** Explicitly collapse every known wallet. Writes `false` for each so
	 *  the auto-expand effect (which only fires on `undefined`) doesn't
	 *  immediately re-open the active wallet on the next reactive pass. */
	function collapseAllWallets() {
		const next: Record<string, boolean> = {};
		for (const w of wallets) next[w.id] = false;
		expandedWallets = next;
	}
</script>

<svelte:window onkeydown={(e) => {
	// Only react when this switcher is the topmost layer; the AccountPanel's
	// own Escape handler still works because we mark the event consumed.
	if (e.key === 'Escape' && open) {
		close();
		e.stopPropagation();
	}
}} />

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="absolute inset-0 z-50 bg-black/60 backdrop-blur-[4px] flex items-start justify-center p-0 rounded-[inherit]" onclick={close}>
		<div class="ws-sheet absolute top-0 left-0 right-0 w-full bg-background border-b border-line shadow-[0_12px_32px_rgba(0,0,0,0.6)] flex flex-col max-h-full" onclick={(e) => e.stopPropagation()} role="dialog" aria-label="Wallet switcher" tabindex="-1">
			<!-- ── Header ───────────────────────────────────────── -->
			<div class="flex items-center justify-between px-4 pt-3.5 pb-2">
				<div class="font-display text-sm font-extrabold text-heading">{$t('switcher.wallets')}</div>
				<button class="w-7 h-7 rounded-lg border-none bg-surface-input text-dim cursor-pointer flex items-center justify-center transition hover:bg-surface-hover hover:text-heading" onclick={close} aria-label="Close">
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
				</button>
			</div>

			<!-- Search + global settings cog. The cog opens an action
			     sheet with device-wide ops (add/import wallet, change
			     PIN, auto-lock) — they apply to every wallet on this
			     device, so they don't belong in the per-wallet menu. -->
			<div class="flex gap-2 px-4 pb-2.5 items-center">
				<div class="relative flex-1">
					<svg class="absolute left-2.5 top-1/2 -translate-y-[60%] text-dim pointer-events-none" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
					<input
						class="w-full py-2.5 pr-7 pl-8 rounded-[9px] bg-surface-input border border-line text-heading font-mono text-xs outline-none transition-colors duration-[120ms] placeholder:text-dim focus:border-brand-cyan/30"
						placeholder={$t('switcher.searchPlaceholder')}
						bind:value={search}
						{...INPUT_ATTRS}
					/>
					{#if search}
						<button class="absolute right-2 top-1/2 -translate-y-[60%] w-5 h-5 rounded-full border-none bg-surface-hover text-muted cursor-pointer flex items-center justify-center" onclick={() => (search = '')} aria-label="Clear search">
							<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
						</button>
					{/if}
				</div>
				<button
					class="w-9 h-9 shrink-0 rounded-[9px] border border-line bg-surface-input text-muted cursor-pointer flex items-center justify-center transition-colors duration-100 hover:text-heading hover:border-brand-cyan/30"
					onclick={() => { globalSheetOpen = true; }}
					aria-label="Wallet settings"
					title="Wallet settings"
				>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
				</button>
			</div>

			<!-- ── Wallet list (scrollable) ─────────────────────── -->
			<div class="flex-1 overflow-y-auto px-1">
				{#each filteredWallets as w (w.id)}
					{@const isActive = w.id === activeWalletId}
					{@const isExpanded = !!expandedWallets[w.id] || !!search.trim()}
					{@const isRenaming = renamingWalletId === w.id}
					{@const visibleAccounts = accountsForWallet(w)}

					<div class="ws-wallet" class:ws-wallet-active={isActive}>
						<!-- Wallet row — long-press anywhere on the row body to open
						     the wallet action sheet (rename / add account / export
						     seed / change PIN / set primary / delete). The inline
						     gear and edit-name icons were removed in favour of this
						     gesture; chevron stays for expand/collapse. -->
						<div
							class="ws-wallet-row"
							class:ws-pressing={pressingKey === `w:${w.id}`}
							onpointerdown={(e) => lpStartWallet(w, e)}
							onpointermove={lpMove}
							onpointerup={lpEnd}
							onpointercancel={lpEnd}
							onpointerleave={lpEnd}
							oncontextmenu={(e) => ctxWallet(w, e)}
						>
							<button
								class="ws-wallet-toggle"
								onclick={() => toggleExpanded(w.id)}
								aria-label={isExpanded ? 'Collapse' : 'Expand'}
							>
								<svg class="ws-chev" class:ws-chev-open={isExpanded} width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
							</button>
							<div class="ws-wallet-icon">{w.name.charAt(0).toUpperCase()}</div>

							{#if isRenaming}
								<input
									class="ws-rename"
									bind:value={renameWalletValue}
									placeholder={w.name}
									onkeydown={(e) => {
										if (e.key === 'Enter') commitRenameWallet(w.id);
										if (e.key === 'Escape') { renamingWalletId = null; renameWalletValue = ''; }
									}}
									{...INPUT_ATTRS}
								/>
								<button class="ws-icon-btn" onclick={() => commitRenameWallet(w.id)} title="Save">
									<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
								</button>
							{:else}
								<button
									class="ws-wallet-meta"
									onclick={() => handleSwitch(w.id)}
									disabled={switchingId === w.id}
								>
									<span class="ws-wallet-name">
										{w.name}
										{#if w.isPrimary}<span class="ws-badge ws-badge-primary">{$t('switcher.primary')}</span>{/if}
										{#if w.isImported}<span class="ws-badge ws-badge-imported">{$t('switcher.imported')}</span>{/if}
									</span>
									<span class="ws-wallet-sub">{w.accountCount} account{w.accountCount === 1 ? '' : 's'}</span>
								</button>

								<div class="ws-wallet-actions">
									{#if switchingId === w.id}
										<span class="ws-spinner"></span>
									{:else if isActive}
										<span class="ws-active-dot" title="Active"></span>
									{/if}
								</div>
							{/if}
						</div>

						<!-- Accounts (only for active wallet — others show count only) -->
						{#if isExpanded && isActive}
							<div class="ws-accounts">
								{#each visibleAccounts as acc (acc.index)}
									{@const isActiveAcct = acc.index === activeAccountIndex}
									{@const isRenamingAcct = renamingAcct?.walletId === w.id && renamingAcct?.index === acc.index}
									{@const usd = usdByAccount[acc.address.toLowerCase()] || 0}
									{@const av = acctAvatar(w.id, acc.index)}

									<div
										class="ws-acct-row"
										class:ws-pressing={pressingKey === `a:${w.id}:${acc.index}`}
										onpointerdown={(e) => { if (!isRenamingAcct) lpStartAccount(w.id, acc, e); }}
										onpointermove={lpMove}
										onpointerup={lpEnd}
										onpointercancel={lpEnd}
										onpointerleave={lpEnd}
										oncontextmenu={(e) => { if (!isRenamingAcct) ctxAccount(w.id, acc, e); }}
									>
										{#if isRenamingAcct}
												<input
													class="ws-rename ws-rename-acct"
													bind:value={renameAcctValue}
													placeholder={acctName(w.id, acc.index)}
													onkeydown={(e) => {
														if (e.key === 'Enter') commitRenameAccount();
														if (e.key === 'Escape') { renamingAcct = null; renameAcctValue = ''; }
													}}
													{...INPUT_ATTRS}
												/>
												<button class="ws-icon-btn" onclick={commitRenameAccount} title="Save">
													<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
												</button>
											{:else}
												<!-- Avatar lives outside the switch button so we can have its
												     own click target without illegal nested <button> elements. -->
												<!-- svelte-ignore a11y_click_events_have_key_events -->
												<!-- svelte-ignore a11y_no_static_element_interactions -->
												<div
													class="ws-acct-avatar"
													onclick={() => { avatarPickerFor = { walletId: w.id, index: acc.index }; }}
													role="button"
													tabindex="0"
													title="Change avatar"
												>
													{#if av}
														<span class="ws-acct-emoji">{av}</span>
													{:else}
														<span class="ws-acct-num">{acc.index + 1}</span>
													{/if}
												</div>
												<button
													class="ws-acct-btn"
													class:ws-acct-active={isActiveAcct}
													onclick={() => handleSwitchAccount(acc.index)}
												>
													<div class="ws-acct-meta">
														<span class="ws-acct-name">{acctName(w.id, acc.index)}</span>
														<span class="ws-acct-addr">{shortAddr(acc.address)}</span>
													</div>
													<div class="ws-acct-right">
														{#if usd > 0}<span class="ws-acct-usd">{fmtUsd(usd)}</span>{/if}
														{#if isActiveAcct}<span class="ws-acct-check">✓</span>{/if}
													</div>
												</button>
											{/if}
										</div>
								{/each}

								<button class="ws-add-acct" onclick={handleAddAccount} disabled={creatingAccount}>
									<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
									{creatingAccount ? $t('switcher.creatingAccount') : $t('switcher.addAccount')}
								</button>
							</div>
						{:else if isExpanded && !isActive}
							<div class="ws-accounts">
								<p class="ws-acct-locked">Switch to this wallet to view its {w.accountCount} account{w.accountCount === 1 ? '' : 's'}</p>
							</div>
						{/if}
					</div>
				{/each}

				{#if filteredWallets.length === 0}
					<p class="ws-empty">{$t('switcher.noMatches')}</p>
				{/if}
			</div>

			<!-- ── Footer ───────────────────────────────────────── -->
			<div class="ws-footer">
				<button class="ws-foot-lock-link" onclick={() => { lockWallet(); onLock(); close(); }}>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
					{$t('switcher.lock')}
				</button>
				<button class="ws-foot-disconnect-link" onclick={() => { onDisconnect(); close(); }}>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
					{$t('switcher.disconnect')}
				</button>
			</div>

			<!-- ── Add-mode bottom sheet ─────────────────────────────
			     Forms triggered from the global settings cog (create /
			     import / change-pin / auto-lock) and the post-create
			     recovery-codes display all live in a bottom-up sheet
			     that slides over the wallet list. Same shape as the
			     long-press ActionSheets so the UX stays consistent. -->
			{#if addMode !== null || createdCodes.length > 0}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="ws-form-backdrop" onclick={() => { if (!addLoading) { addMode = null; resetAddForm(); } }}>
					<div class="ws-form-sheet" onclick={(e) => e.stopPropagation()}>
						<div class="ws-form-sheet-grab" aria-hidden="true"></div>
						<button class="ws-form-sheet-close" onclick={() => { if (!addLoading) { addMode = null; resetAddForm(); } }} aria-label="Close">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
						</button>
						<div class="ws-form-sheet-body">
				{#if addMode === 'create' && createdCodes.length === 0}
				<div class="ws-form">
					<div class="ws-form-title">{$t('switcher.createNewWallet')}</div>
					<input class="ws-input" placeholder={$t('switcher.walletName')} bind:value={newName} maxlength="40" {...INPUT_ATTRS} />
					<!-- type="text" with CSS masking avoids triggering password
					     manager autofill on this unrelated PIN field. -->
					<input
						class="ws-input"
						type="text"
						inputmode="numeric"
						pattern="[0-9]*"
						style="-webkit-text-security: disc; text-security: disc;"
						placeholder={$t('switcher.yourPin')}
						bind:value={newPin}
						{...INPUT_ATTRS}
					/>
					{#if addError}<p class="ws-error">{addError}</p>{/if}
					<div class="ws-form-btns">
						<button class="ws-btn-s" onclick={() => { addMode = null; resetAddForm(); }}>{$t('switcher.cancel')}</button>
						<button class="ws-btn-s ws-btn-primary" disabled={addLoading} onclick={submitCreate}>
							{addLoading ? $t('switcher.creating') : $t('switcher.create')}
						</button>
					</div>
				</div>
			{:else if createdCodes.length > 0}
				<div class="ws-form">
					<div class="ws-form-title">{$t('switcher.recoveryCodes')}</div>
					<p class="ws-form-hint">{$t('switcher.recoveryCodesHint')}</p>
					<div class="ws-codes">
						{#each createdCodes as code, i}
							<div class="ws-code">{i + 1}. {code}</div>
						{/each}
					</div>
					<div class="ws-form-btns">
						<button class="ws-btn-s ws-btn-primary" onclick={() => { addMode = null; resetAddForm(); }}>{$t('switcher.done')}</button>
					</div>
				</div>
			{:else if addMode === 'import'}
				<div class="ws-form">
					<div class="ws-form-title">{$t('switcher.importWallet')}</div>
					<input class="ws-input" placeholder={$t('switcher.walletName')} bind:value={newName} maxlength="40" {...INPUT_ATTRS} />
					<textarea class="ws-input ws-textarea" rows="3" placeholder={$t('wallet.recoveryPhrasePlaceholder')} bind:value={importMnemonic} {...INPUT_ATTRS}></textarea>
					<label class="ws-ack">
						<input type="checkbox" bind:checked={importAck} />
						<span>{$t('switcher.importAck')}</span>
					</label>
					{#if addError}<p class="ws-error">{addError}</p>{/if}
					<div class="ws-form-btns">
						<button class="ws-btn-s" onclick={() => { addMode = null; resetAddForm(); }}>{$t('switcher.cancel')}</button>
						<button class="ws-btn-s ws-btn-primary" disabled={addLoading} onclick={submitImport}>
							{addLoading ? $t('switcher.importing') : $t('switcher.import')}
						</button>
					</div>
				</div>
			{:else if addMode === 'change-pin'}
				<div class="ws-form">
					<div class="ws-form-title">{$t('switcher.changePin')}</div>
					<p class="ws-form-hint">{$t('switcher.changePinHint')}</p>
					<input
						class="ws-input"
						type="text"
						inputmode="numeric"
						pattern="[0-9]*"
						style="-webkit-text-security: disc; text-security: disc;"
						placeholder={$t('switcher.currentPin')}
						bind:value={currentPinInput}
						{...INPUT_ATTRS}
					/>
					<input
						class="ws-input"
						type="text"
						inputmode="numeric"
						pattern="[0-9]*"
						style="-webkit-text-security: disc; text-security: disc;"
						placeholder={$t('switcher.newPin')}
						bind:value={newPinInput}
						{...INPUT_ATTRS}
					/>
					<input
						class="ws-input"
						type="text"
						inputmode="numeric"
						pattern="[0-9]*"
						style="-webkit-text-security: disc; text-security: disc;"
						placeholder={$t('switcher.confirmNewPin')}
						bind:value={newPinConfirm}
						onkeydown={(e) => { if (e.key === 'Enter') submitChangePin(); }}
						{...INPUT_ATTRS}
					/>
					{#if pinChangeConfirm && !addError}
						<p class="ws-warn">
							This re-encrypts <strong>all {wallets.length} {wallets.length === 1 ? 'wallet' : 'wallets'}</strong> with the new PIN. The new PIN becomes the one you'll enter on every unlock. Continue?
						</p>
					{/if}
					{#if addError}<p class="ws-error">{addError}</p>{/if}
					<div class="ws-form-btns">
						<button class="ws-btn-s" onclick={() => { addMode = null; resetAddForm(); }}>{$t('switcher.cancel')}</button>
						<button class="ws-btn-s ws-btn-primary" disabled={addLoading} onclick={submitChangePin}>
							{addLoading ? $t('switcher.updating') : pinChangeConfirm ? $t('switcher.yesUpdateAll') : $t('switcher.updatePin')}
						</button>
					</div>
				</div>
			{:else if addMode === 'settings'}
				<div class="ws-form">
					<div class="ws-form-title">{$t('switcher.autoLock')}</div>
					<p class="ws-form-hint">{$t('switcher.autoLockHint')}</p>
					<div class="ws-autolock-grid">
						{#each AUTO_LOCK_OPTIONS as opt}
							<button
								class="ws-autolock-btn"
								class:ws-autolock-active={selectedIdleMs === opt.idleMs}
								onclick={() => {
									selectedIdleMs = opt.idleMs;
									const policy = getSessionPolicy();
									setSessionPolicy(opt.idleMs, policy.absoluteMs);
									onFeedback({ message: `Auto-lock set to ${opt.label}`, type: 'success' });
								}}
							>{opt.label}</button>
						{/each}
					</div>
					<div class="ws-form-btns">
						<button class="ws-btn-s" onclick={() => { addMode = null; }}>{$t('switcher.done')}</button>
					</div>
				</div>
				{/if}
						</div>
					</div>
				</div>
			{/if}

			<!-- Avatar picker overlay -->
			{#if avatarPickerFor}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="ws-avatar-overlay" onclick={() => (avatarPickerFor = null)}>
					<div class="ws-avatar-modal" onclick={(e) => e.stopPropagation()}>
						<div class="ws-avatar-title">{$t('switcher.chooseAvatar')}</div>
						<div class="ws-avatar-grid">
							{#each AVATAR_OPTIONS as emoji}
								<button class="ws-avatar-btn" onclick={() => pickAvatar(emoji)}>{emoji}</button>
							{/each}
						</div>
						<button class="ws-avatar-clear" onclick={clearAvatar}>{$t('switcher.resetToNumber')}</button>
					</div>
				</div>
			{/if}

			<!-- Delete-wallet confirm modal. Wallet deletion is irreversible
			     — without the recovery phrase the wallet can never be
			     restored. Two-step UX (intentional friction): first
			     screen forces the user to type the wallet name; second
			     screen asks for the device PIN. No placeholder on the
			     name input — making the operator actually remember the
			     name is part of the safeguard. -->
			{#if deletingTarget}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="ws-avatar-overlay" onclick={dismissDeleteConfirm}>
					<div class="ws-delete-modal" onclick={(e) => e.stopPropagation()}>
						<div class="ws-delete-icon" aria-hidden="true">
							<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2">
								<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
								<line x1="12" y1="9" x2="12" y2="13" />
								<line x1="12" y1="17" x2="12.01" y2="17" />
							</svg>
						</div>

						{#if deleteStep === 'name'}
							<div class="ws-delete-title">Delete this wallet?</div>
							<p class="ws-delete-body">
								This wallet will be removed from this device. Without your recovery phrase you will not be able to restore it. Any tokens or NFTs in this wallet will be inaccessible.
							</p>
							<label class="ws-delete-label" for="ws-del-name">
								Type <strong>{deletingTarget.name}</strong> to confirm
							</label>
							<input
								id="ws-del-name"
								class="ws-delete-input"
								type="text"
								autocomplete="off"
								autocorrect="off"
								autocapitalize="off"
								spellcheck="false"
								bind:value={deleteTypedName}
								disabled={deleting}
								onkeydown={(e) => { if (e.key === 'Enter') advanceToPinStep(); }}
							/>
							{#if deleteError}
								<div class="ws-delete-error">{deleteError}</div>
							{/if}
							<div class="ws-delete-actions">
								<button class="ws-delete-cancel" onclick={dismissDeleteConfirm}>
									Cancel
								</button>
								<button
									class="ws-delete-confirm"
									onclick={advanceToPinStep}
									disabled={deleteTypedName !== deletingTarget.name}
								>
									Delete
								</button>
							</div>
						{:else}
							<div class="ws-delete-title">Enter PIN to confirm</div>
							<p class="ws-delete-body">
								This is your last chance — entering your PIN below will permanently delete <strong>{deletingTarget.name}</strong> from this device.
							</p>
							<label class="ws-delete-label" for="ws-del-pin">Device PIN</label>
							<input
								id="ws-del-pin"
								class="ws-delete-input"
								type="tel"
								inputmode="numeric"
								style="-webkit-text-security: disc; text-security: disc;"
								autocomplete="off"
								bind:value={deletePin}
								disabled={deleting}
								onkeydown={(e) => { if (e.key === 'Enter') confirmDelete(); }}
							/>
							{#if deleteError}
								<div class="ws-delete-error">{deleteError}</div>
							{/if}
							<div class="ws-delete-actions">
								<button class="ws-delete-cancel" onclick={backToNameStep} disabled={deleting}>
									Back
								</button>
								<button
									class="ws-delete-confirm"
									onclick={confirmDelete}
									disabled={deleting || !deletePin}
								>
									{deleting ? 'Deleting…' : 'Delete wallet'}
								</button>
							</div>
						{/if}
					</div>
				</div>
			{/if}
		</div>
	</div>

	<!-- Long-press action sheets — siblings of the switcher backdrop, not
	     children. The backdrop is the slide-down sheet from the top of .ap;
	     mounting the action sheets inside it would confine them to that
	     upper rectangle. As siblings they go absolute relative to the next
	     positioned ancestor (.ap, position: fixed) and slide up from the
	     bottom of the wallet panel — same chrome as RowActionSheet. -->
	<ActionSheet
		bind:open={walletSheetOpen}
		title={walletSheetTarget?.name || ''}
		subtitle={walletSheetTarget ? `${walletSheetTarget.isImported ? 'Imported · ' : ''}${walletSheetTarget.isActive ? 'Active wallet' : 'Locked wallet'}` : ''}
		avatar={walletSheetTarget?.name?.charAt(0).toUpperCase() || ''}
		avatarColor="#00d2ff"
		actions={walletActions}
	/>

	<ActionSheet
		bind:open={accountSheetOpen}
		title={accountSheetTarget?.name || ''}
		subtitle={accountSheetTarget ? shortAddr(accountSheetTarget.address) : ''}
		avatar={accountSheetTarget?.avatar || ''}
		avatarColor="#a78bfa"
		actions={accountActions}
	/>

	<!-- Device-wide settings sheet — opened by the cog next to the
	     search bar. Bottom-up 80vh, same chrome as the per-wallet /
	     per-account sheets so the UX feels consistent. -->
	<ActionSheet
		bind:open={globalSheetOpen}
		title="Wallet settings"
		subtitle="Applies to every wallet on this device"
		avatar="⚙"
		avatarColor="#a78bfa"
		actions={globalSettingsActions}
	/>
{/if}

<style>
	/* Contained overlay — fills the parent AccountPanel rather than the
	   whole viewport. Parent (.ap) is a fixed right-side drawer, so absolute
	   positioning here keeps the switcher inside the wallet container on
	   every screen size. The sheet anchors to the TOP because the chip
	   that opens it lives in the panel header — opening downward keeps the
	   visual flow uninterrupted. */
	.ws-overlay {
		position: absolute; top: 0; left: 0; right: 0; bottom: 0; z-index: 50;
		background: rgba(0,0,0,0.6); backdrop-filter: blur(4px);
		display: flex; align-items: flex-start; justify-content: center;
		padding: 0; border-radius: inherit;
	}
	.ws-sheet {
		position: absolute; top: 0; left: 0; right: 0;
		width: 100%;
		background: var(--bg); border-bottom: 1px solid var(--border);
		box-shadow: 0 12px 32px rgba(0,0,0,0.6);
		display: flex; flex-direction: column;
		max-height: 100%;
		animation: wsSlide 0.22s ease-out;
	}
	@keyframes wsSlide {
		from { transform: translateY(-12px); opacity: 0; }
		to { transform: translateY(0); opacity: 1; }
	}

	.ws-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 8px; }
	.ws-head-title { font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 800; color: var(--text-heading); }
	.ws-x {
		width: 28px; height: 28px; border-radius: 8px; border: none;
		background: var(--bg-surface-input); color: var(--text-dim); cursor: pointer;
		display: flex; align-items: center; justify-content: center; transition: all 0.12s;
	}
	.ws-x:hover { background: var(--bg-surface-hover); color: var(--text-heading); }

	.ws-search-wrap {
		position: relative; padding: 0 16px 10px;
	}
	.ws-search-icon { position: absolute; left: 26px; top: 50%; transform: translateY(-60%); color: var(--text-dim); pointer-events: none; }
	.ws-search {
		width: 100%; padding: 9px 28px 9px 32px; border-radius: 9px;
		background: var(--bg-surface-input); border: 1px solid var(--border);
		color: var(--text-heading); font-family: 'Space Mono', monospace; font-size: 12px;
		outline: none; transition: border-color 0.12s;
	}
	.ws-search:focus { border-color: rgba(0,210,255,0.3); }
	.ws-search::placeholder { color: var(--text-dim); }
	.ws-search-clear {
		position: absolute; right: 22px; top: 50%; transform: translateY(-60%);
		width: 20px; height: 20px; border-radius: 50%; border: none;
		background: var(--bg-surface-hover); color: var(--text-muted); cursor: pointer;
		display: flex; align-items: center; justify-content: center;
	}

	.ws-list {
		flex: 1; overflow-y: auto; padding: 0 4px;
	}
	.ws-empty { text-align: center; padding: 30px; color: var(--text-dim); font-family: 'Space Mono', monospace; font-size: 11px; }

	.ws-wallet {
		margin: 4px 0; border-radius: 10px;
		border: 1px solid transparent;
		background: var(--bg-surface);
	}
	.ws-wallet-active { border-color: rgba(0,210,255,0.18); background: rgba(0,210,255,0.04); }

	.ws-wallet-row {
		display: flex; align-items: center; gap: 6px; padding: 8px 8px 8px 4px;
		transition: transform 0.18s ease;
	}
	.ws-wallet-row.ws-pressing,
	.ws-acct-row.ws-pressing { transform: scale(0.97); }
	.ws-acct-row { transition: transform 0.18s ease; }
	.ws-wallet-toggle {
		width: 22px; height: 22px; border: none; border-radius: 6px;
		background: transparent; color: var(--text-dim); cursor: pointer;
		display: flex; align-items: center; justify-content: center;
	}
	.ws-wallet-toggle:hover { background: var(--bg-surface-input); color: var(--text-heading); }
	.ws-chev { transition: transform 0.15s; }
	.ws-chev-open { transform: rotate(90deg); }

	.ws-wallet-icon {
		width: 30px; height: 30px; border-radius: 8px; flex-shrink: 0;
		background: linear-gradient(135deg, rgba(0,210,255,0.16), rgba(58,123,213,0.16));
		border: 1px solid rgba(0,210,255,0.22);
		display: flex; align-items: center; justify-content: center;
		font-family: 'Syne', sans-serif; font-size: 12px; font-weight: 800; color: #00d2ff;
	}

	.ws-wallet-meta {
		flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start;
		background: none; border: none; cursor: pointer; padding: 0; gap: 1px;
	}
	.ws-wallet-meta:disabled { cursor: progress; }
	.ws-wallet-name {
		font-family: 'Syne', sans-serif; font-size: 12px; font-weight: 700; color: var(--text);
		display: flex; align-items: center; gap: 6px;
	}
	.ws-wallet-sub { font-family: 'Space Mono', monospace; font-size: 9px; color: var(--text-dim); }

	.ws-badge {
		font-family: 'Space Mono', monospace; font-size: 7px; font-weight: 700;
		padding: 1px 5px; border-radius: 3px; text-transform: uppercase; letter-spacing: 0.05em;
	}
	.ws-badge-primary { background: rgba(16,185,129,0.12); color: #10b981; }
	.ws-badge-imported { background: rgba(251,191,36,0.12); color: #fbbf24; border: 1px solid rgba(251,191,36,0.25); }

	.ws-wallet-actions { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
	.ws-active-dot { width: 6px; height: 6px; border-radius: 50%; background: #10b981; box-shadow: 0 0 6px rgba(16,185,129,0.6); margin: 0 4px; }

	.ws-icon-btn {
		width: 32px; height: 32px; border-radius: 6px; border: none;
		background: transparent; color: var(--text-dim); cursor: pointer;
		display: flex; align-items: center; justify-content: center;
		transition: all 0.12s; flex-shrink: 0; position: relative; overflow: hidden;
	}
	.ws-icon-btn:hover { background: var(--bg-surface-hover); color: var(--text-muted); }

	.ws-rename {
		flex: 1; padding: 6px 10px; border-radius: 6px;
		background: var(--bg-surface-hover); border: 1px solid rgba(0,210,255,0.3);
		color: var(--text-heading); font-family: 'Syne', sans-serif; font-size: 12px; font-weight: 600;
		outline: none;
	}
	.ws-rename-acct { font-size: 11px; }

	.ws-spinner {
		width: 11px; height: 11px; border-radius: 50%;
		border: 1.5px solid var(--border-input); border-top-color: #00d2ff;
		animation: wsSpin 0.8s linear infinite; margin: 0 4px;
	}
	@keyframes wsSpin { to { transform: rotate(360deg); } }

	/* Accounts (nested under wallet). Full-width rows — the dashed
	   top border alone communicates the parent-child relationship. */
	.ws-accounts {
		padding: 6px 6px 8px 6px;
		margin: 2px 4px 0 4px;
		display: flex; flex-direction: column; gap: 2px;
		border-top: 1px dashed var(--border-subtle);
	}
	.ws-acct-row { display: flex; align-items: center; gap: 2px; }
	.ws-acct-btn {
		flex: 1; min-width: 0;
		display: flex; align-items: center; gap: 8px;
		padding: 6px 8px; border-radius: 7px; border: none;
		background: transparent; color: var(--text-muted); cursor: pointer;
		font-family: inherit; transition: background 0.1s;
	}
	.ws-acct-btn:hover { background: var(--bg-surface); }
	.ws-acct-active { background: rgba(0,210,255,0.06) !important; color: #00d2ff; }
	.ws-acct-avatar {
		width: 26px; height: 26px; border-radius: 50%; flex-shrink: 0;
		background: rgba(0,210,255,0.1); border: 1px solid rgba(0,210,255,0.2);
		display: flex; align-items: center; justify-content: center;
		cursor: pointer; padding: 0;
	}
	.ws-acct-avatar:hover { background: rgba(0,210,255,0.18); }
	.ws-acct-emoji { font-size: 14px; line-height: 1; }
	.ws-acct-num { font-family: 'Syne', sans-serif; font-size: 10px; font-weight: 800; color: #00d2ff; }
	.ws-acct-meta { flex: 1; min-width: 0; text-align: left; display: flex; flex-direction: column; gap: 1px; }
	.ws-acct-name { font-family: 'Syne', sans-serif; font-size: 11px; font-weight: 600; color: var(--text); }
	.ws-acct-addr { font-family: 'Space Mono', monospace; font-size: 8px; color: var(--text-dim); }
	.ws-acct-right { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
	.ws-acct-usd { font-family: 'Rajdhani', sans-serif; font-size: 11px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
	.ws-acct-check { font-size: 10px; color: #10b981; }
	.ws-acct-actions { display: flex; flex-shrink: 0; }

	.ws-acct-locked { font-family: 'Space Mono', monospace; font-size: 9px; color: var(--text-dim); padding: 4px 8px; margin: 0; }

	.ws-add-acct {
		display: flex; align-items: center; justify-content: center; gap: 4px;
		padding: 7px; margin-top: 4px;
		background: transparent; border: 1px dashed rgba(0,210,255,0.18); border-radius: 7px;
		color: #00d2ff; cursor: pointer; font-family: 'Space Mono', monospace; font-size: 10px;
		transition: all 0.12s;
	}
	.ws-add-acct:hover { background: rgba(0,210,255,0.05); border-color: rgba(0,210,255,0.35); }

	/* Footer — single terminal action. */
	.ws-footer {
		padding: 10px 14px 14px;
		border-top: 1px solid var(--border-subtle);
	}
	/* Footer: two side-by-side buttons — Lock (neutral) + Disconnect (red) */
	.ws-footer { display: flex; gap: 8px; }
	.ws-foot-lock-link {
		display: flex; align-items: center; justify-content: center; gap: 6px;
		flex: 1; padding: 11px 10px; border-radius: 9px;
		background: var(--bg-surface);
		border: 1px solid var(--border);
		color: var(--text-muted); cursor: pointer;
		font-family: 'Syne', sans-serif; font-size: 12px; font-weight: 700;
		transition: all 0.12s;
	}
	.ws-foot-lock-link:hover {
		background: var(--bg-surface-hover);
		border-color: var(--text-dim);
		color: var(--text);
	}
	.ws-foot-lock-link svg { width: 14px; height: 14px; }
	.ws-foot-disconnect-link {
		display: flex; align-items: center; justify-content: center; gap: 6px;
		flex: 1; padding: 11px 10px; border-radius: 9px;
		background: rgba(248,113,113,0.04);
		border: 1px solid rgba(248,113,113,0.18);
		color: #f87171; cursor: pointer;
		font-family: 'Syne', sans-serif; font-size: 12px; font-weight: 700;
		transition: all 0.12s;
	}
	.ws-foot-disconnect-link:hover {
		background: rgba(248,113,113,0.1);
		border-color: rgba(248,113,113,0.35);
	}
	.ws-foot-disconnect-link svg { width: 14px; height: 14px; }

	/* Auto-lock settings grid */
	.ws-autolock-grid {
		display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px;
	}
	.ws-autolock-btn {
		padding: 10px 6px; border-radius: 8px; border: 1px solid var(--border);
		background: var(--bg-surface); color: var(--text-muted); cursor: pointer;
		font-family: 'Space Mono', monospace; font-size: 11px; font-weight: 600;
		transition: all 0.12s;
	}
	.ws-autolock-btn:hover { border-color: rgba(0,210,255,0.2); color: var(--text); }
	.ws-autolock-active {
		border-color: rgba(0,210,255,0.4); background: rgba(0,210,255,0.1); color: #00d2ff;
	}

	/* Wallet settings action sheet — centered overlay, rendered outside
	   the scrollable list so it never gets clipped. Mirrors the pattern
	   used by the avatar picker. */
	.ws-icon-btn-active { background: rgba(0,210,255,0.1); color: #00d2ff; }
	.ws-sheet-backdrop {
		position: absolute; inset: 0; z-index: 5;
		background: rgba(0,0,0,0.55); backdrop-filter: blur(3px);
		display: flex; align-items: center; justify-content: center;
		border-radius: inherit; padding: 20px;
	}
	.ws-sheet-menu {
		width: 100%; max-width: 280px;
		background: var(--bg); border: 1px solid var(--border);
		border-radius: 12px; padding: 6px;
		box-shadow: 0 12px 32px rgba(0,0,0,0.6);
		display: flex; flex-direction: column; gap: 1px;
	}
	.ws-sheet-menu-title {
		font-family: 'Syne', sans-serif; font-size: 11px; font-weight: 800;
		color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.08em;
		padding: 8px 12px 4px;
	}
	.ws-menu-item {
		display: flex; align-items: center; gap: 10px;
		width: 100%; padding: 9px 10px; border: none; border-radius: 7px;
		background: transparent; color: var(--text-muted); cursor: pointer;
		font-family: 'Space Mono', monospace; font-size: 11px; text-align: left;
		transition: all 0.12s;
	}
	.ws-menu-item:hover { background: rgba(0,210,255,0.06); color: #00d2ff; }
	.ws-menu-item-danger { color: #f87171; }
	.ws-menu-item-danger:hover { background: rgba(248,113,113,0.08); color: #f87171; }
	.ws-menu-sub {
		margin-left: auto; font-size: 9px; color: var(--text-dim);
	}
	.ws-menu-divider {
		height: 1px; background: var(--bg-surface-hover); margin: 3px 4px;
	}

	/* Bottom-up sheet hosting all addMode forms. Anchored to the
	   viewport (position: fixed) so it matches the size + chrome of
	   the cog's ActionSheet — being constrained to the wallet
	   switcher's auto-sized content area made it look like a tiny
	   popover instead of a proper sheet. */
	.ws-form-backdrop {
		position: fixed; inset: 0; z-index: 60;
		background: rgba(0,0,0,0.55); backdrop-filter: blur(3px);
		display: flex; align-items: flex-end; justify-content: center;
		animation: wsFormFade 0.18s ease-out;
	}
	.ws-form-sheet {
		position: relative;
		width: 100%; height: 80vh; max-height: 80%;
		background: var(--bg);
		border-top: 1px solid var(--border);
		border-radius: 16px 16px 0 0;
		box-shadow: 0 -8px 24px rgba(0,0,0,0.4);
		display: flex; flex-direction: column;
		animation: wsFormSlideUp 0.22s ease-out;
		overflow: hidden;
	}
	.ws-form-sheet-grab {
		width: 36px; height: 4px; border-radius: 2px;
		background: var(--bg-surface-hover); margin: 8px auto 0;
	}
	.ws-form-sheet-close {
		position: absolute; top: 10px; right: 12px; z-index: 1;
		width: 28px; height: 28px; border-radius: 8px; border: none;
		background: var(--bg-surface-input); color: var(--text-dim); cursor: pointer;
		display: flex; align-items: center; justify-content: center; transition: all 0.12s;
	}
	.ws-form-sheet-close:hover { background: var(--bg-surface-hover); color: var(--text-heading); }
	.ws-form-sheet-body { flex: 1; overflow-y: auto; }
	.ws-form-sheet-body .ws-form { background: transparent; border-top: none; }
	@keyframes wsFormSlideUp {
		from { transform: translateY(100%); }
		to { transform: translateY(0); }
	}
	@keyframes wsFormFade {
		from { opacity: 0; }
		to { opacity: 1; }
	}

	/* Form (create / import / codes) */
	.ws-form {
		padding: 12px 16px 16px;
		display: flex; flex-direction: column; gap: 8px;
		background: rgba(0,210,255,0.03); border-top: 1px solid rgba(0,210,255,0.08);
	}
	.ws-form-title { font-family: 'Syne', sans-serif; font-size: 12px; font-weight: 700; color: var(--text-heading); }
	.ws-form-hint { font-family: 'Space Mono', monospace; font-size: 9px; color: var(--text-dim); margin: 0; line-height: 1.5; }
	.ws-input {
		width: 100%; padding: 9px 12px; border-radius: 8px;
		background: var(--bg-surface-input); border: 1px solid var(--border);
		color: var(--text-heading); font-family: 'Space Mono', monospace; font-size: 12px;
		outline: none; transition: border-color 0.12s;
	}
	.ws-input:focus { border-color: rgba(0,210,255,0.3); }
	.ws-input::placeholder { color: var(--text-dim); }
	.ws-textarea { resize: vertical; line-height: 1.5; }
	.ws-ack {
		display: flex; gap: 6px; align-items: flex-start;
		font-family: 'Space Mono', monospace; font-size: 9px; color: var(--text-muted);
		line-height: 1.4; cursor: pointer;
	}
	.ws-ack input { accent-color: #00d2ff; flex-shrink: 0; margin-top: 1px; }
	.ws-error {
		font-family: 'Space Mono', monospace; font-size: 10px; color: #f87171;
		margin: 0; padding: 4px 8px; background: rgba(248,113,113,0.06); border-radius: 4px;
	}
	.ws-warn {
		font-family: 'Space Mono', monospace; font-size: 10px; color: #fbbf24;
		margin: 0; padding: 8px 10px; background: rgba(251,191,36,0.08);
		border: 1px solid rgba(251,191,36,0.25); border-radius: 6px; line-height: 1.5;
	}
	.ws-warn strong { color: #fde68a; font-weight: 700; }
	.ws-form-btns { display: flex; gap: 8px; justify-content: flex-end; }
	.ws-btn-s {
		padding: 7px 14px; font-size: 11px; border-radius: 7px;
		border: 1px solid var(--border); background: var(--bg-surface);
		color: var(--text-muted); cursor: pointer; font-family: 'Space Mono', monospace; transition: all 0.12s;
	}
	.ws-btn-s:hover { background: var(--bg-surface-hover); color: var(--text-heading); }
	.ws-btn-primary {
		background: linear-gradient(135deg, #00d2ff, #3a7bd5); border: none; color: white;
		font-family: 'Syne', sans-serif; font-weight: 700;
	}
	.ws-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
	.ws-codes {
		display: flex; flex-direction: column; gap: 4px;
		padding: 8px 10px; background: rgba(16,185,129,0.06);
		border: 1px solid rgba(16,185,129,0.18); border-radius: 7px;
	}
	.ws-code { font-family: 'Space Mono', monospace; font-size: 11px; color: #10b981; letter-spacing: 0.03em; }

	/* Avatar picker */
	.ws-avatar-overlay {
		position: absolute; inset: 0; z-index: 5;
		background: rgba(0,0,0,0.5); backdrop-filter: blur(2px);
		display: flex; align-items: center; justify-content: center;
		border-radius: inherit;
	}
	.ws-avatar-modal {
		background: var(--bg); border: 1px solid var(--border);
		border-radius: 12px; padding: 14px; min-width: 240px;
		display: flex; flex-direction: column; gap: 10px;
	}
	.ws-avatar-title { font-family: 'Syne', sans-serif; font-size: 12px; font-weight: 700; color: var(--text-heading); }
	.ws-avatar-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px; }
	.ws-avatar-btn {
		width: 32px; height: 32px; border-radius: 8px;
		background: var(--bg-surface-input); border: 1px solid var(--border);
		font-size: 18px; cursor: pointer; transition: all 0.12s;
		display: flex; align-items: center; justify-content: center;
	}
	.ws-avatar-btn:hover { background: rgba(0,210,255,0.1); border-color: rgba(0,210,255,0.3); }
	.ws-avatar-clear {
		padding: 6px; border: none; background: var(--bg-surface-input); border-radius: 6px;
		color: var(--text-dim); cursor: pointer; font-family: 'Space Mono', monospace; font-size: 10px;
	}
	.ws-avatar-clear:hover { background: var(--bg-surface-hover); color: var(--text-heading); }

	/* Delete-wallet confirm modal — uses the same overlay/backdrop as
	   the avatar picker so it stacks correctly inside the switcher's
	   contained scope. The body is intentionally narrow to keep the
	   warning legible without sprawling. */
	.ws-delete-modal {
		background: var(--bg); border: 1px solid rgba(248,113,113,0.25);
		border-radius: 14px; padding: 18px 16px 16px; width: min(320px, calc(100% - 32px));
		display: flex; flex-direction: column; gap: 10px;
		box-shadow: 0 18px 40px rgba(0,0,0,0.5);
	}
	.ws-delete-icon {
		align-self: center;
		width: 44px; height: 44px; border-radius: 50%;
		background: rgba(248,113,113,0.08);
		display: flex; align-items: center; justify-content: center;
		margin-bottom: 2px;
	}
	.ws-delete-title {
		font-family: 'Syne', sans-serif; font-size: 15px; font-weight: 800;
		color: var(--text-heading); text-align: center;
	}
	.ws-delete-body {
		margin: 0 0 4px; font-family: 'Space Mono', monospace;
		font-size: 11px; line-height: 1.55;
		color: var(--text-muted); text-align: center;
	}
	.ws-delete-label {
		font-family: 'Space Mono', monospace; font-size: 10px;
		color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em;
		margin-top: 4px;
	}
	.ws-delete-label strong { color: var(--text-heading); font-weight: 700; }
	.ws-delete-input {
		width: 100%; padding: 9px 10px; border-radius: 8px; box-sizing: border-box;
		background: var(--bg-surface-input); border: 1px solid var(--border);
		color: var(--text-heading); font-family: 'Space Mono', monospace; font-size: 12px;
		outline: none; transition: border-color 0.12s;
	}
	.ws-delete-input:focus { border-color: rgba(248,113,113,0.4); }
	.ws-delete-input:disabled { opacity: 0.6; cursor: not-allowed; }
	.ws-delete-error {
		font-family: 'Space Mono', monospace; font-size: 10px;
		color: #f87171; padding: 6px 8px; border-radius: 6px;
		background: rgba(248,113,113,0.06);
	}
	.ws-delete-actions { display: flex; gap: 8px; margin-top: 6px; }
	.ws-delete-cancel, .ws-delete-confirm {
		flex: 1; padding: 10px; border: none; border-radius: 9px;
		font-family: 'Syne', sans-serif; font-size: 12px; font-weight: 700;
		cursor: pointer; transition: all 0.12s;
	}
	.ws-delete-cancel { background: var(--bg-surface-input); color: var(--text-heading); }
	.ws-delete-cancel:hover:not(:disabled) { background: var(--bg-surface-hover); }
	.ws-delete-confirm {
		background: linear-gradient(135deg, #ef4444, #b91c1c); color: white;
	}
	.ws-delete-confirm:hover:not(:disabled) { filter: brightness(1.08); }
	.ws-delete-confirm:disabled, .ws-delete-cancel:disabled {
		opacity: 0.5; cursor: not-allowed;
	}
</style>
