// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Mock USDT for testing
contract MockUSDT is ERC20 {
    constructor() ERC20("Mock USDT", "USDT") {
        _mint(msg.sender, 1_000_000_000 * 1e6);
    }
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @dev 18-decimal mock USDT for local frontend testing (matches BSC USDT decimals)
contract MockUSDT18 is ERC20 {
    constructor() ERC20("Mock USDT", "USDT") {
        _mint(msg.sender, 1_000_000_000 * 1e18);
    }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @dev Mock WETH for testing
contract MockWETH is ERC20 {
    constructor() ERC20("Wrapped ETH", "WETH") {}
    function deposit() external payable { _mint(msg.sender, msg.value); }
    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok);
    }
    receive() external payable { _mint(msg.sender, msg.value); }
}

/// @dev Minimal mock Uniswap V2 Pair. Implements just enough to let
///      `LaunchInstance._graduate` complete in tests:
///        - tokens are transferred into the pair by the caller
///        - `mint(to)` snapshots balances, issues 1 LP unit to `to`, and
///          records reserves so `getReserves` returns sensible values
contract MockUniswapV2Pair {
    address public token0;
    address public token1;
    uint112 private _reserve0;
    uint112 private _reserve1;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    constructor(address _token0, address _token1) {
        // sort addresses to match V2 canonical order
        if (_token0 < _token1) { token0 = _token0; token1 = _token1; }
        else { token0 = _token1; token1 = _token0; }
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (_reserve0, _reserve1, uint32(block.timestamp));
    }

    function mint(address to) external returns (uint256 liquidity) {
        uint256 b0 = IERC20(token0).balanceOf(address(this));
        uint256 b1 = IERC20(token1).balanceOf(address(this));
        liquidity = 1e18;
        totalSupply += liquidity;
        balanceOf[to] += liquidity;
        _reserve0 = uint112(b0);
        _reserve1 = uint112(b1);
    }

    function sync() external {
        _reserve0 = uint112(IERC20(token0).balanceOf(address(this)));
        _reserve1 = uint112(IERC20(token1).balanceOf(address(this)));
    }
}

/// @dev Minimal mock Uniswap V2 Factory. `createPair` deploys a real
///      `MockUniswapV2Pair` contract (not just a pseudo-address) so it can
///      be called by `mint()` during graduation tests.
contract MockUniswapV2Factory {
    mapping(address => mapping(address => address)) public pairs;

    function getPair(address tokenA, address tokenB) external view returns (address) {
        return pairs[tokenA][tokenB];
    }

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        require(tokenA != tokenB, "identical");
        require(pairs[tokenA][tokenB] == address(0), "exists");
        MockUniswapV2Pair p = new MockUniswapV2Pair(tokenA, tokenB);
        pair = address(p);
        pairs[tokenA][tokenB] = pair;
        pairs[tokenB][tokenA] = pair;
        return pair;
    }
}

/// @dev Minimal mock Uniswap V2 Router with configurable price
contract MockUniswapV2Router {
    address public immutable WETH;
    address public immutable factory;

    // price[tokenA][tokenB] = how many tokenB per 1e18 tokenA
    mapping(address => mapping(address => uint256)) public mockPrice;

    constructor(address _weth, address _factory) {
        WETH = _weth;
        factory = _factory;
    }

    function setMockPrice(address tokenA, address tokenB, uint256 price) external {
        mockPrice[tokenA][tokenB] = price;
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external view returns (uint256[] memory amounts)
    {
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        for (uint256 i = 0; i < path.length - 1; i++) {
            uint256 price = mockPrice[path[i]][path[i+1]];
            require(price > 0, "MockRouter: no price set");
            amounts[i+1] = (amounts[i] * price) / 1e18;
        }
    }

    function getAmountsIn(uint256 amountOut, address[] calldata path)
        external view returns (uint256[] memory amounts)
    {
        amounts = new uint256[](path.length);
        amounts[path.length - 1] = amountOut;
        for (uint256 i = path.length - 1; i > 0; i--) {
            uint256 price = mockPrice[path[i-1]][path[i]];
            require(price > 0, "MockRouter: no price set");
            amounts[i-1] = (amounts[i] * 1e18) / price;
        }
    }

    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 /* deadline */
    ) external payable returns (uint256[] memory amounts) {
        require(path[0] == WETH, "first must be WETH");
        amounts = new uint256[](path.length);
        amounts[0] = msg.value;
        for (uint256 i = 0; i < path.length - 1; i++) {
            uint256 price = mockPrice[path[i]][path[i+1]];
            require(price > 0, "MockRouter: no price");
            amounts[i+1] = (amounts[i] * price) / 1e18;
        }
        require(amounts[path.length-1] >= amountOutMin, "slippage");
        IERC20(path[path.length-1]).transfer(to, amounts[path.length-1]);
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 /* deadline */
    ) external returns (uint256[] memory amounts) {
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        for (uint256 i = 0; i < path.length - 1; i++) {
            uint256 price = mockPrice[path[i]][path[i+1]];
            require(price > 0, "MockRouter: no price");
            amounts[i+1] = (amounts[i] * price) / 1e18;
        }
        require(amounts[path.length-1] >= amountOutMin, "slippage");
        IERC20(path[path.length-1]).transfer(to, amounts[path.length-1]);
    }

    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 /* amountAMin */,
        uint256 /* amountBMin */,
        address /* to */,
        uint256 /* deadline */
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
        IERC20(tokenA).transferFrom(msg.sender, address(this), amountADesired);
        IERC20(tokenB).transferFrom(msg.sender, address(this), amountBDesired);
        return (amountADesired, amountBDesired, amountADesired);
    }

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 /* amountTokenMin */,
        uint256 /* amountETHMin */,
        address /* to */,
        uint256 /* deadline */
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity) {
        IERC20(token).transferFrom(msg.sender, address(this), amountTokenDesired);
        return (amountTokenDesired, msg.value, amountTokenDesired);
    }

    receive() external payable {}
}
