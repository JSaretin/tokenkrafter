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

    // ----------------------------------------------------------------
    // Events
    // ----------------------------------------------------------------
    event TokenCreatedAndLaunched(
        address indexed creator,
        address indexed token,
        address indexed launch
    );

    // ----------------------------------------------------------------
    // State
    // ----------------------------------------------------------------
    ITokenFactory public immutable tokenFactory;
    ILaunchpadFactory public immutable launchpadFactory;

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
    constructor(address tokenFactory_, address launchpadFactory_) {
        if (tokenFactory_ == address(0) || launchpadFactory_ == address(0))
            revert ZeroAddress();

        tokenFactory = ITokenFactory(tokenFactory_);
        launchpadFactory = ILaunchpadFactory(launchpadFactory_);
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
            // Native payment: use the router's remaining balance
            // (original msg.value minus what the token factory kept for fees)
            launchNativeValue = address(this).balance;
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
        _configureProtections(
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

        // 10. Refund any excess native (from launch fee overpayment, etc.)
        uint256 excess = address(this).balance;
        if (excess > 0) {
            (bool ok, ) = payable(msg.sender).call{value: excess}("");
            if (!ok) revert NativeTransferFailed();
        }

        emit TokenCreatedAndLaunched(msg.sender, tokenAddress, launchAddress);
    }

    // ----------------------------------------------------------------
    // Internal helpers
    // ----------------------------------------------------------------
    function _configureProtections(
        address tokenAddress,
        address launchAddress,
        ProtectionParams calldata protection,
        TaxParams calldata tax,
        bool isTaxable
    ) internal {
        IProtectedToken token = IProtectedToken(tokenAddress);

        // Exclude creator and launch contract from limits
        token.setExcludedFromLimits(msg.sender, true);
        token.setExcludedFromLimits(launchAddress, true);

        // Exclude launch contract from tax if token is taxable (has excludeFromTax).
        // Partner-only tokens (type 4, 5) don't implement excludeFromTax and don't
        // need it — partner tax only applies on pool buys/sells, not launch operations.
        if (isTaxable) {
            ITaxableToken(tokenAddress).excludeFromTax(launchAddress, true);
        }

        // Apply protection params if nonzero
        if (protection.maxWalletAmount > 0) {
            token.setMaxWalletAmount(protection.maxWalletAmount);
        }
        if (protection.maxTransactionAmount > 0) {
            token.setMaxTransactionAmount(protection.maxTransactionAmount);
        }
        if (protection.cooldownSeconds > 0) {
            token.setCooldownTime(protection.cooldownSeconds);
        }

        // Apply tax params if taxable and any tax is set
        if (
            isTaxable &&
            (tax.buyTaxBps > 0 ||
                tax.sellTaxBps > 0 ||
                tax.transferTaxBps > 0)
        ) {
            ITaxableToken taxToken = ITaxableToken(tokenAddress);
            taxToken.setTaxes(
                tax.buyTaxBps,
                tax.sellTaxBps,
                tax.transferTaxBps
            );
            if (tax.taxWallets.length > 0) {
                taxToken.setTaxDistribution(
                    tax.taxWallets,
                    tax.taxSharesBps
                );
            }
        }

        // Enable trading
        token.enableTrading();
    }

    // ----------------------------------------------------------------
    // Receive native (for refunds)
    // ----------------------------------------------------------------
    receive() external payable {}
}
