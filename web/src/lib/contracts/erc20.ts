import { ethers } from 'ethers';

// ════════════════════════════════════════════════════════════════════════════
//  ABI — canonical, self-contained IERC20 surface.
//
//  Kept local to this file rather than importing `$lib/tokenCrafter:ERC20_ABI`
//  so the client is the single source of truth for the generic ERC20 shape.
//  Covers every read/write/event the standard interface defines.
// ════════════════════════════════════════════════════════════════════════════

const ERC20_CLIENT_ABI = [
	// ── Reads ──────────────────────────────────────────────────
	'function name() view returns (string)',
	'function symbol() view returns (string)',
	'function decimals() view returns (uint8)',
	'function totalSupply() view returns (uint256)',
	'function balanceOf(address owner) view returns (uint256)',
	'function allowance(address owner, address spender) view returns (uint256)',

	// ── Writes ─────────────────────────────────────────────────
	'function transfer(address to, uint256 amount) returns (bool)',
	'function transferFrom(address from, address to, uint256 amount) returns (bool)',
	'function approve(address spender, uint256 amount) returns (bool)',

	// ── Events ─────────────────────────────────────────────────
	'event Transfer(address indexed from, address indexed to, uint256 value)',
	'event Approval(address indexed owner, address indexed spender, uint256 value)',
] as const;

// ════════════════════════════════════════════════════════════════════════════
//  Public result shapes
// ════════════════════════════════════════════════════════════════════════════

export interface TxResult {
	tx: ethers.TransactionResponse;
	receipt: ethers.TransactionReceipt | null;
}

/** Combined metadata tuple returned by {@link ERC20Client.getMetadata}. */
export interface ERC20Metadata {
	name: string;
	symbol: string;
	decimals: number;
	totalSupply: bigint;
}

/**
 * Result of {@link ERC20Client.ensureAllowance}. `approved` indicates whether
 * a new approval was actually sent: `true` → a tx fired (see `tx`/`receipt`),
 * `false` → existing allowance already covered `amount`, no tx was sent.
 */
export interface EnsureAllowanceResult {
	approved: boolean;
	tx?: ethers.TransactionResponse;
	receipt?: ethers.TransactionReceipt | null;
}

/** Decoded args passed to a `Transfer` event subscriber. */
export interface TransferEvent {
	from: string;
	to: string;
	value: bigint;
	raw: ethers.Log;
}

/** Decoded args passed to an `Approval` event subscriber. */
export interface ApprovalEvent {
	owner: string;
	spender: string;
	value: bigint;
	raw: ethers.Log;
}

/** Optional narrowing filter for {@link ERC20Client.onTransfer}. */
export interface TransferFilter {
	from?: string;
	to?: string;
}

/** Optional narrowing filter for {@link ERC20Client.onApproval}. */
export interface ApprovalFilter {
	owner?: string;
	spender?: string;
}

// ════════════════════════════════════════════════════════════════════════════
//  Client
// ════════════════════════════════════════════════════════════════════════════

/**
 * Typed wrapper around any IERC20-compatible token. Minimal, canonical
 * surface — the generic read/write/event methods the standard defines,
 * plus a small set of pragmatic helpers (`ensureAllowance`, `approveMax`,
 * `getMetadata`) that replace patterns repeated across the app.
 *
 * Pattern mirrors the other `$lib/contracts/*Client` wrappers:
 *   - `new ERC20Client(address, providerOrSigner)`
 *   - `.connect(signer)` returns a signer-backed instance
 *   - reads throw on revert (callers can wrap in try/catch), except `name()`
 *     and `symbol()` which fall back to '' for tokens that don't implement
 *     them as strings, and `decimals()` which falls back to 18.
 *   - writes return `{ tx, receipt }` after awaiting `tx.wait()`.
 */
export class ERC20Client {
	readonly contract: ethers.Contract;

	constructor(address: string, signerOrProvider: ethers.Signer | ethers.Provider) {
		this.contract = new ethers.Contract(address, ERC20_CLIENT_ABI, signerOrProvider);
	}

	/** New instance bound to a signer (required for write methods). */
	connect(signer: ethers.Signer): ERC20Client {
		return new ERC20Client(this.contract.target as string, signer);
	}

	// ── Reads ──────────────────────────────────────────────

	/**
	 * Token name. Falls back to '' if the call reverts — some pre-ERC20
	 * tokens store name as bytes32 or omit it entirely; the fallback lets
	 * UIs keep rendering instead of crashing.
	 */
	async name(): Promise<string> {
		try {
			return String(await this.contract.name());
		} catch {
			return '';
		}
	}

	/** Token symbol. Same '' fallback as {@link name} for non-compliant tokens. */
	async symbol(): Promise<string> {
		try {
			return String(await this.contract.symbol());
		} catch {
			return '';
		}
	}

	/** Token decimals as a number (uint8). Falls back to 18 on revert. */
	async decimals(): Promise<number> {
		try {
			return Number(await this.contract.decimals());
		} catch {
			return 18;
		}
	}

	async totalSupply(): Promise<bigint> {
		return BigInt(await this.contract.totalSupply());
	}

	async balanceOf(account: string): Promise<bigint> {
		return BigInt(await this.contract.balanceOf(account));
	}

	async allowance(owner: string, spender: string): Promise<bigint> {
		return BigInt(await this.contract.allowance(owner, spender));
	}

	// ── Convenience reads ──────────────────────────────────

	/**
	 * Fetch `{name, symbol, decimals, totalSupply}` in parallel. Each read
	 * goes through its individual method so the same fallbacks apply
	 * (name/symbol → '', decimals → 18).
	 */
	async getMetadata(): Promise<ERC20Metadata> {
		const [name, symbol, decimals, totalSupply] = await Promise.all([
			this.name(),
			this.symbol(),
			this.decimals(),
			this.totalSupply(),
		]);
		return { name, symbol, decimals, totalSupply };
	}

	// ── Writes (signer required) ───────────────────────────

	async transfer(to: string, amount: bigint, overrides: ethers.Overrides = {}): Promise<TxResult> {
		const tx = (await this.contract.transfer(to, amount, overrides)) as ethers.TransactionResponse;
		const receipt = await tx.wait();
		return { tx, receipt };
	}

	async transferFrom(
		from: string,
		to: string,
		amount: bigint,
		overrides: ethers.Overrides = {},
	): Promise<TxResult> {
		const tx = (await this.contract.transferFrom(from, to, amount, overrides)) as ethers.TransactionResponse;
		const receipt = await tx.wait();
		return { tx, receipt };
	}

	async approve(spender: string, amount: bigint, overrides: ethers.Overrides = {}): Promise<TxResult> {
		const tx = (await this.contract.approve(spender, amount, overrides)) as ethers.TransactionResponse;
		const receipt = await tx.wait();
		return { tx, receipt };
	}

	// ── Smart helpers ──────────────────────────────────────

	/**
	 * Ensure `spender` has at least `amount` allowance from `owner`. Reads
	 * the current allowance; if it already covers `amount`, returns
	 * `{ approved: false }` with no tx. Otherwise calls `approve(spender, amount)`
	 * and returns the tx + receipt with `approved: true`.
	 *
	 * Replaces the common 4-line allowance→approve pattern scattered across
	 * the codebase. Writes require a signer-backed client.
	 */
	async ensureAllowance(
		owner: string,
		spender: string,
		amount: bigint,
		overrides: ethers.Overrides = {},
	): Promise<EnsureAllowanceResult> {
		const current = await this.allowance(owner, spender);
		if (current >= amount) return { approved: false };
		const { tx, receipt } = await this.approve(spender, amount, overrides);
		return { approved: true, tx, receipt };
	}

	/** Approve `spender` for `ethers.MaxUint256` — the classic infinite approval. */
	async approveMax(spender: string, overrides: ethers.Overrides = {}): Promise<TxResult> {
		return this.approve(spender, ethers.MaxUint256, overrides);
	}

	/** Revoke approval for `spender` by setting allowance to 0. */
	async revokeApproval(spender: string, overrides: ethers.Overrides = {}): Promise<TxResult> {
		return this.approve(spender, 0n, overrides);
	}

	// ── Events ─────────────────────────────────────────────

	/**
	 * Subscribe to `Transfer` events on this token. Pass an optional
	 * `{ from?, to? }` filter to narrow by indexed topic — e.g. pass
	 * `{ to: userAddr }` to watch a user's inbound transfers.
	 *
	 * Returns an unsubscribe function. The callback receives the decoded
	 * args plus the raw ethers log for access to block/tx metadata.
	 */
	onTransfer(cb: (ev: TransferEvent) => void, filter: TransferFilter = {}): () => void {
		const eventFilter = this.contract.filters.Transfer(filter.from ?? null, filter.to ?? null);
		const handler = (from: string, to: string, value: bigint, raw: ethers.ContractEventPayload) => {
			cb({ from, to, value: BigInt(value), raw: raw.log });
		};
		this.contract.on(eventFilter, handler);
		return () => { this.contract.off(eventFilter, handler); };
	}

	/**
	 * Subscribe to `Approval` events. Optional `{ owner?, spender? }` filter
	 * narrows by indexed topic. Returns an unsubscribe function.
	 */
	onApproval(cb: (ev: ApprovalEvent) => void, filter: ApprovalFilter = {}): () => void {
		const eventFilter = this.contract.filters.Approval(filter.owner ?? null, filter.spender ?? null);
		const handler = (owner: string, spender: string, value: bigint, raw: ethers.ContractEventPayload) => {
			cb({ owner, spender, value: BigInt(value), raw: raw.log });
		};
		this.contract.on(eventFilter, handler);
		return () => { this.contract.off(eventFilter, handler); };
	}
}
