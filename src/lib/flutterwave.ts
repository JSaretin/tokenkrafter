import { env } from '$env/dynamic/private';

// ═══════════════════════════════════════════════════════════════
// Flutterwave dual-API client
//
// v3 API (api.flutterwave.com/v3/) — uses FLWSECK key directly
//   → Banks list, account resolve, transfers
//
// v4 API (developersandbox-api.flutterwave.com) — uses OAuth token
//   → Virtual accounts, charges, customers
// ═══════════════════════════════════════════════════════════════

const V3_BASE = 'https://api.flutterwave.com/v3';

const IDP_URL = 'https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token';
const isProd = env.NODE_ENV === 'production';
const V4_BASE = isProd
	? 'https://f4bexperience.flutterwave.com'
	: 'https://developersandbox-api.flutterwave.com';

// ── v3 API (FLWSECK key) ──────────────────────────────────────

function getV3Key(): string {
	const key = env.FLUTTERWAVE_SECRET_KEY;
	if (!key) throw new Error('FLUTTERWAVE_SECRET_KEY (FLWSECK- key) required');
	return key;
}

async function v3Fetch(path: string, options: RequestInit = {}): Promise<any> {
	const res = await fetch(`${V3_BASE}${path}`, {
		...options,
		headers: {
			'Authorization': `Bearer ${getV3Key()}`,
			'Content-Type': 'application/json',
			...options.headers
		}
	});
	return res.json();
}

// ── v4 API (OAuth token) ──────────────────────────────────────

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

async function getV4Token(): Promise<string> {
	if (cachedToken && Date.now() < tokenExpiresAt - 60_000) {
		return cachedToken;
	}

	const clientId = env.FLUTTERWAVE_CLIENT_ID;
	const clientSecret = env.FLUTTERWAVE_V4_CLIENT_SECRET;

	if (!clientId || !clientSecret) {
		throw new Error('FLUTTERWAVE_CLIENT_ID and FLUTTERWAVE_V4_CLIENT_SECRET required');
	}

	const res = await fetch(IDP_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			grant_type: 'client_credentials'
		})
	});

	const data = await res.json();

	if (!data.access_token) {
		throw new Error(`Flutterwave OAuth failed: ${data.error_description || data.error || 'Unknown'}`);
	}

	cachedToken = data.access_token;
	tokenExpiresAt = Date.now() + (data.expires_in * 1000);
	return cachedToken;
}

async function v4Fetch(path: string, options: RequestInit = {}): Promise<any> {
	const token = await getV4Token();
	const res = await fetch(`${V4_BASE}${path}`, {
		...options,
		headers: {
			'Authorization': `Bearer ${token}`,
			'Content-Type': 'application/json',
			...options.headers
		}
	});
	return res.json();
}

// ═══════════════════════════════════════════════════════════════
//  PUBLIC API
// ═══════════════════════════════════════════════════════════════

/**
 * Get available wallet balance for a currency (v3 API)
 */
export async function getBalance(currency = 'NGN'): Promise<{ available: number; ledger: number }> {
	const data = await v3Fetch(`/balances/${currency}`);
	if (data.status === 'success' && data.data) {
		return {
			available: data.data.available_balance || 0,
			ledger: data.data.ledger_balance || 0,
		};
	}
	return { available: 0, ledger: 0 };
}

/**
 * Get all Nigerian banks (v3 API)
 */
export async function getBanks(): Promise<{ code: string; name: string }[]> {
	const data = await v3Fetch('/banks/NG');
	if (data.status === 'success' && Array.isArray(data.data)) {
		return data.data.map((b: any) => ({ code: b.code, name: b.name }));
	}
	return [];
}

/**
 * Resolve bank account name (v3 API)
 */
export async function resolveAccount(
	accountNumber: string,
	bankCode: string
): Promise<{ account_name: string | null; error?: string }> {
	const data = await v3Fetch('/accounts/resolve', {
		method: 'POST',
		body: JSON.stringify({ account_number: accountNumber, account_bank: bankCode })
	});

	if (data.status === 'success' && data.data?.account_name) {
		return { account_name: data.data.account_name };
	}

	return { account_name: null, error: data.message || 'Could not resolve account' };
}

/**
 * Initiate bank transfer (v3 API)
 */
export async function initiateTransfer(params: {
	accountNumber: string;
	bankCode: string;
	amount: number;
	narration: string;
	reference: string;
	accountName?: string;
}): Promise<{ success: boolean; transferId?: number; status?: string; error?: string }> {
	const data = await v3Fetch('/transfers', {
		method: 'POST',
		body: JSON.stringify({
			account_bank: params.bankCode,
			account_number: params.accountNumber,
			amount: params.amount,
			currency: 'NGN',
			narration: params.narration,
			reference: params.reference,
			beneficiary_name: params.accountName
		})
	});

	if (data.status === 'success' && data.data) {
		return { success: true, transferId: data.data.id, status: data.data.status };
	}

	return { success: false, error: data.message || 'Transfer failed' };
}

/**
 * Get transfer status (v3 API)
 */
export async function getTransferStatus(transferId: number): Promise<{ status: string; error?: string }> {
	const data = await v3Fetch(`/transfers/${transferId}`);
	if (data.status === 'success' && data.data) {
		return { status: data.data.status };
	}
	return { status: 'unknown', error: data.message };
}

// ── v4 API functions (virtual accounts, charges) ──────────────

/**
 * Create Flutterwave customer (v4 API)
 */
export async function createCustomer(params: {
	firstName: string;
	lastName: string;
	email: string;
}): Promise<{ customerId: string | null; error?: string }> {
	const data = await v4Fetch('/customers', {
		method: 'POST',
		headers: { 'X-Idempotency-Key': `cust-${params.email}-${Date.now()}` },
		body: JSON.stringify({
			name: { first: params.firstName, last: params.lastName },
			email: params.email
		})
	});

	if (data.status === 'success' && data.data?.id) {
		return { customerId: data.data.id };
	}

	return { customerId: null, error: data.error?.message || data.message || 'Failed to create customer' };
}

/**
 * Create virtual account for receiving payment (v4 API)
 */
export async function createVirtualAccount(params: {
	customerId: string;
	amount: number;
	reference: string;
	narration: string;
	type?: 'dynamic' | 'static';
	expiry?: number; // seconds, for dynamic accounts
	bvn?: string; // required for static accounts
}): Promise<{
	success: boolean;
	accountNumber?: string;
	bankName?: string;
	reference?: string;
	expiresAt?: string;
	error?: string;
}> {
	const body: any = {
		reference: params.reference,
		customer_id: params.customerId,
		amount: params.amount,
		currency: 'NGN',
		account_type: params.type || 'dynamic',
		narration: params.narration
	};

	if (params.type === 'dynamic' && params.expiry) {
		body.expiry = params.expiry;
	}
	if (params.type === 'static' && params.bvn) {
		body.bvn = params.bvn;
	}

	const data = await v4Fetch('/virtual-accounts', {
		method: 'POST',
		headers: { 'X-Idempotency-Key': `va-${params.reference}` },
		body: JSON.stringify(body)
	});

	if (data.status === 'success' && data.data) {
		return {
			success: true,
			accountNumber: data.data.account_number,
			bankName: data.data.account_bank_name,
			reference: data.data.reference,
			expiresAt: data.data.account_expiration_datetime
		};
	}

	return { success: false, error: data.error?.message || data.message || 'Failed to create virtual account' };
}

/**
 * Verify a charge/payment (v4 API)
 */
export async function verifyCharge(chargeId: string): Promise<{
	success: boolean;
	amount?: number;
	status?: string;
	reference?: string;
	error?: string;
}> {
	const data = await v4Fetch(`/charges/${chargeId}`);

	if (data.status === 'success' && data.data) {
		return {
			success: true,
			amount: data.data.amount,
			status: data.data.status,
			reference: data.data.reference
		};
	}

	return { success: false, error: data.error?.message || 'Verification failed' };
}
