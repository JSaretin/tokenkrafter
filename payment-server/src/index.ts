/**
 * Payment Proxy Server (Bun)
 *
 * Lightweight proxy that relays Flutterwave API calls from the SvelteKit
 * backend through a whitelisted IP. No business logic — just auth check,
 * forward, return.
 *
 * Endpoints:
 *   POST /transfer          — Initiate bank transfer
 *   POST /resolve-account   — Resolve bank account name
 *   GET  /balance/:currency — Check Flutterwave wallet balance
 *   GET  /transfer/:id      — Check transfer status
 *   GET  /banks/:country    — List banks
 *   GET  /health            — Health check
 *
 * Auth: TX_CONFIRM_SECRET bearer token on all endpoints.
 * Env:  TX_CONFIRM_SECRET, FLUTTERWAVE_SECRET_KEY, PORT (default 4100)
 */

const PORT = parseInt(Bun.env.PORT || '4100');
const TX_SECRET = Bun.env.TX_CONFIRM_SECRET;
const FLW_KEY = Bun.env.FLUTTERWAVE_SECRET_KEY;
const FLW_BASE = 'https://api.flutterwave.com/v3';

if (!TX_SECRET) {
	console.error('TX_CONFIRM_SECRET is required');
	process.exit(1);
}
if (!FLW_KEY) {
	console.error('FLUTTERWAVE_SECRET_KEY is required');
	process.exit(1);
}

/** Verify the caller's bearer token */
function checkAuth(req: Request): boolean {
	const auth = req.headers.get('authorization');
	return auth === `Bearer ${TX_SECRET}`;
}

/** Forward a request to Flutterwave v3 API */
async function flwFetch(path: string, options: RequestInit = {}): Promise<Response> {
	const res = await fetch(`${FLW_BASE}${path}`, {
		...options,
		headers: {
			Authorization: `Bearer ${FLW_KEY}`,
			'Content-Type': 'application/json',
			...options.headers,
		},
	});
	const data = await res.json();
	return Response.json(data, { status: res.status });
}

/** Simple JSON error response */
function err(status: number, message: string): Response {
	return Response.json({ status: 'error', message }, { status });
}

const server = Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);
		const path = url.pathname;

		// Health check (no auth)
		if (path === '/health') {
			return Response.json({ ok: true, time: new Date().toISOString() });
		}

		// Auth check on everything else
		if (!checkAuth(req)) {
			return err(401, 'Unauthorized');
		}

		// ── POST /transfers — Initiate bank transfer ──
		if (req.method === 'POST' && path === '/transfers') {
			try {
				const body = await req.json();
				const { account_bank, account_number, amount, currency, narration, reference, beneficiary_name } = body;

				if (!account_bank || !account_number || !amount) {
					return err(400, 'account_bank, account_number, and amount required');
				}

				return await flwFetch('/transfers', {
					method: 'POST',
					body: JSON.stringify({
						account_bank,
						account_number,
						amount,
						currency: currency || 'NGN',
						narration: narration || 'TokenKrafter payout',
						reference: reference || `TKR-${Date.now()}`,
						beneficiary_name,
					}),
				});
			} catch (e: any) {
				return err(500, e.message || 'Transfer failed');
			}
		}

		// ── POST /accounts/resolve — Resolve bank account name ──
		if (req.method === 'POST' && path === '/accounts/resolve') {
			try {
				const body = await req.json();
				return await flwFetch('/accounts/resolve', {
					method: 'POST',
					body: JSON.stringify({
						account_number: body.account_number,
						account_bank: body.account_bank,
					}),
				});
			} catch (e: any) {
				return err(500, e.message || 'Resolve failed');
			}
		}

		// ── GET /balances/:currency — Check wallet balance ──
		const balanceMatch = path.match(/^\/balances\/(\w+)$/);
		if (req.method === 'GET' && balanceMatch) {
			return await flwFetch(`/balances/${balanceMatch[1]}`);
		}

		// ── GET /transfers/:id — Check transfer status ──
		const statusMatch = path.match(/^\/transfers\/(\d+)$/);
		if (req.method === 'GET' && statusMatch) {
			return await flwFetch(`/transfers/${statusMatch[1]}`);
		}

		// ── GET /banks/:country — List banks ──
		const banksMatch = path.match(/^\/banks\/(\w+)$/);
		if (req.method === 'GET' && banksMatch) {
			return await flwFetch(`/banks/${banksMatch[1]}`);
		}

		return err(404, 'Not found');
	},
});

console.log(`Payment proxy running on :${server.port}`);
