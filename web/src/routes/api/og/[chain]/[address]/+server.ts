import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';

/**
 * Dynamic Open Graph share image for token detail pages.
 *
 *   GET /api/og/{chainSlug}/{tokenAddress}  →  image/svg+xml  (1200×630)
 *
 * Why SVG instead of Satori / Puppeteer:
 *   - Cloudflare Pages friendly: no headless Chrome, no native deps.
 *   - SVG is universally accepted by Twitter, WhatsApp, Discord, Telegram,
 *     Slack, LinkedIn — all the surfaces creators actually share into.
 *   - Plain string concatenation, zero runtime allocation surprises.
 *
 * Design choices:
 *   - We deliberately do NOT fetch the token's logo URL server-side. Most
 *     OG-image consumers don't follow nested <image href="…"> links anyway,
 *     and arbitrary IPFS gateways can stall the response. Instead the symbol
 *     initial is rendered inside a brand-gradient circle — fast and
 *     reliable across every social card renderer.
 *   - Brand colors mirror `--color-brand-cyan` / `--color-brand-blue`
 *     defined in `src/app.css`.
 */

const CHAIN_MAP: Record<string, { id: number; name: string }> = {
	bsc: { id: 56, name: 'BNB Smart Chain' },
	eth: { id: 1, name: 'Ethereum' },
	base: { id: 8453, name: 'Base' },
	arbitrum: { id: 42161, name: 'Arbitrum' },
	polygon: { id: 137, name: 'Polygon' },
};

const W = 1200;
const H = 630;
const CACHE = 'public, max-age=3600, s-maxage=86400';

/** Escape user-supplied strings before inlining them into SVG. */
function esc(input: unknown): string {
	if (input == null) return '';
	return String(input)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

/** Truncate a string to a max display length, adding an ellipsis. */
function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max - 1).trimEnd() + '…';
}

/** Pick a foreground initial from the symbol (or a fallback). */
function initialOf(symbol: string): string {
	const ch = (symbol || '?').trim().charAt(0).toUpperCase();
	return ch || '?';
}

function svgResponse(body: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: {
			'Content-Type': 'image/svg+xml; charset=utf-8',
			'Cache-Control': CACHE,
		},
	});
}

/** Shared <defs> block: gradients, filters, grid pattern. */
const DEFS = `
	<defs>
		<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
			<stop offset="0%" stop-color="#07070d" />
			<stop offset="50%" stop-color="#0a1530" />
			<stop offset="100%" stop-color="#050510" />
		</linearGradient>
		<radialGradient id="glowCyan" cx="0.18" cy="0.25" r="0.55">
			<stop offset="0%" stop-color="#00d2ff" stop-opacity="0.22" />
			<stop offset="100%" stop-color="#00d2ff" stop-opacity="0" />
		</radialGradient>
		<radialGradient id="glowBlue" cx="0.85" cy="0.85" r="0.55">
			<stop offset="0%" stop-color="#3a7bd5" stop-opacity="0.18" />
			<stop offset="100%" stop-color="#3a7bd5" stop-opacity="0" />
		</radialGradient>
		<linearGradient id="logoGrad" x1="0" y1="0" x2="1" y2="1">
			<stop offset="0%" stop-color="#00d2ff" />
			<stop offset="100%" stop-color="#3a7bd5" />
		</linearGradient>
		<linearGradient id="wordmark" x1="0" y1="0" x2="1" y2="0">
			<stop offset="0%" stop-color="#00d2ff" />
			<stop offset="100%" stop-color="#3a7bd5" />
		</linearGradient>
		<pattern id="grid" x="0" y="0" width="48" height="48" patternUnits="userSpaceOnUse">
			<path d="M 48 0 L 0 0 0 48" fill="none" stroke="rgba(255,255,255,0.04)" stroke-width="1"/>
		</pattern>
	</defs>
`;

/** The shared backdrop — gradient + grid + corner glows. */
function backdrop(): string {
	return `
		<rect width="${W}" height="${H}" fill="url(#bg)" />
		<rect width="${W}" height="${H}" fill="url(#grid)" />
		<rect width="${W}" height="${H}" fill="url(#glowCyan)" />
		<rect width="${W}" height="${H}" fill="url(#glowBlue)" />
	`;
}

/** TokenKrafter wordmark in the top-left. */
function wordmark(): string {
	return `
		<g transform="translate(56, 60)">
			<rect x="0" y="-2" width="34" height="34" rx="8" fill="url(#logoGrad)" />
			<text x="17" y="22" font-family="Syne, sans-serif" font-size="22" font-weight="800" fill="#07070d" text-anchor="middle">T</text>
			<text x="50" y="24" font-family="Syne, sans-serif" font-size="24" font-weight="700" fill="#ffffff" letter-spacing="-0.5">TokenKrafter</text>
		</g>
	`;
}

/** Bottom-right URL hint. */
function urlHint(chainSlug: string, address: string): string {
	const path = `tokenkrafter.com/explore/${esc(chainSlug)}/${esc(address.slice(0, 10))}…`;
	return `<text x="${W - 56}" y="${H - 48}" font-family="ui-monospace, monospace" font-size="18" fill="rgba(226,232,240,0.45)" text-anchor="end">${path}</text>`;
}

function notFoundSvg(chainSlug: string, address: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
	${DEFS}
	${backdrop()}
	${wordmark()}
	<g transform="translate(${W / 2}, ${H / 2 - 20})">
		<text x="0" y="0" font-family="Syne, sans-serif" font-size="64" font-weight="800" fill="#ffffff" text-anchor="middle">Token not found</text>
		<text x="0" y="56" font-family="ui-monospace, monospace" font-size="22" fill="rgba(226,232,240,0.5)" text-anchor="middle">${esc(chainSlug)} · ${esc(truncate(address, 22))}</text>
	</g>
	${urlHint(chainSlug, address)}
</svg>`;
}

/**
 * Render the SAFU pill if applicable.
 * Positioned in the top-right corner.
 */
function safuPill(): string {
	return `
		<g transform="translate(${W - 56}, 60)">
			<rect x="-148" y="-22" width="148" height="40" rx="20"
				fill="rgba(16,185,129,0.14)" stroke="rgba(16,185,129,0.45)" stroke-width="1.5"/>
			<circle cx="-118" cy="-2" r="5" fill="#10b981"/>
			<text x="-104" y="4" font-family="Syne, sans-serif" font-size="18" font-weight="700" fill="#6ee7b7">SAFU verified</text>
		</g>
	`;
}

interface TokenRow {
	address: string;
	chain_id: number;
	name: string | null;
	symbol: string | null;
	logo_url: string | null;
	is_safu: boolean | null;
	is_partner: boolean | null;
}

function buildTokenSvg(opts: {
	chainName: string;
	chainSlug: string;
	address: string;
	row: TokenRow;
}): string {
	const { chainName, chainSlug, address, row } = opts;
	const name = truncate(esc(row.name || 'Unknown Token'), 28);
	const symbol = truncate(esc(row.symbol || '???'), 10);
	const initial = esc(initialOf(row.symbol || ''));
	const isSafu = !!row.is_safu;

	// Big logo circle, centered horizontally near the top of the content area.
	const logoCx = 180;
	const logoCy = 280;
	const logoR = 88;

	const nameX = logoCx + logoR + 36;
	const nameY = 270;
	const symbolY = nameY + 56;

	// Bottom row: chain badge + (optional) partner badge.
	const metaY = H - 130;

	return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
	${DEFS}
	${backdrop()}
	${wordmark()}
	${isSafu ? safuPill() : ''}

	<!-- Logo circle with brand gradient + symbol initial. -->
	<g>
		<circle cx="${logoCx}" cy="${logoCy}" r="${logoR + 8}" fill="rgba(0,210,255,0.08)" />
		<circle cx="${logoCx}" cy="${logoCy}" r="${logoR}" fill="url(#logoGrad)" />
		<text x="${logoCx}" y="${logoCy + 32}" font-family="Syne, sans-serif" font-size="92" font-weight="800" fill="#07070d" text-anchor="middle">${initial}</text>
	</g>

	<!-- Name + symbol, stacked. -->
	<g>
		<text x="${nameX}" y="${nameY}" font-family="Syne, sans-serif" font-size="72" font-weight="800" fill="#ffffff" letter-spacing="-1.5">${name}</text>
		<text x="${nameX}" y="${symbolY}" font-family="ui-monospace, monospace" font-size="32" font-weight="600" fill="#00d2ff">$${symbol}</text>
	</g>

	<!-- Chain pill + address -->
	<g transform="translate(56, ${metaY})">
		<rect x="0" y="0" width="${chainName.length * 14 + 64}" height="48" rx="24"
			fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>
		<circle cx="28" cy="24" r="6" fill="#00d2ff"/>
		<text x="48" y="31" font-family="Syne, sans-serif" font-size="20" font-weight="600" fill="#e2e8f0">${esc(chainName)}</text>
	</g>

	<g transform="translate(56, ${metaY + 70})">
		<text x="0" y="20" font-family="ui-monospace, monospace" font-size="18" fill="rgba(226,232,240,0.55)">${esc(truncate(address, 42))}</text>
	</g>

	${urlHint(chainSlug, address)}
</svg>`;
}

export const GET: RequestHandler = async ({ params }) => {
	const chainSlug = (params.chain || '').toLowerCase();
	const tokenAddress = (params.address || '').toLowerCase();
	const chain = CHAIN_MAP[chainSlug];

	// Bad chain or non-hex address → fall through to "not found".
	const looksLikeAddress = /^0x[a-f0-9]{40}$/i.test(tokenAddress);
	if (!chain || !looksLikeAddress) {
		return svgResponse(notFoundSvg(chainSlug || 'unknown', tokenAddress || '—'), 404);
	}

	let row: TokenRow | null = null;
	try {
		const { data } = await supabaseAdmin
			.from('created_tokens')
			.select('address, chain_id, name, symbol, logo_url, is_safu, is_partner')
			.eq('address', tokenAddress)
			.eq('chain_id', chain.id)
			.maybeSingle();
		row = (data as TokenRow) ?? null;
	} catch {
		row = null;
	}

	if (!row) {
		return svgResponse(notFoundSvg(chainSlug, tokenAddress), 404);
	}

	const body = buildTokenSvg({
		chainName: chain.name,
		chainSlug,
		address: tokenAddress,
		row,
	});
	return svgResponse(body);
};
