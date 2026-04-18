// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title LaunchPreflight
 * @notice Constructor-only simulator — never deployed. Returns a diagnostic
 *         report about a token's suitability for the launchpad so the
 *         frontend can block launch creation for unsafe tokens before the
 *         creator wastes gas on failed deposits.
 *
 * @dev `testFrom` must hold `testAmount` of the token AND have approved
 *      this constructor address for `testAmount` before the call — only
 *      then can the fee-on-transfer probe run. If unavailable, pass
 *      (address(0), 0) and the probe is skipped (still detects platform
 *      hooks + common tax patterns + ownership).
 */

interface IERC20Lite {
    function balanceOf(address) external view returns (uint256);
    function transferFrom(address, address, uint256) external returns (bool);
    function totalSupply() external view returns (uint256);
    function decimals() external view returns (uint8);
}

interface ILaunchTokenHooks {
    function isExcludedFromLimits(address) external view returns (bool);
    function isTaxFree(address) external view returns (bool);
    function isAuthorizedLauncher(address) external view returns (bool);
}

interface ITaxableHooks {
    function buyTaxBps() external view returns (uint16);
    function sellTaxBps() external view returns (uint16);
    function transferTaxBps() external view returns (uint16);
    function taxCeilingLocked() external view returns (bool);
}

interface IOwnable {
    function owner() external view returns (address);
}

contract LaunchPreflight {

    struct Report {
        bool supportsIsExcludedFromLimits;
        bool supportsIsTaxFree;
        bool supportsIsAuthorizedLauncher;

        bool excludedFromLimits;
        bool taxFree;
        bool authorizedLauncher;

        bool hasKrafterTaxInterface;
        uint16 buyTaxBps;
        uint16 sellTaxBps;
        uint16 transferTaxBps;
        bool taxCeilingLocked;

        bool feeOnTransferProbeRan;
        bool feeOnTransferDetected;
        uint256 expectedReceived;
        uint256 actualReceived;

        address owner;
        bool isRenounced;

        uint256 totalSupply;
        uint8 decimals;
        uint256 creatorBalance;

        bool safeForPlatformTokenRules;
        bool safeForExternalToken;
        string blockedReason;
    }

    constructor(
        address token,
        address predictedLaunch,
        address testFrom,
        uint256 testAmount
    ) payable {
        Report memory r;

        try IERC20Lite(token).totalSupply() returns (uint256 ts) { r.totalSupply = ts; } catch {}
        try IERC20Lite(token).decimals() returns (uint8 d) { r.decimals = d; } catch { r.decimals = 18; }
        if (testFrom != address(0)) {
            try IERC20Lite(token).balanceOf(testFrom) returns (uint256 b) { r.creatorBalance = b; } catch {}
        }

        try ILaunchTokenHooks(token).isExcludedFromLimits(predictedLaunch) returns (bool v) {
            r.supportsIsExcludedFromLimits = true;
            r.excludedFromLimits = v;
        } catch {}

        try ILaunchTokenHooks(token).isTaxFree(predictedLaunch) returns (bool v) {
            r.supportsIsTaxFree = true;
            r.taxFree = v;
        } catch {}

        try ILaunchTokenHooks(token).isAuthorizedLauncher(predictedLaunch) returns (bool v) {
            r.supportsIsAuthorizedLauncher = true;
            r.authorizedLauncher = v;
        } catch {}

        bool hasAny;
        try ITaxableHooks(token).buyTaxBps() returns (uint16 v) { r.buyTaxBps = v; hasAny = true; } catch {}
        try ITaxableHooks(token).sellTaxBps() returns (uint16 v) { r.sellTaxBps = v; hasAny = true; } catch {}
        try ITaxableHooks(token).transferTaxBps() returns (uint16 v) { r.transferTaxBps = v; hasAny = true; } catch {}
        try ITaxableHooks(token).taxCeilingLocked() returns (bool v) { r.taxCeilingLocked = v; hasAny = true; } catch {}
        r.hasKrafterTaxInterface = hasAny;

        try IOwnable(token).owner() returns (address o) {
            r.owner = o;
            r.isRenounced = o == address(0) || o == address(0xdead);
        } catch {}

        // Fee-on-transfer probe — state rolls back at end of constructor.
        if (testFrom != address(0) && testAmount > 0 && r.creatorBalance >= testAmount) {
            uint256 balBefore = IERC20Lite(token).balanceOf(address(this));
            try IERC20Lite(token).transferFrom(testFrom, address(this), testAmount) returns (bool ok) {
                if (ok) {
                    uint256 balAfter = IERC20Lite(token).balanceOf(address(this));
                    uint256 received = balAfter - balBefore;
                    r.feeOnTransferProbeRan = true;
                    r.expectedReceived = testAmount;
                    r.actualReceived = received;
                    r.feeOnTransferDetected = received != testAmount;
                }
            } catch {}
        }

        r.safeForPlatformTokenRules =
            r.supportsIsExcludedFromLimits && r.excludedFromLimits &&
            r.supportsIsTaxFree && r.taxFree &&
            r.supportsIsAuthorizedLauncher && r.authorizedLauncher;

        bool noPlatformHooks =
            !r.supportsIsExcludedFromLimits &&
            !r.supportsIsTaxFree &&
            !r.supportsIsAuthorizedLauncher;
        r.safeForExternalToken = noPlatformHooks &&
            (!r.feeOnTransferProbeRan || !r.feeOnTransferDetected);

        if (r.feeOnTransferProbeRan && r.feeOnTransferDetected) {
            r.blockedReason = "FEE_ON_TRANSFER";
        } else if (r.supportsIsExcludedFromLimits && !r.excludedFromLimits) {
            r.blockedReason = "NOT_EXCLUDED_FROM_LIMITS";
        } else if (r.supportsIsTaxFree && !r.taxFree) {
            r.blockedReason = "NOT_TAX_FREE";
        } else if (r.supportsIsAuthorizedLauncher && !r.authorizedLauncher) {
            r.blockedReason = "NOT_AUTHORIZED_LAUNCHER";
        }

        bytes memory encoded = abi.encode(r);
        assembly {
            return(add(encoded, 32), mload(encoded))
        }
    }
}
