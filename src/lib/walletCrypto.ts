/**
 * Client-side wallet encryption using Web Crypto API.
 * Seed phrase encrypted with PBKDF2(pin, salt) → AES-256-GCM.
 * Salt comes from server: HMAC(SERVER_SECRET, user_id).
 * PIN/recovery codes never leave the client.
 */

const PBKDF2_ITERATIONS = 600_000;
const IV_LENGTH = 12;
const SALT_LABEL = 'tokenkrafter-wallet-v1';

// ── Helpers ──

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

// ── Key Derivation ──

/** Derive AES-256 key from a secret (PIN or recovery code) + server salt */
async function deriveKey(secret: string, salt: string): Promise<CryptoKey> {
	const encoder = new TextEncoder();
	const keyMaterial = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		'PBKDF2',
		false,
		['deriveKey']
	);

	const saltBytes = encoder.encode(`${SALT_LABEL}:${salt}`);

	return crypto.subtle.deriveKey(
		{ name: 'PBKDF2', salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
		keyMaterial,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt']
	);
}

// ── Encrypt / Decrypt ──

/** Encrypt plaintext → base64 string (iv + ciphertext + tag) */
async function encryptData(plaintext: string, secret: string, salt: string): Promise<string> {
	const key = await deriveKey(secret, salt);
	const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
	const encoded = new TextEncoder().encode(plaintext);

	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv, tagLength: 128 },
		key,
		encoded
	);

	const packed = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
	packed.set(iv, 0);
	packed.set(new Uint8Array(ciphertext), IV_LENGTH);
	return bytesToBase64(packed);
}

/** Decrypt base64 string → plaintext. Returns null if wrong secret. */
async function decryptData(encrypted: string, secret: string, salt: string): Promise<string | null> {
	try {
		const key = await deriveKey(secret, salt);
		const packed = base64ToBytes(encrypted);
		const iv = packed.slice(0, IV_LENGTH);
		const ciphertext = packed.slice(IV_LENGTH);

		const plaintext = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv, tagLength: 128 },
			key,
			ciphertext
		);

		return new TextDecoder().decode(plaintext);
	} catch {
		return null; // wrong PIN or corrupted data
	}
}

// ── Recovery Code Generation ──

/** Generate a human-readable recovery code: XXXX-XXXX-XXXX-XXXX */
export function generateRecoveryCode(): string {
	const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	const parts: string[] = [];
	for (let p = 0; p < 4; p++) {
		let chunk = '';
		for (let i = 0; i < 4; i++) {
			chunk += chars[bytes[p * 4 + i] % chars.length];
		}
		parts.push(chunk);
	}
	return parts.join('-');
}

// ── Public API ──

export interface WalletVault {
	primaryBlob: string;
	recoveryBlob1: string;
	recoveryBlob2: string;
	recoveryBlob3: string;
	recoveryCodes: string[]; // shown once to user, never stored
}

/**
 * Create a new encrypted wallet vault.
 * Returns encrypted blobs (for DB) + recovery codes (show to user once).
 */
export async function createWalletVault(
	mnemonic: string,
	pin: string,
	salt: string
): Promise<WalletVault> {
	const code1 = generateRecoveryCode();
	const code2 = generateRecoveryCode();
	const code3 = generateRecoveryCode();

	const [primaryBlob, recoveryBlob1, recoveryBlob2, recoveryBlob3] = await Promise.all([
		encryptData(mnemonic, pin, salt),
		encryptData(mnemonic, code1, salt),
		encryptData(mnemonic, code2, salt),
		encryptData(mnemonic, code3, salt),
	]);

	return {
		primaryBlob,
		recoveryBlob1,
		recoveryBlob2,
		recoveryBlob3,
		recoveryCodes: [code1, code2, code3],
	};
}

/**
 * Decrypt wallet with PIN.
 * Returns mnemonic or null if wrong PIN.
 */
export async function unlockWithPin(
	primaryBlob: string,
	pin: string,
	salt: string
): Promise<string | null> {
	return decryptData(primaryBlob, pin, salt);
}

/**
 * Encrypt a plaintext mnemonic with a PIN. Used by the import flow for
 * wallets that don't need platform-generated recovery codes (the user is
 * expected to keep their own backup).
 */
export async function encryptWithPin(
	plaintext: string,
	pin: string,
	salt: string
): Promise<string> {
	return encryptData(plaintext, pin, salt);
}

/**
 * Try to decrypt wallet with a recovery code.
 * Tries all 3 recovery blobs — returns mnemonic if any matches.
 */
export async function unlockWithRecoveryCode(
	recoveryBlobs: string[],
	code: string,
	salt: string
): Promise<string | null> {
	for (const blob of recoveryBlobs) {
		const result = await decryptData(blob, code, salt);
		if (result) return result;
	}
	return null;
}

/**
 * Re-encrypt with a new PIN and generate new recovery codes.
 * Used after PIN recovery.
 */
export async function resetPin(
	mnemonic: string,
	newPin: string,
	salt: string
): Promise<WalletVault> {
	return createWalletVault(mnemonic, newPin, salt);
}
