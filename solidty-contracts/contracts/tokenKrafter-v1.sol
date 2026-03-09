// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";


// =============================================================
// DEX INTERFACES
// =============================================================

/// @notice Minimal Uniswap V2 Router interface for fee conversion and price queries.
interface IUniswapV2Router02 {
    function factory() external pure returns (address);
    function WETH() external pure returns (address);
    function getAmountsIn(uint256 amountOut, address[] calldata path)
        external view returns (uint256[] memory amounts);
    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external view returns (uint256[] memory amounts);
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

/// @notice Minimal Uniswap V2 Factory interface for pair creation and lookup.
interface IUniswapV2Factory {
    function createPair(address tokenA, address tokenB) external returns (address pair);
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

// =============================================================
// TOKEN INTERFACES
// =============================================================

/// @notice Initialization interface for basic (non-pool-managed) token implementations.
interface IToken {
    /// @param name Token name
    /// @param symbol Token ticker symbol
    /// @param totalSupply Initial total supply (already scaled by decimals)
    /// @param decimals Number of decimal places (max 18)
    /// @param creator Address that will own the token and receive initial supply
    function initialize(
        string calldata name,
        string calldata symbol,
        uint256 totalSupply,
        uint8 decimals,
        address creator
    ) external;
}

/// @notice Interface for tokens to call back into the factory for tax processing.
interface ITokenFactory {
    /// @notice Converts accumulated tax tokens to USDT via the best DEX route.
    /// @param token The token address whose tax balance should be converted
    function processTax(address token) external;
}

/// @notice Initialization interface for pool-managed token implementations (taxable/partner).
interface IPoolManagedToken {
    /// @param name Token name
    /// @param symbol Token ticker symbol
    /// @param totalSupply Initial total supply (already scaled by decimals)
    /// @param decimals Number of decimal places (max 18)
    /// @param creator Address that will own the token and receive initial supply
    /// @param factory The TokenFactory address, used as poolFactory for pool management and tax processing
    function initialize(
        string calldata name,
        string calldata symbol,
        uint256 totalSupply,
        uint8 decimals,
        address creator,
        address factory
    ) external;

    /// @notice Registers DEX liquidity pool addresses for tax detection. Can only be called once by the factory.
    /// @param pools Array of DEX pair addresses to register
    function setupPools(address[] calldata pools) external;
}

// =============================================================
// BASE IMPLEMENTATION
// =============================================================

/// @title BasicTokenImpl
/// @notice Base ERC20 token implementation using OpenZeppelin upgradeable proxies.
///         Deployed as a singleton and cloned via minimal proxy (EIP-1167) for each new token.
/// @dev All derived token types inherit from this contract. The constructor disables
///      initializers on the implementation contract itself to prevent misuse.
contract BasicTokenImpl is ERC20Upgradeable, OwnableUpgradeable {
    /// @dev Locks the implementation contract so it cannot be initialized directly.
    constructor() {
        _disableInitializers();
    }

    uint8 private decimals_;

    /// @notice Shared initialization logic for all token types.
    /// @dev Includes a double-guard: both `initializer` modifier and manual `owner() == address(0)` check.
    /// @param name Token name
    /// @param symbol Token ticker symbol
    /// @param totalSupply Initial total supply (pre-scaled by decimals)
    /// @param _decimals Number of decimal places (max 18)
    /// @param creator Address that receives ownership and initial supply
    function _baseInit(
        string calldata name,
        string calldata symbol,
        uint256 totalSupply,
        uint8 _decimals,
        address creator
    ) internal {
        require(_decimals <= 18);
        __ERC20_init(name, symbol);
        decimals_ = _decimals;
        __Ownable_init(creator);
        _mint(creator, totalSupply);
    }

    /// @notice Initializes a basic (non-taxable, non-partner) token clone.
    /// @param name Token name
    /// @param symbol Token ticker symbol
    /// @param totalSupply Initial total supply (pre-scaled by decimals)
    /// @param _decimals Number of decimal places (max 18)
    /// @param creator Address that receives ownership and initial supply
    function initialize(
        string calldata name,
        string calldata symbol,
        uint256 totalSupply,
        uint8 _decimals,
        address creator
    ) public virtual initializer {
        _baseInit(name, symbol, totalSupply, _decimals, creator);
    }

    /// @notice Returns the number of decimals for the token.
    function decimals() public view override returns (uint8) {
        return decimals_;
    }

}

// =============================================================
// MINTABLE IMPLEMENTATION
// =============================================================

/// @title MintableTokenImpl
/// @notice Basic token with owner-controlled minting and permissionless burn (own tokens only).
/// @dev Type key: 1 (mintable bit set)
contract MintableTokenImpl is BasicTokenImpl {
    /// @notice Mints new tokens. No supply cap is enforced.
    /// @param to Recipient address
    /// @param amount Amount to mint (in smallest unit)
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// @notice Burns tokens from the caller's balance.
    /// @param amount Amount to burn (in smallest unit)
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }
}

// =============================================================
// POOL MANAGED (shared pool logic for taxable/partner tokens)
// =============================================================

/// @title PoolManaged
/// @notice Shared DEX pool tracking logic inherited by TaxableTokenImpl and PartnerTokenImpl.
///         Pools are registered addresses (DEX pairs) used to distinguish buys/sells from
///         regular transfers for tax calculation purposes.
/// @dev The factory auto-creates pairs for supported quote tokens (WBNB, USDT, etc.)
///      and registers them via `setupPools` during token creation. The token owner can
///      manually add/remove pools afterwards.
contract PoolManaged is BasicTokenImpl {
    /// @notice Returns true if the address is a registered DEX liquidity pool.
    mapping(address => bool) public isPool;

    /// @notice The TokenFactory address that created this token. Also used for tax processing callbacks.
    address public poolFactory;

    /// @dev Guard to ensure setupPools is only called once.
    bool private _poolsInitialized;

    /// @notice Emitted when a pool is added or removed.
    /// @param pool The DEX pair address
    /// @param added True if added, false if removed
    event PoolUpdated(address indexed pool, bool added);

    /// @dev Sets the factory address during initialization. Called by derived contracts.
    /// @param _factory The TokenFactory contract address
    function _initPoolManager(address _factory) internal {
        poolFactory = _factory;
    }

    /// @notice Batch-registers DEX pool addresses. Can only be called once, by the factory.
    /// @dev Called automatically by the factory after creating DEX pairs during token creation.
    /// @param pools Array of DEX pair addresses to register
    function setupPools(address[] calldata pools) external {
        require(msg.sender == poolFactory, "Only factory");
        require(!_poolsInitialized, "Already initialized");
        _poolsInitialized = true;
        uint256 len = pools.length;
        for (uint256 i; i < len;) {
            if (pools[i] != address(0)) {
                isPool[pools[i]] = true;
                emit PoolUpdated(pools[i], true);
            }
            unchecked { ++i; }
        }
    }

    /// @notice Registers a new DEX pool for tax detection.
    /// @param pool The DEX pair address to add
    function addPool(address pool) external onlyOwner {
        require(pool != address(0), "Invalid pool");
        isPool[pool] = true;
        emit PoolUpdated(pool, true);
    }

    /// @notice Unregisters a DEX pool from tax detection.
    /// @param pool The DEX pair address to remove
    function removePool(address pool) external onlyOwner {
        isPool[pool] = false;
        emit PoolUpdated(pool, false);
    }
}

// =============================================================
// TAXABLE IMPLEMENTATION
// =============================================================

/// @title TaxableTokenImpl
/// @notice ERC20 token with configurable buy/sell/transfer taxes and pool-based tax detection.
///         Tax is deducted on each transfer and distributed to configured wallets proportionally.
///         Any undistributed remainder (due to rounding or shares < 100%) is burned.
/// @dev Type key: 2 (taxable bit set). Tax rates are in basis points (1 bps = 0.01%).
///      Caps: buy/sell <= 10%, transfer <= 5%, total <= 25%.
contract TaxableTokenImpl is PoolManaged {
    /// @notice Buy tax rate in basis points (applied when `from` is a registered pool).
    uint256 public buyTaxBps;

    /// @notice Sell tax rate in basis points (applied when `to` is a registered pool).
    uint256 public sellTaxBps;

    /// @notice Transfer tax rate in basis points (applied on wallet-to-wallet transfers).
    uint256 public transferTaxBps;

    /// @notice Ordered list of wallets that receive tax distributions.
    address[] public taxWallets;

    /// @notice Corresponding share for each tax wallet in basis points (max total 10000).
    uint16[] public taxSharesBps;

    /// @notice Addresses exempt from tax (tax wallets are auto-exempted).
    mapping(address => bool) public isTaxFree;

    /// @param totalShareBps Sum of all wallet shares in basis points
    event TaxDistributionUpdated(uint256 totalShareBps);

    /// @param account The address whose exemption status changed
    /// @param exempt True if now exempt, false if no longer exempt
    event TaxExemptUpdated(address indexed account, bool exempt);

    /// @notice Initializes a taxable token clone with pool management.
    /// @param name Token name
    /// @param symbol Token ticker symbol
    /// @param totalSupply Initial total supply (pre-scaled by decimals)
    /// @param _decimals Number of decimal places (max 18)
    /// @param creator Address that receives ownership and initial supply
    /// @param _factory The TokenFactory address for pool management
    function initialize(
        string calldata name,
        string calldata symbol,
        uint256 totalSupply,
        uint8 _decimals,
        address creator,
        address _factory
    ) public virtual initializer {
        _baseInit(name, symbol, totalSupply, _decimals, creator);
        _initPoolManager(_factory);
    }

    /// @notice Configures tax distribution wallets and their proportional shares.
    /// @dev Tax wallets are automatically marked as tax-exempt to prevent cascading taxes.
    ///      Previous tax wallets lose their auto-exemption when replaced.
    ///      If shares sum to less than 10000, the remainder is burned.
    /// @param wallets Array of recipient addresses (max 10, no zero addresses)
    /// @param sharesBps Array of shares in basis points (each > 0, total <= 10000)
    function setTaxDistribution(
        address[] calldata wallets,
        uint16[] calldata sharesBps
    ) external onlyOwner {
        require(wallets.length == sharesBps.length, "Length mismatch");
        require(wallets.length <= 10, "Max 10 wallets");

        uint256 oldLen = taxWallets.length;
        for (uint256 i; i < oldLen;) {
            isTaxFree[taxWallets[i]] = false;
            unchecked { ++i; }
        }

        delete taxWallets;
        delete taxSharesBps;

        uint256 newLen = sharesBps.length;
        uint256 sum;
        for (uint256 i; i < newLen;) {
            require(sharesBps[i] > 0, "Share > 0");
            sum += sharesBps[i];
            unchecked { ++i; }
        }
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

    /// @notice Sets buy, sell, and transfer tax rates.
    /// @dev Caps: buy <= 1000 (10%), sell <= 1000 (10%), transfer <= 500 (5%), total <= 2500 (25%).
    /// @param _buyTaxBps Buy tax in basis points
    /// @param _sellTaxBps Sell tax in basis points
    /// @param _transferTaxBps Transfer tax in basis points
    function setTaxes(
        uint256 _buyTaxBps,
        uint256 _sellTaxBps,
        uint256 _transferTaxBps
    ) external virtual onlyOwner {
        require(_buyTaxBps <= 1000, "Buy tax <= 10%");
        require(_sellTaxBps <= 1000, "Sell tax <= 10%");
        require(_transferTaxBps <= 500, "Transfer tax <= 5%");
        require(_buyTaxBps + _sellTaxBps + _transferTaxBps <= 2500, "Total tax <= 25%");
        buyTaxBps = _buyTaxBps;
        sellTaxBps = _sellTaxBps;
        transferTaxBps = _transferTaxBps;
    }

    /// @notice Exempts or un-exempts an address from tax.
    /// @param account The address to update
    /// @param exempt True to exempt, false to remove exemption
    function excludeFromTax(address account, bool exempt) external onlyOwner {
        isTaxFree[account] = exempt;
        emit TaxExemptUpdated(account, exempt);
    }

    /// @dev Overrides ERC20 `_update` to deduct taxes on transfers.
    ///      Tax logic: mint/burn/zero-value pass through untaxed. Tax-free addresses are exempt.
    ///      Pool interactions trigger buy/sell tax; all others trigger transfer tax.
    ///      Tax is split among taxWallets per their sharesBps; remainder is burned.
    function _update(address from, address to, uint256 value) internal virtual override {
        if (from == address(0) || to == address(0) || value == 0) {
            super._update(from, to, value);
            return;
        }

        if (isTaxFree[from] || isTaxFree[to]) {
            super._update(from, to, value);
            return;
        }

        uint256 tax = 0;
        if (!isPool[from] && !isPool[to]) {
            tax = (value * transferTaxBps) / 10000;
        } else if (isPool[from]) {
            tax = (value * buyTaxBps) / 10000;
        } else if (isPool[to]) {
            tax = (value * sellTaxBps) / 10000;
        }

        if (tax == 0) {
            super._update(from, to, value);
            return;
        }

        uint256 remaining = tax;
        uint256 len = taxWallets.length;

        for (uint256 i; i < len;) {
            uint256 amount = (tax * taxSharesBps[i]) / 10000;
            if (amount > 0) {
                super._update(from, taxWallets[i], amount);
                remaining -= amount;
            }
            unchecked { ++i; }
        }

        if (remaining > 0) {
            super._update(from, address(0), remaining);
        }

        super._update(from, to, value - tax);
    }
}

// =============================================================
// TAXABLE + MINTABLE
// =============================================================

/// @title TaxableMintableTokenImpl
/// @notice Taxable token with additional owner-controlled minting and permissionless burn.
/// @dev Type key: 3 (taxable + mintable bits set)
contract TaxableMintableTokenImpl is TaxableTokenImpl {
    /// @notice Mints new tokens to the specified address. No supply cap.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// @notice Burns tokens from the caller's balance.
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }
}

// =============================================================
// PARTNER IMPLEMENTATION (1% factory tax on buys/sells)
// =============================================================

/// @title PartnerTokenImpl
/// @notice ERC20 token with a fixed 1% partnership tax on buys and sells.
///         The partnership tax is sent to the factory, which optionally converts it to USDT.
/// @dev Type key: 4 (partner bit set). The factory address is exempt from taxes to prevent
///      reentrancy issues during processTax DEX swaps. If processTax fails (no liquidity,
///      reentrancy), tokens accumulate in the factory for later manual conversion.
contract PartnerTokenImpl is PoolManaged {
    /// @notice Fixed partnership tax rate: 100 bps (1%) on all pool interactions (buys/sells).
    uint16 public constant PARTNERSHIP_BPS = 100;

    /// @notice Initializes a partner token clone with pool management.
    function initialize(
        string calldata name,
        string calldata symbol,
        uint256 totalSupply,
        uint8 _decimals,
        address creator,
        address _factory
    ) public virtual initializer {
        _baseInit(name, symbol, totalSupply, _decimals, creator);
        _initPoolManager(_factory);
    }

    /// @dev Overrides `_update` to deduct 1% partnership tax on pool interactions.
    ///      After deducting, calls `processTax` on the factory (wrapped in try-catch for safety).
    ///      Factory address is exempt to prevent reentrancy during DEX swaps.
    function _update(address from, address to, uint256 value) internal virtual override {
        if (from != address(0) && to != address(0) && value > 0
            && from != poolFactory && to != poolFactory
            && (isPool[from] || isPool[to]))
        {
            uint256 pTax = (value * PARTNERSHIP_BPS) / 10000;
            if (pTax > 0) {
                super._update(from, poolFactory, pTax);
                super._update(from, to, value - pTax);
                try ITokenFactory(poolFactory).processTax(address(this)) {} catch {}
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
/// @notice Partner token with additional owner-controlled minting and permissionless burn.
/// @dev Type key: 5 (partner + mintable bits set)
contract PartnerMintableTokenImpl is PartnerTokenImpl {
    /// @notice Mints new tokens to the specified address. No supply cap.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// @notice Burns tokens from the caller's balance.
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }
}

// =============================================================
// PARTNER + TAXABLE
// =============================================================

/// @title PartnerTaxableTokenImpl
/// @notice Combined partner + taxable token. Applies both a fixed 1% partnership tax
///         (sent to factory) and user-configurable taxes (distributed to tax wallets).
/// @dev Type key: 6 (partner + taxable bits set). Tax caps are reduced vs plain taxable:
///      buy/sell <= 9% (since 1% goes to partnership), transfer <= 5%, total <= 24%.
///      Uses ERC20Upgradeable._update directly (not super._update) to avoid double-taxing
///      through TaxableTokenImpl's _update override.
contract PartnerTaxableTokenImpl is TaxableTokenImpl {
    /// @notice Fixed partnership tax rate: 100 bps (1%) on pool interactions.
    uint16 public constant PARTNERSHIP_BPS = 100;

    /// @notice Sets tax rates with partner-adjusted caps (buy/sell <= 9%, transfer <= 5%, total <= 24%).
    /// @dev Overrides TaxableTokenImpl.setTaxes with lower limits to account for the 1% partnership tax.
    /// @param _buyTaxBps Buy tax in basis points (max 900)
    /// @param _sellTaxBps Sell tax in basis points (max 900)
    /// @param _transferTaxBps Transfer tax in basis points (max 500)
    function setTaxes(
        uint256 _buyTaxBps,
        uint256 _sellTaxBps,
        uint256 _transferTaxBps
    ) external override onlyOwner {
        require(_buyTaxBps <= 900, "Buy tax <= 9% (partner)");
        require(_sellTaxBps <= 900, "Sell tax <= 9% (partner)");
        require(_transferTaxBps <= 500, "Transfer tax <= 5%");
        require(_buyTaxBps + _sellTaxBps + _transferTaxBps <= 2400, "Total tax <= 24% (partner 1%)");
        buyTaxBps = _buyTaxBps;
        sellTaxBps = _sellTaxBps;
        transferTaxBps = _transferTaxBps;
    }

    /// @dev Overrides `_update` to apply both partnership and user taxes in a single pass.
    ///      Order: (1) partnership tax to factory, (2) user tax to wallets, (3) remainder to recipient.
    ///      Factory address is fully exempt from all taxes. After deductions on pool interactions,
    ///      calls processTax on the factory (try-catch for graceful failure).
    function _update(address from, address to, uint256 value) internal virtual override {
        // Mint/burn pass through
        if (from == address(0) || to == address(0) || value == 0) {
            ERC20Upgradeable._update(from, to, value);
            return;
        }

        // Factory always exempt from all taxes
        if (from == poolFactory || to == poolFactory) {
            ERC20Upgradeable._update(from, to, value);
            return;
        }

        bool isBuy = isPool[from];
        bool isSell = isPool[to];
        uint256 totalDeducted = 0;

        // Partnership tax (buys/sells only)
        if (isBuy || isSell) {
            uint256 pTax = (value * PARTNERSHIP_BPS) / 10000;
            if (pTax > 0) {
                ERC20Upgradeable._update(from, poolFactory, pTax);
                totalDeducted += pTax;
            }
        }

        // User tax (skip if either side is tax-free)
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
                    if (amt > 0) {
                        ERC20Upgradeable._update(from, taxWallets[i], amt);
                        remaining -= amt;
                    }
                    unchecked { ++i; }
                }

                if (remaining > 0) {
                    ERC20Upgradeable._update(from, address(0), remaining);
                }
                totalDeducted += userTax;
            }
        }

        ERC20Upgradeable._update(from, to, value - totalDeducted);

        // Process partnership tax conversion if any was collected
        if (totalDeducted > 0 && (isBuy || isSell)) {
            try ITokenFactory(poolFactory).processTax(address(this)) {} catch {}
        }
    }
}

// =============================================================
// PARTNER + TAXABLE + MINTABLE
// =============================================================

/// @title PartnerTaxableMintableTokenImpl
/// @notice Combined partner + taxable + mintable token. Full feature set.
/// @dev Type key: 7 (all bits set: partner + taxable + mintable)
contract PartnerTaxableMintableTokenImpl is PartnerTaxableTokenImpl {
    /// @notice Mints new tokens to the specified address. No supply cap.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// @notice Burns tokens from the caller's balance.
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }
}

// =============================================================
// TOKEN FACTORY
// =============================================================

/// @title TokenFactory
/// @author TokenKrafter
/// @notice Factory contract for creating ERC20 tokens with configurable features via minimal proxies (EIP-1167).
///         Supports 8 token types based on a 3-bit feature bitfield: partner (4), taxable (2), mintable (1).
///         Handles creation fees (payable in USDT or native currency), auto-creates DEX liquidity pairs
///         for taxable/partner tokens, and optionally converts accumulated partnership taxes to USDT.
/// @dev Uses OpenZeppelin Clones for gas-efficient token deployment. Each token type has a pre-deployed
///      implementation contract that is cloned and initialized per creation. The factory also serves as
///      the `poolFactory` for all pool-managed tokens, receiving partnership taxes and converting them
///      via the best available DEX route (direct or via WETH).
contract TokenFactory is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Metadata stored for each created token.
    struct TokenInfo {
        address creator;
        bool isMintable;
        bool isTaxable;
        bool isPartnership;
    }

    /// @notice Parameters for creating a new token.
    /// @param name Token name
    /// @param symbol Token ticker symbol
    /// @param totalSupply Total supply in whole units (scaled by decimals during creation)
    /// @param decimals Number of decimal places (max 18)
    /// @param isTaxable Whether the token has user-configurable taxes
    /// @param isMintable Whether the owner can mint additional tokens
    /// @param isPartner Whether a 1% partnership tax is applied on pool interactions
    /// @param paymentToken Address of the token used to pay creation fee (address(0) for native)
    struct CreateTokenParams {
        string name;
        string symbol;
        uint256 totalSupply;
        uint8 decimals;
        bool isTaxable;
        bool isMintable;
        bool isPartner;
        address paymentToken;
    }

    /// @dev Token type keys use a 3-bit bitfield: partner=4, taxable=2, mintable=1
    ///      0=basic, 1=mintable, 2=taxable, 3=taxable+mintable,
    ///      4=partner, 5=partner+mintable, 6=partner+taxable, 7=partner+taxable+mintable

    /// @notice The DEX router used for fee conversion and tax processing swaps.
    IUniswapV2Router02 public dexRouter;

    /// @notice The stablecoin address (e.g., USDT) used as the base fee denomination and tax conversion target.
    address public usdt;

    /// @notice Implementation contract address for each token type (indexed by type key 0-7).
    mapping(uint8 => address) public implementations;

    /// @notice Creation fee in USDT for each token type (indexed by type key 0-7).
    mapping(uint8 => uint256) public creationFee;

    /// @dev List of supported payment tokens. address(0) represents native currency (BNB/ETH).
    address[] private _supportedTokens;

    /// @notice Returns true if a token is accepted as payment for creation fees.
    mapping(address => bool) public isPaymentSupported;

    /// @dev Mapping of creator address to their created token addresses.
    mapping(address => address[]) private createdTokens;

    /// @notice Metadata for each token created by this factory.
    mapping(address => TokenInfo) public tokenInfo;

    /// @notice Total number of tokens created across all types.
    uint256 public totalTokensCreated;

    /// @notice Per-creator nonce used for deterministic salt computation.
    mapping(address => uint256) public creatorNonce;

    /// @notice Number of tokens created per type key (0-7).
    mapping(uint8 => uint256) public tokensCreatedByType;

    /// @notice When true, `processTax` will swap accumulated tax tokens to USDT via the best DEX route.
    bool public convertTaxToStable;

    // =============================================================
    // REFERRAL / AFFILIATE PROGRAM
    // =============================================================

    /// @notice Maps a user to their referrer (the address that referred them).
    mapping(address => address) public referrals;

    /// @notice Number of referral levels to walk up the chain (default 3, max 10).
    uint8 public referralLevels = 3;

    /// @notice When true, referral rewards are sent immediately on token creation.
    ///         When false, rewards accumulate and referrers must call `claimReward`.
    bool public autoDistributeReward = true;

    /// @notice Reward percentage per referral level in basis points (e.g., 500 = 5%).
    /// @dev Index 0 = direct referrer, index 1 = referrer's referrer, etc.
    uint256[] public referralPercents;

    /// @notice Number of direct referrals per referrer.
    mapping(address => uint256) public totalReferred;

    /// @notice Total rewards earned per referrer per payment token.
    mapping(address => mapping(address => uint256)) public totalEarned;

    /// @notice Claimable reward balance per user per payment token (used when autoDistributeReward is false).
    mapping(address => mapping(address => uint256)) public pendingRewards;

    /// @param creator The address that created the token
    /// @param tokenAddress The deployed token clone address
    /// @param tokenType The type key (0-7) of the created token
    /// @param name Token name
    /// @param symbol Token symbol
    /// @param totalSupply Total supply in whole units (before decimal scaling)
    /// @param decimals Number of decimals
    event TokenCreated(
        address indexed creator,
        address indexed tokenAddress,
        uint8 tokenType,
        string name,
        string symbol,
        uint256 totalSupply,
        uint8 decimals
    );

    /// @param tokenType The type key (0-7) that was updated
    /// @param impl The new implementation contract address
    event ImplementationUpdated(uint8 indexed tokenType, address impl);

    /// @param token The payment token address added (address(0) for native)
    event PaymentTokenAdded(address indexed token);

    /// @param token The payment token address removed
    event PaymentTokenRemoved(address indexed token);

    /// @param token The tax token that was swapped
    /// @param amountIn Amount of tax tokens swapped
    /// @param amountOut Amount of USDT received
    event TaxProcessed(address indexed token, uint256 amountIn, uint256 amountOut);

    /// @param enabled Whether tax-to-stable conversion is now enabled
    event ConvertTaxToStableUpdated(bool enabled);

    /// @param creator The token creator who was referred
    /// @param referrer The address that referred the creator
    event ReferralRecorded(address indexed creator, address indexed referrer);

    /// @param referrer The referrer receiving the reward
    /// @param paymentToken The token the reward is denominated in
    /// @param amount The reward amount
    /// @param level The referral level (0 = direct, 1 = second level, etc.)
    event ReferralRewardDistributed(address indexed referrer, address paymentToken, uint256 amount, uint8 level);

    /// @param user The user claiming their accumulated rewards
    /// @param paymentToken The token being claimed
    /// @param amount The claimed amount
    event ReferralRewardClaimed(address indexed user, address paymentToken, uint256 amount);

    /// @notice Deploys the factory with USDT as the fee denomination token and a DEX router for price queries.
    /// @dev Sets default creation fees for all 8 token types and auto-adds USDT + native as payment methods.
    /// @param _usdt The stablecoin address used for fee denomination and tax conversion target
    /// @param _dexRouter The Uniswap V2-compatible router address
    constructor(
        address _usdt,
        address _dexRouter
    ) Ownable(msg.sender) {
        require(_usdt != address(0), "Invalid USDT");
        require(_dexRouter != address(0), "Invalid router");

        usdt = _usdt;
        dexRouter = IUniswapV2Router02(_dexRouter);

        uint8 _usdtDecimals = ERC20(_usdt).decimals();

        // Default fees in USDT
        creationFee[0] = 10 * 10 ** _usdtDecimals;  // basic
        creationFee[1] = 20 * 10 ** _usdtDecimals;  // mintable
        creationFee[2] = 25 * 10 ** _usdtDecimals;  // taxable
        creationFee[3] = 35 * 10 ** _usdtDecimals;  // taxable+mintable
        creationFee[4] = 15 * 10 ** _usdtDecimals;  // partner
        creationFee[5] = 25 * 10 ** _usdtDecimals;  // partner+mintable
        creationFee[6] = 30 * 10 ** _usdtDecimals;  // partner+taxable
        creationFee[7] = 40 * 10 ** _usdtDecimals;  // partner+taxable+mintable

        // Auto-add USDT and native as supported payment
        _addPaymentToken(_usdt);
        _addPaymentToken(address(0));

        // Default referral rewards: 5%, 3%, 2%
        referralPercents.push(500);
        referralPercents.push(300);
        referralPercents.push(200);
    }

    // =============================================================
    // INTERNAL HELPERS
    // =============================================================

    /// @dev Computes the token type key from feature flags using a 3-bit bitfield.
    /// @return Type key 0-7
    function _tokenTypeKey(bool isTaxable, bool isMintable, bool isPartner)
        internal pure returns (uint8)
    {
        return uint8((isPartner ? 4 : 0) | (isTaxable ? 2 : 0) | (isMintable ? 1 : 0));
    }

    /// @dev Converts a USDT-denominated fee amount to an equivalent amount of `paymentToken`
    ///      using the DEX router's `getAmountsIn`. Returns 0 if no route exists.
    /// @param usdtAmount The fee amount denominated in USDT
    /// @param paymentToken The token the user wants to pay with (address(0) for native)
    /// @return The equivalent amount in `paymentToken`
    function _convertFee(uint256 usdtAmount, address paymentToken)
        internal view returns (uint256)
    {
        if (usdtAmount == 0) return 0;
        if (paymentToken == usdt) return usdtAmount;

        address tokenIn = paymentToken == address(0)
            ? dexRouter.WETH()
            : paymentToken;

        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = usdt;

        try dexRouter.getAmountsIn(usdtAmount, path) returns (uint256[] memory amounts) {
            return amounts[0];
        } catch {
            return 0;
        }
    }

    /// @dev Collects the creation fee from `payer` in the specified `paymentToken`.
    ///      For native payments, refunds any excess. For ERC20 payments, uses safeTransferFrom.
    /// @param payer The address paying the fee
    /// @param paymentToken The payment token address (address(0) for native)
    /// @param typeKey The token type key to look up the fee amount
    /// @return amount The actual fee amount collected in `paymentToken` units
    function _collectFeeFrom(
        address payer,
        address paymentToken,
        uint8 typeKey
    ) internal returns (uint256 amount) {
        uint256 baseFee = creationFee[typeKey];
        if (baseFee == 0) return 0;

        require(isPaymentSupported[paymentToken], "Unsupported payment token");

        amount = _convertFee(baseFee, paymentToken);
        require(amount > 0, "Cannot determine fee");

        if (paymentToken == address(0)) {
            require(msg.value >= amount, "Insufficient native payment");
            uint256 excess = msg.value - amount;
            if (excess > 0) {
                (bool ok, ) = msg.sender.call{value: excess}("");
                require(ok, "Refund failed");
            }
        } else {
            IERC20(paymentToken).safeTransferFrom(payer, address(this), amount);
        }
    }

    /// @dev Creates DEX pairs for the token against all supported quote tokens and registers
    ///      them on the token via `setupPools`. Skips if the quote token is the token itself.
    /// @param token The newly created token address
    function _setupPools(address token) internal {
        IUniswapV2Factory dexFactory = IUniswapV2Factory(dexRouter.factory());
        address weth = dexRouter.WETH();
        uint256 len = _supportedTokens.length;
        address[] memory pools = new address[](len);
        uint256 count;

        for (uint256 i; i < len;) {
            address quoteToken = _supportedTokens[i] == address(0)
                ? weth
                : _supportedTokens[i];

            // Skip if quote token is the token itself
            if (quoteToken == token) {
                unchecked { ++i; }
                continue;
            }

            address pair = dexFactory.getPair(token, quoteToken);
            if (pair == address(0)) {
                pair = dexFactory.createPair(token, quoteToken);
            }
            pools[count] = pair;
            unchecked { ++count; ++i; }
        }

        // Trim array to actual count
        assembly ("memory-safe") { mstore(pools, count) }

        IPoolManagedToken(token).setupPools(pools);
    }

    /// @dev Adds a token to the supported payment list if not already present.
    function _addPaymentToken(address token) internal {
        if (!isPaymentSupported[token]) {
            isPaymentSupported[token] = true;
            _supportedTokens.push(token);
            emit PaymentTokenAdded(token);
        }
    }

    /// @dev Processes the referral chain: records the referral relationship, then walks up the chain
    ///      distributing rewards at each level. Rewards are either sent immediately or accumulated
    ///      for claiming, depending on `autoDistributeReward`.
    /// @param creator The token creator being referred
    /// @param referral The direct referrer address passed to `createToken`
    /// @param paymentToken The token used to pay the creation fee
    /// @param feeAmount The total fee amount collected (rewards are a percentage of this)
    function _processReferral(
        address creator,
        address referral,
        address paymentToken,
        uint256 feeAmount
    ) internal {
        if (referral == address(0) || referral == creator) return;
        require(referrals[referral] != creator, "Circular referral");

        // Record referral if creator doesn't already have one
        if (referrals[creator] == address(0)) {
            referrals[creator] = referral;
            totalReferred[referral]++;
            emit ReferralRecorded(creator, referral);
        }

        if (feeAmount == 0) return;

        // Walk up the referral chain from creator's referrer
        address ref = referrals[creator];
        uint8 levels = referralLevels;
        uint256 percentsLen = referralPercents.length;

        for (uint8 i = 0; i < levels;) {
            if (ref == address(0)) break;
            if (i >= percentsLen) break;

            uint256 reward = (feeAmount * referralPercents[i]) / 10000;
            if (reward > 0) {
                if (autoDistributeReward) {
                    if (paymentToken == address(0)) {
                        (bool ok, ) = ref.call{value: reward}("");
                        if (!ok) {
                            pendingRewards[ref][paymentToken] += reward;
                        }
                    } else {
                        IERC20(paymentToken).safeTransfer(ref, reward);
                    }
                } else {
                    pendingRewards[ref][paymentToken] += reward;
                }

                totalEarned[ref][paymentToken] += reward;
                emit ReferralRewardDistributed(ref, paymentToken, reward, i);
            }

            ref = referrals[ref];
            unchecked { ++i; }
        }
    }

    /// @dev Initializes a cloned token, sets up pools (if applicable), records metadata, and emits event.
    /// @param p The creation parameters
    /// @param creator The address that will own the token
    /// @param tokenAddress The cloned token contract address
    /// @param typeKey The token type key (0-7)
    function _initAndRecord(
        CreateTokenParams calldata p,
        address creator,
        address tokenAddress,
        uint8 typeKey
    ) internal {
        uint256 supply = p.totalSupply * 10 ** p.decimals;

        if (p.isPartner || p.isTaxable) {
            IPoolManagedToken(tokenAddress).initialize(
                p.name, p.symbol, supply, p.decimals, creator, address(this)
            );
            _setupPools(tokenAddress);
        } else {
            IToken(tokenAddress).initialize(
                p.name, p.symbol, supply, p.decimals, creator
            );
        }

        createdTokens[creator].push(tokenAddress);
        tokenInfo[tokenAddress] = TokenInfo({
            creator: creator,
            isMintable: p.isMintable,
            isTaxable: p.isTaxable,
            isPartnership: p.isPartner
        });

        totalTokensCreated++;
        tokensCreatedByType[typeKey]++;

        emit TokenCreated(
            creator, tokenAddress, typeKey,
            p.name, p.symbol, p.totalSupply, p.decimals
        );
    }

    // =============================================================
    // TOKEN CREATION
    // =============================================================

    /// @dev Generates a deterministic salt from the creator address and their nonce, then increments the nonce.
    /// @param creator The token creator address
    /// @return salt The computed salt for cloneDeterministic
    function _computeSalt(address creator) internal returns (bytes32) {
        uint256 nonce = creatorNonce[creator]++;
        return keccak256(abi.encodePacked(creator, nonce));
    }

    /// @notice Creates a new token by cloning the appropriate implementation and initializing it.
    /// @dev Uses cloneDeterministic for predictable token addresses. The salt is derived from
    ///      the creator address and `totalTokensCreated` counter, ensuring uniqueness.
    /// @param p Token creation parameters
    /// @param referral The address that referred this creator (address(0) if none)
    /// @return tokenAddress The address of the newly created token clone
    function createToken(CreateTokenParams calldata p, address referral)
        external payable nonReentrant returns (address tokenAddress)
    {
        require(p.totalSupply > 0 && p.decimals <= 18
            && bytes(p.name).length > 0 && bytes(p.symbol).length > 0);

        uint8 typeKey = _tokenTypeKey(p.isTaxable, p.isMintable, p.isPartner);
        address impl = implementations[typeKey];
        require(impl != address(0), "Token type not supported");

        uint256 feeAmount = _collectFeeFrom(msg.sender, p.paymentToken, typeKey);
        _processReferral(msg.sender, referral, p.paymentToken, feeAmount);

        bytes32 salt = _computeSalt(msg.sender);
        tokenAddress = Clones.cloneDeterministic(impl, salt);
        _initAndRecord(p, msg.sender, tokenAddress, typeKey);

        return tokenAddress;
    }

    /// @notice Creates a token on behalf of another address. Only callable by the factory owner.
    /// @dev Fee is collected from `creator`, not msg.sender. Useful for airdrop or sponsored creation.
    /// @param creator The address that will own the token and pay the creation fee
    /// @param p Token creation parameters
    /// @param referral The address that referred the creator (address(0) if none)
    /// @return tokenAddress The address of the newly created token clone
    function ownerCreateToken(address creator, CreateTokenParams calldata p, address referral)
        external payable onlyOwner nonReentrant returns (address tokenAddress)
    {
        require(creator != address(0), "Invalid creator");
        require(p.totalSupply > 0 && p.decimals <= 18
            && bytes(p.name).length > 0 && bytes(p.symbol).length > 0);

        uint8 typeKey = _tokenTypeKey(p.isTaxable, p.isMintable, p.isPartner);
        address impl = implementations[typeKey];
        require(impl != address(0), "Token type not supported");

        uint256 feeAmount = _collectFeeFrom(creator, p.paymentToken, typeKey);
        _processReferral(creator, referral, p.paymentToken, feeAmount);

        bytes32 salt = _computeSalt(creator);
        tokenAddress = Clones.cloneDeterministic(impl, salt);
        _initAndRecord(p, creator, tokenAddress, typeKey);

        return tokenAddress;
    }

    // =============================================================
    // VIEW FUNCTIONS
    // =============================================================

    /// @notice Returns all token addresses created by a specific creator.
    /// @param creator The creator's address
    function getCreatedTokens(address creator) external view returns (address[] memory) {
        return createdTokens[creator];
    }

    /// @notice Returns metadata for a token created by this factory.
    /// @param token The token contract address
    function getTokenInfo(address token) external view returns (TokenInfo memory) {
        return tokenInfo[token];
    }

    /// @notice Returns creation fees for a token type across all supported payment tokens.
    /// @dev Converts the USDT-denominated base fee to each payment token using DEX prices.
    /// @param isTaxable Whether the token type has user taxes
    /// @param isMintable Whether the token type is mintable
    /// @param isPartner Whether the token type has partnership tax
    /// @return tokens Array of supported payment token addresses
    /// @return fees Array of corresponding fee amounts in each payment token
    function getCreationFee(bool isTaxable, bool isMintable, bool isPartner)
        external view returns (address[] memory tokens, uint256[] memory fees)
    {
        uint8 typeKey = _tokenTypeKey(isTaxable, isMintable, isPartner);
        uint256 baseFee = creationFee[typeKey];
        uint256 len = _supportedTokens.length;

        tokens = new address[](len);
        fees = new uint256[](len);

        for (uint256 i; i < len;) {
            tokens[i] = _supportedTokens[i];
            fees[i] = _convertFee(baseFee, _supportedTokens[i]);
            unchecked { ++i; }
        }
    }

    /// @notice Returns all supported payment token addresses. address(0) represents native currency.
    function getSupportedPaymentTokens() external view returns (address[] memory) {
        return _supportedTokens;
    }

    /// @notice Returns factory-wide token creation statistics.
    /// @return total Total number of tokens created
    /// @return byType Array of 8 counts, one per token type key (0-7)
    function getStats() external view returns (
        uint256 total,
        uint256[8] memory byType
    ) {
        total = totalTokensCreated;
        for (uint8 i; i < 8;) {
            byType[i] = tokensCreatedByType[i];
            unchecked { ++i; }
        }
    }

    /// @notice Predicts the address of the next token that would be created by `creator`.
    /// @dev Uses `Clones.predictDeterministicAddress` with the same salt logic as `createToken`.
    /// @param creator The prospective token creator
    /// @param isTaxable Whether the token will be taxable
    /// @param isMintable Whether the token will be mintable
    /// @param isPartner Whether the token will be a partner token
    /// @return predicted The deterministic address of the next token clone
    function predictTokenAddress(
        address creator,
        bool isTaxable,
        bool isMintable,
        bool isPartner
    ) external view returns (address predicted) {
        uint8 typeKey = _tokenTypeKey(isTaxable, isMintable, isPartner);
        address impl = implementations[typeKey];
        require(impl != address(0), "Token type not supported");

        bytes32 salt = keccak256(abi.encodePacked(creator, creatorNonce[creator]));
        predicted = Clones.predictDeterministicAddress(impl, salt, address(this));
    }

    /// @notice Returns referral stats for a referrer across specified payment tokens.
    /// @param referrer The referrer address
    /// @param paymentTokens Array of payment token addresses to query earnings for
    /// @return referred Number of direct referrals
    /// @return earned Array of total earnings per payment token
    /// @return pending Array of claimable rewards per payment token
    function getReferralStats(address referrer, address[] calldata paymentTokens)
        external view returns (
            uint256 referred,
            uint256[] memory earned,
            uint256[] memory pending
        )
    {
        referred = totalReferred[referrer];
        uint256 len = paymentTokens.length;
        earned = new uint256[](len);
        pending = new uint256[](len);

        for (uint256 i; i < len;) {
            earned[i] = totalEarned[referrer][paymentTokens[i]];
            pending[i] = pendingRewards[referrer][paymentTokens[i]];
            unchecked { ++i; }
        }
    }

    /// @notice Returns the full referral chain for a user up to `referralLevels` deep.
    /// @param user The user to trace the referral chain for
    /// @return chain Array of referrer addresses from direct referrer upward
    function getReferralChain(address user) external view returns (address[] memory chain) {
        chain = new address[](referralLevels);
        address ref = referrals[user];
        uint256 count;

        for (uint8 i = 0; i < referralLevels;) {
            if (ref == address(0)) break;
            chain[count] = ref;
            ref = referrals[ref];
            unchecked { ++count; ++i; }
        }

        assembly ("memory-safe") { mstore(chain, count) }
    }

    /// @notice Returns the current referral reward percentages per level.
    /// @return percents Array of basis point values per level
    function getReferralPercents() external view returns (uint256[] memory) {
        return referralPercents;
    }

    // =============================================================
    // REFERRAL CLAIMS
    // =============================================================

    /// @notice Claims accumulated referral rewards for a specific payment token.
    /// @dev Only callable when `autoDistributeReward` is false (or when auto-send failed for native).
    /// @param paymentToken The payment token to claim (address(0) for native)
    function claimReward(address paymentToken) external nonReentrant {
        uint256 amount = pendingRewards[msg.sender][paymentToken];
        require(amount > 0, "No rewards");

        pendingRewards[msg.sender][paymentToken] = 0;

        if (paymentToken == address(0)) {
            (bool ok, ) = msg.sender.call{value: amount}("");
            require(ok, "Transfer failed");
        } else {
            IERC20(paymentToken).safeTransfer(msg.sender, amount);
        }

        emit ReferralRewardClaimed(msg.sender, paymentToken, amount);
    }

    // =============================================================
    // TAX PROCESSING
    // =============================================================

    /// @notice Converts accumulated tax tokens held by the factory to USDT via the best DEX route.
    /// @dev Callable by the factory owner or by the registered token itself (during `_update` callbacks).
    ///      Compares direct (token→USDT) vs WETH (token→WETH→USDT) routes and uses the better one.
    ///      Wrapped in try-catch: if the swap fails (no liquidity, reentrancy), tokens remain in the
    ///      factory and can be converted later via a manual owner call or `withdrawToken`.
    /// @param token The ERC20 token address to swap for USDT
    function processTax(address token) external {
        require(
            msg.sender == owner() ||
            (msg.sender == token && tokenInfo[token].creator != address(0)),
            "Only owner or registered token"
        );
        if (!convertTaxToStable) return;
        if (token == usdt) return; // already stable

        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance == 0) return;

        address weth = dexRouter.WETH();

        // Route 1: token → USDT (direct)
        address[] memory directPath = new address[](2);
        directPath[0] = token;
        directPath[1] = usdt;

        // Route 2: token → WETH → USDT
        address[] memory wethPath = new address[](3);
        wethPath[0] = token;
        wethPath[1] = weth;
        wethPath[2] = usdt;

        uint256 directOut;
        uint256 wethOut;

        try dexRouter.getAmountsOut(balance, directPath) returns (uint256[] memory amounts) {
            directOut = amounts[amounts.length - 1];
        } catch {}

        try dexRouter.getAmountsOut(balance, wethPath) returns (uint256[] memory amounts) {
            wethOut = amounts[amounts.length - 1];
        } catch {}

        // No liquidity on either route
        if (directOut == 0 && wethOut == 0) return;

        bool isDirect = directOut >= wethOut;
        address[] memory bestPath = isDirect ? directPath : wethPath;
        uint256 expectedOut = isDirect ? directOut : wethOut;

        // 5% slippage tolerance to prevent sandwich attacks
        uint256 amountOutMin = (expectedOut * 95) / 100;

        IERC20(token).forceApprove(address(dexRouter), balance);

        try dexRouter.swapExactTokensForTokens(
            balance,
            amountOutMin,
            bestPath,
            address(this),
            block.timestamp
        ) returns (uint256[] memory amounts) {
            emit TaxProcessed(token, balance, amounts[amounts.length - 1]);
        } catch {}
    }

    // =============================================================
    // ADMIN FUNCTIONS
    // =============================================================

    /// @notice Sets the implementation contract address for a token type.
    /// @param tokenType The type key (0-7)
    /// @param impl The implementation contract address (must not be zero)
    function setImplementation(uint8 tokenType, address impl) external onlyOwner {
        require(tokenType <= 7, "Invalid token type");
        require(impl != address(0), "Invalid implementation");
        implementations[tokenType] = impl;
        emit ImplementationUpdated(tokenType, impl);
    }

    /// @notice Toggles whether `processTax` converts accumulated tokens to USDT.
    /// @param _enabled True to enable automatic conversion, false to accumulate tokens
    function setConvertTaxToStable(bool _enabled) external onlyOwner {
        convertTaxToStable = _enabled;
        emit ConvertTaxToStableUpdated(_enabled);
    }

    /// @notice Updates the USDT-denominated creation fee for a token type.
    /// @param tokenType The type key (0-7)
    /// @param fee The fee amount in USDT (with decimals)
    function setCreationFee(uint8 tokenType, uint256 fee) external onlyOwner {
        require(tokenType <= 7, "Invalid token type");
        creationFee[tokenType] = fee;
    }

    /// @notice Updates the DEX router used for fee conversion and tax processing.
    /// @param _dexRouter The new Uniswap V2-compatible router address
    function setDexRouter(address _dexRouter) external onlyOwner {
        require(_dexRouter != address(0), "Invalid router");
        dexRouter = IUniswapV2Router02(_dexRouter);
    }

    /// @notice Adds a new accepted payment token for creation fees.
    /// @param token The token address to add (address(0) for native)
    function addPaymentToken(address token) external onlyOwner {
        require(!isPaymentSupported[token], "Already supported");
        _addPaymentToken(token);
    }

    /// @notice Removes a payment token from the accepted list. Uses swap-and-pop for gas efficiency.
    /// @param token The token address to remove
    function removePaymentToken(address token) external onlyOwner {
        require(isPaymentSupported[token], "Not supported");
        isPaymentSupported[token] = false;

        uint256 len = _supportedTokens.length;
        for (uint256 i; i < len;) {
            if (_supportedTokens[i] == token) {
                _supportedTokens[i] = _supportedTokens[len - 1];
                _supportedTokens.pop();
                break;
            }
            unchecked { ++i; }
        }
        emit PaymentTokenRemoved(token);
    }

    /// @notice Sets the number of referral levels to distribute rewards through.
    /// @param _levels Number of levels (max 10)
    function setReferralLevels(uint8 _levels) external onlyOwner {
        require(_levels <= 10, "Max 10 levels");
        referralLevels = _levels;
    }

    /// @notice Sets the referral reward percentages per level in basis points.
    /// @dev Array length should match `referralLevels`. Total must not exceed 5000 (50%).
    /// @param _percents Array of basis point values per level (e.g., [500, 300, 200] = 5%, 3%, 2%)
    function setReferralPercents(uint256[] calldata _percents) external onlyOwner {
        uint256 total;
        for (uint256 i; i < _percents.length;) {
            total += _percents[i];
            unchecked { ++i; }
        }
        require(total <= 5000, "Total exceeds 50%");

        delete referralPercents;
        for (uint256 i; i < _percents.length;) {
            referralPercents.push(_percents[i]);
            unchecked { ++i; }
        }
    }

    /// @notice Toggles whether referral rewards are sent immediately or accumulated for claiming.
    /// @param _enabled True for auto-distribution, false for manual claiming
    function setAutoDistributeReward(bool _enabled) external onlyOwner {
        autoDistributeReward = _enabled;
    }

    /// @notice Withdraws accumulated tokens or native currency from the factory to the owner.
    /// @dev Use address(0) to withdraw native currency (BNB/ETH).
    /// @param token The token address to withdraw, or address(0) for native
    function withdrawToken(address token) external onlyOwner {
        if (token == address(0)) {
            uint256 bal = address(this).balance;
            require(bal > 0, "No balance");
            (bool ok, ) = msg.sender.call{value: bal}("");
            require(ok, "Transfer failed");
        } else {
            uint256 bal = IERC20(token).balanceOf(address(this));
            require(bal > 0, "No balance");
            IERC20(token).safeTransfer(msg.sender, bal);
        }
    }

    /// @dev Allows the factory to receive native currency (BNB/ETH) for fee payments and refunds.
    receive() external payable {}
}
