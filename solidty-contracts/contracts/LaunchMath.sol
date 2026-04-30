// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Bonding curve cost math (linear / sqrt / quadratic / exponential).
///         Already an external library so individual cost calls are
///         DELEGATECALL'd — keeping callers thin on bytecode.
library BondingCurve {
    uint256 constant PRECISION = 1e18;

    /// @notice Linear: price = slope * supply + intercept
    function linearCost(
        uint256 supply,
        uint256 amount,
        uint256 slope,
        uint256 intercept
    ) external pure returns (uint256) {
        uint256 sumTerm = 2 * supply + amount;
        uint256 amountXsum = Math.mulDiv(amount, sumTerm, 1);
        uint256 term1 = Math.mulDiv(slope, amountXsum, 2 * PRECISION);
        uint256 term2 = Math.mulDiv(intercept, amount, PRECISION);
        return term1 + term2;
    }

    /// @notice Square Root: price = coefficient * sqrt(supply)
    function sqrtCost(
        uint256 supply,
        uint256 amount,
        uint256 coefficient
    ) external pure returns (uint256) {
        uint256 newSupply = supply + amount;
        uint256 mid = supply + amount / 2;
        uint256 priceLow = Math.mulDiv(coefficient, Math.sqrt(supply), PRECISION);
        uint256 priceMid = Math.mulDiv(coefficient, Math.sqrt(mid), PRECISION);
        uint256 priceHigh = Math.mulDiv(coefficient, Math.sqrt(newSupply), PRECISION);
        uint256 simpsonSum = priceLow + 4 * priceMid + priceHigh;
        return Math.mulDiv(simpsonSum, amount, 6 * PRECISION);
    }

    /// @notice Quadratic (FOMO): price = coefficient * supply^2
    function quadraticCost(
        uint256 supply,
        uint256 amount,
        uint256 coefficient
    ) external pure returns (uint256) {
        uint256 newSupply = supply + amount;
        uint256 a2 = Math.mulDiv(newSupply, newSupply, PRECISION);
        uint256 ab = Math.mulDiv(newSupply, supply, PRECISION);
        uint256 b2 = Math.mulDiv(supply, supply, PRECISION);
        uint256 sumSquares = a2 + ab + b2;
        return Math.mulDiv(Math.mulDiv(coefficient, amount, 1), sumSquares, 3 * PRECISION * PRECISION);
    }

    /// @notice Exponential Lite: price = base * e^(k * supply)
    function exponentialCost(
        uint256 supply,
        uint256 amount,
        uint256 base_,
        uint256 kFactor
    ) external pure returns (uint256) {
        uint256 newSupply = supply + amount;
        uint256 mid = supply + amount / 2;
        uint256 priceLow = _approxExp(supply, base_, kFactor);
        uint256 priceMid = _approxExp(mid, base_, kFactor);
        uint256 priceHigh = _approxExp(newSupply, base_, kFactor);
        uint256 simpsonSum = priceLow + 4 * priceMid + priceHigh;
        return Math.mulDiv(simpsonSum, amount, 6 * PRECISION);
    }

    /// @dev 6th-order Taylor series for e^(kx).
    function _approxExp(uint256 x, uint256 base_, uint256 kFactor) private pure returns (uint256) {
        uint256 kx = Math.mulDiv(kFactor, x, PRECISION);
        uint256 kx2 = Math.mulDiv(kx, kx, PRECISION);
        uint256 kx3 = Math.mulDiv(kx2, kx, PRECISION);
        uint256 kx4 = Math.mulDiv(kx3, kx, PRECISION);
        uint256 kx5 = Math.mulDiv(kx4, kx, PRECISION);
        uint256 kx6 = Math.mulDiv(kx5, kx, PRECISION);
        uint256 series = PRECISION + kx + kx2 / 2 + kx3 / 6 + kx4 / 24 + kx5 / 120 + kx6 / 720;
        return Math.mulDiv(base_, series, PRECISION);
    }
}

/// @notice Higher-level launch math extracted from LaunchInstance to keep
///         the instance under EIP-170. Functions take all state they
///         depend on as parameters — pure dispatch logic, no storage.
///         Externalised (DELEGATECALL) so the bytecode lives in this
///         library, not in every LaunchInstance clone.
///
///         curveType is `uint8` rather than enum so the library is
///         decoupled from LaunchInstance's enum declaration:
///             0 = Linear, 1 = SquareRoot, 2 = Quadratic, 3 = Exponential
library LaunchMath {
    /// @dev Internal so this same library's other functions can call
    ///      it (Solidity rejects library-self DELEGATECALL).
    function _curveCostAt(
        uint256 supply,
        uint256 amount,
        uint8 curveType,
        uint256 curveParam1,
        uint256 curveParam2
    ) internal view returns (uint256) {
        if (curveType == 0) {
            return BondingCurve.linearCost(supply, amount, curveParam1, curveParam2);
        } else if (curveType == 1) {
            return BondingCurve.sqrtCost(supply, amount, curveParam1);
        } else if (curveType == 2) {
            return BondingCurve.quadraticCost(supply, amount, curveParam1);
        } else {
            return BondingCurve.exponentialCost(supply, amount, curveParam1, curveParam2);
        }
    }

    /// @notice 4-way curve dispatch. External (DELEGATECALL'd) from
    ///         LaunchInstance so the dispatch bytecode lives here, not
    ///         in every clone.
    function curveCostAt(
        uint256 supply,
        uint256 amount,
        uint8 curveType,
        uint256 curveParam1,
        uint256 curveParam2
    ) external view returns (uint256) {
        return _curveCostAt(supply, amount, curveType, curveParam1, curveParam2);
    }

    struct PreviewParams {
        uint256 baseAmount;
        uint256 maxBase;
        uint256 tokensSold;
        uint256 tokensForCurve;
        uint8 curveType;
        uint256 curveParam1;
        uint256 curveParam2;
        uint256 baseScale;
        uint256 buyFeeBps;
        uint256 bps;
        uint256 currentPrice;
    }

    /// @notice Preview-buy math, extracted from LaunchInstance._previewBuy.
    ///         Caller passes its `getCurrentPrice()` result and other
    ///         derived state so this stays pure dispatch.
    function previewBuy(PreviewParams memory p) external view returns (
        uint256 tokensOut,
        uint256 fee,
        uint256 priceImpactBps
    ) {
        if (p.baseAmount == 0) return (0, 0, 0);
        fee = (p.baseAmount * p.buyFeeBps) / p.bps;
        uint256 baseForTokens = p.baseAmount - fee;
        if (baseForTokens > p.maxBase) baseForTokens = p.maxBase;

        // Inline binary-search budget→tokens. Mirrors LaunchInstance's
        // _getTokensForBase but reverts on curve overflow rather than
        // soft-failing — preview is a view, callers can catch.
        uint256 remaining = p.tokensForCurve - p.tokensSold;
        if (remaining > 0 && baseForTokens > 0) {
            uint256 scaledBase = baseForTokens * p.baseScale;
            uint256 low = 0;
            uint256 high = remaining;
            uint256 best = 0;
            for (uint256 i = 0; i < 64; i++) {
                if (low > high) break;
                uint256 mid = (low + high) / 2;
                if (mid == 0) break;
                uint256 cost = _curveCostAt(p.tokensSold, mid, p.curveType, p.curveParam1, p.curveParam2);
                if (cost > scaledBase) {
                    if (mid == 0) break;
                    high = mid - 1;
                } else {
                    best = mid;
                    low = mid + 1;
                }
            }
            tokensOut = best > remaining ? remaining : best;
        }

        if (p.currentPrice > 0 && tokensOut > 0) {
            uint256 cost = _curveCostAt(p.tokensSold, tokensOut, p.curveType, p.curveParam1, p.curveParam2) / p.baseScale;
            uint256 avgPrice = (cost * 1e18) / tokensOut;
            if (avgPrice > p.currentPrice) {
                priceImpactBps = ((avgPrice - p.currentPrice) * p.bps) / p.currentPrice;
            }
        }
    }
}
