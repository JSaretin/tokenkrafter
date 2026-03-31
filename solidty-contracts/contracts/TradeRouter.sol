// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

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
        WithdrawStatus status;
        bytes32 bankRef;        // hashed bank reference (off-chain lookup)
    }

    // ── State ───────────────────────────────────────────────────────
    ISwapRouter public immutable dexRouter;
    address public immutable weth;
    IERC20 public immutable usdt;

    uint256 public feeBps = 10;                 // 0.1% default
    uint256 public payoutTimeout = 300;         // 5 minutes default
    address public platformWallet;
    address[] public admins;
    mapping(address => bool) public isAdmin;

    // FIX #5: Index mappings for O(1) lookups instead of O(n) loops
    WithdrawRequest[] public withdrawals;
    uint256[] public pendingIds;                            // active pending request IDs
    mapping(uint256 => uint256) internal pendingIdxOf;      // id → index in pendingIds
    mapping(address => uint256[]) internal userWithdrawIds;  // user → their request IDs

    uint256 public totalEscrow;                             // total user funds held
    mapping(address => uint256) public platformEarnings;    // per token

    uint256 public constant MAX_FEE_BPS = 100;  // max 1%
    uint256 public constant MIN_TIMEOUT = 120;  // min 2 minutes
    uint256 public constant MAX_TIMEOUT = 86400; // max 24 hours

    // ── Events ──────────────────────────────────────────────────────
    event Swap(
        address indexed user, address tokenIn, address tokenOut,
        uint256 amountIn, uint256 amountOut
    );
    event WithdrawRequested(
        uint256 indexed id, address indexed user,
        address token, uint256 grossAmount, uint256 fee,
        uint256 netAmount, bytes32 bankRef
    );
    event WithdrawConfirmed(uint256 indexed id, address indexed admin);
    event WithdrawCancelled(uint256 indexed id, address indexed user);
    event FeesWithdrawn(address indexed token, uint256 amount, address indexed to);
    event FeeUpdated(uint256 oldFee, uint256 newFee);
    event TimeoutUpdated(uint256 oldTimeout, uint256 newTimeout);
    event AdminAdded(address indexed admin);
    event AdminRemoved(address indexed admin);
    event PlatformWalletUpdated(address indexed oldWallet, address indexed newWallet);

    // ── Errors ──────────────────────────────────────────────────────
    error NotAdmin();
    error InvalidFee();
    error InvalidTimeout();
    error ZeroAmount();
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
    error EmptyPending();

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
        admins.push(msg.sender);
    }

    // ════════════════════════════════════════════════════════════════
    //  SWAP (direct, no escrow)
    // ════════════════════════════════════════════════════════════════

    /// @notice Swap token → token via DEX (supports fee-on-transfer tokens)
    function swapTokens(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        bool hasTax
    ) external nonReentrant whenNotPaused returns (uint256 amountOut) {
        if (amountIn == 0) revert ZeroAmount();

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        // FIX #1: Reset-approve pattern to prevent allowance accumulation
        _safeResetApprove(tokenIn, address(dexRouter), amountIn);

        address[] memory path = _buildPath(tokenIn, tokenOut);

        if (hasTax) {
            uint256 balBefore = IERC20(tokenOut).balanceOf(msg.sender);
            dexRouter.swapExactTokensForTokensSupportingFeeOnTransferTokens(
                amountIn, amountOutMin, path, msg.sender, block.timestamp
            );
            amountOut = IERC20(tokenOut).balanceOf(msg.sender) - balBefore;
        } else {
            uint256[] memory amounts = dexRouter.swapExactTokensForTokens(
                amountIn, amountOutMin, path, msg.sender, block.timestamp
            );
            amountOut = amounts[amounts.length - 1];
        }

        emit Swap(msg.sender, tokenIn, tokenOut, amountIn, amountOut);
    }

    /// @notice Swap ETH → token via DEX
    function swapETHForTokens(
        address tokenOut,
        uint256 amountOutMin,
        bool hasTax
    ) external payable nonReentrant whenNotPaused returns (uint256 amountOut) {
        if (msg.value == 0) revert ZeroAmount();

        address[] memory path = new address[](2);
        path[0] = weth;
        path[1] = tokenOut;

        if (hasTax) {
            uint256 balBefore = IERC20(tokenOut).balanceOf(msg.sender);
            dexRouter.swapExactETHForTokensSupportingFeeOnTransferTokens{value: msg.value}(
                amountOutMin, path, msg.sender, block.timestamp
            );
            amountOut = IERC20(tokenOut).balanceOf(msg.sender) - balBefore;
        } else {
            uint256[] memory amounts = dexRouter.swapExactETHForTokens{value: msg.value}(
                amountOutMin, path, msg.sender, block.timestamp
            );
            amountOut = amounts[amounts.length - 1];
        }

        emit Swap(msg.sender, address(0), tokenOut, msg.value, amountOut);
    }

    /// @notice Swap token → ETH via DEX
    function swapTokensForETH(
        address tokenIn,
        uint256 amountIn,
        uint256 amountOutMin,
        bool hasTax
    ) external nonReentrant whenNotPaused returns (uint256 amountOut) {
        if (amountIn == 0) revert ZeroAmount();

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        // FIX #1: Reset-approve pattern
        _safeResetApprove(tokenIn, address(dexRouter), amountIn);

        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = weth;

        if (hasTax) {
            uint256 balBefore = address(msg.sender).balance;
            dexRouter.swapExactTokensForETHSupportingFeeOnTransferTokens(
                amountIn, amountOutMin, path, msg.sender, block.timestamp
            );
            amountOut = address(msg.sender).balance - balBefore;
        } else {
            uint256[] memory amounts = dexRouter.swapExactTokensForETH(
                amountIn, amountOutMin, path, msg.sender, block.timestamp
            );
            amountOut = amounts[amounts.length - 1];
        }

        emit Swap(msg.sender, tokenIn, address(0), amountIn, amountOut);
    }

    /// @notice Get expected output for a swap (for UI preview)
    function getAmountOut(
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) external view returns (uint256) {
        address[] memory path = _buildPath(tokenIn, tokenOut);
        uint256[] memory amounts = dexRouter.getAmountsOut(amountIn, path);
        return amounts[amounts.length - 1];
    }

    // ════════════════════════════════════════════════════════════════
    //  OFF-RAMP (deposit → admin confirms → bank transfer)
    // ════════════════════════════════════════════════════════════════

    /// @notice Deposit USDT directly for fiat withdrawal
    function deposit(
        uint256 amount,
        bytes32 bankRef
    ) external nonReentrant whenNotPaused returns (uint256 id) {
        if (amount == 0) revert ZeroAmount();

        usdt.safeTransferFrom(msg.sender, address(this), amount);
        id = _createWithdrawRequest(msg.sender, address(usdt), amount, bankRef);
    }

    /// @notice Swap any token → USDT and deposit for fiat withdrawal
    function depositAndSwap(
        address tokenIn,
        uint256 amountIn,
        uint256 minUsdtOut,
        bool hasTax,
        bytes32 bankRef
    ) external nonReentrant whenNotPaused returns (uint256 id) {
        if (amountIn == 0) revert ZeroAmount();

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        // FIX #1: Reset-approve pattern
        _safeResetApprove(tokenIn, address(dexRouter), amountIn);

        address[] memory path = _buildPath(tokenIn, address(usdt));

        uint256 usdtReceived;
        // FIX #4: Use fee-on-transfer variant for all depositAndSwap
        // (safe for non-taxed tokens too, just slightly more gas)
        uint256 balBefore = usdt.balanceOf(address(this));
        if (hasTax) {
            dexRouter.swapExactTokensForTokensSupportingFeeOnTransferTokens(
                amountIn, minUsdtOut, path, address(this), block.timestamp
            );
        } else {
            dexRouter.swapExactTokensForTokens(
                amountIn, minUsdtOut, path, address(this), block.timestamp
            );
        }
        usdtReceived = usdt.balanceOf(address(this)) - balBefore;

        id = _createWithdrawRequest(msg.sender, address(usdt), usdtReceived, bankRef);
    }

    /// @notice Swap ETH → USDT and deposit for fiat withdrawal
    /// @dev Uses fee-on-transfer safe pattern (FIX #4)
    function depositETH(
        uint256 minUsdtOut,
        bytes32 bankRef
    ) external payable nonReentrant whenNotPaused returns (uint256 id) {
        if (msg.value == 0) revert ZeroAmount();

        address[] memory path = new address[](2);
        path[0] = weth;
        path[1] = address(usdt);

        // FIX #1 (depositETH): Use fee-on-transfer safe variant
        uint256 balBefore = usdt.balanceOf(address(this));
        dexRouter.swapExactETHForTokensSupportingFeeOnTransferTokens{value: msg.value}(
            minUsdtOut, path, address(this), block.timestamp
        );
        uint256 usdtReceived = usdt.balanceOf(address(this)) - balBefore;

        id = _createWithdrawRequest(msg.sender, address(usdt), usdtReceived, bankRef);
    }

    /// @notice Admin confirms withdrawal (means bank transfer is being sent NOW)
    /// @dev FIX #3: Admin CANNOT confirm after timeout — prevents race with user cancel
    function confirm(uint256 id) external onlyAdmin nonReentrant {
        if (id >= withdrawals.length) revert InvalidRequest();
        WithdrawRequest storage req = withdrawals[id];
        if (req.status != WithdrawStatus.Pending) revert NotPending();
        if (block.timestamp >= req.createdAt + payoutTimeout) revert TimeoutReached();

        req.status = WithdrawStatus.Confirmed;

        // Move fee to platform earnings
        platformEarnings[req.token] += req.fee;
        totalEscrow -= req.grossAmount;

        // FIX #5: Remove from pending index
        _removePendingId(id);

        emit WithdrawConfirmed(id, msg.sender);
    }

    /// @notice Batch confirm multiple withdrawals (skips invalid/expired, doesn't revert)
    function confirmBatch(uint256[] calldata ids) external onlyAdmin nonReentrant returns (uint256 confirmed) {
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 id = ids[i];
            if (id >= withdrawals.length) continue;
            WithdrawRequest storage req = withdrawals[id];
            if (req.status != WithdrawStatus.Pending) continue;
            if (block.timestamp >= req.createdAt + payoutTimeout) continue;

            req.status = WithdrawStatus.Confirmed;
            platformEarnings[req.token] += req.fee;
            totalEscrow -= req.grossAmount;
            _removePendingId(id);
            confirmed++;

            emit WithdrawConfirmed(id, msg.sender);
        }
    }

    /// @notice User cancels if admin hasn't confirmed within timeout
    function cancel(uint256 id) external nonReentrant {
        if (id >= withdrawals.length) revert InvalidRequest();
        WithdrawRequest storage req = withdrawals[id];
        if (req.user != msg.sender) revert NotRequestOwner();
        if (req.status != WithdrawStatus.Pending) revert NotPending();
        if (block.timestamp < req.createdAt + payoutTimeout) revert TimeoutNotReached();

        req.status = WithdrawStatus.Cancelled;
        totalEscrow -= req.grossAmount;
        _removePendingId(id);

        // Return full amount (no fee since not processed)
        IERC20(req.token).safeTransfer(msg.sender, req.grossAmount);

        emit WithdrawCancelled(id, msg.sender);
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
        external view returns (WithdrawRequest[] memory result, uint256 total)
    {
        uint256[] storage ids = userWithdrawIds[user];
        total = ids.length;
        if (offset >= total) return (new WithdrawRequest[](0), total);

        uint256 end = offset + limit > total ? total : offset + limit;
        result = new WithdrawRequest[](end - offset);
        for (uint256 i = 0; i < result.length; i++) {
            result[i] = withdrawals[ids[offset + i]];
        }
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

    // FIX #6: Validate platformWallet not zero + FIX #5b: emit event
    function setPlatformWallet(address wallet) external onlyOwner {
        if (wallet == address(0)) revert ZeroAddress();
        emit PlatformWalletUpdated(platformWallet, wallet);
        platformWallet = wallet;
    }

    function addAdmin(address admin) external onlyOwner {
        if (isAdmin[admin]) revert AlreadyAdmin();
        isAdmin[admin] = true;
        admins.push(admin);
        emit AdminAdded(admin);
    }

    function removeAdmin(address admin) external onlyOwner {
        if (!isAdmin[admin]) revert NotAnAdmin();
        if (admin == msg.sender) revert CannotRemoveSelf();
        isAdmin[admin] = false;
        for (uint256 i = 0; i < admins.length; i++) {
            if (admins[i] == admin) {
                admins[i] = admins[admins.length - 1];
                admins.pop();
                break;
            }
        }
        emit AdminRemoved(admin);
    }

    function getAdmins() external view returns (address[] memory) {
        return admins;
    }

    /// @notice Withdraw accumulated platform fees (ONLY from earnings, never escrow)
    function withdrawFees(address token) external onlyOwner nonReentrant {
        uint256 amount = platformEarnings[token];
        if (amount == 0) revert InsufficientEarnings();

        platformEarnings[token] = 0;
        IERC20(token).safeTransfer(platformWallet, amount);

        emit FeesWithdrawn(token, amount, platformWallet);
    }

    // ════════════════════════════════════════════════════════════════
    //  INTERNAL
    // ════════════════════════════════════════════════════════════════

    function _createWithdrawRequest(
        address user,
        address token,
        uint256 grossAmount,
        bytes32 bankRef
    ) internal returns (uint256 id) {
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
            status: WithdrawStatus.Pending,
            bankRef: bankRef
        }));

        totalEscrow += grossAmount;

        // FIX #5: Maintain indexes
        pendingIdxOf[id] = pendingIds.length;
        pendingIds.push(id);
        userWithdrawIds[user].push(id);

        emit WithdrawRequested(id, user, token, grossAmount, fee, netAmount, bankRef);
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

    /// @dev FIX #1: Reset allowance to 0, then set to exact amount
    function _safeResetApprove(address token, address spender, uint256 amount) internal {
        IERC20(token).forceApprove(spender, amount);
    }

    function _buildPath(address tokenIn, address tokenOut) internal view returns (address[] memory) {
        if (tokenIn != weth && tokenOut != weth) {
            address[] memory path = new address[](3);
            path[0] = tokenIn;
            path[1] = weth;
            path[2] = tokenOut;
            return path;
        }
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;
        return path;
    }

    receive() external payable {}
}
