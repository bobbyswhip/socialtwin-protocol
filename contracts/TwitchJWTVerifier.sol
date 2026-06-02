// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IVerifier} from "./interfaces/IVerifier.sol";

/// @title TwitchJWTVerifier
/// @notice Verifies a Twitch OpenID Connect id_token entirely on-chain.
///
/// The id_token is an RS256-signed JWT issued by id.twitch.tv. We verify
/// the RSA signature using the modexp precompile against Twitch's published
/// public key(s), then parse the payload to extract:
///   • sub      — Twitch numeric user_id, must equal `userId` argument
///   • iat      — issued-at timestamp, must equal `oauthExchangeEpoch`
///   • nonce    — hex-encoded action_hash (the binding mechanism)
///   • iss      — must equal "https://id.twitch.tv/oauth2"
///
/// Bound to action_hash via the OAuth `nonce` parameter (OIDC spec §3.1.2.1).
/// The client sets nonce = hex(action_hash) in the authorize URL; Twitch
/// echoes it into the signed id_token; this contract checks it matches.
///
/// Trust roots: Twitch's RSA private key, Base sequencer, EVM precompile.
/// NO witness network. NO TEE. NO external protocol.
///
/// Source of Twitch JWKS: https://id.twitch.tv/oauth2/keys
contract TwitchJWTVerifier is IVerifier {
    bytes constant ISSUER = bytes("https://id.twitch.tv/oauth2");
    uint256 constant PUBLIC_EXPONENT = 65537; // Twitch uses e=AQAB

    /// @notice Twitch signs with multiple keys at once (smooth rotation). We
    ///         accept any of the moduli baked in at construction; new keys
    ///         require a redeploy.
    /// @dev Each modulus must be 256 bytes (RSA-2048). We index by `kid`
    ///      string so the JWT header's kid selects which one to use.
    mapping(bytes32 => bytes) public modulusOf;
    bytes32[] public registeredKids;

    /// @notice Curated, MUTABLE allowlist of acceptable `aud` claims (Twitch
    ///         OAuth client_ids). A JWT is only accepted if its `aud` is one of
    ///         these. Anti-phishing control: a malicious site must use its OWN
    ///         Twitch app (different client_id → different aud → rejected), and
    ///         it can't obtain a token for an allowlisted client_id because that
    ///         app's redirect URL points at the legit domain, not the attacker.
    /// @dev    Managed by `audAdmin` (set to the treasury/multisig). The admin
    ///         can add/remove approved apps but CANNOT move funds; a compromised
    ///         admin could re-enable phishing by allowlisting a malicious app,
    ///         so the key must be treated as sensitive (treasury/multisig).
    mapping(bytes32 => bool) public allowedAud;
    string[] public registeredAuds;
    address public audAdmin;

    /// @notice When false, the aud allowlist is NOT enforced — any app's JWT is
    ///         accepted (fully permissionless, like a wallet that signs for any
    ///         dapp). Lets the protocol "graduate" to full decentralization.
    ///         Defaults to true (allowlist enforced). Toggle via audAdmin; or
    ///         disable PERMANENTLY (and drop the admin) via lockOpenForever().
    bool public audCheckEnabled = true;

    event AudAdded(string aud);
    event AudRemoved(string aud);
    event AudAdminTransferred(address indexed from, address indexed to);
    event AudCheckSet(bool enabled);
    event LockedOpenForever();

    error UnknownKey();
    error BadSignature();
    error BadJwtShape();
    error WrongIssuer();
    error WrongSub();
    error WrongIat();
    error WrongNonce();
    error WrongAlgorithm();
    error WrongAudience();
    error ParseFailed();
    error NotAudAdmin();

    /// @param kids     list of Twitch JWT key ids (e.g., ["1"])
    /// @param moduli   matching 256-byte RSA moduli for each kid
    /// @param auds     initial allowlisted OAuth client_ids (the `aud` claim); non-empty
    /// @param _audAdmin address allowed to add/remove auds (treasury/multisig); non-zero
    constructor(string[] memory kids, bytes[] memory moduli, string[] memory auds, address _audAdmin) {
        require(kids.length == moduli.length && kids.length > 0, "kids/moduli mismatch");
        require(auds.length > 0, "need >=1 aud");
        require(_audAdmin != address(0), "audAdmin zero");
        for (uint256 i = 0; i < kids.length; i++) {
            require(moduli[i].length == 256, "modulus must be 256 bytes (RSA-2048)");
            bytes32 k = keccak256(bytes(kids[i]));
            modulusOf[k] = moduli[i];
            registeredKids.push(k);
        }
        for (uint256 i = 0; i < auds.length; i++) _addAud(auds[i]);
        audAdmin = _audAdmin;
        emit AudAdminTransferred(address(0), _audAdmin);
    }

    // ─────────── aud allowlist administration ───────────

    modifier onlyAudAdmin() {
        if (msg.sender != audAdmin) revert NotAudAdmin();
        _;
    }

    function addAud(string calldata aud) external onlyAudAdmin {
        _addAud(aud);
    }

    function _addAud(string memory aud) internal {
        require(bytes(aud).length > 0, "empty aud");
        bytes32 h = keccak256(bytes(aud));
        if (!allowedAud[h]) {
            allowedAud[h] = true;
            registeredAuds.push(aud);
            emit AudAdded(aud);
        }
    }

    function removeAud(string calldata aud) external onlyAudAdmin {
        bytes32 h = keccak256(bytes(aud));
        require(allowedAud[h], "not allowlisted");
        allowedAud[h] = false;
        // swap-pop from the transparency array
        uint256 n = registeredAuds.length;
        for (uint256 i = 0; i < n; i++) {
            if (keccak256(bytes(registeredAuds[i])) == h) {
                registeredAuds[i] = registeredAuds[n - 1];
                registeredAuds.pop();
                break;
            }
        }
        emit AudRemoved(aud);
    }

    /// @notice Hand aud-admin to a new address (e.g., a DAO/multisig). Non-zero.
    function transferAudAdmin(address newAdmin) external onlyAudAdmin {
        require(newAdmin != address(0), "zero");
        emit AudAdminTransferred(audAdmin, newAdmin);
        audAdmin = newAdmin;
    }

    /// @notice Turn the aud allowlist on/off. Off = any app's JWT accepted
    ///         (open/permissionless). Reversible.
    function setAudCheckEnabled(bool enabled) external onlyAudAdmin {
        audCheckEnabled = enabled;
        emit AudCheckSet(enabled);
    }

    /// @notice PERMANENTLY disable the aud allowlist and renounce the admin.
    ///         Irreversible: after this the verifier accepts any app's JWT
    ///         forever and has no privileged role — full decentralization.
    function lockOpenForever() external onlyAudAdmin {
        audCheckEnabled = false;
        emit AudCheckSet(false);
        emit AudAdminTransferred(audAdmin, address(0));
        audAdmin = address(0);
        emit LockedOpenForever();
    }

    function audCount() external view returns (uint256) {
        return registeredAuds.length;
    }

    // ─────────── IVerifier ───────────

    function verify(
        uint64 userId,
        bytes32 actionHash,
        uint256 oauthExchangeEpoch,
        bytes calldata proof
    ) external view returns (bool) {
        // `proof` is the raw JWT bytes: header.payload.signature (base64url segments).
        (bytes calldata headerB64, bytes calldata payloadB64, bytes calldata sigB64) = _splitJwt(proof);

        // 1. RSA signature: verify SHA-256("header.payload") matches sig^e mod n.
        bytes memory header = _base64UrlDecode(headerB64);
        bytes memory payload = _base64UrlDecode(payloadB64);
        bytes memory sig = _base64UrlDecode(sigB64);

        bytes memory modulus = _resolveModulusByKid(header);
        bytes32 msgHash = sha256(abi.encodePacked(headerB64, ".", payloadB64));
        if (!_rsaPkcs1v15Sha256Verify(msgHash, sig, modulus)) revert BadSignature();

        // 2. Payload claims.
        _requireClaimEquals(payload, '"iss":"', ISSUER);

        // aud must be an allowlisted client_id (anti-phishing). Twitch sends
        // aud as a single string; an array form ("aud":[...]) won't match the
        // needle and is rejected, which is the safe default.
        if (audCheckEnabled) {
            bytes memory audBytes = _extractStringClaim(payload, '"aud":"');
            if (audBytes.length == 0 || !allowedAud[keccak256(audBytes)]) revert WrongAudience();
        }

        // sub is a JSON STRING containing decimal digits.
        bytes memory subBytes = _extractStringClaim(payload, '"sub":"');
        if (subBytes.length == 0 || _parseDecimal(subBytes) != userId) revert WrongSub();

        // iat is a JSON NUMBER.
        uint256 iat = _extractNumberClaim(payload, '"iat":');
        if (iat != oauthExchangeEpoch) revert WrongIat();

        // nonce is hex(action_hash) — 66 chars "0x..." — set by the client in the OAuth URL.
        bytes memory nonceBytes = _extractStringClaim(payload, '"nonce":"');
        if (!_eq(nonceBytes, _bytes32ToHexString(actionHash))) revert WrongNonce();

        return true;
    }

    // ─────────── JWT parsing ───────────

    function _splitJwt(bytes calldata jwt)
        internal
        pure
        returns (bytes calldata, bytes calldata, bytes calldata)
    {
        uint256 firstDot = type(uint256).max;
        uint256 secondDot = type(uint256).max;
        for (uint256 i = 0; i < jwt.length; i++) {
            if (jwt[i] == 0x2e) {
                if (firstDot == type(uint256).max) firstDot = i;
                else { secondDot = i; break; }
            }
        }
        if (firstDot == type(uint256).max || secondDot == type(uint256).max) revert BadJwtShape();
        return (jwt[0:firstDot], jwt[firstDot + 1:secondDot], jwt[secondDot + 1:]);
    }

    function _resolveModulusByKid(bytes memory header) internal view returns (bytes memory) {
        // Header is JSON: {"alg":"RS256","kid":"1","typ":"JWT"}
        bytes memory alg = _extractStringClaim(header, '"alg":"');
        bytes32 RS256 = keccak256("RS256");
        if (keccak256(alg) != RS256) revert WrongAlgorithm();

        bytes memory kid = _extractStringClaim(header, '"kid":"');
        bytes32 k = keccak256(kid);
        bytes memory mod = modulusOf[k];
        if (mod.length == 0) revert UnknownKey();
        return mod;
    }

    function _requireClaimEquals(bytes memory payload, bytes memory needle, bytes memory expected) internal pure {
        bytes memory actual = _extractStringClaim(payload, needle);
        if (!_eq(actual, expected)) revert WrongIssuer();
    }

    /// Extract a JSON string claim. Caller supplies the prefix including the
    /// opening quote, e.g. `"sub":"`. Returns the bytes between that and the
    /// next unescaped quote. Returns empty if not found.
    function _extractStringClaim(bytes memory hay, bytes memory needle) internal pure returns (bytes memory) {
        int256 start = _indexOf(hay, needle);
        if (start < 0) return new bytes(0);
        uint256 valueStart = uint256(start) + needle.length;
        uint256 end = valueStart;
        while (end < hay.length && hay[end] != 0x22) end++; // 0x22 = '"'
        bytes memory out = new bytes(end - valueStart);
        for (uint256 i = 0; i < out.length; i++) out[i] = hay[valueStart + i];
        return out;
    }

    /// Extract a JSON number claim, given a prefix without quotes, e.g. `"iat":`.
    function _extractNumberClaim(bytes memory hay, bytes memory needle) internal pure returns (uint256) {
        int256 start = _indexOf(hay, needle);
        if (start < 0) return 0;
        uint256 i = uint256(start) + needle.length;
        uint256 acc = 0;
        bool found = false;
        while (i < hay.length) {
            uint8 c = uint8(hay[i]);
            if (c >= 0x30 && c <= 0x39) {
                acc = acc * 10 + (c - 0x30);
                found = true;
                i++;
            } else if (!found && (c == 0x20 || c == 0x09)) {
                i++; // skip whitespace
            } else {
                break;
            }
        }
        return acc;
    }

    function _indexOf(bytes memory hay, bytes memory needle) internal pure returns (int256) {
        if (needle.length == 0 || needle.length > hay.length) return -1;
        for (uint256 i = 0; i <= hay.length - needle.length; i++) {
            bool match_ = true;
            for (uint256 j = 0; j < needle.length; j++) {
                if (hay[i + j] != needle[j]) { match_ = false; break; }
            }
            if (match_) return int256(i);
        }
        return -1;
    }

    function _parseDecimal(bytes memory s) internal pure returns (uint256 v) {
        if (s.length == 0) revert ParseFailed();
        for (uint256 i = 0; i < s.length; i++) {
            uint8 c = uint8(s[i]);
            if (c < 0x30 || c > 0x39) revert ParseFailed();
            v = v * 10 + (c - 0x30);
        }
    }

    // ─────────── RSA-2048 PKCS#1 v1.5 with SHA-256 ───────────

    /// Compute sig^e mod n using the modexp precompile, then check the result
    /// matches the PKCS#1 v1.5 padding of SHA-256(msg).
    function _rsaPkcs1v15Sha256Verify(bytes32 msgHash, bytes memory sig, bytes memory mod) internal view returns (bool) {
        if (sig.length != 256 || mod.length != 256) return false;
        bytes memory exp = abi.encodePacked(uint24(0x010001)); // 65537 in 3 bytes
        bytes memory decoded = _modexp(sig, exp, mod);
        if (decoded.length != 256) return false;

        // Expected PKCS#1 v1.5 padded form for RSA-2048 + SHA-256:
        //   0x00 0x01 (0xFF × 202) 0x00 (DigestInfo: 19 bytes) (Hash: 32 bytes)
        // DigestInfo for SHA-256:
        //   30 31 30 0D 06 09 60 86 48 01 65 03 04 02 01 05 00 04 20
        if (decoded[0] != 0x00 || decoded[1] != 0x01) return false;
        for (uint256 i = 2; i < 204; i++) if (decoded[i] != 0xFF) return false;
        if (decoded[204] != 0x00) return false;

        bytes19 expectedDigestInfo = 0x3031300D060960864801650304020105000420;
        for (uint256 i = 0; i < 19; i++) if (decoded[205 + i] != expectedDigestInfo[i]) return false;
        for (uint256 i = 0; i < 32; i++) if (decoded[224 + i] != msgHash[i]) return false;
        return true;
    }

    function _modexp(bytes memory base, bytes memory exp, bytes memory modulus) internal view returns (bytes memory) {
        bytes memory input = abi.encodePacked(
            uint256(base.length), uint256(exp.length), uint256(modulus.length),
            base, exp, modulus
        );
        uint256 outLen = modulus.length;
        bytes memory result = new bytes(outLen);
        assembly {
            let ok := staticcall(gas(), 0x05, add(input, 0x20), mload(input), add(result, 0x20), outLen)
            if iszero(ok) { revert(0, 0) }
        }
        return result;
    }

    // ─────────── base64url decode ───────────

    function _base64UrlDecode(bytes calldata data) internal pure returns (bytes memory) {
        bytes memory copy = new bytes(data.length);
        for (uint256 i = 0; i < data.length; i++) copy[i] = data[i];
        return _b64Decode(copy, true);
    }

    /// Decode standard or url-safe base64 (no padding required).
    function _b64Decode(bytes memory input, bool urlSafe) internal pure returns (bytes memory) {
        uint256 inLen = input.length;
        // Strip any '=' padding for size calc.
        while (inLen > 0 && input[inLen - 1] == 0x3D) inLen--;
        uint256 outLen = (inLen * 6) / 8;
        bytes memory out = new bytes(outLen);

        uint256 outIdx = 0;
        uint256 buffer = 0;
        uint256 bits = 0;
        for (uint256 i = 0; i < inLen; i++) {
            uint8 c = uint8(input[i]);
            uint8 v;
            if (c >= 0x41 && c <= 0x5A) v = c - 0x41;                  // A-Z
            else if (c >= 0x61 && c <= 0x7A) v = c - 0x61 + 26;        // a-z
            else if (c >= 0x30 && c <= 0x39) v = c - 0x30 + 52;        // 0-9
            else if (urlSafe && c == 0x2D) v = 62;                     // -
            else if (urlSafe && c == 0x5F) v = 63;                     // _
            else if (!urlSafe && c == 0x2B) v = 62;                    // +
            else if (!urlSafe && c == 0x2F) v = 63;                    // /
            else continue; // skip whitespace / other
            buffer = (buffer << 6) | v;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                out[outIdx++] = bytes1(uint8(buffer >> bits));
            }
        }
        // Trim if overestimated.
        assembly { mstore(out, outIdx) }
        return out;
    }

    // ─────────── small utilities ───────────

    function _eq(bytes memory a, bytes memory b) internal pure returns (bool) {
        if (a.length != b.length) return false;
        return keccak256(a) == keccak256(b);
    }

    function _bytes32ToHexString(bytes32 v) internal pure returns (bytes memory) {
        bytes16 alphabet = 0x30313233343536373839616263646566;
        bytes memory out = new bytes(66);
        out[0] = "0"; out[1] = "x";
        for (uint256 i = 0; i < 32; i++) {
            uint8 b = uint8(v[i]);
            out[2 + i * 2] = alphabet[b >> 4];
            out[3 + i * 2] = alphabet[b & 0x0f];
        }
        return out;
    }
}
