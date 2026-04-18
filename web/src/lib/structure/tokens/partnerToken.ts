/**
 * PartnerTokenImpl — BasicTokenImpl + fixed 0.5% platform fee on every
 * pool interaction (buy/sell). No transfer tax. Fee routes to tokenFactory,
 * which can later swap it to USDT.
 *
 * PartnerMintableTokenImpl additionally exposes `mint(to, amount)` + `burn(amount)`.
 *
 * No configurable surface — the partner fee is hard-coded. All other state
 * (trading/pool/protection) comes from BasicTokenImpl.
 */

// ════════════════════════════════════════════════════════════════════════════
//  Constants
// ════════════════════════════════════════════════════════════════════════════

/** Fixed platform fee on every buy/sell — NOT configurable. */
export const PARTNERSHIP_BPS = 50;
export const PARTNERSHIP_PCT = 0.5;

// No new events or write params — PartnerTokenImpl exposes no new surface
// beyond BasicTokenImpl. Events from BasicTokenImpl / MintableTokenImpl apply.
