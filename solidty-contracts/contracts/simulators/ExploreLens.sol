// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ExploreLens
 * @notice Constructor-only batch reader for the explore page.
 *         Returns all data needed to render token cards without external APIs.
 *         One eth_call per page of tokens.
 *
 * Usage (ethers.js):
 *   const args = abiCoder.encode(
 *     ['address','address','address','address','address[]'],
 *     [factory, dexFactory, weth, usdt, tokenAddresses]
 *   );
 *   const raw = await provider.call({ data: bytecode + args.slice(2), gasLimit: 30_000_000 });
 *   const decoded = abiCoder.decode(RESULT_TYPES, raw);
 */

interface ITokenFactory {
    function tokenInfo(address token) external view returns (
        address creator, bool isMintable, bool isTaxable, bool isPartnership
    );
}

interface IERC20 {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
}

interface IOwnable {
    function owner() external view returns (address);
}

interface IDexFactory {
    function getPair(address tokenA, address tokenB) external view returns (address);
}

interface IPair {
    function token0() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
}

// Optional interfaces — try/catch for backwards compat with old tokens
interface ITokenExtended {
    function holderCount() external view returns (uint256);
    function totalVolume() external view returns (uint256);
    function tradingStartTime() external view returns (uint256);
    function buyTaxBps() external view returns (uint256);
    function sellTaxBps() external view returns (uint256);
    function transferTaxBps() external view returns (uint256);
    function taxCeilingBuy() external view returns (uint256);
    function taxCeilingSell() external view returns (uint256);
    function taxCeilingTransfer() external view returns (uint256);
    function maxWalletAmount() external view returns (uint256);
    function maxTransactionAmount() external view returns (uint256);
}

contract ExploreLens {

    struct TokenData {
        address token;
        string name;
        string symbol;
        uint8 decimals;
        uint256 totalSupply;
        address creator;
        address owner;
        bool ownerIsZero;
        bool isMintable;
        bool isTaxable;
        bool isPartner;
        // Market data (from DEX reserves)
        uint256 priceNumerator;     // price = priceNumerator / priceDenominator (in USDT units)
        uint256 priceDenominator;
        uint256 marketCap;          // totalSupply * price (in USDT units)
        bool hasLiquidity;
        uint256 reserveToken;
        uint256 reserveBase;
        address pairAddress;
        // New counters (0 for old tokens)
        uint256 holderCount;
        uint256 totalVolume;
        // Protection status
        bool tradingEnabled;
        uint256 buyTaxBps;
        uint256 sellTaxBps;
        uint256 transferTaxBps;
        uint256 taxCeilingBuy;
        uint256 taxCeilingSell;
        uint256 maxWalletAmount;
        uint256 maxTransactionAmount;
    }

    constructor(
        address factory,
        address dexFactory,
        address weth,
        address usdt,
        address[] memory tokens
    ) {
        uint256 len = tokens.length;
        TokenData[] memory results = new TokenData[](len);

        // Get USDT/WETH price for market cap conversion
        uint256 wethPriceNum;   // WETH price in USDT (numerator)
        uint256 wethPriceDen;   // denominator
        {
            address wethUsdtPair;
            try IDexFactory(dexFactory).getPair(weth, usdt) returns (address p) {
                wethUsdtPair = p;
            } catch {}

            if (wethUsdtPair != address(0)) {
                try IPair(wethUsdtPair).getReserves() returns (uint112 r0, uint112 r1, uint32) {
                    address t0;
                    try IPair(wethUsdtPair).token0() returns (address _t0) { t0 = _t0; } catch {}
                    if (t0 == weth) {
                        wethPriceNum = r1; // USDT reserve
                        wethPriceDen = r0; // WETH reserve
                    } else {
                        wethPriceNum = r0;
                        wethPriceDen = r1;
                    }
                } catch {}
            }
        }

        for (uint256 i = 0; i < len; i++) {
            results[i] = _getTokenData(
                factory, dexFactory, weth, usdt,
                tokens[i], wethPriceNum, wethPriceDen
            );
        }

        bytes memory encoded = abi.encode(results);
        assembly {
            return(add(encoded, 32), mload(encoded))
        }
    }

    function _getTokenData(
        address factory,
        address dexFactory,
        address weth,
        address usdt,
        address token,
        uint256 wethPriceNum,
        uint256 wethPriceDen
    ) internal view returns (TokenData memory td) {
        td.token = token;

        // Basic ERC20 metadata
        try IERC20(token).name() returns (string memory n) { td.name = n; } catch {}
        try IERC20(token).symbol() returns (string memory s) { td.symbol = s; } catch {}
        try IERC20(token).decimals() returns (uint8 d) { td.decimals = d; } catch { td.decimals = 18; }
        try IERC20(token).totalSupply() returns (uint256 s) { td.totalSupply = s; } catch {}

        // Ownership
        try IOwnable(token).owner() returns (address o) {
            td.owner = o;
            td.ownerIsZero = (o == address(0));
        } catch {}

        // Factory metadata
        try ITokenFactory(factory).tokenInfo(token) returns (address c, bool m, bool t, bool p) {
            td.creator = c;
            td.isMintable = m;
            td.isTaxable = t;
            td.isPartner = p;
        } catch {}

        // New counters (backwards compat — returns 0 for old tokens)
        try ITokenExtended(token).holderCount() returns (uint256 h) { td.holderCount = h; } catch {}
        try ITokenExtended(token).totalVolume() returns (uint256 v) { td.totalVolume = v; } catch {}

        // Protection status
        try ITokenExtended(token).tradingStartTime() returns (uint256 t) {
            td.tradingEnabled = (t != type(uint256).max && t <= block.timestamp);
        } catch {}
        try ITokenExtended(token).buyTaxBps() returns (uint256 b) { td.buyTaxBps = b; } catch {}
        try ITokenExtended(token).sellTaxBps() returns (uint256 s) { td.sellTaxBps = s; } catch {}
        try ITokenExtended(token).transferTaxBps() returns (uint256 t) { td.transferTaxBps = t; } catch {}
        try ITokenExtended(token).taxCeilingBuy() returns (uint256 c) { td.taxCeilingBuy = c; } catch {}
        try ITokenExtended(token).taxCeilingSell() returns (uint256 c) { td.taxCeilingSell = c; } catch {}
        try ITokenExtended(token).maxWalletAmount() returns (uint256 m) { td.maxWalletAmount = m; } catch {}
        try ITokenExtended(token).maxTransactionAmount() returns (uint256 m) { td.maxTransactionAmount = m; } catch {}

        // ── Price from DEX reserves ──
        // Try USDT pair first, fall back to WETH pair
        _tryPricePair(td, dexFactory, token, usdt, true, 0, 0);
        if (!td.hasLiquidity) {
            _tryPricePair(td, dexFactory, token, weth, false, wethPriceNum, wethPriceDen);
        }

        // Market cap = totalSupply * price
        if (td.hasLiquidity && td.priceDenominator > 0) {
            td.marketCap = (td.totalSupply * td.priceNumerator) / td.priceDenominator;
        }
    }

    function _tryPricePair(
        TokenData memory td,
        address dexFactory,
        address token,
        address base,
        bool baseIsUsdt,
        uint256 wethPriceNum,
        uint256 wethPriceDen
    ) internal view {
        address pair;
        try IDexFactory(dexFactory).getPair(token, base) returns (address p) {
            pair = p;
        } catch { return; }
        if (pair == address(0)) return;

        try IPair(pair).getReserves() returns (uint112 r0, uint112 r1, uint32) {
            if (r0 == 0 || r1 == 0) return;

            address t0;
            try IPair(pair).token0() returns (address _t0) { t0 = _t0; } catch { return; }

            uint256 reserveToken;
            uint256 reserveBase;
            if (t0 == token) {
                reserveToken = r0;
                reserveBase = r1;
            } else {
                reserveToken = r1;
                reserveBase = r0;
            }

            // Min liquidity check ($100 equivalent)
            if (reserveBase < 1e16) return;

            td.hasLiquidity = true;
            td.reserveToken = reserveToken;
            td.reserveBase = reserveBase;
            td.pairAddress = pair;

            if (baseIsUsdt) {
                // Price = reserveBase / reserveToken (already in USDT)
                td.priceNumerator = reserveBase;
                td.priceDenominator = reserveToken;
            } else if (wethPriceDen > 0) {
                // Price = (reserveBase / reserveToken) * (wethPriceNum / wethPriceDen)
                td.priceNumerator = reserveBase * wethPriceNum;
                td.priceDenominator = reserveToken * wethPriceDen;
            }
        } catch {}
    }
}
