# Changelog

All notable changes to the protocol and reference implementation. Format inspired by [Keep a Changelog](https://keepachangelog.com/).

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
