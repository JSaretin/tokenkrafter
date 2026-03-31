// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

// =============================================================
// LAUNCHPAD FACTORY INTERFACE (minimal — avoids circular import)
// =============================================================

interface ILaunchpadFactory {
    function platformWallet() external view returns (address);
    function recordGraduation(address launch_) external;
    function clearTokenLaunch(address token_) external;
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

interface IUniswapV2Router02 {
    function factory() external pure returns (address);
    function WETH() external pure returns (address);
    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity);
    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity);
    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external view returns (uint256[] memory amounts);
    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable returns (uint256[] memory amounts);
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
    function getAmountsIn(uint256 amountOut, address[] calldata path)
        external view returns (uint256[] memory amounts);
}

interface IUniswapV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

interface IOwnable {
    function owner() external view returns (address);
}

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
    error DeadlineNotReached();
    error SoftCapAlreadyReached();
    error InsufficientTokensOut();
    error LaunchNotStarted();
    error InvalidStartTimestamp();

    // ── Enums ──────────────────────────────────────────────────
    enum CurveType { Linear, SquareRoot, Quadratic, Exponential }
    enum LaunchState { Pending, Active, Graduated, Refunding }

    // ── Immutables ─────────────────────────────────────────────
    address payable public immutable factory;
    address public immutable creator;
    IERC20 public immutable token;
    CurveType public immutable curveType;
    IUniswapV2Router02 public immutable dexRouter;
    IERC20 public immutable usdt;    // stablecoin — all curve math denominated in USDT
    uint256 public immutable baseScale; // 10^(18 - usdtDecimals), to normalize curve math to 1e18

    uint256 public immutable curveParam1;
    uint256 public immutable curveParam2;

    uint256 public immutable softCap;    // in USDT
    uint256 public immutable hardCap;    // in USDT
    uint256 public immutable durationSeconds;
    uint256 public deadline;             // set on activation (or startTimestamp), not deployment
    uint256 public immutable startTimestamp; // 0 = start immediately on activation
    uint256 public immutable maxBuyPerWallet;

    // ── Creator vesting ────────────────────────────────────────
    uint256 public immutable creatorAllocationBps;
    uint256 public immutable vestingDuration;
    uint256 public immutable vestingCliff;
    uint256 public creatorTotalTokens;
    uint256 public creatorClaimed;
    uint256 public graduationTimestamp;

    // ── Token distribution ─────────────────────────────────────
    uint256 public immutable tokensForCurve;
    uint256 public immutable tokensForLP;
    uint256 public immutable totalTokensRequired;

    // ── Platform fees ──────────────────────────────────────────
    uint256 public constant PLATFORM_FEE_BPS = 300;  // 3% on graduation
    uint256 public constant BPS = 10000;

    // ── State ──────────────────────────────────────────────────
    LaunchState public state;
    uint256 public tokensSold;
    uint256 public totalBaseRaised;
    uint256 public totalTokensDeposited;

    mapping(address => uint256) public basePaid;      // base spent (excluding fee) — refundable amount
    mapping(address => uint256) public tokensBought;

    // ── Events ─────────────────────────────────────────────────
    event TokensDeposited(address indexed creator, uint256 amount);
    event LaunchActivated();
    event TokenBought(address indexed buyer, uint256 tokenAmount, uint256 basePaid, uint256 newPrice);
    event Graduated(address indexed dexPair, uint256 baseToLP, uint256 tokensToLP, uint256 platformBaseFee, uint256 platformTokenFee);
    event Refunded(address indexed buyer, uint256 baseAmount);
    event CreatorClaimed(address indexed creator, uint256 amount);
    event RefundingEnabled();
    event CreatorWithdraw(address indexed creator, uint256 tokenAmount);

    // ── Modifiers ──────────────────────────────────────────────
    modifier onlyActive() {
        if (state != LaunchState.Active) revert NotActive();
        _;
    }

    modifier onlyCreator() {
        if (msg.sender != creator) revert NotCreator();
        _;
    }

    // ── Constructor ────────────────────────────────────────────
    constructor(
        address creator_,
        address token_,
        uint256 totalTokensForLaunch_,  // Total tokens creator will deposit (curve + LP + creator alloc)
        CurveType curveType_,
        uint256 curveParam1_,
        uint256 curveParam2_,
        uint256 softCap_,               // in USDT
        uint256 hardCap_,               // in USDT
        uint256 durationDays_,
        uint256 maxBuyBps_,
        uint256 creatorAllocationBps_,
        uint256 vestingDays_,
        address dexRouter_,
        address usdt_,
        uint256 startTimestamp_
    ) {
        if (token_ == address(0)) revert InvalidToken();
        if (usdt_ == address(0)) revert InvalidUsdt();
        if (softCap_ == 0 || hardCap_ < softCap_) revert InvalidCaps();
        if (durationDays_ < 7 || durationDays_ > 90) revert InvalidDuration();
        if (maxBuyBps_ < 50 || maxBuyBps_ > 500) revert InvalidMaxBuy();
        if (creatorAllocationBps_ > 500) revert InvalidCreatorAlloc();
        if (vestingDays_ != 0 && vestingDays_ != 30 && vestingDays_ != 60 && vestingDays_ != 90) revert InvalidVesting();
        if (creatorAllocationBps_ != 0 && vestingDays_ == 0) revert CreatorAllocRequiresVesting();
        if (startTimestamp_ != 0 && startTimestamp_ <= block.timestamp) revert InvalidStartTimestamp();

        factory = payable(msg.sender);
        creator = creator_;
        token = IERC20(token_);
        usdt = IERC20(usdt_);
        // Compute scale factor: curve math operates in 18 decimals internally
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

        // Token distribution from the deposited amount:
        // 70% for bonding curve, remaining for LP and creator
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

        // Start as Pending — needs token deposit to activate
        state = LaunchState.Pending;
    }

    // ── Deposit & Activate ─────────────────────────────────────

    /// @notice Creator deposits tokens to fund the launch. Once the required amount
    ///         is deposited, the launch activates automatically.
    ///         Creator must approve this contract before calling.
    function depositTokens(uint256 amount) external onlyCreator {
        if (state != LaunchState.Pending) revert NotPending();
        if (amount == 0) revert ZeroAmount();

        uint256 remaining = totalTokensRequired - totalTokensDeposited;
        uint256 toDeposit = amount > remaining ? remaining : amount;

        token.safeTransferFrom(msg.sender, address(this), toDeposit);
        totalTokensDeposited += toDeposit;

        emit TokensDeposited(msg.sender, toDeposit);

        // Auto-activate when fully funded
        if (totalTokensDeposited >= totalTokensRequired) {
            state = LaunchState.Active;
            uint256 start = startTimestamp > block.timestamp ? startTimestamp : block.timestamp;
            deadline = start + durationSeconds;
            emit LaunchActivated();
        }
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

        emit TokensDeposited(creator, amount);

        // Auto-activate when fully funded
        if (totalTokensDeposited >= totalTokensRequired) {
            state = LaunchState.Active;
            uint256 start = startTimestamp > block.timestamp ? startTimestamp : block.timestamp;
            deadline = start + durationSeconds;
            emit LaunchActivated();
        }
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

    /// @notice Buy tokens with native coin (ETH/BNB). Auto-converts to USDT via DEX.
    /// @param minUsdtOut Minimum USDT to receive from the DEX swap (slippage protection)
    /// @param minTokensOut Minimum tokens to receive from bonding curve (slippage protection)
    function buy(uint256 minUsdtOut, uint256 minTokensOut) external payable nonReentrant onlyActive {
        if (msg.value == 0) revert SendNativeCoin();
        if (startTimestamp > 0 && block.timestamp < startTimestamp) revert LaunchNotStarted();
        if (block.timestamp >= deadline) revert LaunchExpired();

        // Swap native coin → USDT via DEX
        address weth = dexRouter.WETH();
        address[] memory path = new address[](2);
        path[0] = weth;
        path[1] = address(usdt);

        uint256[] memory amounts = dexRouter.swapExactETHForTokens{value: msg.value}(
            minUsdtOut,
            path,
            address(this),
            block.timestamp + 300
        );

        uint256 usdtReceived = amounts[amounts.length - 1];
        _processBuy(msg.sender, usdtReceived, minTokensOut);
    }

    /// @notice Buy tokens with an ERC20 token (USDT, USDC, etc.). Non-USDT tokens are auto-converted.
    /// @param paymentToken The ERC20 token address to pay with
    /// @param amount Amount of paymentToken to spend
    /// @param minUsdtOut Minimum USDT to receive from the DEX swap (slippage protection, ignored if paying in USDT)
    /// @param minTokensOut Minimum tokens to receive from bonding curve (slippage protection)
    function buyWithToken(address paymentToken, uint256 amount, uint256 minUsdtOut, uint256 minTokensOut) external nonReentrant onlyActive {
        if (amount == 0) revert ZeroAmount();
        if (startTimestamp > 0 && block.timestamp < startTimestamp) revert LaunchNotStarted();
        if (block.timestamp >= deadline) revert LaunchExpired();

        IERC20(paymentToken).safeTransferFrom(msg.sender, address(this), amount);

        uint256 usdtAmount;
        if (paymentToken == address(usdt)) {
            usdtAmount = amount;
        } else {
            // Swap paymentToken → USDT via DEX
            IERC20(paymentToken).forceApprove(address(dexRouter), amount);

            // Try direct path first
            address[] memory directPath = new address[](2);
            directPath[0] = paymentToken;
            directPath[1] = address(usdt);

            try dexRouter.swapExactTokensForTokens(
                amount, minUsdtOut, directPath, address(this), block.timestamp + 300
            ) returns (uint256[] memory amounts) {
                usdtAmount = amounts[amounts.length - 1];
            } catch {
                // Try via WETH
                address[] memory wethPath = new address[](3);
                wethPath[0] = paymentToken;
                wethPath[1] = dexRouter.WETH();
                wethPath[2] = address(usdt);
                uint256[] memory amounts = dexRouter.swapExactTokensForTokens(
                    amount, minUsdtOut, wethPath, address(this), block.timestamp + 300
                );
                usdtAmount = amounts[amounts.length - 1];
            }
        }

        _processBuy(msg.sender, usdtAmount, minTokensOut);
    }

    /// @dev Internal buy logic. All amounts are in USDT after conversion.
    ///      No buy fee — platform earns only from the 3% graduation fee.
    function _processBuy(address buyer, uint256 usdtAmount, uint256 minTokensOut) internal {
        uint256 baseForTokens = usdtAmount;

        // Calculate tokens from curve
        uint256 tokensOut = _getTokensForBase(baseForTokens);
        if (tokensOut == 0) revert AmountTooSmall();

        uint256 remaining = tokensForCurve - tokensSold;
        if (tokensOut > remaining) {
            tokensOut = remaining;
            uint256 actualCost = _getCostForTokens(tokensOut);
            uint256 refundUsdt = usdtAmount - actualCost;
            baseForTokens = actualCost;
            if (refundUsdt > 0) {
                usdt.safeTransfer(buyer, refundUsdt);
            }
        }

        // Anti-whale: cap by USDT value (% of hard cap)
        if (basePaid[buyer] + baseForTokens > maxBuyPerWallet) {
            uint256 remaining_allowance = maxBuyPerWallet > basePaid[buyer]
                ? maxBuyPerWallet - basePaid[buyer]
                : 0;
            if (remaining_allowance == 0) revert ExceedsMaxBuy();

            tokensOut = _getTokensForBase(remaining_allowance);
            if (tokensOut == 0) revert ExceedsMaxBuy();
            uint256 actualCost = _getCostForTokens(tokensOut);
            uint256 refundUsdt = usdtAmount - actualCost;
            baseForTokens = actualCost;
            if (refundUsdt > 0) {
                usdt.safeTransfer(buyer, refundUsdt);
            }
        }

        // Check minTokensOut AFTER all capping
        if (tokensOut < minTokensOut) revert InsufficientTokensOut();

        // Update state
        tokensSold += tokensOut;
        totalBaseRaised += baseForTokens;
        basePaid[buyer] += baseForTokens;
        tokensBought[buyer] += tokensOut;

        // Transfer tokens to buyer
        token.safeTransfer(buyer, tokensOut);

        emit TokenBought(buyer, tokensOut, baseForTokens, getCurrentPrice());

        // Auto-graduate on hard cap or curve sell-out
        if (totalBaseRaised >= hardCap || tokensSold >= tokensForCurve) {
            _graduate();
        }
    }

    // ── Graduate ───────────────────────────────────────────────

    /// @notice Graduate to DEX. Creator can call after soft cap, or auto on hard cap / sell-out.
    ///         After deadline, anyone can trigger graduation if soft cap was met (prevents fund lock).
    function graduate() external nonReentrant onlyActive {
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

        // Platform fees: 3% of USDT base + 3% of LP tokens
        uint256 platformBaseFee = (totalBaseRaised * PLATFORM_FEE_BPS) / BPS;
        uint256 platformTokenFee = (tokensForLP * PLATFORM_FEE_BPS) / BPS;
        uint256 usdtForLP = totalBaseRaised - platformBaseFee;
        uint256 tokensForDexLP = tokensForLP - platformTokenFee;

        // Send platform fees
        address platformWallet = ILaunchpadFactory(factory).platformWallet();

        // Send USDT platform fee
        if (platformBaseFee > 0) {
            usdt.safeTransfer(platformWallet, platformBaseFee);
        }

        if (platformTokenFee > 0) {
            token.safeTransfer(platformWallet, platformTokenFee);
        }

        // Approve router and add TOKEN/USDT liquidity
        token.forceApprove(address(dexRouter), tokensForDexLP);
        usdt.forceApprove(address(dexRouter), usdtForLP);

        (uint256 amountToken, uint256 amountUsdt, ) = dexRouter.addLiquidity(
            address(token),
            address(usdt),
            tokensForDexLP,
            usdtForLP,
            (tokensForDexLP * 995) / 1000,
            (usdtForLP * 995) / 1000,
            address(0xdead),               // Burn LP tokens — permanent liquidity
            block.timestamp + 300
        );

        // Send any unused USDT from slippage to platform
        uint256 unusedUsdt = usdtForLP - amountUsdt;
        if (unusedUsdt > 0) {
            usdt.safeTransfer(platformWallet, unusedUsdt);
        }

        // Burn unsold curve tokens
        uint256 unsoldTokens = tokensForCurve - tokensSold;
        if (unsoldTokens > 0) {
            token.safeTransfer(address(0xdead), unsoldTokens);
        }

        // Burn unused LP tokens (from rounding)
        uint256 unusedLPTokens = tokensForDexLP - amountToken;
        if (unusedLPTokens > 0) {
            token.safeTransfer(address(0xdead), unusedLPTokens);
        }

        address dexFactory = dexRouter.factory();
        address pair = IUniswapV2Factory(dexFactory).getPair(address(token), address(usdt));

        emit Graduated(pair, amountUsdt, amountToken, platformBaseFee, platformTokenFee);

        // Record graduation in factory daily stats
        try ILaunchpadFactory(factory).recordGraduation(address(this)) {} catch {}
    }

    // ── Refund ─────────────────────────────────────────────────

    /// @notice Enable refunds if deadline passes without soft cap.
    function enableRefunds() external {
        if (state != LaunchState.Active) revert NotActive();
        if (block.timestamp < deadline) revert DeadlineNotReached();
        if (totalBaseRaised >= softCap) revert SoftCapAlreadyReached();
        state = LaunchState.Refunding;
        emit RefundingEnabled();
    }

    /// @notice Claim refund. Returns base coin to buyer. Buyer must return all tokens
    ///         (approve this contract first). This prevents gaming the refund mechanism.
    function refund() external nonReentrant {
        if (state != LaunchState.Refunding) revert NotRefunding();
        uint256 paid = basePaid[msg.sender];
        if (paid == 0) revert NothingToRefund();

        uint256 buyerTokens = tokensBought[msg.sender];

        // Update global state — correct curve accounting
        tokensSold -= buyerTokens;
        totalBaseRaised -= paid;

        basePaid[msg.sender] = 0;
        tokensBought[msg.sender] = 0;

        // Require full token return to get refund
        if (buyerTokens > 0) {
            uint256 balance = token.balanceOf(msg.sender);
            uint256 allowance = token.allowance(msg.sender, address(this));
            if (balance < buyerTokens || allowance < buyerTokens) revert ReturnTokensToRefund();
            token.safeTransferFrom(msg.sender, address(this), buyerTokens);
        }

        // Refund full USDT amount (no buy fee was taken)
        usdt.safeTransfer(msg.sender, paid);

        emit Refunded(msg.sender, paid);
    }

    /// @notice After refunding completes, creator can withdraw remaining tokens.
    ///         Only allowed once all buyers have been refunded (totalBaseRaised == 0).
    ///         Clears tokenToLaunch in factory to allow relaunching.
    function creatorWithdrawAfterRefund() external onlyCreator {
        if (state != LaunchState.Refunding) revert NotRefunding();
        if (totalBaseRaised != 0) revert OutstandingRefundsRemain();
        uint256 balance = token.balanceOf(address(this));
        if (balance == 0) revert NoTokens();
        token.safeTransfer(creator, balance);

        // Clear tokenToLaunch in factory to allow relaunching this token
        try ILaunchpadFactory(factory).clearTokenLaunch(address(token)) {} catch {}

        emit CreatorWithdraw(creator, balance);
    }

    // ── Creator Vesting ────────────────────────────────────────

    /// @notice Claim vested creator tokens after graduation.
    function claimCreatorTokens() external onlyCreator {
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
        token.safeTransfer(creator, claimable);

        emit CreatorClaimed(creator, claimable);
    }

    // ── View Functions ─────────────────────────────────────────

    /// @notice Current token price on the curve (cost for 1 full token).
    function getCurrentPrice() public view returns (uint256) {
        uint256 remaining = tokensForCurve - tokensSold;
        if (remaining == 0) return 0;
        uint256 amount = remaining < 1e18 ? remaining : 1e18;
        return _getCostForTokens(amount);
    }

    /// @notice Cost in base coin to buy `amount` tokens.
    function getCostForTokens(uint256 amount) external view returns (uint256) {
        return _getCostForTokens(amount);
    }

    /// @notice Tokens received for `baseAmount` base coin (no buy fee).
    function getTokensForBase(uint256 baseAmount) external view returns (uint256) {
        return _getTokensForBase(baseAmount);
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
        fee = 0; // No buy fee — platform earns from graduation only
        uint256 baseForTokens = baseAmount;

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

    /// @notice Recover accidentally sent ETH. Only callable by creator.
    function recoverETH() external onlyCreator {
        uint256 bal = address(this).balance;
        if (bal == 0) revert NoETH();
        (bool ok, ) = creator.call{value: bal}("");
        if (!ok) revert TransferFailed();
    }

    receive() external payable {}
}
