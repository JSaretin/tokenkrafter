/**
 * AES-256-GCM encryption for sensitive data (payment details).
 * Uses ENCRYPTION_KEY env var (64-char hex = 32 bytes).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { env } from '$env/dynamic/private';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getKey(): Buffer {
	const key = env.ENCRYPTION_KEY;
	if (!key || key.length !== 64) {
		throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
	}
	return Buffer.from(key, 'hex');
}

/** Encrypt an object → base64 string (iv:tag:ciphertext) */
export function encrypt(data: Record<string, unknown>): string {
	const key = getKey();
	const iv = randomBytes(IV_LENGTH);
	const cipher = createCipheriv(ALGORITHM, key, iv);

	const plaintext = JSON.stringify(data);
	const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();

	// Pack as: iv + tag + ciphertext, then base64
	const packed = Buffer.concat([iv, tag, encrypted]);
	return packed.toString('base64');
}

/** Decrypt a base64 string → object */
export function decrypt(encoded: string): Record<string, unknown> {
	const key = getKey();
	const packed = Buffer.from(encoded, 'base64');

	const iv = packed.subarray(0, IV_LENGTH);
	const tag = packed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
	const ciphertext = packed.subarray(IV_LENGTH + TAG_LENGTH);

	const decipher = createDecipheriv(ALGORITHM, key, iv);
	decipher.setAuthTag(tag);

	const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
	return JSON.parse(decrypted.toString('utf8'));
}
