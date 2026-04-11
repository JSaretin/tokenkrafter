// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

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
        uint256 startTimestamp_,
        uint256 lockDurationAfterListing_,
        uint256 minBuyUsdt_
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
    function createPair(address tokenA, address tokenB) external returns (address pair);
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

interface IProtectedToken {
    function enableTrading(uint256 delay) external;
    function setMaxWalletAmount(uint256) external;
    function setMaxTransactionAmount(uint256) external;
    function setCooldownTime(uint256) external;
    function setExcludedFromLimits(address, bool) external;
    function setAuthorizedLauncher(address, bool) external;
}

interface ITaxableToken {
    function setTaxes(uint256, uint256, uint256) external;
    function setTaxDistribution(address[] calldata, uint16[] calldata) external;
    function excludeFromTax(address, bool) external;
}

interface IOwnableToken {
    function transferOwnership(address newOwner) external;
}

// Dead address for burning LP tokens
address constant DEAD = 0x000000000000000000000000000000000000dEaD;

contract PlatformRouter is Ownable, ReentrancyGuard, Pausable {
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
    error BelowMinLiquidity();

    // ----------------------------------------------------------------
    // Events
    // ----------------------------------------------------------------
    event TokenCreatedAndLaunched(address indexed creator, address indexed token, address indexed launch);
    event TokenCreatedAndListed(address indexed creator, address indexed token, uint256 poolCount, bool lpBurned);
    event TokenCreated(address indexed creator, address indexed token);
    event TokenListed(address indexed owner, address indexed token, uint256 poolCount, bool lpBurned);
    event LiquidityBurned(address indexed token, address indexed pair, uint256 lpAmount);

    // ----------------------------------------------------------------
    // State
    // ----------------------------------------------------------------
    ITokenFactory public immutable tokenFactory;
    ILaunchpadFactory public immutable launchpadFactory;
    IUniswapV2Router02 public immutable dexRouter;

    uint256 public minLiquidity;  // minimum base amount per pool (0 = no minimum)

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
        bool burnLP;               // burn LP tokens to dead address
        uint256 tradingDelay;      // seconds between enableTrading() and public trading (anti-snipe)
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
        uint256 lockDurationAfterListing;  // anti-snipe window after graduation
        uint256 minBuyUsdt;                // anti-dust floor, in USDT native units
    }

    // ----------------------------------------------------------------
    // Constructor
    // ----------------------------------------------------------------
    constructor(address tokenFactory_, address launchpadFactory_, address dexRouter_) Ownable(msg.sender) {
        if (tokenFactory_ == address(0) || launchpadFactory_ == address(0) || dexRouter_ == address(0))
            revert ZeroAddress();

        tokenFactory = ITokenFactory(tokenFactory_);
        launchpadFactory = ILaunchpadFactory(launchpadFactory_);
        dexRouter = IUniswapV2Router02(dexRouter_);
    }

    // ================================================================
    //  CREATE + LAUNCH (bonding curve)
    // ================================================================

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
        whenNotPaused
        returns (address tokenAddress, address launchAddress)
    {
        if (launch.tokensForLaunch == 0 || p.totalSupply == 0) revert ZeroAddress();
        uint256 totalSupplyWei = p.totalSupply * 10 ** p.decimals;
        if (launch.tokensForLaunch > totalSupplyWei) revert TokensForLaunchExceedsSupply();

        uint256 preBalance = address(this).balance - msg.value;

        uint8 typeKey = uint8(
            (p.isPartner ? 4 : 0) | (p.isTaxable ? 2 : 0) | (p.isMintable ? 1 : 0)
        );

        // Fee handling
        uint256 totalUsdtFee = tokenFactory.creationFee(typeKey) + launchpadFactory.launchFee();
        uint256 nativeValue;

        if (p.paymentToken == address(0)) {
            nativeValue = msg.value;
        } else {
            uint256 erc20Fee = tokenFactory.convertFee(totalUsdtFee, p.paymentToken);
            if (erc20Fee > 0) {
                IERC20(p.paymentToken).safeTransferFrom(msg.sender, address(this), erc20Fee);
                uint256 factoryFee = tokenFactory.convertFee(tokenFactory.creationFee(typeKey), p.paymentToken);
                IERC20(p.paymentToken).forceApprove(address(tokenFactory), factoryFee);
                uint256 launchFee = erc20Fee - factoryFee;
                IERC20(p.paymentToken).forceApprove(address(launchpadFactory), launchFee);
            }
        }

        // Create token
        uint256 factoryNativeValue = p.paymentToken == address(0) ? nativeValue : 0;
        tokenAddress = tokenFactory.routerCreateToken{value: factoryNativeValue}(
            msg.sender, p, referral
        );

        // Create launch
        uint256 remainingNative = address(this).balance - preBalance;
        launchAddress = launchpadFactory.routerCreateLaunch{value: remainingNative}(
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
            launch.startTimestamp,
            launch.lockDurationAfterListing,
            launch.minBuyUsdt
        );

        // Configure protections (router is owner)
        _configureLaunchProtections(tokenAddress, launchAddress, protection, tax, p.isTaxable || p.isPartner);

        // Deposit tokens to launch
        uint256 tokenBal = IERC20(tokenAddress).balanceOf(address(this));
        if (tokenBal > 0) {
            IERC20(tokenAddress).forceApprove(launchAddress, tokenBal);
            IERC20(tokenAddress).safeTransfer(launchAddress, tokenBal);
            launchpadFactory.notifyDeposit(launchAddress, tokenBal);
        }

        // Transfer ownership to creator
        IOwnableToken(tokenAddress).transferOwnership(msg.sender);

        _refundExcess(preBalance);

        emit TokenCreatedAndLaunched(msg.sender, tokenAddress, launchAddress);
    }

    // ================================================================
    //  CREATE + LIST ON DEX
    // ================================================================

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
        whenNotPaused
        returns (address tokenAddress)
    {
        if (list.bases.length != list.baseAmounts.length || list.bases.length != list.tokenAmounts.length)
            revert ArrayLengthMismatch();

        uint256 preBalance = address(this).balance - msg.value;

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

        // Create token — router receives full supply + ownership
        tokenAddress = tokenFactory.routerCreateToken{value: creationFeeNativeValue}(
            msg.sender, p, referral
        );

        // Add liquidity + configure
        uint256 poolCount = _addLiquidity(tokenAddress, list, preBalance);

        // Configure protections + tax
        _configureAndEnableTrading(tokenAddress, protection, tax, p.isTaxable || p.isPartner, list.tradingDelay);

        // Transfer remaining tokens + ownership to creator
        uint256 remaining = IERC20(tokenAddress).balanceOf(address(this));
        if (remaining > 0) IERC20(tokenAddress).safeTransfer(msg.sender, remaining);
        IOwnableToken(tokenAddress).transferOwnership(msg.sender);

        // Refund excess native
        _refundExcess(preBalance);

        emit TokenCreatedAndListed(msg.sender, tokenAddress, poolCount, list.burnLP);
    }

    // ================================================================
    //  CREATE TOKEN ONLY (no listing, no launch)
    // ================================================================

    /// @notice Create a token with protections and tax in one transaction.
    ///         No liquidity, no launch. Creator receives full supply + ownership.
    function createTokenOnly(
        ITokenFactory.CreateTokenParams calldata p,
        ProtectionParams calldata protection,
        TaxParams calldata tax,
        address referral
    )
        external
        payable
        nonReentrant
        whenNotPaused
        returns (address tokenAddress)
    {
        uint256 preBalance = address(this).balance - msg.value;

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

        tokenAddress = tokenFactory.routerCreateToken{value: creationFeeNativeValue}(
            msg.sender, p, referral
        );

        // No DEX listing here, no pools registered → no anti-snipe window needed.
        _configureAndEnableTrading(tokenAddress, protection, tax, p.isTaxable || p.isPartner, 0);

        uint256 balance = IERC20(tokenAddress).balanceOf(address(this));
        if (balance > 0) IERC20(tokenAddress).safeTransfer(msg.sender, balance);
        IOwnableToken(tokenAddress).transferOwnership(msg.sender);

        _refundExcess(preBalance);

        emit TokenCreated(msg.sender, tokenAddress);
    }

    // ================================================================
    //  ADD LIQUIDITY TO EXISTING TOKEN
    // ================================================================

    /// @notice Add liquidity for an existing token with optional LP burn + pool registration.
    function addLiquidityToExisting(
        address tokenAddress,
        ListParams calldata list
    )
        external
        payable
        nonReentrant
        whenNotPaused
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

        // Add liquidity (handles burn internally)
        uint256 poolCount = _addLiquidity(tokenAddress, list, preBalance);

        // Return any unused tokens
        uint256 leftover = IERC20(tokenAddress).balanceOf(address(this));
        if (leftover > 0) IERC20(tokenAddress).safeTransfer(msg.sender, leftover);

        _refundExcess(preBalance);

        emit TokenListed(msg.sender, tokenAddress, poolCount, list.burnLP);
    }

    // ================================================================
    //  ADMIN
    // ================================================================

    /// @notice Pause all creation/listing. Emergency only.
    function pause() external onlyOwner { _pause(); }

    /// @notice Unpause.
    function unpause() external onlyOwner { _unpause(); }

    /// @notice Set minimum base amount per liquidity pool (0 = no minimum).
    function setMinLiquidity(uint256 amount) external onlyOwner {
        minLiquidity = amount;
    }

    /// @notice Recover tokens accidentally sent to this contract.
    function withdrawStuckTokens(address token) external onlyOwner {
        if (token == address(0)) {
            uint256 bal = address(this).balance;
            if (bal > 0) {
                (bool ok, ) = payable(owner()).call{value: bal}("");
                if (!ok) revert NativeTransferFailed();
            }
        } else {
            uint256 bal = IERC20(token).balanceOf(address(this));
            if (bal > 0) IERC20(token).safeTransfer(owner(), bal);
        }
    }

    // ================================================================
    //  INTERNAL HELPERS
    // ================================================================

    /// @dev Add liquidity to DEX pools. Handles both native and ERC20 bases.
    ///      If list.burnLP is true, LP tokens go to dead address.
    function _addLiquidity(
        address tokenAddress,
        ListParams calldata list,
        uint256 preBalance
    ) internal returns (uint256 poolCount) {
        IUniswapV2Factory factory = IUniswapV2Factory(dexRouter.factory());
        poolCount = list.bases.length;
        address lpRecipient = list.burnLP ? DEAD : msg.sender;
        address[] memory pools = new address[](poolCount);

        for (uint256 i = 0; i < poolCount; i++) {
            // Enforce minimum liquidity
            if (minLiquidity > 0 && list.baseAmounts[i] < minLiquidity) revert BelowMinLiquidity();

            IERC20(tokenAddress).forceApprove(address(dexRouter), list.tokenAmounts[i]);

            if (list.bases[i] == address(0)) {
                uint256 ethAvailable = address(this).balance - preBalance;
                uint256 ethToUse = list.baseAmounts[i] > ethAvailable ? ethAvailable : list.baseAmounts[i];
                (,, uint256 lp) = dexRouter.addLiquidityETH{value: ethToUse}(
                    tokenAddress, list.tokenAmounts[i], 0, 0,
                    lpRecipient, block.timestamp + 300
                );
                pools[i] = factory.getPair(tokenAddress, dexRouter.WETH());
                if (list.burnLP && lp > 0) emit LiquidityBurned(tokenAddress, pools[i], lp);
            } else {
                IERC20(list.bases[i]).safeTransferFrom(msg.sender, address(this), list.baseAmounts[i]);
                IERC20(list.bases[i]).forceApprove(address(dexRouter), list.baseAmounts[i]);
                (,, uint256 lp) = dexRouter.addLiquidity(
                    tokenAddress, list.bases[i],
                    list.tokenAmounts[i], list.baseAmounts[i], 0, 0,
                    lpRecipient, block.timestamp + 300
                );
                pools[i] = factory.getPair(tokenAddress, list.bases[i]);
                if (list.burnLP && lp > 0) emit LiquidityBurned(tokenAddress, pools[i], lp);
            }
        }

        // Pools are already pre-registered in the token at initialize() time
        // via bases[] → factory.createPair, so no post-creation addPool loop is needed.
    }

    /// @dev Configure protections, tax, and enable trading for a newly created token.
    ///      `tradingDelay` is the anti-snipe window (0 = trading opens immediately).
    function _configureAndEnableTrading(
        address tokenAddress,
        ProtectionParams calldata protection,
        TaxParams calldata tax,
        bool isTaxable,
        uint256 tradingDelay
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

        token.enableTrading(tradingDelay);
    }

    /// @dev Configure protections for launch. Does NOT enable trading —
    ///      LaunchInstance.graduate() calls enableTrading(delay) atomically
    ///      when the curve graduates, so the anti-snipe window starts from
    ///      the actual DEX seeding moment, not from token creation.
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
        // Authorize the launch instance to call enableTrading on graduation.
        token.setAuthorizedLauncher(launchAddress, true);

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
    }

    /// @dev Refund any excess ETH back to the caller.
    function _refundExcess(uint256 preBalance) internal {
        uint256 excess = address(this).balance > preBalance ? address(this).balance - preBalance : 0;
        if (excess > 0) {
            (bool ok, ) = payable(msg.sender).call{value: excess}("");
            if (!ok) revert NativeTransferFailed();
        }
    }

    // ----------------------------------------------------------------
    // Receive native (for refunds from DEX router)
    // ----------------------------------------------------------------
    receive() external payable {}
}
