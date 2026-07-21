// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Test-only USD token for the /testnet native-AA demo. Anyone can `drip()`
///         100 tokens to themselves — Base Sepolia only, no value. 6 decimals so it
///         reads like USDC in the UI.
contract DemoUSD is ERC20 {
    constructor() ERC20("Demo USD", "dUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mint 100 dUSD to the caller. Capped per call; unlimited calls (testnet).
    function drip() external {
        _mint(msg.sender, 100_000_000); // 100 * 1e6
    }
}

/// @notice A tip target that pulls tokens via `transferFrom`, so tipping is a real
///         two-call flow (approve → tip). On native AA those two calls batch into one
///         atomic transaction — which is exactly what the demo shows.
contract TipJar {
    event Tipped(address indexed from, address indexed to, address indexed token, uint256 amount);

    function tip(address token, address to, uint256 amount) external {
        require(IERC20(token).transferFrom(msg.sender, to, amount), "transfer failed");
        emit Tipped(msg.sender, to, token, amount);
    }
}
