# Security Audit Report: Token-Crafter Contracts

**Date:** 2026-04-02
**Auditor:** Claude Opus 4.6
**Scope:** All contracts in `solidty-contracts/contracts/`

---

## Critical / High Severity

| ID | Contract | Issue |
|----|----------|-------|
| **H-02** | TokenFactory | `processTax` swaps full token balance with only 5% slippage — easily sandwichable by MEV bots |
| **H-08** | PlatformRouter | `addLiquidity` passes `0, 0` for min amounts — sandwich attack on listing if pair already has liquidity |
| **H-10** | TradeRouter | `confirm(id, to, amount)` lets any admin redirect withdrawal funds to arbitrary addresses |
| **H-11** | Cross-contract | ~~Factory owner has god-mode over ALL token protections~~ — **By design:** platform owner overrides are a consumer protection mechanism, allowing the platform to intervene when token creators abuse blacklists or restrictive settings against innocent users. Consider adding a timelock on destructive actions like `setImplementation`, `setUsdt`, `setDexRouter` as a key-compromise safeguard. |
| **H-01** | TokenFactory | Circular referral check only walks `referralLevels` deep — deeper cycles go undetected, enabling referral farming |
| **H-07** | LaunchInstance | Bonding curve binary search precision loss on steep exponential curves — buyers may get incorrect token amounts |

---

## Medium Severity

| ID | Contract | Issue |
|----|----------|-------|
| **M-13** | LaunchInstance | If any buyer never claims refund, `totalBaseRaised` never reaches 0 — creator can **never** withdraw remaining tokens. No timeout mechanism. |
| **M-21** | TradeRouter | `swapETHForTokens` and `swapTokensForETH` skip `_validateSlippage` — no platform slippage protection on ETH swaps |
| **M-09** | LaunchpadFactory | `cancelPendingLaunch` deletes mapping but never cleans `launches[]` / `creatorLaunches[]` arrays — unbounded growth |
| **M-10** | LaunchpadFactory | If a launch contract bugs out and can't call `clearTokenLaunch`, the token is permanently locked from re-launching. No owner override. |
| **M-23** | PlatformLens | `getActiveLaunches` does two full passes over all launches — will hit gas limits and break frontends at scale |
| **M-15** | LaunchInstance | Graduation fails if DEX price moves >0.5% — locks funds until price stabilizes |
| **M-20** | TradeRouter | Default `payoutTimeout` is 300s (5 min) — far too short for fiat off-ramp flows |
| **M-04** | TokenFactory | `withdrawFees` doesn't account for tokens pending tax conversion — owner could withdraw tax revenue meant for swap |
| **M-05** | TokenImplementations | `MintableTokenImpl.mint` has no supply cap — owner can dilute infinitely |

---

## Low / Informational

| ID | Contract | Issue |
|----|----------|-------|
| **L-08** | LaunchInstance | `_approxExp` Taylor series diverges for large `kx` (>~7) with no runtime guard |
| **L-09** | PlatformRouter | `receive()` allows ETH to persist between txs — could be consumed by next user's fee calculation |
| **L-11** | TradeRouter | `_buildPath` always routes through WETH — misses direct pairs with better liquidity |
| **L-04** | TokenImplementations | No events emitted for `setTaxes` changes |
| **M-03** | TokenFactory | Missing event for `setCreationFee` |

---

## Detailed Findings

### H-01: Referral Chain Cycle Bypass

**File:** `TokenFactory.sol` — `_processReferral`

The circular referral check only walks `referralLevels` deep. If a cycle is longer than `referralLevels`, it won't be detected. An attacker controlling multiple addresses can set up a chain `A→B→C→A` that exceeds the check depth and repeatedly create tokens to farm referral rewards. Each creation costs a fee, but the attacker recovers `referralPercents` sum (~10%) per creation.

### H-02: processTax Sandwich Attack

**File:** `TokenFactory.sol` — `processTax`

Any factory-created token triggers `processTax` during transfers. The swap uses only `taxSlippageBps` (default 5%) for slippage protection, and swaps the **full factory balance** of that token. Accumulated tax over many transfers can be swapped in a single sandwichable transaction, making this a profitable MEV target.

### H-07: Bonding Curve Precision Loss

**File:** `LaunchInstance.sol` — `_getTokensForBase`

The binary search uses 128 iterations max with integer division. For very steep exponential curves, approximation error could be significant. The `_approxExp` Taylor series (used internally) diverges for large `kx` values with no runtime guard.

### H-08: Zero Slippage on addLiquidity

**File:** `PlatformRouter.sol` — `createAndList`, `createAndListWithEth`

Both functions pass `0, 0` for `amountAMin` / `amountBMin` in `addLiquidity` / `addLiquidityETH`. For the first liquidity addition this is technically safe, but if the pair already exists with some liquidity, a sandwich attacker can manipulate the price before LP addition.

### H-10: Admin Fund Redirection

**File:** `TradeRouter.sol` — `confirm(uint256 id, address to, uint256 amount)`

The `confirm` overload with `customAmount` lets any admin send withdrawal funds to an arbitrary address. While designed for the off-ramp flow, a compromised admin key can redirect user funds. The `onlyAdmin` modifier allows any admin (not just owner) to do this.

### H-11: Factory Owner Override Powers — By Design

**Files:** `TokenFactory.sol`, `TokenImplementations.sol`

The factory owner can call `forceRelaxMaxWallet`, `forceRelaxCooldown`, `forceRelaxMaxTransaction`, `forceUnblacklist`, and `forceDisableBlacklist` on ANY token created by the factory. **This is intentional** — the platform owner acts as a consumer protection layer, able to intervene when token creators abuse blacklists or set restrictive settings against innocent users. **Remaining recommendation:** add a timelock on infrastructure-level actions (`setImplementation`, `setUsdt`, `setDexRouter`) as a safeguard against key compromise.

### M-13: Permanent Creator Token Lock on Unclaimed Refunds

**File:** `LaunchInstance.sol` — `creatorWithdrawAfterRefund`

Requires `totalBaseRaised == 0`, but buyers who never claim refunds block the creator forever. There is no timeout mechanism for unclaimed refunds.

### M-21: Missing Slippage Validation on ETH Swaps

**File:** `TradeRouter.sol`

`_validateSlippage` is only called in `swapTokens` — not in `swapETHForTokens` or `swapTokensForETH`. Users of ETH swap functions don't get the platform's slippage protection.

### M-09: Unbounded Array Growth

**File:** `LaunchpadFactory.sol` — `cancelPendingLaunch`

Deletes the mapping entry but never removes from `launches[]` or `creatorLaunches[]` arrays. These grow indefinitely, increasing gas costs for iteration in `PlatformLens`.

### M-10: No Owner Override for clearTokenLaunch

**File:** `LaunchpadFactory.sol`

If a launch contract has a bug preventing it from calling `clearTokenLaunch`, the token is permanently locked from being re-launched. The factory owner has no override (unlike `cancelPendingLaunch` which only works for Pending state).

---

## Top Recommendations

1. **Add real slippage protection** to `addLiquidity` in PlatformRouter and to all swap paths in TradeRouter (ETH variants currently skip validation)
2. **Add a refund claim timeout** in LaunchInstance so unclaimed refunds don't permanently lock the creator's tokens
3. **Timelock on infrastructure changes** — owner overrides on token protections are by design (consumer protection), but `setImplementation`, `setUsdt`, `setDexRouter` should have a timelock as a key-compromise safeguard
4. **Cap `processTax` swap size** or use TWAP-based pricing to reduce MEV sandwich exposure
5. **Clean up arrays** on launch cancellation to prevent unbounded storage growth
6. **Add a factory-owner override** for `clearTokenLaunch` to handle buggy launch contracts
