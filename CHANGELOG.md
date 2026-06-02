# Changelog

All notable changes to the protocol and reference implementation. Format inspired by [Keep a Changelog](https://keepachangelog.com/).

## [1.3.0] — 2026-06-02 — Timelocked signing-key rotation

Guarantees a Twitch signing-key rotation can never permanently lock funds. **Deployed + Basescan-verified:** `TwinFactory` `0x260C074c3afDc46A209D4619B5FAdB2964dF9a28`, `TwitchJWTVerifier` `0xBDfC552469f11843802BCD7ec9a8372c8020fee8`.

### Added
- `TwitchJWTVerifier`: `queueKey` → `KEY_TIMELOCK` (7 days) → `commitKey` rotates/adds a Twitch RSA key **in place** (same verifier ⇒ same twin addresses, no migration, no permanent lock). A **distinct `guardian`** role can `cancelKey` to veto a pending key; `keyAdmin` cannot reassign the guardian. Pending modulus is public via `pendingKeyFor` for JWKS comparison. New roles `keyAdmin`/`guardian` (constructor now takes both); errors `NotKeyAdmin`/`NotGuardianNorKeyAdmin`/`KeyNotQueued`/`KeyTimelockNotElapsed`/`BadModulusLength`; `test/KeyRotation.test.ts` (9 tests; 84 total).
- `monitoring/jwks-watchdog.js`: standalone JWKS watchdog (ethers + fetch). Reconciles the live verifier's `modulusOf`/`pendingKeyFor` against Twitch's JWKS; **critical** (non-zero exit) if a *queued* rotation doesn't match the live JWKS, so the guardian gets the veto signal within the timelock. `npm run watchdog`.

### Note
- `TwinAccount`/`TwinFactory` source is unchanged from v1.2, but a new verifier ⇒ new twin addresses, so v1.2 (`0xe717…`/`0xEaD1…`) is deprecated. Residual trust of the rotation path documented in `SECURITY.md` / `AUDIT_RESPONSE.md` (Finding 5).

## [1.2.0] — 2026-06-02 — One-way self-custody

Follow-up security hardening (strengthens audit Finding 2). **Deployed + Basescan-verified:** `TwinFactory` `0xe717Dd981Ea9FD5Fe7E61cFA11e07EDc48Ba1088` (verifier `0xEaD1…` reused from v1.1).

### Security
- `TwinAccount`: connecting an owner EOA via `setOwnerEOA` sets a one-way `selfCustody` flag that **permanently disables the JWT/Twitch path** (`execute`, `executeBatch`, `setOwnerEOA`) — only `executeAsOwner`/`rotateOwnerEOA` work afterward. A compromised/phished Twitch login can no longer drain or re-point a self-custodied twin. New error `SelfCustodyEnabled`; new view `selfCustody`.
- `completeRescue` does **not** set `selfCustody`, so abandoned-then-rescued twins remain JWT-reclaimable by the real streamer.
- Tests: +2 (TwinV2Features "JWT disabled after self-custody", RedTeam "E3 self-custodied twin rejects JWT drain + re-point"); 101 passing.
- v1.1 factory `0x4318…` deprecated (the verifier is unchanged).

## [1.1.0] — 2026-06-02 — Audit response

Addresses the external review by Sterling Crispin. Full mapping in [`AUDIT_RESPONSE.md`](AUDIT_RESPONSE.md).

**Deployed + Basescan-verified on Base mainnet:** `TwinFactory` `0x4318db7BeDF879A43B77fa608248bBF78423bBDa`, `TwitchJWTVerifier` `0xEaD1e986407d899fD00A8733F48Fd87DeeB33A4e`. Passed a post-deploy live adversarial matrix (rescue access-control, owner-path, JWT-path, aud-timelock) + 99 tests. Pre-audit v1.0 (`0x942C…`, `0xF1Ff…`) deprecated.

### Security
- **Rescue redesign (Finding 1, High):** abandoned-funds rescue is now two-phase and intent-based — `initiateRescue()` starts the 90-day clock from the rescuer's public signal (not deploy time), then `completeRescue()`. Neutralizes the pre-deploy timing attack. New error `RescueNotInitiated`; removed `rescueAbandoned`.
- **Timelocked aud allowlist (Finding 2, High):** `addAud` replaced by `queueAud` → `AUD_TIMELOCK` (2 days) → `commitAud`; removals and the off-switch stay immediate. Added an ERC-7730 clear-signing descriptor for the owner-EOA wallet path (`clear-signing/`).
- **SDK hash bug fixed (Finding 3, High/Med):** `buildSpendFlow` now binds the real `userId` (was hardcoded `0n`); SDK reframed from the attestor model to the deployed Twitch-JWT flow.
- **Parser fuzz suite (Finding 6):** `test/FuzzVerifier.test.ts` — random/adversarial JWTs, wrong-key, claim mutation, alg-confusion, truncation, quote-injection.

### Removed
- `AttestorVerifier` contract + tests + `ATTESTOR_VERIFIER_ABI` + `docs/ATTESTOR_OPERATIONS.md` (Finding 4 — 1-of-N trust, never deployed).

### Fixed
- `deploy-local.ts` verifier constructor call (2→4 args); `deploy-twin-factory.ts` + `TwinFactory` NatSpec referenced a nonexistent `renounceRescuer` (rescuer is non-renounceable). Privileged roles documented in `ARCHITECTURE.md`; attestor-era docs banner-marked as superseded; key-rotation playbook clarified (Findings 5, 7).

## [0.3.0] — 2026-05-27

### Added
- `AttestorVerifier` contract: ECDSA-based `IVerifier` accepting signatures from any of an immutable approved-attestor set.
- Reference attestor service (`attestor/`): Express + jose + viem, provider-pluggable, ships with a Twitch OIDC adapter.
- Client SDK (`sdk/`): TS module that predicts twin addresses, builds OAuth redirects, parses attestations, and produces `execute()` calldata.
- Comprehensive documentation: `ARCHITECTURE`, `PROTOCOL`, `SECURITY`, `ROADMAP`, plus 10+ files under `docs/`.

### Changed
- Default verifier shifted from onchain JWT (`TwitchJWTVerifier`) to off-chain attestor with onchain ECDSA check (`AttestorVerifier`). ~10× cheaper gas, ~3× smaller audit surface. The onchain JWT path remains in the repo as a comparison artifact for adopters who want pure-cryptography decentralization.

### Security
- Audit findings from the pre-attestor design carried forward as defensive design choices in `AttestorVerifier`. See `SECURITY_REVIEW.md` for the prior report.

## [0.2.1] — 2026-05-27

### Fixed (twin/JWT path, audit-driven)
- `TwitchJWTVerifier._parseDecimal` now reverts on non-digit input instead of silently returning `0` (LOW-1).
- `TwinAccount.execute` now rejects future-`iat` JWTs beyond `MAX_CLOCK_SKEW = 60s` (LOW-2).
- `TwinFactory.deployTwin` now reverts on `userId == 0` (LOW-4).

### Deployed
- TwinFactory: `0x5204a18785ce8ab080B7194A679e5f0605A7b6Ec` (Base mainnet)
- TwitchJWTVerifier: `0xE4CC251864B0271903D458a9F5731D38ed3eeA39` (Base mainnet)
- Both Basescan-verified.

## [0.2.0] — 2026-05-27

### Added
- `TwinFactory` + `TwinAccount`: per-Twitch-user smart accounts at deterministic CREATE2 addresses, gated by onchain JWT verification via `TwitchJWTVerifier`.

### Deployed
- TwinFactory (pre-audit): `0x2D301e0325a7dBbB6aB6EbA5cdac9be17EbC2c07` (deprecated 2026-05-27)

## [0.1.x] — 2026-05-24 → 2026-05-26

Earlier exploration:
- Reclaim-based escrow at `0xb3314bEb49A7D047b87F3E4B84cD7e171E197d35` (deprecated).
- Demo MockVerifier escrow at `0x85e910d07e9b793E176968363F24357dfA3A03e1` (deprecated, demo only).
- Onchain JWT verifier introduction.

See git history for the full evolution.
