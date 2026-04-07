// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ITokenFactory {
    struct CreateTokenParams {
        string name;
        string symbol;
        uint256 totalSupply;
        uint8 decimals;
        bool isTaxable;
        bool isMintable;
        bool isPartner;
        address paymentToken;
    }

    function routerCreateToken(
        address creator,
        CreateTokenParams calldata p,
        address referral
    ) external payable returns (address);

    function convertFee(
        uint256 usdtAmount,
        address paymentToken
    ) external view returns (uint256);

    function creationFee(uint8 typeKey) external view returns (uint256);
}

interface ILaunchpadFactory {
    function routerCreateLaunch(
        address creator_,
        address token_,
        uint256 totalTokens_,
        uint8 curveType_,
        uint256 softCap_,
        uint256 hardCap_,
        uint256 durationDays_,
        uint256 maxBuyBps_,
        uint256 creatorAllocationBps_,
        uint256 vestingDays_,
        address paymentToken_,
        uint256 startTimestamp_
    ) external payable returns (address);

    function notifyDeposit(address launch_, uint256 amount) external;

    function convertFee(
        uint256 usdtAmount,
        address paymentToken
    ) external view returns (uint256);

    function launchFee() external view returns (uint256);
}

interface IUniswapV2Router02 {
    function WETH() external pure returns (address);
    function factory() external pure returns (address);
    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity);
    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity);
}

interface IUniswapV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

interface IPoolToken {
    function setupPools(address[] calldata pools) external;
    function addPool(address pool) external;
}

interface IProtectedToken {
    function enableTrading() external;
    function setMaxWalletAmount(uint256 amount) external;
    function setMaxTransactionAmount(uint256 amount) external;
    function setCooldownTime(uint256 _seconds) external;
    function setExcludedFromLimits(address account, bool excluded) external;
}

interface ITaxableToken {
    function setTaxes(
        uint256 buyTaxBps,
        uint256 sellTaxBps,
        uint256 transferTaxBps
    ) external;

    function setTaxDistribution(
        address[] calldata wallets,
        uint16[] calldata sharesBps
    ) external;

    function excludeFromTax(address account, bool exempt) external;
}

interface IOwnableToken {
    function transferOwnership(address newOwner) external;
}

contract PlatformRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ----------------------------------------------------------------
    // Errors
    // ----------------------------------------------------------------
    error NativeTransferFailed();
    error InsufficientNativeValue();
    error ZeroAddress();
    error TokensForLaunchExceedsSupply();
    error ArrayLengthMismatch();
    error InsufficientTokensForLiquidity();

    // ----------------------------------------------------------------
    // Events
    // ----------------------------------------------------------------
    event TokenCreatedAndLaunched(
        address indexed creator,
        address indexed token,
        address indexed launch
    );
    event TokenCreatedAndListed(
        address indexed creator,
        address indexed token,
        uint256 poolCount
    );

    // ----------------------------------------------------------------
    // State
    // ----------------------------------------------------------------
    ITokenFactory public immutable tokenFactory;
    ILaunchpadFactory public immutable launchpadFactory;
    IUniswapV2Router02 public immutable dexRouter;

    // ----------------------------------------------------------------
    // Structs
    // ----------------------------------------------------------------
    struct ProtectionParams {
        uint256 maxWalletAmount;
        uint256 maxTransactionAmount;
        uint256 cooldownSeconds;
    }

    struct TaxParams {
        uint256 buyTaxBps;
        uint256 sellTaxBps;
        uint256 transferTaxBps;
        address[] taxWallets;
        uint16[] taxSharesBps;
    }

    struct ListParams {
        address[] bases;           // base tokens for LP (address(0) = native coin)
        uint256[] baseAmounts;     // amount of each base token for LP
        uint256[] tokenAmounts;    // amount of created token per pool
    }

    struct LaunchParams {
        uint256 tokensForLaunch;
        uint8 curveType;
        uint256 softCap;
        uint256 hardCap;
        uint256 durationDays;
        uint256 maxBuyBps;
        uint256 creatorAllocationBps;
        uint256 vestingDays;
        address launchPaymentToken;
        uint256 startTimestamp;
    }

    // ----------------------------------------------------------------
    // Constructor
    // ----------------------------------------------------------------
    constructor(address tokenFactory_, address launchpadFactory_, address dexRouter_) {
        if (tokenFactory_ == address(0) || launchpadFactory_ == address(0) || dexRouter_ == address(0))
            revert ZeroAddress();

        tokenFactory = ITokenFactory(tokenFactory_);
        launchpadFactory = ILaunchpadFactory(launchpadFactory_);
        dexRouter = IUniswapV2Router02(dexRouter_);
    }

    // ----------------------------------------------------------------
    // Main entry point
    // ----------------------------------------------------------------
    function createTokenAndLaunch(
        ITokenFactory.CreateTokenParams calldata p,
        LaunchParams calldata launch,
        ProtectionParams calldata protection,
        TaxParams calldata tax,
        address referral
    )
        external
        payable
        nonReentrant
        returns (address tokenAddress, address launchAddress)
    {
        // 0. Snapshot ETH balance before this call to ignore residual dust
        uint256 preBalance = address(this).balance - msg.value;

        // 1. Compute token type key
        uint8 typeKey = uint8(
            (p.isPartner ? 4 : 0) |
            (p.isTaxable ? 2 : 0) |
            (p.isMintable ? 1 : 0)
        );

        // 2. Handle token creation fee
        uint256 creationFeeNativeValue;
        if (p.paymentToken == address(0)) {
            // Native payment: send ALL msg.value to the factory.
            // Factory takes the exact fee and refunds excess back to this router.
            // This eliminates the race condition from pre-computing the fee.
            creationFeeNativeValue = msg.value;
        } else {
            // ERC20 payment: pull from user, approve factory, factory pulls from router.
            uint256 creationFeeAmount = tokenFactory.convertFee(
                tokenFactory.creationFee(typeKey),
                p.paymentToken
            );
            if (creationFeeAmount > 0) {
                IERC20(p.paymentToken).safeTransferFrom(
                    msg.sender,
                    address(this),
                    creationFeeAmount
                );
                IERC20(p.paymentToken).forceApprove(
                    address(tokenFactory),
                    creationFeeAmount
                );
            }
        }

        // 3. Create the token via TokenFactory.
        //    After this call, the router holds the entire token supply AND
        //    is the token owner (factory transfers both at the end of routerCreateToken).
        //    Any excess native is refunded back to the router.
        tokenAddress = tokenFactory.routerCreateToken{
            value: creationFeeNativeValue
        }(msg.sender, p, referral);

        // 3b. Validate tokensForLaunch doesn't exceed minted supply
        uint256 totalMinted = IERC20(tokenAddress).balanceOf(address(this));
        if (launch.tokensForLaunch > totalMinted) revert TokensForLaunchExceedsSupply();

        // 4. Handle launch fee
        uint256 launchNativeValue;
        if (launch.launchPaymentToken == address(0)) {
            // Native payment: use only this call's remaining ETH (ignore residual dust)
            launchNativeValue = address(this).balance - preBalance;
        } else {
            // ERC20 payment: pull from user, approve factory, factory pulls from router.
            uint256 launchFeeAmount = launchpadFactory.convertFee(
                launchpadFactory.launchFee(),
                launch.launchPaymentToken
            );
            if (launchFeeAmount > 0) {
                IERC20(launch.launchPaymentToken).safeTransferFrom(
                    msg.sender,
                    address(this),
                    launchFeeAmount
                );
                IERC20(launch.launchPaymentToken).forceApprove(
                    address(launchpadFactory),
                    launchFeeAmount
                );
            }
        }

        // 5. Create the launch via LaunchpadFactory
        launchAddress = launchpadFactory.routerCreateLaunch{
            value: launchNativeValue
        }(
            msg.sender,
            tokenAddress,
            launch.tokensForLaunch,
            launch.curveType,
            launch.softCap,
            launch.hardCap,
            launch.durationDays,
            launch.maxBuyBps,
            launch.creatorAllocationBps,
            launch.vestingDays,
            launch.launchPaymentToken,
            launch.startTimestamp
        );

        // 6. Transfer launch tokens to the launch instance and notify
        IERC20(tokenAddress).safeTransfer(launchAddress, launch.tokensForLaunch);
        launchpadFactory.notifyDeposit(launchAddress, launch.tokensForLaunch);

        // 7. Configure token protections (router is owner, set by factory)
        _configureLaunchProtections(
            tokenAddress,
            launchAddress,
            protection,
            tax,
            p.isTaxable
        );

        // 8. Transfer remaining tokens to the creator
        uint256 remaining = IERC20(tokenAddress).balanceOf(address(this));
        if (remaining > 0) {
            IERC20(tokenAddress).safeTransfer(msg.sender, remaining);
        }

        // 9. Transfer token ownership from router to the creator
        IOwnableToken(tokenAddress).transferOwnership(msg.sender);

        // 10. Refund any excess native (only this call's ETH, not residual)
        uint256 excess = address(this).balance > preBalance ? address(this).balance - preBalance : 0;
        if (excess > 0) {
            (bool ok, ) = payable(msg.sender).call{value: excess}("");
            if (!ok) revert NativeTransferFailed();
        }

        emit TokenCreatedAndLaunched(msg.sender, tokenAddress, launchAddress);
    }

    // ----------------------------------------------------------------
    // Create token and list on DEX directly (no bonding curve)
    // ----------------------------------------------------------------

    /// @notice Create a token and add liquidity to one or more DEX pools.
    ///         Supports native (ETH/BNB) and ERC20 base pairs in a single call.
    ///         For native pairs, use address(0) in list.bases[] and send ETH via msg.value.
    ///         For ERC20-only listing, send msg.value = 0 (or just enough for creation fee if paying native).
    function createAndList(
        ITokenFactory.CreateTokenParams calldata p,
        ListParams calldata list,
        ProtectionParams calldata protection,
        TaxParams calldata tax,
        address referral
    )
        external
        payable
        nonReentrant
        returns (address tokenAddress)
    {
        if (list.bases.length != list.baseAmounts.length || list.bases.length != list.tokenAmounts.length)
            revert ArrayLengthMismatch();

        // 0. Snapshot ETH balance before this call
        uint256 preBalance = address(this).balance - msg.value;

        // 1. Compute token type and handle creation fee
        uint8 typeKey = uint8(
            (p.isPartner ? 4 : 0) | (p.isTaxable ? 2 : 0) | (p.isMintable ? 1 : 0)
        );

        uint256 creationFeeNativeValue;
        if (p.paymentToken == address(0)) {
            creationFeeNativeValue = msg.value;
        } else {
            uint256 creationFeeAmount = tokenFactory.convertFee(
                tokenFactory.creationFee(typeKey), p.paymentToken
            );
            if (creationFeeAmount > 0) {
                IERC20(p.paymentToken).safeTransferFrom(msg.sender, address(this), creationFeeAmount);
                IERC20(p.paymentToken).forceApprove(address(tokenFactory), creationFeeAmount);
            }
        }

        // 2. Create token — router receives full supply + ownership
        tokenAddress = tokenFactory.routerCreateToken{value: creationFeeNativeValue}(
            msg.sender, p, referral
        );

        // 3. Add liquidity + configure
        uint256 poolCount = _addLiquidity(tokenAddress, list, preBalance);

        // 4. Configure protections + tax
        _configureAndEnableTrading(tokenAddress, protection, tax, p.isTaxable || p.isPartner);

        // 5. Transfer remaining tokens + ownership to creator
        uint256 remaining = IERC20(tokenAddress).balanceOf(address(this));
        if (remaining > 0) IERC20(tokenAddress).safeTransfer(msg.sender, remaining);
        IOwnableToken(tokenAddress).transferOwnership(msg.sender);

        // 6. Refund excess native (only this call's ETH)
        _refundExcess(preBalance);

        emit TokenCreatedAndListed(msg.sender, tokenAddress, poolCount);
    }

    // ----------------------------------------------------------------
    // List existing token on DEX (no token creation)
    // ----------------------------------------------------------------

    event TokenListed(address indexed owner, address indexed token, uint256 poolCount);

    /// @notice Add liquidity for an existing token to one or more DEX pools.
    ///         Caller must approve this router for both the token and base amounts.
    ///         For native pairs, use address(0) in list.bases[] and send ETH via msg.value.
    function listTokenToDex(
        address tokenAddress,
        ListParams calldata list
    )
        external
        payable
        nonReentrant
    {
        if (tokenAddress == address(0)) revert ZeroAddress();
        if (list.bases.length != list.baseAmounts.length || list.bases.length != list.tokenAmounts.length)
            revert ArrayLengthMismatch();

        uint256 preBalance = address(this).balance - msg.value;

        // Pull tokens from caller
        uint256 totalTokensNeeded;
        for (uint256 i = 0; i < list.tokenAmounts.length; i++) {
            totalTokensNeeded += list.tokenAmounts[i];
        }
        IERC20(tokenAddress).safeTransferFrom(msg.sender, address(this), totalTokensNeeded);

        // Add liquidity
        uint256 poolCount = _addLiquidity(tokenAddress, list, preBalance);

        // Return any unused tokens
        uint256 leftover = IERC20(tokenAddress).balanceOf(address(this));
        if (leftover > 0) IERC20(tokenAddress).safeTransfer(msg.sender, leftover);

        // Refund excess native
        _refundExcess(preBalance);

        emit TokenListed(msg.sender, tokenAddress, poolCount);
    }

    // ----------------------------------------------------------------
    // Internal helpers
    // ----------------------------------------------------------------

    /// @dev Add liquidity to DEX pools. Handles both native (address(0)) and ERC20 bases.
    ///      Pulls ERC20 bases from msg.sender. Native ETH comes from contract balance.
    function _addLiquidity(
        address tokenAddress,
        ListParams calldata list,
        uint256 preBalance
    ) internal returns (uint256 poolCount) {
        IUniswapV2Factory factory = IUniswapV2Factory(dexRouter.factory());
        poolCount = list.bases.length;
        address[] memory pools = new address[](poolCount);

        for (uint256 i = 0; i < poolCount; i++) {
            IERC20(tokenAddress).forceApprove(address(dexRouter), list.tokenAmounts[i]);

            if (list.bases[i] == address(0)) {
                // Native pair — use remaining ETH from this call
                uint256 ethAvailable = address(this).balance - preBalance;
                dexRouter.addLiquidityETH{value: list.baseAmounts[i] > ethAvailable ? ethAvailable : list.baseAmounts[i]}(
                    tokenAddress, list.tokenAmounts[i], 0, 0,
                    msg.sender, block.timestamp + 300
                );
                pools[i] = factory.getPair(tokenAddress, dexRouter.WETH());
            } else {
                // ERC20 pair — pull base from caller
                IERC20(list.bases[i]).safeTransferFrom(msg.sender, address(this), list.baseAmounts[i]);
                IERC20(list.bases[i]).forceApprove(address(dexRouter), list.baseAmounts[i]);
                dexRouter.addLiquidity(
                    tokenAddress, list.bases[i],
                    list.tokenAmounts[i], list.baseAmounts[i], 0, 0,
                    msg.sender, block.timestamp + 300
                );
                pools[i] = factory.getPair(tokenAddress, list.bases[i]);
            }
        }

        // Register pools on token — use addPool (not setupPools which may already be initialized)
        for (uint256 i = 0; i < pools.length; i++) {
            if (pools[i] != address(0)) {
                // addPool sets isPool + isExcludedFromLimits in one call
                try IPoolToken(tokenAddress).addPool(pools[i]) {} catch {}
            }
        }
    }

    /// @dev Configure protections, tax, and enable trading for a newly created token.
    function _configureAndEnableTrading(
        address tokenAddress,
        ProtectionParams calldata protection,
        TaxParams calldata tax,
        bool isTaxable
    ) internal {
        IProtectedToken token = IProtectedToken(tokenAddress);
        token.setExcludedFromLimits(msg.sender, true);
        token.setExcludedFromLimits(address(this), true);

        if (protection.maxWalletAmount > 0) token.setMaxWalletAmount(protection.maxWalletAmount);
        if (protection.maxTransactionAmount > 0) token.setMaxTransactionAmount(protection.maxTransactionAmount);
        if (protection.cooldownSeconds > 0) token.setCooldownTime(protection.cooldownSeconds);

        if (isTaxable && (tax.buyTaxBps > 0 || tax.sellTaxBps > 0 || tax.transferTaxBps > 0)) {
            ITaxableToken taxToken = ITaxableToken(tokenAddress);
            taxToken.setTaxes(tax.buyTaxBps, tax.sellTaxBps, tax.transferTaxBps);
            if (tax.taxWallets.length > 0) {
                taxToken.setTaxDistribution(tax.taxWallets, tax.taxSharesBps);
            }
        }

        token.enableTrading();
    }

    /// @dev Configure protections for launch (excludes launch contract, enables trading).
    function _configureLaunchProtections(
        address tokenAddress,
        address launchAddress,
        ProtectionParams calldata protection,
        TaxParams calldata tax,
        bool isTaxable
    ) internal {
        IProtectedToken token = IProtectedToken(tokenAddress);
        token.setExcludedFromLimits(msg.sender, true);
        token.setExcludedFromLimits(launchAddress, true);

        if (isTaxable) {
            ITaxableToken(tokenAddress).excludeFromTax(launchAddress, true);
        }

        if (protection.maxWalletAmount > 0) token.setMaxWalletAmount(protection.maxWalletAmount);
        if (protection.maxTransactionAmount > 0) token.setMaxTransactionAmount(protection.maxTransactionAmount);
        if (protection.cooldownSeconds > 0) token.setCooldownTime(protection.cooldownSeconds);

        if (isTaxable && (tax.buyTaxBps > 0 || tax.sellTaxBps > 0 || tax.transferTaxBps > 0)) {
            ITaxableToken taxToken = ITaxableToken(tokenAddress);
            taxToken.setTaxes(tax.buyTaxBps, tax.sellTaxBps, tax.transferTaxBps);
            if (tax.taxWallets.length > 0) {
                taxToken.setTaxDistribution(tax.taxWallets, tax.taxSharesBps);
            }
        }

        token.enableTrading();
    }

    /// @dev Refund any excess ETH from this call back to the caller.
    function _refundExcess(uint256 preBalance) internal {
        uint256 excess = address(this).balance > preBalance ? address(this).balance - preBalance : 0;
        if (excess > 0) {
            (bool ok, ) = payable(msg.sender).call{value: excess}("");
            if (!ok) revert NativeTransferFailed();
        }
    }

    // ----------------------------------------------------------------
    // Receive native (for refunds)
    // ----------------------------------------------------------------
    receive() external payable {}
}
