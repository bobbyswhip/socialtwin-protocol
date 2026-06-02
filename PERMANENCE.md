# Permanence & Decentralization

The definitive answer to: **"If the operator (us) disappears, can users still access their funds?"**

**Short answer: yes.** Nothing the operator runs is in the spend path. Everything required to fund, claim, and control a twin is either onchain or reproducible by anyone.

## What spending actually requires

A twin spend needs only:

1. The twin's deployed bytecode on Base (permissionless to deploy via `deployTwin`, or already deployed).
2. **Either** a fresh Twitch `id_token` (verified onchain) **or** the owner EOA's signature (once self-custodied).
3. A transaction broadcast to Base — by any wallet or relayer. `execute` has no `msg.sender` check.

No SocialTwin server, API, indexer, or relayer is required for any of this.

## If the operator vanishes

| Operator component | In spend path? | If it's gone |
|---|---|---|
| Relayer (gasless submit) | No | Users (or anyone) self-submit `execute`; they just pay their own gas. |
| RPC proxy | No | Use any Base RPC. |
| Resolver (`@handle → user_id`) | No | Twitch user_id is public; derive the twin offline with the SDK. |
| Deposit indexer / web app | No | Read balances from any RPC; the SDK derives addresses with no server. |
| `audAdmin` / `rescuer` (treasury) | No (curation/rescue only) | Existing twins keep working; no new apps get allowlisted and no abandoned-fund rescue happens — neither affects a user's ability to spend their own twin. |

The reference web app + backend live outside this repo precisely because they're disposable convenience tooling.

## Self-custody is the strongest permanence

Once a user calls `setOwnerEOA`, the twin flips a one-way `selfCustody` flag: the Twitch/JWT path is permanently disabled and **only the owner EOA can act** (`executeAsOwner` / `rotateOwnerEOA`). From that point the twin is a plain self-custody account — it does not depend on Twitch, the operator, or any allowlist. This is the recommended end state for anyone holding meaningful value; link a smart-contract wallet if you want key recovery.

## The one real dependency: Twitch's signing key

The JWT path depends on Twitch maintaining OIDC and not rotating `kid="1"` out from under a deployed verifier. If Twitch rotates keys, the JWT path for *unlinked* twins stalls until a new verifier+factory is deployed and users migrate — a transparent, observable event with weeks of warning (a JWKS watchdog flags it). Self-custodied twins are unaffected (they use no JWT). We deliberately do **not** let an admin inject new RSA moduli, because that would make the admin able to forge tokens — strictly worse than the rotation risk.

## The decentralization dial

The `aud` allowlist is the only curated trust surface, and it's a deliberate dial:

- **Today (curated):** the treasury `audAdmin` approves apps with `queueAud`→`commitAud` (2-day timelock). Safe default while the verifier is unaudited.
- **Open / locked:** `setAudCheckEnabled(false)` (reversible) or `lockOpenForever()` (irreversible — also drops the admin) make the verifier accept any app's JWTs with no privileged role at all. That accepts the same phishing surface every wallet already lives with, in exchange for removing the last operator lever.

So permanence holds today, and the protocol can graduate to fully admin-less when the verifier is audited.
