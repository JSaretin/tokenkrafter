// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title PlatformLensV2
 * @notice Constructor-only batch reader — never deployed. Returns data via assembly.
 *         Reads from TokenFactory, LaunchpadFactory, and LaunchInstance contracts.
 *
 * Usage (ethers.js):
 *   const args = abiCoder.encode(
 *     ['address','address','uint8','address','uint256','uint256'],
 *     [tokenFactory, launchpadFactory, queryType, param, offset, limit]
 *   );
 *   const raw = await provider.call({ data: bytecode + args.slice(2), gasLimit: 30_000_000 });
 *
 * Query types:
 *   0 = getTokensByCreator(creator, offset, limit)
 *   1 = getActiveLaunches(offset, limit)
 *   2 = batchLaunchInfo(launches[])  — pass launches as param (encoded in param field)
 *   3 = getTokenInfo(tokenAddress)
 *   4 = platformStats()
 */

interface ITokenFactory {
    function getCreatedTokens(address creator) external view returns (address[] memory);
    function tokenInfo(address token) external view returns (address creator, bool isMintable, bool isTaxable, bool isPartnership);
    function totalTokensCreated() external view returns (uint256);
    function getTokenByIndex(uint256 index) external view returns (address);
    function getState() external view returns (
        address factoryOwner, uint256 totalTokens, uint256 totalFeeUsdt,
        uint256[8] memory feesPerType, uint256[8] memory countPerType,
        address[] memory paymentTokens, bool taxToStable, uint256 taxSlippage,
        uint8 refLevels, bool autoDistribute
    );
}

interface ILaunchpadFactory {
    function totalLaunches() external view returns (uint256);
    function launches(uint256 index) external view returns (address);
    function getState() external view returns (
        address factoryOwner, uint256 totalLaunchCount, uint256 totalFeeUsdt, uint256 fee
    );
}

interface ILaunchInstance {
    function getLaunchInfo() external view returns (
        address token_, address creator_, uint8 curveType_, uint8 state_,
        uint256 softCap_, uint256 hardCap_, uint256 deadline_,
        uint256 totalBaseRaised_, uint256 tokensSold_,
        uint256 tokensForCurve_, uint256 tokensForLP_,
        uint256 creatorAllocationBps_, uint256 currentPrice_,
        address usdt_, uint256 startTimestamp_
    );
    function stateHash() external view returns (bytes32);
    function totalPurchases() external view returns (uint256);
    function totalBuyers() external view returns (uint256);
}

interface IERC20Meta {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
}

interface IOwnable {
    function owner() external view returns (address);
}

contract PlatformLensV2 {

    // ── Token info (for batch reads) ──
    struct TokenData {
        address token;
        string name;
        string symbol;
        uint8 decimals;
        uint256 totalSupply;
        address creator;
        address owner;
        bool isMintable;
        bool isTaxable;
        bool isPartner;
    }

    // ── Launch info (for batch reads) ──
    struct LaunchData {
        address launch;
        address token;
        address creator;
        uint8 curveType;
        uint8 state;
        uint256 softCap;
        uint256 hardCap;
        uint256 deadline;
        uint256 startTimestamp;
        uint256 totalBaseRaised;
        uint256 tokensSold;
        uint256 tokensForCurve;
        uint256 currentPrice;
        uint256 totalPurchases;
        uint256 totalBuyers;
        bytes32 stateHash;
        // Token metadata
        string tokenName;
        string tokenSymbol;
        uint8 tokenDecimals;
    }

    // ── Platform stats ──
    struct PlatformStats {
        uint256 totalTokens;
        uint256 totalTokenFeeUsdt;
        uint256[8] feesPerType;
        uint256[8] countPerType;
        uint256 totalLaunches;
        uint256 totalLaunchFeeUsdt;
        uint256 launchFee;
    }

    constructor(
        address tokenFactory,
        address launchpadFactory,
        uint8 queryType,
        address param,       // creator address for type 0, token address for type 3
        uint256 offset,
        uint256 limit
    ) {
        if (queryType == 0) {
            // ── getTokensByCreator ──
            _queryTokensByCreator(tokenFactory, param, offset, limit);
        } else if (queryType == 1) {
            // ── getActiveLaunches ──
            _queryActiveLaunches(launchpadFactory, offset, limit);
        } else if (queryType == 3) {
            // ── getTokenInfo (single token) ──
            _queryTokenInfo(tokenFactory, param);
        } else if (queryType == 4) {
            // ── platformStats ──
            _queryPlatformStats(tokenFactory, launchpadFactory);
        }
    }

    function _queryTokensByCreator(address factory, address creator, uint256 offset, uint256 limit) internal {
        address[] memory tokens;
        try ITokenFactory(factory).getCreatedTokens(creator) returns (address[] memory t) {
            tokens = t;
        } catch {
            bytes memory encoded = abi.encode(new TokenData[](0), uint256(0));
            assembly { return(add(encoded, 32), mload(encoded)) }
        }

        uint256 total = tokens.length;
        if (offset >= total) {
            bytes memory encoded = abi.encode(new TokenData[](0), total);
            assembly { return(add(encoded, 32), mload(encoded)) }
        }

        uint256 end = offset + limit;
        if (end > total) end = total;
        uint256 count = end - offset;

        TokenData[] memory results = new TokenData[](count);
        for (uint256 i = 0; i < count; i++) {
            results[i] = _getTokenData(factory, tokens[offset + i]);
        }

        bytes memory encoded = abi.encode(results, total);
        assembly { return(add(encoded, 32), mload(encoded)) }
    }

    function _queryActiveLaunches(address launchFactory, uint256 offset, uint256 limit) internal {
        uint256 total;
        try ILaunchpadFactory(launchFactory).totalLaunches() returns (uint256 t) {
            total = t;
        } catch {
            bytes memory encoded = abi.encode(new LaunchData[](0), uint256(0));
            assembly { return(add(encoded, 32), mload(encoded)) }
        }

        // Collect active/pending launches (iterate backwards for newest first)
        LaunchData[] memory temp = new LaunchData[](total);
        uint256 activeCount = 0;

        for (uint256 i = total; i > 0; i--) {
            try ILaunchpadFactory(launchFactory).launches(i - 1) returns (address addr) {
                LaunchData memory ld = _getLaunchData(addr);
                // Only include pending (0) and active (1)
                if (ld.state <= 1) {
                    temp[activeCount++] = ld;
                }
            } catch {}
            // Stop early if we have enough
            if (activeCount >= offset + limit) break;
        }

        // Apply pagination
        if (offset >= activeCount) {
            bytes memory encoded = abi.encode(new LaunchData[](0), activeCount);
            assembly { return(add(encoded, 32), mload(encoded)) }
        }
        uint256 end = offset + limit;
        if (end > activeCount) end = activeCount;
        uint256 count = end - offset;

        LaunchData[] memory results = new LaunchData[](count);
        for (uint256 i = 0; i < count; i++) {
            results[i] = temp[offset + i];
        }

        bytes memory encoded = abi.encode(results, activeCount);
        assembly { return(add(encoded, 32), mload(encoded)) }
    }

    function _queryTokenInfo(address factory, address token) internal {
        TokenData memory td = _getTokenData(factory, token);
        bytes memory encoded = abi.encode(td);
        assembly { return(add(encoded, 32), mload(encoded)) }
    }

    function _queryPlatformStats(address tokenFactory, address launchFactory) internal {
        PlatformStats memory stats;

        try ITokenFactory(tokenFactory).getState() returns (
            address, uint256 totalTokens, uint256 totalFee,
            uint256[8] memory fees, uint256[8] memory counts,
            address[] memory, bool, uint256, uint8, bool
        ) {
            stats.totalTokens = totalTokens;
            stats.totalTokenFeeUsdt = totalFee;
            stats.feesPerType = fees;
            stats.countPerType = counts;
        } catch {}

        try ILaunchpadFactory(launchFactory).getState() returns (
            address, uint256 totalLaunches, uint256 totalFee, uint256 fee
        ) {
            stats.totalLaunches = totalLaunches;
            stats.totalLaunchFeeUsdt = totalFee;
            stats.launchFee = fee;
        } catch {}

        bytes memory encoded = abi.encode(stats);
        assembly { return(add(encoded, 32), mload(encoded)) }
    }

    // ── Helpers ──

    function _getTokenData(address factory, address token) internal view returns (TokenData memory td) {
        td.token = token;
        try IERC20Meta(token).name() returns (string memory n) { td.name = n; } catch {}
        try IERC20Meta(token).symbol() returns (string memory s) { td.symbol = s; } catch {}
        try IERC20Meta(token).decimals() returns (uint8 d) { td.decimals = d; } catch { td.decimals = 18; }
        try IERC20Meta(token).totalSupply() returns (uint256 s) { td.totalSupply = s; } catch {}
        try IOwnable(token).owner() returns (address o) { td.owner = o; } catch {}
        try ITokenFactory(factory).tokenInfo(token) returns (address c, bool m, bool t, bool p) {
            td.creator = c;
            td.isMintable = m;
            td.isTaxable = t;
            td.isPartner = p;
        } catch {}
    }

    function _getLaunchData(address launch) internal view returns (LaunchData memory ld) {
        ld.launch = launch;
        try ILaunchInstance(launch).getLaunchInfo() returns (
            address token_, address creator_, uint8 curveType_, uint8 state_,
            uint256 softCap_, uint256 hardCap_, uint256 deadline_,
            uint256 totalBaseRaised_, uint256 tokensSold_,
            uint256 tokensForCurve_, uint256,
            uint256, uint256 currentPrice_,
            address, uint256 startTimestamp_
        ) {
            ld.token = token_;
            ld.creator = creator_;
            ld.curveType = curveType_;
            ld.state = state_;
            ld.softCap = softCap_;
            ld.hardCap = hardCap_;
            ld.deadline = deadline_;
            ld.startTimestamp = startTimestamp_;
            ld.totalBaseRaised = totalBaseRaised_;
            ld.tokensSold = tokensSold_;
            ld.tokensForCurve = tokensForCurve_;
            ld.currentPrice = currentPrice_;

            // Token metadata
            try IERC20Meta(token_).name() returns (string memory n) { ld.tokenName = n; } catch {}
            try IERC20Meta(token_).symbol() returns (string memory s) { ld.tokenSymbol = s; } catch {}
            try IERC20Meta(token_).decimals() returns (uint8 d) { ld.tokenDecimals = d; } catch { ld.tokenDecimals = 18; }
        } catch {}

        // These may not exist on old implementations — try/catch
        try ILaunchInstance(launch).stateHash() returns (bytes32 h) { ld.stateHash = h; } catch {}
        try ILaunchInstance(launch).totalPurchases() returns (uint256 p) { ld.totalPurchases = p; } catch {}
        try ILaunchInstance(launch).totalBuyers() returns (uint256 b) { ld.totalBuyers = b; } catch {}
    }
}
