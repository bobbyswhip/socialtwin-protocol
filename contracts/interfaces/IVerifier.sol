// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IVerifier
/// @notice Verifies a ZK-TLS attestation that PROVES a fresh OAuth 2.0
///         authorization-code exchange just completed for the given user.
///
/// The proof MUST attest to the following sequence, witnessed by the
/// ZK-TLS witness network within a tight time window:
///
///   (A) A successful HTTPS request to twitter.com/i/oauth2/authorize was
///       redeemed for an authorization `code` (implicit — Twitter only
///       issues a `code` after a human clicks "Authorize" on twitter.com).
///   (B) A successful HTTPS request to api.x.com/2/oauth2/token using that
///       `code` returned an `access_token` at attested timestamp
///       `oauthExchangeEpoch`.
///   (C) A successful HTTPS request to api.x.com/2/users/me using that
///       same `access_token` returned `data.id == userId`.
///
/// Implementations MUST reject proofs where (A) is absent, where the
/// `access_token` in (B) differs from the bearer in (C), or where
/// `oauthExchangeEpoch` is not within the witness network's freshness bound.
///
/// This requirement is what prevents an attacker who has acquired a stale
/// OAuth token from minting valid proofs: without a fresh `code` from (A),
/// they cannot satisfy (B), and (C) alone is not sufficient.
interface IVerifier {
    function verify(
        uint64 userId,
        bytes32 actionHash,
        uint256 oauthExchangeEpoch,
        bytes calldata proof
    ) external view returns (bool);
}
