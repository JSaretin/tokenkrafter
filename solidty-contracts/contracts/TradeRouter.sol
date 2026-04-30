// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

interface IAffiliateReporter {
    function report(address user, address ref, uint256 platformFee) external;
}

interface ISwapRouter {
    function WETH() external pure returns (address);
    function swapExactTokensForTokens(
        uint256 amountIn, uint256 amountOutMin,
        address[] calldata path, address to, uint256 deadline
    ) external returns (uint256[] memory amounts);
    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path, address to, uint256 deadline
    ) external payable returns (uint256[] memory amounts);
    function swapExactTokensForETH(
        uint256 amountIn, uint256 amountOutMin,
        address[] calldata path, address to, uint256 deadline
    ) external returns (uint256[] memory amounts);
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn, uint256 amountOutMin,
        address[] calldata path, address to, uint256 deadline
    ) external;
    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path, address to, uint256 deadline
    ) external payable;
    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn, uint256 amountOutMin,
        address[] calldata path, address to, uint256 deadline
    ) external;
    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external view returns (uint256[] memory amounts);
}

/**
 * @title TradeRouter
 * @notice Swap tokens via DEX + fiat off-ramp with escrow
 *
 * Swap flow:
 *   User approves token → swapTokens() → receives output token directly
 *
 * Off-ramp (sell to fiat) flow:
 *   1. User calls deposit() or depositAndSwap() → USDT held in escrow
 *   2. Admin calls confirm(id) within timeout → fee taken, user marked as paid
 *   3. If admin doesn't confirm within timeout → user calls cancel(id) → gets USDT back
 *
 * Platform earnings from fees are tracked separately — admin can only
 * withdraw from platformEarnings, never from user escrow.
 */
contract TradeRouter is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ── Types ───────────────────────────────────────────────────────
    enum WithdrawStatus { Pending, Confirmed, Cancelled }

    struct WithdrawRequest {
        address user;
        address token;          // settlement token (usually USDT)
        uint256 grossAmount;    // amount before fee
        uint256 fee;            // platform fee
        uint256 netAmount;      // amount user receives (gross - fee)
        uint256 createdAt;
        uint256 expiresAt;      // snapshot of createdAt + payoutTimeout at creation time
        WithdrawStatus status;
        bytes32 bankRef;        // hashed bank reference (off-chain lookup)
        address referrer;       // affiliate who referred this trade (address(0) if none)
    }

    struct RouterState {
        address owner;
        uint256 feeBps;
        uint256 payoutTimeout;
        address platformWallet;
        uint256 totalEscrow;
        uint256 pendingCount;
        uint256 totalWithdrawals;
        bool paused;
        uint256 maxSlippageBps;
        bool affiliateEnabled;
        uint256 affiliateShareBps;
        address[] admins;
    }

    // ── State ───────────────────────────────────────────────────────
    ISwapRouter public immutable dexRouter;
    address public immutable weth;
    IERC20 public immutable usdt;

    uint256 public feeBps = 100;                // 1% default
    uint256 public payoutTimeout = 600;         // 10 minutes default
    /// @notice Minimum withdrawal value in USDT (native units). Anti-dust
    ///         floor that stops attackers from spamming `withdrawals` /
    ///         `pendingIds` / `userWithdrawIds` with sub-cent requests to
    ///         bloat storage and DoS the indexer. Owner-configurable.
    ///         Set to 0 to disable the floor entirely.
    uint256 public minWithdrawUsdt;
    address public platformWallet;

    /// @notice Shared platform Affiliate contract. address(0) disables the new
    ///         affiliate path; behaviour falls back to the legacy direct-pay
    ///         logic gated by `affiliateEnabled`.
    address public affiliate;
    event AffiliateUpdated(address indexed previous, address indexed current);

    /// @notice Owner-only. Points at the (new) Affiliate contract. Approvals
    ///         are now granted per-call inside `_confirm` for exactly the fee
    ///         amount, so this function only needs to revoke any leftover
    ///         allowance on the outgoing affiliate.
    function setAffiliate(address aff) external onlyOwner {
        address prev = affiliate;
        if (prev != address(0)) {
            // Defense-in-depth: a rotated/compromised affiliate must not keep
            // any standing USDT allowance. Per-call approvals in `_confirm`
            // already minimise the window, but stale approvals from older
            // contract versions (or future fee tokens) get cleared here.
            usdt.forceApprove(prev, 0);
        }
        affiliate = aff;
        emit AffiliateUpdated(prev, aff);
    }
    address[] public admins;
    mapping(address => bool) public isAdmin;
    mapping(address => uint256) internal adminIdxOf;          // admin → index in admins

    // FIX #5: Index mappings for O(1) lookups instead of O(n) loops
    WithdrawRequest[] public withdrawals;
    uint256[] public pendingIds;                            // active pending request IDs
    mapping(uint256 => uint256) internal pendingIdxOf;      // id → index in pendingIds
    mapping(address => uint256[]) internal userWithdrawIds;  // user → their request IDs

    // bankRef uniqueness — guards against the off-chain backend
    // accidentally re-using the same human-readable reference (e.g.
    // a frontend retry that double-submits with the same generated
    // ref). Without on-chain enforcement, two pending withdrawals
    // could share a ref and the off-ramp processor wouldn't know
    // which one a fiat deposit corresponds to.
    mapping(bytes32 => bool) public bankRefUsed;

    uint256 public totalEscrow;                             // total user funds held
    mapping(address => uint256) public platformEarnings;    // per token

    uint256 public constant MAX_FEE_BPS = 500; // max 5% — hard ceiling so a compromised owner can't suddenly charge 10%
    uint256 public constant MIN_TIMEOUT = 300;  // min 5 minutes
    uint256 public constant MAX_TIMEOUT = 86400; // max 24 hours
    uint256 public maxSlippageBps = 500;         // max 5% slippage (configurable)
    uint256 public constant MAX_SLIPPAGE_CAP = 2000; // absolute cap 20%

    // Affiliate / referral
    bool public affiliateEnabled;
    uint256 public affiliateShareBps = 1000;     // 10% of platform fee → referrer
    mapping(address => uint256) public affiliateEarnings; // per referrer

    // ── Events ──────────────────────────────────────────────────────
    event Swap(
        address indexed user, address indexed tokenIn, address indexed tokenOut,
        uint256 amountIn, uint256 amountOut
    );
    event WithdrawRequested(
        uint256 indexed id, address indexed user,
        address token, uint256 grossAmount, uint256 fee,
        uint256 netAmount, bytes32 bankRef,
        address referrer, uint256 expiresAt
    );
    event WithdrawConfirmed(uint256 indexed id, address indexed admin, address indexed to, uint256 netAmount, uint256 grossAmount, uint256 fee, address token);
    event WithdrawCancelled(uint256 indexed id, address indexed user, uint256 refundedAmount);
    event FeesWithdrawn(address indexed token, uint256 amount, address indexed to);
    event TokenRescued(address indexed token, uint256 amount, address indexed to);
    event FeeUpdated(uint256 oldFee, uint256 newFee);
    event TimeoutUpdated(uint256 oldTimeout, uint256 newTimeout);
    event AdminAdded(address indexed admin);
    event AdminRemoved(address indexed admin);
    event PlatformWalletUpdated(address indexed oldWallet, address indexed newWallet);
    event MaxSlippageUpdated(uint256 oldBps, uint256 newBps);
    event MinWithdrawUpdated(uint256 oldMin, uint256 newMin);
    event AffiliatePaid(uint256 indexed id, address indexed referrer, uint256 amount);
    event AffiliateEnabledUpdated(bool enabled);
    event AffiliateShareUpdated(uint256 oldBps, uint256 newBps);

    // ── Errors ──────────────────────────────────────────────────────
    error NotAdmin();
    error InvalidFee();
    error InvalidTimeout();
    error ZeroAmount();
    error BelowMinWithdraw();
    error ZeroAddress();
    error InvalidRequest();
    error NotPending();
    error NotRequestOwner();
    error TimeoutNotReached();
    error TimeoutReached();
    error InsufficientEarnings();
    error AlreadyAdmin();
    error NotAnAdmin();
    error CannotRemoveSelf();
    error SlippageTooHigh();
    error SlippageConfigTooHigh();
    error SlippageRequired();
    error SlippageQuoteUnavailable();
    error AffiliateOverpull();
    error EmptyPending();
    error TooManyAdmins();
    error BankRefAlreadyUsed();

    // ── Modifiers ───────────────────────────────────────────────────
    modifier onlyAdmin() {
        if (!isAdmin[msg.sender] && msg.sender != owner()) revert NotAdmin();
        _;
    }

    // ── Constructor ─────────────────────────────────────────────────
    constructor(
        address dexRouter_,
        address usdt_,
        address platformWallet_
    ) Ownable(msg.sender) {
        if (platformWallet_ == address(0)) revert ZeroAddress();
        dexRouter = ISwapRouter(dexRouter_);
        weth = ISwapRouter(dexRouter_).WETH();
        usdt = IERC20(usdt_);
        platformWallet = platformWallet_;
        isAdmin[msg.sender] = true;
        adminIdxOf[msg.sender] = 0;
        admins.push(msg.sender);
    }

    // ════════════════════════════════════════════════════════════════
    //  SWAP (direct, no escrow)
    // ════════════════════════════════════════════════════════════════

    /// @notice Swap token → token via DEX with caller-specified path
    function swapTokens(
        address[] calldata path,
        uint256 amountIn,
        uint256 amountOutMin,
        bool hasTax
    ) external nonReentrant whenNotPaused returns (uint256 amountOut) {
        return _swapTokens(path, amountIn, amountOutMin, hasTax, block.timestamp + 300);
    }

    /// @notice Swap token → token with explicit deadline
    function swapTokens(
        address[] calldata path,
        uint256 amountIn,
        uint256 amountOutMin,
        bool hasTax,
        uint256 deadline
    ) external nonReentrant whenNotPaused returns (uint256 amountOut) {
        return _swapTokens(path, amountIn, amountOutMin, hasTax, deadline);
    }

    function _swapTokens(
        address[] calldata path,
        uint256 amountIn,
        uint256 amountOutMin,
        bool hasTax,
        uint256 deadline
    ) internal returns (uint256 amountOut) {
        if (amountIn == 0) revert ZeroAmount();
        require(path.length >= 2, "Invalid path");

        address tokenIn = path[0];
        address tokenOut = path[path.length - 1];

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        _safeResetApprove(tokenIn, address(dexRouter), amountIn);
        _validateSlippage(path, amountIn, amountOutMin);

        if (hasTax) {
            uint256 balBefore = IERC20(tokenOut).balanceOf(msg.sender);
            dexRouter.swapExactTokensForTokensSupportingFeeOnTransferTokens(
                amountIn, amountOutMin, path, msg.sender, deadline
            );
            amountOut = IERC20(tokenOut).balanceOf(msg.sender) - balBefore;
        } else {
            uint256[] memory amounts = dexRouter.swapExactTokensForTokens(
                amountIn, amountOutMin, path, msg.sender, deadline
            );
            amountOut = amounts[amounts.length - 1];
        }

        emit Swap(msg.sender, tokenIn, tokenOut, amountIn, amountOut);
    }

    /// @notice Swap ETH → token via DEX with caller-specified path
    function swapETHForTokens(
        address[] calldata path,
        uint256 amountOutMin,
        bool hasTax
    ) external payable nonReentrant whenNotPaused returns (uint256 amountOut) {
        return _swapETHForTokens(path, amountOutMin, hasTax, block.timestamp + 300);
    }

    /// @notice Swap ETH → token with explicit deadline
    function swapETHForTokens(
        address[] calldata path,
        uint256 amountOutMin,
        bool hasTax,
        uint256 deadline
    ) external payable nonReentrant whenNotPaused returns (uint256 amountOut) {
        return _swapETHForTokens(path, amountOutMin, hasTax, deadline);
    }

    function _swapETHForTokens(
        address[] calldata path,
        uint256 amountOutMin,
        bool hasTax,
        uint256 deadline
    ) internal returns (uint256 amountOut) {
        if (msg.value == 0) revert ZeroAmount();
        require(path.length >= 2 && path[0] == weth, "Path must start with WETH");

        address tokenOut = path[path.length - 1];
        _validateSlippage(path, msg.value, amountOutMin);

        if (hasTax) {
            uint256 balBefore = IERC20(tokenOut).balanceOf(msg.sender);
            dexRouter.swapExactETHForTokensSupportingFeeOnTransferTokens{value: msg.value}(
                amountOutMin, path, msg.sender, deadline
            );
            amountOut = IERC20(tokenOut).balanceOf(msg.sender) - balBefore;
        } else {
            uint256[] memory amounts = dexRouter.swapExactETHForTokens{value: msg.value}(
                amountOutMin, path, msg.sender, deadline
            );
            amountOut = amounts[amounts.length - 1];
        }

        emit Swap(msg.sender, address(0), tokenOut, msg.value, amountOut);
    }

    /// @notice Swap token → ETH via DEX with caller-specified path
    function swapTokensForETH(
        address[] calldata path,
        uint256 amountIn,
        uint256 amountOutMin,
        bool hasTax
    ) external nonReentrant whenNotPaused returns (uint256 amountOut) {
        return _swapTokensForETH(path, amountIn, amountOutMin, hasTax, block.timestamp + 300);
    }

    /// @notice Swap token → ETH with explicit deadline
    function swapTokensForETH(
        address[] calldata path,
        uint256 amountIn,
        uint256 amountOutMin,
        bool hasTax,
        uint256 deadline
    ) external nonReentrant whenNotPaused returns (uint256 amountOut) {
        return _swapTokensForETH(path, amountIn, amountOutMin, hasTax, deadline);
    }

    function _swapTokensForETH(
        address[] calldata path,
        uint256 amountIn,
        uint256 amountOutMin,
        bool hasTax,
        uint256 deadline
    ) internal returns (uint256 amountOut) {
        if (amountIn == 0) revert ZeroAmount();
        require(path.length >= 2 && path[path.length - 1] == weth, "Path must end with WETH");

        address tokenIn = path[0];

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        _safeResetApprove(tokenIn, address(dexRouter), amountIn);
        _validateSlippage(path, amountIn, amountOutMin);

        if (hasTax) {
            uint256 balBefore = address(this).balance;
            dexRouter.swapExactTokensForETHSupportingFeeOnTransferTokens(
                amountIn, amountOutMin, path, address(this), deadline
            );
            amountOut = address(this).balance - balBefore;
            (bool ok, ) = msg.sender.call{value: amountOut}("");
            require(ok, "ETH transfer failed");
        } else {
            uint256[] memory amounts = dexRouter.swapExactTokensForETH(
                amountIn, amountOutMin, path, msg.sender, deadline
            );
            amountOut = amounts[amounts.length - 1];
        }

        emit Swap(msg.sender, tokenIn, address(0), amountIn, amountOut);
    }

    /// @notice Get expected output for a swap with caller-specified path
    function getAmountOut(
        address[] calldata path,
        uint256 amountIn
    ) external view returns (uint256) {
        uint256[] memory amounts = dexRouter.getAmountsOut(amountIn, path);
        return amounts[amounts.length - 1];
    }

    // ════════════════════════════════════════════════════════════════
    //  OFF-RAMP (deposit → admin confirms → bank transfer)
    // ════════════════════════════════════════════════════════════════

    /// @notice Deposit USDT directly for fiat withdrawal
    function deposit(
        uint256 amount,
        bytes32 bankRef,
        address referrer
    ) external nonReentrant whenNotPaused returns (uint256 id) {
        if (amount == 0) revert ZeroAmount();

        usdt.safeTransferFrom(msg.sender, address(this), amount);
        id = _createWithdrawRequest(msg.sender, address(usdt), amount, bankRef, referrer);
    }

    /// @notice Swap token → USDT and deposit for fiat withdrawal (default 5min deadline)
    function depositAndSwap(
        address[] calldata path,
        uint256 amountIn,
        uint256 minUsdtOut,
        bool hasTax,
        bytes32 bankRef,
        address referrer
    ) external nonReentrant whenNotPaused returns (uint256 id) {
        return _depositAndSwap(path, amountIn, minUsdtOut, hasTax, bankRef, referrer, block.timestamp + 300);
    }

    /// @notice Swap token → USDT and deposit for fiat withdrawal with explicit deadline
    function depositAndSwap(
        address[] calldata path,
        uint256 amountIn,
        uint256 minUsdtOut,
        bool hasTax,
        bytes32 bankRef,
        address referrer,
        uint256 deadline
    ) external nonReentrant whenNotPaused returns (uint256 id) {
        return _depositAndSwap(path, amountIn, minUsdtOut, hasTax, bankRef, referrer, deadline);
    }

    function _depositAndSwap(
        address[] calldata path,
        uint256 amountIn,
        uint256 minUsdtOut,
        bool hasTax,
        bytes32 bankRef,
        address referrer,
        uint256 deadline
    ) internal returns (uint256 id) {
        if (amountIn == 0) revert ZeroAmount();
        require(path.length >= 2 && path[path.length - 1] == address(usdt), "Path must end with USDT");

        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountIn);
        _safeResetApprove(path[0], address(dexRouter), amountIn);
        _validateSlippage(path, amountIn, minUsdtOut);

        uint256 balBefore = usdt.balanceOf(address(this));
        if (hasTax) {
            dexRouter.swapExactTokensForTokensSupportingFeeOnTransferTokens(
                amountIn, minUsdtOut, path, address(this), deadline
            );
        } else {
            dexRouter.swapExactTokensForTokens(
                amountIn, minUsdtOut, path, address(this), deadline
            );
        }
        uint256 usdtReceived = usdt.balanceOf(address(this)) - balBefore;
        if (usdtReceived < minUsdtOut) revert SlippageTooHigh();

        id = _createWithdrawRequest(msg.sender, address(usdt), usdtReceived, bankRef, referrer);
    }

    /// @notice Swap ETH → USDT and deposit for fiat withdrawal (default 5min deadline)
    function depositETH(
        address[] calldata path,
        uint256 minUsdtOut,
        bytes32 bankRef,
        address referrer
    ) external payable nonReentrant whenNotPaused returns (uint256 id) {
        return _depositETH(path, minUsdtOut, bankRef, referrer, block.timestamp + 300);
    }

    /// @notice Swap ETH → USDT and deposit for fiat withdrawal with explicit deadline
    function depositETH(
        address[] calldata path,
        uint256 minUsdtOut,
        bytes32 bankRef,
        address referrer,
        uint256 deadline
    ) external payable nonReentrant whenNotPaused returns (uint256 id) {
        return _depositETH(path, minUsdtOut, bankRef, referrer, deadline);
    }

    function _depositETH(
        address[] calldata path,
        uint256 minUsdtOut,
        bytes32 bankRef,
        address referrer,
        uint256 deadline
    ) internal returns (uint256 id) {
        if (msg.value == 0) revert ZeroAmount();
        require(path.length >= 2 && path[0] == weth && path[path.length - 1] == address(usdt), "Path must be WETH -> ... -> USDT");

        _validateSlippage(path, msg.value, minUsdtOut);

        uint256 balBefore = usdt.balanceOf(address(this));
        dexRouter.swapExactETHForTokensSupportingFeeOnTransferTokens{value: msg.value}(
            minUsdtOut, path, address(this), deadline
        );
        uint256 usdtReceived = usdt.balanceOf(address(this)) - balBefore;
        if (usdtReceived < minUsdtOut) revert SlippageTooHigh();

        id = _createWithdrawRequest(msg.sender, address(usdt), usdtReceived, bankRef, referrer);
    }

    /// @notice Confirm withdrawal — send full net amount to platformWallet
    function confirm(uint256 id) external onlyAdmin nonReentrant {
        _confirm(id, platformWallet);
    }

    /// @notice Confirm withdrawal — send full net amount to a custom address
    function confirm(uint256 id, address to) external onlyAdmin nonReentrant {
        _confirm(id, to);
    }

    /// @dev Internal confirmation path. Always pays the full `req.netAmount`
    ///      to `to`. The custom-amount variant was intentionally removed:
    ///      anything less than netAmount silently extracted the shortfall
    ///      to the platform, which doubled the trust surface on admins and
    ///      made payouts non-auditable from event logs alone.
    function _confirm(uint256 id, address to) internal {
        if (id >= withdrawals.length) revert InvalidRequest();
        if (to == address(0)) revert ZeroAddress();
        WithdrawRequest storage req = withdrawals[id];
        if (req.status != WithdrawStatus.Pending) revert NotPending();
        if (block.timestamp >= req.expiresAt) revert TimeoutReached();

        req.status = WithdrawStatus.Confirmed;
        totalEscrow -= req.grossAmount;
        _removePendingId(id);

        // Affiliate fee split. Prefer the new shared Affiliate contract when
        // configured (sticky referrer + lifetime stats + pull-claim). Falls
        // back to the legacy direct-pay path while admin migrates.
        uint256 platformFee = req.fee;
        if (affiliate != address(0)) {
            if (req.token == address(usdt) && req.fee > 0) {
                // Approve exactly req.fee — never grant a standing allowance
                // that a compromised affiliate could drain. forceApprove
                // handles the USDT zero-then-set quirk; we set 0 again at
                // the end so leftover allowance can never linger.
                usdt.forceApprove(affiliate, req.fee);
                uint256 balBefore = usdt.balanceOf(address(this));
                try IAffiliateReporter(affiliate).report(req.user, req.referrer, req.fee) {
                    uint256 pulled = balBefore - usdt.balanceOf(address(this));
                    // Affiliate must not pull more than the fee it was told
                    // about. Anything above that is escrow theft, so we
                    // revert the whole confirm rather than silently absorbing
                    // the loss. The revert rolls back the forceApprove above
                    // too, so no stale allowance leaks; user can re-confirm
                    // after the owner rotates the affiliate.
                    if (pulled > req.fee) revert AffiliateOverpull();
                    platformFee = req.fee - pulled;
                } catch {}
                usdt.forceApprove(affiliate, 0);
            }
        } else if (affiliateEnabled && req.referrer != address(0) && req.referrer != req.user) {
            uint256 referralCut = (req.fee * affiliateShareBps) / 10000;
            if (referralCut > 0) {
                platformFee -= referralCut;
                // CEI ok: status was set to Confirmed above, totalEscrow was
                // already decremented, _removePendingId already swap-popped.
                // Reentry into _confirm via this transfer hits NotPending.
                // nonReentrant on the entry-point is the outer guard.
                IERC20(req.token).safeTransfer(req.referrer, referralCut);
                emit AffiliatePaid(id, req.referrer, referralCut);
            }
        }
        platformEarnings[req.token] += platformFee;

        IERC20(req.token).safeTransfer(to, req.netAmount);

        emit WithdrawConfirmed(id, msg.sender, to, req.netAmount, req.grossAmount, req.fee, req.token);
    }

    /// @notice Batch confirm — all net amounts to platformWallet, with proper affiliate handling
    function confirmBatch(uint256[] calldata ids) external onlyAdmin nonReentrant returns (uint256 confirmed) {
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 id = ids[i];
            if (id >= withdrawals.length) continue;
            if (withdrawals[id].status != WithdrawStatus.Pending) continue;
            // Use the per-request snapshot, not the live config. payoutTimeout
            // is mutable; expiresAt is locked in at deposit time. Otherwise a
            // shortened payoutTimeout would silently skip still-valid ids.
            if (block.timestamp >= withdrawals[id].expiresAt) continue;

            _confirm(id, platformWallet);
            confirmed++;
        }
    }

    /// @notice User cancels if admin hasn't confirmed within timeout
    function cancel(uint256 id) external nonReentrant {
        if (id >= withdrawals.length) revert InvalidRequest();
        WithdrawRequest storage req = withdrawals[id];
        if (req.user != msg.sender) revert NotRequestOwner();
        if (req.status != WithdrawStatus.Pending) revert NotPending();
        if (block.timestamp < req.expiresAt) revert TimeoutNotReached();

        req.status = WithdrawStatus.Cancelled;
        totalEscrow -= req.grossAmount;
        _removePendingId(id);

        IERC20(req.token).safeTransfer(msg.sender, req.grossAmount);

        emit WithdrawCancelled(id, msg.sender, req.grossAmount);
    }

    // ════════════════════════════════════════════════════════════════
    //  VIEWS (FIX #5: O(1) indexed lookups instead of O(n) loops)
    // ════════════════════════════════════════════════════════════════

    function totalWithdrawals() external view returns (uint256) {
        return withdrawals.length;
    }

    function getWithdrawal(uint256 id) external view returns (WithdrawRequest memory) {
        return withdrawals[id];
    }

    /// @notice Get pending withdrawal count
    function pendingCount() external view returns (uint256) {
        return pendingIds.length;
    }

    /// @notice Get pending withdrawals (paginated, O(1) per item)
    function getPendingWithdrawals(uint256 offset, uint256 limit)
        external view returns (WithdrawRequest[] memory result, uint256 total)
    {
        total = pendingIds.length;
        if (offset >= total) return (new WithdrawRequest[](0), total);

        uint256 end = offset + limit > total ? total : offset + limit;
        result = new WithdrawRequest[](end - offset);
        for (uint256 i = 0; i < result.length; i++) {
            result[i] = withdrawals[pendingIds[offset + i]];
        }
    }

    /// @notice Get user's withdrawal history (paginated, O(1) per item)
    function getUserWithdrawals(address user, uint256 offset, uint256 limit)
        external view returns (WithdrawRequest[] memory result, uint256[] memory withdrawIds, uint256 total)
    {
        uint256[] storage ids = userWithdrawIds[user];
        total = ids.length;
        if (offset >= total) return (new WithdrawRequest[](0), new uint256[](0), total);

        uint256 end = offset + limit > total ? total : offset + limit;
        uint256 count = end - offset;
        result = new WithdrawRequest[](count);
        withdrawIds = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            withdrawIds[i] = ids[offset + i];
            result[i] = withdrawals[ids[offset + i]];
        }
    }

    /// @notice Admin refund: return escrowed USDT to the user for a timed-out
    ///         withdrawal the user hasn't cancelled themselves. Only callable
    ///         by admins, only for Pending withdrawals past the timeout.
    function refund(uint256 id) external onlyAdmin nonReentrant {
        if (id >= withdrawals.length) revert InvalidRequest();
        WithdrawRequest storage req = withdrawals[id];
        if (req.status != WithdrawStatus.Pending) revert NotPending();
        if (block.timestamp < req.expiresAt) revert TimeoutNotReached();

        req.status = WithdrawStatus.Cancelled;
        totalEscrow -= req.grossAmount;
        _removePendingId(id);

        IERC20(req.token).safeTransfer(req.user, req.grossAmount);

        emit WithdrawCancelled(id, req.user, req.grossAmount);
    }

    /// @notice Preview fee and net amount for a deposit
    function previewDeposit(uint256 amount) external view returns (
        uint256 fee, uint256 netAmount
    ) {
        fee = (amount * feeBps) / 10000;
        netAmount = amount - fee;
    }

    // ════════════════════════════════════════════════════════════════
    //  ADMIN
    // ════════════════════════════════════════════════════════════════

    // FIX #7: Pausable
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function setFeeBps(uint256 newFee) external onlyOwner {
        if (newFee > MAX_FEE_BPS) revert InvalidFee();
        emit FeeUpdated(feeBps, newFee);
        feeBps = newFee;
    }

    function setPayoutTimeout(uint256 newTimeout) external onlyOwner {
        if (newTimeout < MIN_TIMEOUT || newTimeout > MAX_TIMEOUT) revert InvalidTimeout();
        emit TimeoutUpdated(payoutTimeout, newTimeout);
        payoutTimeout = newTimeout;
    }

    function setMaxSlippage(uint256 newBps) external onlyOwner {
        if (newBps > MAX_SLIPPAGE_CAP) revert SlippageConfigTooHigh();
        emit MaxSlippageUpdated(maxSlippageBps, newBps);
        maxSlippageBps = newBps;
    }

    /// @notice Set the minimum withdrawal value in USDT native units. Pass 0
    ///         to disable the floor. Anti-dust storage protection — see
    ///         `minWithdrawUsdt` declaration for context.
    function setMinWithdrawUsdt(uint256 newMin) external onlyOwner {
        emit MinWithdrawUpdated(minWithdrawUsdt, newMin);
        minWithdrawUsdt = newMin;
    }

    function setAffiliateEnabled(bool enabled) external onlyOwner {
        affiliateEnabled = enabled;
        emit AffiliateEnabledUpdated(enabled);
    }

    function setAffiliateShare(uint256 bps) external onlyOwner {
        if (bps > 5000) revert InvalidFee(); // max 50% of fee to affiliate
        emit AffiliateShareUpdated(affiliateShareBps, bps);
        affiliateShareBps = bps;
    }

    function setPlatformWallet(address wallet) external onlyOwner {
        if (wallet == address(0)) revert ZeroAddress();
        emit PlatformWalletUpdated(platformWallet, wallet);
        platformWallet = wallet;
    }

    function addAdmin(address admin) external onlyOwner {
        if (isAdmin[admin]) revert AlreadyAdmin();
        if (admins.length >= 20) revert TooManyAdmins();
        isAdmin[admin] = true;
        adminIdxOf[admin] = admins.length;
        admins.push(admin);
        emit AdminAdded(admin);
    }

    /// @dev O(1) swap-and-pop removal
    function removeAdmin(address admin) external onlyOwner {
        if (!isAdmin[admin]) revert NotAnAdmin();
        if (admin == msg.sender) revert CannotRemoveSelf();
        isAdmin[admin] = false;

        uint256 idx = adminIdxOf[admin];
        address last = admins[admins.length - 1];
        admins[idx] = last;
        adminIdxOf[last] = idx;
        admins.pop();
        delete adminIdxOf[admin];

        emit AdminRemoved(admin);
    }

    function getAdmins() external view returns (address[] memory) {
        return admins;
    }

    /// @notice Get all router state in one call (saves RPC calls)
    function getState() external view returns (RouterState memory) {
        return RouterState({
            owner: owner(),
            feeBps: feeBps,
            payoutTimeout: payoutTimeout,
            platformWallet: platformWallet,
            totalEscrow: totalEscrow,
            pendingCount: pendingIds.length,
            totalWithdrawals: withdrawals.length,
            paused: paused(),
            maxSlippageBps: maxSlippageBps,
            affiliateEnabled: affiliateEnabled,
            affiliateShareBps: affiliateShareBps,
            admins: admins
        });
    }

    /// @notice Withdraw all available tokens (earnings + unaccounted) to platformWallet
    function withdraw() external onlyOwner nonReentrant {
        _withdraw(platformWallet, 0);
    }

    /// @notice Withdraw all available tokens to custom address
    function withdraw(address to) external onlyOwner nonReentrant {
        _withdraw(to, 0);
    }

    /// @notice Withdraw specific amount to custom address
    function withdraw(address to, uint256 amount) external onlyOwner nonReentrant {
        _withdraw(to, amount);
    }

    function _withdraw(address to, uint256 customAmount) internal {
        if (to == address(0)) revert ZeroAddress();
        // Available = total balance - escrow (user funds we can't touch)
        uint256 balance = usdt.balanceOf(address(this));
        uint256 available = balance > totalEscrow ? balance - totalEscrow : 0;
        if (available == 0) revert InsufficientEarnings();

        uint256 amount = customAmount > 0 && customAmount <= available ? customAmount : available;

        // Decrement only the earnings portion. Anything above platformEarnings
        // is unaccounted dust (rounding, accidental sends) — it leaves the
        // contract but should never have been counted as fee income.
        uint256 earned = platformEarnings[address(usdt)];
        platformEarnings[address(usdt)] = amount >= earned ? 0 : earned - amount;

        usdt.safeTransfer(to, amount);
        emit FeesWithdrawn(address(usdt), amount, to);
    }

    /// @notice Withdraw native BNB/ETH from contract
    function withdrawETH() external onlyOwner nonReentrant {
        uint256 balance = address(this).balance;
        if (balance == 0) revert ZeroAmount();
        (bool ok, ) = platformWallet.call{value: balance}("");
        require(ok, "ETH transfer failed");
    }

    /// @notice Rescue any ERC20 token stuck in the contract (dust, accidental sends)
    /// @dev Cannot withdraw more USDT than available (balance - escrow)
    function rescueToken(address token) external onlyOwner nonReentrant {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance == 0) revert ZeroAmount();

        uint256 withdrawable;
        if (token == address(usdt)) {
            // For USDT: only withdraw what's above escrow
            withdrawable = balance > totalEscrow ? balance - totalEscrow : 0;
            if (withdrawable == 0) revert InsufficientEarnings();
            // Decrement only the earnings portion. Dust (anything above
            // platformEarnings) is rescued without polluting the earnings
            // counter — keep that as a faithful record of fees collected.
            uint256 earned = platformEarnings[token];
            platformEarnings[token] = withdrawable >= earned ? 0 : earned - withdrawable;
        } else {
            // For any other token: withdraw everything
            withdrawable = balance;
        }

        IERC20(token).safeTransfer(platformWallet, withdrawable);
        emit TokenRescued(token, withdrawable, platformWallet);
    }

    // ════════════════════════════════════════════════════════════════
    //  INTERNAL
    // ════════════════════════════════════════════════════════════════

    function _createWithdrawRequest(
        address user,
        address token,
        uint256 grossAmount,
        bytes32 bankRef,
        address referrer
    ) internal returns (uint256 id) {
        // Anti-dust floor. Single chokepoint catches all three deposit paths
        // (deposit, depositAndSwap, depositETH) so attackers can't bloat the
        // unbounded `withdrawals` / `pendingIds` arrays with sub-cent requests.
        if (minWithdrawUsdt > 0 && grossAmount < minWithdrawUsdt) revert BelowMinWithdraw();
        // bankRef must be unique across all withdrawals (zero is the
        // explicit "no ref provided" sentinel and is allowed for
        // anonymous deposits). Pre-deposit dedup so the off-ramp
        // processor can rely on bankRef as a stable lookup key.
        if (bankRef != bytes32(0)) {
            if (bankRefUsed[bankRef]) revert BankRefAlreadyUsed();
            bankRefUsed[bankRef] = true;
        }

        uint256 fee = (grossAmount * feeBps) / 10000;
        uint256 netAmount = grossAmount - fee;

        id = withdrawals.length;
        withdrawals.push(WithdrawRequest({
            user: user,
            token: token,
            grossAmount: grossAmount,
            fee: fee,
            netAmount: netAmount,
            createdAt: block.timestamp,
            expiresAt: block.timestamp + payoutTimeout,
            status: WithdrawStatus.Pending,
            bankRef: bankRef,
            referrer: referrer
        }));

        totalEscrow += grossAmount;

        // FIX #5: Maintain indexes
        pendingIdxOf[id] = pendingIds.length;
        pendingIds.push(id);
        userWithdrawIds[user].push(id);

        emit WithdrawRequested(id, user, token, grossAmount, fee, netAmount, bankRef, referrer, block.timestamp + payoutTimeout);
    }

    /// @dev Remove id from pendingIds using swap-and-pop (O(1))
    function _removePendingId(uint256 id) internal {
        if (pendingIds.length == 0) revert EmptyPending();
        uint256 idx = pendingIdxOf[id];
        uint256 lastId = pendingIds[pendingIds.length - 1];
        pendingIds[idx] = lastId;
        pendingIdxOf[lastId] = idx;
        pendingIds.pop();
        delete pendingIdxOf[id];
    }

    /// @dev Validate that slippage tolerance isn't too loose
    /// Compares amountOutMin against expected output from DEX quote.
    /// Fail-closed: amountOutMin == 0 and missing/zero quotes both revert,
    /// so the maxSlippageBps cap can't be bypassed by opting out or by
    /// pointing at a manipulated pool that returns 0.
    function _validateSlippage(address[] calldata path, uint256 amountIn, uint256 amountOutMin) internal view {
        if (amountOutMin == 0) revert SlippageRequired();
        try dexRouter.getAmountsOut(amountIn, path) returns (uint256[] memory amounts) {
            uint256 expected = amounts[amounts.length - 1];
            if (expected == 0) revert SlippageQuoteUnavailable();
            uint256 minAllowed = (expected * (10000 - maxSlippageBps)) / 10000;
            if (amountOutMin < minAllowed) revert SlippageTooHigh();
        } catch {
            revert SlippageQuoteUnavailable();
        }
    }

    /// @dev FIX #1: Reset allowance to 0, then set to exact amount
    function _safeResetApprove(address token, address spender, uint256 amount) internal {
        IERC20(token).forceApprove(spender, amount);
    }


    receive() external payable {}
}
