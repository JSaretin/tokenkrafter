// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title LaunchLens
 * @notice Constructor-only batch reader for launch detail pages.
 *         Returns ALL launch data in a single eth_call.
 *
 * Usage:
 *   const args = abiCoder.encode(['address'], [launchAddress]);
 *   const raw = await provider.call({ data: bytecode + args.slice(2), gasLimit: 15_000_000 });
 */

interface ILaunchInstance {
    function getLaunchInfo() external view returns (
        address token_, address creator_, uint8 curveType_, uint8 state_,
        uint256 softCap_, uint256 hardCap_, uint256 deadline_,
        uint256 totalBaseRaised_, uint256 tokensSold_,
        uint256 tokensForCurve_, uint256 tokensForLP_,
        uint256 creatorAllocationBps_, uint256 currentPrice_,
        address usdt_, uint256 startTimestamp_
    );
    function totalTokensRequired() external view returns (uint256);
    function totalTokensDeposited() external view returns (uint256);
    function effectiveState() external view returns (uint8);
    function totalBuyers() external view returns (uint256);
    function totalPurchases() external view returns (uint256);
    function maxBuyPerWallet() external view returns (uint256);
    function vestingCliff() external view returns (uint256);
    function vestingDuration() external view returns (uint256);
    function lockDurationAfterListing() external view returns (uint256);
    function minBuyUsdt() external view returns (uint256);
    function progressBps() external view returns (uint256 softCapBps, uint256 hardCapBps);
    function vestingInfo() external view returns (uint256 total, uint256 claimed, uint256 claimable, uint256 nextClaimTimestamp);
    function refundStartTimestamp() external view returns (uint256);
    function basePaid(address) external view returns (uint256);
    function tokensBought(address) external view returns (uint256);
}

interface IERC20 {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
}

contract LaunchLens {

    struct LaunchData {
        // Core info (from getLaunchInfo)
        address token;
        address creator;
        uint8 curveType;
        uint8 state;
        uint8 effectiveState;
        uint256 softCap;
        uint256 hardCap;
        uint256 deadline;
        uint256 totalBaseRaised;
        uint256 tokensSold;
        uint256 tokensForCurve;
        uint256 tokensForLP;
        uint256 creatorAllocationBps;
        uint256 currentPrice;
        address usdt;
        uint256 startTimestamp;
        // Extended
        uint256 totalTokensRequired;
        uint256 totalTokensDeposited;
        uint256 totalBuyers;
        uint256 totalPurchases;
        uint256 maxBuyPerWallet;
        uint256 vestingCliff;
        uint256 vestingDuration;
        uint256 lockDurationAfterListing;
        uint256 minBuyUsdt;
        uint256 softCapBps;
        uint256 hardCapBps;
        uint256 refundStartTimestamp;
        // Vesting info (for creator)
        uint256 vestingTotal;
        uint256 vestingClaimed;
        uint256 vestingClaimable;
        uint256 vestingNextClaim;
        // Token metadata
        string tokenName;
        string tokenSymbol;
        uint8 tokenDecimals;
        uint256 tokenTotalSupply;
    }

    struct UserPosition {
        uint256 basePaid;
        uint256 tokensBought;
        uint256 tokenBalance;
    }

    constructor(address launch, address user) {
        LaunchData memory ld;
        UserPosition memory up;

        // Core info
        try ILaunchInstance(launch).getLaunchInfo() returns (
            address token_, address creator_, uint8 curveType_, uint8 state_,
            uint256 softCap_, uint256 hardCap_, uint256 deadline_,
            uint256 totalBaseRaised_, uint256 tokensSold_,
            uint256 tokensForCurve_, uint256 tokensForLP_,
            uint256 creatorAllocationBps_, uint256 currentPrice_,
            address usdt_, uint256 startTimestamp_
        ) {
            ld.token = token_;
            ld.creator = creator_;
            ld.curveType = curveType_;
            ld.state = state_;
            ld.softCap = softCap_;
            ld.hardCap = hardCap_;
            ld.deadline = deadline_;
            ld.totalBaseRaised = totalBaseRaised_;
            ld.tokensSold = tokensSold_;
            ld.tokensForCurve = tokensForCurve_;
            ld.tokensForLP = tokensForLP_;
            ld.creatorAllocationBps = creatorAllocationBps_;
            ld.currentPrice = currentPrice_;
            ld.usdt = usdt_;
            ld.startTimestamp = startTimestamp_;

            // Token metadata
            try IERC20(token_).name() returns (string memory n) { ld.tokenName = n; } catch {}
            try IERC20(token_).symbol() returns (string memory s) { ld.tokenSymbol = s; } catch {}
            try IERC20(token_).decimals() returns (uint8 d) { ld.tokenDecimals = d; } catch { ld.tokenDecimals = 18; }
            try IERC20(token_).totalSupply() returns (uint256 s) { ld.tokenTotalSupply = s; } catch {}
        } catch {}

        // Extended fields
        try ILaunchInstance(launch).effectiveState() returns (uint8 s) { ld.effectiveState = s; } catch { ld.effectiveState = ld.state; }
        try ILaunchInstance(launch).totalTokensRequired() returns (uint256 v) { ld.totalTokensRequired = v; } catch {}
        try ILaunchInstance(launch).totalTokensDeposited() returns (uint256 v) { ld.totalTokensDeposited = v; } catch {}
        try ILaunchInstance(launch).totalBuyers() returns (uint256 v) { ld.totalBuyers = v; } catch {}
        try ILaunchInstance(launch).totalPurchases() returns (uint256 v) { ld.totalPurchases = v; } catch {}
        try ILaunchInstance(launch).maxBuyPerWallet() returns (uint256 v) { ld.maxBuyPerWallet = v; } catch {}
        try ILaunchInstance(launch).vestingCliff() returns (uint256 v) { ld.vestingCliff = v; } catch {}
        try ILaunchInstance(launch).vestingDuration() returns (uint256 v) { ld.vestingDuration = v; } catch {}
        try ILaunchInstance(launch).lockDurationAfterListing() returns (uint256 v) { ld.lockDurationAfterListing = v; } catch {}
        try ILaunchInstance(launch).minBuyUsdt() returns (uint256 v) { ld.minBuyUsdt = v; } catch {}
        try ILaunchInstance(launch).refundStartTimestamp() returns (uint256 v) { ld.refundStartTimestamp = v; } catch {}

        // Progress
        try ILaunchInstance(launch).progressBps() returns (uint256 sc, uint256 hc) {
            ld.softCapBps = sc;
            ld.hardCapBps = hc;
        } catch {}

        // Vesting
        try ILaunchInstance(launch).vestingInfo() returns (uint256 t, uint256 c, uint256 cl, uint256 nc) {
            ld.vestingTotal = t;
            ld.vestingClaimed = c;
            ld.vestingClaimable = cl;
            ld.vestingNextClaim = nc;
        } catch {}

        // User position
        if (user != address(0) && ld.token != address(0)) {
            try ILaunchInstance(launch).basePaid(user) returns (uint256 v) { up.basePaid = v; } catch {}
            try ILaunchInstance(launch).tokensBought(user) returns (uint256 v) { up.tokensBought = v; } catch {}
            try IERC20(ld.token).balanceOf(user) returns (uint256 v) { up.tokenBalance = v; } catch {}
        }

        bytes memory encoded = abi.encode(ld, up);
        assembly {
            return(add(encoded, 32), mload(encoded))
        }
    }
}
