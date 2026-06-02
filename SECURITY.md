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
| `keyAdmin` | `TwitchJWTVerifier` | `queueKey`→(7-day timelock)→`commitKey` to add/rotate a Twitch signing key in place | move funds; install a key the guardian vetoes, or without the public delay |
| `guardian` | `TwitchJWTVerifier` | `cancelKey` — veto a pending signing-key rotation | anything else (cancel-only) |
| `rescuer` | `TwinFactory` | `initiateRescue` / `completeRescue` on **never-activated** twins after a 90-day window | touch any activated/owned twin; rescue without the public delay |

`audAdmin`/`guardian`/`rescuer` are the treasury multisig (`0xD1EC…`); **`keyAdmin` is a DISTINCT operator key** (`0xa825…`). So the cold treasury holds the rotation veto while a hot key does routine queueing — a single compromise can't push a malicious signing key (`keyAdmin` queues, the treasury `guardian` can veto, and `keyAdmin` cannot reassign the guardian). `lockOpenForever()` permanently drops `audAdmin`. `rescuer` is non-renounceable but transferable.

The off-chain **relayer** key is spend-risk only (it pays gas); it is powerless beyond that — it can only broadcast what a JWT authorized, and must verify `twin == factory.predictAddress(jwt.sub)` before paying.

## Residual risks (honest)

- **OAuth blind-signing.** The Twitch consent screen can't display tx details, so JWT-path authorization is "blind." The action-hash binding stops tampering/redirection, and the `aud` allowlist stops foreign apps — but a user authorizing a malicious *allowlisted* app (or open mode) is the same ceiling as any "Sign in with X." Mitigations: dApps must show the action pre-redirect; `force_verify=true`; **and self-custody removes the JWT path entirely for that twin.** See [`AUDIT_RESPONSE.md`](./AUDIT_RESPONSE.md) Finding 2.
- **Twitch key rotation.** A contract can't fetch Twitch's JWKS, so the modulus is onchain. If Twitch rotates `kid="1"`, `keyAdmin` rotates it **in place** (`queueKey` → 7-day timelock → `commitKey`) — same verifier + twin addresses, no migration, so funds are **never permanently locked**; a legit rotation just pauses JWT-claims for the timelock. The rotation is **bounded**, not blind: the pending modulus is public (anyone compares it to `id.twitch.tv/oauth2/keys`), the `guardian` can `cancelKey`, and self-custodied twins use no JWT at all. **Residual:** if `keyAdmin` **and** `guardian` are both compromised and a malicious key sits queued for 7 days *without* anyone (watchdog/community) noticing and *without* affected users self-custodying, the attacker could install a forged key and drain JWT-path twins. That's a real but bounded trust assumption — strictly larger than an immutable verifier, deliberately taken to remove the permanent-lock risk. The watchdog at [`monitoring/jwks-watchdog.js`](./monitoring/jwks-watchdog.js) is the alarm: it cross-checks any **queued** key against the live JWKS and exits critical on a mismatch (and flags the rotation itself in advance) — run it on a schedule so the guardian gets the signal to `cancelKey` within the window.
- **Treasury key.** A compromised treasury could allowlist a phishing app (after the 2-day timelock — publicly visible) or rescue never-activated twins after 90 days. It cannot take active users' funds. Keep it a multisig.
- **Unaudited verifier.** Hand-rolled onchain base64url/JSON/RSA. Internally red-teamed (22+ vectors) + a fuzz suite (`test/FuzzVerifier.test.ts`), but a specialist audit is still recommended.

## Verified deployment

The live v1.3 contracts are **source-verified on Basescan**, so the deployed bytecode provably equals the code in this repo and exercised by the test suite. Addresses in [`README.md`](./README.md).
