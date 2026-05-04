// SPDX-License-Identifier: MIT
// Bumped to ^0.8.24 to match BasicToken's permit-bearing pragma — see
// BasicToken.sol header for the reasoning.
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "./BasicToken.sol";

// =============================================================
// TAXABLE IMPLEMENTATION
// =============================================================

/// @title TaxableTokenImpl
/// @notice Adds buy/sell/transfer taxation with a per-field ceiling
///         mechanism that protects investors. The ceiling locks when the
///         PlatformRouter creates a launch or listing, and stays locked
///         permanently once trading opens. Creator can only lower (never
///         raise) taxes past their committed ceiling. Platform admin can
///         force-lower via the factory's `forceRelaxTaxes`.
///
///         Tax classification uses the parent's `pools` mapping: a
///         transfer where `from` is a pool is a buy, where `to` is a
///         pool is a sell, otherwise it's a peer-to-peer transfer.
///
///         To avoid double-charging cooldown when a transfer is split
///         into tax + recipient sub-transfers, `_checkProtections` is
///         called ONCE for the whole value and the sub-transfers go
///         through `ERC20Upgradeable._update` directly.
contract TaxableTokenImpl is BasicTokenImpl {
    uint256 public buyTaxBps;
    uint256 public sellTaxBps;
    uint256 public transferTaxBps;
    address[] public taxWallets;
    uint16[] public taxSharesBps;
    mapping(address => bool) public isTaxFree;

    /// @dev Tracks whether an address's current `isTaxFree` flag was set
    ///      by `setTaxDistribution` (as a payout-wallet side effect) or
    ///      by an explicit `excludeFromTax` call. Prevents wallet rotation
    ///      from clobbering manual exemptions (router, launch, LP locker).
    mapping(address => bool) private _taxFreeFromDistribution;

    // ── Tax ceiling ───────────────────────────────────────────
    //
    // Per-field ceiling that locks the maximum tax the creator can ever
    // set. Once locked (> 0), `setTaxes` enforces newValue <= ceiling.
    //
    // Lock trigger:
    //   - `lockTaxCeiling()` called by owner or factory (router holds
    //     ownership during createTokenAndLaunch / launchCreatedToken /
    //     createAndList and calls this right after setTaxes).
    //   - `enableTrading()` belt-and-suspenders: if ceiling is still
    //     unlocked at this point (direct listing, no launchpad), the
    //     current values are snapshotted as ceiling.
    //
    // Unlock trigger:
    //   - `unlockTaxCeiling()` callable ONLY by an authorized launcher
    //     (the LaunchInstance clone), on launch failure (enableRefunds).
    //     Owner cannot unlock — prevents creator bait-and-switch during
    //     an active launchpad.
    //   - Unlock is rejected once trading has started (permanent lock).
    //
    // Platform force-relax:
    //   - `forceRelaxTaxes()` callable by the tokenFactory. Lowers both
    //     the tax values AND their ceilings, so the creator can never
    //     raise back above the platform-reduced level.

    uint256 public taxCeilingBuy;
    uint256 public taxCeilingSell;
    uint256 public taxCeilingTransfer;

    /// @dev True once lockTaxCeiling() has been called. Independent of the
    ///      ceiling values so a 0/0/0 ceiling is still enforced — without
    ///      this flag, `if (taxCeilingBuy > 0)` would skip enforcement
    ///      for zero-tax launches, letting the creator raise taxes later.
    bool public taxCeilingIsLocked;

    uint256 public constant MAX_BUY_TAX_BPS = 400;       // 4%
    uint256 public constant MAX_SELL_TAX_BPS = 400;       // 4%
    uint256 public constant MAX_TRANSFER_TAX_BPS = 200;   // 2%

    // ── Events ────────────────────────────────────────────────

    event TaxDistributionUpdated(uint256 totalShareBps);
    event TaxExemptUpdated(address indexed account, bool exempt);
    event TaxesUpdated(uint256 buyTaxBps, uint256 sellTaxBps, uint256 transferTaxBps);
    event TaxCeilingLocked(uint256 buyCeiling, uint256 sellCeiling, uint256 transferCeiling);
    event TaxCeilingUnlocked();
    event TaxCeilingRelaxed(uint256 buyCeiling, uint256 sellCeiling, uint256 transferCeiling);

    // ── Initializer ───────────────────────────────────────────

    /// @dev Override the base initializer so the TokenKrafter factory is
    ///      automatically tax-exempt from the moment the token exists.
    function initialize(
        string calldata name,
        string calldata symbol,
        uint256 totalSupply,
        uint8 _decimals,
        address creator,
        address _factory,
        address _dexFactory,
        address[] calldata bases
    ) public virtual override {
        super.initialize(name, symbol, totalSupply, _decimals, creator, _factory, _dexFactory, bases);
        isTaxFree[_factory] = true;
        emit TaxExemptUpdated(_factory, true);
    }

    // ── Tax distribution ──────────────────────────────────────

    function setTaxDistribution(address[] calldata wallets, uint16[] calldata sharesBps) external onlyOwner {
        require(wallets.length == sharesBps.length, "Length mismatch");
        require(wallets.length <= 10, "Max 10 wallets");

        uint256 oldLen = taxWallets.length;
        for (uint256 i; i < oldLen;) {
            address w = taxWallets[i];
            if (_taxFreeFromDistribution[w]) {
                isTaxFree[w] = false;
                _taxFreeFromDistribution[w] = false;
            }
            unchecked { ++i; }
        }
        delete taxWallets;
        delete taxSharesBps;

        uint256 newLen = sharesBps.length;
        uint256 sum;
        for (uint256 i; i < newLen;) { require(sharesBps[i] > 0, "Share > 0"); sum += sharesBps[i]; unchecked { ++i; } }
        require(sum <= 10000, "Total share > 100%");

        for (uint256 i; i < newLen;) {
            address w = wallets[i];
            require(w != address(0), "Zero address");
            taxWallets.push(w);
            taxSharesBps.push(sharesBps[i]);
            if (!isTaxFree[w]) {
                isTaxFree[w] = true;
                _taxFreeFromDistribution[w] = true;
            }
            unchecked { ++i; }
        }
        emit TaxDistributionUpdated(sum);
    }

    // ── Tax rates ─────────────────────────────────────────────

    function setTaxes(uint256 _buyTaxBps, uint256 _sellTaxBps, uint256 _transferTaxBps) external virtual onlyOwner {
        // Hard caps — never exceeded regardless of ceiling state.
        require(_buyTaxBps <= MAX_BUY_TAX_BPS, "Buy tax > cap");
        require(_sellTaxBps <= MAX_SELL_TAX_BPS, "Sell tax > cap");
        require(_transferTaxBps <= MAX_TRANSFER_TAX_BPS, "Transfer tax > cap");

        // Per-field ceiling: once locked, creator can only lower (or match).
        // Uses the bool flag — NOT `ceiling > 0` — so 0/0/0 ceilings are
        // still enforced (a zero-tax launch stays zero-tax forever).
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

    function excludeFromTax(address account, bool exempt) external onlyOwner {
        isTaxFree[account] = exempt;
        emit TaxExemptUpdated(account, exempt);
    }

    // ── Tax ceiling control ───────────────────────────────────

    /// @notice Snapshot current tax values as the ceiling. Called by the
    ///         PlatformRouter (which holds ownership at that moment) during
    ///         createTokenAndLaunch / launchCreatedToken / createAndList.
    ///         Once locked, setTaxes can only lower — never raise above
    ///         the ceiling. If taxes are 0/0/0 at lock time, the ceiling
    ///         is 0/0/0 — the creator can never add tax. The wizard warns
    ///         about this before submission.
    function lockTaxCeiling() external onlyOwnerOrFactory {
        taxCeilingBuy = buyTaxBps;
        taxCeilingSell = sellTaxBps;
        taxCeilingTransfer = transferTaxBps;
        taxCeilingIsLocked = true;
        emit TaxCeilingLocked(buyTaxBps, sellTaxBps, transferTaxBps);
    }

    /// @notice Reset the ceiling so the creator can adjust taxes and
    ///         relaunch. ONLY callable by an authorized launcher (the
    ///         LaunchInstance clone) on launch failure — NOT by the owner.
    ///         Rejected once trading has started (ceiling becomes permanent).
    function unlockTaxCeiling() external {
        require(isAuthorizedLauncher[msg.sender], "Only launcher");
        require(tradingStartTime == type(uint256).max, "Trading started");
        taxCeilingBuy = 0;
        taxCeilingSell = 0;
        taxCeilingTransfer = 0;
        taxCeilingIsLocked = false;
        emit TaxCeilingUnlocked();
    }

    /// @notice Platform force-relax: lower the tax values AND the
    ///         ceilings. Creator can never raise back above the
    ///         platform-reduced ceiling. Only callable by the factory.
    function forceRelaxTaxes(
        uint256 newBuyBps,
        uint256 newSellBps,
        uint256 newTransferBps
    ) external {
        require(msg.sender == tokenFactory, "Only factory");
        require(newBuyBps <= buyTaxBps, "Can only reduce buy");
        require(newSellBps <= sellTaxBps, "Can only reduce sell");
        require(newTransferBps <= transferTaxBps, "Can only reduce transfer");
        buyTaxBps = newBuyBps;
        sellTaxBps = newSellBps;
        transferTaxBps = newTransferBps;
        // Tighten the ceilings so creator can't raise back
        if (taxCeilingBuy > 0 && newBuyBps < taxCeilingBuy) taxCeilingBuy = newBuyBps;
        if (taxCeilingSell > 0 && newSellBps < taxCeilingSell) taxCeilingSell = newSellBps;
        if (taxCeilingTransfer > 0 && newTransferBps < taxCeilingTransfer) taxCeilingTransfer = newTransferBps;
        emit TaxCeilingRelaxed(taxCeilingBuy, taxCeilingSell, taxCeilingTransfer);
        emit TaxesUpdated(newBuyBps, newSellBps, newTransferBps);
    }

    // ── Transfer logic ────────────────────────────────────────

    function _update(address from, address to, uint256 value) internal virtual override {
        if (from == address(0) || to == address(0) || value == 0) { super._update(from, to, value); return; }
        if (isTaxFree[from] || isTaxFree[to]) { super._update(from, to, value); return; }

        uint256 tax = 0;
        if (!pools[from].isPool && !pools[to].isPool) tax = (value * transferTaxBps) / 10000;
        else if (pools[from].isPool) tax = (value * buyTaxBps) / 10000;
        else if (pools[to].isPool) tax = (value * sellTaxBps) / 10000;

        if (tax == 0) { super._update(from, to, value); return; }

        _checkProtections(from, to, value);

        // Track new holders for tax wallet recipients + final recipient
        uint256 netValue = value - tax;
        if (balanceOf(to) == 0 && netValue > 0) {
            unchecked { holderCount++; }
        }

        uint256 remaining = tax;
        uint256 len = taxWallets.length;
        for (uint256 i; i < len;) {
            uint256 amount = (tax * taxSharesBps[i]) / 10000;
            if (amount > 0) {
                if (balanceOf(taxWallets[i]) == 0) {
                    unchecked { holderCount++; }
                }
                ERC20Upgradeable._update(from, taxWallets[i], amount);
                remaining -= amount;
            }
            unchecked { ++i; }
        }
        if (remaining > 0) ERC20Upgradeable._update(from, address(0), remaining);
        ERC20Upgradeable._update(from, to, netValue);

        // Track holder removal + volume
        if (balanceOf(from) == 0) {
            unchecked { holderCount--; }
        }
        unchecked { totalVolume += value; }
    }

    // ── enableTrading belt-and-suspenders ──────────────────────
    //    If ceiling is still unlocked at enableTrading time (direct
    //    listing, no launchpad flow that called lockTaxCeiling), snapshot
    //    the current values. After this, ceiling is permanent.

    function enableTrading(uint256 delay) external override {
        require(
            msg.sender == owner()
            || msg.sender == tokenFactory
            || isAuthorizedLauncher[msg.sender],
            "Not authorized"
        );
        require(tradingStartTime == type(uint256).max, "Already enabled");
        require(delay <= MAX_TRADING_DELAY, "Delay > max");

        // Lock ceiling if not already locked (covers direct-listing path)
        if (!taxCeilingIsLocked) {
            taxCeilingBuy = buyTaxBps;
            taxCeilingSell = sellTaxBps;
            taxCeilingTransfer = transferTaxBps;
            taxCeilingIsLocked = true;
            emit TaxCeilingLocked(buyTaxBps, sellTaxBps, transferTaxBps);
        }

        tradingStartTime = block.timestamp + delay;
        tradingEnabledAt = block.timestamp;
        emit TradingEnabled(tradingStartTime);
    }
}

// =============================================================
// TAXABLE + MINTABLE
// =============================================================

/// @title TaxableMintableTokenImpl
/// @notice Taxable token + post-deploy mint and burn.
contract TaxableMintableTokenImpl is TaxableTokenImpl {
    function mint(address to, uint256 amount) external onlyOwner { _mint(to, amount); }
    function burn(uint256 amount) external { _burn(msg.sender, amount); }
}
