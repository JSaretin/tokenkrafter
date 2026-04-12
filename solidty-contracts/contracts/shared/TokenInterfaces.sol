// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title TokenInterfaces
/// @notice Cross-cutting interfaces for the token implementations and the
///         contracts that consume them. Single source of truth — consolidates
///         declarations that previously lived inline in TokenImplementations.sol
///         and PlatformRouter.sol so they cannot drift.
///
///         Each token variant lives in its own file under contracts/tokens/.
///         These interfaces describe the externally-callable surface of those
///         tokens (and the factory's processTax callback that taxable variants
///         invoke). Auditors can read this file alone to understand what every
///         contract that talks to a token is allowed to call.

/// @notice Unified initializer for every token variant. Pools for the
///         supplied `bases` are created and registered at init time; the
///         pool-lock gate in `_update` relies on that list being authoritative.
interface IToken {
    function initialize(
        string calldata name,
        string calldata symbol,
        uint256 totalSupply,
        uint8 decimals,
        address creator,
        address factory,
        address dexFactory,
        address[] calldata bases
    ) external;
}

/// @notice Tax-processing callback. PartnerTokenImpl and PartnerTaxableTokenImpl
///         call this on the factory after every pool interaction so the factory
///         can swap accumulated tax tokens to USDT.
///         Distinct from PlatformRouter's local `ITokenFactory` (which describes
///         the routerCreateToken / convertFee surface) — these two interfaces
///         serve opposite directions of the token↔factory relationship.
interface ITokenFactoryTaxCallback {
    function processTax(address token) external;
}

/// @notice Standard OZ-style ownership transfer. Used by TokenFactory and
///         PlatformRouter to reassign token ownership during the
///         routerCreateToken flow.
interface IOwnableToken {
    function transferOwnership(address newOwner) external;
}

/// @notice The protection-management surface every token variant exposes.
///         Includes the pool-lock controls (enableTrading, addPool variants,
///         setAuthorizedLauncher), classic owner knobs (max wallet/tx,
///         cooldown), and the exclusion list. PlatformRouter calls these
///         to configure a freshly-deployed token before handing it back to
///         the creator.
interface IProtectedToken {
    function enableTrading(uint256 delay) external;
    function setMaxWalletAmount(uint256 amount) external;
    function setMaxTransactionAmount(uint256 amount) external;
    function setCooldownTime(uint256 _seconds) external;
    function setExcludedFromLimits(address account, bool excluded) external;
    function setAuthorizedLauncher(address launcher, bool authorized) external;
    function addPool(address base) external;
    function addPoolByAddress(address pool) external;
}

/// @notice Tax configuration surface for taxable variants. Caps and
///         distribution rules are enforced inside the implementations.
interface ITaxableToken {
    function setTaxes(uint256 buyTaxBps, uint256 sellTaxBps, uint256 transferTaxBps) external;
    function setTaxDistribution(address[] calldata wallets, uint16[] calldata sharesBps) external;
    function excludeFromTax(address account, bool exempt) external;
    function lockTaxCeiling() external;
    function unlockTaxCeiling() external;
}
