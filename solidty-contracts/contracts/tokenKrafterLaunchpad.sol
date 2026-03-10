// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

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
}

interface IUniswapV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

// =============================================================
// BONDING CURVE LIBRARY
// =============================================================

/// @title BondingCurve
/// @notice Pure math for four bonding curve types. Returns cost in base coin (wei)
///         to purchase `amount` tokens from current `supply`. 1e18 precision.
library BondingCurve {
    uint256 constant PRECISION = 1e18;

    /// @notice Linear: price = slope * supply + intercept
    function linearCost(
        uint256 supply,
        uint256 amount,
        uint256 slope,
        uint256 intercept
    ) internal pure returns (uint256) {
        uint256 term1 = (slope * (2 * supply * amount + amount * amount)) / (2 * PRECISION);
        uint256 term2 = (intercept * amount) / PRECISION;
        return term1 + term2;
    }

    /// @notice Square Root: price = coefficient * sqrt(supply)
    function sqrtCost(
        uint256 supply,
        uint256 amount,
        uint256 coefficient
    ) internal pure returns (uint256) {
        uint256 newSupply = supply + amount;
        uint256 priceLow = (coefficient * sqrt(supply)) / PRECISION;
        uint256 priceHigh = (coefficient * sqrt(newSupply)) / PRECISION;
        return ((priceLow + priceHigh) * amount) / (2 * PRECISION);
    }

    /// @notice Quadratic (FOMO): price = coefficient * supply^2
    function quadraticCost(
        uint256 supply,
        uint256 amount,
        uint256 coefficient
    ) internal pure returns (uint256) {
        uint256 newSupply = supply + amount;
        uint256 a2 = (newSupply * newSupply) / PRECISION;
        uint256 ab = (newSupply * supply) / PRECISION;
        uint256 b2 = (supply * supply) / PRECISION;
        uint256 sumSquares = a2 + ab + b2;
        return (coefficient * amount * sumSquares) / (3 * PRECISION * PRECISION);
    }

    /// @notice Exponential Lite: price = base * e^(k * supply)
    function exponentialCost(
        uint256 supply,
        uint256 amount,
        uint256 base_,
        uint256 kFactor
    ) internal pure returns (uint256) {
        uint256 newSupply = supply + amount;
        uint256 priceLow = _approxExp(supply, base_, kFactor);
        uint256 priceHigh = _approxExp(newSupply, base_, kFactor);
        return ((priceLow + priceHigh) * amount) / (2 * PRECISION);
    }

    function _approxExp(uint256 x, uint256 base_, uint256 kFactor) private pure returns (uint256) {
        uint256 kx = (kFactor * x) / PRECISION;
        uint256 kx2 = (kx * kx) / PRECISION;
        return (base_ * (PRECISION + kx + kx2 / 2)) / PRECISION;
    }

    function sqrt(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        uint256 y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
        return y * 1e9;
    }
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

    // ── Enums ──────────────────────────────────────────────────
    enum CurveType { Linear, SquareRoot, Quadratic, Exponential }
    enum LaunchState { Pending, Active, Graduated, Refunding }

    // ── Immutables ─────────────────────────────────────────────
    address public immutable factory;
    address public immutable creator;
    IERC20 public immutable token;
    CurveType public immutable curveType;
    IUniswapV2Router02 public immutable dexRouter;

    uint256 public immutable curveParam1;
    uint256 public immutable curveParam2;

    uint256 public immutable softCap;
    uint256 public immutable hardCap;
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

    mapping(address => uint256) public basePaid;
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
        require(state == LaunchState.Active, "Launch not active");
        _;
    }

    modifier onlyCreator() {
        require(msg.sender == creator, "Only creator");
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
        uint256 softCap_,
        uint256 hardCap_,
        uint256 durationDays_,
        uint256 maxBuyBps_,
        uint256 creatorAllocationBps_,
        uint256 vestingDays_,
        address dexRouter_
    ) {
        require(token_ != address(0), "Invalid token");
        require(softCap_ > 0 && hardCap_ >= softCap_, "Invalid caps");
        require(durationDays_ >= 7 && durationDays_ <= 90, "Duration: 7-90 days");
        require(maxBuyBps_ >= 50 && maxBuyBps_ <= 500, "Max buy: 0.5-5%");
        require(creatorAllocationBps_ <= 500, "Creator alloc: max 5%");
        require(
            vestingDays_ == 0 || vestingDays_ == 30 || vestingDays_ == 60 || vestingDays_ == 90,
            "Vesting: 0, 30, 60, or 90 days"
        );
        require(creatorAllocationBps_ == 0 || vestingDays_ > 0, "Creator alloc requires vesting");

        factory = msg.sender;
        creator = creator_;
        token = IERC20(token_);
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
        vestingCliff = 7 days;

        // Start as Pending — needs token deposit to activate
        state = LaunchState.Pending;
    }

    // ── Deposit & Activate ─────────────────────────────────────

    /// @notice Creator deposits tokens to fund the launch. Once the required amount
    ///         is deposited, the launch activates automatically.
    ///         Creator must approve this contract before calling.
    function depositTokens(uint256 amount) external onlyCreator {
        require(state == LaunchState.Pending, "Not pending");
        require(amount > 0, "Zero amount");

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

    /// @notice Creator can withdraw deposited tokens if launch is still pending
    ///         (not yet activated). Cancels the launch effectively.
    function withdrawPendingTokens() external onlyCreator {
        require(state == LaunchState.Pending, "Not pending");
        uint256 deposited = totalTokensDeposited;
        require(deposited > 0, "Nothing deposited");

        totalTokensDeposited = 0;
        token.safeTransfer(creator, deposited);

        emit CreatorWithdraw(creator, deposited);
    }

    // ── Buy ────────────────────────────────────────────────────

    /// @notice Buy tokens on the bonding curve. Send native coin (ETH/BNB).
    function buy() external payable nonReentrant onlyActive {
        require(msg.value > 0, "Send base coin");
        require(block.timestamp < deadline, "Launch expired");

        uint256 baseSent = msg.value;

        // 1% buy fee
        uint256 fee = (baseSent * BUY_FEE_BPS) / BPS;
        uint256 baseForTokens = baseSent - fee;

        // Calculate tokens from curve
        uint256 tokensOut = _getTokensForBase(baseForTokens);
        require(tokensOut > 0, "Amount too small");

        uint256 remaining = tokensForCurve - tokensSold;
        if (tokensOut > remaining) {
            tokensOut = remaining;
            uint256 actualCost = _getCostForTokens(tokensOut);
            uint256 actualFee = (actualCost * BUY_FEE_BPS) / (BPS - BUY_FEE_BPS);
            uint256 refundAmount = baseSent - actualCost - actualFee;
            fee = actualFee;
            baseForTokens = actualCost;
            if (refundAmount > 0) {
                (bool ok, ) = msg.sender.call{value: refundAmount}("");
                require(ok, "Refund failed");
            }
        }

        // Anti-whale
        require(
            tokensBought[msg.sender] + tokensOut <= maxBuyPerWallet,
            "Exceeds max buy per wallet"
        );

        // Update state
        tokensSold += tokensOut;
        totalBaseRaised += baseForTokens;
        basePaid[msg.sender] += baseForTokens + fee;
        tokensBought[msg.sender] += tokensOut;

        // Transfer tokens to buyer
        token.safeTransfer(msg.sender, tokensOut);

        // Send buy fee to factory (platform)
        if (fee > 0) {
            (bool feeOk, ) = factory.call{value: fee}("");
            require(feeOk, "Fee transfer failed");
        }

        emit TokenBought(msg.sender, tokensOut, baseForTokens + fee, getCurrentPrice());

        // Auto-graduate on hard cap
        if (totalBaseRaised >= hardCap) {
            _graduate();
        }
    }

    // ── Graduate ───────────────────────────────────────────────

    /// @notice Graduate to DEX. Creator can call after soft cap, or auto on hard cap.
    function graduate() external nonReentrant onlyActive {
        require(totalBaseRaised >= softCap, "Soft cap not reached");
        require(msg.sender == creator || totalBaseRaised >= hardCap, "Only creator can graduate early");
        _graduate();
    }

    function _graduate() internal {
        state = LaunchState.Graduated;
        graduationTimestamp = block.timestamp;

        // Platform fees: 3% of base + 3% of LP tokens
        uint256 platformBaseFee = (totalBaseRaised * PLATFORM_FEE_BPS) / BPS;
        uint256 platformTokenFee = (tokensForLP * PLATFORM_FEE_BPS) / BPS;
        uint256 baseForLP = totalBaseRaised - platformBaseFee;
        uint256 tokensForDexLP = tokensForLP - platformTokenFee;

        // Send platform fees
        address platformWallet = LaunchpadFactory(factory).platformWallet();

        (bool baseFeeOk, ) = platformWallet.call{value: platformBaseFee}("");
        require(baseFeeOk, "Platform base fee failed");

        if (platformTokenFee > 0) {
            token.safeTransfer(platformWallet, platformTokenFee);
        }

        // Approve router and add liquidity
        token.approve(address(dexRouter), tokensForDexLP);

        (uint256 amountToken, uint256 amountETH, ) = dexRouter.addLiquidityETH{value: baseForLP}(
            address(token),
            tokensForDexLP,
            (tokensForDexLP * 95) / 100,
            (baseForLP * 95) / 100,
            address(0xdead),               // Burn LP tokens — permanent liquidity
            block.timestamp + 300
        );

        // Refund any unused base from slippage
        uint256 unusedBase = baseForLP - amountETH;
        if (unusedBase > 0) {
            (bool refundOk, ) = platformWallet.call{value: unusedBase}("");
            require(refundOk, "Unused base refund failed");
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

        address weth = dexRouter.WETH();
        address dexFactory = dexRouter.factory();
        address pair = IUniswapV2Factory(dexFactory).getPair(address(token), weth);

        emit Graduated(pair, amountETH, amountToken, platformBaseFee, platformTokenFee);
    }

    // ── Refund ─────────────────────────────────────────────────

    /// @notice Enable refunds if deadline passes without soft cap.
    function enableRefunds() external {
        require(state == LaunchState.Active, "Not active");
        require(block.timestamp >= deadline, "Deadline not reached");
        require(totalBaseRaised < softCap, "Soft cap was reached");
        state = LaunchState.Refunding;
        emit RefundingEnabled();
    }

    /// @notice Claim refund. Returns base coin to buyer. Buyer must approve
    ///         token transfer back (or they forfeit tokens and still get base back).
    function refund() external nonReentrant {
        require(state == LaunchState.Refunding, "Refunds not enabled");
        uint256 paid = basePaid[msg.sender];
        require(paid > 0, "Nothing to refund");

        uint256 buyerTokens = tokensBought[msg.sender];

        basePaid[msg.sender] = 0;
        tokensBought[msg.sender] = 0;

        // Try to reclaim tokens (best effort — buyer might have transferred them)
        if (buyerTokens > 0) {
            uint256 balance = token.balanceOf(msg.sender);
            uint256 allowance = token.allowance(msg.sender, address(this));
            uint256 toReturn = Math.min(buyerTokens, Math.min(balance, allowance));
            if (toReturn > 0) {
                token.safeTransferFrom(msg.sender, address(this), toReturn);
            }
        }

        // Full refund of base coin
        (bool ok, ) = msg.sender.call{value: paid}("");
        require(ok, "Refund failed");

        emit Refunded(msg.sender, paid);
    }

    /// @notice After refunding completes, creator can withdraw remaining tokens.
    function creatorWithdrawAfterRefund() external onlyCreator {
        require(state == LaunchState.Refunding, "Not refunding");
        uint256 balance = token.balanceOf(address(this));
        require(balance > 0, "No tokens");
        token.safeTransfer(creator, balance);
        emit CreatorWithdraw(creator, balance);
    }

    // ── Creator Vesting ────────────────────────────────────────

    /// @notice Claim vested creator tokens after graduation.
    function claimCreatorTokens() external onlyCreator {
        require(state == LaunchState.Graduated, "Not graduated");
        require(creatorTotalTokens > 0, "No allocation");

        uint256 elapsed = block.timestamp - graduationTimestamp;
        require(elapsed >= vestingCliff, "Cliff not reached");

        uint256 vestedTime = elapsed - vestingCliff;
        uint256 vested;
        if (vestedTime >= vestingDuration) {
            vested = creatorTotalTokens;
        } else {
            vested = (creatorTotalTokens * vestedTime) / vestingDuration;
        }

        uint256 claimable = vested - creatorClaimed;
        require(claimable > 0, "Nothing to claim");

        creatorClaimed += claimable;
        token.safeTransfer(creator, claimable);

        emit CreatorClaimed(creator, claimable);
    }

    // ── View Functions ─────────────────────────────────────────

    /// @notice Current token price on the curve (cost for 1 full token).
    function getCurrentPrice() public view returns (uint256) {
        return _getCostForTokens(1e18);
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
        uint256 currentPrice_
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
            state == LaunchState.Active || state == LaunchState.Pending ? getCurrentPrice() : 0
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

    receive() external payable {}
}

// =============================================================
// LAUNCHPAD FACTORY
// =============================================================

/// @title LaunchpadFactory
/// @notice Deploys LaunchInstance contracts for tokens created by TokenKrafter's TokenFactory.
contract LaunchpadFactory is Ownable, ReentrancyGuard {

    address public platformWallet;
    address public dexRouter;

    LaunchInstance[] public launches;
    mapping(address => LaunchInstance[]) public creatorLaunches;
    mapping(address => LaunchInstance) public tokenToLaunch;

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

    constructor(
        address platformWallet_,
        address dexRouter_
    ) Ownable(msg.sender) {
        require(platformWallet_ != address(0), "Invalid platform wallet");
        require(dexRouter_ != address(0), "Invalid router");
        platformWallet = platformWallet_;
        dexRouter = dexRouter_;

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
    /// @param token_ Address of the token (must be created via TokenFactory)
    /// @param totalTokens_ Total tokens to allocate (curve + LP + creator vesting)
    /// @param curveType_ Bonding curve type
    /// @param softCap_ Soft cap in base coin (wei)
    /// @param hardCap_ Hard cap in base coin (wei)
    /// @param durationDays_ Days until deadline (7-90)
    /// @param maxBuyBps_ Max buy per wallet in BPS of curve supply (50-500)
    /// @param creatorAllocationBps_ Creator token allocation in BPS (0-500)
    /// @param vestingDays_ Creator vesting duration (0, 30, 60, 90)
    function createLaunch(
        address token_,
        uint256 totalTokens_,
        LaunchInstance.CurveType curveType_,
        uint256 softCap_,
        uint256 hardCap_,
        uint256 durationDays_,
        uint256 maxBuyBps_,
        uint256 creatorAllocationBps_,
        uint256 vestingDays_
    ) external nonReentrant returns (address) {
        require(token_ != address(0), "Invalid token");
        require(totalTokens_ > 0, "Zero tokens");
        require(address(tokenToLaunch[token_]) == address(0), "Token already has a launch");

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
            dexRouter
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
        uint256 vestingDays_
    ) external nonReentrant returns (address) {
        require(token_ != address(0), "Invalid token");
        require(totalTokens_ > 0, "Zero tokens");
        require(address(tokenToLaunch[token_]) == address(0), "Token already has a launch");

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
            dexRouter
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

        return address(instance);
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

    // ── Admin ──────────────────────────────────────────────────

    function setPlatformWallet(address wallet_) external onlyOwner {
        require(wallet_ != address(0), "Invalid address");
        platformWallet = wallet_;
        emit PlatformWalletUpdated(wallet_);
    }

    function setDexRouter(address router_) external onlyOwner {
        require(router_ != address(0), "Invalid address");
        dexRouter = router_;
        emit DexRouterUpdated(router_);
    }

    function setCurveDefaults(CurveDefaults calldata defaults_) external onlyOwner {
        curveDefaults = defaults_;
        emit CurveDefaultsUpdated();
    }

    // ── Internal ───────────────────────────────────────────────

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
