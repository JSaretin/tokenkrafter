// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./shared/DexInterfaces.sol";

// =============================================================
// LAUNCHPAD FACTORY INTERFACE (minimal — avoids circular import)
// =============================================================

interface ILaunchpadFactory {
    function platformWallet() external view returns (address);
    function affiliate() external view returns (address);
    function globalPause() external view returns (bool);
    function recordGraduation(address launch_) external;
    function clearTokenLaunch(address token_) external;
}

interface IAffiliateReporter {
    function report(address user, address ref, uint256 platformFee) external;
}

interface ILaunchToken {
    function enableTrading(uint256 delay) external;
    function isAuthorizedLauncher(address) external view returns (bool);
    function isExcludedFromLimits(address) external view returns (bool);
    function isTaxFree(address) external view returns (bool);
    function unlockTaxCeiling() external;
}

// =============================================================
// BONDING CURVE LIBRARY
// =============================================================

/// @title BondingCurve
/// @notice Pure math for four bonding curve types. Returns cost in base coin (wei)
///         to purchase `amount` tokens from current `supply`. 1e18 precision.
///         Deployed as an external library to reduce consumer contract size.
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
    ///         Approximated via Simpson's rule (3 points) for better accuracy than trapezoidal.
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
    ///         Uses Simpson's rule (3 points) for better accuracy than trapezoidal.
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

    /// @dev 6th-order Taylor series for e^(kx): 1 + x + x²/2 + x³/6 + x⁴/24 + x⁵/120 + x⁶/720
    ///      Accurate to <1% error for kx up to ~7 (e^7 ≈ 1097). Previous 2nd-order had 8x error at kx=5.
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

// =============================================================
// DEX INTERFACES
// =============================================================

// DEX interfaces (IUniswapV2Router02, IUniswapV2Factory, IUniswapV2Pair,
// IWETH) come from shared/DexInterfaces.sol.

// =============================================================
// LAUNCH INSTANCE
// =============================================================

/// @title LaunchInstance
/// @notice Bonding curve launch for a token created by TokenKrafter's TokenFactory.
///         Creator deposits tokens from their existing token. Buy-only curve, then
///         graduates to DEX with auto LP + burn.
contract LaunchInstance is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Custom Errors ───────────────────────────────────────────
    error NotActive();
    error NotCreator();
    error InvalidToken();
    error InvalidUsdt();
    error InvalidCaps();
    error InvalidDuration();
    error InvalidMaxBuy();
    error InvalidCreatorAlloc();
    error InvalidVesting();
    error CreatorAllocRequiresVesting();
    error NotPending();
    error ZeroAmount();
    error InsufficientTokenBalance();
    error OnlyFactory();
    error NothingDeposited();
    error SendNativeCoin();
    error LaunchExpired();
    error AmountTooSmall();
    error ExceedsMaxBuy();
    error SoftCapNotReached();
    error OnlyCreatorCanGraduateEarly();
    error NotRefunding();
    error NothingToRefund();
    error ReturnTokensToRefund();
    error OutstandingRefundsRemain();
    error NoTokens();
    error NotGraduated();
    error NoAllocation();
    error CliffNotReached();
    error NothingToClaim();
    error NoETH();
    error TransferFailed();
    error InsufficientTokensOut();
    error LaunchNotStarted();
    error InvalidStartTimestamp();
    error InvalidPath();
    error PathMustEndAtUsdt();
    error StrandedSweepTooEarly();
    error LaunchPaused();
    error FeeOnTransferNotSupported();

    // ── Enums ──────────────────────────────────────────────────
    enum CurveType { Linear, SquareRoot, Quadratic, Exponential }
    enum LaunchState { Pending, Active, Graduated, Refunding }

    // ── Storage (set once via initialize, replaces immutables for clone pattern) ──
    bool private _initialized;
    address payable public factory;
    address public creator;
    IERC20 public token;
    CurveType public curveType;
    IUniswapV2Router02 public dexRouter;
    IERC20 public usdt;
    uint256 public baseScale;

    /// @notice Minimum USDT value (in USDT's native units) per buy. Set by
    ///         the creator at launch creation time. Anti-dust floor that
    ///         prevents flooding `_purchases` history with near-zero buys.
    ///         Denominated in the chain's USDT native units (6 on Ethereum,
    ///         18 on BSC-peg, etc.) — the frontend wizard converts the
    ///         creator's "$ minimum" input to the right unit count.
    uint256 public minBuyUsdt;

    uint256 public curveParam1;
    uint256 public curveParam2;

    uint256 public softCap;
    uint256 public hardCap;
    uint256 public durationSeconds;
    uint256 public deadline;
    uint256 public startTimestamp;
    uint256 public maxBuyPerWallet;

    // ── Creator vesting ────────────────────────────────────────
    uint256 public creatorAllocationBps;
    uint256 public vestingDuration;
    uint256 public vestingCliff;
    uint256 public creatorTotalTokens;
    uint256 public creatorClaimed;
    uint256 public graduationTimestamp;
    uint256 public refundStartTimestamp;

    /// @notice Anti-snipe window after graduation. `enableTrading(lockDurationAfterListing)`
    ///         is called atomically with DEX seeding so public trading only opens
    ///         `lockDurationAfterListing` seconds after graduation.
    uint256 public lockDurationAfterListing;

    // ── Token distribution ─────────────────────────────────────
    uint256 public tokensForCurve;
    uint256 public tokensForLP;
    uint256 public totalTokensRequired;

    // ── Platform fees ──────────────────────────────────────────
    uint256 public constant BUY_FEE_BPS = 100;          // 1% on every buy
    uint256 public constant GRADUATION_FEE_BPS = 100;   // 1% on graduation
    uint256 public constant BPS = 10000;

    /// @notice Emergency pause — factory-controlled per-launch circuit breaker.
    ///         When true, `buy()` and manual `graduate()` revert. Refunds
    ///         open even during Active state (emergency exit).
    bool public paused;

    // ── State ──────────────────────────────────────────────────
    LaunchState public state;
    uint256 public tokensSold;
    uint256 public totalBaseRaised;       // USDT raised (after buy fees)
    uint256 public totalBuyFeesCollected; // accumulated buy fees
    uint256 public totalTokensDeposited;

    mapping(address => uint256) public basePaid;      // net (after fee) — used for refunds + max buy check
    mapping(address => uint256) public grossPaid;     // gross (before fee) — what the user actually spent
    mapping(address => uint256) public tokensBought;

    // ── Purchase history (on-chain, enumerable) ───────────────
    struct Purchase {
        address buyer;
        uint256 baseAmount;      // USDT paid (after fee)
        uint256 tokensReceived;  // tokens received
        uint256 fee;             // buy fee taken
        uint256 price;           // price at time of purchase
        uint256 timestamp;       // block.timestamp
    }

    Purchase[] private _purchases;
    address[] private _buyers;                    // unique buyer list
    mapping(address => bool) private _isBuyer;    // dedup

    // ── Events ─────────────────────────────────────────────────
    // Enriched with cumulative state so a WS-subscribed indexer never needs
    // follow-up eth_calls to rebuild the current snapshot.
    event TokensDeposited(address indexed creator, uint256 amount, uint256 totalDeposited, uint256 totalRequired);
    event LaunchActivated(address indexed token, uint256 deadline, uint256 softCap, uint256 hardCap, uint256 tokensForCurve);
    event TokenBought(
        address indexed buyer, uint256 tokenAmount, uint256 basePaid, uint256 fee,
        uint256 newPrice, uint256 totalBaseRaised, uint256 totalTokensSold,
        uint256 remainingTokens, uint256 buyerCount
    );
    event Graduated(
        address indexed dexPair, uint256 baseToLP, uint256 tokensToLP,
        uint256 platformBaseFee, uint256 platformTokenFee,
        uint256 finalTotalRaised, uint256 finalTokensSold, uint256 totalBuyers
    );
    event Refunded(address indexed buyer, uint256 baseAmount, uint256 tokensReturned);
    event CreatorClaimed(address indexed creator, uint256 amount, uint256 totalClaimed, uint256 totalVested);
    event RefundingEnabled(address indexed token, uint256 totalRaised, uint256 softCap);
    event CreatorWithdraw(address indexed creator, uint256 tokenAmount);
    event CreatorReclaim(address indexed creator, uint256 tokenAmount);
    event PausedChanged(bool paused);

    // ── Modifiers ──────────────────────────────────────────────
    modifier onlyActive() {
        if (state != LaunchState.Active) revert NotActive();
        _;
    }

    modifier onlyCreator() {
        if (msg.sender != creator) revert NotCreator();
        _;
    }

    // ── Errors ──────────────────────────────────────────────────
    error AlreadyInitialized();
    error BelowMinBuy();
    error InvalidMinBuy();

    // ── Initialize (replaces constructor for clone pattern) ────
    /// @notice Called once by the factory immediately after cloning.
    ///         Sets all launch parameters. Cannot be called again.
    function initialize(
        address creator_,
        address token_,
        uint256 totalTokensForLaunch_,
        CurveType curveType_,
        uint256 curveParam1_,
        uint256 curveParam2_,
        uint256 softCap_,
        uint256 hardCap_,
        uint256 durationDays_,
        uint256 maxBuyBps_,
        uint256 creatorAllocationBps_,
        uint256 vestingDays_,
        address dexRouter_,
        address usdt_,
        uint256 startTimestamp_,
        uint256 lockDurationAfterListing_,
        uint256 minBuyUsdt_
    ) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;

        if (token_ == address(0)) revert InvalidToken();
        if (usdt_ == address(0)) revert InvalidUsdt();
        if (softCap_ == 0 || hardCap_ < softCap_) revert InvalidCaps();
        if (durationDays_ < 7 || durationDays_ > 90) revert InvalidDuration();
        if (maxBuyBps_ < 50 || maxBuyBps_ > 500) revert InvalidMaxBuy();
        if (creatorAllocationBps_ > 500) revert InvalidCreatorAlloc();
        if (vestingDays_ != 0 && vestingDays_ != 30 && vestingDays_ != 60 && vestingDays_ != 90) revert InvalidVesting();
        if (creatorAllocationBps_ != 0 && vestingDays_ == 0) revert CreatorAllocRequiresVesting();
        if (startTimestamp_ != 0 && startTimestamp_ <= block.timestamp) revert InvalidStartTimestamp();
        // Mirror the token's MAX_TRADING_DELAY cap (24 hours).
        if (lockDurationAfterListing_ > 24 hours) revert InvalidDuration();
        // minBuyUsdt must be > 0 (otherwise no anti-dust floor), <= softCap
        // (otherwise a single buy could skip past the soft cap with one tx,
        // and no realistic creator wants a minimum higher than their softCap),
        // and <= maxBuyPerWallet (otherwise the first buy instantly exceeds
        // the per-wallet cap and the launch is unreachable — nobody can buy).
        uint256 maxBuyPerWallet_ = (hardCap_ * maxBuyBps_) / BPS;
        if (minBuyUsdt_ == 0 || minBuyUsdt_ > softCap_ || minBuyUsdt_ > maxBuyPerWallet_) {
            revert InvalidMinBuy();
        }

        factory = payable(msg.sender);
        creator = creator_;
        token = IERC20(token_);
        usdt = IERC20(usdt_);
        uint8 usdtDec = IERC20Metadata(usdt_).decimals();
        baseScale = usdtDec < 18 ? 10 ** (18 - usdtDec) : 1;
        curveType = curveType_;
        curveParam1 = curveParam1_;
        curveParam2 = curveParam2_;
        softCap = softCap_;
        hardCap = hardCap_;
        durationSeconds = durationDays_ * 1 days;
        startTimestamp = startTimestamp_;
        dexRouter = IUniswapV2Router02(dexRouter_);

        uint256 curveTokens = (totalTokensForLaunch_ * 7000) / BPS;
        uint256 creatorTokens = (totalTokensForLaunch_ * creatorAllocationBps_) / BPS;
        uint256 lpTokens = totalTokensForLaunch_ - curveTokens - creatorTokens;

        tokensForCurve = curveTokens;
        tokensForLP = lpTokens;
        creatorTotalTokens = creatorTokens;
        creatorAllocationBps = creatorAllocationBps_;
        totalTokensRequired = totalTokensForLaunch_;

        maxBuyPerWallet = (hardCap_ * maxBuyBps_) / BPS;
        vestingDuration = vestingDays_ * 1 days;
        vestingCliff = vestingDays_ > 0 ? 7 days : 0;
        lockDurationAfterListing = lockDurationAfterListing_;
        minBuyUsdt = minBuyUsdt_;

        state = LaunchState.Pending;
    }

    // ── Deposit & Activate ─────────────────────────────────────

    /// @notice Creator deposits tokens to fund the launch. Once every
    ///         prerequisite is met the launch activates automatically;
    ///         otherwise the creator calls `activate()` once they're set.
    ///         Creator must approve this contract before calling.
    function depositTokens(uint256 amount) external onlyCreator {
        if (state != LaunchState.Pending) revert NotPending();
        if (amount == 0) revert ZeroAmount();

        uint256 remaining = totalTokensRequired - totalTokensDeposited;
        uint256 toDeposit = amount > remaining ? remaining : amount;

        // Reject fee-on-transfer tokens — any shortfall desyncs
        // totalTokensDeposited from actual balance, breaking buy distribution,
        // refunds, and LP seeding downstream.
        uint256 balBefore = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), toDeposit);
        uint256 received = token.balanceOf(address(this)) - balBefore;
        if (received != toDeposit) revert FeeOnTransferNotSupported();

        totalTokensDeposited += received;

        emit TokensDeposited(msg.sender, received, totalTokensDeposited, totalTokensRequired);

        _tryActivate();
    }

    /// @notice Returns whether the launch is ready to activate and, if not,
    ///         a short reason code. Frontend uses this to show a checklist
    ///         and guide the creator through the remaining steps. Every view
    ///         call is wrapped in try/catch so tokens that don't implement
    ///         a particular interface (e.g. plain ERC20s) silently pass that
    ///         check — the corresponding restriction doesn't exist for them.
    ///
    ///         Reason codes:
    ///           ""                       — ready
    ///           "NOT_PENDING"            — already active / graduated / refunding
    ///           "NOT_FUNDED"             — tokens still being deposited
    ///           "NOT_EXCLUDED_FROM_LIMITS" — token enforces trading/limits and launch is not exempt
    ///           "NOT_TAX_EXEMPT"         — taxable token and launch is not tax-free
    ///           "NOT_AUTHORIZED_LAUNCHER" — platform token and launch is not an authorized launcher
    function preflight() public view returns (bool ready, string memory reason) {
        if (state != LaunchState.Pending) return (false, "NOT_PENDING");
        if (totalTokensDeposited < totalTokensRequired) return (false, "NOT_FUNDED");

        // Exemption from trading-enabled gate, maxWallet, maxTx, cooldown,
        // pool-lock. Required so the launch can move tokens during curve
        // buys/refunds regardless of the token's global restrictions.
        try ILaunchToken(address(token)).isExcludedFromLimits(address(this)) returns (bool excluded) {
            if (!excluded) return (false, "NOT_EXCLUDED_FROM_LIMITS");
        } catch {}

        // Tax exemption so curve buys/refunds aren't taxed as DEX trades.
        try ILaunchToken(address(token)).isTaxFree(address(this)) returns (bool taxFree) {
            if (!taxFree) return (false, "NOT_TAX_EXEMPT");
        } catch {}

        // Authorized to call enableTrading(delay) on graduation. Only matters
        // for platform tokens with the pool-lock anti-snipe gate.
        try ILaunchToken(address(token)).isAuthorizedLauncher(address(this)) returns (bool authorized) {
            if (!authorized) return (false, "NOT_AUTHORIZED_LAUNCHER");
        } catch {}

        return (true, "");
    }

    /// @notice Manually activate the launch once every prerequisite is met.
    ///         Idempotent with the auto-activation path in `depositTokens`.
    function activate() external onlyCreator {
        if (state != LaunchState.Pending) revert NotPending();
        (bool ready, ) = preflight();
        require(ready, "Preflight failed");
        _activate();
    }

    /// @dev Non-reverting activation used by auto-paths. No-op if preflight fails.
    function _tryActivate() internal {
        (bool ready, ) = preflight();
        if (ready) _activate();
    }

    function _activate() internal {
        state = LaunchState.Active;
        uint256 start = startTimestamp > block.timestamp ? startTimestamp : block.timestamp;
        deadline = start + durationSeconds;
        emit LaunchActivated(address(token), deadline, softCap, hardCap, tokensForCurve);
    }

    /// @notice Factory-only emergency pause. When true, `buy()` and manual
    ///         `graduate()` revert. Refunds remain open so users can always
    ///         exit. Intended for post-deployment incident response.
    function setPaused(bool paused_) external {
        if (msg.sender != factory) revert OnlyFactory();
        paused = paused_;
        emit PausedChanged(paused_);
    }

    /// @notice Called by the factory after tokens have been transferred directly
    ///         to this contract (e.g. during one-click createTokenAndLaunch flow).
    ///         Only callable by the LaunchpadFactory that deployed this instance.
    function notifyDeposit(uint256 amount) external {
        if (msg.sender != factory) revert OnlyFactory();
        if (state != LaunchState.Pending) revert NotPending();
        if (amount == 0) revert ZeroAmount();

        totalTokensDeposited += amount;

        // Verify the contract actually holds enough tokens
        if (token.balanceOf(address(this)) < totalTokensDeposited) revert InsufficientTokenBalance();

        emit TokensDeposited(creator, amount, totalTokensDeposited, totalTokensRequired);

        _tryActivate();
    }

    /// @notice Creator can withdraw deposited tokens if launch is still pending
    ///         (not yet activated). Cancels the launch effectively.
    function withdrawPendingTokens() external onlyCreator {
        if (state != LaunchState.Pending) revert NotPending();
        uint256 deposited = totalTokensDeposited;
        if (deposited == 0) revert NothingDeposited();

        totalTokensDeposited = 0;
        token.safeTransfer(creator, deposited);

        emit CreatorWithdraw(creator, deposited);
    }

    // ── Buy ────────────────────────────────────────────────────

    /// @notice Unified buy entrypoint. One function handles every payment mode:
    ///           - Native coin:   path = [address(0), ..., USDT],  msg.value = amountIn
    ///           - USDT direct:   path = [USDT, USDT],             msg.value = 0
    ///           - Any ERC20:     path = [token, ..., USDT],       msg.value = 0
    ///
    ///         The frontend computes the best path off-chain using cached pool
    ///         reserves (see findBestRoute in tradeLens.ts) and passes it in.
    ///         This lets us pick multi-hop routes like [WBNB, USDC, USDT] when
    ///         they yield more than the hardcoded two-hop alternative, and
    ///         avoids routing through dust-liquidity pools.
    ///
    /// @param path         [paymentToken, ..., USDT] — last hop MUST be USDT.
    ///                     First element address(0) signals native payment.
    /// @param amountIn     Amount of path[0] to spend (must equal msg.value for native)
    /// @param minUsdtOut   Minimum USDT to receive from the swap (slippage protection)
    /// @param minTokensOut Minimum launch tokens to receive from the curve
    /// @notice Buy with no referrer. Delegates to {buy} with `ref = address(0)`.
    function buy(
        address[] calldata path,
        uint256 amountIn,
        uint256 minUsdtOut,
        uint256 minTokensOut
    ) external payable {
        // Forward to the referrer-aware variant. Solidity doesn't let us
        // call the overload on `this` without re-entering nonReentrant,
        // so we duplicate the entrypoint via a thin wrapper that delegates
        // by setting ref=address(0) inline. Cheaper than an external self-call.
        _buyWithRef(path, amountIn, minUsdtOut, minTokensOut, address(0));
    }

    /// @notice Buy with an attributed referrer. The referrer earns a share of
    ///         the buy fee via the platform Affiliate contract (sticky after
    ///         first non-zero `ref` ever supplied for `msg.sender`).
    function buy(
        address[] calldata path,
        uint256 amountIn,
        uint256 minUsdtOut,
        uint256 minTokensOut,
        address ref
    ) external payable {
        _buyWithRef(path, amountIn, minUsdtOut, minTokensOut, ref);
    }

    function _buyWithRef(
        address[] calldata path,
        uint256 amountIn,
        uint256 minUsdtOut,
        uint256 minTokensOut,
        address ref
    ) internal nonReentrant {
        if (paused || ILaunchpadFactory(factory).globalPause()) revert LaunchPaused();
        _autoResolve();
        if (state != LaunchState.Active) revert NotActive();
        if (amountIn == 0) revert ZeroAmount();
        if (path.length < 2) revert InvalidPath();
        if (path[path.length - 1] != address(usdt)) revert PathMustEndAtUsdt();
        if (startTimestamp > 0 && block.timestamp < startTimestamp) revert LaunchNotStarted();
        if (block.timestamp >= deadline) revert LaunchExpired();

        address paymentToken = path[0];
        uint256 usdtAmount;

        // Credit the on-chain USDT delta rather than the swap router's
        // reported output: if a non-canonical USDT ever taxes transfers,
        // the reported amounts[last] would over-credit the buyer.
        uint256 usdtBefore = IERC20(address(usdt)).balanceOf(address(this));

        if (paymentToken == address(0)) {
            // Native coin: msg.value must match amountIn exactly (no under/over pay).
            if (msg.value != amountIn) revert SendNativeCoin();

            // Rewrite the path's first entry to WETH for the swap call.
            address weth = dexRouter.WETH();
            address[] memory fullPath = new address[](path.length);
            fullPath[0] = weth;
            for (uint256 i = 1; i < path.length;) {
                fullPath[i] = path[i];
                unchecked { ++i; }
            }
            dexRouter.swapExactETHForTokens{value: amountIn}(
                minUsdtOut,
                fullPath,
                address(this),
                block.timestamp + 300
            );
            usdtAmount = IERC20(address(usdt)).balanceOf(address(this)) - usdtBefore;
        } else {
            // ERC20 payment: no native expected.
            if (msg.value != 0) revert SendNativeCoin();

            IERC20(paymentToken).safeTransferFrom(msg.sender, address(this), amountIn);

            if (paymentToken == address(usdt)) {
                // Caller paid in USDT — no swap needed, extra hops are ignored.
                usdtAmount = amountIn;
            } else {
                IERC20(paymentToken).forceApprove(address(dexRouter), amountIn);
                dexRouter.swapExactTokensForTokens(
                    amountIn,
                    minUsdtOut,
                    path,
                    address(this),
                    block.timestamp + 300
                );
                usdtAmount = IERC20(address(usdt)).balanceOf(address(this)) - usdtBefore;
            }
        }

        _processBuy(msg.sender, usdtAmount, minTokensOut, ref);
    }

    /// @dev Internal buy logic. All amounts are in USDT after conversion.
    ///      1% buy fee computed upfront but only charged on the actual amount
    ///      spent after curve-cap and max-buy capping. Excess is refunded.
    function _processBuy(address buyer, uint256 usdtAmount, uint256 minTokensOut, address ref) internal {
        // Anti-dust floor: reject buys below the creator-set minimum so an
        // attacker can't flood `_purchases` with near-zero entries.
        if (usdtAmount < minBuyUsdt) revert BelowMinBuy();

        // Compute fee on full amount, but we may adjust after capping
        uint256 buyFee = (usdtAmount * BUY_FEE_BPS) / BPS;
        uint256 baseForTokens = usdtAmount - buyFee;

        // Calculate tokens from curve
        uint256 tokensOut = _getTokensForBase(baseForTokens);
        if (tokensOut == 0) revert AmountTooSmall();

        // Cap to remaining curve tokens
        uint256 remaining = tokensForCurve - tokensSold;
        if (tokensOut > remaining) {
            tokensOut = remaining;
            baseForTokens = _getCostForTokens(tokensOut);
        }

        // Anti-whale: cap by USDT value (% of hard cap)
        if (basePaid[buyer] + baseForTokens > maxBuyPerWallet) {
            uint256 remaining_allowance = maxBuyPerWallet > basePaid[buyer]
                ? maxBuyPerWallet - basePaid[buyer]
                : 0;
            if (remaining_allowance == 0) revert ExceedsMaxBuy();

            tokensOut = _getTokensForBase(remaining_allowance);
            if (tokensOut == 0) revert ExceedsMaxBuy();
            baseForTokens = _getCostForTokens(tokensOut);
        }

        // Check minTokensOut AFTER all capping
        if (tokensOut < minTokensOut) revert InsufficientTokensOut();

        // Recompute fee on the ACTUAL amount spent, not the original input.
        // This ensures users only pay 1% on what they actually used.
        buyFee = (baseForTokens * BUY_FEE_BPS) / (BPS - BUY_FEE_BPS);
        uint256 totalSpent = baseForTokens + buyFee;
        // Refund any excess USDT
        if (usdtAmount > totalSpent) {
            usdt.safeTransfer(buyer, usdtAmount - totalSpent);
        }

        // Send fee to platform + affiliate
        totalBuyFeesCollected += buyFee;
        if (buyFee > 0) {
            address _platformWallet = ILaunchpadFactory(factory).platformWallet();
            address aff = ILaunchpadFactory(factory).affiliate();
            uint256 platformShare = buyFee;

            if (aff != address(0)) {
                if (usdt.allowance(address(this), aff) < buyFee) {
                    usdt.forceApprove(aff, type(uint256).max);
                }
                uint256 balBefore = usdt.balanceOf(address(this));
                try IAffiliateReporter(aff).report(buyer, ref, buyFee) {
                    uint256 pulled = balBefore - usdt.balanceOf(address(this));
                    if (pulled <= buyFee) platformShare = buyFee - pulled;
                } catch {}
            }

            if (platformShare > 0) usdt.safeTransfer(_platformWallet, platformShare);
        }

        // Update state
        tokensSold += tokensOut;
        totalBaseRaised += baseForTokens;
        basePaid[buyer] += baseForTokens;
        grossPaid[buyer] += totalSpent;
        tokensBought[buyer] += tokensOut;

        // Record purchase history
        uint256 currentPrice = getCurrentPrice();
        _purchases.push(Purchase({
            buyer: buyer,
            baseAmount: baseForTokens,
            tokensReceived: tokensOut,
            fee: buyFee,
            price: currentPrice,
            timestamp: block.timestamp
        }));
        if (!_isBuyer[buyer]) {
            _isBuyer[buyer] = true;
            _buyers.push(buyer);
        }

        // Transfer tokens to buyer — exact-delta check catches any
        // fee-on-transfer flipped on after deposit validation.
        _transferExact(buyer, tokensOut);

        emit TokenBought(
            buyer, tokensOut, baseForTokens, buyFee,
            currentPrice, totalBaseRaised, tokensSold,
            tokensForCurve - tokensSold, _buyers.length
        );

        // Auto-graduate on hard cap or curve sell-out
        if (totalBaseRaised >= hardCap || tokensSold >= tokensForCurve) {
            _graduate();
        }
    }

    /// @dev Transfer `amount` of the launch token to `to` and verify the
    ///      recipient's balance increased by exactly `amount`. Catches
    ///      fee-on-transfer or blacklist behavior enabled AFTER the
    ///      initial deposit check passed (token admin flipping a global
    ///      tax post-activation). Reverts so accounting stays consistent.
    function _transferExact(address to, uint256 amount) internal {
        if (amount == 0) return;
        uint256 before = token.balanceOf(to);
        token.safeTransfer(to, amount);
        uint256 received = token.balanceOf(to) - before;
        if (received != amount) revert FeeOnTransferNotSupported();
    }

    /// @dev transferFrom counterpart — pull `amount` into this contract
    ///      and verify exact receipt.
    function _transferFromExact(address from, uint256 amount) internal {
        if (amount == 0) return;
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - before;
        if (received != amount) revert FeeOnTransferNotSupported();
    }

    // ── Graduate ───────────────────────────────────────────────

    /// @notice Graduate to DEX. Creator can call after soft cap, or auto on hard cap / sell-out.
    ///         After deadline, anyone can trigger graduation if soft cap was met (prevents fund lock).
    function graduate() external nonReentrant onlyActive {
        if (paused || ILaunchpadFactory(factory).globalPause()) revert LaunchPaused();
        _autoResolve();
        if (state != LaunchState.Active) revert NotActive();
        if (totalBaseRaised < softCap) revert SoftCapNotReached();
        if (
            msg.sender != creator
                && totalBaseRaised < hardCap
                && tokensSold < tokensForCurve
                && block.timestamp < deadline
        ) revert OnlyCreatorCanGraduateEarly();
        _graduate();
    }

    function _graduate() internal {
        state = LaunchState.Graduated;
        graduationTimestamp = block.timestamp;

        address platformWallet = ILaunchpadFactory(factory).platformWallet();

        // Buy fees already sent to platform on each buy — no transfer needed here

        // Graduation fee: 1% of USDT raised
        uint256 platformBaseFee = (totalBaseRaised * GRADUATION_FEE_BPS) / BPS;
        uint256 usdtForLP = totalBaseRaised - platformBaseFee;

        // Seed LP at the current curve price so DEX opens at fair value.
        // tokensForDexLP = usdtForLP / price_per_token.
        // getCurrentPrice() = USDT cost for 1e18 token units.
        uint256 curvePrice = getCurrentPrice();
        uint256 maxLPTokens = tokensForLP;
        uint256 tokensForDexLP;
        if (curvePrice > 0) {
            tokensForDexLP = Math.mulDiv(usdtForLP, 1e18, curvePrice);
            if (tokensForDexLP > maxLPTokens) tokensForDexLP = maxLPTokens;
        } else {
            // Curve fully sold — use full LP allocation
            tokensForDexLP = maxLPTokens;
        }

        // Platform token fee: 1% of tokens actually going to LP
        uint256 platformTokenFee = (tokensForDexLP * GRADUATION_FEE_BPS) / BPS;
        tokensForDexLP -= platformTokenFee;

        // Send graduation fees
        if (platformBaseFee > 0) {
            usdt.safeTransfer(platformWallet, platformBaseFee);
        }

        if (platformTokenFee > 0) {
            _transferExact(platformWallet, platformTokenFee);
        }

        // Add LP by transferring directly to the pair and calling mint().
        // This bypasses the router's ratio-matching, making it immune to
        // pair manipulation: our large amounts dominate any griefer position,
        // and the griefer loses their capital regardless of direction.
        address dexFactory = dexRouter.factory();
        address pair = IUniswapV2Factory(dexFactory).getPair(address(token), address(usdt));
        if (pair == address(0)) {
            pair = IUniswapV2Factory(dexFactory).createPair(address(token), address(usdt));
        }

        // Transfer LP amounts directly to the pair. _transferExact reverts
        // if the token charges a hidden fee — protects the LP ratio.
        _transferExact(pair, tokensForDexLP);
        usdt.safeTransfer(pair, usdtForLP);

        // Mint LP tokens and burn them — permanent liquidity
        IUniswapV2Pair(pair).mint(address(0xdead));

        // Open public trading after the anti-snipe window. Only platform tokens
        // expose `enableTrading` and only when the creator authorized this launch
        // instance via `setAuthorizedLauncher`. External Ownable ERC20s (already
        // tradeable) don't implement this — silently skip in that case. Missing
        // authorization on a platform token is non-fatal here: the creator can
        // still call `token.enableTrading(0)` themselves after graduation.
        try ILaunchToken(address(token)).enableTrading(lockDurationAfterListing) {} catch {}

        // Send remaining USDT to platform (graduation = no refunds)
        uint256 usdtBal = usdt.balanceOf(address(this));
        if (usdtBal > 0) {
            usdt.safeTransfer(platformWallet, usdtBal);
        }

        // Burn unsold curve tokens + any unused LP tokens
        uint256 tokenBal = token.balanceOf(address(this));
        uint256 tokenReserved = creatorTotalTokens;
        if (tokenBal > tokenReserved) {
            token.safeTransfer(address(0xdead), tokenBal - tokenReserved);
        }

        emit Graduated(
            pair, usdtForLP, tokensForDexLP, platformBaseFee, platformTokenFee,
            totalBaseRaised, tokensSold, _buyers.length
        );

        // Record graduation in factory daily stats
        try ILaunchpadFactory(factory).recordGraduation(address(this)) {} catch {}
    }

    // ── Refund ─────────────────────────────────────────────────

    /// @dev Automatically transition to Refunding if the launch is Active,
    ///      the deadline has passed, and soft cap was not reached. Called
    ///      internally before any state-dependent operation so users never
    ///      need to trigger a separate transaction.
    function _autoResolve() internal {
        if (
            state == LaunchState.Active &&
            block.timestamp >= deadline &&
            totalBaseRaised < softCap
        ) {
            state = LaunchState.Refunding;
            refundStartTimestamp = block.timestamp;

            // Unlock the tax ceiling so the creator can adjust rates and
            // relaunch. This instance is an authorized launcher on the token,
            // which is the only role permitted to unlock.
            try ILaunchToken(address(token)).unlockTaxCeiling() {} catch {}

            emit RefundingEnabled(address(token), totalBaseRaised, softCap);
        }
    }

    /// @notice Resolve the launch state. If the deadline has passed and soft
    ///         cap was not reached, transitions to Refunding automatically.
    ///         No-op if conditions aren't met. Anyone can call this, but it
    ///         is also called internally by refund(), graduate(), and buy().
    function resolveState() external {
        _autoResolve();
    }

    /// @notice Claim a (possibly partial) refund during Refunding. The buyer
    ///         returns `tokensToReturn` of the launch token and receives a
    ///         proportional share of their original USDT payment. Full refund
    ///         is just the all-at-once case of this.
    ///
    ///         Partial refunds let buyers who split tokens across wallets
    ///         recover value incrementally without needing to consolidate.
    ///         Entitlement stays keyed to msg.sender — there's no cross-wallet
    ///         grief vector because we never let a different address claim
    ///         someone else's entitlement.
    function refund(uint256 tokensToReturn) external nonReentrant {
        _autoResolve();
        // Refunds available in Refunding state OR when the launch is paused
        // (emergency exit path — factory-flipped pause gives users an
        // immediate way out without waiting for the deadline).
        if (state != LaunchState.Refunding && !paused) revert NotRefunding();
        uint256 paid = basePaid[msg.sender];
        if (paid == 0) revert NothingToRefund();

        uint256 buyerTokens = tokensBought[msg.sender];
        if (tokensToReturn == 0 || tokensToReturn > buyerTokens) revert ZeroAmount();

        // Pro-rata refund amount — rounds down so dust stays in buyer's
        // entitlement (safer than rounding up which could drain the pool).
        uint256 refundBase = (paid * tokensToReturn) / buyerTokens;

        // Update global state
        tokensSold -= tokensToReturn;
        totalBaseRaised -= refundBase;

        // Update buyer entitlement (might leave small residuals for the
        // caller to claim on a second call)
        basePaid[msg.sender] = paid - refundBase;
        // Pro-rata gross reduction matching the net refund ratio
        uint256 grossRefund = grossPaid[msg.sender] > 0
            ? (grossPaid[msg.sender] * tokensToReturn) / buyerTokens
            : 0;
        grossPaid[msg.sender] -= grossRefund;
        tokensBought[msg.sender] = buyerTokens - tokensToReturn;

        // Buyer must hold + have approved the tokens they're returning
        uint256 balance = token.balanceOf(msg.sender);
        uint256 allowance = token.allowance(msg.sender, address(this));
        if (balance < tokensToReturn || allowance < tokensToReturn) revert ReturnTokensToRefund();
        _transferFromExact(msg.sender, tokensToReturn);

        usdt.safeTransfer(msg.sender, refundBase);

        emit Refunded(msg.sender, refundBase, tokensToReturn);
    }

    /// @notice Creator reclaims launch tokens currently held by the contract.
    ///         Callable any time during Refunding.
    ///
    ///         Simple because refunds are USDT-out / tokens-in: the contract
    ///         never needs a token reserve to honor refund obligations. When
    ///         a buyer refunds, they transfer tokens INTO the contract; they
    ///         don't withdraw any. So every token sitting in the contract at
    ///         any moment during Refunding is safe for the creator to take.
    ///
    ///         Incremental behavior: initial call drains whatever wasn't
    ///         sold from the curve. As buyers refund, their returned tokens
    ///         accumulate in the balance and a subsequent call picks them up.
    ///
    ///         This replaces the old "wait 90 days or until all refunds"
    ///         pattern which permanently locked tokens when even one buyer
    ///         abandoned their refund.
    function creatorWithdrawAvailable() external onlyCreator nonReentrant {
        _autoResolve();
        if (state != LaunchState.Refunding) revert NotRefunding();
        uint256 available = token.balanceOf(address(this));
        if (available == 0) revert NoTokens();

        _transferExact(creator, available);

        // Clear the factory's tokenToLaunch slot so the creator (or anyone)
        // can re-launch this token. Safe to call repeatedly — the factory
        // side is idempotent, and the try/catch protects against external
        // factories that may not implement clearTokenLaunch.
        try ILaunchpadFactory(factory).clearTokenLaunch(address(token)) {} catch {}

        emit CreatorReclaim(creator, available);
    }

    /// @notice Platform rescue: after STRANDED_SWEEP_DELAY in Refunding,
    ///         sweep any USDT still stranded from buyers who abandoned
    ///         their refund. Never touches USDT owed to live entitlements —
    ///         by the time the sweep window opens, the expectation is that
    ///         active buyers have long since refunded.
    ///
    ///         5 years is deliberately long. Abandoned refunds are almost
    ///         always dust; platform revenue from sweeps is negligible, so
    ///         the window is sized to protect buyers who lost access
    ///         (hospital, lost keys, divorce, moved countries) rather than
    ///         to recover value fast. Also lines up with 3-5 year
    ///         unclaimed-property escheatment norms in most jurisdictions.
    uint256 public constant STRANDED_SWEEP_DELAY = 1825 days;

    function sweepStrandedUsdt() external {
        if (state != LaunchState.Refunding) revert NotRefunding();
        if (block.timestamp < refundStartTimestamp + STRANDED_SWEEP_DELAY) revert StrandedSweepTooEarly();
        address _platformWallet = ILaunchpadFactory(factory).platformWallet();
        // Platform-only. The creator used to be allowed here too, but the
        // funds always land in `platformWallet` — leaving creator in the
        // access list was cosmetic (no incentive to call) and encouraged
        // confused-deputy expectations.
        if (msg.sender != _platformWallet) revert NotCreator();
        uint256 bal = usdt.balanceOf(address(this));
        if (bal == 0) revert NoTokens();
        usdt.safeTransfer(_platformWallet, bal);
    }

    // ── Creator Vesting ────────────────────────────────────────

    /// @notice Claim vested creator tokens after graduation.
    function claimCreatorTokens() external onlyCreator nonReentrant {
        if (state != LaunchState.Graduated) revert NotGraduated();
        if (creatorTotalTokens == 0) revert NoAllocation();

        uint256 elapsed = block.timestamp - graduationTimestamp;
        if (elapsed < vestingCliff) revert CliffNotReached();

        uint256 vestedTime = elapsed - vestingCliff;
        uint256 vested;
        if (vestedTime >= vestingDuration) {
            vested = creatorTotalTokens;
        } else {
            vested = (creatorTotalTokens * vestedTime) / vestingDuration;
        }

        uint256 claimable = vested - creatorClaimed;
        if (claimable == 0) revert NothingToClaim();

        creatorClaimed += claimable;
        _transferExact(creator, claimable);

        emit CreatorClaimed(creator, claimable, creatorClaimed, vested);
    }

    // ── View Functions ─────────────────────────────────────────

    /// @notice Effective state — returns Refunding if the launch is technically
    ///         Active but the deadline has passed without reaching soft cap.
    ///         Use this in frontends instead of raw `state` for accurate display.
    function effectiveState() public view returns (LaunchState) {
        if (
            state == LaunchState.Active &&
            block.timestamp >= deadline &&
            totalBaseRaised < softCap
        ) {
            return LaunchState.Refunding;
        }
        return state;
    }

    /// @notice Current token price on the curve (cost for 1 full token).
    ///         When the curve is fully sold, returns the final price rather
    ///         than 0 — needed by _graduate() for fair LP seeding.
    function getCurrentPrice() public view returns (uint256) {
        uint256 remaining = tokensForCurve - tokensSold;
        if (remaining == 0) {
            // Curve fully sold — compute price at the final position.
            // Use the cost of the last 1e18 units of the curve.
            if (tokensSold >= 1e18) {
                return _getCostForTokensAt(tokensSold - 1e18, 1e18);
            }
            return _getCostForTokensAt(0, tokensSold);
        }
        uint256 amount = remaining < 1e18 ? remaining : 1e18;
        return _getCostForTokens(amount);
    }

    /// @notice Cost in base coin to buy `amount` tokens.
    function getCostForTokens(uint256 amount) external view returns (uint256) {
        return _getCostForTokens(amount);
    }

    /// @notice Tokens received for `baseAmount` base coin (before buy fee deduction).
    ///         For accurate preview including fee, use previewBuy().
    function getTokensForBase(uint256 baseAmount) external view returns (uint256) {
        uint256 afterFee = baseAmount - (baseAmount * BUY_FEE_BPS) / BPS;
        return _getTokensForBase(afterFee);
    }

    /// @notice Preview a buy: returns tokens out, fee, and price impact for a given base amount.
    ///         Does not account for per-wallet limits. Use previewBuyFor() for wallet-aware preview.
    function previewBuy(uint256 baseAmount) external view returns (
        uint256 tokensOut,
        uint256 fee,
        uint256 priceImpactBps
    ) {
        return _previewBuy(baseAmount, type(uint256).max);
    }

    /// @notice Preview a buy for a specific buyer, respecting their per-wallet USDT limit.
    function previewBuyFor(address buyer, uint256 baseAmount) external view returns (
        uint256 tokensOut,
        uint256 fee,
        uint256 priceImpactBps
    ) {
        uint256 remainingAllowance = maxBuyPerWallet > basePaid[buyer]
            ? maxBuyPerWallet - basePaid[buyer]
            : 0;
        return _previewBuy(baseAmount, remainingAllowance);
    }

    function _previewBuy(uint256 baseAmount, uint256 maxBase) internal view returns (
        uint256 tokensOut,
        uint256 fee,
        uint256 priceImpactBps
    ) {
        if (baseAmount == 0 || state != LaunchState.Active) return (0, 0, 0);
        fee = (baseAmount * BUY_FEE_BPS) / BPS;
        uint256 baseForTokens = baseAmount - fee;

        // Cap to wallet's remaining USDT allowance
        if (baseForTokens > maxBase) {
            baseForTokens = maxBase;
        }

        tokensOut = _getTokensForBase(baseForTokens);
        uint256 remaining = tokensForCurve - tokensSold;
        if (tokensOut > remaining) tokensOut = remaining;

        // Price impact: compare current price vs average fill price
        uint256 priceBefore = getCurrentPrice();
        if (priceBefore > 0 && tokensOut > 0) {
            uint256 cost = _getCostForTokens(tokensOut);
            uint256 avgPrice = (cost * 1e18) / tokensOut;
            if (avgPrice > priceBefore) {
                priceImpactBps = ((avgPrice - priceBefore) * BPS) / priceBefore;
            }
        }
    }

    /// @notice Progress towards soft/hard cap in BPS.
    function progressBps() external view returns (uint256 softCapBps, uint256 hardCapBps) {
        softCapBps = softCap > 0 ? Math.min((totalBaseRaised * BPS) / softCap, BPS) : 0;
        hardCapBps = hardCap > 0 ? Math.min((totalBaseRaised * BPS) / hardCap, BPS) : 0;
    }

    // ── Purchase history reads ──────────────────────────────────

    /// @notice Total number of purchases.
    function totalPurchases() external view returns (uint256) { return _purchases.length; }

    /// @notice Total unique buyers.
    function totalBuyers() external view returns (uint256) { return _buyers.length; }

    /// @notice Get a single purchase by index.
    function getPurchase(uint256 index) external view returns (Purchase memory) {
        return _purchases[index];
    }

    /// @notice Get a batch of purchases.
    function getPurchases(uint256 offset, uint256 limit) external view returns (Purchase[] memory purchases, uint256 total) {
        total = _purchases.length;
        if (offset >= total) return (new Purchase[](0), total);
        uint256 end = offset + limit;
        if (end > total) end = total;
        purchases = new Purchase[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            purchases[i - offset] = _purchases[i];
        }
    }

    /// @notice Get unique buyer addresses.
    function getBuyers(uint256 offset, uint256 limit) external view returns (address[] memory buyers, uint256 total) {
        total = _buyers.length;
        if (offset >= total) return (new address[](0), total);
        uint256 end = offset + limit;
        if (end > total) end = total;
        buyers = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            buyers[i - offset] = _buyers[i];
        }
    }

    /// @notice Cheap state hash for change detection. Daemon compares this against cache —
    ///         only fetches full data when hash changes.
    function stateHash() external view returns (bytes32) {
        return keccak256(abi.encodePacked(
            state, totalBaseRaised, tokensSold, totalTokensDeposited,
            _purchases.length, _buyers.length
        ));
    }

    /// @notice Creator vesting details.
    function vestingInfo() external view returns (
        uint256 total,
        uint256 claimed,
        uint256 claimable,
        uint256 nextClaimTimestamp
    ) {
        total = creatorTotalTokens;
        claimed = creatorClaimed;
        if (state != LaunchState.Graduated || creatorTotalTokens == 0) {
            return (total, claimed, 0, 0);
        }
        uint256 elapsed = block.timestamp - graduationTimestamp;
        if (elapsed < vestingCliff) {
            return (total, claimed, 0, graduationTimestamp + vestingCliff);
        }
        uint256 vestedTime = elapsed - vestingCliff;
        uint256 vested = vestedTime >= vestingDuration
            ? creatorTotalTokens
            : (creatorTotalTokens * vestedTime) / vestingDuration;
        claimable = vested - claimed;
        nextClaimTimestamp = vested >= creatorTotalTokens ? 0 : block.timestamp;
    }

    /// @notice Full launch info for frontend.
    function getLaunchInfo() external view returns (
        address token_,
        address creator_,
        CurveType curveType_,
        LaunchState state_,
        uint256 softCap_,
        uint256 hardCap_,
        uint256 deadline_,
        uint256 totalBaseRaised_,
        uint256 tokensSold_,
        uint256 tokensForCurve_,
        uint256 tokensForLP_,
        uint256 creatorAllocationBps_,
        uint256 currentPrice_,
        address usdt_,
        uint256 startTimestamp_
    ) {
        return (
            address(token),
            creator,
            curveType,
            state,
            softCap,
            hardCap,
            deadline,
            totalBaseRaised,
            tokensSold,
            tokensForCurve,
            tokensForLP,
            creatorAllocationBps,
            state == LaunchState.Active || state == LaunchState.Pending ? getCurrentPrice() : 0,
            address(usdt),
            startTimestamp
        );
    }

    // ── Internal Curve Math ────────────────────────────────────

    /// @dev Raw curve cost in 18-decimal virtual base units (before scaling to actual USDT decimals).
    function _curveCost(uint256 amount) internal view returns (uint256) {
        if (curveType == CurveType.Linear) {
            return BondingCurve.linearCost(tokensSold, amount, curveParam1, curveParam2);
        } else if (curveType == CurveType.SquareRoot) {
            return BondingCurve.sqrtCost(tokensSold, amount, curveParam1);
        } else if (curveType == CurveType.Quadratic) {
            return BondingCurve.quadraticCost(tokensSold, amount, curveParam1);
        } else {
            return BondingCurve.exponentialCost(tokensSold, amount, curveParam1, curveParam2);
        }
    }

    /// @dev Cost in actual USDT units (scaled from 18-dec curve output).
    function _getCostForTokens(uint256 amount) internal view returns (uint256) {
        return _curveCost(amount) / baseScale;
    }

    /// @dev Cost at a specific supply position (not necessarily tokensSold).
    ///      Used by getCurrentPrice() to compute the final curve price after sell-out.
    function _getCostForTokensAt(uint256 atSupply, uint256 amount) internal view returns (uint256) {
        uint256 rawCost;
        if (curveType == CurveType.Linear) {
            rawCost = BondingCurve.linearCost(atSupply, amount, curveParam1, curveParam2);
        } else if (curveType == CurveType.SquareRoot) {
            rawCost = BondingCurve.sqrtCost(atSupply, amount, curveParam1);
        } else if (curveType == CurveType.Quadratic) {
            rawCost = BondingCurve.quadraticCost(atSupply, amount, curveParam1);
        } else {
            rawCost = BondingCurve.exponentialCost(atSupply, amount, curveParam1, curveParam2);
        }
        return rawCost / baseScale;
    }

    function _getTokensForBase(uint256 baseAmount) internal view returns (uint256) {
        if (baseAmount == 0) return 0;
        uint256 remaining = tokensForCurve - tokensSold;
        if (remaining == 0) return 0;

        // Scale up to 18-dec for curve comparison
        uint256 scaledBase = baseAmount * baseScale;

        uint256 low = 0;
        uint256 high = remaining;
        uint256 bestAmount = 0;

        for (uint256 i = 0; i < 128; i++) {
            if (low > high) break;
            uint256 mid = (low + high) / 2;
            if (mid == 0) break;
            // Use _tryCurveCost to handle overflow for extreme curve params
            (bool ok, uint256 cost) = _tryCurveCost(mid);
            if (!ok || cost > scaledBase) {
                if (mid == 0) break;
                high = mid - 1;
            } else {
                bestAmount = mid;
                low = mid + 1;
            }
        }
        return bestAmount;
    }

    /// @dev Wraps _curveCost to catch overflow/revert for extreme curve parameters.
    ///      Returns cost in 18-decimal virtual units (not actual USDT units).
    function _tryCurveCost(uint256 amount) internal view returns (bool success, uint256 cost) {
        try this.curveCostExternal(amount) returns (uint256 result) {
            return (true, result);
        } catch {
            return (false, 0);
        }
    }

    /// @dev External wrapper needed for try/catch on internal view function.
    ///      Returns raw 18-decimal curve cost.
    function curveCostExternal(uint256 amount) external view returns (uint256) {
        return _curveCost(amount);
    }

    /// @notice Recover accidentally sent ETH. Creator or platform can call.
    ///         Sends to creator first; if that fails (e.g. contract creator
    ///         that reverts on receive), falls back to platformWallet.
    function recoverETH() external nonReentrant {
        if (msg.sender != creator && msg.sender != ILaunchpadFactory(factory).platformWallet()) revert NotCreator();
        uint256 bal = address(this).balance;
        if (bal == 0) revert NoETH();
        (bool ok, ) = creator.call{value: bal}("");
        if (!ok) {
            address pw = ILaunchpadFactory(factory).platformWallet();
            (bool ok2, ) = pw.call{value: bal}("");
            if (!ok2) revert TransferFailed();
        }
    }

    receive() external payable {}
}
