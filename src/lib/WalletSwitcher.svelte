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
		type WalletState,
	} from './embeddedWallet';
	import { friendlyError } from './errorDecoder';

	let {
		open = $bindable(false),
		usdByAccount = {} as Record<string, number>,
		onAccountSwitched = (_addr: string) => {},
		onFeedback = (_: { message: string; type: string }) => {},
		onExportSeed = () => {},
		onExportKey = () => {},
		onDisconnect = () => {},
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

	// Hold-to-delete progress (0..1)
	let holdProgress = $state(0);
	let holdTargetId = $state<string | null>(null);
	let holdTimer: ReturnType<typeof setInterval> | null = null;
	const HOLD_MS = 1500;

	// Add-wallet form state
	let addMode = $state<'create' | 'import' | 'change-pin' | null>(null);
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

	// Per-wallet cog menu (single popover — only one open at a time).
	let menuForWallet = $state<string | null>(null);

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
		cancelHold();
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

	// Hold-to-delete: start a timer, animate progress, fire delete on completion.
	function startHold(id: string) {
		holdTargetId = id;
		holdProgress = 0;
		const start = Date.now();
		holdTimer = setInterval(() => {
			const elapsed = Date.now() - start;
			holdProgress = Math.min(1, elapsed / HOLD_MS);
			if (holdProgress >= 1) {
				cancelHold();
				confirmDelete(id);
			}
		}, 16);
	}

	function cancelHold() {
		if (holdTimer) {
			clearInterval(holdTimer);
			holdTimer = null;
		}
		holdProgress = 0;
		holdTargetId = null;
	}

	async function confirmDelete(id: string) {
		const w = wallets.find((x) => x.id === id);
		if (!w) return;
		try {
			await deleteWallet(id);
			onFeedback({ message: `Wallet "${w.name}" deleted`, type: 'success' });
		} catch (e) {
			onFeedback({ message: friendlyError(e), type: 'error' });
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

	function shortAddr(a: string): string {
		if (!a) return '';
		return a.slice(0, 6) + '…' + a.slice(-4);
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
	<div class="ws-overlay" onclick={close}>
		<div class="ws-sheet" onclick={(e) => e.stopPropagation()} role="dialog" aria-label="Wallet switcher" tabindex="-1">
			<!-- ── Header ───────────────────────────────────────── -->
			<div class="ws-head">
				<div class="ws-head-title">Wallets</div>
				<button class="ws-x" onclick={close} aria-label="Close">
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
				</button>
			</div>

			<!-- Search -->
			<div class="ws-search-wrap">
				<svg class="ws-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
				<input
					class="ws-search"
					placeholder="Search wallets & accounts"
					bind:value={search}
					{...INPUT_ATTRS}
				/>
				{#if search}
					<button class="ws-search-clear" onclick={() => (search = '')} aria-label="Clear search">
						<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
					</button>
				{/if}
			</div>

			<!-- ── Wallet list (scrollable) ─────────────────────── -->
			<div class="ws-list">
				{#each filteredWallets as w (w.id)}
					{@const isActive = w.id === activeWalletId}
					{@const isExpanded = !!expandedWallets[w.id] || !!search.trim()}
					{@const isRenaming = renamingWalletId === w.id}
					{@const visibleAccounts = accountsForWallet(w)}

					<div class="ws-wallet" class:ws-wallet-active={isActive}>
						<!-- Wallet row -->
						<div class="ws-wallet-row">
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
										{#if w.isPrimary}<span class="ws-badge ws-badge-primary">primary</span>{/if}
										{#if w.isImported}<span class="ws-badge ws-badge-imported">imported</span>{/if}
									</span>
									<span class="ws-wallet-sub">{w.accountCount} account{w.accountCount === 1 ? '' : 's'}</span>
								</button>

								<div class="ws-wallet-actions">
									{#if switchingId === w.id}
										<span class="ws-spinner"></span>
									{:else if isActive}
										<span class="ws-active-dot" title="Active"></span>
									{/if}
									<button class="ws-icon-btn" title="Rename" onclick={(e) => { e.stopPropagation(); renamingWalletId = w.id; renameWalletValue = w.name; }}>
										<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
									</button>
									<!-- Wallet settings cog — opens popover with export seed /
									     export private key / set primary / delete. Export
									     actions are only shown for the active wallet since
									     only its seed is in memory. -->
									<button
										class="ws-icon-btn"
										class:ws-icon-btn-active={menuForWallet === w.id}
										title="Wallet settings"
										onclick={(e) => { e.stopPropagation(); menuForWallet = menuForWallet === w.id ? null : w.id; }}
									>
										<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
									</button>
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

									<div class="ws-acct-row">
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

												<div class="ws-acct-actions">
													<button class="ws-icon-btn" title="Rename account" onclick={() => { renamingAcct = { walletId: w.id, index: acc.index }; renameAcctValue = acctName(w.id, acc.index); }}>
														<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
													</button>
													<!-- Per-account private key export. Switches to this
													     account first so the export view reads the
													     correct key, then navigates and closes the sheet. -->
													<button class="ws-icon-btn" title="Export private key" onclick={() => { setActiveAccount(acc.index); onExportKey(); close(); }}>
														<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
													</button>
												</div>
											{/if}
										</div>
								{/each}

								<button class="ws-add-acct" onclick={handleAddAccount} disabled={creatingAccount}>
									<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
									{creatingAccount ? 'Creating…' : 'Add account'}
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
					<p class="ws-empty">No matches</p>
				{/if}
			</div>

			<!-- ── Footer: disconnect only ──────────────────────── -->
			<!-- New/Import wallet live in the active wallet's cog menu so
			     the footer has exactly one action: terminal disconnect. -->
			{#if addMode === null && createdCodes.length === 0}
				<div class="ws-footer">
					<button class="ws-foot-disconnect-link" onclick={() => { onDisconnect(); close(); }}>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
						Disconnect wallet
					</button>
				</div>
			{:else if addMode === 'create' && createdCodes.length === 0}
				<div class="ws-form">
					<div class="ws-form-title">Create new wallet</div>
					<input class="ws-input" placeholder="Wallet name" bind:value={newName} maxlength="40" {...INPUT_ATTRS} />
					<!-- type="text" with CSS masking avoids triggering password
					     manager autofill on this unrelated PIN field. -->
					<input
						class="ws-input"
						type="text"
						inputmode="numeric"
						pattern="[0-9]*"
						style="-webkit-text-security: disc; text-security: disc;"
						placeholder="Your PIN"
						bind:value={newPin}
						{...INPUT_ATTRS}
					/>
					{#if addError}<p class="ws-error">{addError}</p>{/if}
					<div class="ws-form-btns">
						<button class="ws-btn-s" onclick={() => { addMode = null; resetAddForm(); }}>Cancel</button>
						<button class="ws-btn-s ws-btn-primary" disabled={addLoading} onclick={submitCreate}>
							{addLoading ? 'Creating…' : 'Create'}
						</button>
					</div>
				</div>
			{:else if createdCodes.length > 0}
				<div class="ws-form">
					<div class="ws-form-title">Recovery codes</div>
					<p class="ws-form-hint">Save these. Each can unlock this wallet if you forget your PIN. They won't be shown again.</p>
					<div class="ws-codes">
						{#each createdCodes as code, i}
							<div class="ws-code">{i + 1}. {code}</div>
						{/each}
					</div>
					<div class="ws-form-btns">
						<button class="ws-btn-s ws-btn-primary" onclick={() => { addMode = null; resetAddForm(); }}>Done</button>
					</div>
				</div>
			{:else if addMode === 'import'}
				<div class="ws-form">
					<div class="ws-form-title">Import existing wallet</div>
					<input class="ws-input" placeholder="Wallet name" bind:value={newName} maxlength="40" {...INPUT_ATTRS} />
					<textarea class="ws-input ws-textarea" rows="3" placeholder="12 or 24 word recovery phrase" bind:value={importMnemonic} {...INPUT_ATTRS}></textarea>
					<label class="ws-ack">
						<input type="checkbox" bind:checked={importAck} />
						<span>Imported wallets have no platform recovery — I have my own backup.</span>
					</label>
					{#if addError}<p class="ws-error">{addError}</p>{/if}
					<div class="ws-form-btns">
						<button class="ws-btn-s" onclick={() => { addMode = null; resetAddForm(); }}>Cancel</button>
						<button class="ws-btn-s ws-btn-primary" disabled={addLoading} onclick={submitImport}>
							{addLoading ? 'Importing…' : 'Import'}
						</button>
					</div>
				</div>
			{:else if addMode === 'change-pin'}
				<div class="ws-form">
					<div class="ws-form-title">Change PIN</div>
					<p class="ws-form-hint">Re-encrypts every wallet with the new PIN. Your recovery codes still work with the same codes — they're independent of the PIN.</p>
					<input
						class="ws-input"
						type="text"
						inputmode="numeric"
						pattern="[0-9]*"
						style="-webkit-text-security: disc; text-security: disc;"
						placeholder="Current PIN"
						bind:value={currentPinInput}
						{...INPUT_ATTRS}
					/>
					<input
						class="ws-input"
						type="text"
						inputmode="numeric"
						pattern="[0-9]*"
						style="-webkit-text-security: disc; text-security: disc;"
						placeholder="New PIN (6+ digits)"
						bind:value={newPinInput}
						{...INPUT_ATTRS}
					/>
					<input
						class="ws-input"
						type="text"
						inputmode="numeric"
						pattern="[0-9]*"
						style="-webkit-text-security: disc; text-security: disc;"
						placeholder="Confirm new PIN"
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
						<button class="ws-btn-s" onclick={() => { addMode = null; resetAddForm(); }}>Cancel</button>
						<button class="ws-btn-s ws-btn-primary" disabled={addLoading} onclick={submitChangePin}>
							{addLoading ? 'Updating…' : pinChangeConfirm ? 'Yes, update all' : 'Update PIN'}
						</button>
					</div>
				</div>
			{/if}

			<!-- Wallet settings action sheet — single instance, centered in
			     the switcher. Renders outside the scrollable list so it
			     can't be clipped. -->
			{#if menuForWallet}
				{@const menuWallet = wallets.find((w) => w.id === menuForWallet)}
				{#if menuWallet}
					{@const menuIsActive = menuWallet.id === activeWalletId}
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div class="ws-sheet-backdrop" onclick={() => (menuForWallet = null)}>
						<div class="ws-sheet-menu" onclick={(e) => e.stopPropagation()}>
							<div class="ws-sheet-menu-title">{menuWallet.name}</div>
							{#if menuIsActive}
								<button class="ws-menu-item" onclick={() => { menuForWallet = null; onExportSeed(); close(); }}>
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20h16M4 4h16M6 8h12v8H6z"/></svg>
									Export recovery phrase
								</button>
								<button class="ws-menu-item" onclick={() => { menuForWallet = null; resetAddForm(); addMode = 'change-pin'; collapseAllWallets(); }}>
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
									Change PIN
									<span class="ws-menu-sub">re-encrypts all wallets</span>
								</button>
							{/if}
							{#if !menuWallet.isPrimary}
								{#if menuIsActive}<div class="ws-menu-divider"></div>{/if}
								<button class="ws-menu-item" onclick={() => { const id = menuWallet.id; menuForWallet = null; handleSetPrimary(id); }}>
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
									Set as primary
								</button>
							{/if}
							{#if menuIsActive}
								<div class="ws-menu-divider"></div>
								<!-- Collapse every wallet (explicit false so the auto-expand
								     effect doesn't re-open the active one) so the create
								     /import form has the full sheet height and focus
								     lands on the input. -->
								<button class="ws-menu-item" onclick={() => { menuForWallet = null; resetAddForm(); addMode = 'create'; newName = `Wallet ${wallets.length + 1}`; collapseAllWallets(); }}>
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
									New wallet
								</button>
								<button class="ws-menu-item" onclick={() => { menuForWallet = null; resetAddForm(); addMode = 'import'; newName = `Imported ${wallets.length + 1}`; collapseAllWallets(); }}>
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
									Import wallet
								</button>
							{/if}
							{#if wallets.length > 1 && !menuWallet.isPrimary}
								<div class="ws-menu-divider"></div>
								<button class="ws-menu-item ws-menu-item-danger" onclick={() => { const id = menuWallet.id; menuForWallet = null; confirmDelete(id); }}>
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
								Delete wallet
							</button>
							{/if}
						</div>
					</div>
				{/if}
			{/if}

			<!-- Avatar picker overlay -->
			{#if avatarPickerFor}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="ws-avatar-overlay" onclick={() => (avatarPickerFor = null)}>
					<div class="ws-avatar-modal" onclick={(e) => e.stopPropagation()}>
						<div class="ws-avatar-title">Choose avatar</div>
						<div class="ws-avatar-grid">
							{#each AVATAR_OPTIONS as emoji}
								<button class="ws-avatar-btn" onclick={() => pickAvatar(emoji)}>{emoji}</button>
							{/each}
						</div>
						<button class="ws-avatar-clear" onclick={clearAvatar}>Reset to number</button>
					</div>
				</div>
			{/if}
		</div>
	</div>
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
		background: #0a0b10; border-bottom: 1px solid rgba(255,255,255,0.08);
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
	.ws-head-title { font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 800; color: #fff; }
	.ws-x {
		width: 28px; height: 28px; border-radius: 8px; border: none;
		background: rgba(255,255,255,0.04); color: #64748b; cursor: pointer;
		display: flex; align-items: center; justify-content: center; transition: all 0.12s;
	}
	.ws-x:hover { background: rgba(255,255,255,0.08); color: #fff; }

	.ws-search-wrap {
		position: relative; padding: 0 16px 10px;
	}
	.ws-search-icon { position: absolute; left: 26px; top: 50%; transform: translateY(-60%); color: #475569; pointer-events: none; }
	.ws-search {
		width: 100%; padding: 9px 28px 9px 32px; border-radius: 9px;
		background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06);
		color: #fff; font-family: 'Space Mono', monospace; font-size: 12px;
		outline: none; transition: border-color 0.12s;
	}
	.ws-search:focus { border-color: rgba(0,210,255,0.3); }
	.ws-search::placeholder { color: #374151; }
	.ws-search-clear {
		position: absolute; right: 22px; top: 50%; transform: translateY(-60%);
		width: 20px; height: 20px; border-radius: 50%; border: none;
		background: rgba(255,255,255,0.06); color: #94a3b8; cursor: pointer;
		display: flex; align-items: center; justify-content: center;
	}

	.ws-list {
		flex: 1; overflow-y: auto; padding: 0 4px;
	}
	.ws-empty { text-align: center; padding: 30px; color: #475569; font-family: 'Space Mono', monospace; font-size: 11px; }

	.ws-wallet {
		margin: 4px 0; border-radius: 10px;
		border: 1px solid transparent;
		background: rgba(255,255,255,0.015);
	}
	.ws-wallet-active { border-color: rgba(0,210,255,0.18); background: rgba(0,210,255,0.04); }

	.ws-wallet-row {
		display: flex; align-items: center; gap: 6px; padding: 8px 8px 8px 4px;
	}
	.ws-wallet-toggle {
		width: 22px; height: 22px; border: none; border-radius: 6px;
		background: transparent; color: #475569; cursor: pointer;
		display: flex; align-items: center; justify-content: center;
	}
	.ws-wallet-toggle:hover { background: rgba(255,255,255,0.04); color: #fff; }
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
		font-family: 'Syne', sans-serif; font-size: 12px; font-weight: 700; color: #e2e8f0;
		display: flex; align-items: center; gap: 6px;
	}
	.ws-wallet-sub { font-family: 'Space Mono', monospace; font-size: 9px; color: #475569; }

	.ws-badge {
		font-family: 'Space Mono', monospace; font-size: 7px; font-weight: 700;
		padding: 1px 5px; border-radius: 3px; text-transform: uppercase; letter-spacing: 0.05em;
	}
	.ws-badge-primary { background: rgba(16,185,129,0.12); color: #10b981; }
	.ws-badge-imported { background: rgba(251,191,36,0.12); color: #fbbf24; border: 1px solid rgba(251,191,36,0.25); }

	.ws-wallet-actions { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
	.ws-active-dot { width: 6px; height: 6px; border-radius: 50%; background: #10b981; box-shadow: 0 0 6px rgba(16,185,129,0.6); margin: 0 4px; }

	.ws-icon-btn {
		width: 26px; height: 26px; border-radius: 6px; border: none;
		background: transparent; color: #475569; cursor: pointer;
		display: flex; align-items: center; justify-content: center;
		transition: all 0.12s; flex-shrink: 0; position: relative; overflow: hidden;
	}
	.ws-icon-btn:hover { background: rgba(255,255,255,0.05); color: #94a3b8; }

	.ws-hold-btn { position: relative; }
	.ws-hold-active { background: rgba(248,113,113,0.08); }
	.ws-hold-fill {
		position: absolute; inset: 0; background: rgba(248,113,113,0.25);
		transform-origin: bottom; pointer-events: none; transition: transform 16ms linear;
	}

	.ws-rename {
		flex: 1; padding: 6px 10px; border-radius: 6px;
		background: rgba(255,255,255,0.05); border: 1px solid rgba(0,210,255,0.3);
		color: #fff; font-family: 'Syne', sans-serif; font-size: 12px; font-weight: 600;
		outline: none;
	}
	.ws-rename-acct { font-size: 11px; }

	.ws-spinner {
		width: 11px; height: 11px; border-radius: 50%;
		border: 1.5px solid rgba(255,255,255,0.1); border-top-color: #00d2ff;
		animation: wsSpin 0.8s linear infinite; margin: 0 4px;
	}
	@keyframes wsSpin { to { transform: rotate(360deg); } }

	/* Accounts (nested under wallet). Full-width rows — the dashed
	   top border alone communicates the parent-child relationship. */
	.ws-accounts {
		padding: 6px 6px 8px 6px;
		margin: 2px 4px 0 4px;
		display: flex; flex-direction: column; gap: 2px;
		border-top: 1px dashed rgba(255,255,255,0.04);
	}
	.ws-acct-row { display: flex; align-items: center; gap: 2px; }
	.ws-acct-btn {
		flex: 1; min-width: 0;
		display: flex; align-items: center; gap: 8px;
		padding: 6px 8px; border-radius: 7px; border: none;
		background: transparent; color: #94a3b8; cursor: pointer;
		font-family: inherit; transition: background 0.1s;
	}
	.ws-acct-btn:hover { background: rgba(255,255,255,0.03); }
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
	.ws-acct-name { font-family: 'Syne', sans-serif; font-size: 11px; font-weight: 600; color: #e2e8f0; }
	.ws-acct-addr { font-family: 'Space Mono', monospace; font-size: 8px; color: #475569; }
	.ws-acct-right { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
	.ws-acct-usd { font-family: 'Rajdhani', sans-serif; font-size: 11px; color: #64748b; font-variant-numeric: tabular-nums; }
	.ws-acct-check { font-size: 10px; color: #10b981; }
	.ws-acct-actions { display: flex; flex-shrink: 0; }

	.ws-acct-locked { font-family: 'Space Mono', monospace; font-size: 9px; color: #475569; padding: 4px 8px; margin: 0; }

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
		border-top: 1px solid rgba(255,255,255,0.04);
	}
	/* Disconnect: full-width, comfortably tap-sized. Colored subtly
	   (red border + red icon) so it reads as terminal without competing
	   with the primary New/Import row visually. */
	.ws-foot-disconnect-link {
		display: flex; align-items: center; justify-content: center; gap: 8px;
		width: 100%; padding: 11px 14px; border-radius: 9px;
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
		background: #11141c; border: 1px solid rgba(255,255,255,0.08);
		border-radius: 12px; padding: 6px;
		box-shadow: 0 12px 32px rgba(0,0,0,0.6);
		display: flex; flex-direction: column; gap: 1px;
	}
	.ws-sheet-menu-title {
		font-family: 'Syne', sans-serif; font-size: 11px; font-weight: 800;
		color: #64748b; text-transform: uppercase; letter-spacing: 0.08em;
		padding: 8px 12px 4px;
	}
	.ws-menu-item {
		display: flex; align-items: center; gap: 10px;
		width: 100%; padding: 9px 10px; border: none; border-radius: 7px;
		background: transparent; color: #94a3b8; cursor: pointer;
		font-family: 'Space Mono', monospace; font-size: 11px; text-align: left;
		transition: all 0.12s;
	}
	.ws-menu-item:hover { background: rgba(0,210,255,0.06); color: #00d2ff; }
	.ws-menu-item-danger { color: #f87171; }
	.ws-menu-item-danger:hover { background: rgba(248,113,113,0.08); color: #f87171; }
	.ws-menu-sub {
		margin-left: auto; font-size: 9px; color: #475569;
	}
	.ws-menu-divider {
		height: 1px; background: rgba(255,255,255,0.05); margin: 3px 4px;
	}

	/* Form (create / import / codes) */
	.ws-form {
		padding: 12px 16px 16px;
		display: flex; flex-direction: column; gap: 8px;
		background: rgba(0,210,255,0.03); border-top: 1px solid rgba(0,210,255,0.08);
	}
	.ws-form-title { font-family: 'Syne', sans-serif; font-size: 12px; font-weight: 700; color: #fff; }
	.ws-form-hint { font-family: 'Space Mono', monospace; font-size: 9px; color: #64748b; margin: 0; line-height: 1.5; }
	.ws-input {
		width: 100%; padding: 9px 12px; border-radius: 8px;
		background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06);
		color: #fff; font-family: 'Space Mono', monospace; font-size: 12px;
		outline: none; transition: border-color 0.12s;
	}
	.ws-input:focus { border-color: rgba(0,210,255,0.3); }
	.ws-input::placeholder { color: #374151; }
	.ws-textarea { resize: vertical; line-height: 1.5; }
	.ws-ack {
		display: flex; gap: 6px; align-items: flex-start;
		font-family: 'Space Mono', monospace; font-size: 9px; color: #94a3b8;
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
		border: 1px solid rgba(255,255,255,0.06); background: rgba(255,255,255,0.03);
		color: #94a3b8; cursor: pointer; font-family: 'Space Mono', monospace; transition: all 0.12s;
	}
	.ws-btn-s:hover { background: rgba(255,255,255,0.06); color: #fff; }
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
		background: #0f1118; border: 1px solid rgba(255,255,255,0.08);
		border-radius: 12px; padding: 14px; min-width: 240px;
		display: flex; flex-direction: column; gap: 10px;
	}
	.ws-avatar-title { font-family: 'Syne', sans-serif; font-size: 12px; font-weight: 700; color: #fff; }
	.ws-avatar-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px; }
	.ws-avatar-btn {
		width: 32px; height: 32px; border-radius: 8px;
		background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06);
		font-size: 18px; cursor: pointer; transition: all 0.12s;
		display: flex; align-items: center; justify-content: center;
	}
	.ws-avatar-btn:hover { background: rgba(0,210,255,0.1); border-color: rgba(0,210,255,0.3); }
	.ws-avatar-clear {
		padding: 6px; border: none; background: rgba(255,255,255,0.04); border-radius: 6px;
		color: #64748b; cursor: pointer; font-family: 'Space Mono', monospace; font-size: 10px;
	}
	.ws-avatar-clear:hover { background: rgba(255,255,255,0.08); color: #fff; }
</style>
