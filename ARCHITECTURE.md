# Architecture

One page on how the pieces fit. For wire formats see [`PROTOCOL.md`](./PROTOCOL.md).

## Three actors, three jobs

```
┌─────────────────┐       ┌────────────────────┐       ┌───────────────────┐
│   Sender app    │       │  Attestor service  │       │   Recipient dApp  │
│                 │       │                    │       │                   │
│  computes twin  │       │  redirects user    │       │  reads twin       │
│  address from   │       │  to IdP, verifies  │       │  balance, builds  │
│  Twitch user_id │       │  id_token, signs   │       │  execute() call,  │
│  & sends ETH    │       │  ECDSA attestation │       │  redirects to     │
│  to that addr   │       │                    │       │  attestor, submits│
└─────────────────┘       └────────────────────┘       └───────────────────┘
```

The sender side requires **zero** participation from the attestor or recipient. The sender just needs to know the recipient's Twitch user_id (resolvable from the handle via the public Twitch Helix API).

## On-chain pieces

| Contract | Role |
|---|---|
| `TwinFactory` | Deploys `TwinAccount` instances at deterministic CREATE2 addresses keyed by `(salt, userId, verifier)`. Permissionless `deployTwin(userId)`. |
| `TwinAccount` | Per-user smart account. Single storage slot (nonce). Verifies an attestation via the immutable `IVerifier` before performing arbitrary external calls. |
| `AttestorVerifier` | `IVerifier` implementation that accepts an ECDSA signature from any address in the immutable approved-attestor set. |
| `IVerifier` | Common interface — `verify(userId, actionHash, oauthExchangeEpoch, proof) returns (bool)`. Other verifiers can implement this without changing the twin contracts. |

The factory and verifier are deployed once and immutable. There are no admin functions, no upgrade paths, and no privileged roles. Twin accounts are also immutable; each lives at its CREATE2 address forever.

## Off-chain pieces

| Service | Role |
|---|---|
| Attestor backend | Hosts the OAuth flow with the IdP, verifies the id_token signature, and ECDSA-signs the canonical digest. One private key, kept secret. |
| Sender SDK | Predicts twin addresses off-chain so apps can route funds without RPC reads. |
| Recipient SDK | Builds the attestor redirect, parses the returned attestation, encodes the on-chain call. |

## A single end-to-end transaction

```
1. User browses recipient dApp
   → dApp wants user to spend `value` ETH from their twin to `target`.
   → dApp reads twin.nonce(), picks deadline = now + 10min.
   → dApp computes actionHash = twin.computeActionHash(target, value, data, nonce, deadline).

2. dApp redirects to:
     GET https://attestor.example.com/attest/twitch/start
       ?action_hash=<actionHash>
       &return_to=https://dapp.example.com/callback

3. Attestor stores (action_hash, return_to, code_verifier) in a signed state token.
   Attestor redirects user to id.twitch.tv with response_type=code, scope=openid, nonce=actionHash, force_verify=true.

4. User authorizes on Twitch.
5. Twitch redirects to https://attestor.example.com/attest/twitch/callback?code=...&state=...

6. Attestor:
   a. Verifies state token signature.
   b. Exchanges code for id_token at api.twitch.tv/oauth2/token.
   c. Verifies id_token signature against Twitch's JWKS.
   d. Extracts sub (user_id) from id_token claims.
   e. Signs ECDSA over keccak256(domain, chainid, verifierAddress, userId, actionHash, now).

7. Attestor redirects user to:
     https://dapp.example.com/callback#attestation=0x<65 bytes sig>&user_id=<id>&epoch=<now>&action_hash=<...>&signer=<addr>

8. dApp parses the fragment, calls writeContract:
     twin.execute(target, value, data, nonce, deadline, epoch, attestation)

9. TwinAccount.execute:
   a. Verifies nonce matches stored nonce.
   b. Verifies block.timestamp ≤ deadline.
   c. Verifies block.timestamp - epoch ≤ MAX_PROOF_AGE (5 min).
   d. Re-derives actionHash from inputs.
   e. Calls verifier.verify(userId, actionHash, epoch, attestation).
   f. AttestorVerifier ECDSA-recovers signer, checks isApproved.
   g. Increments nonce.
   h. Calls target.call{value: value}(data).

10. Done.
```

## Why CREATE2 with `(factory, userId, verifier)`

- Anyone can pre-compute a twin address before it exists.
- Two implementations of the SDK arrive at the same address byte-for-byte.
- The verifier address is baked in via the constructor args (which are part of the initcode), so changing verifiers means deploying a new factory at a new address space. This is intentional — twin authorization is tied to a specific verifier deployment.

## What changes if you change the IdP

Only the attestor backend needs to know about the IdP. The on-chain code never sees IdP-specific data — it only sees a `userId` and an attestor signature. So adding Google or Discord is purely a backend change: add a new provider to `attestor/src/providers/` and re-deploy that service. The on-chain contracts are unchanged.

This is the central reason the architecture chose backend attestation over on-chain JWT verification.

## Deployed default: on-chain JWT verification

The Base mainnet deployment uses `TwitchJWTVerifier`, which verifies Twitch's RSA-2048 signed id_token entirely in Solidity. This is the **permanent, operator-free** path: no server sits between the user and their funds. See [`PERMANENCE.md`](./PERMANENCE.md).

The `AttestorVerifier` (ECDSA from an approved off-chain attestor) is an **optional** alternative for adopters who want ~10× cheaper gas and explicitly accept that spending then depends on the attestor staying alive. Both implement the same `IVerifier` interface, so the twin contracts are identical regardless of which one a deployment binds to. See [`docs/COMPARISON.md`](./docs/COMPARISON.md) for the full side-by-side.

The single caveat of the JWT path is Twitch signing-key rotation; the contracts can't self-update Twitch's key trustlessly, so rotation requires a migration. A JWKS watchdog provides months of advance warning. Full analysis in [`PERMANENCE.md`](./PERMANENCE.md).
