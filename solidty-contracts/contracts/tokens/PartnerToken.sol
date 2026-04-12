// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "../shared/TokenInterfaces.sol";
import "./BasicToken.sol";

// =============================================================
// PARTNER IMPLEMENTATION (1% factory tax)
// =============================================================

/// @title PartnerTokenImpl
/// @notice Basic token + a fixed 1% partnership fee on every pool
///         interaction (buy or sell). The fee routes directly to the
///         token's `tokenFactory`, which can later swap it to USDT for
///         platform revenue.
///
///         After the partner-fee deduction, the token calls
///         `factory.processTax(address(this))` so the factory can drain
///         accumulated fees. The `_processingTax` flag is a reentrancy
///         guard against the case where `processTax` triggers a DEX swap
///         that itself calls back into this token's `_update`.
contract PartnerTokenImpl is BasicTokenImpl {
    uint16 public constant PARTNERSHIP_BPS = 50; // 0.5% platform fee on buy/sell
    bool private _processingTax;

    function _update(address from, address to, uint256 value) internal virtual override {
        if (from != address(0) && to != address(0) && value > 0
            && from != tokenFactory && to != tokenFactory
            && (pools[from].isPool || pools[to].isPool))
        {
            uint256 pTax = (value * PARTNERSHIP_BPS) / 10000;
            if (pTax > 0) {
                // Run protection checks ONCE on the full value, then split.
                _checkProtections(from, to, value);
                ERC20Upgradeable._update(from, tokenFactory, pTax);
                ERC20Upgradeable._update(from, to, value - pTax);
                if (!_processingTax) {
                    _processingTax = true;
                    try ITokenFactoryTaxCallback(tokenFactory).processTax(address(this)) {} catch {}
                    _processingTax = false;
                }
                return;
            }
        }
        super._update(from, to, value);
    }
}

// =============================================================
// PARTNER + MINTABLE
// =============================================================

/// @title PartnerMintableTokenImpl
/// @notice Partner token + post-deploy mint and burn.
contract PartnerMintableTokenImpl is PartnerTokenImpl {
    function mint(address to, uint256 amount) external onlyOwner { _mint(to, amount); }
    function burn(uint256 amount) external { _burn(msg.sender, amount); }
}
