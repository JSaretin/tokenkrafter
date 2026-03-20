// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

// =============================================================
// TOKEN INTERFACES
// =============================================================

interface IToken {
    function initialize(string calldata name, string calldata symbol, uint256 totalSupply, uint8 decimals, address creator, address factory) external;
}

interface ITokenFactory {
    function processTax(address token) external;
}

interface IPoolManagedToken {
    function initialize(string calldata name, string calldata symbol, uint256 totalSupply, uint8 decimals, address creator, address factory) external;
    function setupPools(address[] calldata pools) external;
}

interface IOwnableToken {
    function transferOwnership(address newOwner) external;
}

interface IProtectedToken {
    function enableTrading() external;
    function setMaxWalletAmount(uint256 amount) external;
    function setMaxTransactionAmount(uint256 amount) external;
    function setCooldownTime(uint256 _seconds) external;
    function setExcludedFromLimits(address account, bool excluded) external;
}

interface ITaxableToken {
    function setTaxes(uint256 buyTaxBps, uint256 sellTaxBps, uint256 transferTaxBps) external;
    function setTaxDistribution(address[] calldata wallets, uint16[] calldata sharesBps) external;
    function excludeFromTax(address account, bool exempt) external;
}

// =============================================================
// BASE IMPLEMENTATION
// =============================================================

contract BasicTokenImpl is ERC20Upgradeable, OwnableUpgradeable {
    constructor() { _disableInitializers(); }

    uint8 private decimals_;

    bool public tradingEnabled;
    uint256 public maxWalletAmount;
    uint256 public maxTransactionAmount;
    uint256 public cooldownTime;
    uint256 public blacklistWindow;
    uint256 public tradingEnabledAt;
    mapping(address => bool) public isExcludedFromLimits;
    mapping(address => bool) public blacklisted;
    mapping(address => uint256) public lastTransferTime;
    address public tokenFactory;

    event TradingEnabled(uint256 timestamp);
    event MaxWalletAmountUpdated(uint256 amount);
    event MaxTransactionAmountUpdated(uint256 amount);
    event CooldownTimeUpdated(uint256 seconds_);
    event BlacklistWindowUpdated(uint256 seconds_);
    event BlacklistUpdated(address indexed account, bool blocked);
    event ExcludedFromLimitsUpdated(address indexed account, bool excluded);

    function _baseInit(string calldata name, string calldata symbol, uint256 totalSupply, uint8 _decimals, address creator) internal {
        require(_decimals <= 18);
        __ERC20_init(name, symbol);
        decimals_ = _decimals;
        __Ownable_init(creator);
        _mint(creator, totalSupply);
        isExcludedFromLimits[creator] = true;
    }

    function initialize(string calldata name, string calldata symbol, uint256 totalSupply, uint8 _decimals, address creator, address _factory) public virtual initializer {
        _baseInit(name, symbol, totalSupply, _decimals, creator);
        _setFactory(_factory);
    }

    function decimals() public view override returns (uint8) { return decimals_; }

    function enableTrading() external onlyOwner {
        require(!tradingEnabled, "Already enabled");
        tradingEnabled = true;
        tradingEnabledAt = block.timestamp;
        emit TradingEnabled(block.timestamp);
    }

    modifier onlyOwnerOrFactory() {
        require(msg.sender == owner() || msg.sender == tokenFactory, "Not authorized");
        _;
    }

    function _setFactory(address _factory) internal { tokenFactory = _factory; }

    function setMaxWalletAmount(uint256 amount) external onlyOwner {
        if (tradingEnabled) require(amount == 0 || amount >= maxWalletAmount, "Can only relax after trading");
        maxWalletAmount = amount;
        emit MaxWalletAmountUpdated(amount);
    }

    function setMaxTransactionAmount(uint256 amount) external onlyOwner {
        if (tradingEnabled) require(amount == 0 || amount >= maxTransactionAmount, "Can only relax after trading");
        maxTransactionAmount = amount;
        emit MaxTransactionAmountUpdated(amount);
    }

    function setCooldownTime(uint256 _seconds) external onlyOwner {
        if (tradingEnabled) require(_seconds <= cooldownTime, "Can only relax after trading");
        cooldownTime = _seconds;
        emit CooldownTimeUpdated(_seconds);
    }

    function setBlacklistWindow(uint256 _seconds) external onlyOwner {
        require(!tradingEnabled, "Cannot change after trading");
        require(_seconds <= 259200, "Max 72 hours");
        blacklistWindow = _seconds;
        emit BlacklistWindowUpdated(_seconds);
    }

    function setBlacklisted(address account, bool blocked) external onlyOwner {
        require(blacklistWindow > 0, "Blacklist not enabled");
        if (tradingEnabled) require(block.timestamp <= tradingEnabledAt + blacklistWindow, "Blacklist window expired");
        require(account != owner(), "Cannot blacklist owner");
        blacklisted[account] = blocked;
        emit BlacklistUpdated(account, blocked);
    }

    function setExcludedFromLimits(address account, bool excluded) external onlyOwner {
        isExcludedFromLimits[account] = excluded;
        emit ExcludedFromLimitsUpdated(account, excluded);
    }

    // Factory overrides (relax only)
    function forceUnblacklist(address account) external {
        require(msg.sender == tokenFactory, "Only factory");
        blacklisted[account] = false;
        emit BlacklistUpdated(account, false);
    }

    function forceRelaxMaxWallet(uint256 amount) external {
        require(msg.sender == tokenFactory, "Only factory");
        require(amount == 0 || amount > maxWalletAmount, "Can only relax");
        maxWalletAmount = amount;
        emit MaxWalletAmountUpdated(amount);
    }

    function forceRelaxMaxTransaction(uint256 amount) external {
        require(msg.sender == tokenFactory, "Only factory");
        require(amount == 0 || amount > maxTransactionAmount, "Can only relax");
        maxTransactionAmount = amount;
        emit MaxTransactionAmountUpdated(amount);
    }

    function forceRelaxCooldown(uint256 _seconds) external {
        require(msg.sender == tokenFactory, "Only factory");
        require(_seconds == 0 || _seconds < cooldownTime, "Can only relax");
        cooldownTime = _seconds;
        emit CooldownTimeUpdated(_seconds);
    }

    function forceDisableBlacklist() external {
        require(msg.sender == tokenFactory, "Only factory");
        blacklistWindow = 0;
        emit BlacklistWindowUpdated(0);
    }

    /// @dev Runs trading, blacklist, maxTx, maxWallet, and cooldown checks.
    ///      Extracted so taxable _update can call it once before splitting sub-transfers.
    function _checkProtections(address from, address to, uint256 value) internal {
        if (!tradingEnabled) {
            require(from == owner() || to == owner() || isExcludedFromLimits[from] || isExcludedFromLimits[to], "Trading not enabled");
        }
        require(!blacklisted[from] && !blacklisted[to], "Blacklisted");
        if (!isExcludedFromLimits[from] && !isExcludedFromLimits[to]) {
            if (maxTransactionAmount > 0) require(value <= maxTransactionAmount, "Exceeds max transaction");
            if (maxWalletAmount > 0) require(balanceOf(to) + value <= maxWalletAmount, "Exceeds max wallet");
            if (cooldownTime > 0) {
                require(block.timestamp >= lastTransferTime[from] + cooldownTime, "Cooldown active");
                lastTransferTime[from] = block.timestamp;
            }
        }
    }

    function _update(address from, address to, uint256 value) internal virtual override {
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }
        _checkProtections(from, to, value);
        super._update(from, to, value);
    }

    function withdrawToken(address token) external onlyOwner {
        if (token == address(0)) {
            uint256 bal = address(this).balance;
            require(bal > 0, "No balance");
            (bool ok, ) = msg.sender.call{value: bal}("");
            require(ok, "Transfer failed");
        } else {
            require(token != address(this), "Cannot withdraw own token");
            uint256 bal = IERC20(token).balanceOf(address(this));
            require(bal > 0, "No balance");
            SafeERC20.safeTransfer(IERC20(token), msg.sender, bal);
        }
    }
}

// =============================================================
// MINTABLE IMPLEMENTATION
// =============================================================

contract MintableTokenImpl is BasicTokenImpl {
    function mint(address to, uint256 amount) external onlyOwner { _mint(to, amount); }
    function burn(uint256 amount) external { _burn(msg.sender, amount); }
}

// =============================================================
// POOL MANAGED (shared pool logic for taxable/partner tokens)
// =============================================================

contract PoolManaged is BasicTokenImpl {
    mapping(address => bool) public isPool;
    address public poolFactory;
    bool private _poolsInitialized;

    event PoolUpdated(address indexed pool, bool added);

    function _initPoolManager(address _factory) internal {
        poolFactory = _factory;
        _setFactory(_factory);
    }

    function setupPools(address[] calldata pools) external {
        require(msg.sender == poolFactory, "Only factory");
        require(!_poolsInitialized, "Already initialized");
        _poolsInitialized = true;
        isExcludedFromLimits[poolFactory] = true;
        uint256 len = pools.length;
        for (uint256 i; i < len;) {
            if (pools[i] != address(0)) {
                isPool[pools[i]] = true;
                isExcludedFromLimits[pools[i]] = true;
                emit PoolUpdated(pools[i], true);
            }
            unchecked { ++i; }
        }
    }

    function addPool(address pool) external onlyOwner {
        require(pool != address(0), "Invalid pool");
        isPool[pool] = true;
        isExcludedFromLimits[pool] = true;
        emit PoolUpdated(pool, true);
    }

    function removePool(address pool) external onlyOwner {
        isPool[pool] = false;
        isExcludedFromLimits[pool] = false;
        emit PoolUpdated(pool, false);
    }
}

// =============================================================
// TAXABLE IMPLEMENTATION
// =============================================================

contract TaxableTokenImpl is PoolManaged {
    uint256 public buyTaxBps;
    uint256 public sellTaxBps;
    uint256 public transferTaxBps;
    address[] public taxWallets;
    uint16[] public taxSharesBps;
    mapping(address => bool) public isTaxFree;

    event TaxDistributionUpdated(uint256 totalShareBps);
    event TaxExemptUpdated(address indexed account, bool exempt);

    function initialize(string calldata name, string calldata symbol, uint256 totalSupply, uint8 _decimals, address creator, address _factory) public virtual override initializer {
        _baseInit(name, symbol, totalSupply, _decimals, creator);
        _initPoolManager(_factory);
    }

    function setTaxDistribution(address[] calldata wallets, uint16[] calldata sharesBps) external onlyOwner {
        require(wallets.length == sharesBps.length, "Length mismatch");
        require(wallets.length <= 10, "Max 10 wallets");
        uint256 oldLen = taxWallets.length;
        for (uint256 i; i < oldLen;) { isTaxFree[taxWallets[i]] = false; unchecked { ++i; } }
        delete taxWallets;
        delete taxSharesBps;
        uint256 newLen = sharesBps.length;
        uint256 sum;
        for (uint256 i; i < newLen;) { require(sharesBps[i] > 0, "Share > 0"); sum += sharesBps[i]; unchecked { ++i; } }
        require(sum <= 10000, "Total share > 100%");
        for (uint256 i; i < newLen;) {
            require(wallets[i] != address(0), "Zero address");
            taxWallets.push(wallets[i]);
            taxSharesBps.push(sharesBps[i]);
            isTaxFree[wallets[i]] = true;
            unchecked { ++i; }
        }
        emit TaxDistributionUpdated(sum);
    }

    function setTaxes(uint256 _buyTaxBps, uint256 _sellTaxBps, uint256 _transferTaxBps) external virtual onlyOwner {
        require(_buyTaxBps <= 1000, "Buy tax <= 10%");
        require(_sellTaxBps <= 1000, "Sell tax <= 10%");
        require(_transferTaxBps <= 500, "Transfer tax <= 5%");
        require(_buyTaxBps + _sellTaxBps + _transferTaxBps <= 2500, "Total tax <= 25%");
        buyTaxBps = _buyTaxBps;
        sellTaxBps = _sellTaxBps;
        transferTaxBps = _transferTaxBps;
    }

    function excludeFromTax(address account, bool exempt) external onlyOwner {
        isTaxFree[account] = exempt;
        emit TaxExemptUpdated(account, exempt);
    }

    function _update(address from, address to, uint256 value) internal virtual override {
        if (from == address(0) || to == address(0) || value == 0) { super._update(from, to, value); return; }
        if (isTaxFree[from] || isTaxFree[to]) { super._update(from, to, value); return; }

        uint256 tax = 0;
        if (!isPool[from] && !isPool[to]) tax = (value * transferTaxBps) / 10000;
        else if (isPool[from]) tax = (value * buyTaxBps) / 10000;
        else if (isPool[to]) tax = (value * sellTaxBps) / 10000;

        if (tax == 0) { super._update(from, to, value); return; }

        // Run protection checks ONCE for the whole transfer, then use
        // ERC20Upgradeable._update for sub-transfers to avoid double-cooldown.
        _checkProtections(from, to, value);

        uint256 remaining = tax;
        uint256 len = taxWallets.length;
        for (uint256 i; i < len;) {
            uint256 amount = (tax * taxSharesBps[i]) / 10000;
            if (amount > 0) { ERC20Upgradeable._update(from, taxWallets[i], amount); remaining -= amount; }
            unchecked { ++i; }
        }
        if (remaining > 0) ERC20Upgradeable._update(from, address(0), remaining);
        ERC20Upgradeable._update(from, to, value - tax);
    }
}

// =============================================================
// TAXABLE + MINTABLE
// =============================================================

contract TaxableMintableTokenImpl is TaxableTokenImpl {
    function mint(address to, uint256 amount) external onlyOwner { _mint(to, amount); }
    function burn(uint256 amount) external { _burn(msg.sender, amount); }
}

// =============================================================
// PARTNER IMPLEMENTATION (1% factory tax)
// =============================================================

contract PartnerTokenImpl is PoolManaged {
    uint16 public constant PARTNERSHIP_BPS = 100;
    bool private _processingTax;

    function initialize(string calldata name, string calldata symbol, uint256 totalSupply, uint8 _decimals, address creator, address _factory) public virtual override initializer {
        _baseInit(name, symbol, totalSupply, _decimals, creator);
        _initPoolManager(_factory);
    }

    function _update(address from, address to, uint256 value) internal virtual override {
        if (from != address(0) && to != address(0) && value > 0
            && from != poolFactory && to != poolFactory
            && (isPool[from] || isPool[to]))
        {
            uint256 pTax = (value * PARTNERSHIP_BPS) / 10000;
            if (pTax > 0) {
                super._update(from, poolFactory, pTax);
                super._update(from, to, value - pTax);
                // Guard against nested processTax calls during DEX swap callbacks
                if (!_processingTax) {
                    _processingTax = true;
                    try ITokenFactory(poolFactory).processTax(address(this)) {} catch {}
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

contract PartnerMintableTokenImpl is PartnerTokenImpl {
    function mint(address to, uint256 amount) external onlyOwner { _mint(to, amount); }
    function burn(uint256 amount) external { _burn(msg.sender, amount); }
}

// =============================================================
// PARTNER + TAXABLE
// =============================================================

contract PartnerTaxableTokenImpl is TaxableTokenImpl {
    uint16 public constant PARTNERSHIP_BPS = 100;
    bool private _processingTax;

    function setTaxes(uint256 _buyTaxBps, uint256 _sellTaxBps, uint256 _transferTaxBps) external override onlyOwner {
        require(_buyTaxBps <= 900, "Buy tax <= 9% (partner)");
        require(_sellTaxBps <= 900, "Sell tax <= 9% (partner)");
        require(_transferTaxBps <= 500, "Transfer tax <= 5%");
        require(_buyTaxBps + _sellTaxBps + _transferTaxBps <= 2400, "Total tax <= 24% (partner 1%)");
        buyTaxBps = _buyTaxBps;
        sellTaxBps = _sellTaxBps;
        transferTaxBps = _transferTaxBps;
    }

    function _update(address from, address to, uint256 value) internal virtual override {
        if (from == address(0) || to == address(0) || value == 0) { ERC20Upgradeable._update(from, to, value); return; }
        if (from == poolFactory || to == poolFactory) { ERC20Upgradeable._update(from, to, value); return; }

        // Run protection checks ONCE (trading, blacklist, limits, cooldown),
        // then use ERC20Upgradeable._update for all sub-transfers.
        _checkProtections(from, to, value);

        bool isBuy = isPool[from];
        bool isSell = isPool[to];
        uint256 totalDeducted = 0;

        if (isBuy || isSell) {
            uint256 pTax = (value * PARTNERSHIP_BPS) / 10000;
            if (pTax > 0) { ERC20Upgradeable._update(from, poolFactory, pTax); totalDeducted += pTax; }
        }

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
        // Guard against nested processTax calls during DEX swap callbacks
        if (totalDeducted > 0 && (isBuy || isSell) && !_processingTax) {
            _processingTax = true;
            try ITokenFactory(poolFactory).processTax(address(this)) {} catch {}
            _processingTax = false;
        }
    }
}

// =============================================================
// PARTNER + TAXABLE + MINTABLE
// =============================================================

contract PartnerTaxableMintableTokenImpl is PartnerTaxableTokenImpl {
    function mint(address to, uint256 amount) external onlyOwner { _mint(to, amount); }
    function burn(uint256 amount) external { _burn(msg.sender, amount); }
}
