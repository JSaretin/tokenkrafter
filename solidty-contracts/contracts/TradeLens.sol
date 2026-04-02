// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

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
    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external view returns (uint256[] memory amounts);
    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin, address[] calldata path, address to, uint256 deadline
    ) external payable;
    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline
    ) external;
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
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

/**
 * @title TradeLens
 * @notice All-in-one: batch prices + tax simulation in a single eth_call.
 *         Use via state override — no deployment needed.
 */
contract TradeLens {

    struct TokenInfo {
        address token;
        string symbol;
        string name;
        uint8 decimals;
        uint256 reserveToken;
        uint256 reserveBase;
        address pairAddress;
        bool hasLiquidity;
        uint256 balance;        // user balance (0 if user is address(0))
    }

    struct TaxInfo {
        bool success;
        bool canBuy;
        bool canSell;
        uint256 buyTaxBps;
        uint256 sellTaxBps;
        uint256 buyGas;
        uint256 sellGas;
        string buyError;
        string sellError;
    }

    struct FullResult {
        address weth;
        address factory;
        uint256 nativeBalance;  // user's native coin balance (0 if user is address(0))
        TokenInfo[] tokens;
        TaxInfo taxInfo;
        address taxToken;
    }

    /**
     * @notice Batch fetch token info + balances + optionally simulate tax.
     * @param router DEX router (e.g. PancakeSwap)
     * @param tokens Array of token addresses to get info for
     * @param user User address for balances (address(0) to skip balances)
     * @param simulateTax Address of token to simulate buy/sell tax (address(0) to skip)
     * @param simBuyAmount Amount of native to simulate buy with (e.g. 0.001 ETH)
     */
    function query(
        address router,
        address[] calldata tokens,
        address user,
        address simulateTax,
        uint256 simBuyAmount
    ) external returns (FullResult memory r) {
        IRouter dex = IRouter(router);
        r.weth = dex.WETH();

        try dex.factory() returns (address f) { r.factory = f; } catch { return r; }

        // Native balance
        if (user != address(0)) {
            r.nativeBalance = user.balance;
        }

        // ── Batch token info + balances ──
        r.tokens = new TokenInfo[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            r.tokens[i] = _getTokenInfo(tokens[i], r.weth, r.factory);
            if (user != address(0) && tokens[i] != r.weth) {
                try IERC20(tokens[i]).balanceOf(user) returns (uint256 bal) {
                    r.tokens[i].balance = bal;
                } catch {}
            }
        }

        // ── Tax simulation (if requested) ──
        if (simulateTax != address(0) && simBuyAmount > 0) {
            r.taxToken = simulateTax;
            r.taxInfo = _simulateTax(dex, simulateTax, r.weth, r.factory, simBuyAmount);
        }
    }

    function _getTokenInfo(
        address token,
        address weth,
        address factory
    ) internal view returns (TokenInfo memory info) {
        info.token = token;
        try IERC20(token).symbol() returns (string memory s) { info.symbol = s; } catch {}
        try IERC20(token).name() returns (string memory n) { info.name = n; } catch {}
        try IERC20(token).decimals() returns (uint8 d) { info.decimals = d; } catch { info.decimals = 18; }

        if (token == weth) {
            info.hasLiquidity = true;
            return info;
        }

        try IFactory(factory).getPair(token, weth) returns (address pair) {
            info.pairAddress = pair;
            if (pair != address(0)) {
                try IPair(pair).getReserves() returns (uint112 r0, uint112 r1, uint32) {
                    address token0 = IPair(pair).token0();
                    if (token0 == token) {
                        info.reserveToken = r0;
                        info.reserveBase = r1;
                    } else {
                        info.reserveToken = r1;
                        info.reserveBase = r0;
                    }
                    info.hasLiquidity = info.reserveToken > 0 && info.reserveBase > 0;
                } catch {}
            }
        } catch {}
    }

    function _simulateTax(
        IRouter dex,
        address token,
        address weth,
        address factory,
        uint256 buyAmount
    ) internal returns (TaxInfo memory t) {
        // Check liquidity exists
        address pair;
        try IFactory(factory).getPair(token, weth) returns (address p) { pair = p; } catch {}
        if (pair == address(0)) {
            t.buyError = "No liquidity";
            return t;
        }

        address[] memory path = new address[](2);
        path[0] = weth;
        path[1] = token;

        // Expected buy amount
        uint256 expectedBuy;
        try dex.getAmountsOut(buyAmount, path) returns (uint256[] memory amounts) {
            expectedBuy = amounts[1];
        } catch {
            t.buyError = "Quote failed";
            return t;
        }

        // ── BUY ──
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
            t.buyError = reason;
            t.buyGas = gasBefore - gasleft();
            return t;
        } catch {
            t.buyError = "Buy reverted";
            t.buyGas = gasBefore - gasleft();
            return t;
        }

        // ── SELL ──
        uint256 tokensToSell = IERC20(token).balanceOf(address(this));
        if (tokensToSell == 0) { t.sellError = "No tokens"; return t; }

        try IERC20(token).approve(address(dex), tokensToSell) {} catch {
            t.sellError = "Approve failed";
            return t;
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
            t.sellError = reason;
            t.sellGas = gasBefore - gasleft();
        } catch {
            t.sellError = "Sell reverted";
            t.sellGas = gasBefore - gasleft();
        }

        t.success = t.canBuy && t.canSell;
    }

    receive() external payable {}
}
