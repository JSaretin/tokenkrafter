// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title SafuLens
 * @notice Batch-reads SAFU badge data for multiple tokens in a single
 *         eth_call. Never deployed — the frontend sends the creation
 *         bytecode + constructor args via eth_call, the constructor runs
 *         all the reads, and the return data is ABI-decoded.
 *
 *         Each token gets a struct of boolean badges derived from on-chain
 *         state. The frontend decides how to render them (badge pills,
 *         composite "SAFU" label, trust score, etc.).
 *
 * Usage (ethers.js):
 *   const args = abiCoder.encode(
 *     ['address', 'address', 'address[]'],
 *     [tokenFactoryAddr, dexFactoryAddr, tokenAddresses]
 *   );
 *   const callData = SafuLensArtifact.bytecode + args.slice(2);
 *   const raw = await provider.call({ data: callData });
 *   const [results] = abiCoder.decode(
 *     ['tuple(address token, bool isMintable, bool isTaxable, bool isPartner, bool ownerIsZero, bool taxCeilingLocked, bool tradingEnabled, bool hasLiquidity, bool lpBurned, uint256 lpBurnedPct, address owner, uint256 buyTaxBps, uint256 sellTaxBps, uint256 transferTaxBps, bool isSafu)[]'],
 *     raw
 *   );
 */
contract SafuLens {
    struct TokenSafu {
        address token;
        // Factory metadata
        bool isMintable;
        bool isTaxable;
        bool isPartner;
        // Ownership
        address owner;
        bool ownerIsZero;
        // Tax ceiling
        bool taxCeilingLocked;
        uint256 buyTaxBps;
        uint256 sellTaxBps;
        uint256 transferTaxBps;
        // Trading
        bool tradingEnabled;
        // Liquidity
        bool hasLiquidity;
        bool lpBurned;         // any LP at 0xdead
        uint256 lpBurnedPct;   // 0-10000 bps of total LP burned
        // Composite
        bool isSafu;
    }

    constructor(
        address tokenFactory,
        address dexFactory,
        address weth,
        address usdt,
        address[] memory tokens
    ) {
        TokenSafu[] memory results = new TokenSafu[](tokens.length);

        for (uint256 i = 0; i < tokens.length; i++) {
            address t = tokens[i];
            TokenSafu memory s;
            s.token = t;

            // Factory metadata
            try ITokenFactory(tokenFactory).tokenInfo(t) returns (
                address, bool _isMintable, bool _isTaxable, bool _isPartner
            ) {
                s.isMintable = _isMintable;
                s.isTaxable = _isTaxable;
                s.isPartner = _isPartner;
            } catch {}

            // Owner
            try IOwnable(t).owner() returns (address o) {
                s.owner = o;
                s.ownerIsZero = o == address(0);
            } catch {}

            // Tax ceiling
            try ITaxable(t).taxCeilingIsLocked() returns (bool locked) {
                s.taxCeilingLocked = locked;
            } catch {}

            // Current tax rates
            try ITaxable(t).buyTaxBps() returns (uint256 v) { s.buyTaxBps = v; } catch {}
            try ITaxable(t).sellTaxBps() returns (uint256 v) { s.sellTaxBps = v; } catch {}
            try ITaxable(t).transferTaxBps() returns (uint256 v) { s.transferTaxBps = v; } catch {}

            // Trading state
            try IProtected(t).tradingStartTime() returns (uint256 ts) {
                s.tradingEnabled = ts != type(uint256).max && ts <= block.timestamp;
            } catch {}

            // Liquidity: check WETH pair, then USDT pair
            if (weth != address(0)) {
                try IDexFactory(dexFactory).getPair(t, weth) returns (address pair) {
                    if (pair != address(0)) _checkLiquidity(pair, s);
                } catch {}
            }
            if (!s.hasLiquidity && usdt != address(0)) {
                try IDexFactory(dexFactory).getPair(t, usdt) returns (address pair2) {
                    if (pair2 != address(0)) _checkLiquidity(pair2, s);
                } catch {}
            }

            // Composite SAFU:
            // - tax ceiling locked (or not taxable/partner — no tax to worry about)
            // - trading enabled + has liquidity
            // - LP fully burned
            // - not mintable, OR mintable but owner renounced
            bool taxSafe = s.taxCeilingLocked || (!s.isTaxable && !s.isPartner);
            bool mintSafe = !s.isMintable || s.ownerIsZero;
            s.isSafu = taxSafe && mintSafe && s.tradingEnabled && s.hasLiquidity && s.lpBurnedPct >= 9900; // 99%+ burned

            results[i] = s;
        }

        // Encode and return via revert-trick (constructor can't return)
        bytes memory encoded = abi.encode(results);
        assembly {
            return(add(encoded, 32), mload(encoded))
        }
    }

    function _checkLiquidity(address pair, TokenSafu memory s) internal view {
        try IPair(pair).getReserves() returns (uint112 r0, uint112 r1, uint32) {
            if (r0 > 0 && r1 > 0) s.hasLiquidity = true;
        } catch {}

        address dead = 0x000000000000000000000000000000000000dEaD;
        try IERC20(pair).balanceOf(dead) returns (uint256 deadBal) {
            if (deadBal > 0) {
                s.lpBurned = true;
                try IERC20(pair).totalSupply() returns (uint256 total) {
                    if (total > 0) {
                        s.lpBurnedPct = (deadBal * 10000) / total;
                    }
                } catch {}
            }
        } catch {}
    }
}

// Minimal interfaces — only what the lens reads
interface ITokenFactory {
    function tokenInfo(address) external view returns (address creator, bool isMintable, bool isTaxable, bool isPartnership);
}

// IRouter and IRouterWETH removed — WETH and USDT passed as constructor args directly.

interface IOwnable {
    function owner() external view returns (address);
}

interface ITaxable {
    function taxCeilingIsLocked() external view returns (bool);
    function buyTaxBps() external view returns (uint256);
    function sellTaxBps() external view returns (uint256);
    function transferTaxBps() external view returns (uint256);
}

interface IProtected {
    function tradingStartTime() external view returns (uint256);
}

interface IDexFactory {
    function getPair(address, address) external view returns (address);
}

interface IPair {
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function totalSupply() external view returns (uint256);
}

