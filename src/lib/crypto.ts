/**
 * AES-256-GCM encryption for sensitive data (payment details).
 * Uses Web Crypto API — compatible with Cloudflare Workers, Deno, Node 18+.
 * ENCRYPTION_KEY env var: 64-char hex string (32 bytes).
 */
import { env } from '$env/dynamic/private';

const ALGORITHM = 'AES-GCM';
const IV_LENGTH = 12;
const TAG_LENGTH = 128; // bits (Web Crypto uses bit length)

function hexToBytes(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

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

async function getKey(): Promise<CryptoKey> {
	const keyHex = env.ENCRYPTION_KEY;
	if (!keyHex || keyHex.length !== 64) {
		throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
	}
	const rawKey = hexToBytes(keyHex);
	return crypto.subtle.importKey(
		'raw',
		rawKey.buffer as ArrayBuffer,
		{ name: ALGORITHM },
		false,
		['encrypt', 'decrypt']
	);
}

/** Encrypt an object → base64 string */
export async function encrypt(data: Record<string, unknown>): Promise<string> {
	const key = await getKey();
	const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
	const plaintext = new TextEncoder().encode(JSON.stringify(data));

	const ciphertext = await crypto.subtle.encrypt(
		{ name: ALGORITHM, iv, tagLength: TAG_LENGTH },
		key,
		plaintext
	);

	// Web Crypto appends the auth tag to the ciphertext
	// Pack as: iv + ciphertext (which includes tag)
	const packed = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
	packed.set(iv, 0);
	packed.set(new Uint8Array(ciphertext), IV_LENGTH);

	return bytesToBase64(packed);
}

/** Decrypt a base64 string → object */
export async function decrypt(encoded: string): Promise<Record<string, unknown>> {
	const key = await getKey();
	const packed = base64ToBytes(encoded);

	const iv = packed.slice(0, IV_LENGTH);
	const ciphertext = packed.slice(IV_LENGTH);

	const plaintext = await crypto.subtle.decrypt(
		{ name: ALGORITHM, iv, tagLength: TAG_LENGTH },
		key,
		ciphertext
	);

	return JSON.parse(new TextDecoder().decode(plaintext));
}
