# Protocol

Wire formats for the SocialTwin twin/JWT system on Base. Source of truth is the contracts; this documents what an integrator must reproduce. Chain: Base mainnet (`8453`). Live addresses: [`README.md`](./README.md).

## 1. Deterministic twin address (CREATE2)

```
salt      = keccak256(abi.encodePacked("SocialTwin:twitch:v2", uint64(userId)))
initCode  = TwinAccount.creationCode ++ abi.encode(uint64(userId), address(verifier))
twin      = address(keccak256(0xff ++ factory ++ salt ++ keccak256(initCode))[12:])
```

- Onchain: `TwinFactory.predictAddress(uint64 userId)`. Offchain: `sdk` → `predictTwinAddress({factory, verifier, userId})`.
- `TwinAccount.creationCode` is compiler-sensitive (solc 0.8.24, viaIR, optimizer runs=200, evmVersion=cancun). Changing it changes every twin address and the SDK's `TWIN_ACCOUNT_INIT_CODE`. The factory embeds the creation code, so a new `TwinAccount` ⇒ a new factory address.
- Fund a twin by sending ETH/ERC-20 to `predictAddress(userId)` — no deploy required first. Deploy lazily with `deployTwin(userId)` before the first function call.

## 2. Action-hash binding

The action a user authorizes is hashed and embedded into the OAuth `nonce`, binding the JWT to one exact call on one twin on one chain.

```solidity
// execute
keccak256(abi.encode("TwinAccount:v2:execute",
  block.chainid, address(this), userId, target, value, keccak256(data), nonce, deadline))

// executeBatch
keccak256(abi.encode("TwinAccount:v2:executeBatch",
  block.chainid, address(this), userId,
  keccak256(abi.encodePacked(targets)), keccak256(abi.encodePacked(values)),
  keccak256(abi.encodePacked(dataHashes)),     // dataHashes[i] = keccak256(datas[i])
  nonce, deadline))

// setOwnerEOA
keccak256(abi.encode("TwinAccount:v2:setOwnerEOA",
  block.chainid, address(this), userId, newOwner, nonce, deadline))
```

Read these from the contract: `computeActionHash`, `computeBatchHash`, `computeSetOwnerHash`. The OAuth `nonce` is the lowercase `0x…`-prefixed hex of the 32-byte hash.

## 3. Twitch OIDC implicit flow

Redirect the user (top-level) to:

```
https://id.twitch.tv/oauth2/authorize
  ?client_id=<allowlisted client_id>      # becomes the JWT `aud`
  &redirect_uri=<exact registered URI>     # trailing slash matters
  &response_type=id_token
  &scope=openid
  &nonce=<hex(actionHash)>                 # the binding
  &force_verify=true                       # consent every time
```

Twitch returns the signed `id_token` in the URL **fragment**: `…#id_token=<JWT>&…`. Claims: `iss`, `aud`, `sub` (numeric user_id, a JSON string), `iat`, `exp`, `nonce`, plus `preferred_username`/`picture`.

> The Twitch consent screen cannot show transaction details — your dApp MUST display the exact action (recipient, amount, twin) before redirecting. The action-hash binding makes a tampered call revert onchain, but the human still needs to see what they approve.

## 4. Submitting the call

```solidity
twin.execute(target, value, data, nonce, deadline, oauthExchangeEpoch, jwt)
```

- `nonce` — the twin's current `nonce()` (per-twin replay counter; increments on success).
- `deadline` — unix seconds; reverts past it.
- `oauthExchangeEpoch` — must equal the JWT's `iat`.
- `jwt` — the **raw** id_token bytes (`utf8("header.payload.signature")`).

Submit from the user's wallet **or** any relayer — `execute` has no `msg.sender` check.

## 5. Onchain verification (what must hold)

`TwinAccount._checkJwt` then `TwitchJWTVerifier.verify` enforce, in effect:

1. `selfCustody == false` (else `SelfCustodyEnabled` — the JWT path is dead once a wallet is linked).
2. `nonce` == the twin's stored nonce; `block.timestamp <= deadline`.
3. Freshness: `block.timestamp <= iat + MAX_PROOF_AGE` (5 min) and `iat <= block.timestamp + MAX_CLOCK_SKEW` (60 s).
4. JWT header `alg == "RS256"`, `kid` known.
5. RSA-2048 PKCS#1 v1.5 + SHA-256 signature valid over `header.payload` against the baked-in Twitch modulus (via the `modexp` precompile `0x05`; byte-exact padding check, RFC 8017).
6. `iss == "https://id.twitch.tv/oauth2"`.
7. `aud` ∈ allowlist (when `audCheckEnabled`).
8. `sub` (decimal) `== userId` — the cross-user isolation guarantee.
9. `iat == oauthExchangeEpoch`.
10. `nonce` (string) `== hex(actionHash)`.

Any failure reverts; the verifier returns `true` only when all hold.

## 6. Self-custody (one-way)

`setOwnerEOA(newOwner, …, jwt)` (JWT-gated, once) sets `ownerEOA` and the permanent `selfCustody` flag. While `selfCustody` is set, `execute`/`executeBatch`/`setOwnerEOA` all revert `SelfCustodyEnabled`; only `executeAsOwner(target,value,data)` and `rotateOwnerEOA(newOwner)` (both require `msg.sender == ownerEOA`) work. There is no path to re-enable Twitch.

## 7. Rescue (two-phase, intent-timed)

`initiateRescue()` (rescuer-only, never-activated twin) starts a `RESCUE_DELAY` (90-day) countdown from that call. `completeRescue(designatedEOA)` then delegates control after the delay if the twin is still never-activated. Any JWT action / `setOwnerEOA` sets `activated` and blocks rescue. `completeRescue` does **not** set `selfCustody`, so the real streamer can still reclaim via JWT.

## 8. Signing-key rotation (timelocked, in place)

A contract can't fetch Twitch's JWKS, so the modulus per `kid` is stored onchain and can be rotated without redeploying:

- `queueKey(string kid, bytes modulus)` (`keyAdmin`, modulus must be 256 bytes) → sets a pending key with `eta = now + KEY_TIMELOCK`; emits `KeyQueued(kid, keccak256(modulus), eta)`.
- During the window: `pendingKeyFor(kid) → (modulus, eta)` is public so anyone can compare the pending modulus to `id.twitch.tv/oauth2/keys`. `cancelKey(kid)` (callable by `keyAdmin` **or** `guardian`) vetoes it.
- `commitKey(string kid)` (`keyAdmin`, after `eta`) → sets `modulusOf[keccak256(kid)] = modulus` **in place** (adds the kid if new). The verifier address is unchanged, so every existing twin keeps the same address and resumes verifying against the new key — no migration, no permanent lock.

`keyAdmin` is transferable; `guardian` is transferable **only by the guardian** (so `keyAdmin` can't neutralize the veto). Self-custodied twins use no JWT and are unaffected by any key change. See [`SECURITY.md`](./SECURITY.md) for the trust analysis.

## Constants

`MAX_PROOF_AGE = 5 minutes` · `MAX_CLOCK_SKEW = 60 seconds` · `RESCUE_DELAY = 90 days` · `AUD_TIMELOCK = 2 days` · `KEY_TIMELOCK = 7 days`.
