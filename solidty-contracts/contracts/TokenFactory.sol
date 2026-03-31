// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";

import "./TokenImplementations.sol";

// =============================================================
// LAUNCHPAD INTERFACE (minimal, for fee queries)
// =============================================================

interface ILaunchpadFee {
    function launchFee() external view returns (uint256);
}

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
// TOKEN FACTORY
// =============================================================

/// @title TokenFactory
/// @notice Creates ERC20 tokens via EIP-1167 minimal proxies (Clones) with built-in
///         fee management, referral system, payment token support, and daily statistics.
contract TokenFactory is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // =============================================================
    // CUSTOM ERRORS
    // =============================================================

    error InvalidAddress();
    error InvalidTokenType();
    error UnsupportedPaymentToken();
    error ImplementationNotSet();
    error InsufficientPayment();
    error CannotDetermineFee();
    error RefundFailed();
    error TransferFailed();
    error CircularReferral();
    error NoRewards();
    error NoBalance();
    error InvalidParams();
    error AlreadySupported();
    error NotSupported();
    error MaxLevelsExceeded();
    error TotalExceedsMax();
    error NotFactoryToken();
    error NotAuthorizedRouter();

    // =============================================================
    // STRUCTS
    // =============================================================

    /// @notice Metadata stored for each created token.
    struct TokenInfo {
        address creator;
        bool isMintable;
        bool isTaxable;
        bool isPartnership;
    }

    /// @notice Parameters for creating a new token.
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

    /// @notice Daily statistics snapshot.
    struct DayStats {
        uint256 basic;
        uint256 mintable;
        uint256 taxable;
        uint256 taxMintable;
        uint256 partner;
        uint256 partnerMint;
        uint256 partnerTax;
        uint256 partnerTaxMint;
        uint256 totalTokens;
        uint256 totalFeeUsdt;
    }

    // =============================================================
    // EVENTS
    // =============================================================

    event TokenCreated(
        address indexed creator,
        address indexed tokenAddress,
        uint8 tokenType,
        string name,
        string symbol,
        uint256 totalSupply,
        uint8 decimals
    );
    event ImplementationUpdated(uint8 indexed tokenType, address impl);
    event TaxProcessed(address indexed token, uint256 amountIn, uint256 amountOut);
    event ConvertTaxToStableUpdated(bool enabled);
    event TaxProcessFailed(address indexed token, uint256 amount);
    event PaymentTokenAdded(address indexed token);
    event PaymentTokenRemoved(address indexed token);
    event ReferralRecorded(address indexed creator, address indexed referrer);
    event ReferralRewardDistributed(address indexed referrer, address paymentToken, uint256 amount, uint8 level);
    event ReferralRewardClaimed(address indexed user, address paymentToken, uint256 amount);

    // =============================================================
    // STATE VARIABLES
    // =============================================================

    /// @notice The DEX router used for fee conversion and tax processing swaps.
    IUniswapV2Router02 public dexRouter;

    /// @notice The stablecoin address (e.g., USDT) used as the base fee denomination.
    address public usdt;

    /// @notice Implementation contract address for each token type (indexed by type key 0-7).
    mapping(uint8 => address) public implementations;

    /// @notice Creation fee in USDT for each token type (indexed by type key 0-7).
    mapping(uint8 => uint256) public creationFee;

    /// @dev List of supported payment tokens. address(0) represents native currency.
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

    /// @notice When true, `processTax` will swap accumulated tax tokens to USDT.
    bool public convertTaxToStable;

    /// @notice Slippage tolerance for tax swaps in basis points (default 500 = 5%).
    uint256 public taxSlippageBps = 500;

    // =============================================================
    // REFERRAL STATE
    // =============================================================

    /// @notice Maps a user to their referrer.
    mapping(address => address) public referrals;

    /// @notice Number of referral levels to walk up the chain (default 3, max 10).
    uint8 public referralLevels = 3;

    /// @notice When true, referral rewards are sent immediately on token creation.
    bool public autoDistributeReward = true;

    /// @notice Reward percentage per referral level in basis points.
    uint256[] public referralPercents;

    /// @notice Number of direct referrals per referrer.
    mapping(address => uint256) public totalReferred;

    /// @notice Total rewards earned per referrer per payment token.
    mapping(address => mapping(address => uint256)) public totalEarned;

    /// @notice Claimable reward balance per user per payment token.
    mapping(address => mapping(address => uint256)) public pendingRewards;

    /// @notice Sum of all pending rewards across all users, per payment token.
    mapping(address => uint256) public totalPendingRewards;

    // =============================================================
    // DAILY STATS
    // =============================================================

    /// @notice Daily statistics keyed by day number (block.timestamp / 1 days).
    mapping(uint256 => DayStats) public dailyStats;

    /// @notice Cumulative fees earned in USDT-equivalent across all time.
    uint256 public totalFeeEarnedUsdt;

    // =============================================================
    // AUTHORIZED ROUTER
    // =============================================================

    /// @notice The PlatformRouter address authorized to call routerCreateToken.
    address public authorizedRouter;

    // =============================================================
    // CONSTRUCTOR
    // =============================================================

    /// @param usdt_ The stablecoin address used for fee denomination
    /// @param dexRouter_ The Uniswap V2-compatible router address
    constructor(
        address usdt_,
        address dexRouter_
    ) Ownable(msg.sender) {
        if (usdt_ == address(0)) revert InvalidAddress();
        if (dexRouter_ == address(0)) revert InvalidAddress();

        usdt = usdt_;
        dexRouter = IUniswapV2Router02(dexRouter_);

        uint8 _usdtDecimals = ERC20(usdt_).decimals();

        // Default fees in USDT
        creationFee[0] = 10 * 10 ** _usdtDecimals; // basic
        creationFee[1] = 20 * 10 ** _usdtDecimals; // mintable
        creationFee[2] = 25 * 10 ** _usdtDecimals; // taxable
        creationFee[3] = 35 * 10 ** _usdtDecimals; // taxable+mintable
        creationFee[4] = 15 * 10 ** _usdtDecimals; // partner
        creationFee[5] = 25 * 10 ** _usdtDecimals; // partner+mintable
        creationFee[6] = 30 * 10 ** _usdtDecimals; // partner+taxable
        creationFee[7] = 40 * 10 ** _usdtDecimals; // partner+taxable+mintable

        // Auto-add USDT and native as supported payment
        _addPaymentToken(usdt_);
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
    ///      partner=4, taxable=2, mintable=1
    function _tokenTypeKey(bool isTaxable, bool isMintable, bool isPartner)
        internal pure returns (uint8)
    {
        return uint8((isPartner ? 4 : 0) | (isTaxable ? 2 : 0) | (isMintable ? 1 : 0));
    }

    /// @dev Converts a USDT-denominated fee amount to an equivalent amount of `paymentToken`.
    ///      Tries direct path first, then falls back to WETH path.
    function _convertFee(uint256 usdtAmount, address paymentToken)
        internal view returns (uint256)
    {
        if (usdtAmount == 0) return 0;
        if (paymentToken == usdt) return usdtAmount;

        address tokenIn = paymentToken == address(0)
            ? dexRouter.WETH()
            : paymentToken;

        // Try direct path: paymentToken → USDT
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = usdt;

        try dexRouter.getAmountsIn(usdtAmount, path) returns (uint256[] memory amounts) {
            return amounts[0];
        } catch {}

        // Fallback: paymentToken → WETH → USDT
        address weth = dexRouter.WETH();
        if (tokenIn != weth) {
            address[] memory wethPath = new address[](3);
            wethPath[0] = tokenIn;
            wethPath[1] = weth;
            wethPath[2] = usdt;

            try dexRouter.getAmountsIn(usdtAmount, wethPath) returns (uint256[] memory amounts) {
                return amounts[0];
            } catch {}
        }

        return 0;
    }

    /// @dev Collects the creation fee from `payer` in the specified `paymentToken`.
    ///      For native payments, refunds excess unless `skipRefund` is true.
    function _collectFee(
        address,           // payer — unused after msg.sender refactor, kept for call-site readability
        address paymentToken,
        uint256 baseFeeUsdt,
        bool skipRefund
    ) internal returns (uint256 amount) {
        if (baseFeeUsdt == 0) return 0;

        if (!isPaymentSupported[paymentToken]) revert UnsupportedPaymentToken();

        amount = _convertFee(baseFeeUsdt, paymentToken);
        if (amount == 0) revert CannotDetermineFee();

        if (paymentToken == address(0)) {
            if (msg.value < amount) revert InsufficientPayment();
            if (!skipRefund) {
                uint256 excess = msg.value - amount;
                if (excess > 0) {
                    (bool ok, ) = msg.sender.call{value: excess}("");
                    if (!ok) revert RefundFailed();
                }
            }
        } else {
            // Always pull from msg.sender (not payer) so router flow works:
            // normal createToken: msg.sender == payer (creator)
            // routerCreateToken: msg.sender == router (which pre-pulled from user)
            IERC20(paymentToken).safeTransferFrom(msg.sender, address(this), amount);
        }
    }

    /// @dev Creates DEX pairs for the token against all supported quote tokens and
    ///      registers them on the token via `setupPools`.
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

    /// @dev Processes the referral chain: records the referral relationship, then walks up
    ///      the chain distributing rewards at each level.
    function _processReferral(
        address creator,
        address referral,
        address paymentToken,
        uint256 feeAmount
    ) internal {
        if (referral == address(0) || referral == creator) return;

        // Walk the referral chain to detect cycles of any length
        address current = referral;
        for (uint8 j = 0; j < referralLevels; j++) {
            if (current == address(0)) break;
            if (current == creator) revert CircularReferral();
            current = referrals[current];
        }

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
                        // Cap gas to 2300 (transfer-like) to prevent reentrancy and gas griefing
                        (bool ok, ) = ref.call{value: reward, gas: 2300}("");
                        if (!ok) {
                            pendingRewards[ref][paymentToken] += reward;
                            totalPendingRewards[paymentToken] += reward;
                        }
                    } else {
                        IERC20(paymentToken).safeTransfer(ref, reward);
                    }
                } else {
                    pendingRewards[ref][paymentToken] += reward;
                    totalPendingRewards[paymentToken] += reward;
                }

                totalEarned[ref][paymentToken] += reward;
                emit ReferralRewardDistributed(ref, paymentToken, reward, i);
            }

            ref = referrals[ref];
            unchecked { ++i; }
        }
    }

    /// @dev Initializes a cloned token, sets up pools (if applicable), records metadata,
    ///      and emits the TokenCreated event.
    /// @param mintTo The address that receives the minted supply (usually creator, but
    ///        address(this) for routerCreateToken so factory holds tokens temporarily).
    function _initAndRecord(
        CreateTokenParams calldata p,
        address creator,
        address mintTo,
        address tokenAddress,
        uint8 typeKey
    ) internal {
        uint256 supply = p.totalSupply * 10 ** p.decimals;

        if (p.isPartner || p.isTaxable) {
            IPoolManagedToken(tokenAddress).initialize(
                p.name, p.symbol, supply, p.decimals, mintTo, address(this)
            );
            _setupPools(tokenAddress);
        } else {
            IToken(tokenAddress).initialize(
                p.name, p.symbol, supply, p.decimals, mintTo, address(this)
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

    /// @dev Generates a deterministic salt from the creator address and their nonce.
    function _computeSalt(address creator) internal returns (bytes32) {
        uint256 nonce = creatorNonce[creator]++;
        return keccak256(abi.encodePacked(creator, nonce));
    }

    /// @dev Records daily stats and cumulative USDT fee total.
    function _recordStats(uint8 typeKey, address paymentToken, uint256 feeAmount) internal {
        uint256 day = block.timestamp / 1 days;
        DayStats storage ds = dailyStats[day];

        if (typeKey == 0) ds.basic++;
        else if (typeKey == 1) ds.mintable++;
        else if (typeKey == 2) ds.taxable++;
        else if (typeKey == 3) ds.taxMintable++;
        else if (typeKey == 4) ds.partner++;
        else if (typeKey == 5) ds.partnerMint++;
        else if (typeKey == 6) ds.partnerTax++;
        else if (typeKey == 7) ds.partnerTaxMint++;

        ds.totalTokens++;

        // Convert fee to USDT equivalent for stats
        uint256 feeUsdt;
        if (paymentToken == usdt) {
            feeUsdt = feeAmount;
        } else if (feeAmount > 0) {
            address tokenIn = paymentToken == address(0)
                ? dexRouter.WETH()
                : paymentToken;

            address[] memory path = new address[](2);
            path[0] = tokenIn;
            path[1] = usdt;

            try dexRouter.getAmountsOut(feeAmount, path) returns (uint256[] memory amounts) {
                feeUsdt = amounts[amounts.length - 1];
            } catch {
                // Fallback via WETH
                address weth = dexRouter.WETH();
                if (tokenIn != weth) {
                    address[] memory wethPath = new address[](3);
                    wethPath[0] = tokenIn;
                    wethPath[1] = weth;
                    wethPath[2] = usdt;
                    try dexRouter.getAmountsOut(feeAmount, wethPath) returns (uint256[] memory amounts) {
                        feeUsdt = amounts[amounts.length - 1];
                    } catch {}
                }
            }
        }

        ds.totalFeeUsdt += feeUsdt;
        totalFeeEarnedUsdt += feeUsdt;
    }

    // =============================================================
    // TOKEN CREATION
    // =============================================================

    /// @notice Creates a new token by cloning the appropriate implementation.
    /// @param p Token creation parameters
    /// @param referral The address that referred this creator (address(0) if none)
    /// @return tokenAddress The address of the newly created token clone
    function createToken(CreateTokenParams calldata p, address referral)
        external payable nonReentrant returns (address tokenAddress)
    {
        if (p.totalSupply == 0 || p.totalSupply > 1e30 || p.decimals > 18
            || bytes(p.name).length == 0 || bytes(p.symbol).length == 0)
            revert InvalidParams();

        uint8 typeKey = _tokenTypeKey(p.isTaxable, p.isMintable, p.isPartner);
        address impl = implementations[typeKey];
        if (impl == address(0)) revert ImplementationNotSet();

        uint256 feeAmount = _collectFee(msg.sender, p.paymentToken, creationFee[typeKey], false);
        _processReferral(msg.sender, referral, p.paymentToken, feeAmount);
        _recordStats(typeKey, p.paymentToken, feeAmount);

        bytes32 salt = _computeSalt(msg.sender);
        tokenAddress = Clones.cloneDeterministic(impl, salt);
        _initAndRecord(p, msg.sender, msg.sender, tokenAddress, typeKey);

        return tokenAddress;
    }

    /// @notice Creates a token on behalf of another address. Only callable by the factory owner.
    /// @param creator The address that will own the token and pay the creation fee
    /// @param p Token creation parameters
    /// @param referral The address that referred the creator (address(0) if none)
    /// @return tokenAddress The address of the newly created token clone
    function ownerCreateToken(address creator, CreateTokenParams calldata p, address referral)
        external payable onlyOwner nonReentrant returns (address tokenAddress)
    {
        if (creator == address(0)) revert InvalidAddress();
        if (p.totalSupply == 0 || p.totalSupply > 1e30 || p.decimals > 18
            || bytes(p.name).length == 0 || bytes(p.symbol).length == 0)
            revert InvalidParams();

        uint8 typeKey = _tokenTypeKey(p.isTaxable, p.isMintable, p.isPartner);
        address impl = implementations[typeKey];
        if (impl == address(0)) revert ImplementationNotSet();

        uint256 feeAmount = _collectFee(creator, p.paymentToken, creationFee[typeKey], false);
        _processReferral(creator, referral, p.paymentToken, feeAmount);
        _recordStats(typeKey, p.paymentToken, feeAmount);

        bytes32 salt = _computeSalt(creator);
        tokenAddress = Clones.cloneDeterministic(impl, salt);
        _initAndRecord(p, creator, creator, tokenAddress, typeKey);

        return tokenAddress;
    }

    /// @notice Creates a token on behalf of a user, called by the authorized PlatformRouter.
    /// @dev Tokens are minted to address(this) so the router can distribute them (e.g., to a launch).
    ///      skipRefund=true for fee collection since the router manages the combined native payment.
    /// @param creator The real user who is creating the token
    /// @param p Token creation parameters
    /// @param referral The address that referred the creator (address(0) if none)
    /// @return tokenAddress The address of the newly created token clone
    function routerCreateToken(address creator, CreateTokenParams calldata p, address referral)
        external payable nonReentrant returns (address tokenAddress)
    {
        if (msg.sender != authorizedRouter) revert NotAuthorizedRouter();
        if (creator == address(0)) revert InvalidAddress();
        if (p.totalSupply == 0 || p.totalSupply > 1e30 || p.decimals > 18
            || bytes(p.name).length == 0 || bytes(p.symbol).length == 0)
            revert InvalidParams();

        uint8 typeKey = _tokenTypeKey(p.isTaxable, p.isMintable, p.isPartner);
        address impl = implementations[typeKey];
        if (impl == address(0)) revert ImplementationNotSet();

        // skipRefund=false: excess native is refunded to msg.sender (the router),
        // which then forwards the remaining balance to the launchpad factory.
        uint256 feeAmount = _collectFee(creator, p.paymentToken, creationFee[typeKey], false);
        _processReferral(creator, referral, p.paymentToken, feeAmount);
        _recordStats(typeKey, p.paymentToken, feeAmount);

        bytes32 salt = _computeSalt(creator);
        tokenAddress = Clones.cloneDeterministic(impl, salt);

        // Mint tokens to address(this) so factory holds supply temporarily.
        _initAndRecord(p, creator, address(this), tokenAddress, typeKey);

        // Transfer all minted tokens to the router so it can distribute them
        // (to launch instance, to creator, etc.)
        uint256 tokenBalance = IERC20(tokenAddress).balanceOf(address(this));
        IERC20(tokenAddress).safeTransfer(msg.sender, tokenBalance);

        // Transfer token ownership to the router so it can configure protections,
        // enable trading, and then transfer ownership to the real creator.
        IOwnableToken(tokenAddress).transferOwnership(msg.sender);

        return tokenAddress;
    }

    // =============================================================
    // TAX PROCESSING
    // =============================================================

    /// @notice Converts accumulated tax tokens held by the factory to USDT via the best DEX route.
    /// @dev Callable by the factory owner or by a registered token itself (during _update callbacks).
    /// @param token The ERC20 token address to swap for USDT
    function processTax(address token) external {
        if (msg.sender != owner()
            && !(msg.sender == token && tokenInfo[token].creator != address(0)))
            revert NotFactoryToken();

        if (!convertTaxToStable) return;
        if (token == usdt) return;

        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance == 0) return;

        address weth = dexRouter.WETH();

        // Route 1: token -> USDT (direct)
        address[] memory directPath = new address[](2);
        directPath[0] = token;
        directPath[1] = usdt;

        // Route 2: token -> WETH -> USDT
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

        if (directOut == 0 && wethOut == 0) return;

        bool isDirect = directOut >= wethOut;
        address[] memory bestPath = isDirect ? directPath : wethPath;
        uint256 expectedOut = isDirect ? directOut : wethOut;

        uint256 amountOutMin = (expectedOut * (10000 - taxSlippageBps)) / 10000;

        IERC20(token).forceApprove(address(dexRouter), balance);

        try dexRouter.swapExactTokensForTokens(
            balance,
            amountOutMin,
            bestPath,
            address(this),
            block.timestamp
        ) returns (uint256[] memory amounts) {
            emit TaxProcessed(token, balance, amounts[amounts.length - 1]);
        } catch {
            emit TaxProcessFailed(token, balance);
        }
    }

    // =============================================================
    // REFERRAL CLAIMS
    // =============================================================

    /// @notice Claims accumulated referral rewards for a specific payment token.
    /// @param paymentToken The payment token to claim (address(0) for native)
    function claimReward(address paymentToken) external nonReentrant {
        uint256 amount = pendingRewards[msg.sender][paymentToken];
        if (amount == 0) revert NoRewards();

        pendingRewards[msg.sender][paymentToken] = 0;
        totalPendingRewards[paymentToken] -= amount;

        if (paymentToken == address(0)) {
            (bool ok, ) = msg.sender.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            IERC20(paymentToken).safeTransfer(msg.sender, amount);
        }

        emit ReferralRewardClaimed(msg.sender, paymentToken, amount);
    }

    // =============================================================
    // VIEW FUNCTIONS
    // =============================================================

    /// @notice Returns all token addresses created by a specific creator.
    function getCreatedTokens(address creator) external view returns (address[] memory) {
        return createdTokens[creator];
    }

    /// @notice Returns all supported payment token addresses.
    function getSupportedPaymentTokens() external view returns (address[] memory) {
        return _supportedTokens;
    }

    /// @notice Public wrapper around _convertFee for external queries (e.g., PlatformLens).
    function convertFee(uint256 usdtAmount, address paymentToken) external view returns (uint256) {
        return _convertFee(usdtAmount, paymentToken);
    }

    /// @notice Aggregated referral stats for a referrer across multiple payment tokens.
    function getReferralStats(
        address referrer,
        address[] calldata paymentTokens
    ) external view returns (
        uint256 referred,
        uint256[] memory earned,
        uint256[] memory pending
    ) {
        referred = totalReferred[referrer];
        earned = new uint256[](paymentTokens.length);
        pending = new uint256[](paymentTokens.length);
        for (uint256 i = 0; i < paymentTokens.length; i++) {
            earned[i] = totalEarned[referrer][paymentTokens[i]];
            pending[i] = pendingRewards[referrer][paymentTokens[i]];
        }
    }

    /// @notice Walks the referral chain upward from a user, up to referralLevels deep.
    function getReferralChain(address user) external view returns (address[] memory chain) {
        address[] memory temp = new address[](referralLevels);
        uint256 length = 0;
        address current = user;
        for (uint8 i = 0; i < referralLevels; i++) {
            address referrer = referrals[current];
            if (referrer == address(0)) break;
            temp[length++] = referrer;
            current = referrer;
        }
        chain = new address[](length);
        for (uint256 i = 0; i < length; i++) {
            chain[i] = temp[i];
        }
    }

    /// @notice Returns all referral level percentages as an array.
    function getReferralPercents() external view returns (uint256[] memory percents) {
        percents = new uint256[](referralLevels);
        for (uint256 i = 0; i < referralLevels; i++) {
            percents[i] = referralPercents[i];
        }
    }

    /// @notice Returns creation fees (and optionally launchpad fees) for all supported payment tokens in one call.
    /// @param isTaxable Whether the token is taxable
    /// @param isMintable Whether the token is mintable
    /// @param isPartner Whether the token is a partner token
    /// @param launchpadFactory Address of LaunchpadFactory (address(0) to skip launchpad fees)
    /// @return paymentTokens Array of supported payment token addresses
    /// @return creationFees Array of creation fees denominated in each payment token
    /// @return launchFees Array of launchpad fees denominated in each payment token (all zeros if launchpadFactory is address(0))
    function getCreationFees(
        bool isTaxable,
        bool isMintable,
        bool isPartner,
        address launchpadFactory
    ) external view returns (
        address[] memory paymentTokens,
        uint256[] memory creationFees,
        uint256[] memory launchFees
    ) {
        uint8 typeKey = _tokenTypeKey(isTaxable, isMintable, isPartner);
        uint256 usdtFee = creationFee[typeKey];
        uint256 len = _supportedTokens.length;

        paymentTokens = new address[](len);
        creationFees = new uint256[](len);
        launchFees = new uint256[](len);

        // Fetch launchpad fee in USDT if address provided
        uint256 lpFeeUsdt = 0;
        if (launchpadFactory != address(0)) {
            try ILaunchpadFee(launchpadFactory).launchFee() returns (uint256 f) {
                lpFeeUsdt = f;
            } catch {}
        }

        for (uint256 i = 0; i < len; i++) {
            paymentTokens[i] = _supportedTokens[i];
            creationFees[i] = _convertFee(usdtFee, _supportedTokens[i]);
            if (lpFeeUsdt > 0) {
                launchFees[i] = _convertFee(lpFeeUsdt, _supportedTokens[i]);
            }
        }
    }

    /// @notice Predicts the address of the next token that would be created by `creator`.
    function predictTokenAddress(
        address creator,
        bool isTaxable,
        bool isMintable,
        bool isPartner
    ) external view returns (address predicted) {
        uint8 typeKey = _tokenTypeKey(isTaxable, isMintable, isPartner);
        address impl = implementations[typeKey];
        if (impl == address(0)) revert ImplementationNotSet();

        bytes32 salt = keccak256(abi.encodePacked(creator, creatorNonce[creator]));
        predicted = Clones.predictDeterministicAddress(impl, salt, address(this));
    }

    // =============================================================
    // ADMIN FUNCTIONS
    // =============================================================

    /// @notice Sets the implementation contract address for a token type.
    function setImplementation(uint8 tokenType, address impl) external onlyOwner {
        if (tokenType > 7) revert InvalidTokenType();
        if (impl == address(0)) revert InvalidAddress();
        implementations[tokenType] = impl;
        emit ImplementationUpdated(tokenType, impl);
    }

    /// @notice Updates the USDT-denominated creation fee for a token type.
    function setCreationFee(uint8 tokenType, uint256 fee) external onlyOwner {
        if (tokenType > 7) revert InvalidTokenType();
        creationFee[tokenType] = fee;
    }

    /// @notice Toggles whether `processTax` converts accumulated tokens to USDT.
    function setConvertTaxToStable(bool _enabled) external onlyOwner {
        convertTaxToStable = _enabled;
        emit ConvertTaxToStableUpdated(_enabled);
    }

    /// @notice Updates the slippage tolerance for tax swaps.
    function setTaxSlippage(uint256 _bps) external onlyOwner {
        if (_bps > 5000) revert TotalExceedsMax();
        taxSlippageBps = _bps;
    }

    /// @notice Updates the DEX router.
    function setDexRouter(address _dexRouter) external onlyOwner {
        if (_dexRouter == address(0)) revert InvalidAddress();
        dexRouter = IUniswapV2Router02(_dexRouter);
    }

    /// @notice Updates the USDT address.
    function setUsdt(address _usdt) external onlyOwner {
        if (_usdt == address(0)) revert InvalidAddress();
        usdt = _usdt;
    }

    /// @notice Adds a new accepted payment token.
    function addPaymentToken(address token) external onlyOwner {
        if (isPaymentSupported[token]) revert AlreadySupported();
        _addPaymentToken(token);
    }

    /// @notice Removes a payment token from the accepted list.
    function removePaymentToken(address token) external onlyOwner {
        if (!isPaymentSupported[token]) revert NotSupported();
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

    /// @notice Sets the number of referral levels.
    function setReferralLevels(uint8 _levels) external onlyOwner {
        if (_levels > 10) revert MaxLevelsExceeded();
        referralLevels = _levels;
    }

    /// @notice Sets the referral reward percentages per level in basis points.
    function setReferralPercents(uint256[] calldata _percents) external onlyOwner {
        uint256 total;
        for (uint256 i; i < _percents.length;) {
            total += _percents[i];
            unchecked { ++i; }
        }
        if (total > 5000) revert TotalExceedsMax();

        delete referralPercents;
        for (uint256 i; i < _percents.length;) {
            referralPercents.push(_percents[i]);
            unchecked { ++i; }
        }
    }

    /// @notice Toggles whether referral rewards are sent immediately or accumulated.
    function setAutoDistributeReward(bool _enabled) external onlyOwner {
        autoDistributeReward = _enabled;
    }

    /// @notice Withdraws accumulated fees minus reserved referral rewards.
    /// @param token The token address to withdraw, or address(0) for native
    function withdrawFees(address token) external onlyOwner {
        if (token == address(0)) {
            uint256 bal = address(this).balance;
            uint256 reserved = totalPendingRewards[address(0)];
            uint256 withdrawable = bal > reserved ? bal - reserved : 0;
            if (withdrawable == 0) revert NoBalance();
            (bool ok, ) = msg.sender.call{value: withdrawable}("");
            if (!ok) revert TransferFailed();
        } else {
            uint256 bal = IERC20(token).balanceOf(address(this));
            uint256 reserved = totalPendingRewards[token];
            uint256 withdrawable = bal > reserved ? bal - reserved : 0;
            if (withdrawable == 0) revert NoBalance();
            IERC20(token).safeTransfer(msg.sender, withdrawable);
        }
    }

    /// @notice Sets the authorized PlatformRouter address.
    function setAuthorizedRouter(address _router) external onlyOwner {
        authorizedRouter = _router;
    }

    // =============================================================
    // PROTECTION OVERRIDES (factory owner can relax token protections)
    // =============================================================

    /// @notice Force-removes an address from a token's blacklist.
    function forceUnblacklist(address token, address account) external onlyOwner {
        if (tokenInfo[token].creator == address(0)) revert NotFactoryToken();
        BasicTokenImpl(token).forceUnblacklist(account);
    }

    /// @notice Force-increases or disables a token's max wallet limit.
    function forceRelaxMaxWallet(address token, uint256 amount) external onlyOwner {
        if (tokenInfo[token].creator == address(0)) revert NotFactoryToken();
        BasicTokenImpl(token).forceRelaxMaxWallet(amount);
    }

    /// @notice Force-increases or disables a token's max transaction limit.
    function forceRelaxMaxTransaction(address token, uint256 amount) external onlyOwner {
        if (tokenInfo[token].creator == address(0)) revert NotFactoryToken();
        BasicTokenImpl(token).forceRelaxMaxTransaction(amount);
    }

    /// @notice Force-reduces or disables a token's cooldown.
    function forceRelaxCooldown(address token, uint256 _seconds) external onlyOwner {
        if (tokenInfo[token].creator == address(0)) revert NotFactoryToken();
        BasicTokenImpl(token).forceRelaxCooldown(_seconds);
    }

    /// @notice Force-disables a token's blacklist entirely.
    function forceDisableBlacklist(address token) external onlyOwner {
        if (tokenInfo[token].creator == address(0)) revert NotFactoryToken();
        BasicTokenImpl(token).forceDisableBlacklist();
    }

    // =============================================================
    // RECEIVE
    // =============================================================

    /// @dev Allows the factory to receive native currency for fee payments and refunds.
    receive() external payable {}
}
