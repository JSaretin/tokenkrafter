// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title AdminLens
 * @notice Constructor-only batch reader for the admin dashboard.
 *         Returns all platform stats, recent tokens, and recent launches
 *         in a single eth_call — no deployment, no state changes.
 *
 * Usage (ethers.js):
 *   const args = abiCoder.encode(
 *     ['address','address','uint256','uint256'],
 *     [tokenFactory, launchpadFactory, recentTokenCount, recentLaunchCount]
 *   );
 *   const raw = await provider.call({ data: bytecode + args.slice(2), gasLimit: 30_000_000 });
 *   const decoded = abiCoder.decode(RESULT_TYPES, raw);
 */

interface ITokenFactory {
    function getState() external view returns (
        address factoryOwner, uint256 totalTokens, uint256 totalFeeUsdt,
        uint256[8] memory feesPerType, uint256[8] memory countPerType,
        bool taxToStable, uint256 taxSlippage, uint8 refLevels, bool autoDistribute
    );
    function dexRouter() external view returns (address);
    function usdt() external view returns (address);
    function authorizedRouter() external view returns (address);
    function platformWallet() external view returns (address);
    function totalTokensCreated() external view returns (uint256);
    function getTokenByIndex(uint256 index) external view returns (address);
    function tokenInfo(address token) external view returns (
        address creator, bool isMintable, bool isTaxable, bool isPartnership
    );
}

interface ILaunchpadFactory {
    function getState() external view returns (
        address factoryOwner, uint256 totalLaunchCount, uint256 totalFeeUsdt, uint256 fee
    );
    function totalLaunches() external view returns (uint256);
    function launches(uint256 index) external view returns (address);
    function platformWallet() external view returns (address);
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
    function totalPurchases() external view returns (uint256);
    function totalBuyers() external view returns (uint256);
}

interface IERC20Meta {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
    function totalSupply() external view returns (uint256);
}

interface IOwnable {
    function owner() external view returns (address);
}

contract AdminLens {

    struct FactoryState {
        address owner;
        uint256 totalTokens;
        uint256 totalFeeUsdt;
        uint256[8] feesPerType;
        uint256[8] countPerType;
        bool taxToStable;
        uint256 taxSlippage;
        uint8 refLevels;
        bool autoDistribute;
        address dexRouter;
        address usdt;
        uint8 usdtDecimals;
        address authorizedRouter;
        address platformWallet;
    }

    struct LaunchpadState {
        address owner;
        uint256 totalLaunches;
        uint256 totalFeeUsdt;
        uint256 launchFee;
        address platformWallet;
    }

    struct TokenInfo {
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

    struct LaunchInfo {
        address launch;
        address token;
        string tokenName;
        string tokenSymbol;
        uint8 tokenDecimals;
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
        uint256 tokensForLP;
        uint256 currentPrice;
        uint256 totalPurchases;
        uint256 totalBuyers;
    }

    constructor(
        address tokenFactory,
        address launchpadFactory,
        uint256 recentTokenCount,
        uint256 recentLaunchCount
    ) {
        FactoryState memory fs;
        LaunchpadState memory ls;

        // ── Factory state ──
        if (tokenFactory != address(0)) {
            try ITokenFactory(tokenFactory).getState() returns (
                address o, uint256 tt, uint256 tf,
                uint256[8] memory fpt, uint256[8] memory cpt,
                bool tts, uint256 ts, uint8 rl, bool ad
            ) {
                fs.owner = o;
                fs.totalTokens = tt;
                fs.totalFeeUsdt = tf;
                fs.feesPerType = fpt;
                fs.countPerType = cpt;
                fs.taxToStable = tts;
                fs.taxSlippage = ts;
                fs.refLevels = rl;
                fs.autoDistribute = ad;
            } catch {}

            try ITokenFactory(tokenFactory).dexRouter() returns (address r) { fs.dexRouter = r; } catch {}
            try ITokenFactory(tokenFactory).usdt() returns (address u) {
                fs.usdt = u;
                try IERC20Meta(u).decimals() returns (uint8 d) { fs.usdtDecimals = d; } catch { fs.usdtDecimals = 18; }
            } catch {}
            try ITokenFactory(tokenFactory).authorizedRouter() returns (address r) { fs.authorizedRouter = r; } catch {}
            try ITokenFactory(tokenFactory).platformWallet() returns (address w) { fs.platformWallet = w; } catch {}
        }

        // ── Launchpad state ──
        if (launchpadFactory != address(0)) {
            try ILaunchpadFactory(launchpadFactory).getState() returns (
                address o, uint256 tl, uint256 tf, uint256 lf
            ) {
                ls.owner = o;
                ls.totalLaunches = tl;
                ls.totalFeeUsdt = tf;
                ls.launchFee = lf;
            } catch {}
            try ILaunchpadFactory(launchpadFactory).platformWallet() returns (address w) { ls.platformWallet = w; } catch {}
        }

        // ── Recent tokens (newest first) ──
        TokenInfo[] memory tokens;
        if (tokenFactory != address(0) && recentTokenCount > 0) {
            uint256 total = fs.totalTokens;
            uint256 count = recentTokenCount > total ? total : recentTokenCount;
            tokens = new TokenInfo[](count);
            for (uint256 i = 0; i < count; i++) {
                uint256 idx = total - 1 - i;
                try ITokenFactory(tokenFactory).getTokenByIndex(idx) returns (address addr) {
                    tokens[i] = _getTokenInfo(tokenFactory, addr);
                } catch {}
            }
        } else {
            tokens = new TokenInfo[](0);
        }

        // ── Recent launches (newest first) ──
        LaunchInfo[] memory launches;
        if (launchpadFactory != address(0) && recentLaunchCount > 0) {
            uint256 total = ls.totalLaunches;
            uint256 count = recentLaunchCount > total ? total : recentLaunchCount;
            launches = new LaunchInfo[](count);
            for (uint256 i = 0; i < count; i++) {
                uint256 idx = total - 1 - i;
                try ILaunchpadFactory(launchpadFactory).launches(idx) returns (address addr) {
                    launches[i] = _getLaunchInfo(addr);
                } catch {}
            }
        } else {
            launches = new LaunchInfo[](0);
        }

        // ── Encode and return ──
        bytes memory encoded = abi.encode(fs, ls, tokens, launches);
        assembly {
            return(add(encoded, 32), mload(encoded))
        }
    }

    function _getTokenInfo(address factory, address token) internal view returns (TokenInfo memory ti) {
        ti.token = token;
        try IERC20Meta(token).name() returns (string memory n) { ti.name = n; } catch {}
        try IERC20Meta(token).symbol() returns (string memory s) { ti.symbol = s; } catch {}
        try IERC20Meta(token).decimals() returns (uint8 d) { ti.decimals = d; } catch { ti.decimals = 18; }
        try IERC20Meta(token).totalSupply() returns (uint256 s) { ti.totalSupply = s; } catch {}
        try IOwnable(token).owner() returns (address o) { ti.owner = o; } catch {}
        try ITokenFactory(factory).tokenInfo(token) returns (address c, bool m, bool t, bool p) {
            ti.creator = c;
            ti.isMintable = m;
            ti.isTaxable = t;
            ti.isPartner = p;
        } catch {}
    }

    function _getLaunchInfo(address launch) internal view returns (LaunchInfo memory li) {
        li.launch = launch;
        try ILaunchInstance(launch).getLaunchInfo() returns (
            address token_, address creator_, uint8 curveType_, uint8 state_,
            uint256 softCap_, uint256 hardCap_, uint256 deadline_,
            uint256 totalBaseRaised_, uint256 tokensSold_,
            uint256 tokensForCurve_, uint256 tokensForLP_,
            uint256, uint256 currentPrice_,
            address, uint256 startTimestamp_
        ) {
            li.token = token_;
            li.creator = creator_;
            li.curveType = curveType_;
            li.state = state_;
            li.softCap = softCap_;
            li.hardCap = hardCap_;
            li.deadline = deadline_;
            li.startTimestamp = startTimestamp_;
            li.totalBaseRaised = totalBaseRaised_;
            li.tokensSold = tokensSold_;
            li.tokensForCurve = tokensForCurve_;
            li.tokensForLP = tokensForLP_;
            li.currentPrice = currentPrice_;

            try IERC20Meta(token_).name() returns (string memory n) { li.tokenName = n; } catch {}
            try IERC20Meta(token_).symbol() returns (string memory s) { li.tokenSymbol = s; } catch {}
            try IERC20Meta(token_).decimals() returns (uint8 d) { li.tokenDecimals = d; } catch { li.tokenDecimals = 18; }
        } catch {}
        try ILaunchInstance(launch).totalPurchases() returns (uint256 p) { li.totalPurchases = p; } catch {}
        try ILaunchInstance(launch).totalBuyers() returns (uint256 b) { li.totalBuyers = b; } catch {}
    }
}
