import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resolveAccount } from '$lib/flutterwave';

// Cache successful resolutions for 3 months. Account holder names rarely
// change per (bank_code, account_number), and we want to stop hammering
// Flutterwave for repeat lookups within the same flow / across sessions.
//
// 90 days ≈ 7,776,000 seconds. `public` lets shared caches (browser, CDN)
// store it. `immutable` hints to skip revalidation within maxAge. `s-maxage`
// mirrors `max-age` so Cloudflare treats it the same as the browser.
const CACHE_3_MONTHS =
	'public, max-age=7776000, s-maxage=7776000, immutable';

// Errors get a short cache — don't keep negative results around if the
// user mistypes then fixes it, but also don't hit Flutterwave on every
// keystroke when the input is wrong.
const CACHE_ERROR = 'public, max-age=60, s-maxage=60';

/**
 * GET /api/bank/resolve?account_number=...&account_bank=...
 *
 * Resolve a Nigerian bank account via Flutterwave. GET is used instead of
 * POST so browsers and Cloudflare can cache the response. Query params
 * form the cache key automatically.
 */
export const GET: RequestHandler = async ({ url }) => {
	const accountNumber = url.searchParams.get('account_number');
	const accountBank = url.searchParams.get('account_bank');

	if (!accountNumber || !accountBank) {
		return error(400, 'account_number and account_bank required');
	}

	if (!/^\d{10}$/.test(accountNumber)) {
		return error(400, 'Account number must be 10 digits');
	}

	try {
		const result = await resolveAccount(accountNumber, accountBank);

		if (result.account_name) {
			return json(
				{ account_name: result.account_name, account_number: accountNumber },
				{ headers: { 'cache-control': CACHE_3_MONTHS } },
			);
		}

		return json(
			{ account_name: null, error: result.error || 'Could not resolve account' },
			{ status: 404, headers: { 'cache-control': CACHE_ERROR } },
		);
	} catch (e: any) {
		return json(
			{ account_name: null, error: e.message || 'Failed to reach Flutterwave' },
			{ status: 502, headers: { 'cache-control': 'no-store' } },
		);
	}
};

/**
 * POST /api/bank/resolve — legacy JSON-body variant. Kept for backwards
 * compatibility with any older clients; new code should use GET so the
 * response is cacheable.
 */
export const POST: RequestHandler = async ({ request }) => {
	const { account_number, account_bank } = await request.json();

	if (!account_number || !account_bank) {
		return error(400, 'account_number and account_bank required');
	}

	if (!/^\d{10}$/.test(account_number)) {
		return error(400, 'Account number must be 10 digits');
	}

	try {
		const result = await resolveAccount(account_number, account_bank);

		if (result.account_name) {
			return json({
				account_name: result.account_name,
				account_number,
			});
		}

		return json(
			{ account_name: null, error: result.error || 'Could not resolve account' },
			{ status: 404 },
		);
	} catch (e: any) {
		return json(
			{ account_name: null, error: e.message || 'Failed to reach Flutterwave' },
			{ status: 502 },
		);
	}
};
