// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ITokenFactoryView {
    struct TokenInfo {
        address creator;
        bool isMintable;
        bool isTaxable;
        bool isPartnership;
    }

    struct DayStats {
        uint256 basic;
        uint256 mintable;
        uint256 taxable;
        uint256 taxMintable;
        uint256 partner;
        uint256 partnerMint;
        uint256 partnerTax;
        uint256 partnerTaxMint;
        uint256 totalTokens;
        uint256 totalFeeUsdt;
    }

    function totalTokensCreated() external view returns (uint256);
    function tokensCreatedByType(uint8) external view returns (uint256);
    function creationFee(uint8) external view returns (uint256);
    function convertFee(uint256, address) external view returns (uint256);
    function getSupportedPaymentTokens() external view returns (address[] memory);
    function tokenInfo(address) external view returns (address creator, bool isMintable, bool isTaxable, bool isPartnership);
    function totalFeeEarnedUsdt() external view returns (uint256);
    function referrals(address) external view returns (address);
    function referralLevels() external view returns (uint8);
    function referralPercents(uint256) external view returns (uint256);
    function totalReferred(address) external view returns (uint256);
    function totalEarned(address, address) external view returns (uint256);
    function pendingRewards(address, address) external view returns (uint256);
    function dailyStats(uint256) external view returns (uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256);
}

interface ILaunchpadFactoryView {
    function totalLaunches() external view returns (uint256);
    function launches(uint256) external view returns (address);
    function launchFee() external view returns (uint256);
    function convertFee(uint256, address) external view returns (uint256);
    function getSupportedPaymentTokens() external view returns (address[] memory);
    function totalLaunchFeeEarnedUsdt() external view returns (uint256);
    function dailyLaunchStats(uint256) external view returns (uint256 created, uint256 graduated, uint256 totalFeeUsdt);
}

interface ILaunchInstance {
    enum LaunchState { Pending, Active, Graduated, Refunding }
    function state() external view returns (LaunchState);
}

contract PlatformLens {
    struct LaunchDayStats {
        uint256 created;
        uint256 graduated;
        uint256 totalFeeUsdt;
    }

    ITokenFactoryView public immutable tokenFactory;
    ILaunchpadFactoryView public immutable launchpadFactory;

    constructor(address _tokenFactory, address _launchpadFactory) {
        tokenFactory = ITokenFactoryView(_tokenFactory);
        launchpadFactory = ILaunchpadFactoryView(_launchpadFactory);
    }

    /// @notice Returns total tokens created and per-type breakdown (8 types).
    function getTokenStats() external view returns (uint256 total, uint256[8] memory byType) {
        total = tokenFactory.totalTokensCreated();
        for (uint8 i = 0; i < 8; i++) {
            byType[i] = tokenFactory.tokensCreatedByType(i);
        }
    }

    /// @notice Returns the creation fee for a given token configuration in all supported payment tokens.
    function getCreationFee(
        bool isTaxable,
        bool isMintable,
        bool isPartner
    ) external view returns (address[] memory tokens, uint256[] memory fees) {
        uint8 typeKey = 0;
        if (isMintable) typeKey |= 1;
        if (isTaxable) typeKey |= 2;
        if (isPartner) typeKey |= 4;

        uint256 baseFee = tokenFactory.creationFee(typeKey);
        tokens = tokenFactory.getSupportedPaymentTokens();
        fees = new uint256[](tokens.length);

        for (uint256 i = 0; i < tokens.length; i++) {
            fees[i] = tokenFactory.convertFee(baseFee, tokens[i]);
        }
    }

    /// @notice Returns the launch fee denominated in the given payment token.
    function getLaunchFee(address paymentToken) external view returns (uint256) {
        uint256 baseFee = launchpadFactory.launchFee();
        if (baseFee == 0) return 0;
        return launchpadFactory.convertFee(baseFee, paymentToken);
    }

    /// @notice Returns a paginated list of active/pending launches.
    function getActiveLaunches(
        uint256 offset,
        uint256 limit
    ) external view returns (address[] memory result, uint256 total) {
        uint256 numLaunches = launchpadFactory.totalLaunches();

        // First pass: count active/pending launches
        uint256 activeCount = 0;
        for (uint256 i = 0; i < numLaunches; i++) {
            address launch = launchpadFactory.launches(i);
            ILaunchInstance.LaunchState s = ILaunchInstance(launch).state();
            if (s == ILaunchInstance.LaunchState.Active || s == ILaunchInstance.LaunchState.Pending) {
                activeCount++;
            }
        }

        total = activeCount;

        if (offset >= activeCount) {
            result = new address[](0);
            return (result, total);
        }

        uint256 remaining = activeCount - offset;
        uint256 count = remaining < limit ? remaining : limit;
        result = new address[](count);

        // Second pass: fill the result array
        uint256 seen = 0;
        uint256 filled = 0;
        for (uint256 i = 0; i < numLaunches && filled < count; i++) {
            address launch = launchpadFactory.launches(i);
            ILaunchInstance.LaunchState s = ILaunchInstance(launch).state();
            if (s == ILaunchInstance.LaunchState.Active || s == ILaunchInstance.LaunchState.Pending) {
                if (seen >= offset) {
                    result[filled] = launch;
                    filled++;
                }
                seen++;
            }
        }
    }

    /// @notice Returns token factory daily stats for a day range [fromDay, toDay].
    function getTokenDailyStats(
        uint256 fromDay,
        uint256 toDay
    ) external view returns (ITokenFactoryView.DayStats[] memory) {
        require(toDay >= fromDay, "invalid range");
        uint256 count = toDay - fromDay + 1;
        require(count <= 365, "max 365 days");

        ITokenFactoryView.DayStats[] memory stats = new ITokenFactoryView.DayStats[](count);

        for (uint256 i = 0; i < count; i++) {
            (
                uint256 basic,
                uint256 mintable,
                uint256 taxable,
                uint256 taxMintable,
                uint256 partner,
                uint256 partnerMint,
                uint256 partnerTax,
                uint256 partnerTaxMint,
                uint256 totalTokens,
                uint256 totalFeeUsdt
            ) = tokenFactory.dailyStats(fromDay + i);

            stats[i] = ITokenFactoryView.DayStats({
                basic: basic,
                mintable: mintable,
                taxable: taxable,
                taxMintable: taxMintable,
                partner: partner,
                partnerMint: partnerMint,
                partnerTax: partnerTax,
                partnerTaxMint: partnerTaxMint,
                totalTokens: totalTokens,
                totalFeeUsdt: totalFeeUsdt
            });
        }

        return stats;
    }

    /// @notice Returns launchpad factory daily stats for a day range [fromDay, toDay].
    function getLaunchDailyStats(
        uint256 fromDay,
        uint256 toDay
    ) external view returns (LaunchDayStats[] memory) {
        require(toDay >= fromDay, "invalid range");
        uint256 count = toDay - fromDay + 1;
        require(count <= 365, "max 365 days");

        LaunchDayStats[] memory stats = new LaunchDayStats[](count);

        for (uint256 i = 0; i < count; i++) {
            (uint256 created, uint256 graduated, uint256 totalFeeUsdt) =
                launchpadFactory.dailyLaunchStats(fromDay + i);

            stats[i] = LaunchDayStats({
                created: created,
                graduated: graduated,
                totalFeeUsdt: totalFeeUsdt
            });
        }

        return stats;
    }

    /// @notice Returns referral stats for a referrer across multiple payment tokens.
    function getReferralStats(
        address referrer,
        address[] calldata paymentTokens
    )
        external
        view
        returns (
            uint256 referred,
            uint256[] memory earned,
            uint256[] memory pending
        )
    {
        referred = tokenFactory.totalReferred(referrer);
        earned = new uint256[](paymentTokens.length);
        pending = new uint256[](paymentTokens.length);

        for (uint256 i = 0; i < paymentTokens.length; i++) {
            earned[i] = tokenFactory.totalEarned(referrer, paymentTokens[i]);
            pending[i] = tokenFactory.pendingRewards(referrer, paymentTokens[i]);
        }
    }

    /// @notice Walks the referral chain upward from a user, up to referralLevels deep.
    function getReferralChain(address user) external view returns (address[] memory chain) {
        uint8 levels = tokenFactory.referralLevels();
        address[] memory temp = new address[](levels);
        uint256 length = 0;
        address current = user;

        for (uint8 i = 0; i < levels; i++) {
            address referrer = tokenFactory.referrals(current);
            if (referrer == address(0)) break;
            temp[length] = referrer;
            length++;
            current = referrer;
        }

        chain = new address[](length);
        for (uint256 i = 0; i < length; i++) {
            chain[i] = temp[i];
        }
    }

    /// @notice Returns all referral level percentages.
    function getReferralPercents() external view returns (uint256[] memory) {
        uint8 levels = tokenFactory.referralLevels();
        uint256[] memory percents = new uint256[](levels);

        for (uint256 i = 0; i < levels; i++) {
            percents[i] = tokenFactory.referralPercents(i);
        }

        return percents;
    }

    /// @notice Returns aggregate platform stats across both factories.
    function getPlatformStats()
        external
        view
        returns (
            uint256 totalTokens,
            uint256 totalLaunches,
            uint256 totalTokenFeeUsdt,
            uint256 totalLaunchFeeUsdt
        )
    {
        totalTokens = tokenFactory.totalTokensCreated();
        totalLaunches = launchpadFactory.totalLaunches();
        totalTokenFeeUsdt = tokenFactory.totalFeeEarnedUsdt();
        totalLaunchFeeUsdt = launchpadFactory.totalLaunchFeeEarnedUsdt();
    }
}
