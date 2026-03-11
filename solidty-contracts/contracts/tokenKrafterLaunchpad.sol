// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

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

    uint256 public immutable curveParam1;
    uint256 public immutable curveParam2;

    uint256 public immutable softCap;    // in USDT
    uint256 public immutable hardCap;    // in USDT
    uint256 public immutable deadline;
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
    uint256 public constant PLATFORM_FEE_BPS = 300;  // 3%
    uint256 public constant BPS = 10000;
    uint256 public constant BUY_FEE_BPS = 100;       // 1% fee on each buy

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
        address usdt_
    ) {
        if (token_ == address(0)) revert InvalidToken();
        if (usdt_ == address(0)) revert InvalidUsdt();
        if (softCap_ == 0 || hardCap_ < softCap_) revert InvalidCaps();
        if (durationDays_ < 7 || durationDays_ > 90) revert InvalidDuration();
        if (maxBuyBps_ < 50 || maxBuyBps_ > 500) revert InvalidMaxBuy();
        if (creatorAllocationBps_ > 500) revert InvalidCreatorAlloc();
        if (vestingDays_ != 0 && vestingDays_ != 30 && vestingDays_ != 60 && vestingDays_ != 90) revert InvalidVesting();
        if (creatorAllocationBps_ != 0 && vestingDays_ == 0) revert CreatorAllocRequiresVesting();

        factory = payable(msg.sender);
        creator = creator_;
        token = IERC20(token_);
        usdt = IERC20(usdt_);
        curveType = curveType_;
        curveParam1 = curveParam1_;
        curveParam2 = curveParam2_;
        softCap = softCap_;
        hardCap = hardCap_;
        deadline = block.timestamp + (durationDays_ * 1 days);
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

        maxBuyPerWallet = (curveTokens * maxBuyBps_) / BPS;
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
            block.timestamp
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
                amount, minUsdtOut, directPath, address(this), block.timestamp
            ) returns (uint256[] memory amounts) {
                usdtAmount = amounts[amounts.length - 1];
            } catch {
                // Try via WETH
                address[] memory wethPath = new address[](3);
                wethPath[0] = paymentToken;
                wethPath[1] = dexRouter.WETH();
                wethPath[2] = address(usdt);
                uint256[] memory amounts = dexRouter.swapExactTokensForTokens(
                    amount, minUsdtOut, wethPath, address(this), block.timestamp
                );
                usdtAmount = amounts[amounts.length - 1];
            }
        }

        _processBuy(msg.sender, usdtAmount, minTokensOut);
    }

    /// @dev Internal buy logic. All amounts are in USDT after conversion.
    function _processBuy(address buyer, uint256 usdtAmount, uint256 minTokensOut) internal {
        // 1% buy fee
        uint256 fee = (usdtAmount * BUY_FEE_BPS) / BPS;
        uint256 baseForTokens = usdtAmount - fee;

        // Calculate tokens from curve
        uint256 tokensOut = _getTokensForBase(baseForTokens);
        if (tokensOut == 0) revert AmountTooSmall();

        uint256 remaining = tokensForCurve - tokensSold;
        if (tokensOut > remaining) {
            tokensOut = remaining;
            uint256 actualCost = _getCostForTokens(tokensOut);
            uint256 actualFee = (actualCost * BUY_FEE_BPS) / (BPS - BUY_FEE_BPS);
            uint256 refundUsdt = usdtAmount - actualCost - actualFee;
            fee = actualFee;
            baseForTokens = actualCost;
            if (refundUsdt > 0) {
                usdt.safeTransfer(buyer, refundUsdt);
            }
        }

        // Check minTokensOut AFTER capping to remaining supply
        if (tokensOut < minTokensOut) revert InsufficientTokensOut();

        // Anti-whale
        if (tokensBought[buyer] + tokensOut > maxBuyPerWallet) revert ExceedsMaxBuy();

        // Update state
        tokensSold += tokensOut;
        totalBaseRaised += baseForTokens;
        basePaid[buyer] += baseForTokens;  // only track refundable USDT base (fee is non-refundable)
        tokensBought[buyer] += tokensOut;

        // Transfer tokens to buyer
        token.safeTransfer(buyer, tokensOut);

        // Send buy fee to factory (platform) in USDT
        if (fee > 0) {
            usdt.safeTransfer(factory, fee);
        }

        emit TokenBought(buyer, tokensOut, baseForTokens + fee, getCurrentPrice());

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
        address platformWallet = LaunchpadFactory(factory).platformWallet();

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
            (tokensForDexLP * 98) / 100,
            (usdtForLP * 98) / 100,
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
        try LaunchpadFactory(factory).recordGraduation(address(this)) {} catch {}
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

        // Refund USDT (excluding buy fee — fee is non-refundable)
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
        try LaunchpadFactory(factory).clearTokenLaunch(address(token)) {} catch {}

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

    /// @notice Tokens received for `baseAmount` base coin (after fee).
    function getTokensForBase(uint256 baseAmount) external view returns (uint256) {
        uint256 fee = (baseAmount * BUY_FEE_BPS) / BPS;
        return _getTokensForBase(baseAmount - fee);
    }

    /// @notice Preview a buy: returns tokens out, fee, and price impact for a given base amount.
    function previewBuy(uint256 baseAmount) external view returns (
        uint256 tokensOut,
        uint256 fee,
        uint256 priceImpactBps
    ) {
        if (baseAmount == 0 || state != LaunchState.Active) return (0, 0, 0);
        fee = (baseAmount * BUY_FEE_BPS) / BPS;
        uint256 baseForTokens = baseAmount - fee;
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
        address usdt_
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
            address(usdt)
        );
    }

    // ── Internal Curve Math ────────────────────────────────────

    function _getCostForTokens(uint256 amount) internal view returns (uint256) {
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

    function _getTokensForBase(uint256 baseAmount) internal view returns (uint256) {
        if (baseAmount == 0) return 0;
        uint256 remaining = tokensForCurve - tokensSold;
        if (remaining == 0) return 0;

        uint256 low = 0;
        uint256 high = remaining;
        uint256 bestAmount = 0;

        for (uint256 i = 0; i < 128; i++) {
            if (low > high) break;
            uint256 mid = (low + high) / 2;
            if (mid == 0) break;
            uint256 cost = _getCostForTokens(mid);
            if (cost <= baseAmount) {
                bestAmount = mid;
                low = mid + 1;
            } else {
                if (mid == 0) break;
                high = mid - 1;
            }
        }
        return bestAmount;
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

// =============================================================
// LAUNCHPAD FACTORY
// =============================================================

/// @title LaunchpadFactory
/// @notice Deploys LaunchInstance contracts for tokens created by TokenKrafter's TokenFactory.
contract LaunchpadFactory is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Custom Errors ───────────────────────────────────────────
    error InvalidAddress();
    error InvalidUsdt();
    error InvalidToken();
    error ZeroTokens();
    error TokenAlreadyHasLaunch();
    error InvalidCurveParam();
    error OnlyTokenFactory();
    error InvalidRange();
    error MaxDaysExceeded();
    error AlreadySupported();
    error NotSupported();
    error NoBalance();
    error WithdrawFailed();
    error UnsupportedPaymentToken();
    error CannotDetermineFee();
    error InsufficientNativePayment();
    error RefundFailed();
    error NotTokenOwner();
    error NotRegisteredLaunch();
    error OnlyLaunch();
    error NotGraduated();
    error NotRefunding();

    address public platformWallet;
    address public dexRouter;
    address public tokenFactory;  // Authorized TokenFactory for createLaunchFor

    // ── Launch Fee ──────────────────────────────────────────
    uint256 public launchFee;                              // Fee in USDT base units (e.g. 50e18 = $50)
    address[] internal _supportedPaymentTokens;            // address(0) = native coin
    mapping(address => bool) public isPaymentSupported;
    mapping(address => address) public tokenPriceFeeds;    // optional: for price conversion

    // ── DEX for fee conversion ──────────────────────────────
    address public usdt;                                   // USDT address (base unit for fee)

    LaunchInstance[] public launches;
    mapping(address => LaunchInstance[]) public creatorLaunches;
    mapping(address => LaunchInstance) public tokenToLaunch;

    // ── Daily Stats ─────────────────────────────────────────────
    struct LaunchDayStats {
        uint256 created;
        uint256 graduated;
        uint256 totalFeeUsdt;
    }

    /// @notice Daily launch stats keyed by day number (block.timestamp / 86400).
    mapping(uint256 => LaunchDayStats) public dailyLaunchStats;

    /// @notice Cumulative total launch fee earned in USDT equivalent.
    uint256 public totalLaunchFeeEarnedUsdt;

    struct CurveDefaults {
        uint256 linearSlope;
        uint256 linearIntercept;
        uint256 sqrtCoefficient;
        uint256 quadraticCoefficient;
        uint256 expBase;
        uint256 expKFactor;
    }
    CurveDefaults public curveDefaults;

    event LaunchCreated(
        address indexed launch,
        address indexed token,
        address indexed creator,
        LaunchInstance.CurveType curveType,
        uint256 softCap,
        uint256 hardCap,
        uint256 totalTokens
    );
    event PlatformWalletUpdated(address newWallet);
    event DexRouterUpdated(address newRouter);
    event CurveDefaultsUpdated();
    event TokenFactoryUpdated(address newFactory);
    event LaunchFeeUpdated(uint256 newFee);
    event PaymentTokenAdded(address token);
    event PaymentTokenRemoved(address token);
    event LaunchFeePaid(address indexed payer, address indexed paymentToken, uint256 amount);

    constructor(
        address platformWallet_,
        address dexRouter_,
        address usdt_
    ) Ownable(msg.sender) {
        if (platformWallet_ == address(0)) revert InvalidAddress();
        if (dexRouter_ == address(0)) revert InvalidAddress();
        if (usdt_ == address(0)) revert InvalidUsdt();
        platformWallet = platformWallet_;
        dexRouter = dexRouter_;
        usdt = usdt_;

        // Native coin is supported by default
        _supportedPaymentTokens.push(address(0));
        isPaymentSupported[address(0)] = true;

        curveDefaults = CurveDefaults({
            linearSlope: 1e9,
            linearIntercept: 1e12,
            sqrtCoefficient: 1e14,
            quadraticCoefficient: 1e6,
            expBase: 1e12,
            expKFactor: 1e12
        });
    }

    /// @notice Create a launch for an existing TokenKrafter token.
    ///         After calling this, the creator must call depositTokens() on the
    ///         returned LaunchInstance to fund and activate the launch.
    function createLaunch(
        address token_,
        uint256 totalTokens_,
        LaunchInstance.CurveType curveType_,
        uint256 softCap_,
        uint256 hardCap_,
        uint256 durationDays_,
        uint256 maxBuyBps_,
        uint256 creatorAllocationBps_,
        uint256 vestingDays_,
        address paymentToken_
    ) external payable nonReentrant returns (address) {
        if (token_ == address(0)) revert InvalidToken();
        if (totalTokens_ == 0) revert ZeroTokens();
        if (address(tokenToLaunch[token_]) != address(0)) revert TokenAlreadyHasLaunch();
        // Only token owner can create a launch (prevents griefing by occupying tokenToLaunch)
        if (IOwnable(token_).owner() != msg.sender) revert NotTokenOwner();

        // Collect launch fee
        _collectLaunchFee(msg.sender, paymentToken_);

        (uint256 param1, uint256 param2) = _getCurveParams(curveType_);

        LaunchInstance instance = new LaunchInstance(
            msg.sender,
            token_,
            totalTokens_,
            curveType_,
            param1,
            param2,
            softCap_,
            hardCap_,
            durationDays_,
            maxBuyBps_,
            creatorAllocationBps_,
            vestingDays_,
            dexRouter,
            usdt
        );

        launches.push(instance);
        creatorLaunches[msg.sender].push(instance);
        tokenToLaunch[token_] = instance;

        emit LaunchCreated(
            address(instance),
            token_,
            msg.sender,
            curveType_,
            softCap_,
            hardCap_,
            totalTokens_
        );

        _recordLaunchCreated();
        return address(instance);
    }

    /// @notice Create a launch with custom curve parameters.
    function createLaunchCustomCurve(
        address token_,
        uint256 totalTokens_,
        LaunchInstance.CurveType curveType_,
        uint256 curveParam1_,
        uint256 curveParam2_,
        uint256 softCap_,
        uint256 hardCap_,
        uint256 durationDays_,
        uint256 maxBuyBps_,
        uint256 creatorAllocationBps_,
        uint256 vestingDays_,
        address paymentToken_
    ) external payable nonReentrant returns (address) {
        if (token_ == address(0)) revert InvalidToken();
        if (totalTokens_ == 0) revert ZeroTokens();
        if (address(tokenToLaunch[token_]) != address(0)) revert TokenAlreadyHasLaunch();
        if (curveParam1_ == 0) revert InvalidCurveParam();
        // Only token owner can create a launch (prevents griefing by occupying tokenToLaunch)
        if (IOwnable(token_).owner() != msg.sender) revert NotTokenOwner();

        // Collect launch fee
        _collectLaunchFee(msg.sender, paymentToken_);

        LaunchInstance instance = new LaunchInstance(
            msg.sender,
            token_,
            totalTokens_,
            curveType_,
            curveParam1_,
            curveParam2_,
            softCap_,
            hardCap_,
            durationDays_,
            maxBuyBps_,
            creatorAllocationBps_,
            vestingDays_,
            dexRouter,
            usdt
        );

        launches.push(instance);
        creatorLaunches[msg.sender].push(instance);
        tokenToLaunch[token_] = instance;

        emit LaunchCreated(
            address(instance),
            token_,
            msg.sender,
            curveType_,
            softCap_,
            hardCap_,
            totalTokens_
        );

        _recordLaunchCreated();
        return address(instance);
    }

    /// @notice Create a launch on behalf of a creator. Only callable by the authorized TokenFactory.
    ///         Used by TokenFactory.createTokenAndLaunch() for one-click token creation + launch.
    function createLaunchFor(
        address creator_,
        address token_,
        uint256 totalTokens_,
        uint8 curveType_,
        uint256 softCap_,
        uint256 hardCap_,
        uint256 durationDays_,
        uint256 maxBuyBps_,
        uint256 creatorAllocationBps_,
        uint256 vestingDays_,
        address paymentToken_
    ) external payable nonReentrant returns (address) {
        if (msg.sender != tokenFactory) revert OnlyTokenFactory();
        if (token_ == address(0)) revert InvalidToken();
        if (totalTokens_ == 0) revert ZeroTokens();
        if (address(tokenToLaunch[token_]) != address(0)) revert TokenAlreadyHasLaunch();

        // Collect launch fee (forwarded from TokenFactory)
        _collectLaunchFee(creator_, paymentToken_);

        LaunchInstance.CurveType ct = LaunchInstance.CurveType(curveType_);
        (uint256 param1, uint256 param2) = _getCurveParams(ct);

        LaunchInstance instance = new LaunchInstance(
            creator_,
            token_,
            totalTokens_,
            ct,
            param1,
            param2,
            softCap_,
            hardCap_,
            durationDays_,
            maxBuyBps_,
            creatorAllocationBps_,
            vestingDays_,
            dexRouter,
            usdt
        );

        launches.push(instance);
        creatorLaunches[creator_].push(instance);
        tokenToLaunch[token_] = instance;

        emit LaunchCreated(
            address(instance),
            token_,
            creator_,
            ct,
            softCap_,
            hardCap_,
            totalTokens_
        );

        _recordLaunchCreated();
        return address(instance);
    }

    /// @notice Forwards a deposit notification to a LaunchInstance. Only callable by the TokenFactory.
    function notifyDeposit(address launch_, uint256 amount) external {
        if (msg.sender != tokenFactory) revert OnlyTokenFactory();
        LaunchInstance(payable(launch_)).notifyDeposit(amount);
    }

    // ── View ───────────────────────────────────────────────────

    function totalLaunches() external view returns (uint256) {
        return launches.length;
    }

    function getCreatorLaunches(address creator_) external view returns (LaunchInstance[] memory) {
        return creatorLaunches[creator_];
    }

    function getActiveLaunches(uint256 offset, uint256 limit)
        external view returns (address[] memory result, uint256 total)
    {
        total = launches.length;
        uint256 end = offset + limit > total ? total : offset + limit;

        uint256 count = 0;
        for (uint256 i = offset; i < end; i++) {
            LaunchInstance.LaunchState s = launches[i].state();
            if (s == LaunchInstance.LaunchState.Active || s == LaunchInstance.LaunchState.Pending) count++;
        }

        result = new address[](count);
        uint256 idx = 0;
        for (uint256 i = offset; i < end; i++) {
            LaunchInstance.LaunchState s = launches[i].state();
            if (s == LaunchInstance.LaunchState.Active || s == LaunchInstance.LaunchState.Pending) {
                result[idx++] = address(launches[i]);
            }
        }
    }

    /// @notice Returns daily launch stats for a range of days.
    function getDailyLaunchStats(uint256 fromDay, uint256 toDay)
        external view returns (LaunchDayStats[] memory stats)
    {
        if (toDay < fromDay) revert InvalidRange();
        uint256 count = toDay - fromDay + 1;
        if (count > 365) revert MaxDaysExceeded();
        stats = new LaunchDayStats[](count);
        for (uint256 i; i < count;) {
            stats[i] = dailyLaunchStats[fromDay + i];
            unchecked { ++i; }
        }
    }

    // ── Admin ──────────────────────────────────────────────────

    function setPlatformWallet(address wallet_) external onlyOwner {
        if (wallet_ == address(0)) revert InvalidAddress();
        platformWallet = wallet_;
        emit PlatformWalletUpdated(wallet_);
    }

    function setDexRouter(address router_) external onlyOwner {
        if (router_ == address(0)) revert InvalidAddress();
        dexRouter = router_;
        emit DexRouterUpdated(router_);
    }

    function setCurveDefaults(CurveDefaults calldata defaults_) external onlyOwner {
        curveDefaults = defaults_;
        emit CurveDefaultsUpdated();
    }

    function setTokenFactory(address factory_) external onlyOwner {
        tokenFactory = factory_;
        emit TokenFactoryUpdated(factory_);
    }

    // ── Fee Management ───────────────────────────────────────

    function setLaunchFee(uint256 fee_) external onlyOwner {
        launchFee = fee_;
        emit LaunchFeeUpdated(fee_);
    }

    function setUsdt(address usdt_) external onlyOwner {
        if (usdt_ == address(0)) revert InvalidUsdt();
        usdt = usdt_;
    }

    function addPaymentToken(address token_) external onlyOwner {
        if (isPaymentSupported[token_]) revert AlreadySupported();
        _supportedPaymentTokens.push(token_);
        isPaymentSupported[token_] = true;
        emit PaymentTokenAdded(token_);
    }

    function removePaymentToken(address token_) external onlyOwner {
        if (!isPaymentSupported[token_]) revert NotSupported();
        isPaymentSupported[token_] = false;
        // Remove from array
        for (uint256 i = 0; i < _supportedPaymentTokens.length; i++) {
            if (_supportedPaymentTokens[i] == token_) {
                _supportedPaymentTokens[i] = _supportedPaymentTokens[_supportedPaymentTokens.length - 1];
                _supportedPaymentTokens.pop();
                break;
            }
        }
        emit PaymentTokenRemoved(token_);
    }

    function getSupportedPaymentTokens() external view returns (address[] memory) {
        return _supportedPaymentTokens;
    }

    /// @notice Get the launch fee amount in a specific payment token.
    function getLaunchFee(address paymentToken) external view returns (uint256) {
        if (launchFee == 0) return 0;
        return _convertFee(launchFee, paymentToken);
    }

    /// @notice Withdraw collected fees. Owner only.
    function withdrawFees(address token_) external onlyOwner {
        if (token_ == address(0)) {
            uint256 bal = address(this).balance;
            if (bal == 0) revert NoBalance();
            (bool ok, ) = owner().call{value: bal}("");
            if (!ok) revert WithdrawFailed();
        } else {
            uint256 bal = IERC20(token_).balanceOf(address(this));
            if (bal == 0) revert NoBalance();
            SafeERC20.safeTransfer(IERC20(token_), owner(), bal);
        }
    }

    // ── Internal ───────────────────────────────────────────────

    /// @dev Collect launch fee from payer. Returns the fee amount collected.
    ///      For native payments, excess is refunded to the payer (not msg.sender,
    ///      since msg.sender may be TokenFactory forwarding on behalf of the user).
    function _collectLaunchFee(address payer, address paymentToken) internal returns (uint256 amount) {
        if (launchFee == 0) return 0;

        if (!isPaymentSupported[paymentToken]) revert UnsupportedPaymentToken();

        amount = _convertFee(launchFee, paymentToken);
        if (amount == 0) revert CannotDetermineFee();

        if (paymentToken == address(0)) {
            if (msg.value < amount) revert InsufficientNativePayment();
            uint256 excess = msg.value - amount;
            if (excess > 0) {
                // Refund excess to the actual payer (not msg.sender which may be TokenFactory)
                (bool ok, ) = payer.call{value: excess}("");
                if (!ok) revert RefundFailed();
            }
        } else {
            // Pull from msg.sender (for direct calls msg.sender == payer;
            // for createLaunchFor, msg.sender is TokenFactory which relays the fee)
            IERC20(paymentToken).safeTransferFrom(msg.sender, address(this), amount);
        }

        // Track daily stats
        uint256 day = block.timestamp / 86400;
        uint256 feeUsdt = paymentToken == usdt ? amount : launchFee;
        dailyLaunchStats[day].totalFeeUsdt += feeUsdt;
        totalLaunchFeeEarnedUsdt += feeUsdt;

        emit LaunchFeePaid(payer, paymentToken, amount);
    }

    /// @dev Record a launch creation in daily stats.
    function _recordLaunchCreated() internal {
        uint256 day = block.timestamp / 86400;
        dailyLaunchStats[day].created++;
    }

    /// @notice Clear tokenToLaunch mapping after a failed launch (refund completed).
    ///         Only callable by the registered launch contract for that token.
    function clearTokenLaunch(address token_) external {
        LaunchInstance launch = tokenToLaunch[token_];
        if (address(launch) == address(0)) revert NotRegisteredLaunch();
        if (msg.sender != address(launch)) revert OnlyLaunch();
        if (launch.state() != LaunchInstance.LaunchState.Refunding) revert NotRefunding();
        delete tokenToLaunch[token_];
    }

    /// @notice Record a graduation. Called by LaunchInstance on graduation.
    ///         Only callable by registered launch contracts that have actually graduated.
    function recordGraduation(address launch_) external {
        if (address(tokenToLaunch[address(LaunchInstance(payable(launch_)).token())]) != launch_) revert NotRegisteredLaunch();
        if (msg.sender != launch_) revert OnlyLaunch();
        if (LaunchInstance(payable(launch_)).state() != LaunchInstance.LaunchState.Graduated) revert NotGraduated();
        uint256 day = block.timestamp / 86400;
        dailyLaunchStats[day].graduated++;
    }

    /// @dev Convert USDT-denominated fee to the equivalent amount in paymentToken.
    function _convertFee(uint256 baseFeeUsdt, address paymentToken) internal view returns (uint256) {
        // If paying in USDT, return as-is
        if (paymentToken == usdt) return baseFeeUsdt;

        // Use DEX to get conversion rate
        IUniswapV2Router02 router = IUniswapV2Router02(dexRouter);
        address weth = router.WETH();

        if (paymentToken == address(0)) {
            // Native coin: USDT → WETH path
            address[] memory path = new address[](2);
            path[0] = usdt;
            path[1] = weth;
            try router.getAmountsOut(baseFeeUsdt, path) returns (uint256[] memory amounts) {
                return amounts[1];
            } catch {
                return 0;
            }
        } else {
            // ERC20: USDT → paymentToken (try direct, then via WETH)
            address[] memory directPath = new address[](2);
            directPath[0] = usdt;
            directPath[1] = paymentToken;
            try router.getAmountsOut(baseFeeUsdt, directPath) returns (uint256[] memory amounts) {
                return amounts[1];
            } catch {
                // Try via WETH
                address[] memory path = new address[](3);
                path[0] = usdt;
                path[1] = weth;
                path[2] = paymentToken;
                try router.getAmountsOut(baseFeeUsdt, path) returns (uint256[] memory amounts) {
                    return amounts[2];
                } catch {
                    return 0;
                }
            }
        }
    }

    function _getCurveParams(LaunchInstance.CurveType curveType_)
        internal view returns (uint256 param1, uint256 param2)
    {
        if (curveType_ == LaunchInstance.CurveType.Linear) {
            return (curveDefaults.linearSlope, curveDefaults.linearIntercept);
        } else if (curveType_ == LaunchInstance.CurveType.SquareRoot) {
            return (curveDefaults.sqrtCoefficient, 0);
        } else if (curveType_ == LaunchInstance.CurveType.Quadratic) {
            return (curveDefaults.quadraticCoefficient, 0);
        } else {
            return (curveDefaults.expBase, curveDefaults.expKFactor);
        }
    }

    receive() external payable {}
}
