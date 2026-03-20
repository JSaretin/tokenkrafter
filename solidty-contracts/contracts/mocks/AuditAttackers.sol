// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// =============================================================
// INTERFACES (minimal, to avoid circular imports)
// =============================================================

interface ITokenFactoryForAttack {
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

    function createToken(CreateTokenParams calldata p, address referral)
        external payable returns (address);
    function claimReward(address paymentToken) external;
    function pendingRewards(address user, address token) external view returns (uint256);
}

// =============================================================
// C-02: Malicious referrer that consumes all gas on ETH receive
// =============================================================

/// @dev Contract that wastes gas when receiving ETH, to grief referral distribution
contract GasGriefReferrer {
    uint256 public dummy;

    /// @dev Burns ~30M gas in a loop on every ETH receive
    receive() external payable {
        for (uint256 i = 0; i < 100_000; i++) {
            dummy = i;
        }
    }
}

// =============================================================
// C-02: Malicious referrer that reverts on ETH receive
// =============================================================

/// @dev Contract that always reverts when receiving ETH
contract RevertingReferrer {
    receive() external payable {
        revert("I refuse ETH");
    }

    /// @dev Claim pending rewards from the factory (pull pattern)
    function claimRewards(address factory, address paymentToken) external {
        ITokenFactoryForAttack(factory).claimReward(paymentToken);
    }

    /// @dev Allow withdrawing claimed ERC20 tokens
    function withdraw(address token, address to) external {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) IERC20(token).transfer(to, bal);
    }
}

// =============================================================
// C-01: Accomplice contract for refund theft PoC
// =============================================================

/// @dev Simulates an accomplice in the refund attack.
///      Buyer buys tokens, transfers to accomplice, buys back, gets refund.
contract RefundAccomplice {
    function transferTokens(address token, address to, uint256 amount) external {
        IERC20(token).transfer(to, amount);
    }
}

// =============================================================
// H-02: Contract to demonstrate tax-free addresses bypassing protections
// =============================================================

/// @dev Simple holder contract that can transfer tokens
contract TokenHolder {
    function transfer(address token, address to, uint256 amount) external {
        IERC20(token).transfer(to, amount);
    }

    function approve(address token, address spender, uint256 amount) external {
        IERC20(token).approve(spender, amount);
    }
}

// =============================================================
// C-03: Contract to detect reentrancy in processTax
// =============================================================

/// @dev Mock token that tracks reentrancy depth when processTax is called
contract ReentrancyDetector {
    uint256 public maxDepth;
    uint256 public currentDepth;
    address public target;

    constructor(address _target) {
        target = _target;
    }

    function callProcessTax(address token) external {
        currentDepth++;
        if (currentDepth > maxDepth) maxDepth = currentDepth;
        (bool ok, ) = target.call(abi.encodeWithSignature("processTax(address)", token));
        ok; // suppress warning
        currentDepth--;
    }
}
