// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IVerifier} from "./interfaces/IVerifier.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title AttestorVerifier
/// @notice IVerifier implementation that accepts ECDSA signatures from any
///         approved attestor. An "attestor" is an off-chain service that has
///         independently verified the user's identity at an IdP (Twitch,
///         Google, Apple, etc.) and signed a binding statement.
///
/// Trust model
/// ───────────
///   1. The IdP (e.g., Twitch) holds the root identity claim.
///   2. The attestor service verifies the IdP's JWT off-chain and signs an
///      ECDSA attestation over (userId, actionHash, oauthExchangeEpoch).
///   3. This contract accepts the attestation if the recovered signer is in
///      the immutable approved set.
///
/// Same trust shape as the Base–Solana bridge guardians or LayerZero DVNs.
/// No on-chain JWT/RSA verification; gas is ~30k per check.
///
/// Federation
/// ──────────
///   The approved-attestor set is fixed at deployment. Multiple attestors
///   are supported simultaneously (1-of-N: any one valid signature is
///   sufficient). To add an attestor, deploy a new AttestorVerifier with
///   the expanded set and migrate users to a new factory pointing at it.
///   N-of-M threshold signatures are NOT implemented here; that requires
///   a separate verifier contract that aggregates multiple signatures.
contract AttestorVerifier is IVerifier {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    string public constant DOMAIN = "SocialTwin:AttestorVerifier:v1";

    /// @notice True for any address in the immutable approved-attestor set.
    mapping(address => bool) public isApproved;
    /// @notice The full set, exposed for transparency.
    address[] public approvedAttestors;

    event AttestorsSet(address[] attestors);

    error NoAttestors();
    error ZeroAddress();
    error DuplicateAttestor(address attestor);
    error BadSignatureLength();
    error UnapprovedSigner(address recovered);

    constructor(address[] memory _attestors) {
        if (_attestors.length == 0) revert NoAttestors();
        for (uint256 i = 0; i < _attestors.length; i++) {
            address a = _attestors[i];
            if (a == address(0)) revert ZeroAddress();
            if (isApproved[a]) revert DuplicateAttestor(a);
            isApproved[a] = true;
            approvedAttestors.push(a);
        }
        emit AttestorsSet(_attestors);
    }

    function attestorCount() external view returns (uint256) {
        return approvedAttestors.length;
    }

    /// @notice IVerifier.verify — accepts a 65-byte ECDSA signature over the
    ///         protocol's canonical digest. The recovered signer must be in
    ///         the approved set.
    function verify(
        uint64 userId,
        bytes32 actionHash,
        uint256 oauthExchangeEpoch,
        bytes calldata proof
    ) external view returns (bool) {
        if (proof.length != 65) revert BadSignatureLength();
        bytes32 digest = computeDigest(userId, actionHash, oauthExchangeEpoch);
        address signer = digest.toEthSignedMessageHash().recover(proof);
        if (!isApproved[signer]) revert UnapprovedSigner(signer);
        return true;
    }

    /// @notice The exact digest the attestor must sign (after EIP-191 prefixing).
    ///         Exposed as a pure helper so adopter frontends and attestor
    ///         services can re-derive identically without copy-pasting the
    ///         encoding.
    function computeDigest(uint64 userId, bytes32 actionHash, uint256 oauthExchangeEpoch)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                DOMAIN,
                block.chainid,
                address(this),
                userId,
                actionHash,
                oauthExchangeEpoch
            )
        );
    }
}
