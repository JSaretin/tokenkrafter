/**
 * Passkey unlock for the embedded wallet.
 *
 * The wallet's seed is encrypted by the user's PIN. To skip typing the
 * PIN every time, we let the user register a passkey with the WebAuthn
 * PRF extension. The passkey's PRF output (a per-credential HMAC over
 * a stable salt) is used to derive an AES-GCM key that encrypts the
 * PIN locally. On unlock, FaceID/TouchID releases the PRF output,
 * which decrypts the PIN, which decrypts the vault.
 *
 * Properties:
 * - The server never sees the passkey, the PRF output, or the PIN.
 * - The encrypted PIN sits in localStorage; without the passkey
 *   (which lives in the device's secure enclave), it can't be
 *   decrypted — even by the user without their device.
 * - PRF is the load-bearing primitive. If the browser doesn't
 *   support it, isPasskeySupported() returns false and the UI
 *   keeps the PIN-only flow.
 */

const STORAGE_PREFIX = 'pk_';

interface StoredPasskey {
	credentialId: string; // base64url
	prfSalt: string;      // base64url, 32 bytes
	encryptedPin: string; // base64url, AES-GCM ciphertext
	iv: string;           // base64url, 12 bytes
	createdAt: number;
}

function storageKey(userId: string): string {
	return `${STORAGE_PREFIX}${userId}`;
}

// ── Encoding helpers ───────────────────────────────────────────────

function b64uEncode(buf: ArrayBuffer | Uint8Array): string {
	const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
	let s = '';
	for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64uDecode(s: string): ArrayBuffer {
	const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
	const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	// Return the underlying ArrayBuffer so callers can pass it directly to
	// WebAuthn / WebCrypto APIs (BufferSource). Avoids a TS strictness
	// mismatch between Uint8Array<ArrayBufferLike> and ArrayBuffer.
	return out.buffer;
}

// ── Capability check ────────────────────────────────────────────────

export function isPasskeySupported(): boolean {
	if (typeof window === 'undefined') return false;
	if (!('credentials' in navigator)) return false;
	if (!('PublicKeyCredential' in window)) return false;
	return true;
}

/** Conservative check — does the browser actually expose PRF? Verified
 *  at registration time because some browsers report support but reject
 *  the extension at create time on certain authenticators. */
async function probePrf(): Promise<boolean> {
	if (!isPasskeySupported()) return false;
	try {
		// Static check via getClientCapabilities (Chrome 121+)
		const caps = (PublicKeyCredential as any).getClientCapabilities;
		if (typeof caps === 'function') {
			const r = await caps.call(PublicKeyCredential);
			if (r && typeof r.extensionPrf === 'boolean') return r.extensionPrf;
		}
	} catch {}
	return true; // Assume yes; the create() call will reject if not.
}

// ── Storage ────────────────────────────────────────────────────────

export function hasPasskey(userId: string): boolean {
	if (typeof window === 'undefined' || !userId) return false;
	return !!localStorage.getItem(storageKey(userId));
}

function loadPasskey(userId: string): StoredPasskey | null {
	if (typeof window === 'undefined' || !userId) return null;
	try {
		const raw = localStorage.getItem(storageKey(userId));
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		if (!parsed?.credentialId || !parsed?.prfSalt || !parsed?.encryptedPin || !parsed?.iv) return null;
		return parsed as StoredPasskey;
	} catch {
		return null;
	}
}

export function disablePasskey(userId: string) {
	if (typeof window === 'undefined' || !userId) return;
	try { localStorage.removeItem(storageKey(userId)); } catch {}
}

// ── PRF → AES-GCM key derivation ────────────────────────────────────

async function deriveKey(prfOutput: ArrayBuffer): Promise<CryptoKey> {
	// HKDF-SHA256 over the PRF output to a 256-bit AES-GCM key.
	const ikm = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey']);
	return crypto.subtle.deriveKey(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: new Uint8Array(0),
			info: new TextEncoder().encode('tokenkrafter:passkey:pin-aes-gcm'),
		},
		ikm,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt'],
	);
}

// ── Setup: register passkey + encrypt PIN ───────────────────────────

export async function setupPasskey(opts: {
	userId: string;
	userEmail: string;
	displayName: string;
	pin: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
	if (!isPasskeySupported()) return { ok: false, reason: 'Passkeys not supported on this browser' };
	if (!(await probePrf())) return { ok: false, reason: 'PRF extension not available' };

	const challenge = crypto.getRandomValues(new Uint8Array(32));
	const userIdBytes = new TextEncoder().encode(opts.userId);
	const prfSalt = crypto.getRandomValues(new Uint8Array(32));

	let cred: PublicKeyCredential;
	try {
		cred = (await navigator.credentials.create({
			publicKey: {
				challenge,
				rp: { name: 'TokenKrafter', id: window.location.hostname },
				user: {
					id: userIdBytes,
					name: opts.userEmail,
					displayName: opts.displayName,
				},
				pubKeyCredParams: [
					{ type: 'public-key', alg: -7 },   // ES256
					{ type: 'public-key', alg: -257 }, // RS256
				],
				authenticatorSelection: {
					residentKey: 'preferred',
					userVerification: 'required',
				},
				timeout: 60_000,
				extensions: { prf: { eval: { first: prfSalt } } } as any,
			},
		})) as PublicKeyCredential;
	} catch (e: any) {
		return { ok: false, reason: e?.message || 'Passkey registration cancelled' };
	}
	if (!cred) return { ok: false, reason: 'No credential returned' };

	const ext = (cred.getClientExtensionResults() as any)?.prf;
	const firstAtCreate = ext?.results?.first as ArrayBuffer | undefined;

	// Some authenticators only release the PRF output on get(), not
	// create(). If we don't have it now, immediately do a get() with
	// the same salt to fetch it.
	let prfOutput: ArrayBuffer;
	if (firstAtCreate) {
		prfOutput = firstAtCreate;
	} else {
		try {
			const assertion = (await navigator.credentials.get({
				publicKey: {
					challenge: crypto.getRandomValues(new Uint8Array(32)),
					rpId: window.location.hostname,
					allowCredentials: [{ type: 'public-key', id: cred.rawId }],
					userVerification: 'required',
					timeout: 60_000,
					extensions: { prf: { eval: { first: prfSalt } } } as any,
				},
			})) as PublicKeyCredential;
			const a = (assertion.getClientExtensionResults() as any)?.prf?.results?.first;
			if (!a) return { ok: false, reason: 'Authenticator did not release PRF output' };
			prfOutput = a;
		} catch (e: any) {
			return { ok: false, reason: e?.message || 'Could not retrieve PRF output' };
		}
	}

	// Encrypt the PIN under the PRF-derived key.
	const key = await deriveKey(prfOutput);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv },
		key,
		new TextEncoder().encode(opts.pin),
	);

	const stored: StoredPasskey = {
		credentialId: b64uEncode(cred.rawId),
		prfSalt: b64uEncode(prfSalt),
		encryptedPin: b64uEncode(ciphertext),
		iv: b64uEncode(iv),
		createdAt: Date.now(),
	};
	try {
		localStorage.setItem(storageKey(opts.userId), JSON.stringify(stored));
	} catch (e: any) {
		return { ok: false, reason: 'localStorage write failed' };
	}
	return { ok: true };
}

// ── Unlock: passkey → PRF → decrypt PIN ────────────────────────────

export async function unlockWithPasskey(userId: string): Promise<
	{ ok: true; pin: string } | { ok: false; reason: string }
> {
	const stored = loadPasskey(userId);
	if (!stored) return { ok: false, reason: 'No passkey registered' };
	if (!isPasskeySupported()) return { ok: false, reason: 'Passkeys not supported' };

	const credentialId = b64uDecode(stored.credentialId);
	const prfSalt = b64uDecode(stored.prfSalt);

	let assertion: PublicKeyCredential;
	try {
		assertion = (await navigator.credentials.get({
			publicKey: {
				challenge: crypto.getRandomValues(new Uint8Array(32)),
				rpId: window.location.hostname,
				allowCredentials: [{ type: 'public-key', id: credentialId }],
				userVerification: 'required',
				timeout: 60_000,
				extensions: { prf: { eval: { first: prfSalt } } } as any,
			},
		})) as PublicKeyCredential;
	} catch (e: any) {
		return { ok: false, reason: e?.message || 'Passkey unlock cancelled' };
	}

	const prfOut = (assertion.getClientExtensionResults() as any)?.prf?.results?.first as
		| ArrayBuffer
		| undefined;
	if (!prfOut) return { ok: false, reason: 'Authenticator did not release PRF output' };

	try {
		const key = await deriveKey(prfOut);
		const plain = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: b64uDecode(stored.iv) },
			key,
			b64uDecode(stored.encryptedPin),
		);
		return { ok: true, pin: new TextDecoder().decode(plain) };
	} catch (e: any) {
		return { ok: false, reason: 'Decryption failed — passkey/key mismatch' };
	}
}
