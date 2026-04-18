/**
 * PartnerTaxableTokenImpl — TaxableTokenImpl + fixed 0.5% platform fee on
 * buy/sell only (no transfer). Per-field hard caps are tightened so the
 * total take (user tax + partner fee) matches the plain-taxable headline.
 *
 * Extends ALL of taxableToken.ts's write/read/event surface. Only the hard
 * caps differ — import SetTaxesParams / toSetTaxesRaw from taxableToken.ts
 * and validate against the constants here.
 */

// ════════════════════════════════════════════════════════════════════════════
//  Constants — tightened hard caps
// ════════════════════════════════════════════════════════════════════════════

export const PARTNERSHIP_BPS = 50;
export const PARTNERSHIP_PCT = 0.5;

export const PARTNER_MAX_BUY_TAX_BPS = 350;        // 3.5%
export const PARTNER_MAX_SELL_TAX_BPS = 350;       // 3.5%
export const PARTNER_MAX_TRANSFER_TAX_BPS = 200;   // 2% (no partner fee on transfer)

export const PARTNER_MAX_BUY_TAX_PCT = 3.5;
export const PARTNER_MAX_SELL_TAX_PCT = 3.5;
export const PARTNER_MAX_TRANSFER_TAX_PCT = 2;

// PartnerTaxableMintableTokenImpl adds mint/burn — same surface as
// MintableTokenImpl, see tokens/basicToken.ts for MintParams / BurnParams.
