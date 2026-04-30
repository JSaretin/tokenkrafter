// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "../shared/TokenInterfaces.sol";
import "./TaxableToken.sol";

// =============================================================
// PARTNER + TAXABLE
// =============================================================

/// @title PartnerTaxableTokenImpl
/// @notice Stacks a 0.5% partnership fee (buy/sell only, no transfer)
///         on top of user-configured tax. Per-field caps are 3.5/3.5/2
///         so the total max take including the partner fee matches the
///         plain-taxable cap of 4/4/2. Inherits the tax-ceiling
///         mechanism from TaxableTokenImpl.
contract PartnerTaxableTokenImpl is TaxableTokenImpl {
    uint16 public constant PARTNERSHIP_BPS = 50;  // 0.5%
    bool private _processingTax;

    // Override the hard-cap constants so partner tokens leave room for
    // the 0.5% platform fee. Total take per trade: 3.5% user + 0.5%
    // partner = 4% — same headline number as plain taxable.
    uint256 public constant PARTNER_MAX_BUY_TAX_BPS = 350;       // 3.5%
    uint256 public constant PARTNER_MAX_SELL_TAX_BPS = 350;       // 3.5%
    uint256 public constant PARTNER_MAX_TRANSFER_TAX_BPS = 200;   // 2% (no partner fee on transfer)

    function setTaxes(uint256 _buyTaxBps, uint256 _sellTaxBps, uint256 _transferTaxBps) external override onlyOwner {
        require(_buyTaxBps <= PARTNER_MAX_BUY_TAX_BPS, "Buy tax > 3.5%");
        require(_sellTaxBps <= PARTNER_MAX_SELL_TAX_BPS, "Sell tax > 3.5%");
        require(_transferTaxBps <= PARTNER_MAX_TRANSFER_TAX_BPS, "Transfer tax > 2%");

        // Per-field ceiling enforcement (inherited from TaxableTokenImpl state)
        // Uses the bool flag so 0/0/0 ceilings are still enforced
        if (taxCeilingIsLocked) {
            require(_buyTaxBps <= taxCeilingBuy, "Buy > ceiling");
            require(_sellTaxBps <= taxCeilingSell, "Sell > ceiling");
            require(_transferTaxBps <= taxCeilingTransfer, "Transfer > ceiling");
        }

        buyTaxBps = _buyTaxBps;
        sellTaxBps = _sellTaxBps;
        transferTaxBps = _transferTaxBps;
        emit TaxesUpdated(_buyTaxBps, _sellTaxBps, _transferTaxBps);
    }

    function _update(address from, address to, uint256 value) internal virtual override {
        if (from == address(0) || to == address(0) || value == 0) { ERC20Upgradeable._update(from, to, value); return; }
        // Factory-side fast-path: skip the partner-fee + user-tax
        // logic so tax-token → USDT swaps (processTax / processTaxAuth)
        // don't tax themselves recursively. We still run
        // _checkProtections so pool-lock auto-unlock fires correctly
        // when the factory itself is the seeder (the factory is
        // isExcludedFromLimits, so the auto-open path inside
        // _checkProtections triggers normally).
        if (from == tokenFactory || to == tokenFactory) {
            _checkProtections(from, to, value);
            ERC20Upgradeable._update(from, to, value);
            return;
        }

        _checkProtections(from, to, value);

        bool isBuy = pools[from].isPool;
        bool isSell = pools[to].isPool;
        uint256 totalDeducted = 0;

        // 0.5% partner fee on pool interactions (buy/sell), not transfers.
        // First-seed bypass: a sell-direction transfer to a pool whose
        // token balance is zero is the LP-seed transaction, so we skip
        // the fee for that one transfer (otherwise it shaves 0.5% out
        // of LP). After the seed the pool has tokens, so this can
        // never re-trigger for the same pool — and we don't rely on
        // any owner-mutable flag (isExcludedFromLimits / isTaxFree),
        // so the owner can't whitelist a dump wallet to dodge the fee.
        bool firstSeed = isSell && balanceOf(to) == 0;
        if ((isBuy || isSell) && !firstSeed) {
            uint256 pTax = (value * PARTNERSHIP_BPS) / 10000;
            if (pTax > 0) { ERC20Upgradeable._update(from, tokenFactory, pTax); totalDeducted += pTax; }
        }

        // User-configured tax
        if (!isTaxFree[from] && !isTaxFree[to]) {
            uint256 taxBps;
            if (isBuy) taxBps = buyTaxBps;
            else if (isSell) taxBps = sellTaxBps;
            else taxBps = transferTaxBps;

            uint256 userTax = (value * taxBps) / 10000;
            if (userTax > 0) {
                uint256 remaining = userTax;
                uint256 len = taxWallets.length;
                for (uint256 i; i < len;) {
                    uint256 amt = (userTax * taxSharesBps[i]) / 10000;
                    if (amt > 0) { ERC20Upgradeable._update(from, taxWallets[i], amt); remaining -= amt; }
                    unchecked { ++i; }
                }
                if (remaining > 0) ERC20Upgradeable._update(from, address(0), remaining);
                totalDeducted += userTax;
            }
        }

        ERC20Upgradeable._update(from, to, value - totalDeducted);
        if (totalDeducted > 0 && (isBuy || isSell) && !_processingTax) {
            _processingTax = true;
            try ITokenFactoryTaxCallback(tokenFactory).processTax(address(this)) {} catch {}
            _processingTax = false;
        }
    }
}

// =============================================================
// PARTNER + TAXABLE + MINTABLE
// =============================================================

/// @title PartnerTaxableMintableTokenImpl
/// @notice PartnerTaxable token + post-deploy mint and burn.
contract PartnerTaxableMintableTokenImpl is PartnerTaxableTokenImpl {
    function mint(address to, uint256 amount) external onlyOwner { _mint(to, amount); }
    function burn(uint256 amount) external { _burn(msg.sender, amount); }
}
