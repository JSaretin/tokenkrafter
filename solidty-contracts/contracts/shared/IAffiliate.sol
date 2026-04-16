// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IAffiliate
 * @notice Minimum surface revenue contracts need to integrate with the
 *         shared Affiliate program. Reporters must be authorized via
 *         {Affiliate.setAuthorized} before {report} calls succeed.
 */
interface IAffiliate {
    /**
     * @notice Credit affiliate earnings for a user's paid action.
     * @param user        End user who paid the platform fee.
     * @param ref         Proposed referrer (ignored if user already bound).
     * @param platformFee Net platform fee in USDT, with third-party costs
     *                    already subtracted by the reporter.
     */
    function report(address user, address ref, uint256 platformFee) external;

    /// @notice Whitelist/de-whitelist a reporter. Callable by owner or
    ///         authorized factory.
    function setAuthorized(address reporter, bool enabled) external;
}
