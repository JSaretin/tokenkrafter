// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title DexInterfaces
/// @notice Single source of truth for Uniswap V2-style DEX interfaces used
///         across TokenImplementations, TokenFactory, LaunchpadFactory,
///         LaunchInstance, and PlatformRouter. Consolidates ~80 lines of
///         previously-duplicated inline declarations and removes the risk
///         that the interfaces drift apart.
///
///         We only declare the functions the platform actually calls. This
///         is both a size optimization and a surface-minimization — the
///         smaller the interface, the fewer the assumptions we make about
///         downstream DEXes.
///
///         `addLiquidity` / `addLiquidityETH` are intentionally absent —
///         every seeding path (PlatformRouter._addLiquidity, LaunchInstance
///         ._graduate) uses direct-transfer + pair.mint() instead of the
///         router's addLiquidity machinery. See the LaunchInstance docs
///         for why (grifter resistance).

interface IUniswapV2Router02 {
    function factory() external pure returns (address);
    function WETH() external pure returns (address);

    function getAmountsIn(uint256 amountOut, address[] calldata path)
        external view returns (uint256[] memory amounts);
    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external view returns (uint256[] memory amounts);

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable returns (uint256[] memory amounts);

    function swapTokensForExactTokens(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    function swapETHForExactTokens(
        uint256 amountOut,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable returns (uint256[] memory amounts);
}

interface IUniswapV2Factory {
    function createPair(address tokenA, address tokenB) external returns (address pair);
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

interface IUniswapV2Pair {
    function token0() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function mint(address to) external returns (uint256 liquidity);
}

interface IWETH {
    function deposit() external payable;
}
