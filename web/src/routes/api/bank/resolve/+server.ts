import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resolveAccount } from '$lib/flutterwave';

// POST /api/bank/resolve — resolve Nigerian bank account via Flutterwave
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
				account_number
			});
		}

		return json({ account_name: null, error: result.error || 'Could not resolve account' }, { status: 404 });
	} catch (e: any) {
		return json({ account_name: null, error: e.message || 'Failed to reach Flutterwave' }, { status: 502 });
	}
};
