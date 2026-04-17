// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title RouteFinder
 * @notice Constructor-only — never deployed. Finds the best swap route
 *         between two tokens through any of the provided base tokens.
 *
 * For each base, checks if pairs exist with both inToken and outToken,
 * simulates the swap using reserves, and returns the best path + expected output.
 * Also checks direct inToken/outToken pair.
 *
 * Returns all viable routes sorted by output amount (best first).
 *
 * Usage (ethers.js):
 *   const args = abiCoder.encode(
 *     ['address','address','address','uint256','address[]'],
 *     [dexRouter, inToken, outToken, amountIn, bases]
 *   );
 *   const raw = await provider.call({ data: bytecode + args.slice(2), gasLimit: 5_000_000 });
 *   const decoded = abiCoder.decode([RESULT_TYPE], raw);
 */

interface IFactory {
    function getPair(address, address) external view returns (address);
}

interface IRouter {
    function WETH() external pure returns (address);
    function factory() external pure returns (address);
}

interface IPair {
    function getReserves() external view returns (uint112, uint112, uint32);
    function token0() external view returns (address);
}

interface IERC20 {
    function decimals() external view returns (uint8);
}

contract RouteFinder {

    struct Route {
        address[] path;       // e.g. [inToken, base, outToken] or [inToken, outToken]
        uint256 amountOut;    // expected output after 0.25% DEX fee
        uint256 reserveIn;    // reserves of the limiting pool (for price impact)
        uint256 reserveOut;
    }

    constructor(
        address dexRouter,
        address inToken,
        address outToken,
        uint256 amountIn,
        address[] memory bases
    ) {
        address weth = IRouter(dexRouter).WETH();
        address factory = IRouter(dexRouter).factory();

        // Substitute address(0) → WETH for pair lookups (native coin)
        address lookupIn = inToken == address(0) ? weth : inToken;
        address lookupOut = outToken == address(0) ? weth : outToken;

        Route[] memory routes = new Route[](bases.length + 1); // +1 for direct
        uint256 count = 0;

        // ── 1. Check direct pair: inToken / outToken ──
        {
            (uint256 rIn, uint256 rOut, address pair) = _getReserves(factory, lookupIn, lookupOut);
            if (pair != address(0) && rIn > 0 && rOut > 0) {
                uint256 out = _getAmountOut(amountIn, rIn, rOut);
                if (out > 0) {
                    address[] memory path = new address[](2);
                    path[0] = inToken;
                    path[1] = outToken;
                    routes[count++] = Route(path, out, rIn, rOut);
                }
            }
        }

        // ── 2. Check each base: inToken → base → outToken ──
        for (uint256 i = 0; i < bases.length; i++) {
            address base = bases[i];
            if (base == lookupIn || base == lookupOut) {
                // Base IS one of the tokens — check the other side directly
                if (base == lookupIn) {
                    // inToken is the base — just need base/outToken pair
                    (uint256 rIn, uint256 rOut, address pair) = _getReserves(factory, base, lookupOut);
                    if (pair != address(0) && rIn > 0 && rOut > 0) {
                        uint256 out = _getAmountOut(amountIn, rIn, rOut);
                        if (out > 0) {
                            address[] memory path = new address[](2);
                            path[0] = inToken;
                            path[1] = outToken;
                            // Only add if not already added as direct
                            bool dup = false;
                            for (uint256 j = 0; j < count; j++) {
                                if (routes[j].path.length == 2 && routes[j].path[0] == inToken && routes[j].path[1] == outToken) {
                                    if (out > routes[j].amountOut) routes[j] = Route(path, out, rIn, rOut);
                                    dup = true;
                                    break;
                                }
                            }
                            if (!dup) routes[count++] = Route(path, out, rIn, rOut);
                        }
                    }
                } else {
                    // outToken is the base — just need inToken/base pair
                    (uint256 rIn, uint256 rOut, address pair) = _getReserves(factory, lookupIn, base);
                    if (pair != address(0) && rIn > 0 && rOut > 0) {
                        uint256 out = _getAmountOut(amountIn, rIn, rOut);
                        if (out > 0) {
                            address[] memory path = new address[](2);
                            path[0] = inToken;
                            path[1] = outToken;
                            bool dup = false;
                            for (uint256 j = 0; j < count; j++) {
                                if (routes[j].path.length == 2 && routes[j].path[0] == inToken && routes[j].path[1] == outToken) {
                                    if (out > routes[j].amountOut) routes[j] = Route(path, out, rIn, rOut);
                                    dup = true;
                                    break;
                                }
                            }
                            if (!dup) routes[count++] = Route(path, out, rIn, rOut);
                        }
                    }
                }
                continue;
            }

            // Two-hop: inToken → base → outToken
            (uint256 rIn1, uint256 rOut1, address pair1) = _getReserves(factory, lookupIn, base);
            if (pair1 == address(0) || rIn1 == 0 || rOut1 == 0) continue;

            uint256 midAmount = _getAmountOut(amountIn, rIn1, rOut1);
            if (midAmount == 0) continue;

            (uint256 rIn2, uint256 rOut2, address pair2) = _getReserves(factory, base, lookupOut);
            if (pair2 == address(0) || rIn2 == 0 || rOut2 == 0) continue;

            uint256 finalOut = _getAmountOut(midAmount, rIn2, rOut2);
            if (finalOut > 0) {
                address[] memory path = new address[](3);
                path[0] = inToken;
                path[1] = base;
                path[2] = outToken;
                routes[count++] = Route(path, finalOut, rIn2, rOut2);
            }
        }

        // ── 3. Sort by amountOut descending (simple bubble, small N) ──
        for (uint256 i = 0; i < count; i++) {
            for (uint256 j = i + 1; j < count; j++) {
                if (routes[j].amountOut > routes[i].amountOut) {
                    Route memory tmp = routes[i];
                    routes[i] = routes[j];
                    routes[j] = tmp;
                }
            }
        }

        // ── 4. Trim to actual count and return ──
        Route[] memory result = new Route[](count);
        for (uint256 i = 0; i < count; i++) {
            result[i] = routes[i];
        }

        bytes memory encoded = abi.encode(result);
        assembly { return(add(encoded, 32), mload(encoded)) }
    }

    /// @dev Get reserves for a pair, ordered as (reserveA, reserveB) where A=tokenA, B=tokenB
    function _getReserves(address factory, address tokenA, address tokenB)
        internal view returns (uint256 reserveA, uint256 reserveB, address pair)
    {
        try IFactory(factory).getPair(tokenA, tokenB) returns (address p) {
            if (p == address(0)) return (0, 0, address(0));
            pair = p;
            try IPair(p).getReserves() returns (uint112 r0, uint112 r1, uint32) {
                try IPair(p).token0() returns (address t0) {
                    if (t0 == tokenA) {
                        reserveA = r0;
                        reserveB = r1;
                    } else {
                        reserveA = r1;
                        reserveB = r0;
                    }
                } catch {}
            } catch {}
        } catch {}
    }

    /// @dev PancakeSwap V2 getAmountOut with 0.25% fee (9975/10000)
    function _getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        internal pure returns (uint256)
    {
        if (amountIn == 0 || reserveIn == 0 || reserveOut == 0) return 0;
        uint256 amountInWithFee = amountIn * 9975;
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = reserveIn * 10000 + amountInWithFee;
        return numerator / denominator;
    }
}
