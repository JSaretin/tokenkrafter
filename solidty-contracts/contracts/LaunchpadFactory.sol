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
///
///         Plain Ownable — production deployment hands ownership to a
///         Safe (multisig) immediately after deploy, so the on-chain
///         two-step handoff Ownable2Step provides is redundant
///         (the multisig itself enforces multi-key approval on every
///         action including transferOwnership).
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
    error UsdtLocked();
    error NoPendingImplementation();
    error TimelockNotReached();

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
        uint256 param2,
        uint256 durationDays,
        uint256 maxBuyBps,
        uint256 creatorAllocationBps,
        uint256 vestingDays,
        uint256 minBuyUsdt
    );
    event PlatformWalletUpdated(address newWallet);
    event DexRouterUpdated(address newRouter);
    event CurveDefaultsUpdated();
    event LaunchFeeUpdated(uint256 newFee);
    /// @dev `payer` is the attributed creator (off-chain accounting / affiliate
    ///      attribution); `source` is the actual EOA/contract that the USDT
    ///      was pulled from (msg.sender — equals payer on direct calls,
    ///      equals the authorized router on routerCreateLaunch). Including
    ///      both keeps indexers honest when the router fronts the fee.
    event LaunchFeePaid(address indexed payer, address indexed source, uint256 amount);
    event AuthorizedRouterUpdated(address newRouter);
    event UsdtUpdated(address indexed previous, address indexed current);
    event UsdtLockedEvent();
    event LaunchImplementationProposed(address indexed previous, address indexed proposed, uint256 applyAt);
    event LaunchImplementationApplied(address indexed previous, address indexed current);
    event AffiliateAuthorizationFailed(address indexed launch, address indexed affiliate_);
    event LaunchCancelled(address indexed launch, address indexed token, address indexed creator);
    event FeesWithdrawn(address indexed token, address indexed to, uint256 amount);

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

    /// @notice Once any launch has been created, USDT becomes immutable.
    ///         Existing clones bake the USDT address into their initialize()
    ///         call, so swapping it factory-side after launches exist would
    ///         create a confusing two-tier system. Locked on first
    ///         _createLaunchInternal — owner can no longer reach setUsdt().
    bool public usdtLocked;

    /// @notice Two-stage timelock for swapping the launch clone implementation.
    ///         A malicious or fat-fingered impl swap would compromise every
    ///         future launch (and could silently re-route user USDT). The
    ///         48-hour delay gives off-chain monitoring + users time to react
    ///         to the proposal event before the change takes effect.
    address public pendingLaunchImplementation;
    uint256 public pendingLaunchImplementationApplyAt;
    uint256 public constant LAUNCH_IMPL_TIMELOCK = 48 hours;

    /// @notice Shared Affiliate contract reporters across the platform write
    ///         to. address(0) disables affiliate accrual on launch buys.
    address public affiliate;
    event AffiliateUpdated(address indexed previous, address indexed current);

    /// @notice Global kill switch — when true, ALL launch instances block
    ///         new buys and manual graduation. Refunds remain open so users
    ///         can always exit. Scoped for platform-wide incident response.
    bool public globalPause;
    event GlobalPauseChanged(bool paused);
    event LaunchPaused(address indexed launch, bool paused);
    event LaunchesPaused(uint256 fromIndex, uint256 toIndex, bool paused);

    /// @notice Owner-only. Points launches at a (new) Affiliate contract.
    ///         Per-launch instances read this dynamically at fee time.
    function setAffiliate(address aff) external onlyOwner {
        emit AffiliateUpdated(affiliate, aff);
        affiliate = aff;
    }

    /// @notice Global kill switch. Owner-only. When true, every launch
    ///         instance refuses new buys and manual graduation via the
    ///         `factory.globalPause()` check they run before each buy.
    ///         Single tx, instant platform-wide stop. Refunds still work.
    function setGlobalPause(bool paused_) external onlyOwner {
        globalPause = paused_;
        emit GlobalPauseChanged(paused_);
    }

    /// @notice Emergency pause for a specific launch clone. Owner-only.
    ///         When paused, new buys and manual graduation are blocked
    ///         on that launch; refunds still work so users can always exit.
    function pauseLaunch(address launch_, bool paused_) external onlyOwner {
        if (launch_ == address(0)) revert InvalidToken();
        LaunchInstance(payable(launch_)).setPaused(paused_);
        emit LaunchPaused(launch_, paused_);
    }

    /// @notice Paginated per-launch pause. Iterates `[offset, offset+limit)`
    ///         bounded by `launches.length`. Use for targeted incident
    ///         response on a subset of launches (e.g. all launches of a
    ///         compromised external token) when globalPause is too broad.
    function pauseLaunches(uint256 offset, uint256 limit, bool paused_) external onlyOwner {
        uint256 total = launches.length;
        if (offset >= total) return;
        uint256 end = offset + limit;
        if (end > total) end = total;
        for (uint256 i = offset; i < end;) {
            launches[i].setPaused(paused_);
            unchecked { ++i; }
        }
        emit LaunchesPaused(offset, end, paused_);
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
    ///      pre-swapping the user's input token to USDT). The event reports
    ///      both the attributed `payer` and the actual `source` so off-chain
    ///      indexers can tell when a router fronted the fee for a creator.
    function _collectLaunchFee(address payer) internal {
        if (launchFee == 0) return;

        IERC20(usdt).safeTransferFrom(msg.sender, address(this), launchFee);

        uint256 day = block.timestamp / 1 days;
        dailyLaunchStats[day].totalFeeUsdt += launchFee;
        totalLaunchFeeEarnedUsdt += launchFee;

        emit LaunchFeePaid(payer, msg.sender, launchFee);
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

        // Lock USDT on the first ever launch so the address can't drift
        // out from under the existing clones (each clone bakes USDT into
        // its initialize call).
        if (!usdtLocked) {
            usdtLocked = true;
            emit UsdtLockedEvent();
        }

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
        // We swallow the revert so a misconfigured Affiliate doesn't block
        // launch creation, but emit a dedicated event so monitoring catches
        // the dropped attribution before weeks of buy fees go un-credited.
        if (affiliate != address(0)) {
            try IAffiliate(affiliate).setAuthorized(cloneAddr, true) {} catch {
                emit AffiliateAuthorizationFailed(cloneAddr, affiliate);
            }
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
            param2_,
            durationDays_,
            maxBuyBps_,
            creatorAllocationBps_,
            vestingDays_,
            minBuyUsdt_
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

    /// @notice Stage a new launch implementation. Takes effect after
    ///         `LAUNCH_IMPL_TIMELOCK` (48 h) when {applyLaunchImplementation}
    ///         is called. Two-stage with a public proposal event so users and
    ///         off-chain monitoring can see the change well before any new
    ///         clone is spawned from the new pointer. Calling again before
    ///         apply overwrites the pending proposal and resets the clock.
    function proposeLaunchImplementation(address impl_) external onlyOwner {
        if (impl_ == address(0)) revert InvalidAddress();
        pendingLaunchImplementation = impl_;
        pendingLaunchImplementationApplyAt = block.timestamp + LAUNCH_IMPL_TIMELOCK;
        emit LaunchImplementationProposed(launchImplementation, impl_, pendingLaunchImplementationApplyAt);
    }

    /// @notice Apply a previously-proposed launch implementation after the
    ///         timelock has elapsed.
    function applyLaunchImplementation() external onlyOwner {
        if (pendingLaunchImplementation == address(0)) revert NoPendingImplementation();
        if (block.timestamp < pendingLaunchImplementationApplyAt) revert TimelockNotReached();
        address prev = launchImplementation;
        launchImplementation = pendingLaunchImplementation;
        pendingLaunchImplementation = address(0);
        pendingLaunchImplementationApplyAt = 0;
        emit LaunchImplementationApplied(prev, launchImplementation);
    }

    /// @notice Cancel a pending launch implementation proposal before apply.
    function cancelPendingLaunchImplementation() external onlyOwner {
        if (pendingLaunchImplementation == address(0)) revert NoPendingImplementation();
        pendingLaunchImplementation = address(0);
        pendingLaunchImplementationApplyAt = 0;
    }

    /// @notice Set the USDT address. Only callable BEFORE the first launch
    ///         is created (after that, `usdtLocked` is true and existing
    ///         clones have already baked the address into their state).
    ///         Intended for one-shot fixup during deployment, not runtime
    ///         migration — clones can't re-initialize.
    function setUsdt(address usdt_) external onlyOwner {
        if (usdtLocked) revert UsdtLocked();
        if (usdt_ == address(0)) revert InvalidUsdt();
        emit UsdtUpdated(usdt, usdt_);
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

    /// @notice Set the singular authorized router. Pass address(0) to
    ///         explicitly disable the router path — the zero address still
    ///         emits the event so off-chain monitoring can flag the change.
    ///         (No silent typo guard: zeroing is the documented "kill the
    ///         router" pattern. If you didn't mean it, propose a new router
    ///         in a follow-up tx.)
    function setAuthorizedRouter(address router_) external onlyOwner {
        authorizedRouter = router_;
        emit AuthorizedRouterUpdated(router_);
    }

    /// @notice Cancel a pending (not yet activated) launch to clear the
    ///         tokenToLaunch mapping AND notify the clone so it can return
    ///         any deposited tokens to the creator and lock itself out.
    ///         Without notifying the clone, the orphan would still hold
    ///         deposited tokens (recoverable via the clone's own
    ///         `withdrawPendingTokens`) AND retain whatever token-side
    ///         authorisations were granted at launch creation, which a
    ///         malicious creator could later misuse if the same token gets
    ///         relaunched. Only callable by the launch creator or factory owner.
    function cancelPendingLaunch(address token_) external {
        LaunchInstance launch = tokenToLaunch[token_];
        if (address(launch) == address(0)) revert InvalidToken();
        if (launch.state() != LaunchInstance.LaunchState.Pending) revert NotRegisteredLaunch();
        address launchCreator = launch.creator();
        if (msg.sender != launchCreator && msg.sender != owner()) revert NotLaunchCreator();
        delete tokenToLaunch[token_];
        // Notify the clone — moves it to Cancelled, returns deposited
        // tokens to the creator, and bricks every future operation on it
        // (so its dangling token-side authorisations are inert).
        launch.cancelFromFactory();
        emit LaunchCancelled(address(launch), token_, launchCreator);
    }

    /// @notice Withdraws accumulated fees of an arbitrary token to the
    ///         platform wallet. Emits FeesWithdrawn for audit trail —
    ///         previously this was a silent transfer, which made
    ///         post-incident accounting harder than it needed to be.
    function withdrawFees(address token_) external onlyOwner {
        if (token_ == address(0)) revert InvalidAddress();
        uint256 bal = IERC20(token_).balanceOf(address(this));
        if (bal == 0) revert NoBalance();
        IERC20(token_).safeTransfer(platformWallet, bal);
        emit FeesWithdrawn(token_, platformWallet, bal);
    }
}
