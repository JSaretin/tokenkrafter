// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MultiCallLens
 * @notice Aggregates ALL platform reads in a single eth_call.
 *         Never deployed — used via eth_call with constructor bytecode + args.
 *
 * One RPC call returns: platform state, token batch info, user balances, BNB price.
 *
 * Usage (ethers.js):
 *   const factory = new ethers.ContractFactory(MultiCallLens.abi, MultiCallLens.bytecode);
 *   const result = await provider.call({
 *     data: factory.getDeployTransaction(...args).data
 *   });
 *   const decoded = ethers.AbiCoder.defaultAbiCoder().decode([...types], result);
 */

interface ITokenFactory {
    function getState() external view returns (
        address factoryOwner, uint256 totalTokens, uint256 totalFeeUsdt,
        uint256[8] memory feesPerType, uint256[8] memory countPerType,
        address[] memory paymentTokens, bool taxToStable, uint256 taxSlippage,
        uint8 refLevels, bool autoDistribute
    );
    function tokenInfo(address token) external view returns (
        address creator, bool isMintable, bool isTaxable, bool isPartnership
    );
}

interface ILaunchpadFactory {
    function getState() external view returns (
        address factoryOwner, uint256 totalLaunchCount, uint256 totalFeeUsdt, uint256 fee
    );
}

interface ITradeRouter {
    struct RouterState {
        address owner; uint256 feeBps; uint256 payoutTimeout; address platformWallet;
        uint256 totalEscrow; uint256 pendingCount; uint256 totalWithdrawals;
        bool paused; uint256 maxSlippageBps; bool affiliateEnabled;
        uint256 affiliateShareBps; address[] admins;
    }
    function getState() external view returns (RouterState memory);
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
    function name() external view returns (string memory);
    function totalSupply() external view returns (uint256);
}

interface IDexRouter {
    function WETH() external pure returns (address);
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory);
}

contract MultiCallLens {

    struct PlatformData {
        // TokenFactory
        address tfOwner;
        uint256 tfTotalTokens;
        uint256 tfTotalFeeUsdt;
        uint256[8] tfFeesPerType;
        uint256[8] tfCountPerType;
        // LaunchpadFactory
        address lpOwner;
        uint256 lpTotalLaunches;
        uint256 lpTotalFeeUsdt;
        uint256 lpLaunchFee;
        // TradeRouter
        address trOwner;
        uint256 trFeeBps;
        uint256 trPayoutTimeout;
        address trPlatformWallet;
        uint256 trTotalEscrow;
        uint256 trPendingCount;
        uint256 trTotalWithdrawals;
        bool trPaused;
        bool trAffiliateEnabled;
        // Price
        uint256 nativePriceUsdt;
    }

    struct TokenData {
        address addr;
        string name;
        string symbol;
        uint8 decimals;
        uint256 totalSupply;
        uint256 userBalance;
        address creator;
        bool isMintable;
        bool isTaxable;
        bool isPartner;
    }

    struct BalanceInfo {
        address token;  // address(0) = native
        uint256 balance;
        uint8 decimals;
    }

    constructor(
        address tokenFactory,
        address launchpadFactory,
        address tradeRouter,
        address usdt,
        address dexRouter,
        address user,                // address(0) to skip balances
        address[] memory tokens,     // tokens to fetch info for (empty to skip)
        address[] memory balanceTokens // tokens to check balances for (empty to skip)
    ) {
        PlatformData memory p;

        // ── TokenFactory ──
        if (tokenFactory != address(0)) {
            try ITokenFactory(tokenFactory).getState() returns (
                address owner_, uint256 total_, uint256 fee_,
                uint256[8] memory fees_, uint256[8] memory counts_,
                address[] memory, bool, uint256, uint8, bool
            ) {
                p.tfOwner = owner_;
                p.tfTotalTokens = total_;
                p.tfTotalFeeUsdt = fee_;
                p.tfFeesPerType = fees_;
                p.tfCountPerType = counts_;
            } catch {}
        }

        // ── LaunchpadFactory ──
        if (launchpadFactory != address(0)) {
            try ILaunchpadFactory(launchpadFactory).getState() returns (
                address owner_, uint256 total_, uint256 fee_, uint256 launchFee_
            ) {
                p.lpOwner = owner_;
                p.lpTotalLaunches = total_;
                p.lpTotalFeeUsdt = fee_;
                p.lpLaunchFee = launchFee_;
            } catch {}
        }

        // ── TradeRouter ──
        if (tradeRouter != address(0)) {
            try ITradeRouter(tradeRouter).getState() returns (ITradeRouter.RouterState memory s) {
                p.trOwner = s.owner;
                p.trFeeBps = s.feeBps;
                p.trPayoutTimeout = s.payoutTimeout;
                p.trPlatformWallet = s.platformWallet;
                p.trTotalEscrow = s.totalEscrow;
                p.trPendingCount = s.pendingCount;
                p.trTotalWithdrawals = s.totalWithdrawals;
                p.trPaused = s.paused;
                p.trAffiliateEnabled = s.affiliateEnabled;
            } catch {}
        }

        // ── BNB price ──
        if (dexRouter != address(0) && usdt != address(0)) {
            try IDexRouter(dexRouter).WETH() returns (address weth) {
                address[] memory path = new address[](2);
                path[0] = weth;
                path[1] = usdt;
                try IDexRouter(dexRouter).getAmountsOut(1e18, path) returns (uint256[] memory amounts) {
                    p.nativePriceUsdt = amounts[1];
                } catch {}
            } catch {}
        }

        // ── Token batch info ──
        TokenData[] memory tokenResults = new TokenData[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            tokenResults[i].addr = tokens[i];
            IERC20 t = IERC20(tokens[i]);
            try t.name() returns (string memory n) { tokenResults[i].name = n; } catch {}
            try t.symbol() returns (string memory s) { tokenResults[i].symbol = s; } catch {}
            try t.decimals() returns (uint8 d) { tokenResults[i].decimals = d; } catch {}
            try t.totalSupply() returns (uint256 s) { tokenResults[i].totalSupply = s; } catch {}
            if (user != address(0)) {
                try t.balanceOf(user) returns (uint256 b) { tokenResults[i].userBalance = b; } catch {}
            }
            if (tokenFactory != address(0)) {
                try ITokenFactory(tokenFactory).tokenInfo(tokens[i]) returns (
                    address c, bool m, bool tx_, bool pt
                ) {
                    tokenResults[i].creator = c;
                    tokenResults[i].isMintable = m;
                    tokenResults[i].isTaxable = tx_;
                    tokenResults[i].isPartner = pt;
                } catch {}
            }
        }

        // ── Balance batch ──
        BalanceInfo[] memory balResults;
        {
            uint256 hasNative = user != address(0) ? 1 : 0;
            balResults = new BalanceInfo[](balanceTokens.length + hasNative);
            uint256 idx = 0;
            if (hasNative == 1) {
                balResults[idx++] = BalanceInfo(address(0), user.balance, 18);
            }
            for (uint256 i = 0; i < balanceTokens.length; i++) {
                balResults[idx].token = balanceTokens[i];
                try IERC20(balanceTokens[i]).balanceOf(user) returns (uint256 b) {
                    balResults[idx].balance = b;
                } catch {}
                try IERC20(balanceTokens[i]).decimals() returns (uint8 d) {
                    balResults[idx].decimals = d;
                } catch {}
                idx++;
            }
        }

        // ── Encode everything and return ──
        bytes memory encoded = abi.encode(p, tokenResults, balResults);
        assembly {
            return(add(encoded, 32), mload(encoded))
        }
    }
}
