// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IVerifier} from "../interfaces/IVerifier.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @notice Test stand-in for the real ZK-TLS verifier (Reclaim or similar).
/// Treats `proof` as an ECDSA signature by `authorizedSigner` over
/// (userId, actionHash, oauthExchangeEpoch). The signer represents the
/// witness network; the signature simulates an attestation that the
/// FRESH OAuth code-exchange + users.me chain in IVerifier's NatSpec
/// completed at `oauthExchangeEpoch`. NOT for mainnet.
contract MockVerifier is IVerifier {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    address public immutable authorizedSigner;

    constructor(address _authorizedSigner) {
        authorizedSigner = _authorizedSigner;
    }

    function verify(
        uint64 userId,
        bytes32 actionHash,
        uint256 oauthExchangeEpoch,
        bytes calldata proof
    ) external view returns (bool) {
        bytes32 digest = keccak256(
            abi.encode("MockVerifier:v2:freshOAuth", userId, actionHash, oauthExchangeEpoch)
        ).toEthSignedMessageHash();
        return digest.recover(proof) == authorizedSigner;
    }
}
