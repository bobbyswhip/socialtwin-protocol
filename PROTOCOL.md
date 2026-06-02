> **⚠️ Superseded (v1.1, post-audit):** This document predates the audit response and describes the earlier **attestor / off-chain-signer** model, which was **removed**. The deployed protocol verifies Twitch JWTs **entirely onchain** (`TwitchJWTVerifier`), with a two-phase abandoned-funds rescue and a timelocked `aud` allowlist. For the current design see [`README.md`](README.md) and [`AUDIT_RESPONSE.md`](AUDIT_RESPONSE.md); the onchain-JWT review is in [`SECURITY_REVIEW.md`](SECURITY_REVIEW.md). Retained for historical context.

# SocialTwin Protocol v1

Exact wire formats, hashing schemes, ABI. The reference implementation in this repo follows this spec; any adapter must too.

## 1. Identifiers

| Field | Type | Source |
|---|---|---|
| `userId` | `uint64` | IdP's immutable numeric user identifier. For Twitch: `sub` claim of the id_token, parsed as decimal. |
| `twinAddress` | `address` | `CREATE2(factory, salt, initcode)` |
| `verifier` | `address` | The `IVerifier` implementation the twin is bound to |
| `chainId` | `uint256` | EVM chain id (e.g., `8453` for Base) |

## 2. Twin address derivation

```
salt        = keccak256(abi.encodePacked("SocialTwin:twitch:v1", uint64(userId)))
init_code   = TwinAccount.creationCode || abi.encode(uint64(userId), address(verifier))
twin_addr   = address(uint160(uint256(
                  keccak256(abi.encodePacked(
                      bytes1(0xff),
                      address(factory),
                      salt,
                      keccak256(init_code)
                  ))
              )))
```

Reference: `contracts/TwinFactory.sol::predictAddress`. JS/TS adapter: `sdk/src/address.ts::predictTwinAddress`.

The string `"SocialTwin:twitch:v1"` is the domain separator. Forks targeting other IdPs MUST use a different domain to avoid address collisions.

## 3. Action hash (what the attestor signs over, indirectly)

For `TwinAccount.execute(target, value, data, nonce, deadline)`:

```
actionHash = keccak256(abi.encode(
    "TwinAccount:v1:execute",
    block.chainid,
    address(twin),
    twin.userId(),
    target,
    value,
    keccak256(data),
    nonce,
    deadline
))
```

For `executeBatch(targets[], values[], datas[], nonce, deadline)`:

```
actionHash = keccak256(abi.encode(
    "TwinAccount:v1:executeBatch",
    block.chainid,
    address(twin),
    twin.userId(),
    keccak256(abi.encodePacked(targets)),    // tightly-packed address[]
    keccak256(abi.encodePacked(values)),     // tightly-packed uint256[]
    keccak256(abi.encodePacked(dataHashes)), // tightly-packed bytes32[] where dataHashes[i] = keccak256(datas[i])
    nonce,
    deadline
))
```

Reference: `contracts/TwinAccount.sol`.

## 4. Attestor digest (what the attestor ECDSA-signs)

```
digest = keccak256(abi.encode(
    "SocialTwin:AttestorVerifier:v1",
    block.chainid,
    address(verifier),
    userId,
    actionHash,
    oauthExchangeEpoch
))
```

The attestor then signs `MessageHashUtils.toEthSignedMessageHash(digest)` — i.e., applies the EIP-191 personal_sign prefix. Reference: `contracts/AttestorVerifier.sol::computeDigest`, `attestor/src/signer.ts::computeDigest`.

`oauthExchangeEpoch` is the unix timestamp (seconds) at which the attestor finished verifying the IdP id_token. The onchain `TwinAccount.execute` enforces:

```
block.timestamp <= oauthExchangeEpoch + 5 minutes        // freshness
oauthExchangeEpoch <= block.timestamp + 60 seconds       // clock skew cap
```

## 5. Attestation transport format

After the OAuth round-trip, the attestor returns to the dApp via the URL fragment:

```
<return_to>#attestation=0x<65 bytes hex>&user_id=<decimal>&epoch=<decimal>&action_hash=0x<bytes32>&signer=0x<address>&provider=<string>[&preferred_username=<string>][&picture=<url>]
```

The fragment is opaque to the network — never sent to the server. The dApp parses it via `sdk/src/oauth.ts::parseReturnFragment`.

## 6. `execute()` calldata

```
twin.execute(
    address  target,
    uint256  value,
    bytes    data,
    uint256  _nonce,
    uint256  deadline,
    uint256  oauthExchangeEpoch,
    bytes    proof          // ECDSA sig (65 bytes) for AttestorVerifier;
                            // JWT bytes for TwitchJWTVerifier
)
```

The contract is `IVerifier`-agnostic. `proof` is opaque bytes whose interpretation is the responsibility of the bound verifier.

## 7. ABI exports

JSON ABIs for the three contracts plus initcode for the SDK live in `sdk/src/abis.ts`. They're machine-extracted from compiled artifacts — re-run `npx hardhat compile` and copy the relevant blobs if you change the contracts.

## 8. Versioning

Domain separators (`"SocialTwin:twitch:v1"`, `"TwinAccount:v1:execute"`, `"SocialTwin:AttestorVerifier:v1"`) carry the `v1` tag. Breaking changes increment the tag and use a new domain string. Pre-existing twins keep working under their original version forever; new deployments adopt the new domain.

## 9. Bumping the IdP

Forks targeting a different IdP MUST change at least:

| Constant | Where |
|---|---|
| `SALT_DOMAIN` | `TwinFactory.sol`, `sdk/src/address.ts` |
| Provider registry entries | `attestor/src/index.ts` |
| Domain separator if semantics differ | All of the above |

For pure-OIDC swaps (Google ↔ Twitch ↔ Apple), the salt domain can stay the same if you want addresses to remain stable across IdPs — but most adopters will want isolation, so a new domain like `"SocialTwin:google:v1"` is the safe default.
