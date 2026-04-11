import { ethers } from 'ethers';

/**
 * Shared display formatters. Import from here instead of redefining per-route
 * so format conventions (decimals, K/M/B/T suffixes, price precision) stay
 * consistent across the app.
 */

/** Truncate an address to "0x1234...abcd". Returns "" for empty input. */
export function shortAddr(addr: string | null | undefined, head = 6, tail = 4): string {
	if (!addr) return '';
	if (addr.length <= head + tail + 2) return addr;
	return addr.slice(0, head) + '...' + addr.slice(-tail);
}

/**
 * Format a raw token supply (wei-scale bigint or string) into a human-readable
 * K/M/B/T abbreviated string. Returns "—" when the value is missing or zero.
 * Tolerates already-formatted decimal input ("1000000.0") for defensive use.
 */
export function fmtSupply(raw: string | bigint | null | undefined, decimals: number): string {
	if (raw === null || raw === undefined || raw === '' || raw === '0' || raw === 0n) return '—';
	try {
		const str = typeof raw === 'bigint' ? raw.toString() : String(raw);
		const n = /^\d+$/.test(str)
			? parseFloat(ethers.formatUnits(str, decimals))
			: parseFloat(str);
		if (!Number.isFinite(n) || n === 0) return '—';
		if (n >= 1e12) return `${(n / 1e12).toFixed(1)}T`;
		if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
		if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
		if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
		return n.toLocaleString();
	} catch {
		return '—';
	}
}

/** Format a USD price. Uses extra precision below $1 for memecoin-sized values. */
export function fmtPrice(val: number | null | undefined): string {
	if (val === null || val === undefined || val === 0) return '$0';
	if (val >= 1) return `$${val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
	return `$${parseFloat(val.toPrecision(7))}`;
}

/** Format a USD volume with K/M suffixes. */
export function fmtVolume(val: number | null | undefined): string {
	if (val === null || val === undefined || val <= 0) return '$0';
	if (val >= 1e6) return `$${(val / 1e6).toFixed(1)}M`;
	if (val >= 1e3) return `$${(val / 1e3).toFixed(1)}K`;
	return `$${val.toFixed(2)}`;
}

/** Relative time string: "just now", "5m ago", "2h ago", "3d ago", or a date. */
export function timeAgo(input: string | number | Date | null | undefined): string {
	if (!input) return '—';
	const t = input instanceof Date ? input.getTime() : new Date(input).getTime();
	if (!Number.isFinite(t)) return '—';
	const diff = Date.now() - t;
	const mins = Math.floor(diff / 60_000);
	if (mins < 1) return 'just now';
	if (mins < 60) return `${mins}m ago`;
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) return `${hrs}h ago`;
	const days = Math.floor(hrs / 24);
	if (days < 30) return `${days}d ago`;
	return new Date(t).toLocaleDateString();
}

/**
 * Derive a short human label for a token's "type" from its flags.
 * Used in badges across explore + manage-tokens list views.
 */
export function tokenTypeLabel(t: { is_partner?: boolean; is_taxable?: boolean; is_mintable?: boolean }): string {
	if (t.is_partner && t.is_taxable) return 'Partner+Tax';
	if (t.is_partner) return 'Partner';
	if (t.is_taxable && t.is_mintable) return 'Tax+Mint';
	if (t.is_taxable) return 'Taxable';
	if (t.is_mintable) return 'Mintable';
	return 'Basic';
}

/** Tailwind-ish color key for the badge of a given token type. */
export function tokenTypeColor(t: { is_partner?: boolean; is_taxable?: boolean; is_mintable?: boolean }): string {
	if (t.is_partner) return 'purple';
	if (t.is_taxable) return 'amber';
	if (t.is_mintable) return 'cyan';
	return 'emerald';
}
