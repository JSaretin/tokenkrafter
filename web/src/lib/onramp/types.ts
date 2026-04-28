/**
 * On-ramp EIP-712 schema.
 *
 * The receiver wallet is bound to the on-ramp request by signing this
 * typed-data payload — even if the backend / network is compromised,
 * USDT can only be delivered to the address that signed.
 *
 * The frontend builds an OnrampIntent locally from the server-issued
 * quote, signs it, and POSTs intent + signature to /api/onramp/intent.
 * The server recovers the signer via verifyTypedData and refuses to
 * proceed unless the recovered address equals intent.receiver.
 */

export interface OnrampIntent {
	receiver: string;     // 0x address
	chainId: number | string;
	ngnAmount: string;    // kobo (NGN × 100), bigint as string
	usdtAmount: string;   // wei, bigint as string
	rate: string;         // ₦/$ × 100, bigint as string
	reference: string;    // server-issued
	nonce: string;        // 0x-hex bytes32, server-issued, single-use
	expiresAt: string;    // unix seconds, bigint as string
}

export const ONRAMP_DOMAIN = (chainId: number) => ({
	name: 'TokenKrafter Onramp',
	version: '1',
	chainId,
});

export const ONRAMP_TYPES: Record<string, { name: string; type: string }[]> = {
	OnrampIntent: [
		{ name: 'receiver', type: 'address' },
		{ name: 'chainId', type: 'uint256' },
		{ name: 'ngnAmount', type: 'uint256' },
		{ name: 'usdtAmount', type: 'uint256' },
		{ name: 'rate', type: 'uint256' },
		{ name: 'reference', type: 'string' },
		{ name: 'nonce', type: 'bytes32' },
		{ name: 'expiresAt', type: 'uint256' },
	],
};

export interface OnrampQuote {
	reference: string;
	nonce: string;
	chain_id: number;
	ngn_amount_kobo: number;
	/** Net USDT delivered to the user (after on-ramp fee). bigint as string. */
	usdt_amount_wei: string;
	/** Gross USDT before fee — what the FX conversion yields at locked rate. */
	usdt_gross_wei: string;
	/** Platform on-ramp fee in basis points (covers FLW deposit cost + margin). */
	fee_bps: number;
	rate_x100: number;
	expires_at: number; // unix seconds
}

export interface BankDetails {
	account_number: string;
	bank_name: string;
	account_name: string;
	amount_ngn: number;
	reference: string;
	expires_at: string | null;
}

export type OnrampStatus =
	| 'quoted'
	| 'pending_payment'
	| 'payment_received'
	| 'delivering'
	| 'delivered'
	| 'expired'
	| 'failed'
	| 'cancelled'
	| 'refunded';

export interface OnrampStatusView {
	reference: string;
	status: OnrampStatus;
	receiver: string | null;
	ngn_amount_kobo: number;
	usdt_amount_wei: string;
	delivery_tx_hash: string | null;
	failure_reason: string | null;
}
