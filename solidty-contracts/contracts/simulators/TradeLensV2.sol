// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title TradeLensV2
 * @notice Constructor-only — never deployed. All work in constructor, returns via assembly.
 *         Checks each token against ALL provided base tokens for liquidity.
 *         Supports multiple users for balance queries (e.g. all HD wallet accounts).
 *
 * Usage (ethers.js):
 *   const args = abiCoder.encode(
 *     ['address','address[]','address[]','address[]','address','uint256'],
 *     [router, tokens, baseTokens, users, simulateTax, simBuyAmount]
 *   );
 *   const raw = await provider.call({ data: bytecode + args.slice(2), value: simBuyAmount, gasLimit: 15_000_000 });
 */

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function totalSupply() external view returns (uint256);
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
    function name() external view returns (string memory);
}

interface IRouter {
    function WETH() external pure returns (address);
    function factory() external pure returns (address);
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory);
    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin, address[] calldata path, address to, uint256 deadline
    ) external payable;
    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline
    ) external;
}

interface IFactory {
    function getPair(address, address) external view returns (address);
}

interface IPair {
    function getReserves() external view returns (uint112, uint112, uint32);
    function token0() external view returns (address);
}

contract TradeLensV2 {

    struct PoolInfo {
        address base;
        address pairAddress;
        uint256 reserveToken;
        uint256 reserveBase;
        bool hasLiquidity;
    }

    struct TokenInfo {
        address token;
        string name;
        string symbol;
        uint8 decimals;
        uint256 totalSupply;
        bool hasLiquidity;
        PoolInfo[] pools;
        uint256[] balances;     // one per user (same order as users[] input)
    }

    struct UserInfo {
        address user;
        uint256 nativeBalance;
    }

    struct TaxInfo {
        bool success;
        bool canBuy;
        bool canSell;
        uint256 buyTaxBps;
        uint256 sellTaxBps;
        uint256 transferTaxBps;
        uint256 buyGas;
        uint256 sellGas;
        string buyError;
        string sellError;
    }

    constructor(
        address router,
        address[] memory tokens,
        address[] memory baseTokens,
        address[] memory users,         // multiple wallet addresses
        address simulateTax,
        uint256 simBuyAmount
    ) payable {
        IRouter dex = IRouter(router);
        address weth = dex.WETH();
        address factory;
        try dex.factory() returns (address f) { factory = f; } catch {}

        // Always include WETH in base tokens
        bool hasWeth = false;
        for (uint256 i = 0; i < baseTokens.length; i++) {
            if (baseTokens[i] == weth) { hasWeth = true; break; }
        }
        if (!hasWeth) {
            address[] memory newBases = new address[](baseTokens.length + 1);
            newBases[0] = weth;
            for (uint256 i = 0; i < baseTokens.length; i++) {
                newBases[i + 1] = baseTokens[i];
            }
            baseTokens = newBases;
        }

        // ── User native balances ──
        UserInfo[] memory userInfos = new UserInfo[](users.length);
        for (uint256 i = 0; i < users.length; i++) {
            userInfos[i].user = users[i];
            userInfos[i].nativeBalance = users[i].balance;
        }

        // ── Batch token info with multi-base pool check + multi-user balances ──
        TokenInfo[] memory tokenResults = new TokenInfo[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            tokenResults[i] = _getTokenInfo(tokens[i], baseTokens, factory, users);
        }

        // ── Tax simulation — find best route first, then simulate ──
        TaxInfo memory taxInfo;
        address taxToken = simulateTax;
        if (simulateTax != address(0) && simBuyAmount > 0) {
            // Find best buy path: WETH → [base] → token
            address[] memory bestBuyPath = _findBestBuyPath(factory, weth, simulateTax, simBuyAmount, baseTokens);
            if (bestBuyPath.length > 0) {
                taxInfo = _simulateTax(dex, simulateTax, bestBuyPath, simBuyAmount);
            } else {
                taxInfo.buyError = "No liquidity";
            }
        }

        // ── Encode and return ──
        bytes memory encoded = abi.encode(weth, factory, userInfos, tokenResults, taxInfo, taxToken);
        assembly {
            return(add(encoded, 32), mload(encoded))
        }
    }

    function _getTokenInfo(
        address token,
        address[] memory baseTokens,
        address factory,
        address[] memory users
    ) internal view returns (TokenInfo memory info) {
        info.token = token;
        try IERC20(token).name() returns (string memory n) { info.name = n; } catch {}
        try IERC20(token).symbol() returns (string memory s) { info.symbol = s; } catch {}
        try IERC20(token).decimals() returns (uint8 d) { info.decimals = d; } catch { info.decimals = 18; }
        try IERC20(token).totalSupply() returns (uint256 s) { info.totalSupply = s; } catch {}

        // Balances for each user
        info.balances = new uint256[](users.length);
        for (uint256 u = 0; u < users.length; u++) {
            try IERC20(token).balanceOf(users[u]) returns (uint256 bal) {
                info.balances[u] = bal;
            } catch {}
        }

        // Check each base pair
        info.pools = new PoolInfo[](baseTokens.length);
        for (uint256 i = 0; i < baseTokens.length; i++) {
            info.pools[i].base = baseTokens[i];

            if (token == baseTokens[i]) {
                info.pools[i].hasLiquidity = true;
                info.hasLiquidity = true;
                continue;
            }

            try IFactory(factory).getPair(token, baseTokens[i]) returns (address pair) {
                info.pools[i].pairAddress = pair;
                if (pair != address(0)) {
                    try IPair(pair).getReserves() returns (uint112 r0, uint112 r1, uint32) {
                        address token0 = IPair(pair).token0();
                        if (token0 == token) {
                            info.pools[i].reserveToken = r0;
                            info.pools[i].reserveBase = r1;
                        } else {
                            info.pools[i].reserveToken = r1;
                            info.pools[i].reserveBase = r0;
                        }
                        info.pools[i].hasLiquidity = info.pools[i].reserveToken > 0 && info.pools[i].reserveBase > 0;
                        if (info.pools[i].hasLiquidity) info.hasLiquidity = true;
                    } catch {}
                }
            } catch {}
        }
    }

    /// @dev Find the buy path that yields the most tokens.
    ///      Tries WETH→token direct, then WETH→base→token for each base.
    function _findBestBuyPath(
        address factory, address weth, address token, uint256 amountIn, address[] memory baseTokens
    ) internal view returns (address[] memory bestPath) {
        uint256 bestOut;

        // 1. Direct: WETH → token
        {
            uint256 out = _quoteTwo(factory, weth, token, amountIn);
            if (out > bestOut) {
                bestOut = out;
                bestPath = new address[](2);
                bestPath[0] = weth;
                bestPath[1] = token;
            }
        }

        // 2. Two-hop: WETH → base → token
        for (uint256 i = 0; i < baseTokens.length; i++) {
            address base = baseTokens[i];
            if (base == weth || base == token) continue;
            uint256 mid = _quoteTwo(factory, weth, base, amountIn);
            if (mid == 0) continue;
            uint256 out = _quoteTwo(factory, base, token, mid);
            if (out > bestOut) {
                bestOut = out;
                bestPath = new address[](3);
                bestPath[0] = weth;
                bestPath[1] = base;
                bestPath[2] = token;
            }
        }
    }

    /// @dev Quote output for a single-hop swap using reserves (0.25% fee).
    function _quoteTwo(address factory, address tokenA, address tokenB, uint256 amountIn)
        internal view returns (uint256)
    {
        try IFactory(factory).getPair(tokenA, tokenB) returns (address pair) {
            if (pair == address(0)) return 0;
            try IPair(pair).getReserves() returns (uint112 r0, uint112 r1, uint32) {
                address t0 = IPair(pair).token0();
                (uint256 rIn, uint256 rOut) = t0 == tokenA ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
                if (rIn == 0 || rOut == 0) return 0;
                uint256 inFee = amountIn * 9975;
                return (inFee * rOut) / (rIn * 10000 + inFee);
            } catch { return 0; }
        } catch { return 0; }
    }

    /// @dev Simulate buy + transfer + sell tax using a pre-computed buy path.
    ///      buyPath starts with WETH so swapExactETHForTokens works.
    function _simulateTax(
        IRouter dex, address token, address[] memory buyPath, uint256 buyAmount
    ) internal returns (TaxInfo memory t) {
        // ── Buy ──
        uint256 expectedBuy;
        try dex.getAmountsOut(buyAmount, buyPath) returns (uint256[] memory amounts) {
            expectedBuy = amounts[amounts.length - 1];
        } catch { t.buyError = "Quote failed"; return t; }

        uint256 gasBefore = gasleft();
        uint256 balBefore = IERC20(token).balanceOf(address(this));

        try dex.swapExactETHForTokensSupportingFeeOnTransferTokens{value: buyAmount}(
            0, buyPath, address(this), block.timestamp
        ) {
            uint256 actualBuy = IERC20(token).balanceOf(address(this)) - balBefore;
            t.buyGas = gasBefore - gasleft();
            t.canBuy = true;
            if (expectedBuy > 0 && actualBuy < expectedBuy) {
                t.buyTaxBps = ((expectedBuy - actualBuy) * 10000) / expectedBuy;
            }
        } catch Error(string memory reason) {
            t.buyError = reason; t.buyGas = gasBefore - gasleft(); return t;
        } catch {
            t.buyError = "Buy reverted"; t.buyGas = gasBefore - gasleft(); return t;
        }

        // ── Transfer tax ──
        {
            uint256 testAmount = IERC20(token).balanceOf(address(this)) / 10;
            if (testAmount > 0) {
                uint256 deadBefore = IERC20(token).balanceOf(address(0xdead));
                try IERC20(token).transfer(address(0xdead), testAmount) {
                    uint256 deadAfter = IERC20(token).balanceOf(address(0xdead));
                    uint256 received = deadAfter - deadBefore;
                    if (received < testAmount) {
                        t.transferTaxBps = ((testAmount - received) * 10000) / testAmount;
                    }
                } catch {}
            }
        }

        // ── Sell — reverse the buy path ──
        uint256 tokensToSell = IERC20(token).balanceOf(address(this));
        if (tokensToSell == 0) { t.sellError = "No tokens"; return t; }

        try IERC20(token).approve(address(dex), tokensToSell) {} catch {
            t.sellError = "Approve failed"; return t;
        }

        address[] memory sellPath = new address[](buyPath.length);
        for (uint256 i = 0; i < buyPath.length; i++) {
            sellPath[i] = buyPath[buyPath.length - 1 - i];
        }

        uint256 expectedSell;
        try dex.getAmountsOut(tokensToSell, sellPath) returns (uint256[] memory amounts) {
            expectedSell = amounts[amounts.length - 1];
        } catch {}

        uint256 ethBefore = address(this).balance;
        gasBefore = gasleft();

        try dex.swapExactTokensForETHSupportingFeeOnTransferTokens(
            tokensToSell, 0, sellPath, address(this), block.timestamp
        ) {
            uint256 actualSell = address(this).balance - ethBefore;
            t.sellGas = gasBefore - gasleft();
            t.canSell = true;
            if (expectedSell > 0 && actualSell < expectedSell) {
                t.sellTaxBps = ((expectedSell - actualSell) * 10000) / expectedSell;
            }
        } catch Error(string memory reason) {
            t.sellError = reason; t.sellGas = gasBefore - gasleft();
        } catch {
            t.sellError = "Sell reverted"; t.sellGas = gasBefore - gasleft();
        }

        t.success = t.canBuy && t.canSell;
    }

    receive() external payable {}
}
