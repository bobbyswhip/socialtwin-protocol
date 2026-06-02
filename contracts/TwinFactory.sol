// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TwinAccount} from "./TwinAccount.sol";
import {IVerifier} from "./interfaces/IVerifier.sol";

/// @title TwinFactory (v2)
/// @notice Mints deterministic per-Twitch-user smart accounts on Base.
/// @dev    salt = keccak256("SocialTwin:twitch:v2" || uint64(userId))
///         init code embeds (userId, verifier) so the address is fixed by
///         (factory, userId, verifier).
///
/// Holds the `rescuer` role read by every twin for abandoned-funds rescue.
/// The role is permanent (no renounce) but transferable, so it can be handed
/// to a DAO/multisig. It can only ever touch NEVER-ACTIVATED twins after the
/// per-twin RESCUE_DELAY — it can never affect a user who has connected.
contract TwinFactory {
    string internal constant DOMAIN = "SocialTwin:twitch:v2";

    IVerifier public immutable verifier;

    /// @notice Address allowed to call rescueAbandoned() on never-activated
    ///         twins. Renounceable (set to address(0)) to make the entire
    ///         system trustless.
    address public rescuer;

    event TwinDeployed(uint64 indexed userId, address indexed twin);
    event RescuerTransferred(address indexed from, address indexed to);

    error NotRescuer();

    constructor(IVerifier _verifier, address _rescuer) {
        verifier = _verifier;
        rescuer = _rescuer;
        emit RescuerTransferred(address(0), _rescuer);
    }

    function deployTwin(uint64 userId) external returns (address twin) {
        require(userId != 0, "userId 0 not allowed");
        twin = predictAddress(userId);
        if (twin.code.length == 0) {
            bytes32 salt = saltFor(userId);
            TwinAccount deployed = new TwinAccount{salt: salt}(userId, verifier);
            require(address(deployed) == twin, "address mismatch");
            emit TwinDeployed(userId, twin);
        }
    }

    function predictAddress(uint64 userId) public view returns (address) {
        bytes32 salt = saltFor(userId);
        bytes memory bytecode = abi.encodePacked(
            type(TwinAccount).creationCode,
            abi.encode(userId, verifier)
        );
        bytes32 hash = keccak256(
            abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(bytecode))
        );
        return address(uint160(uint256(hash)));
    }

    function isDeployed(uint64 userId) external view returns (bool) {
        return predictAddress(userId).code.length > 0;
    }

    function saltFor(uint64 userId) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(DOMAIN, userId));
    }

    // ─── rescuer administration ───

    /// @notice Hand the rescuer role to a new address (e.g., a DAO/multisig).
    /// @dev    The role is permanent by design (no renounce) — abandoned-funds
    ///         rescue is a retained capability. `newRescuer` must be non-zero
    ///         so the role can never be accidentally destroyed.
    function transferRescuer(address newRescuer) external {
        if (msg.sender != rescuer) revert NotRescuer();
        require(newRescuer != address(0), "rescuer cannot be zero");
        emit RescuerTransferred(rescuer, newRescuer);
        rescuer = newRescuer;
    }
}
