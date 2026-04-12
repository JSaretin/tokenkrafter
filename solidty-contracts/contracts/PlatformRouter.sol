// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./shared/DexInterfaces.sol";
import "./shared/TokenInterfaces.sol";

interface ITokenFactory {
    struct CreateTokenParams {
        string name;
        string symbol;
        uint256 totalSupply;
        uint8 decimals;
        bool isTaxable;
        bool isMintable;
        bool isPartner;
        address[] bases;
    }

    function routerCreateToken(
        address creator,
        CreateTokenParams calldata p,
        address referral
    ) external returns (address);

    function creationFee(uint8 typeKey) external view returns (uint256);

    function usdt() external view returns (address);
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
        uint256 startTimestamp_,
        uint256 lockDurationAfterListing_,
        uint256 minBuyUsdt_
    ) external returns (address);

    function notifyDeposit(address launch_, uint256 amount) external;

    function launchFee() external view returns (uint256);
}

// DEX interfaces (IUniswapV2Router02, IUniswapV2Factory, IUniswapV2Pair,
// IWETH) come from shared/DexInterfaces.sol.
// Token interfaces (IProtectedToken, ITaxableToken, IOwnableToken) come
// from shared/TokenInterfaces.sol.

address constant DEAD = 0x000000000000000000000000000000000000dEaD;

/// @title PlatformRouter
/// @notice Single user-facing entrypoint for token creation, listing, and
///         launching. Always pays the underlying factories in USDT — when the
///         user wants to pay with another token (or native), the router
///         swaps the input through the DEX first via a caller-supplied
///         `FeePayment.path`. The factories themselves never see anything
///         but USDT, which keeps their fee logic trivial.
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
    error InvalidFeePath();

    // ----------------------------------------------------------------
    // Events
    // ----------------------------------------------------------------
    event TokenCreatedAndLaunched(address indexed creator, address indexed token, address indexed launch);
    event TokenLaunched(address indexed creator, address indexed token, address indexed launch);
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
    address public immutable usdt;

    uint256 public minLiquidity;  // minimum base amount per pool (0 = no minimum)

    // ----------------------------------------------------------------
    // Structs
    // ----------------------------------------------------------------

    /// @notice How the user wants to pay USDT-denominated fees.
    /// @dev    `path[length-1]` MUST equal `usdt`. Three modes:
    ///         - `path == [usdt]` (length 1): direct USDT payment, no swap.
    ///         - `path[0] == address(0)`: native input. The router treats
    ///           this as `[WETH, ..., USDT]` for the swap and uses `msg.value`.
    ///         - otherwise: ERC20 input, router pulls `maxAmountIn` and swaps.
    ///         `maxAmountIn` is ignored for the native and direct-USDT modes.
    struct FeePayment {
        address[] path;
        uint256 maxAmountIn;
    }

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
        uint256[] baseAmounts;
        uint256[] tokenAmounts;
        bool burnLP;
        uint256 tradingDelay;
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
        uint256 startTimestamp;
        uint256 lockDurationAfterListing;
        uint256 minBuyUsdt;
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
        usdt = ITokenFactory(tokenFactory_).usdt();
    }

    // ================================================================
    //  CREATE + LAUNCH (bonding curve)
    // ================================================================

    function createTokenAndLaunch(
        ITokenFactory.CreateTokenParams calldata p,
        LaunchParams calldata launch,
        ProtectionParams calldata protection,
        TaxParams calldata tax,
        FeePayment calldata fee,
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

        // Acquire USDT for both fees in a single swap.
        uint256 creationFee = tokenFactory.creationFee(typeKey);
        uint256 launchFee = launchpadFactory.launchFee();
        _payFee(fee, creationFee + launchFee);

        // Approve each factory for its slice and create.
        IERC20(usdt).forceApprove(address(tokenFactory), creationFee);
        tokenAddress = tokenFactory.routerCreateToken(msg.sender, p, referral);

        IERC20(usdt).forceApprove(address(launchpadFactory), launchFee);
        launchAddress = launchpadFactory.routerCreateLaunch(
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
            launch.startTimestamp,
            launch.lockDurationAfterListing,
            launch.minBuyUsdt
        );

        // Configure protections (router is owner)
        _configureLaunchProtections(tokenAddress, launchAddress, protection, tax, p.isTaxable || p.isPartner);

        // Deposit tokens to launch
        uint256 tokenBal = IERC20(tokenAddress).balanceOf(address(this));
        if (tokenBal > 0) {
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
        FeePayment calldata fee,
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

        uint256 creationFee = tokenFactory.creationFee(typeKey);
        _payFee(fee, creationFee);
        IERC20(usdt).forceApprove(address(tokenFactory), creationFee);

        tokenAddress = tokenFactory.routerCreateToken(msg.sender, p, referral);

        // Exempt router + caller BEFORE seeding. The pool-lock gate would
        // otherwise block the direct-transfer seed because neither side is
        // in isExcludedFromLimits yet.
        {
            IProtectedToken t = IProtectedToken(tokenAddress);
            t.setExcludedFromLimits(msg.sender, true);
            t.setExcludedFromLimits(address(this), true);
        }

        uint256 poolCount = _addLiquidity(tokenAddress, list, preBalance);

        _configureAndEnableTrading(tokenAddress, protection, tax, p.isTaxable || p.isPartner, list.tradingDelay);

        uint256 remaining = IERC20(tokenAddress).balanceOf(address(this));
        if (remaining > 0) IERC20(tokenAddress).safeTransfer(msg.sender, remaining);
        IOwnableToken(tokenAddress).transferOwnership(msg.sender);

        _refundExcess(preBalance);

        emit TokenCreatedAndListed(msg.sender, tokenAddress, poolCount, list.burnLP);
    }

    // ================================================================
    //  CREATE TOKEN ONLY (no listing, no launch)
    // ================================================================

    function createTokenOnly(
        ITokenFactory.CreateTokenParams calldata p,
        ProtectionParams calldata protection,
        TaxParams calldata tax,
        FeePayment calldata fee,
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

        uint256 creationFee = tokenFactory.creationFee(typeKey);
        _payFee(fee, creationFee);
        IERC20(usdt).forceApprove(address(tokenFactory), creationFee);

        tokenAddress = tokenFactory.routerCreateToken(msg.sender, p, referral);

        // No DEX listing here — no anti-snipe window needed.
        _configureAndEnableTrading(tokenAddress, protection, tax, p.isTaxable || p.isPartner, 0);

        uint256 balance = IERC20(tokenAddress).balanceOf(address(this));
        if (balance > 0) IERC20(tokenAddress).safeTransfer(msg.sender, balance);
        IOwnableToken(tokenAddress).transferOwnership(msg.sender);

        _refundExcess(preBalance);

        emit TokenCreated(msg.sender, tokenAddress);
    }

    // ================================================================
    //  LAUNCH EXISTING TOKEN (caller-owned)
    // ================================================================

    /// @notice Launch an already-created token via the launchpad.
    /// @dev Caller MUST `transferOwnership(router)` before calling — the
    ///      router needs ownership to exempt the launch instance, set it
    ///      as authorized launcher, and configure protections. Ownership
    ///      is handed back to msg.sender at the end of the call.
    ///      Restricted to **platform-minted tokens**: the setters invoked
    ///      here (`setExcludedFromLimits`, `setAuthorizedLauncher`,
    ///      `excludeFromTax`) only exist on the TokenKrafter token
    ///      implementations. A vanilla Ownable ERC20 will revert at the
    ///      first unknown-selector call.
    function launchCreatedToken(
        address tokenAddress,
        LaunchParams calldata launch,
        ProtectionParams calldata protection,
        TaxParams calldata tax,
        bool isTaxable,
        FeePayment calldata fee
    )
        external
        payable
        nonReentrant
        whenNotPaused
        returns (address launchAddress)
    {
        if (tokenAddress == address(0)) revert ZeroAddress();
        if (launch.tokensForLaunch == 0) revert TokensForLaunchExceedsSupply();

        uint256 preBalance = address(this).balance - msg.value;

        // Pay launch fee in USDT (router swaps user input first).
        uint256 launchFee = launchpadFactory.launchFee();
        _payFee(fee, launchFee);
        IERC20(usdt).forceApprove(address(launchpadFactory), launchFee);

        // Exempt router + caller BEFORE pulling tokens. The tax exemption
        // on the router is critical for taxable variants: without it, the
        // creator→router pull would be skimmed by `transferTaxBps` and the
        // later deposit into the launch would revert with ERC20 underflow.
        {
            IProtectedToken t = IProtectedToken(tokenAddress);
            t.setExcludedFromLimits(address(this), true);
            t.setExcludedFromLimits(msg.sender, true);
            if (isTaxable) {
                ITaxableToken(tokenAddress).excludeFromTax(address(this), true);
                ITaxableToken(tokenAddress).excludeFromTax(msg.sender, true);
            }
        }

        IERC20(tokenAddress).safeTransferFrom(msg.sender, address(this), launch.tokensForLaunch);

        launchAddress = launchpadFactory.routerCreateLaunch(
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
            launch.startTimestamp,
            launch.lockDurationAfterListing,
            launch.minBuyUsdt
        );

        _configureLaunchProtections(tokenAddress, launchAddress, protection, tax, isTaxable);

        IERC20(tokenAddress).safeTransfer(launchAddress, launch.tokensForLaunch);
        launchpadFactory.notifyDeposit(launchAddress, launch.tokensForLaunch);

        IOwnableToken(tokenAddress).transferOwnership(msg.sender);

        _refundExcess(preBalance);

        emit TokenLaunched(msg.sender, tokenAddress, launchAddress);
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

        uint256 poolCount = _addLiquidity(tokenAddress, list, preBalance);

        uint256 leftover = IERC20(tokenAddress).balanceOf(address(this));
        if (leftover > 0) IERC20(tokenAddress).safeTransfer(msg.sender, leftover);

        _refundExcess(preBalance);

        emit TokenListed(msg.sender, tokenAddress, poolCount, list.burnLP);
    }

    // ================================================================
    //  FEE QUOTING (view)
    // ================================================================

    /// @notice Quote how much of `path[0]` the user needs to cover the
    ///         platform fees for a given token type and flow. Saves the
    ///         frontend from making 3 separate RPC calls (creationFee +
    ///         launchFee + getAmountsIn).
    /// @param typeKey     Token type bitfield (0-7): partner=4|taxable=2|mintable=1
    /// @param withLaunch  true = include LaunchpadFactory.launchFee() on top
    /// @param path        Same shape as FeePayment.path.
    ///                    [usdt] → direct USDT (amountIn == usdtFee).
    ///                    [address(0), usdt] → native input.
    ///                    [erc20, ..., usdt] → ERC20 input.
    /// @return usdtFee    Total USDT fee the factories will charge
    /// @return amountIn   How much of path[0] is needed to produce that USDT
    function quoteFee(
        uint8 typeKey,
        bool withLaunch,
        address[] calldata path
    ) external view returns (uint256 usdtFee, uint256 amountIn) {
        usdtFee = tokenFactory.creationFee(typeKey);
        if (withLaunch) usdtFee += launchpadFactory.launchFee();

        if (usdtFee == 0 || path.length == 0) {
            amountIn = 0;
            return (usdtFee, amountIn);
        }

        // Direct USDT — no swap needed
        if (path.length == 1 || path[path.length - 1] == path[0]) {
            amountIn = usdtFee;
            return (usdtFee, amountIn);
        }

        // Build a quote path: replace address(0) sentinel with WETH
        address[] memory quotePath = new address[](path.length);
        quotePath[0] = path[0] == address(0) ? dexRouter.WETH() : path[0];
        for (uint256 i = 1; i < path.length; i++) quotePath[i] = path[i];

        uint256[] memory amounts = dexRouter.getAmountsIn(usdtFee, quotePath);
        amountIn = amounts[0];
    }

    // ================================================================
    //  ADMIN
    // ================================================================

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    function setMinLiquidity(uint256 amount) external onlyOwner {
        minLiquidity = amount;
    }

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

    /// @dev Acquires at least `usdtNeeded` USDT from the caller's input via
    ///      the DEX. Always validates `path[last] == usdt`. Three modes:
    ///        - `path == [usdt]` (length 1): direct USDT transferFrom.
    ///        - `path[0] == address(0)`: native — entire `msg.value` is
    ///          swapped to USDT via swapExactETHForTokens.
    ///        - otherwise: ERC20 — entire `fee.maxAmountIn` is pulled and
    ///          swapped via swapExactTokensForTokens.
    ///      Surplus USDT (received minus needed) is refunded to msg.sender
    ///      *in USDT*, not in the original input token. This intentionally
    ///      avoids ever sending the input token back: the user always
    ///      ends up holding USDT for any unspent budget, which is what
    ///      they'd convert to anyway. Slippage protection comes from the
    ///      `usdtNeeded` floor — if the swap can't yield that much, it
    ///      reverts.
    function _payFee(FeePayment calldata fee, uint256 usdtNeeded) internal {
        if (usdtNeeded == 0) return;
        uint256 len = fee.path.length;
        if (len == 0) revert InvalidFeePath();
        if (fee.path[len - 1] != usdt) revert InvalidFeePath();

        // Direct USDT — pull exactly what's needed, no surplus.
        if (len == 1) {
            IERC20(usdt).safeTransferFrom(msg.sender, address(this), usdtNeeded);
            return;
        }

        uint256 usdtBefore = IERC20(usdt).balanceOf(address(this));

        if (fee.path[0] == address(0)) {
            // Native input. Uses swapETHForExactTokens so only the BNB
            // needed for `usdtNeeded` is consumed. Any leftover BNB
            // stays in the contract for LP wrapping (createAndList) or
            // gets refunded via _refundExcess at the end of the parent
            // call. This lets users pay fee + seed native LP in one tx.
            address weth = dexRouter.WETH();
            address[] memory swapPath = new address[](len);
            swapPath[0] = weth;
            for (uint256 i = 1; i < len; i++) swapPath[i] = fee.path[i];

            dexRouter.swapETHForExactTokens{value: msg.value}(
                usdtNeeded, swapPath, address(this), block.timestamp
            );
            // No USDT surplus possible — exact-output swap delivers
            // exactly usdtNeeded. Skip the surplus refund below.
            return;
        } else {
            // ERC20 input. Fee-on-transfer safety: use the post-transferFrom
            // balance delta as the real amount we control, not `maxAmountIn`,
            // because the pulled amount may be less if `tokenIn` taxes
            // transfers. Passing `maxAmountIn` to the swap when we hold less
            // would revert with INSUFFICIENT_INPUT_AMOUNT.
            address tokenIn = fee.path[0];
            uint256 balBefore = IERC20(tokenIn).balanceOf(address(this));
            IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), fee.maxAmountIn);
            uint256 amountIn = IERC20(tokenIn).balanceOf(address(this)) - balBefore;
            IERC20(tokenIn).forceApprove(address(dexRouter), amountIn);

            address[] memory swapPath2 = new address[](len);
            for (uint256 i = 0; i < len; i++) swapPath2[i] = fee.path[i];

            dexRouter.swapExactTokensForTokens(
                amountIn, usdtNeeded, swapPath2, address(this), block.timestamp
            );
            IERC20(tokenIn).forceApprove(address(dexRouter), 0);
        }

        // Surplus USDT goes back to the caller in USDT.
        uint256 received = IERC20(usdt).balanceOf(address(this)) - usdtBefore;
        if (received > usdtNeeded) {
            IERC20(usdt).safeTransfer(msg.sender, received - usdtNeeded);
        }
    }

    /// @dev Seed liquidity by transferring both sides directly into the pair
    ///      and calling `pair.mint(recipient)`. Bypasses the router's
    ///      ratio-matching machinery for grifter resistance.
    function _addLiquidity(
        address tokenAddress,
        ListParams calldata list,
        uint256 preBalance
    ) internal returns (uint256 poolCount) {
        IUniswapV2Factory factory = IUniswapV2Factory(dexRouter.factory());
        address weth = dexRouter.WETH();
        poolCount = list.bases.length;
        address lpRecipient = list.burnLP ? DEAD : msg.sender;

        for (uint256 i = 0; i < poolCount; i++) {
            if (minLiquidity > 0 && list.baseAmounts[i] < minLiquidity) revert BelowMinLiquidity();

            address base = list.bases[i];
            uint256 baseAmount = list.baseAmounts[i];
            if (base == address(0)) {
                uint256 ethAvailable = address(this).balance - preBalance;
                uint256 ethToUse = baseAmount > ethAvailable ? ethAvailable : baseAmount;
                IWETH(weth).deposit{value: ethToUse}();
                base = weth;
                baseAmount = ethToUse;
            } else {
                IERC20(base).safeTransferFrom(msg.sender, address(this), baseAmount);
            }

            address pair = factory.getPair(tokenAddress, base);
            if (pair == address(0)) {
                pair = factory.createPair(tokenAddress, base);
            }

            IERC20(tokenAddress).safeTransfer(pair, list.tokenAmounts[i]);
            IERC20(base).safeTransfer(pair, baseAmount);
            uint256 lp = IUniswapV2Pair(pair).mint(lpRecipient);
            if (list.burnLP && lp > 0) emit LiquidityBurned(tokenAddress, pair, lp);
        }
    }

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

        // Tax exemption for router + creator. Critical because this helper
        // runs setTaxes BEFORE the caller site returns leftover supply to
        // the creator; without the router exemption, that return hop
        // would silently skim `transferTaxBps` off the creator's own
        // supply. The creator exemption is a courtesy for any follow-up
        // transfers they make from an otherwise tax-exempt wallet (e.g.
        // funding an LP pair themselves later).
        if (isTaxable) {
            ITaxableToken taxToken = ITaxableToken(tokenAddress);
            taxToken.excludeFromTax(address(this), true);
            taxToken.excludeFromTax(msg.sender, true);
        }

        if (protection.maxWalletAmount > 0) token.setMaxWalletAmount(protection.maxWalletAmount);
        if (protection.maxTransactionAmount > 0) token.setMaxTransactionAmount(protection.maxTransactionAmount);
        if (protection.cooldownSeconds > 0) token.setCooldownTime(protection.cooldownSeconds);

        if (isTaxable) {
            ITaxableToken taxToken = ITaxableToken(tokenAddress);
            if (tax.buyTaxBps > 0 || tax.sellTaxBps > 0 || tax.transferTaxBps > 0) {
                taxToken.setTaxes(tax.buyTaxBps, tax.sellTaxBps, tax.transferTaxBps);
                if (tax.taxWallets.length > 0) {
                    taxToken.setTaxDistribution(tax.taxWallets, tax.taxSharesBps);
                }
            }
            // Lock tax ceiling before enableTrading. enableTrading also does
            // a belt-and-suspenders snapshot, but calling lockTaxCeiling
            // explicitly makes the intent clear and covers the edge case
            // where the creator set taxes to 0/0/0 (enableTrading's snapshot
            // skips zero values, but lockTaxCeiling locks them at zero).
            taxToken.lockTaxCeiling();
        }

        token.enableTrading(tradingDelay);
    }

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
        token.setAuthorizedLauncher(launchAddress, true);

        if (isTaxable) {
            ITaxableToken(tokenAddress).excludeFromTax(launchAddress, true);
        }

        if (protection.maxWalletAmount > 0) token.setMaxWalletAmount(protection.maxWalletAmount);
        if (protection.maxTransactionAmount > 0) token.setMaxTransactionAmount(protection.maxTransactionAmount);
        if (protection.cooldownSeconds > 0) token.setCooldownTime(protection.cooldownSeconds);

        if (isTaxable) {
            ITaxableToken taxToken = ITaxableToken(tokenAddress);
            if (tax.buyTaxBps > 0 || tax.sellTaxBps > 0 || tax.transferTaxBps > 0) {
                taxToken.setTaxes(tax.buyTaxBps, tax.sellTaxBps, tax.transferTaxBps);
                if (tax.taxWallets.length > 0) {
                    taxToken.setTaxDistribution(tax.taxWallets, tax.taxSharesBps);
                }
            }
            // Lock the tax ceiling after setting rates. Once locked, the
            // creator can only lower — never raise above these values.
            // If tax is 0/0/0, the ceiling locks at 0/0/0 — creator can
            // never add tax. The wizard warns about this before submission.
            taxToken.lockTaxCeiling();
        }
    }

    function _refundExcess(uint256 preBalance) internal {
        uint256 excess = address(this).balance > preBalance ? address(this).balance - preBalance : 0;
        if (excess > 0) {
            (bool ok, ) = payable(msg.sender).call{value: excess}("");
            if (!ok) revert NativeTransferFailed();
        }
    }

    receive() external payable {}
}
