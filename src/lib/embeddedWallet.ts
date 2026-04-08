/**
 * Embedded Wallet Manager
 *
 * Manages the full lifecycle: create, unlock, derive accounts, sign transactions.
 * Seed is encrypted client-side with PIN + server salt. Server never sees the seed.
 *
 * Flow:
 *   1. Google login via Supabase Auth → get JWT
 *   2. Fetch salt + vault from /api/wallet
 *   3. New user: generate mnemonic → encrypt with PIN → save vault → show recovery codes
 *   4. Returning user: decrypt vault with PIN → derive accounts → ready to sign
 */

import { ethers } from 'ethers';
import { createWalletVault, unlockWithPin, unlockWithRecoveryCode, resetPin, type WalletVault } from './walletCrypto';
import { supabase } from './supabaseClient';

export interface EmbeddedAccount {
	index: number;
	address: string;
	wallet: ethers.Wallet;
}

export interface WalletState {
	isLoggedIn: boolean;
	isUnlocked: boolean;
	accounts: EmbeddedAccount[];
	activeAccount: EmbeddedAccount | null;
	userId: string | null;
	email: string | null;
}

let _state: WalletState = {
	isLoggedIn: false,
	isUnlocked: false,
	accounts: [],
	activeAccount: null,
	userId: null,
	email: null,
};

let _mnemonic: string | null = null;
let _salt: string | null = null;
let _jwt: string | null = null;
let _accountCount = 1;
let _listeners: Array<(state: WalletState) => void> = [];

// ── State Management ──

export function getWalletState(): WalletState {
	return { ..._state };
}

export function onWalletStateChange(listener: (state: WalletState) => void): () => void {
	_listeners.push(listener);
	return () => { _listeners = _listeners.filter(l => l !== listener); };
}

function _notify() {
	const snapshot = getWalletState();
	for (const l of _listeners) l(snapshot);
}

function _reset() {
	_mnemonic = null;
	_salt = null;
	_jwt = null;
	_accountCount = 1;
	_state = {
		isLoggedIn: false,
		isUnlocked: false,
		accounts: [],
		activeAccount: null,
		userId: null,
		email: null,
	};
	_notify();
}

// ── Auth ──

/** Sign in with Google via Supabase Auth (same-page redirect) */
export async function signInWithGoogle(forceAccountPicker = false): Promise<void> {
	// Sign out first if switching accounts
	if (forceAccountPicker) {
		await supabase.auth.signOut();
		_reset();
		localStorage.removeItem('_wp');
		localStorage.removeItem('_active_acct');
	}

	sessionStorage.setItem('wallet_return_to', window.location.pathname + window.location.search);
	sessionStorage.setItem('wallet_pending', 'true');

	const opts: any = {
		redirectTo: window.location.origin + window.location.pathname,
	};
	// Force Google to show account picker
	if (forceAccountPicker) {
		opts.queryParams = { prompt: 'select_account' };
	}

	const { error } = await supabase.auth.signInWithOAuth({
		provider: 'google',
		options: opts,
	});
	if (error) throw new Error(error.message);
}

/** Call on page load to check if returning from Google OAuth */
export async function checkAuthReturn(): Promise<boolean> {
	if (sessionStorage.getItem('wallet_pending') !== 'true') return false;
	sessionStorage.removeItem('wallet_pending');

	// Supabase auto-processes the hash token on load
	const { data: { session } } = await supabase.auth.getSession();
	if (!session) return false;

	_jwt = session.access_token;
	_state.isLoggedIn = true;
	_state.userId = session.user.id;
	_state.email = session.user.email || null;
	_notify();
	return true;
}

/** Check if user has an active Supabase session */
export async function checkSession(): Promise<boolean> {
	const { data: { session } } = await supabase.auth.getSession();
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

/** Cache PIN in localStorage with expiry (shared across tabs) */
const PIN_CACHE_KEY = '_wp';
const PIN_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

function cachePin(pin: string) {
	localStorage.setItem(PIN_CACHE_KEY, JSON.stringify({
		v: btoa(pin),
		exp: Date.now() + PIN_CACHE_TTL,
	}));
}

function getCachedPin(): string | null {
	try {
		const raw = localStorage.getItem(PIN_CACHE_KEY);
		if (!raw) return null;
		const { v, exp } = JSON.parse(raw);
		if (Date.now() > exp) { clearCachedPin(); return null; }
		return atob(v);
	} catch { return null; }
}

function clearCachedPin() {
	localStorage.removeItem(PIN_CACHE_KEY);
}

/** Sign out */
export async function signOut(): Promise<void> {
	clearCachedPin();
	await supabase.auth.signOut();
	_reset();
}

/**
 * Auto-reconnect on page load. Tries in order:
 * 1. Check Supabase session
 * 2. If session exists + vault exists + cached PIN → unlock silently
 * 3. If session exists + vault exists + no cached PIN → return 'needs-pin'
 * 4. If no session → return 'disconnected'
 */
export async function autoReconnect(): Promise<'connected' | 'needs-pin' | 'disconnected'> {
	const { data: { session } } = await supabase.auth.getSession();
	if (!session) return 'disconnected';

	_jwt = session.access_token;
	_state.isLoggedIn = true;
	_state.userId = session.user.id;
	_state.email = session.user.email || null;

	// Try to fetch vault
	try {
		const { salt, vault } = await fetchVault();
		if (!vault) return 'disconnected'; // logged in but no wallet
		_salt = salt;
		_accountCount = vault.account_count || 1;

		// Try cached PIN
		const cachedPin = getCachedPin();
		if (cachedPin) {
			const mnemonic = await (await import('./walletCrypto')).unlockWithPin(vault.primary_blob, cachedPin, salt);
			if (mnemonic) {
				_mnemonic = mnemonic;
				_deriveAccounts();
				_state.isUnlocked = true;
				_notify();
				return 'connected';
			}
			// Cached PIN is wrong (user changed it) — clear it
			clearCachedPin();
		}

		// Session + vault exist but no cached PIN
		_state.isUnlocked = false;
		_notify();
		return 'needs-pin';
	} catch {
		return 'disconnected';
	}
}

// ── API Helpers ──

async function apiFetch(method: string, body?: any): Promise<any> {
	if (!_jwt) throw new Error('Not authenticated');
	const headers: Record<string, string> = {
		'Authorization': `Bearer ${_jwt}`,
	};
	if (body) headers['Content-Type'] = 'application/json';
	const res = await fetch('/api/wallet', {
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

/** Fetch vault + salt from server */
async function fetchVault(): Promise<{ salt: string; vault: any | null }> {
	return apiFetch('GET');
}

/** Save vault to server */
async function saveVault(vault: WalletVault, accountCount: number, defaultAddress: string): Promise<string> {
	const res = await apiFetch('POST', {
		primaryBlob: vault.primaryBlob,
		recoveryBlob1: vault.recoveryBlob1,
		recoveryBlob2: vault.recoveryBlob2,
		recoveryBlob3: vault.recoveryBlob3,
		accountCount,
		defaultAddress,
	});
	return res.salt;
}

// ── Wallet Operations ──

/** Check if user has an existing vault */
export async function hasVault(): Promise<boolean> {
	const { vault } = await fetchVault();
	return vault !== null;
}

/**
 * Create a new wallet. Returns recovery codes (show once to user).
 * Mnemonic generated client-side, encrypted with PIN, saved to server.
 */
export async function createWallet(pin: string): Promise<{ recoveryCodes: string[]; address: string }> {
	if (!_jwt) throw new Error('Not authenticated');

	const { salt } = await fetchVault();
	_salt = salt;

	// Generate mnemonic client-side — never leaves the browser
	const mnemonic = ethers.Wallet.createRandom().mnemonic!.phrase;

	// Encrypt with PIN + salt
	const vault = await createWalletVault(mnemonic, pin, salt);

	// Derive first account
	const hdNode = ethers.HDNodeWallet.fromMnemonic(
		ethers.Mnemonic.fromPhrase(mnemonic),
		"m/44'/60'/0'/0"
	);
	const firstAccount = hdNode.deriveChild(0);

	// Save encrypted vault to server
	await saveVault(vault, 1, firstAccount.address);

	// Cache PIN for session (survives reload, cleared on tab close)
	cachePin(pin);

	// Unlock locally
	_mnemonic = mnemonic;
	_accountCount = 1;
	_state.accounts = [{
		index: 0,
		address: firstAccount.address,
		wallet: new ethers.Wallet(firstAccount.privateKey),
	}];
	_state.activeAccount = _state.accounts[0];
	_state.isUnlocked = true;
	_notify();

	return {
		recoveryCodes: vault.recoveryCodes,
		address: firstAccount.address,
	};
}

/**
 * Unlock existing wallet with PIN.
 * Fetches encrypted vault from server, decrypts client-side.
 */
export async function unlockWallet(pin: string): Promise<boolean> {
	if (!_jwt) throw new Error('Not authenticated');

	const { salt, vault } = await fetchVault();
	if (!vault) throw new Error('No wallet found. Create one first.');
	_salt = salt;

	const mnemonic = await unlockWithPin(vault.primary_blob, pin, salt);
	if (!mnemonic) return false; // wrong PIN

	// Cache PIN for session (survives reload, cleared on tab close)
	cachePin(pin);

	_mnemonic = mnemonic;
	_accountCount = vault.account_count || 1;

	// Derive all accounts
	_deriveAccounts();
	_state.isUnlocked = true;
	_notify();
	return true;
}

/**
 * Recover wallet with a recovery code. Returns true if successful.
 * After recovery, user must set a new PIN.
 */
export async function recoverWithCode(code: string): Promise<boolean> {
	if (!_jwt) throw new Error('Not authenticated');

	const { salt, vault } = await fetchVault();
	if (!vault) throw new Error('No wallet found.');
	_salt = salt;

	const blobs = [vault.recovery_blob_1, vault.recovery_blob_2, vault.recovery_blob_3];
	const mnemonic = await unlockWithRecoveryCode(blobs, code, salt);
	if (!mnemonic) return false; // wrong code

	_mnemonic = mnemonic;
	_accountCount = vault.account_count || 1;
	return true;
}

/**
 * Set new PIN after recovery. Re-encrypts vault and generates new recovery codes.
 */
export async function setNewPin(newPin: string): Promise<string[]> {
	if (!_mnemonic || !_salt) throw new Error('Wallet not recovered');

	const vault = await resetPin(_mnemonic, newPin, _salt);
	const hdNode = ethers.HDNodeWallet.fromMnemonic(
		ethers.Mnemonic.fromPhrase(_mnemonic),
		"m/44'/60'/0'/0"
	);
	const firstAccount = hdNode.deriveChild(0);

	await saveVault(vault, _accountCount, firstAccount.address);
	cachePin(newPin);

	// Derive accounts and unlock
	_deriveAccounts();
	_state.isUnlocked = true;
	_notify();

	return vault.recoveryCodes;
}

/** Derive a new account (next index) */
export async function addAccount(): Promise<EmbeddedAccount> {
	if (!_mnemonic || !_salt) throw new Error('Wallet not unlocked');

	const newIndex = _accountCount;
	_accountCount++;

	const hdNode = ethers.HDNodeWallet.fromMnemonic(
		ethers.Mnemonic.fromPhrase(_mnemonic),
		"m/44'/60'/0'/0"
	);
	const child = hdNode.deriveChild(newIndex);
	const account: EmbeddedAccount = {
		index: newIndex,
		address: child.address,
		wallet: new ethers.Wallet(child.privateKey),
	};

	_state.accounts.push(account);

	// Update server with new account count
	const { vault } = await fetchVault();
	if (vault) {
		await apiFetch('POST', {
			primaryBlob: vault.primary_blob,
			recoveryBlob1: vault.recovery_blob_1,
			recoveryBlob2: vault.recovery_blob_2,
			recoveryBlob3: vault.recovery_blob_3,
			accountCount: _accountCount,
			defaultAddress: _state.activeAccount?.address || account.address,
		});
	}

	_notify();
	return account;
}

/** Switch active account */
export function setActiveAccount(index: number): void {
	const account = _state.accounts.find(a => a.index === index);
	if (account) {
		_state.activeAccount = account;
		localStorage.setItem('_active_acct', String(index));
		_notify();
	}
}

/** Get an ethers Signer connected to a provider */
export function getSigner(provider: ethers.JsonRpcProvider): ethers.Wallet | null {
	if (!_state.activeAccount) return null;
	return _state.activeAccount.wallet.connect(provider);
}

/** Export the seed phrase (user explicitly requests it) */
export function exportSeedPhrase(): string | null {
	return _mnemonic;
}

/** Export a single account's private key */
export function exportPrivateKey(index: number): string | null {
	const account = _state.accounts.find(a => a.index === index);
	return account?.wallet.privateKey || null;
}

/** Lock wallet (clear mnemonic from memory, keep session) */
export function lockWallet(): void {
	_mnemonic = null;
	_state.isUnlocked = false;
	_state.accounts = [];
	_state.activeAccount = null;
	_notify();
}

// ── Internal ──

function _deriveAccounts(): void {
	if (!_mnemonic) return;
	const hdNode = ethers.HDNodeWallet.fromMnemonic(
		ethers.Mnemonic.fromPhrase(_mnemonic),
		"m/44'/60'/0'/0"
	);

	_state.accounts = [];
	for (let i = 0; i < _accountCount; i++) {
		const child = hdNode.deriveChild(i);
		_state.accounts.push({
			index: i,
			address: child.address,
			wallet: new ethers.Wallet(child.privateKey),
		});
	}
	// Restore saved active account index
	const savedIdx = parseInt(localStorage.getItem('_active_acct') || '0', 10);
	_state.activeAccount = _state.accounts.find(a => a.index === savedIdx) || _state.accounts[0] || null;
}
