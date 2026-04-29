/**
 * Payment provider abstraction.
 *
 * Wraps the underlying PSP (Flutterwave / Monnify / etc.) behind a
 * single normalized interface so call sites don't depend on a specific
 * vendor's shape. Add a new provider by:
 *   1. Implementing PaymentProvider in lib/payments/<name>.ts
 *   2. Registering it in lib/payments/index.ts
 *   3. Setting PAYMENT_PROVIDER=<name> in env (default: "monnify")
 */

export interface BankRow {
	code: string;
	name: string;
}

export interface ResolveResult {
	accountName: string | null;
	error?: string;
}

export interface VAParams {
	/** Server-issued unique reference (TokenKrafter-XXXXXX). FLW echoes
	 *  this as the NUBAN account-name; Monnify uses it as the
	 *  reservedAccountReference. */
	reference: string;
	/** Whole NGN amount the user is expected to send. */
	amountNgn: number;
	/** Public bank-statement narration. Keep it brand-neutral. */
	narration: string;
	/** Seconds until the VA expires. Dynamic VAs only. */
	expirySec: number;
	/** Display name shown to payer (FLW: customer.name; Monnify: accountName). */
	payerName?: string;
	/** Email used for FLW customer record. Synthetic OK. */
	payerEmail?: string;
}

export interface VAResult {
	success: boolean;
	accountNumber?: string;
	bankName?: string;
	/** What FLW echoes as `note` / Monnify echoes as `accountName` —
	 *  the actual NUBAN-registered name a payer will see in their bank
	 *  app on lookup. UI must display this verbatim, NOT a guessed value. */
	displayedAccountName?: string;
	expiresAt?: string;
	error?: string;
}

export interface BalanceResult {
	available: number;
	ledger: number;
}

export interface TransferParams {
	accountNumber: string;
	bankCode: string;
	amountNgn: number;
	narration: string;
	reference: string;
	accountName: string;
}

export interface TransferResult {
	success: boolean;
	transferId?: string;
	error?: string;
}

export interface TransferStatus {
	status: 'pending' | 'success' | 'failed' | 'unknown';
	error?: string;
}

/**
 * Normalized webhook event. Both provider parsers should produce this
 * shape so consumers never branch on vendor-specific field names.
 */
export interface NormalizedWebhookEvent {
	/** Always 'inbound.success' or 'inbound.failed' for collections. */
	type: 'inbound.success' | 'inbound.failed' | 'transfer.success' | 'transfer.failed' | 'unknown';
	/** Our reference (TokenKrafter-XXXXXX or legacy TKO-XXXXXX). */
	reference: string;
	/** Vendor-side transaction ID for idempotency. */
	transactionId: string;
	/** Whole NGN amount (already divided from kobo / minor units). */
	amountNgn: number;
	/** Optional payer details for analytics / audit. */
	payerName?: string | null;
	payerAccount?: string | null;
}

export interface PaymentProvider {
	readonly name: string;

	// Banking helpers
	listBanks(country?: 'NG'): Promise<BankRow[]>;
	resolveAccount(args: { accountNumber: string; bankCode: string }): Promise<ResolveResult>;

	// Inbound (on-ramp)
	createInboundVirtualAccount(params: VAParams): Promise<VAResult>;

	// Outbound (off-ramp)
	getBalance(currency: 'NGN'): Promise<BalanceResult>;
	initiateTransfer(params: TransferParams): Promise<TransferResult>;
	getTransferStatus(transferId: string): Promise<TransferStatus>;

	// Webhook
	verifyWebhookSignature(args: { rawBody: string; headers: Headers; secret: string }): boolean;
	parseWebhookEvent(body: unknown): NormalizedWebhookEvent | null;
}
