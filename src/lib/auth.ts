/**
 * Wallet-based authentication helpers.
 * No accounts, no sessions — the wallet IS the identity.
 */
import { ethers } from 'ethers';
import { env } from '$env/dynamic/private';

const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Recover wallet address from a signed message.
 * Validates timestamp freshness and origin to prevent replay/phishing attacks.
 * Returns the lowercase wallet address.
 */
export function recoverWallet(signature: string, message: string): string {
	const recovered = ethers.verifyMessage(message, signature).toLowerCase();

	// Verify timestamp freshness
	const tsMatch = message.match(/Timestamp: (\d+)/);
	if (tsMatch) {
		const ts = parseInt(tsMatch[1]);
		if (Date.now() - ts > SIGNATURE_MAX_AGE_MS) {
			throw new Error('Signature expired');
		}
	}

	// Verify origin if ALLOWED_ORIGINS is set
	const allowedOrigins = env.ALLOWED_ORIGINS;
	if (allowedOrigins) {
		const origins = allowedOrigins.split(',').map(o => o.trim().toLowerCase());
		const originMatch = message.match(/Origin: (.+)/);
		if (!originMatch) {
			throw new Error('Missing origin in signed message');
		}
		if (!origins.includes(originMatch[1].toLowerCase())) {
			throw new Error('Invalid origin');
		}
	}

	return recovered;
}

/**
 * Verify the signer is an admin.
 * Checks recovered address against ADMIN_WALLETS env var.
 * Returns the admin wallet address.
 */
export function verifyAdmin(signature: string, message: string): string {
	const recovered = recoverWallet(signature, message);

	const admins = (env.ADMIN_WALLETS || '')
		.split(',')
		.map(a => a.trim().toLowerCase())
		.filter(Boolean);

	if (admins.length === 0) {
		throw new Error('No admin wallets configured');
	}

	if (!admins.includes(recovered)) {
		throw new Error('Not an admin');
	}

	return recovered;
}

/**
 * Verify the signer is the creator of a resource.
 * Returns the recovered wallet address.
 */
export function verifyCreator(signature: string, message: string, creator: string): string {
	const recovered = recoverWallet(signature, message);

	if (recovered !== creator.toLowerCase()) {
		throw new Error('Not the creator');
	}

	return recovered;
}

// ── Admin session (HMAC-based, no JWT dependency) ──────────

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function getSessionKey(): Uint8Array {
	const key = env.ENCRYPTION_KEY;
	if (!key || key.length < 32) throw new Error('ENCRYPTION_KEY required for sessions');
	// Use first 32 chars of ENCRYPTION_KEY as session HMAC key
	const bytes = new Uint8Array(16);
	for (let i = 0; i < 16; i++) {
		bytes[i] = parseInt(key.substring(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

/**
 * Create an admin session token: wallet:expiry:hmac
 */
export async function createAdminSession(wallet: string): Promise<string> {
	const expiry = Date.now() + SESSION_TTL_MS;
	const payload = `${wallet.toLowerCase()}:${expiry}`;

	const key = await crypto.subtle.importKey(
		'raw', getSessionKey(), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
	);
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
	const hmac = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');

	return `${payload}:${hmac}`;
}

/**
 * Verify an admin session token. Returns wallet address or null.
 */
export async function verifyAdminSession(token: string): Promise<string | null> {
	const parts = token.split(':');
	if (parts.length !== 3) return null;

	const [wallet, expiryStr, hmac] = parts;
	const expiry = parseInt(expiryStr);

	// Check expiry
	if (isNaN(expiry) || Date.now() > expiry) return null;

	// Check wallet is still an admin
	const admins = (env.ADMIN_WALLETS || '')
		.split(',')
		.map(a => a.trim().toLowerCase())
		.filter(Boolean);
	if (!admins.includes(wallet.toLowerCase())) return null;

	// Verify HMAC
	const payload = `${wallet}:${expiryStr}`;
	const key = await crypto.subtle.importKey(
		'raw', getSessionKey(), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
	);
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
	const expected = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');

	if (hmac !== expected) return null;

	return wallet;
}
