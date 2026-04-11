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

        // ── Tax simulation (uses WETH pair) ──
        TaxInfo memory taxInfo;
        address taxToken = simulateTax;
        if (simulateTax != address(0) && simBuyAmount > 0) {
            taxInfo = _simulateTax(dex, simulateTax, weth, factory, simBuyAmount);
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

    function _simulateTax(
        IRouter dex, address token, address weth, address factory, uint256 buyAmount
    ) internal returns (TaxInfo memory t) {
        address pair;
        try IFactory(factory).getPair(token, weth) returns (address p) { pair = p; } catch {}
        if (pair == address(0)) { t.buyError = "No liquidity"; return t; }

        address[] memory path = new address[](2);
        path[0] = weth;
        path[1] = token;

        uint256 expectedBuy;
        try dex.getAmountsOut(buyAmount, path) returns (uint256[] memory amounts) {
            expectedBuy = amounts[1];
        } catch { t.buyError = "Quote failed"; return t; }

        uint256 gasBefore = gasleft();
        uint256 balBefore = IERC20(token).balanceOf(address(this));

        try dex.swapExactETHForTokensSupportingFeeOnTransferTokens{value: buyAmount}(
            0, path, address(this), block.timestamp
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

        uint256 tokensToSell = IERC20(token).balanceOf(address(this));
        if (tokensToSell == 0) { t.sellError = "No tokens"; return t; }

        try IERC20(token).approve(address(dex), tokensToSell) {} catch {
            t.sellError = "Approve failed"; return t;
        }

        path[0] = token;
        path[1] = weth;

        uint256 expectedSell;
        try dex.getAmountsOut(tokensToSell, path) returns (uint256[] memory amounts) {
            expectedSell = amounts[1];
        } catch {}

        uint256 ethBefore = address(this).balance;
        gasBefore = gasleft();

        try dex.swapExactTokensForETHSupportingFeeOnTransferTokens(
            tokensToSell, 0, path, address(this), block.timestamp
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
