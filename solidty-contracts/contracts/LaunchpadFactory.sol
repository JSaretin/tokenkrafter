// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";

import "./LaunchInstance.sol";

// IUniswapV2Router02 and IOwnable are imported from LaunchInstance.sol

// =============================================================
// LAUNCHPAD FACTORY
// =============================================================

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
    error UnsupportedPaymentToken();
    error CannotDetermineFee();
    error InsufficientNativePayment();
    error RefundFailed();
    error WithdrawFailed();
    error NoBalance();

    error AlreadySupported();
    error NotSupported();
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
        uint256 totalTokens
    );
    event PlatformWalletUpdated(address newWallet);
    event DexRouterUpdated(address newRouter);
    event CurveDefaultsUpdated();
    event LaunchFeeUpdated(uint256 newFee);
    event PaymentTokenAdded(address token);
    event PaymentTokenRemoved(address token);
    event LaunchFeePaid(address indexed payer, address indexed paymentToken, uint256 amount);
    event AuthorizedRouterUpdated(address newRouter);

    // ── State variables ────────────────────────────────────────

    address public platformWallet;
    address public dexRouter;
    address public usdt;
    address public launchImplementation;  // LaunchInstance impl for cloning

    uint256 public launchFee;

    address[] internal _supportedPaymentTokens;
    mapping(address => bool) public isPaymentSupported;

    LaunchInstance[] public launches;
    mapping(address => LaunchInstance[]) public creatorLaunches;
    mapping(address => LaunchInstance) public tokenToLaunch;

    CurveDefaults public curveDefaults;

    mapping(uint256 => LaunchDayStats) public dailyLaunchStats;
    uint256 public totalLaunchFeeEarnedUsdt;

    address public authorizedRouter;

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

        // Default launch fee: 0 (admin sets after deployment)
        launchFee = 0;

        // Add native (address(0)) as default supported payment token
        isPaymentSupported[address(0)] = true;
        _supportedPaymentTokens.push(address(0));
        emit PaymentTokenAdded(address(0));

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

    /// @dev Converts a USDT-denominated fee to the equivalent amount in `paymentToken`.
    ///      Uses getAmountsIn to correctly determine how much paymentToken is needed
    ///      to cover baseFeeUsdt worth of USDT.
    function _convertFee(uint256 baseFeeUsdt, address paymentToken)
        internal view returns (uint256)
    {
        if (baseFeeUsdt == 0) return 0;
        if (paymentToken == usdt) return baseFeeUsdt;

        IUniswapV2Router02 router = IUniswapV2Router02(dexRouter);
        address weth = router.WETH();

        address tokenIn = paymentToken == address(0) ? weth : paymentToken;

        // Try direct path: paymentToken → USDT
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = usdt;

        try router.getAmountsIn(baseFeeUsdt, path) returns (uint256[] memory amounts) {
            if (amounts[0] > 0) return amounts[0];
        } catch {}

        // Try via WETH: paymentToken → WETH → USDT
        if (tokenIn != weth) {
            address[] memory path3 = new address[](3);
            path3[0] = tokenIn;
            path3[1] = weth;
            path3[2] = usdt;

            try router.getAmountsIn(baseFeeUsdt, path3) returns (uint256[] memory amounts) {
                if (amounts[0] > 0) return amounts[0];
            } catch {}
        }

        return 0;
    }

    /// @dev Collects the launch fee from `payer` in `paymentToken`, updates daily stats.
    function _collectLaunchFee(address payer, address paymentToken) internal {
        if (launchFee == 0) return;
        if (!isPaymentSupported[paymentToken]) revert UnsupportedPaymentToken();

        uint256 amount = _convertFee(launchFee, paymentToken);
        if (amount == 0) revert CannotDetermineFee();

        if (paymentToken == address(0)) {
            if (msg.value < amount) revert InsufficientNativePayment();
            // Refund excess to msg.sender (not payer) so router flow works:
            // normal createLaunch: msg.sender == payer
            // routerCreateLaunch: msg.sender == router (which refunds user at the end)
            uint256 excess = msg.value - amount;
            if (excess > 0) {
                (bool ok, ) = msg.sender.call{value: excess}("");
                if (!ok) revert RefundFailed();
            }
        } else {
            // Pull from msg.sender so router flow works:
            // normal createLaunch: msg.sender == payer (creator)
            // routerCreateLaunch: msg.sender == router (which pre-pulled from user)
            IERC20(paymentToken).safeTransferFrom(msg.sender, address(this), amount);
        }

        // Update daily stats
        uint256 day = block.timestamp / 1 days;
        dailyLaunchStats[day].totalFeeUsdt += launchFee;
        totalLaunchFeeEarnedUsdt += launchFee;

        emit LaunchFeePaid(payer, paymentToken, amount);
    }

    /// @dev Returns (param1, param2) for a given curve type from defaults.
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
        uint256 lockDurationAfterListing_
    ) internal returns (address) {
        if (token_ == address(0)) revert InvalidToken();
        if (totalTokens_ == 0) revert ZeroTokens();
        if (address(tokenToLaunch[token_]) != address(0)) revert TokenAlreadyHasLaunch();

        // Clone the implementation and initialize
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
            lockDurationAfterListing_
        );

        launches.push(launch);
        creatorLaunches[creator_].push(launch);
        tokenToLaunch[token_] = launch;

        // Update daily stats
        uint256 day = block.timestamp / 1 days;
        dailyLaunchStats[day].created += 1;

        emit LaunchCreated(
            address(launch),
            token_,
            creator_,
            curveType_,
            softCap_,
            hardCap_,
            totalTokens_
        );

        return address(launch);
    }

    // ── External functions ─────────────────────────────────────

    /// @notice Create a launch with default curve params. Caller must be token owner.
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
        address paymentToken_,
        uint256 startTimestamp_,
        uint256 lockDurationAfterListing_
    ) external payable nonReentrant returns (address) {
        // Anyone can create a launch for any ERC20. The real gate is the launch
        // instance's preflight check, which verifies the launch is exempt from
        // the token's transfer restrictions before allowing activation. If the
        // token owner never grants the exemptions, the launch stays Pending and
        // the creator can recover their deposit via withdrawPendingTokens().
        _collectLaunchFee(msg.sender, paymentToken_);

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
            lockDurationAfterListing_
        );
    }

    /// @notice Create a launch with custom curve params. Anyone can call this
    ///         for any ERC20 — same preflight gating as `createLaunch`.
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
        address paymentToken_,
        uint256 startTimestamp_,
        uint256 lockDurationAfterListing_
    ) external payable nonReentrant returns (address) {
        _collectLaunchFee(msg.sender, paymentToken_);

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
            lockDurationAfterListing_
        );
    }

    /// @notice Create a launch on behalf of a creator. Only callable by authorizedRouter.
    ///         Fee is collected from msg.value forwarded by the router.
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
        address paymentToken_,
        uint256 startTimestamp_,
        uint256 lockDurationAfterListing_
    ) external payable nonReentrant returns (address) {
        if (authorizedRouter == address(0) || msg.sender != authorizedRouter) revert OnlyAuthorizedRouter();

        _collectLaunchFee(creator_, paymentToken_);

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
            lockDurationAfterListing_
        );
    }

    /// @notice Forwards a deposit notification to a LaunchInstance. Only callable by authorizedRouter.
    function notifyDeposit(address launch_, uint256 amount) external {
        if (authorizedRouter == address(0) || msg.sender != authorizedRouter) revert OnlyAuthorizedRouter();
        LaunchInstance(payable(launch_)).notifyDeposit(amount);
    }

    /// @notice Called by a LaunchInstance after refund to clear the token→launch mapping.
    function clearTokenLaunch(address token_) external {
        // Only a registered launch for this token may call
        if (address(tokenToLaunch[token_]) != msg.sender) revert OnlyLaunch();
        delete tokenToLaunch[token_];
    }

    /// @notice Called by a LaunchInstance after graduation to record the stat.
    function recordGraduation(address launch_) external {
        // Only a registered launch may call
        LaunchInstance instance = LaunchInstance(payable(launch_));
        address token = address(instance.token());
        if (address(tokenToLaunch[token]) != launch_) revert NotRegisteredLaunch();
        if (msg.sender != launch_) revert OnlyLaunch();

        uint256 day = block.timestamp / 1 days;
        dailyLaunchStats[day].graduated += 1;
    }

    // ── View functions ─────────────────────────────────────────

    /// @notice Returns total number of launches created.
    function totalLaunches() external view returns (uint256) {
        return launches.length;
    }

    /// @notice Returns the launch contract address at a given index.
    function getLaunchByIndex(uint256 index) external view returns (address) {
        return address(launches[index]);
    }

    /// @notice Returns a paginated slice of launch addresses.
    function getLaunches(uint256 offset, uint256 limit) external view returns (address[] memory r, uint256 total) {
        total = launches.length;
        if (offset >= total) return (new address[](0), total);
        uint256 e = offset + limit > total ? total : offset + limit;
        r = new address[](e - offset);
        for (uint256 i = offset; i < e; i++) r[i - offset] = address(launches[i]);
    }

    /// @notice Returns key factory state in a single call for dashboards.
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

    /// @notice Returns all launches created by a given address.
    function getCreatorLaunches(address creator_) external view returns (LaunchInstance[] memory) {
        return creatorLaunches[creator_];
    }

    /// @notice Returns the list of supported payment token addresses.
    function getSupportedPaymentTokens() external view returns (address[] memory) {
        return _supportedPaymentTokens;
    }

    /// @notice Returns the launch fee denominated in `paymentToken`.
    function getLaunchFee(address paymentToken) external view returns (uint256) {
        if (launchFee == 0) return 0;
        if (paymentToken == usdt) return launchFee;
        return _convertFee(launchFee, paymentToken);
    }

    /// @notice Public wrapper around _convertFee for lens / UI usage.
    function convertFee(uint256 baseFeeUsdt, address paymentToken) external view returns (uint256) {
        return _convertFee(baseFeeUsdt, paymentToken);
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
        // Prevent extreme values that would break curve math (overflow in BondingCurve library)
        require(defaults_.linearSlope <= 1e30 && defaults_.linearIntercept <= 1e30, "Linear params too large");
        require(defaults_.sqrtCoefficient <= 1e30, "Sqrt param too large");
        require(defaults_.quadraticCoefficient <= 1e30, "Quad param too large");
        require(defaults_.expBase <= 1e22 && defaults_.expKFactor <= 1e18, "Exp params too large");
        curveDefaults = defaults_;
        emit CurveDefaultsUpdated();
    }

    function addPaymentToken(address token_) external onlyOwner {
        if (isPaymentSupported[token_]) revert AlreadySupported();
        isPaymentSupported[token_] = true;
        _supportedPaymentTokens.push(token_);
        emit PaymentTokenAdded(token_);
    }

    function removePaymentToken(address token_) external onlyOwner {
        if (!isPaymentSupported[token_]) revert NotSupported();
        isPaymentSupported[token_] = false;

        uint256 len = _supportedPaymentTokens.length;
        for (uint256 i = 0; i < len; i++) {
            if (_supportedPaymentTokens[i] == token_) {
                _supportedPaymentTokens[i] = _supportedPaymentTokens[len - 1];
                _supportedPaymentTokens.pop();
                break;
            }
        }
        emit PaymentTokenRemoved(token_);
    }

    function setAuthorizedRouter(address router_) external onlyOwner {
        authorizedRouter = router_;
        emit AuthorizedRouterUpdated(router_);
    }

    /// @notice Cancel a pending (not yet activated) launch to clear the tokenToLaunch mapping.
    ///         Allows the token to be re-launched. Only callable by token owner or factory owner.
    function cancelPendingLaunch(address token_) external {
        LaunchInstance launch = tokenToLaunch[token_];
        if (address(launch) == address(0)) revert InvalidToken();
        if (launch.state() != LaunchInstance.LaunchState.Pending) revert NotRegisteredLaunch();
        // The launch creator (who deposited tokens and paid the fee) or the
        // platform owner can cancel a pending launch. Token ownership is no
        // longer relevant — anyone can create launches for tokens they don't own.
        if (msg.sender != launch.creator() && msg.sender != owner()) revert NotLaunchCreator();
        delete tokenToLaunch[token_];
    }

    function withdrawFees(address token_) external onlyOwner {
        if (token_ == address(0)) {
            uint256 bal = address(this).balance;
            if (bal == 0) revert NoBalance();
            (bool ok, ) = platformWallet.call{value: bal}("");
            if (!ok) revert WithdrawFailed();
        } else {
            uint256 bal = IERC20(token_).balanceOf(address(this));
            if (bal == 0) revert NoBalance();
            IERC20(token_).safeTransfer(platformWallet, bal);
        }
    }


    receive() external payable {}
}
