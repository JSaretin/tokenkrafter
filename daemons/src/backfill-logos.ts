#!/usr/bin/env bun
/**
 * Backfill: cache external token logos into our Supabase storage.
 *
 * Walks created_tokens for the given chain, finds rows whose logo_url
 * still points at an external CDN (typically GeckoTerminal /
 * CoinGecko), signs in as that token's creator wallet (looked up in
 * the bot's HD-derived pool from BOT_MNEMONIC), downloads the image,
 * and POSTs it to /api/token-metadata/upload — the endpoint stores
 * it in the token-logos bucket and updates the row's logo_url.
 *
 * Usage:
 *   set -a; source .envs/prod/global.env; source .envs/prod/activity-bot.env; set +a
 *   bun scripts/backfill-logos.mjs [chain_id]
 *
 * Skips:
 *   - Rows whose logo_url already points at our supabase storage.
 *   - Rows whose creator isn't in the bot's wallet pool (we can't
 *     sign for those — the actual creator must use the FE).
 *   - Rows with no logo_url at all.
 */
import { ethers } from 'ethers';

const API_BASE = process.env.API_BASE_URL || 'https://tokenkrafter.com';
const SYNC_SECRET = process.env.SYNC_SECRET || '';
const MNEMONIC = process.env.BOT_MNEMONIC || '';
const WALLET_COUNT = parseInt(process.env.WALLET_COUNT || '50', 10);
const CHAIN_ID = parseInt(process.argv[2] || process.env.CHAIN_ID || '56', 10);

if (!MNEMONIC) {
	console.error('❌ BOT_MNEMONIC required (source .envs/prod/activity-bot.env)');
	process.exit(1);
}

// Build address → wallet map. Same derivation path as the bot.
function deriveWallets(mnemonic, count) {
	const hd = ethers.HDNodeWallet.fromMnemonic(ethers.Mnemonic.fromPhrase(mnemonic), "m/44'/60'/0'/0");
	const wallets = new Map();
	for (let i = 0; i < count; i++) {
		const child = hd.deriveChild(i);
		const w = new ethers.Wallet(child.privateKey);
		wallets.set(w.address.toLowerCase(), { wallet: w, idx: i });
	}
	return wallets;
}

async function getWalletSession(wallet) {
	const timestamp = Date.now();
	const message = `TokenKrafter Auth\nAddress: ${wallet.address}\nOrigin: ${API_BASE}\nTimestamp: ${timestamp}`;
	const signature = await wallet.signMessage(message);
	const res = await fetch(`${API_BASE}/api/auth`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-wallet-address': wallet.address.toLowerCase(),
		},
		body: JSON.stringify({ signature, signed_message: message }),
	});
	if (!res.ok) return null;
	const setCookie = res.headers.get('set-cookie') || '';
	const m = setCookie.match(/session=[^;]+/);
	return m ? m[0] : null;
}

function isExternalLogo(url) {
	if (!url) return false;
	if (!url.startsWith('http')) return false;
	// Already in our supabase storage — skip.
	if (url.includes('/storage/v1/object/public/token-logos/')) return false;
	return true;
}

async function backfillOne(token, walletMap) {
	const creator = (token.creator || '').toLowerCase();
	const entry = walletMap.get(creator);
	if (!entry) return { ok: false, reason: 'creator-not-in-pool' };

	// Sign in as the creator.
	const cookie = await getWalletSession(entry.wallet);
	if (!cookie) return { ok: false, reason: 'sign-failed' };

	// Download the external image.
	let blob;
	let contentType;
	try {
		const r = await fetch(token.logo_url);
		if (!r.ok) return { ok: false, reason: `download-${r.status}` };
		blob = await r.blob();
		contentType = r.headers.get('content-type') || 'image/png';
	} catch (e) {
		return { ok: false, reason: `download-${(e.message || '').slice(0, 40)}` };
	}
	if (!blob || blob.size === 0) return { ok: false, reason: 'empty-blob' };
	if (blob.size > 2 * 1024 * 1024) return { ok: false, reason: 'too-big' };

	// Upload via the wallet-authed endpoint.
	const fd = new FormData();
	fd.append('file', new File([blob], 'logo', { type: contentType }));
	fd.append('address', token.address.toLowerCase());
	fd.append('chain_id', String(token.chain_id));
	const up = await fetch(`${API_BASE}/api/token-metadata/upload`, {
		method: 'POST',
		headers: {
			'x-wallet-address': entry.wallet.address.toLowerCase(),
			// SvelteKit's CSRF middleware blocks cross-site multipart
			// POSTs when Origin doesn't match the host — set it
			// explicitly so the request is treated as same-origin.
			Origin: API_BASE,
			Cookie: cookie,
		},
		body: fd,
	});
	if (!up.ok) {
		const txt = await up.text().catch(() => '');
		return { ok: false, reason: `upload-${up.status}-${txt.slice(0, 60)}` };
	}
	const body = await up.json();
	return { ok: true, walletIdx: entry.idx, newLogoUrl: body.logo_url };
}

async function main() {
	console.log(`Backfilling logos on chain ${CHAIN_ID}…`);
	console.log(`  API:    ${API_BASE}`);
	console.log(`  Wallets: ${WALLET_COUNT} derived from BOT_MNEMONIC`);

	const walletMap = deriveWallets(MNEMONIC, WALLET_COUNT);
	console.log(`  Pool:   ${walletMap.size} wallets`);

	// Pull every token on this chain. If the row count grows past the
	// API's default page size we'll add pagination — for now this is
	// fine since the platform is new.
	const headers = {};
	if (SYNC_SECRET) headers.Authorization = `Bearer ${SYNC_SECRET}`;
	const res = await fetch(`${API_BASE}/api/created-tokens?chain_id=${CHAIN_ID}`, { headers });
	if (!res.ok) {
		console.error(`Failed to list tokens: ${res.status}`);
		process.exit(1);
	}
	const all = await res.json();
	const candidates = all.filter((t) => isExternalLogo(t.logo_url));
	console.log(`  Tokens: ${all.length} total, ${candidates.length} need backfill`);

	let ok = 0;
	let skipped = 0;
	let failed = 0;
	for (let i = 0; i < candidates.length; i++) {
		const t = candidates[i];
		const tag = `[${i + 1}/${candidates.length}] ${t.symbol || '???'} ${t.address.slice(0, 10)}…`;
		try {
			const r = await backfillOne(t, walletMap);
			if (r.ok) {
				ok += 1;
				console.log(`  ✅ ${tag} (wallet[${r.walletIdx}])`);
			} else if (r.reason === 'creator-not-in-pool') {
				skipped += 1;
				console.log(`  ⏭️  ${tag} (creator ${t.creator.slice(0, 10)}… not in pool)`);
			} else {
				failed += 1;
				console.log(`  ❌ ${tag} ${r.reason}`);
			}
		} catch (e) {
			failed += 1;
			console.log(`  ❌ ${tag} error: ${(e.message || '').slice(0, 80)}`);
		}
		// Pace the loop so we don't pummel the storage upload endpoint.
		if (i + 1 < candidates.length) await new Promise((r) => setTimeout(r, 250));
	}

	console.log(`\nDone. ok=${ok} skipped=${skipped} failed=${failed}`);
}

main().catch((e) => {
	console.error('Fatal:', e);
	process.exit(1);
});
