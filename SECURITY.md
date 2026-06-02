# Security

Threat model and trust assumptions for the deployed twin/JWT system. Companion docs: [`AUDIT_RESPONSE.md`](./AUDIT_RESPONSE.md) (external review by Sterling Crispin + fixes + live red-team) and [`RED_TEAM_FINDINGS.md`](./RED_TEAM_FINDINGS.md) (internal adversarial vectors).

> **Status:** internally red-teamed + one external review; **not yet fully audited.** The onchain RSA/base64/JSON verifier is intricate, correctness-critical code — get a dedicated external audit + fuzzing before routing large value.

## Trust roots

Spending a twin trusts exactly:

1. **Twitch's RSA signing key** (`kid="1"`) — the identity ceiling. A Twitch key compromise (or a forged token) is the only way to impersonate a user on the JWT path.
2. **The Base sequencer / L1** — liveness and ordering.
3. **The EVM `modexp` precompile (`0x05`)** — RSA exponentiation.
4. **A treasury multisig** — for app-allowlist curation and abandoned-fund rescue only (see Roles). It cannot move an active user's funds.

**No server, oracle, witness network, TEE, or off-chain protocol is in the spend path.** The JWT is verified entirely onchain.

## Guarantees

| Property | Mechanism |
|---|---|
| No user can spend another's twin | verifier enforces `sub == userId`; action hash binds `userId` + twin address |
| No replay / cross-twin / cross-chain reuse | action hash binds chainid, twin, nonce, deadline, target, value, calldata; 5-min freshness window |
| Permissionless settlement | `execute` has no `msg.sender` check — any wallet/relayer can submit a valid JWT |
| Anti-phishing | only allowlisted OAuth `aud`s accepted; a malicious site's own Twitch app yields a different `aud` → rejected; new `aud`s are timelocked 2 days |
| Self-custody severs Twitch | `setOwnerEOA` sets a one-way `selfCustody` flag that permanently disables the JWT path — a compromised/phished Twitch login can no longer drain or re-point the twin |
| Survives operator death | deterministic addresses + permissionless `execute` + wallet-owned `executeAsOwner` (see [`PERMANENCE.md`](./PERMANENCE.md)) |
| No admin over user funds | treasury can curate the `aud` allowlist and recover *never-activated* twins (two-phase, 90-day public window) — nothing more |

## Privileged roles

| Role | Where | Can | Cannot |
|---|---|---|---|
| `audAdmin` | `TwitchJWTVerifier` | `queueAud`→(2-day timelock)→`commitAud`, `removeAud` (immediate), `setAudCheckEnabled`, `lockOpenForever` | move funds; instantly allowlist an app |
| `rescuer` | `TwinFactory` | `initiateRescue` / `completeRescue` on **never-activated** twins after a 90-day window | touch any activated/owned twin; rescue without the public delay |

Both are the treasury multisig. `lockOpenForever()` permanently drops `audAdmin` and accepts any app's JWTs (graduating to full permissionlessness). `rescuer` is non-renounceable but transferable.

The off-chain **relayer** key is spend-risk only (it pays gas); it is powerless beyond that — it can only broadcast what a JWT authorized, and must verify `twin == factory.predictAddress(jwt.sub)` before paying.

## Residual risks (honest)

- **OAuth blind-signing.** The Twitch consent screen can't display tx details, so JWT-path authorization is "blind." The action-hash binding stops tampering/redirection, and the `aud` allowlist stops foreign apps — but a user authorizing a malicious *allowlisted* app (or open mode) is the same ceiling as any "Sign in with X." Mitigations: dApps must show the action pre-redirect; `force_verify=true`; **and self-custody removes the JWT path entirely for that twin.** See [`AUDIT_RESPONSE.md`](./AUDIT_RESPONSE.md) Finding 2.
- **Twitch key rotation.** Moduli are baked in at deploy; if Twitch rotates `kid="1"`, the JWT path stalls until a new verifier+factory is deployed and users migrate. We deliberately do **not** allow admin key-injection (that would let the admin forge tokens). Self-custodied twins and `executeAsOwner` are unaffected; a JWKS watchdog gives advance warning.
- **Treasury key.** A compromised treasury could allowlist a phishing app (after the 2-day timelock — publicly visible) or rescue never-activated twins after 90 days. It cannot take active users' funds. Keep it a multisig.
- **Unaudited verifier.** Hand-rolled onchain base64url/JSON/RSA. Internally red-teamed (22+ vectors) + a fuzz suite (`test/FuzzVerifier.test.ts`), but a specialist audit is still recommended.

## Verified deployment

The live v1.2 contracts are **source-verified on Basescan**, so the deployed bytecode provably equals the code in this repo and exercised by the test suite. Addresses in [`README.md`](./README.md).
