// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";

import "./LaunchInstance.sol";
import "./shared/IAffiliate.sol";

// IUniswapV2Router02 and IOwnable are imported from LaunchInstance.sol

// =============================================================
// LAUNCHPAD FACTORY
// =============================================================

/// @notice Creates LaunchInstance clones. Fees are USDT-only — the
///         PlatformRouter handles all input-token swapping before calling
///         this contract, so the factory is intentionally unaware of any
///         payment token besides USDT.
contract LaunchpadFactory is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Custom errors ──────────────────────────────────────────
    error InvalidAddress();
    error InvalidToken();
    error InvalidUsdt();
    error InvalidCurveParam();
    error InvalidRange();
    error ZeroTokens();
    error MaxDaysExceeded();
    error NotLaunchCreator();
    error NotRegisteredLaunch();
    error NotGraduated();
    error NotRefunding();
    error TokenAlreadyHasLaunch();
    error WithdrawFailed();
    error NoBalance();
    error OnlyLaunch();
    error OnlyAuthorizedRouter();

    // ── Structs ────────────────────────────────────────────────

    struct CurveDefaults {
        uint256 linearSlope;
        uint256 linearIntercept;
        uint256 sqrtCoefficient;
        uint256 quadraticCoefficient;
        uint256 expBase;
        uint256 expKFactor;
    }

    struct LaunchDayStats {
        uint256 created;
        uint256 graduated;
        uint256 totalFeeUsdt;
    }

    // ── Events ─────────────────────────────────────────────────

    event LaunchCreated(
        address indexed launch,
        address indexed token,
        address indexed creator,
        LaunchInstance.CurveType curveType,
        uint256 softCap,
        uint256 hardCap,
        uint256 totalTokens,
        uint256 param1,
        uint256 param2
    );
    event PlatformWalletUpdated(address newWallet);
    event DexRouterUpdated(address newRouter);
    event CurveDefaultsUpdated();
    event LaunchFeeUpdated(uint256 newFee);
    event LaunchFeePaid(address indexed payer, uint256 amount);
    event AuthorizedRouterUpdated(address newRouter);

    // ── State variables ────────────────────────────────────────

    address public platformWallet;
    address public dexRouter;
    address public usdt;
    address public launchImplementation;

    uint256 public launchFee;

    LaunchInstance[] public launches;
    mapping(address => LaunchInstance[]) public creatorLaunches;
    mapping(address => LaunchInstance) public tokenToLaunch;

    CurveDefaults public curveDefaults;

    mapping(uint256 => LaunchDayStats) public dailyLaunchStats;
    uint256 public totalLaunchFeeEarnedUsdt;

    address public authorizedRouter;

    /// @notice Shared Affiliate contract reporters across the platform write
    ///         to. address(0) disables affiliate accrual on launch buys.
    address public affiliate;
    event AffiliateUpdated(address indexed previous, address indexed current);

    /// @notice Owner-only. Points launches at a (new) Affiliate contract.
    ///         Per-launch instances read this dynamically at fee time.
    function setAffiliate(address aff) external onlyOwner {
        emit AffiliateUpdated(affiliate, aff);
        affiliate = aff;
    }

    // ── Constructor ────────────────────────────────────────────

    constructor(
        address platformWallet_,
        address dexRouter_,
        address usdt_,
        address launchImpl_
    ) Ownable(msg.sender) {
        if (platformWallet_ == address(0)) revert InvalidAddress();
        if (dexRouter_ == address(0)) revert InvalidAddress();
        if (usdt_ == address(0)) revert InvalidUsdt();
        if (launchImpl_ == address(0)) revert InvalidAddress();

        launchImplementation = launchImpl_;
        platformWallet = platformWallet_;
        dexRouter = dexRouter_;
        usdt = usdt_;

        // Default launch fee: $10 — small friction filter against spam launches.
        // Admin can setLaunchFee() later. Denominated in USDT smallest units.
        uint8 usdtDec = IERC20Metadata(usdt_).decimals();
        launchFee = 10 * 10 ** usdtDec;

        // Default curve parameters
        curveDefaults = CurveDefaults({
            linearSlope: 1e9,
            linearIntercept: 1e12,
            sqrtCoefficient: 1e14,
            quadraticCoefficient: 1e6,
            expBase: 1e12,
            expKFactor: 1e12
        });
    }

    // ── Internal helpers ───────────────────────────────────────

    /// @dev Pulls the launch fee in USDT from msg.sender (creator on direct
    ///      calls, router on routerCreateLaunch — router is responsible for
    ///      pre-swapping the user's input token to USDT).
    function _collectLaunchFee(address payer) internal {
        if (launchFee == 0) return;

        IERC20(usdt).safeTransferFrom(msg.sender, address(this), launchFee);

        uint256 day = block.timestamp / 1 days;
        dailyLaunchStats[day].totalFeeUsdt += launchFee;
        totalLaunchFeeEarnedUsdt += launchFee;

        emit LaunchFeePaid(payer, launchFee);
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
        } else if (curveType_ == LaunchInstance.CurveType.Exponential) {
            return (curveDefaults.expBase, curveDefaults.expKFactor);
        }
        return (0, 0);
    }

    /// @dev Shared logic for deploying a LaunchInstance and recording it.
    function _createLaunchInternal(
        address creator_,
        address token_,
        uint256 totalTokens_,
        LaunchInstance.CurveType curveType_,
        uint256 param1_,
        uint256 param2_,
        uint256 softCap_,
        uint256 hardCap_,
        uint256 durationDays_,
        uint256 maxBuyBps_,
        uint256 creatorAllocationBps_,
        uint256 vestingDays_,
        uint256 startTimestamp_,
        uint256 lockDurationAfterListing_,
        uint256 minBuyUsdt_
    ) internal returns (address) {
        if (token_ == address(0)) revert InvalidToken();
        if (totalTokens_ == 0) revert ZeroTokens();
        if (address(tokenToLaunch[token_]) != address(0)) revert TokenAlreadyHasLaunch();

        address cloneAddr = Clones.clone(launchImplementation);
        LaunchInstance launch = LaunchInstance(payable(cloneAddr));
        launch.initialize(
            creator_,
            token_,
            totalTokens_,
            curveType_,
            param1_,
            param2_,
            softCap_,
            hardCap_,
            durationDays_,
            maxBuyBps_,
            creatorAllocationBps_,
            vestingDays_,
            dexRouter,
            usdt,
            startTimestamp_,
            lockDurationAfterListing_,
            minBuyUsdt_
        );

        launches.push(launch);
        creatorLaunches[creator_].push(launch);
        tokenToLaunch[token_] = launch;

        // Auto-whitelist the new clone on the Affiliate contract so its
        // buy() calls to report() are accepted. No-op if affiliate unset.
        if (affiliate != address(0)) {
            try IAffiliate(affiliate).setAuthorized(cloneAddr, true) {} catch {}
        }

        uint256 day = block.timestamp / 1 days;
        dailyLaunchStats[day].created += 1;

        emit LaunchCreated(
            address(launch),
            token_,
            creator_,
            curveType_,
            softCap_,
            hardCap_,
            totalTokens_,
            param1_,
            param2_
        );

        return address(launch);
    }

    // ── External functions ─────────────────────────────────────

    /// @notice Create a launch with default curve params. Caller pays
    ///         `launchFee` USDT (must be approved beforehand).
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
        uint256 startTimestamp_,
        uint256 lockDurationAfterListing_,
        uint256 minBuyUsdt_
    ) external nonReentrant returns (address) {
        _collectLaunchFee(msg.sender);

        (uint256 p1, uint256 p2) = _getCurveParams(curveType_);

        return _createLaunchInternal(
            msg.sender,
            token_,
            totalTokens_,
            curveType_,
            p1,
            p2,
            softCap_,
            hardCap_,
            durationDays_,
            maxBuyBps_,
            creatorAllocationBps_,
            vestingDays_,
            startTimestamp_,
            lockDurationAfterListing_,
            minBuyUsdt_
        );
    }

    /// @notice Create a launch with custom curve params.
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
        uint256 startTimestamp_,
        uint256 lockDurationAfterListing_,
        uint256 minBuyUsdt_
    ) external nonReentrant returns (address) {
        _collectLaunchFee(msg.sender);

        return _createLaunchInternal(
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
            startTimestamp_,
            lockDurationAfterListing_,
            minBuyUsdt_
        );
    }

    /// @notice Create a launch on behalf of a creator. Only callable by authorizedRouter.
    ///         Router has already swapped the user's input to USDT and approved this
    ///         contract for the exact `launchFee`.
    function routerCreateLaunch(
        address creator_,
        address token_,
        uint256 totalTokens_,
        LaunchInstance.CurveType curveType_,
        uint256 softCap_,
        uint256 hardCap_,
        uint256 durationDays_,
        uint256 maxBuyBps_,
        uint256 creatorAllocationBps_,
        uint256 vestingDays_,
        uint256 startTimestamp_,
        uint256 lockDurationAfterListing_,
        uint256 minBuyUsdt_
    ) external nonReentrant returns (address) {
        if (authorizedRouter == address(0) || msg.sender != authorizedRouter) revert OnlyAuthorizedRouter();

        _collectLaunchFee(creator_);

        (uint256 p1, uint256 p2) = _getCurveParams(curveType_);

        return _createLaunchInternal(
            creator_,
            token_,
            totalTokens_,
            curveType_,
            p1,
            p2,
            softCap_,
            hardCap_,
            durationDays_,
            maxBuyBps_,
            creatorAllocationBps_,
            vestingDays_,
            startTimestamp_,
            lockDurationAfterListing_,
            minBuyUsdt_
        );
    }

    /// @notice Forwards a deposit notification to a LaunchInstance. Only callable by authorizedRouter.
    function notifyDeposit(address launch_, uint256 amount) external {
        if (authorizedRouter == address(0) || msg.sender != authorizedRouter) revert OnlyAuthorizedRouter();
        LaunchInstance(payable(launch_)).notifyDeposit(amount);
    }

    /// @notice Called by a LaunchInstance after refund to clear the token→launch mapping.
    function clearTokenLaunch(address token_) external {
        if (address(tokenToLaunch[token_]) != msg.sender) revert OnlyLaunch();
        delete tokenToLaunch[token_];
    }

    /// @notice Called by a LaunchInstance after graduation to record the stat.
    function recordGraduation(address launch_) external {
        LaunchInstance instance = LaunchInstance(payable(launch_));
        address token = address(instance.token());
        if (address(tokenToLaunch[token]) != launch_) revert NotRegisteredLaunch();
        if (msg.sender != launch_) revert OnlyLaunch();

        uint256 day = block.timestamp / 1 days;
        dailyLaunchStats[day].graduated += 1;
    }

    // ── View functions ─────────────────────────────────────────

    function totalLaunches() external view returns (uint256) {
        return launches.length;
    }

    function getLaunchByIndex(uint256 index) external view returns (address) {
        return address(launches[index]);
    }

    function getLaunches(uint256 offset, uint256 limit) external view returns (address[] memory r, uint256 total) {
        total = launches.length;
        if (offset >= total) return (new address[](0), total);
        uint256 e = offset + limit > total ? total : offset + limit;
        r = new address[](e - offset);
        for (uint256 i = offset; i < e; i++) r[i - offset] = address(launches[i]);
    }

    function getState() external view returns (
        address factoryOwner,
        uint256 totalLaunchCount,
        uint256 totalFeeUsdt,
        uint256 fee
    ) {
        factoryOwner = owner();
        totalLaunchCount = launches.length;
        totalFeeUsdt = totalLaunchFeeEarnedUsdt;
        fee = launchFee;
    }

    function getCreatorLaunches(address creator_) external view returns (LaunchInstance[] memory) {
        return creatorLaunches[creator_];
    }

    // ── Admin functions ────────────────────────────────────────

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

    function setLaunchImplementation(address impl_) external onlyOwner {
        if (impl_ == address(0)) revert InvalidAddress();
        launchImplementation = impl_;
    }

    function setUsdt(address usdt_) external onlyOwner {
        if (usdt_ == address(0)) revert InvalidUsdt();
        usdt = usdt_;
    }

    function setLaunchFee(uint256 fee_) external onlyOwner {
        launchFee = fee_;
        emit LaunchFeeUpdated(fee_);
    }

    function setCurveDefaults(CurveDefaults calldata defaults_) external onlyOwner {
        require(defaults_.linearSlope <= 1e30 && defaults_.linearIntercept <= 1e30, "Linear params too large");
        require(defaults_.sqrtCoefficient <= 1e30, "Sqrt param too large");
        require(defaults_.quadraticCoefficient <= 1e30, "Quad param too large");
        require(defaults_.expBase <= 1e22 && defaults_.expKFactor <= 1e18, "Exp params too large");
        curveDefaults = defaults_;
        emit CurveDefaultsUpdated();
    }

    function setAuthorizedRouter(address router_) external onlyOwner {
        authorizedRouter = router_;
        emit AuthorizedRouterUpdated(router_);
    }

    /// @notice Cancel a pending (not yet activated) launch to clear the tokenToLaunch mapping.
    ///         Only callable by the launch creator or factory owner.
    function cancelPendingLaunch(address token_) external {
        LaunchInstance launch = tokenToLaunch[token_];
        if (address(launch) == address(0)) revert InvalidToken();
        if (launch.state() != LaunchInstance.LaunchState.Pending) revert NotRegisteredLaunch();
        if (msg.sender != launch.creator() && msg.sender != owner()) revert NotLaunchCreator();
        delete tokenToLaunch[token_];
    }

    /// @notice Withdraws accumulated fees of an arbitrary token to the platform wallet.
    function withdrawFees(address token_) external onlyOwner {
        if (token_ == address(0)) revert InvalidAddress();
        uint256 bal = IERC20(token_).balanceOf(address(this));
        if (bal == 0) revert NoBalance();
        IERC20(token_).safeTransfer(platformWallet, bal);
    }
}
