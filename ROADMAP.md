# Roadmap

## Now (v1, in this repo)

- [x] `TwinFactory` + `TwinAccount` on Base mainnet
- [x] `AttestorVerifier` with 1-of-N immutable allowlist
- [x] Reference attestor backend (Node/TS)
- [x] Client SDK (TS)
- [x] Twitch as the first identity provider
- [x] Comprehensive docs
- [x] Internal security review

## Soon

- [ ] External audit of `AttestorVerifier` and the revised twin contracts
- [ ] Google + Apple as additional OIDC providers in the reference attestor
- [ ] npm-published `@socialtwin/sdk`
- [ ] Hosted reference attestor instance (paid SaaS or community-funded)
- [ ] Indexer integration: a hosted Goldsky/Envio dataset for Deposited/Executed events across factories
- [ ] User-facing UI primitives (React components for the connect-and-spend flow)

## Later

- [ ] **N-of-M threshold attestation.** New verifier that requires multiple attestor signatures over the same digest. Bigger trust diffusion than 1-of-N. ~80 lines of additional Solidity.
- [ ] **Discord / GitHub / Twitter providers.** Non-OIDC providers need either an attestor-only trust model (fine for the protocol) or a ZK-TLS step. See `docs/ADDING_PROVIDERS.md`.
- [ ] **ERC-4337 paymaster integration.** Sponsored gas for the recipient's first claim, paid by senders or sponsors. The twin already supports being called by any submitter, which makes paymaster integration natural.
- [ ] **Cross-chain twin federation.** Same `userId` → same twin address on multiple L2s, via deterministic factories. Already works mechanically; needs a coordinated multi-chain deploy and documentation.
- [ ] **Standalone identity registry.** A separate contract that maps `(provider, userId) → twin address`, queryable by senders without needing the SDK. Removes the off-chain CREATE2 prediction step for naive integrations.

## Considered and dropped

- **Pure on-chain ZK-TLS verification** (the original `TwitchJWTVerifier` path). Kept in the repo as a comparison artifact; not the recommended default because of the gas/audit-surface cost. See `docs/COMPARISON.md`.
- **Reclaim Protocol as the attestation layer.** Adds a third-party dependency that was the original reason the project moved off it. The attestor backend keeps the same trust shape without the external protocol.
- **Per-app session keys.** Considered for caching JWT-based authorization across multiple calls; rejected because it weakens the per-action binding that makes phishing resistance possible.
- **Recovery via social guardians.** Adds protocol complexity for a problem the IdP already solves (Twitch account recovery is Twitch's job).

## Out of scope, permanently

- KYC / identity verification beyond what the IdP performs.
- Custodial features. The twin is a smart account; the protocol never holds user funds with a recoverable key.
- A token. There's no protocol token, no governance, no fee.
