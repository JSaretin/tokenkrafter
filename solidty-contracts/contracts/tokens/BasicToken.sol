// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "../shared/DexInterfaces.sol";

// =============================================================
// BASE IMPLEMENTATION
// =============================================================

/// @title BasicTokenImpl
/// @notice Upgradeable ERC20 with a per-pool anti-snipe / anti-grifter gate.
///         Pool addresses are registered at `initialize()` time by calling
///         `factory.createPair(address(this), base)` for every entry in `bases`.
///         Until `enableTrading(delay)` is called and the delay elapses, ANY
///         transfer where either side is a registered pool reverts — unless
///         one side is on the `isExcludedFromLimits` allowlist (used for the
///         launchpad, platform router, tax wallets, etc.).
///         Peer-to-peer transfers between non-pool addresses are unrestricted
///         from day zero — curve buyers can move/refund their tokens freely.
contract BasicTokenImpl is ERC20Upgradeable, OwnableUpgradeable {
    constructor() { _disableInitializers(); }

    uint8 private decimals_;

    // ── Pool gate state ──
    struct PoolInfo { bool isPool; }
    mapping(address => PoolInfo) public pools;

    /// @notice Moment public pool trading opens. `type(uint256).max` means
    ///         "not yet scheduled" — the default until `enableTrading` is called.
    uint256 public tradingStartTime;

    /// @notice Maximum delay that can be passed to `enableTrading`.
    uint256 public constant MAX_TRADING_DELAY = 24 hours;

    /// @notice DEX factory used to resolve `base → pair` at init and in `addPool(base)`.
    address public dexFactory;

    // ── Classic protection knobs ──
    uint256 public maxWalletAmount;
    uint256 public maxTransactionAmount;
    uint256 public cooldownTime;
    uint256 public blacklistWindow;
    uint256 public tradingEnabledAt; // timestamp of enableTrading() call
    mapping(address => bool) public isExcludedFromLimits;
    mapping(address => bool) public blacklisted;
    mapping(address => uint256) public lastTransferTime;
    mapping(address => bool) public isAuthorizedLauncher;
    address public tokenFactory;

    /// @notice Number of unique addresses holding a non-zero balance.
    uint256 public holderCount;
    /// @notice Cumulative transfer volume (sum of all transfer amounts).
    uint256 public totalVolume;

    // ── Events ──
    event PoolRegistered(address indexed pool, address indexed base);
    event TradingEnabled(uint256 startsAt);
    event MaxWalletAmountUpdated(uint256 amount);
    event MaxTransactionAmountUpdated(uint256 amount);
    event CooldownTimeUpdated(uint256 seconds_);
    event BlacklistWindowUpdated(uint256 seconds_);
    event BlacklistUpdated(address indexed account, bool blocked);
    event ExcludedFromLimitsUpdated(address indexed account, bool excluded);
    event AuthorizedLauncherUpdated(address indexed launcher, bool authorized);

    function _baseInit(
        string calldata name,
        string calldata symbol,
        uint256 totalSupply,
        uint8 _decimals,
        address creator,
        address _factory,
        address _dexFactory
    ) internal {
        require(_decimals > 0 && _decimals <= 18, "Decimals must be 1..18");
        require(creator != address(0), "Zero creator");
        __ERC20_init(name, symbol);
        decimals_ = _decimals;
        __Ownable_init(creator);
        _mint(creator, totalSupply);

        tokenFactory = _factory;
        dexFactory = _dexFactory;
        tradingStartTime = type(uint256).max;
    }

    /// @dev Resolves a base token to its V2 pair via the configured DEX factory
    ///      (creating the pair if it doesn't exist yet) and marks it as a pool.
    ///      Used by both `initialize` (in a loop over `bases[]`) and by the
    ///      post-deploy `addPool(base)` entrypoint — single source of truth.
    function _registerPool(address base) internal returns (address pair) {
        require(dexFactory != address(0), "DEX not set");
        require(base != address(0) && base != address(this), "Invalid base");
        IUniswapV2Factory dex = IUniswapV2Factory(dexFactory);
        pair = dex.getPair(address(this), base);
        if (pair == address(0)) pair = dex.createPair(address(this), base);
        require(!pools[pair].isPool, "Duplicate pool");
        pools[pair].isPool = true;
        emit PoolRegistered(pair, base);
    }

    /// @dev Pool pre-registration phase. Separated from `_baseInit` so the
    ///      two concerns (ERC20 wiring vs DEX discovery) stay independent,
    ///      and so subclasses can skip or customize it if needed.
    function _registerPools(address[] calldata bases) internal {
        if (dexFactory == address(0) || bases.length == 0) return;
        uint256 len = bases.length;
        for (uint256 i; i < len;) {
            _registerPool(bases[i]);
            unchecked { ++i; }
        }
    }

    function initialize(
        string calldata name,
        string calldata symbol,
        uint256 totalSupply,
        uint8 _decimals,
        address creator,
        address _factory,
        address _dexFactory,
        address[] calldata bases
    ) public virtual initializer {
        _baseInit(name, symbol, totalSupply, _decimals, creator, _factory, _dexFactory);
        _registerPools(bases);
    }

    function decimals() public view override returns (uint8) { return decimals_; }

    modifier onlyOwnerOrFactory() {
        require(msg.sender == owner() || msg.sender == tokenFactory, "Not authorized");
        _;
    }

    // ── Trading control ──────────────────────────────────────────────

    /// @notice Opens public pool trading after `delay` seconds. Callable by
    ///         the owner (creator), the factory, or a creator-authorized launcher
    ///         (e.g. a `LaunchInstance` that needs to enable trading atomically
    ///         on graduation). Can only be called once.
    function enableTrading(uint256 delay) external virtual {
        require(
            msg.sender == owner()
            || msg.sender == tokenFactory
            || isAuthorizedLauncher[msg.sender],
            "Not authorized"
        );
        require(tradingStartTime == type(uint256).max, "Already enabled");
        require(delay <= MAX_TRADING_DELAY, "Delay > max");
        tradingStartTime = block.timestamp + delay;
        tradingEnabledAt = block.timestamp;
        emit TradingEnabled(tradingStartTime);
    }

    /// @notice Authorize a contract (typically a `LaunchInstance`) to call
    ///         `enableTrading`. Creator opts in before funding the launch.
    function setAuthorizedLauncher(address launcher, bool authorized) external onlyOwner {
        require(launcher != address(0), "Zero launcher");
        isAuthorizedLauncher[launcher] = authorized;
        emit AuthorizedLauncherUpdated(launcher, authorized);
    }

    /// @notice Register an additional V2-style DEX pair by base token.
    ///         Resolves the pair address through the configured DEX factory,
    ///         so an owner cannot mark an arbitrary wallet as a pool. Late
    ///         additions carry NO anti-snipe lock; the window only applies to
    ///         pools registered at init time.
    function addPool(address base) external onlyOwnerOrFactory {
        _registerPool(base);
    }

    /// @notice Register an arbitrary pool address. For DEXes where
    ///         `getPair(base, token)` cannot resolve the pool — Uniswap V3
    ///         (fee-tiered pools), Solidly forks, non-EVM-cloned AMMs, etc.
    ///         Callable by the owner only, and ONLY after public trading has
    ///         been enabled. The post-enable restriction prevents an owner from
    ///         weaponizing the anti-snipe lock against arbitrary addresses
    ///         (marking a user's wallet as a pool during the lock would freeze
    ///         their funds). After trading is open, this is a trusted creator
    ///         action: marking any address as a pool subjects transfers in/out
    ///         of it to tax routing on taxable variants.
    function addPoolByAddress(address pool) external onlyOwner {
        require(pool != address(0) && pool != address(this), "Invalid pool");
        require(tradingStartTime != type(uint256).max && block.timestamp >= tradingStartTime, "Trading not open");
        require(!pools[pool].isPool, "Already registered");
        pools[pool].isPool = true;
        emit PoolRegistered(pool, address(0));
    }

    // ── Classic owner knobs ─────────────────────────────────────────

    function setMaxWalletAmount(uint256 amount) external onlyOwner {
        if (tradingStartTime != type(uint256).max) {
            // Post-trading: can only relax (increase limit or disable).
            // If no limit was set before trading (== 0), can't add one now.
            require(
                amount == 0 || (maxWalletAmount > 0 && amount >= maxWalletAmount),
                "Can only relax after trading"
            );
        }
        maxWalletAmount = amount;
        emit MaxWalletAmountUpdated(amount);
    }

    function setMaxTransactionAmount(uint256 amount) external onlyOwner {
        if (tradingStartTime != type(uint256).max) {
            require(
                amount == 0 || (maxTransactionAmount > 0 && amount >= maxTransactionAmount),
                "Can only relax after trading"
            );
        }
        maxTransactionAmount = amount;
        emit MaxTransactionAmountUpdated(amount);
    }

    function setCooldownTime(uint256 _seconds) external onlyOwner {
        if (tradingStartTime != type(uint256).max) {
            require(_seconds <= cooldownTime, "Can only relax after trading");
        }
        cooldownTime = _seconds;
        emit CooldownTimeUpdated(_seconds);
    }

    function setBlacklistWindow(uint256 _seconds) external onlyOwner {
        require(tradingStartTime == type(uint256).max, "Cannot change after trading");
        require(_seconds <= 259200, "Max 72 hours");
        blacklistWindow = _seconds;
        emit BlacklistWindowUpdated(_seconds);
    }

    function setBlacklisted(address account, bool blocked) external onlyOwner {
        require(blacklistWindow > 0, "Blacklist not enabled");
        if (tradingStartTime != type(uint256).max) {
            require(block.timestamp <= tradingEnabledAt + blacklistWindow, "Blacklist window expired");
        }
        require(account != owner(), "Cannot blacklist owner");
        blacklisted[account] = blocked;
        emit BlacklistUpdated(account, blocked);
    }

    function setExcludedFromLimits(address account, bool excluded) external onlyOwner {
        isExcludedFromLimits[account] = excluded;
        emit ExcludedFromLimitsUpdated(account, excluded);
    }

    // ── Factory overrides (relax-only) ──────────────────────────────

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

    // ── Transfer pipeline ───────────────────────────────────────────

    /// @dev Runs pool-lock, blacklist, maxTx, maxWallet, and cooldown checks.
    ///      Extracted so taxable `_update` can call it once per transfer and
    ///      then split sub-transfers without retriggering cooldown.
    function _checkProtections(address from, address to, uint256 value) internal {
        // Pool-lock gate: first-and-only line of defense against grifter seeds
        // and post-graduation snipe windows.
        if ((pools[from].isPool || pools[to].isPool) && block.timestamp < tradingStartTime) {
            require(
                isExcludedFromLimits[from] || isExcludedFromLimits[to],
                "Pool locked"
            );
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
        // Track new holders (recipient going from 0 → non-zero)
        if (to != address(0) && balanceOf(to) == 0 && value > 0) {
            unchecked { holderCount++; }
        }

        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            // Track holder removal on burn (sender going to 0)
            if (from != address(0) && balanceOf(from) == 0) {
                unchecked { holderCount--; }
            }
            return;
        }

        _checkProtections(from, to, value);
        super._update(from, to, value);

        // Track holder removal (sender going to 0 after transfer)
        if (balanceOf(from) == 0) {
            unchecked { holderCount--; }
        }

        // Accumulate volume (only real transfers, not mint/burn)
        unchecked { totalVolume += value; }
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

    // ── Views ───────────────────────────────────────────────────────

    /// @notice Returns the V2 pair address registered for a base (if any).
    function getPoolForBase(address base) external view returns (address pair, bool registered) {
        if (dexFactory == address(0)) return (address(0), false);
        pair = IUniswapV2Factory(dexFactory).getPair(address(this), base);
        registered = pair != address(0) && pools[pair].isPool;
    }

    /// @notice Seconds until public trading opens for pre-registered pools.
    ///         Returns 0 if already open, or `type(uint256).max` if not yet scheduled.
    function secondsUntilTradingOpens() external view returns (uint256) {
        if (tradingStartTime == type(uint256).max) return type(uint256).max;
        if (block.timestamp >= tradingStartTime) return 0;
        return tradingStartTime - block.timestamp;
    }
}

// =============================================================
// MINTABLE IMPLEMENTATION
// =============================================================

/// @title MintableTokenImpl
/// @notice Basic token + post-deploy mint and burn. Both bypass
///         `_checkProtections` via the `from == address(0)` /
///         `to == address(0)` short-circuit in `_update`, so the pool-lock
///         gate doesn't fire on minting/burning.
contract MintableTokenImpl is BasicTokenImpl {
    function mint(address to, uint256 amount) external onlyOwner { _mint(to, amount); }
    function burn(uint256 amount) external { _burn(msg.sender, amount); }
}
