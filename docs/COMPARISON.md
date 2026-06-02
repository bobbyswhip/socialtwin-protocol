# Design comparison

This protocol sits in a design space crowded with related projects. Here's how the choices we made differ from the alternatives.

## Within this repo: attestor vs. on-chain JWT

Two verifier implementations live in `contracts/`:

|  | `AttestorVerifier` (default) | `TwitchJWTVerifier` (legacy) |
|---|---|---|
| What it checks | ECDSA signature from approved attestor over `(userId, actionHash, epoch)` | RSA-2048 signature from Twitch over the entire id_token JWT |
| Gas per `verify()` | ~30k | ~700k |
| Solidity lines | ~80 | ~280 |
| Trust roots | Twitch + attestor | Twitch only |
| Adding a new IdP | Backend change, no redeploy | New on-chain verifier per IdP |
| Operational requirement | Attestor service must be running | None |
| Key rotation | New verifier deploy (old/new in approved set during overlap) | New verifier deploy (with new modulus) |
| Best fit | Most use cases | High-value deployments needing trust minimization |

**The on-chain JWT verifier is the deployed default**, chosen for permanence: no operator sits in the spend path, so funds can never be locked by an operator disappearing (see [`../PERMANENCE.md`](../PERMANENCE.md)). The attestor model remains in the repo as a fully-functional opt-in for adopters who prioritize cheap gas and accept operator-dependency. They share the `IVerifier` interface, so the twin contracts are identical regardless of which verifier you bind to.

## vs. Reclaim Protocol

[Reclaim](https://reclaimprotocol.org) provides ZK-TLS proofs of arbitrary HTTPS responses, verifiable on-chain. Their model:

```
User → Twitch (HTTPS) ← Reclaim witnesses (ZK-TLS) → ZK proof → on-chain verifier
```

|  | Reclaim | SocialTwin (attestor) |
|---|---|---|
| Trust | Reclaim's witness threshold | Your attestor's signing key |
| External dependency | Reclaim Protocol's infrastructure | None (run it yourself) |
| Provider extensibility | Any HTTPS endpoint with a proof template | Anything with OIDC; backend wraps non-OIDC |
| Gas per verify | ~300k+ (depending on proof complexity) | ~30k |
| Time to ship a new IdP | Days (build a Reclaim template) | Hours (subclass `IdentityProvider`) |

Why we moved away from Reclaim earlier in this project's history: it's a third-party dependency, and the protocol's stated goal was no external protocol dependencies. The attestor model preserves that property by making the trust party someone you control.

## vs. Wormhole guardians / LayerZero DVNs

These are cross-chain message-passing protocols, not identity protocols, but the trust shape is exactly analogous:

|  | Wormhole guardians | LayerZero DVNs | SocialTwin |
|---|---|---|---|
| Approved signer set | 19 guardians (fixed) | Per-channel DVNs (configurable) | 1-N attestors (immutable per verifier) |
| Threshold | 13-of-19 | Per-channel | 1-of-N (today) |
| Per-message cost | 1 signature aggregated | 1 signature per DVN | 1 signature |
| What's signed | Cross-chain message | Cross-chain message | Identity attestation |

SocialTwin's design is much closer to a DVN-style configurable set than to Wormhole's hardcoded guardians. The "identity" use case is simpler than cross-chain messaging — there's no fork-choice complexity, no per-chain state, no replay-protection-across-chains-with-different-chainids.

## vs. zkLogin (Sui)

[Sui's zkLogin](https://docs.sui.io/concepts/cryptography/zklogin) uses ZK proofs of OAuth-provided JWTs to derive a Sui address from an OIDC user identity. The user controls the address via continuing to authenticate with the IdP.

|  | zkLogin | SocialTwin |
|---|---|---|
| Identity provider | Any OIDC (Google, Facebook, etc.) | Any OIDC (Twitch by default) |
| Chain | Sui | Any EVM (Base by default) |
| On-chain verification | ZK proof of JWT | ECDSA from attestor (or RSA from IdP in legacy mode) |
| Per-tx gas | Sui-specific | ~30k EVM (attestor) or ~700k EVM (JWT) |
| External infrastructure | Sui's prover service | Your attestor service |

The conceptual model is similar — derive an address from social identity, gate spending on fresh OAuth. zkLogin is more cryptographic; SocialTwin's attestor model is more operational. Pick based on whether your team prefers managing key infrastructure or accepting ZK prover dependencies.

## vs. Account abstraction (ERC-4337) + passkeys

ERC-4337 smart accounts authenticated by WebAuthn passkeys (Coinbase Smart Wallet, Privy embedded wallets, etc.).

|  | CBSW + passkey | SocialTwin |
|---|---|---|
| Identity source | Passkey (device-bound) | Social network OAuth |
| Address derivation | From passkey public key | From Twitch user_id |
| Anyone can send to you knowing only your handle | No — they need your address | Yes |
| Setup required before receiving | Yes (create the wallet) | No |
| Per-tx auth | Biometric | OAuth + (optionally) wallet biometric |

These solve different problems. CBSW is "personal smart wallet"; SocialTwin is "social handle as on-chain destination." A user could have both: their twin receives, and they spend FROM the twin via CBSW signatures using the attestor as identity attestor.

## vs. ENS

Ethereum Name Service maps human-readable names to Ethereum addresses.

|  | ENS | SocialTwin |
|---|---|---|
| Mapping | Manually configured by name owner | Deterministically derived from social handle |
| Cost | Annual fee in ETH | Free |
| Trust source | Whoever owns the ENS name | The identity provider (Twitch) |
| Use case | "Send to vitalik.eth" | "Send to twitch.tv/streamer" |
| Setup | User registers name | None (anyone can receive) |

ENS requires the recipient to set up. SocialTwin doesn't. ENS is general-purpose; SocialTwin is identity-provider-bound. They can coexist — a user could resolve their twin address into their ENS, making both work.

## vs. Lit Protocol PKPs

[Lit Protocol](https://litprotocol.com) provides Programmable Key Pairs (PKPs) — private keys managed by an MPC threshold of Lit nodes. Each PKP can be conditionally accessed (e.g., "anyone with this OAuth token can sign").

|  | Lit PKPs | SocialTwin |
|---|---|---|
| What "owns" the funds | The PKP held by Lit nodes | A smart contract bound to a verifier |
| Who can spend | Anyone meeting the access condition (e.g., the OAuth user) | Anyone holding a valid attestation for the right userId |
| External dependency | The Lit network | Your attestor |
| Setup required | Mint the PKP, define access conditions | None for receive; one-time attestor visit for spend |

Lit's model is "keys managed by an external network." SocialTwin's is "smart contract authorized by an external attestor." Different shapes, comparable risk profiles. SocialTwin keeps more on-chain explicitness — the verifier and the approved attestor list are both publicly inspectable bytecode/storage.

## Where SocialTwin is unique

- **Address-from-social-handle that doesn't require recipient setup.** Anyone can send to a Twitch user without that user having ever heard of crypto.
- **A protocol designed to be forked.** Salt domains, provider abstractions, and trust-model documentation make adapting to a different IdP a one-day job.
- **Deliberate trust honesty.** The model names its trust roots explicitly (`SECURITY.md`, `TRUST_MODEL.md`) rather than hand-waving them away.
