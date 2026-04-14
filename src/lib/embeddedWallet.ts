/**
 * Embedded Wallet Manager — multi-wallet edition.
 *
 * Architecture:
 *   - A user can own many wallets (one seed each). Each wallet has N HD-derived
 *     accounts from its seed.
 *   - Exactly one wallet is "active" at any moment — its mnemonic is the only
 *     seed held in memory. Switching wallets clears the previous seed.
 *   - Shared PIN: the user uses the same PIN for every wallet, cached in
 *     localStorage + memory so switching is silent.
 *   - Recovery codes are per-wallet; platform-generated wallets have them,
 *     imported wallets do not (the user keeps their own backup).
 *   - Server stores ciphertext only. All crypto runs in the browser.
 *
 * Flow:
 *   1. Google login via Supabase Auth
 *   2. GET /api/wallets → list of encrypted wallets + salt
 *   3. New user: create wallet → generate mnemonic → encrypt → POST /api/wallets
 *   4. Returning user: pick primary → decrypt with PIN → derive accounts
 *   5. Add/import more wallets anytime, each POST'd as a new row
 */

import { ethers } from 'ethers';
import {
	createWalletVault,
	unlockWithPin,
	unlockWithRecoveryCode,
	resetPin,
	type WalletVault,
} from './walletCrypto';
import { supabase } from './supabaseClient';

// ── Types ──────────────────────────────────────────────────────────────

export interface EmbeddedAccount {
	index: number;
	address: string;
	wallet: ethers.Wallet;
}

export interface WalletContext {
	id: string;
	name: string;
	isPrimary: boolean;
	isImported: boolean;
	accountCount: number;
	defaultAddress: string | null;
	/** Derived accounts — empty when this wallet is locked. */
	accounts: EmbeddedAccount[];
	/** Seed phrase, only non-null when this wallet is the active unlocked one. */
	mnemonic: string | null;
	activeAccountIndex: number;
	/** Raw encrypted blob — kept so we can re-decrypt on switch without refetching. */
	primaryBlob: string;
	recoveryBlobs: [string | null, string | null, string | null];
}

export interface EmbeddedState {
	isLoggedIn: boolean;
	userId: string | null;
	email: string | null;
	/** True when the active wallet has its mnemonic in memory. */
	isUnlocked: boolean;
	wallets: WalletContext[];
	activeWalletId: string | null;
	/** Convenience pointer into the active wallet's accounts. */
	activeAccount: EmbeddedAccount | null;
	/** Convenience alias for the active wallet's accounts (back-compat for
	 *  callers that read `state.accounts` directly). Populated on each snapshot. */
	accounts: EmbeddedAccount[];
}

/** @deprecated use EmbeddedState */
export type WalletState = EmbeddedState;

// ── Module state ───────────────────────────────────────────────────────

let _state: EmbeddedState = {
	isLoggedIn: false,
	userId: null,
	email: null,
	isUnlocked: false,
	wallets: [],
	activeWalletId: null,
	activeAccount: null,
	accounts: [],
};

let _salt: string | null = null;
let _jwt: string | null = null;
let _cachedPin: string | null = null;
let _listeners: Array<(state: EmbeddedState) => void> = [];

// ── State notifications ────────────────────────────────────────────────

/** Shallow snapshot for subscribers. Wallets + accounts are copied by reference;
 *  the store is replaced on every change so Svelte derives pick it up.
 *  `accounts` is populated from the active wallet as a back-compat convenience. */
export function getWalletState(): EmbeddedState {
	const active = _state.wallets.find((w) => w.id === _state.activeWalletId);
	return {
		..._state,
		wallets: _state.wallets.map((w) => ({ ...w })),
		accounts: active?.accounts || [],
	};
}

export function onWalletStateChange(listener: (state: EmbeddedState) => void): () => void {
	_listeners.push(listener);
	return () => {
		_listeners = _listeners.filter((l) => l !== listener);
	};
}

function _notify() {
	const snapshot = getWalletState();
	for (const l of _listeners) l(snapshot);
}

function _reset() {
	_salt = null;
	_jwt = null;
	_cachedPin = null;
	_state = {
		isLoggedIn: false,
		userId: null,
		email: null,
		isUnlocked: false,
		wallets: [],
		activeWalletId: null,
		activeAccount: null,
		accounts: [],
	};
	_notify();
}

// ── Auth ───────────────────────────────────────────────────────────────

export async function signInWithGoogle(): Promise<void> {
	sessionStorage.setItem('wallet_return_to', window.location.pathname + window.location.search);
	sessionStorage.setItem('wallet_pending', 'true');

	// Always show the Google account picker. Without `prompt: 'select_account'`
	// Google silently re-uses the last signed-in account, which makes the
	// flow feel like a no-op and gives users no chance to pick a different
	// account. Showing the picker every time is the correct UX — they see
	// they're signing in with Google and can switch accounts on the spot.
	const { error: authErr } = await supabase.auth.signInWithOAuth({
		provider: 'google',
		options: {
			redirectTo: window.location.origin + window.location.pathname + window.location.search,
			queryParams: { prompt: 'select_account' },
		},
	});
	if (authErr) throw new Error(authErr.message);
}

export async function checkAuthReturn(): Promise<boolean> {
	if (sessionStorage.getItem('wallet_pending') !== 'true') return false;
	sessionStorage.removeItem('wallet_pending');

	let session = (await supabase.auth.getSession()).data.session;
	if (!session) {
		session = await new Promise((resolve) => {
			const timeout = setTimeout(() => resolve(null), 5000);
			const {
				data: { subscription },
			} = supabase.auth.onAuthStateChange((_event, s) => {
				if (s) {
					clearTimeout(timeout);
					subscription.unsubscribe();
					resolve(s);
				}
			});
		});
	}

	if (!session) return false;
	_jwt = session.access_token;
	_state.isLoggedIn = true;
	_state.userId = session.user.id;
	_state.email = session.user.email || null;

	// Pre-fetch wallets while we have a confirmed session so that the
	// subsequent hasVault() call finds them in _state.wallets instead of
	// racing with supabase.auth.getSession() which may not have settled yet.
	try {
		const { salt, wallets } = await fetchWallets();
		if (salt) _salt = salt;
		_state.wallets = wallets.map(_walletRowToContext);
		if (_state.wallets.length > 0) {
			const primary = _state.wallets.find((w) => w.isPrimary) || _state.wallets[0];
			_state.activeWalletId = primary.id;
		}
	} catch {}

	_notify();
	return true;
}

export async function checkSession(): Promise<boolean> {
	const {
		data: { session },
	} = await supabase.auth.getSession();
	if (!session) {
		_state.isLoggedIn = false;
		_notify();
		return false;
	}
	_jwt = session.access_token;
	_state.isLoggedIn = true;
	_state.userId = session.user.id;
	_state.email = session.user.email || null;
	_notify();
	return true;
}

// ── Session / PIN cache (shared across wallets) ────────────────────────
//
// Two-tier expiry, configurable by the user:
//   - idle expiry  (default 30 min): bumped on every signing op + on
//                                     explicit `extendSession()` calls
//   - absolute expiry (default 8 hours): hard ceiling, can't be extended
//
// Critical operations (export key, export seed, delete wallet) should
// re-prompt for the PIN regardless of session state — those callers
// pass an explicit PIN to `unlockWallet`.

const SESSION_KEY = '_wp';
const SESSION_POLICY_KEY = '_wallet_session_policy';
const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const DEFAULT_ABSOLUTE_MS = 8 * 60 * 60 * 1000;

export interface SessionPolicy {
	idleMs: number;
	absoluteMs: number;
}

export function getSessionPolicy(): SessionPolicy {
	const clampIdle = (v: number) => Math.max(60_000, Math.min(v, 28_800_000));
	const clampAbsolute = (v: number) => Math.max(300_000, Math.min(v, 86_400_000));
	try {
		const raw = localStorage.getItem(SESSION_POLICY_KEY);
		if (!raw) return { idleMs: DEFAULT_IDLE_MS, absoluteMs: DEFAULT_ABSOLUTE_MS };
		const p = JSON.parse(raw);
		return {
			idleMs: clampIdle(Number(p.idleMs) || DEFAULT_IDLE_MS),
			absoluteMs: clampAbsolute(Number(p.absoluteMs) || DEFAULT_ABSOLUTE_MS),
		};
	} catch {
		return { idleMs: DEFAULT_IDLE_MS, absoluteMs: DEFAULT_ABSOLUTE_MS };
	}
}

export function setSessionPolicy(idleMs: number, absoluteMs: number): void {
	try {
		localStorage.setItem(SESSION_POLICY_KEY, JSON.stringify({ idleMs, absoluteMs }));
	} catch {}
}

function cachePin(pin: string) {
	const policy = getSessionPolicy();
	const now = Date.now();
	_cachedPin = pin;
	localStorage.setItem(
		SESSION_KEY,
		JSON.stringify({
			v: btoa(pin),
			absExp: now + policy.absoluteMs,
			idleExp: now + policy.idleMs,
		}),
	);
}

function getCachedPin(): string | null {
	try {
		const raw = localStorage.getItem(SESSION_KEY);
		if (!raw) {
			_cachedPin = null;
			return null;
		}
		const { v, absExp, idleExp } = JSON.parse(raw);
		const now = Date.now();
		if (now > absExp || now > idleExp) {
			clearCachedPin();
			return null;
		}
		if (!_cachedPin) _cachedPin = atob(v);
		return _cachedPin;
	} catch {
		return null;
	}
}

function clearCachedPin() {
	_cachedPin = null;
	localStorage.removeItem(SESSION_KEY);
}

/** Bump the idle expiry. Call from user-driven activity (clicks, key
 *  events) so a busy user isn't auto-locked while interacting. The
 *  absolute expiry is a hard ceiling and can't be pushed past. */
export function extendSession(): void {
	try {
		const raw = localStorage.getItem(SESSION_KEY);
		if (!raw) return;
		const data = JSON.parse(raw);
		const now = Date.now();
		if (now > data.absExp) {
			clearCachedPin();
			lockWallet();
			return;
		}
		const policy = getSessionPolicy();
		data.idleExp = Math.min(now + policy.idleMs, data.absExp);
		localStorage.setItem(SESSION_KEY, JSON.stringify(data));
	} catch {}
}

export interface SessionInfo {
	unlocked: boolean;
	idleRemainingMs: number;
	absoluteRemainingMs: number;
}

export function getSessionInfo(): SessionInfo {
	if (!_state.isUnlocked) {
		return { unlocked: false, idleRemainingMs: 0, absoluteRemainingMs: 0 };
	}
	try {
		const raw = localStorage.getItem(SESSION_KEY);
		if (!raw) return { unlocked: true, idleRemainingMs: 0, absoluteRemainingMs: 0 };
		const { absExp, idleExp } = JSON.parse(raw);
		const now = Date.now();
		return {
			unlocked: true,
			idleRemainingMs: Math.max(0, idleExp - now),
			absoluteRemainingMs: Math.max(0, absExp - now),
		};
	} catch {
		return { unlocked: true, idleRemainingMs: 0, absoluteRemainingMs: 0 };
	}
}

// ── Sign out ───────────────────────────────────────────────────────────

export async function signOut(): Promise<void> {
	clearCachedPin();
	await supabase.auth.signOut();
	_reset();
}

// ── API helpers ────────────────────────────────────────────────────────

async function apiFetch(path: string, method: string, body?: any): Promise<any> {
	// Pull a fresh access token on every call — supabase-js auto-refreshes
	// expired sessions internally, so getSession() always hands back a
	// currently-valid JWT. Caching _jwt at login would go stale after the
	// 1-hour access-token lifetime and surface as mystery 401s.
	const {
		data: { session },
	} = await supabase.auth.getSession();
	if (!session) throw new Error('Not authenticated');
	_jwt = session.access_token;
	const headers: Record<string, string> = { Authorization: `Bearer ${_jwt}` };
	if (body) headers['Content-Type'] = 'application/json';
	const res = await fetch(path, {
		method,
		headers,
		body: body ? JSON.stringify(body) : undefined,
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({ message: 'Request failed' }));
		throw new Error(err.message || `HTTP ${res.status}`);
	}
	return res.json();
}

/** Fetch all wallets for this user + shared salt. */
async function fetchWallets(): Promise<{ salt: string; wallets: any[] }> {
	return apiFetch('/api/wallets', 'GET');
}

/** Create a new wallet row on the server. */
async function postWallet(payload: any): Promise<any> {
	return apiFetch('/api/wallets', 'POST', payload);
}

/** Update a wallet row. */
async function patchWallet(id: string, payload: any): Promise<any> {
	return apiFetch(`/api/wallets/${id}`, 'PATCH', payload);
}

// ── Wallet loading / unlock ────────────────────────────────────────────

/**
 * Auto-reconnect: loads the wallet list, picks the primary, tries cached PIN.
 * Returns:
 *   'connected'    — fully unlocked, ready to sign
 *   'needs-pin'    — wallets exist but no cached PIN
 *   'no-wallets'   — logged in but no wallet rows yet (user needs to create one)
 *   'disconnected' — not logged in
 */
export async function autoReconnect(): Promise<
	'connected' | 'needs-pin' | 'no-wallets' | 'disconnected'
> {
	const {
		data: { session },
	} = await supabase.auth.getSession();
	if (!session) return 'disconnected';

	_jwt = session.access_token;
	_state.isLoggedIn = true;
	_state.userId = session.user.id;
	_state.email = session.user.email || null;

	try {
		const { salt, wallets } = await fetchWallets();
		_salt = salt;

		if (!wallets || wallets.length === 0) {
			_notify();
			return 'no-wallets';
		}

		_state.wallets = wallets.map(_walletRowToContext);

		// Pick the wallet to activate: previously-active (localStorage) or primary
		const savedActiveId = localStorage.getItem('_active_wallet');
		const preferred =
			_state.wallets.find((w) => w.id === savedActiveId) ||
			_state.wallets.find((w) => w.isPrimary) ||
			_state.wallets[0];
		_state.activeWalletId = preferred.id;

		// One-shot migration of legacy flat account_names → per-wallet meta
		_migrateLegacyAccountNames(preferred.id);

		// Try cached PIN
		const cached = getCachedPin();
		if (cached) {
			const ok = await _unlockWalletInPlace(preferred, cached);
			if (ok) {
				_state.isUnlocked = true;
				_state.activeAccount = preferred.accounts[preferred.activeAccountIndex] || null;
				_notify();
				return 'connected';
			}
			clearCachedPin();
		}

		_state.isUnlocked = false;
		_notify();
		return 'needs-pin';
	} catch {
		return 'disconnected';
	}
}

/** Translate a raw DB row into a WalletContext (locked, no accounts derived). */
function _walletRowToContext(row: any): WalletContext {
	return {
		id: row.id,
		name: row.name || 'Wallet',
		isPrimary: !!row.is_primary,
		isImported: !!row.is_imported,
		accountCount: row.account_count || 1,
		defaultAddress: row.default_address || null,
		accounts: [],
		mnemonic: null,
		activeAccountIndex: 0,
		primaryBlob: row.primary_blob,
		recoveryBlobs: [row.recovery_blob_1, row.recovery_blob_2, row.recovery_blob_3],
	};
}

/** Decrypt a wallet's blob with the given PIN and populate its accounts in-place. */
async function _unlockWalletInPlace(wallet: WalletContext, pin: string): Promise<boolean> {
	if (!_salt) return false;
	const mnemonic = await unlockWithPin(wallet.primaryBlob, pin, _salt);
	if (!mnemonic) return false;
	wallet.mnemonic = mnemonic;
	_deriveAccounts(wallet);
	return true;
}

/** Derive HD accounts for a wallet given its mnemonic. */
function _deriveAccounts(wallet: WalletContext): void {
	if (!wallet.mnemonic) return;
	const hdNode = ethers.HDNodeWallet.fromMnemonic(
		ethers.Mnemonic.fromPhrase(wallet.mnemonic),
		"m/44'/60'/0'/0",
	);
	wallet.accounts = [];
	for (let i = 0; i < wallet.accountCount; i++) {
		const child = hdNode.deriveChild(i);
		wallet.accounts.push({
			index: i,
			address: child.address,
			wallet: new ethers.Wallet(child.privateKey),
		});
	}
	// Restore active account index (per-wallet, stored in localStorage)
	const savedIdx = _getSavedActiveAccount(wallet.id);
	wallet.activeAccountIndex =
		wallet.accounts.find((a) => a.index === savedIdx) !== undefined ? savedIdx : 0;
}

function _getSavedActiveAccount(walletId: string): number {
	try {
		const raw = localStorage.getItem('_active_acct_by_wallet');
		if (!raw) return 0;
		const map = JSON.parse(raw);
		return Number(map[walletId] ?? 0);
	} catch {
		return 0;
	}
}

function _setSavedActiveAccount(walletId: string, index: number): void {
	try {
		const raw = localStorage.getItem('_active_acct_by_wallet');
		const map = raw ? JSON.parse(raw) : {};
		map[walletId] = index;
		localStorage.setItem('_active_acct_by_wallet', JSON.stringify(map));
	} catch {}
}

// ── Public: Unlock + state queries ─────────────────────────────────────

/** Unlock the active wallet with a PIN. Caches the PIN on success.
 *
 *  Lazy-loads the wallet list when called from a flow that hasn't run
 *  `autoReconnect` yet — most notably the post-Google-OAuth return path,
 *  which jumps straight to the PIN prompt without populating `_state.wallets`.
 *  Without this fallback, the user would see "No active wallet" after
 *  entering the right PIN. */
export async function unlockWallet(pin: string): Promise<boolean> {
	let active = _getActiveWalletInternal();

	if (!active && _state.isLoggedIn) {
		try {
			const { salt, wallets } = await fetchWallets();
			if (wallets && wallets.length > 0) {
				_salt = salt;
				_state.wallets = wallets.map(_walletRowToContext);
				const savedActiveId = localStorage.getItem('_active_wallet');
				const preferred =
					_state.wallets.find((w) => w.id === savedActiveId) ||
					_state.wallets.find((w) => w.isPrimary) ||
					_state.wallets[0];
				_state.activeWalletId = preferred.id;
				_migrateLegacyAccountNames(preferred.id);
				active = preferred;
			}
		} catch {
			// fall through to "No active wallet" below
		}
	}

	if (!active) throw new Error('No active wallet');

	const ok = await _unlockWalletInPlace(active, pin);
	if (!ok) return false;

	cachePin(pin);
	_state.isUnlocked = true;
	_state.activeAccount = active.accounts[active.activeAccountIndex] || null;
	_notify();
	return true;
}

/** Whether we have at least one wallet row on the server. */
export async function hasVault(): Promise<boolean> {
	if (_state.wallets.length > 0) return true;
	try {
		const { wallets } = await fetchWallets();
		return Array.isArray(wallets) && wallets.length > 0;
	} catch {
		return false;
	}
}

// ── Create / Import ────────────────────────────────────────────────────

/**
 * Create a brand-new wallet: generate a BIP-39 mnemonic client-side, encrypt
 * with the PIN, persist. If this is the user's first wallet it becomes the
 * primary automatically. Returns the new wallet + its recovery codes.
 */
export async function createNewWallet(
	name: string,
	pin: string,
): Promise<{ wallet: WalletContext; recoveryCodes: string[] }> {
	if (!_jwt) throw new Error('Not authenticated');
	if (!_salt) {
		// Refresh salt if we don't have it yet (first-time user path)
		const { salt } = await fetchWallets();
		_salt = salt;
	}

	const mnemonic = ethers.Wallet.createRandom().mnemonic!.phrase;
	const vault = await createWalletVault(mnemonic, pin, _salt!);

	const hdNode = ethers.HDNodeWallet.fromMnemonic(
		ethers.Mnemonic.fromPhrase(mnemonic),
		"m/44'/60'/0'/0",
	);
	const firstAccount = hdNode.deriveChild(0);

	const { wallet: row } = await postWallet({
		name,
		primaryBlob: vault.primaryBlob,
		recoveryBlob1: vault.recoveryBlob1,
		recoveryBlob2: vault.recoveryBlob2,
		recoveryBlob3: vault.recoveryBlob3,
		accountCount: 1,
		defaultAddress: firstAccount.address,
		isImported: false,
	});

	const ctx = _walletRowToContext(row);
	ctx.mnemonic = mnemonic;
	_deriveAccounts(ctx);
	_state.wallets = [..._state.wallets, ctx];

	// First wallet? cache the PIN + activate it.
	if (_state.wallets.length === 1) {
		cachePin(pin);
		_state.activeWalletId = ctx.id;
		_state.isUnlocked = true;
		_state.activeAccount = ctx.accounts[0] || null;
		localStorage.setItem('_active_wallet', ctx.id);
	}

	_notify();
	return { wallet: ctx, recoveryCodes: vault.recoveryCodes };
}

/**
 * Import an existing BIP-39 mnemonic as a new wallet. Imported wallets skip
 * platform recovery codes — the user keeps their own backup.
 *
 * Uses the cached PIN by default. For the first-time import flow (user has
 * no existing wallet yet), pass `explicitPin` — it will be cached on success.
 */
export async function importWallet(
	name: string,
	mnemonicPhrase: string,
	explicitPin?: string,
): Promise<WalletContext> {
	if (!_jwt) throw new Error('Not authenticated');

	// Validate the mnemonic via ethers' BIP-39 wordlist check
	let normalizedMnemonic: string;
	try {
		const parsed = ethers.Mnemonic.fromPhrase(mnemonicPhrase.trim());
		normalizedMnemonic = parsed.phrase;
	} catch {
		throw new Error('Invalid recovery phrase');
	}

	const pin = explicitPin || getCachedPin();
	if (!pin) throw new Error('Unlock your primary wallet first');
	if (!_salt) {
		const { salt } = await fetchWallets();
		_salt = salt;
	}

	// Encrypt with shared PIN — no recovery blobs for imported wallets.
	const { encryptWithPin } = await import('./walletCrypto');
	const primaryBlob = await encryptWithPin(normalizedMnemonic, pin, _salt!);

	const hdNode = ethers.HDNodeWallet.fromMnemonic(
		ethers.Mnemonic.fromPhrase(normalizedMnemonic),
		"m/44'/60'/0'/0",
	);
	const firstAccount = hdNode.deriveChild(0);

	const { wallet: row } = await postWallet({
		name,
		primaryBlob,
		recoveryBlob1: null,
		recoveryBlob2: null,
		recoveryBlob3: null,
		accountCount: 1,
		defaultAddress: firstAccount.address,
		isImported: true,
	});

	const ctx = _walletRowToContext(row);
	ctx.mnemonic = normalizedMnemonic;
	_deriveAccounts(ctx);
	_state.wallets = [..._state.wallets, ctx];

	// First-time import path: cache the PIN and activate the new wallet
	// immediately so the caller gets a unlocked state back.
	if (explicitPin && _state.wallets.length === 1) {
		cachePin(explicitPin);
		_state.activeWalletId = ctx.id;
		_state.isUnlocked = true;
		_state.activeAccount = ctx.accounts[0] || null;
		localStorage.setItem('_active_wallet', ctx.id);
	}

	_notify();
	return ctx;
}

// ── Switching ──────────────────────────────────────────────────────────

/** Switch the active wallet. Uses the cached PIN silently when possible. */
export async function switchWallet(walletId: string): Promise<boolean> {
	const target = _state.wallets.find((w) => w.id === walletId);
	if (!target) throw new Error('Wallet not found');

	// Already active and unlocked — no-op
	if (_state.activeWalletId === walletId && target.mnemonic) {
		return true;
	}

	// Clear the previous active wallet's hot secret material
	const prev = _getActiveWalletInternal();
	if (prev && prev.id !== walletId) {
		prev.mnemonic = null;
		prev.accounts = [];
	}

	_state.activeWalletId = walletId;
	localStorage.setItem('_active_wallet', walletId);

	// Try cached PIN first
	const pin = getCachedPin();
	if (pin) {
		const ok = await _unlockWalletInPlace(target, pin);
		if (ok) {
			_state.isUnlocked = true;
			_state.activeAccount = target.accounts[target.activeAccountIndex] || null;
			_notify();
			return true;
		}
	}

	// No cached PIN (or it failed) — surface locked state to caller
	_state.isUnlocked = false;
	_state.activeAccount = null;
	_notify();
	return false;
}

// ── Account management (scoped to active wallet) ───────────────────────

/** Derive another HD account on the active wallet. */
export async function addAccount(): Promise<EmbeddedAccount> {
	const active = _getActiveWalletInternal();
	if (!active || !active.mnemonic) throw new Error('Active wallet not unlocked');

	const newIndex = active.accountCount;
	active.accountCount += 1;

	const hdNode = ethers.HDNodeWallet.fromMnemonic(
		ethers.Mnemonic.fromPhrase(active.mnemonic),
		"m/44'/60'/0'/0",
	);
	const child = hdNode.deriveChild(newIndex);
	const account: EmbeddedAccount = {
		index: newIndex,
		address: child.address,
		wallet: new ethers.Wallet(child.privateKey),
	};
	active.accounts.push(account);

	// Persist new account count to server
	try {
		await patchWallet(active.id, {
			accountCount: active.accountCount,
			defaultAddress: active.defaultAddress || account.address,
		});
	} catch {
		// Non-fatal — account is usable locally until next sync
	}

	_notify();
	return account;
}

/** Switch the active account within the active wallet. */
export function setActiveAccount(index: number): void {
	const active = _getActiveWalletInternal();
	if (!active) return;
	const account = active.accounts.find((a) => a.index === index);
	if (!account) return;
	active.activeAccountIndex = index;
	_state.activeAccount = account;
	_setSavedActiveAccount(active.id, index);
	_notify();
}

// ── Signing helpers ────────────────────────────────────────────────────

/** Get an ethers Wallet connected to a provider for the active account. */
export function getSigner(provider: ethers.JsonRpcProvider): ethers.Wallet | null {
	if (!_state.activeAccount) return null;
	return _state.activeAccount.wallet.connect(provider);
}

/** Return the raw ethers Wallet for the active account (unconnected). */
export function getActiveSigner(): ethers.Wallet | null {
	return _state.activeAccount?.wallet || null;
}

// ── Mnemonic + private key export ──────────────────────────────────────

/** Export the active wallet's seed phrase. Caller should PIN-confirm first. */
export function exportSeedPhrase(): string | null {
	const active = _getActiveWalletInternal();
	return active?.mnemonic || null;
}

/** Export a single account's private key from the active wallet. */
export function exportPrivateKey(index: number): string | null {
	const active = _getActiveWalletInternal();
	const account = active?.accounts.find((a) => a.index === index);
	return account?.wallet.privateKey || null;
}

// ── Change PIN (platform-wide) ─────────────────────────────────────────

/**
 * Change the PIN that protects every wallet. Since the PIN is shared
 * across wallets, this re-encrypts every wallet's `primary_blob` with
 * the new PIN and ships them to the server in one batched upsert via
 * `/api/wallets/rotate-pin`. That endpoint uses Supabase's batch upsert,
 * which compiles to a single `INSERT … ON CONFLICT DO UPDATE` statement;
 * Postgres executes it atomically so either every wallet gets the new
 * ciphertext or none do. No more partial-failure window where a network
 * drop mid-loop could leave half the wallets on the old PIN.
 *
 * Recovery blobs are NOT touched (they're encrypted with separate
 * recovery codes, not the PIN). Only the primary_blob changes.
 */
let _pinChanging = false;

export async function changePin(currentPin: string, newPin: string): Promise<void> {
	if (_pinChanging) throw new Error('PIN change already in progress');
	_pinChanging = true;
	try {
		return await _changePinInner(currentPin, newPin);
	} finally {
		_pinChanging = false;
	}
}

async function _changePinInner(currentPin: string, newPin: string): Promise<void> {
	if (!_salt) throw new Error('Salt not loaded');
	if (_state.wallets.length === 0) throw new Error('No wallets to update');
	if (!newPin || newPin.length < 6) throw new Error('New PIN must be at least 6 digits');
	if (newPin === currentPin) throw new Error('New PIN must be different from current PIN');

	const { encryptWithPin } = await import('./walletCrypto');

	// Step 1: verify the current PIN decrypts every wallet before we
	// write anything. If any wallet fails, bail without touching state.
	const decrypted: { id: string; mnemonic: string }[] = [];
	for (const w of _state.wallets) {
		const mnemonic = await unlockWithPin(w.primaryBlob, currentPin, _salt);
		if (!mnemonic) throw new Error('Current PIN is incorrect');
		decrypted.push({ id: w.id, mnemonic });
	}

	// Step 2: re-encrypt each seed with the new PIN locally.
	const updates: Array<{ id: string; primaryBlob: string }> = [];
	for (const d of decrypted) {
		const primaryBlob = await encryptWithPin(d.mnemonic, newPin, _salt);
		updates.push({ id: d.id, primaryBlob });
	}

	// Step 3: ship every new blob in ONE atomic request. Server responds
	// all-or-nothing; on failure nothing is written and we throw so the
	// caller can toast.
	await apiFetch('/api/wallets/rotate-pin', 'POST', { updates });

	// Step 4: apply the new blobs to local state and swap the cached PIN
	// so subsequent unlock/switch calls use it.
	for (const u of updates) {
		const w = _state.wallets.find((x) => x.id === u.id);
		if (w) w.primaryBlob = u.primaryBlob;
	}
	cachePin(newPin);
	_notify();
}

// ── Rename / delete / primary ──────────────────────────────────────────

/**
 * Rename a wallet with optimistic UI: the local state updates synchronously
 * so the new name renders on the next tick. The server call runs in the
 * background; on failure we roll back to the previous name and re-throw
 * so the caller can surface a toast.
 */
export async function renameWallet(walletId: string, newName: string): Promise<void> {
	const w = _state.wallets.find((w) => w.id === walletId);
	if (!w) throw new Error('Wallet not found');
	const trimmed = newName.trim().slice(0, 40);
	if (!trimmed || trimmed === w.name) return;

	const previousName = w.name;
	w.name = trimmed;
	_notify();

	try {
		await patchWallet(walletId, { name: trimmed });
	} catch (e) {
		w.name = previousName;
		_notify();
		throw e;
	}
}

export async function deleteWallet(walletId: string): Promise<void> {
	// Guard in UI, but server also enforces — don't delete last wallet, don't delete primary
	await apiFetch(`/api/wallets/${walletId}`, 'DELETE');
	_state.wallets = _state.wallets.filter((w) => w.id !== walletId);
	// Drop the local account metadata for the deleted wallet
	try {
		localStorage.removeItem(_accountMetaKey(walletId));
	} catch {}
	if (_state.activeWalletId === walletId) {
		const fallback = _state.wallets.find((w) => w.isPrimary) || _state.wallets[0];
		if (fallback) {
			await switchWallet(fallback.id);
		} else {
			_state.activeWalletId = null;
			_state.activeAccount = null;
			_state.isUnlocked = false;
		}
	}
	_notify();
}

export async function setPrimaryWallet(walletId: string): Promise<void> {
	await patchWallet(walletId, { setPrimary: true });
	for (const w of _state.wallets) {
		w.isPrimary = w.id === walletId;
	}
	_notify();
}

// ── Lock / recovery ────────────────────────────────────────────────────

/** Lock everything: clear every in-memory seed + the cached PIN. */
export function lockWallet(): void {
	for (const w of _state.wallets) {
		w.mnemonic = null;
		w.accounts = [];
	}
	clearCachedPin();
	_state.isUnlocked = false;
	_state.activeAccount = null;
	_notify();
}

/** Recover the active wallet with a recovery code. Sets a NEW PIN on success.
 *  Note: other wallets remain encrypted with the old PIN — the user will
 *  need to re-enter the old PIN for them or recover each separately. */
export async function recoverWithCode(code: string): Promise<boolean> {
	const active = _getActiveWalletInternal();
	if (!active) throw new Error('No active wallet');
	if (!_salt) throw new Error('Salt not loaded');

	const blobs = active.recoveryBlobs.filter((b): b is string => !!b);
	if (blobs.length === 0) throw new Error('Imported wallets have no recovery codes');

	const mnemonic = await unlockWithRecoveryCode(blobs, code, _salt);
	if (!mnemonic) return false;

	active.mnemonic = mnemonic;
	_deriveAccounts(active);
	return true;
}

/** After a successful recovery, set a new PIN for the (recovered) active wallet. */
export async function setNewPin(newPin: string): Promise<string[]> {
	const active = _getActiveWalletInternal();
	if (!active || !active.mnemonic) throw new Error('Wallet not recovered');
	if (!_salt) throw new Error('Salt not loaded');

	const vault = await resetPin(active.mnemonic, newPin, _salt);

	await patchWallet(active.id, {
		primaryBlob: vault.primaryBlob,
		recoveryBlob1: vault.recoveryBlob1,
		recoveryBlob2: vault.recoveryBlob2,
		recoveryBlob3: vault.recoveryBlob3,
	});

	active.primaryBlob = vault.primaryBlob;
	active.recoveryBlobs = [vault.recoveryBlob1, vault.recoveryBlob2, vault.recoveryBlob3];

	cachePin(newPin);
	_state.isUnlocked = true;
	_state.activeAccount = active.accounts[active.activeAccountIndex] || null;
	_notify();
	return vault.recoveryCodes;
}

// ── Per-wallet account metadata (names, avatars) ───────────────────────
//
// Account-level metadata is keyed by wallet ID + HD index. Stored
// per-wallet because the same HD index in different wallets is a
// completely different account — naming leaked across wallets in the
// old `account_names` flat key. New format: `account_meta_<wid>`.

export interface AccountMeta {
	name?: string;
	avatar?: string;
}

type WalletAccountMetaMap = Record<string, AccountMeta>;

function _accountMetaKey(walletId: string): string {
	return `account_meta_${walletId}`;
}

function _readWalletMetaMap(walletId: string): WalletAccountMetaMap {
	try {
		const raw = localStorage.getItem(_accountMetaKey(walletId));
		return raw ? JSON.parse(raw) : {};
	} catch {
		return {};
	}
}

function _writeWalletMetaMap(walletId: string, map: WalletAccountMetaMap): void {
	try {
		localStorage.setItem(_accountMetaKey(walletId), JSON.stringify(map));
	} catch {}
}

export function getAccountMeta(walletId: string, index: number): AccountMeta {
	const map = _readWalletMetaMap(walletId);
	return map[String(index)] || {};
}

export function getAllAccountMeta(walletId: string): WalletAccountMetaMap {
	return _readWalletMetaMap(walletId);
}

export function setAccountMeta(walletId: string, index: number, meta: Partial<AccountMeta>): void {
	const map = _readWalletMetaMap(walletId);
	const cur = map[String(index)] || {};
	const next = { ...cur, ...meta };
	// Drop undefined keys so empty entries don't accumulate
	Object.keys(next).forEach((k) => {
		if ((next as any)[k] === undefined || (next as any)[k] === '') delete (next as any)[k];
	});
	if (Object.keys(next).length === 0) {
		delete map[String(index)];
	} else {
		map[String(index)] = next;
	}
	_writeWalletMetaMap(walletId, map);
	// Push to server preferences (debounced)
	syncPreferences(collectPreferences()).catch(() => {});
}

export function getAccountName(walletId: string, index: number): string {
	const meta = getAccountMeta(walletId, index);
	return meta.name || `Account ${index + 1}`;
}

/** First-visit migration: copy the legacy flat `account_names` map into
 *  the active wallet's per-wallet metadata. The old shape was indexed by
 *  HD index only, so it's only safe to apply to one wallet — the user's
 *  primary at migration time. After this runs once, the legacy key is
 *  removed so subsequent wallets get clean metadata. */
function _migrateLegacyAccountNames(walletId: string): void {
	try {
		const raw = localStorage.getItem('account_names');
		if (!raw) return;
		const legacy = JSON.parse(raw) as Record<string, string>;
		if (!legacy || typeof legacy !== 'object') return;

		const map = _readWalletMetaMap(walletId);
		let changed = false;
		for (const [k, v] of Object.entries(legacy)) {
			if (!v) continue;
			if (map[k]?.name) continue;
			map[k] = { ...(map[k] || {}), name: v };
			changed = true;
		}
		if (changed) _writeWalletMetaMap(walletId, map);
		localStorage.removeItem('account_names');
	} catch {}
}

// ── Preferences sync (per active wallet) ───────────────────────────────

let _prefSyncTimer: ReturnType<typeof setTimeout> | null = null;

export async function syncPreferences(prefs: Record<string, any>): Promise<void> {
	const active = _getActiveWalletInternal();
	if (!active || !_jwt) return;
	if (_prefSyncTimer) clearTimeout(_prefSyncTimer);
	_prefSyncTimer = setTimeout(async () => {
		try {
			await patchWallet(active.id, { preferences: prefs });
		} catch (e) {
			console.warn('Preferences sync failed:', (e as Error).message);
		}
	}, 1000);
}

export function collectPreferences(): Record<string, any> {
	const prefs: Record<string, any> = {};
	// Per-wallet account metadata: collect for ALL wallets the user has on file
	const accountMeta: Record<string, WalletAccountMetaMap> = {};
	for (const w of _state.wallets) {
		const map = _readWalletMetaMap(w.id);
		if (Object.keys(map).length > 0) accountMeta[w.id] = map;
	}
	if (Object.keys(accountMeta).length > 0) prefs.account_meta = accountMeta;
	// Session policy
	try {
		const sp = localStorage.getItem(SESSION_POLICY_KEY);
		if (sp) prefs.session_policy = JSON.parse(sp);
	} catch {}
	try {
		const tokens = localStorage.getItem('imported_tokens');
		if (tokens) prefs.imported_tokens = JSON.parse(tokens);
	} catch {}
	try {
		const tradeTokens = localStorage.getItem('importedTokens');
		if (tradeTokens) prefs.trade_imported_tokens = JSON.parse(tradeTokens);
	} catch {}
	return prefs;
}

export function restorePreferences(prefs: Record<string, any>): void {
	if (!prefs || typeof prefs !== 'object') return;
	if (prefs.account_meta && typeof prefs.account_meta === 'object') {
		for (const [walletId, map] of Object.entries(prefs.account_meta)) {
			_writeWalletMetaMap(walletId, map as WalletAccountMetaMap);
		}
	}
	if (prefs.session_policy) {
		try {
			localStorage.setItem(SESSION_POLICY_KEY, JSON.stringify(prefs.session_policy));
		} catch {}
	}
	if (prefs.imported_tokens) {
		localStorage.setItem('imported_tokens', JSON.stringify(prefs.imported_tokens));
	}
	if (prefs.trade_imported_tokens) {
		localStorage.setItem('importedTokens', JSON.stringify(prefs.trade_imported_tokens));
	}
}

export async function pushPreferences(): Promise<void> {
	const prefs = collectPreferences();
	if (Object.keys(prefs).length > 0) {
		await syncPreferences(prefs);
	}
}

// ── Internal lookup ────────────────────────────────────────────────────

function _getActiveWalletInternal(): WalletContext | null {
	return _state.wallets.find((w) => w.id === _state.activeWalletId) || null;
}

// ── Back-compat shims (kept so existing callers don't break) ───────────

/** @deprecated use createNewWallet(name, pin) */
export async function createWallet(
	pin: string,
): Promise<{ recoveryCodes: string[]; address: string }> {
	const { wallet, recoveryCodes } = await createNewWallet('Primary', pin);
	return { recoveryCodes, address: wallet.accounts[0]?.address || '' };
}
