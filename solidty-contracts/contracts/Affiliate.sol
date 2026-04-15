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
 *   1. A whitelisted reporter (revenue contract) collects a platform fee in
 *      USDT. After netting third-party pass-through costs (e.g. Flutterwave
 *      on off-ramp), the reporter approves this contract for the affiliate
 *      cut and calls {report}.
 *   2. On first-ever {report} for a given user with a non-zero `ref`, the
 *      referrer is stickily bound: `referrerOf[user] = ref`. Subsequent
 *      calls ignore the `ref` param for that user — the original referrer
 *      earns on every future action.
 *   3. The affiliate cut (shareBps of platformFee) is pulled from the
 *      reporter and credited to the referrer's balance. No token leaves
 *      this contract until the referrer calls {claim}.
 *
 * Claims are pull-only: the referrer must call {claim} themselves once
 * their balance clears `minClaim`. No automatic sends — avoids mis-routed
 * funds and gives the referrer control of gas costs.
 */
contract Affiliate is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdt;
    uint8 public immutable usdtDecimals;

    mapping(address => address) public referrerOf;
    mapping(address => uint256) public earned;
    mapping(address => bool) public authorized;

    uint256 public shareBps = 2500;           // 25% of reported platform fee
    uint256 public minClaim;                  // initialized in constructor: 1 USDT

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

    constructor(address usdt_, address admin) Ownable(admin) {
        usdt = IERC20(usdt_);
        uint8 d = _tryDecimals(usdt_);
        usdtDecimals = d == 0 ? 18 : d;
        minClaim = 10 ** usdtDecimals; // 1 USDT
    }

    // ── Reporter API ────────────────────────────────────────

    /**
     * @notice Credit affiliate earnings for a user's paid action.
     * @param user       End user who paid the platform fee.
     * @param ref        Proposed referrer (ignored if user already has one).
     * @param platformFee Net platform fee (USDT) the reporter has just
     *                    collected, with third-party costs already subtracted.
     *                    The reporter must have approved this contract for at
     *                    least `platformFee * shareBps / 10000`.
     */
    function report(address user, address ref, uint256 platformFee) external nonReentrant {
        if (!authorized[msg.sender]) revert NotAuthorized();
        if (ref == user) revert SelfReferral();

        if (referrerOf[user] == address(0) && ref != address(0)) {
            referrerOf[user] = ref;
            emit ReferrerSet(user, ref);
        }

        address r = referrerOf[user];
        if (r == address(0) || platformFee == 0) return;

        uint256 cut = (platformFee * shareBps) / 10_000;
        if (cut == 0) return;

        usdt.safeTransferFrom(msg.sender, address(this), cut);
        earned[r] += cut;

        emit Reported(user, r, platformFee, cut);
    }

    // ── Claim ───────────────────────────────────────────────

    /// @notice Pull-claim your accrued affiliate earnings.
    function claim() external nonReentrant {
        uint256 amt = earned[msg.sender];
        if (amt == 0) revert NothingToClaim();
        if (amt < minClaim) revert BelowMinClaim();

        earned[msg.sender] = 0;
        usdt.safeTransfer(msg.sender, amt);
        emit Claimed(msg.sender, amt);
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
