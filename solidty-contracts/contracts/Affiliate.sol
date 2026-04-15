// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title Affiliate
 * @notice Single source of truth for referrer↔wallet mapping and earnings
 *         across TokenKrafter revenue contracts (TokenFactory, TradeRouter,
 *         LaunchInstance).
 *
 * Flow:
 *   1. A user who lands via ?ref= can call {registerReferrer} to bind the
 *      relationship as soon as they connect their wallet — before the
 *      first paying action. Alternatively, the first {report} call for
 *      that user with a non-zero `ref` param also binds it (sticky).
 *   2. A whitelisted reporter (revenue contract) collects a platform fee
 *      in USDT. After netting third-party pass-through costs (e.g.
 *      Flutterwave on off-ramp), the reporter calls {report}, and this
 *      contract pulls `shareBps` of that fee via transferFrom.
 *   3. The cut is credited to the referrer's pending balance and
 *      aggregate stats update (lifetime earned, action count, last seen).
 *   4. Referrers pull-claim their accrued earnings via {claim} once their
 *      pending balance clears `minClaim`. No auto-send — payout is always
 *      user-initiated, which avoids mis-routed funds and lets referrers
 *      control their gas.
 *
 * @dev Reporters should pre-approve this contract for `type(uint256).max`
 *      of USDT at their init/deploy time to avoid per-call approve gas.
 *      On networks with the Ethereum USDT approval quirk (reset-to-zero
 *      before change), use SafeERC20.forceApprove.
 */
contract Affiliate is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdt;
    uint8 public immutable usdtDecimals;

    struct Stats {
        uint256 pending;          // claimable balance
        uint256 totalEarned;      // lifetime gross (never decremented)
        uint32 referredCount;     // unique wallets bonded to this referrer
        uint32 actionCount;       // total reports credited to this referrer
        uint64 lastActionAt;      // unix seconds of most recent credit
    }

    mapping(address => address) public referrerOf;
    mapping(address => Stats) public stats;
    mapping(address => bool) public authorized;

    uint256 public shareBps = 2500;           // 25% of reported platform fee
    uint256 public minClaim;                  // default: 1 USDT (set in constructor)

    event ReferrerSet(address indexed user, address indexed referrer);
    event Reported(address indexed user, address indexed referrer, uint256 platformFee, uint256 affiliateCut);
    event Claimed(address indexed referrer, uint256 amount);
    event AuthorizedReporter(address indexed reporter, bool enabled);
    event ShareUpdated(uint256 bps);
    event MinClaimUpdated(uint256 minClaim);

    error NotAuthorized();
    error SelfReferral();
    error InvalidShare();
    error BelowMinClaim();
    error NothingToClaim();
    error ZeroReferrer();

    constructor(address usdt_, address admin) Ownable(admin) {
        usdt = IERC20(usdt_);
        uint8 d = _tryDecimals(usdt_);
        usdtDecimals = d == 0 ? 18 : d;
        minClaim = 10 ** usdtDecimals; // 1 USDT
    }

    // ── User-facing binding ─────────────────────────────────

    /**
     * @notice Bind yourself to a referrer as soon as you land, before any
     *         paying action. No-op if you're already bound.
     * @param ref The referrer to bind to. Must be non-zero and not yourself.
     */
    function registerReferrer(address ref) external {
        if (ref == address(0)) revert ZeroReferrer();
        if (ref == msg.sender) revert SelfReferral();
        if (referrerOf[msg.sender] != address(0)) return; // sticky

        referrerOf[msg.sender] = ref;
        unchecked { stats[ref].referredCount += 1; }
        emit ReferrerSet(msg.sender, ref);
    }

    // ── Reporter API ────────────────────────────────────────

    /**
     * @notice Credit affiliate earnings for a user's paid action.
     * @param user       End user who paid the platform fee.
     * @param ref        Proposed referrer (ignored if user already has one).
     * @param platformFee Net platform fee (USDT) the reporter has just
     *                    collected, with third-party costs already subtracted.
     *                    The reporter must have approved this contract for
     *                    at least `platformFee * shareBps / 10000`.
     */
    function report(address user, address ref, uint256 platformFee) external nonReentrant {
        if (!authorized[msg.sender]) revert NotAuthorized();
        if (ref == user) revert SelfReferral();

        if (referrerOf[user] == address(0) && ref != address(0)) {
            referrerOf[user] = ref;
            unchecked { stats[ref].referredCount += 1; }
            emit ReferrerSet(user, ref);
        }

        address r = referrerOf[user];
        if (r == address(0) || platformFee == 0) return;

        uint256 cut = (platformFee * shareBps) / 10_000;
        if (cut == 0) return;

        usdt.safeTransferFrom(msg.sender, address(this), cut);

        Stats storage s = stats[r];
        s.pending += cut;
        s.totalEarned += cut;
        unchecked {
            s.actionCount += 1;
            s.lastActionAt = uint64(block.timestamp);
        }

        emit Reported(user, r, platformFee, cut);
    }

    // ── Claim ───────────────────────────────────────────────

    /// @notice Pull-claim your accrued affiliate earnings.
    function claim() external nonReentrant {
        Stats storage s = stats[msg.sender];
        uint256 amt = s.pending;
        if (amt == 0) revert NothingToClaim();
        if (amt < minClaim) revert BelowMinClaim();

        s.pending = 0;
        usdt.safeTransfer(msg.sender, amt);
        emit Claimed(msg.sender, amt);
    }

    // ── Views ───────────────────────────────────────────────

    /// @notice Return everything a dashboard needs for a referrer in one call.
    function getStats(address referrer) external view returns (
        uint256 pending,
        uint256 totalEarned,
        uint256 totalClaimed,
        uint32 referredCount,
        uint32 actionCount,
        uint64 lastActionAt
    ) {
        Stats storage s = stats[referrer];
        return (
            s.pending,
            s.totalEarned,
            s.totalEarned - s.pending,
            s.referredCount,
            s.actionCount,
            s.lastActionAt
        );
    }

    // ── Admin ───────────────────────────────────────────────

    function setAuthorized(address reporter, bool enabled) external onlyOwner {
        authorized[reporter] = enabled;
        emit AuthorizedReporter(reporter, enabled);
    }

    function setShareBps(uint256 bps) external onlyOwner {
        if (bps > 10_000) revert InvalidShare();
        shareBps = bps;
        emit ShareUpdated(bps);
    }

    function setMinClaim(uint256 amount) external onlyOwner {
        minClaim = amount;
        emit MinClaimUpdated(amount);
    }

    // ── Internal ────────────────────────────────────────────

    function _tryDecimals(address token) internal view returns (uint8) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSignature("decimals()"));
        if (ok && data.length >= 32) return abi.decode(data, (uint8));
        return 0;
    }
}
