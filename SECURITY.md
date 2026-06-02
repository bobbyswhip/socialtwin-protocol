> **⚠️ Superseded (v1.1, post-audit):** This document predates the audit response and describes the earlier **attestor / off-chain-signer** model, which was **removed**. The deployed protocol verifies Twitch JWTs **entirely onchain** (`TwitchJWTVerifier`), with a two-phase abandoned-funds rescue and a timelocked `aud` allowlist. For the current design see [`README.md`](README.md) and [`AUDIT_RESPONSE.md`](AUDIT_RESPONSE.md); the onchain-JWT review is in [`SECURITY_REVIEW.md`](SECURITY_REVIEW.md). Retained for historical context.

# Security

This document is the formal threat model. The audit report on the prior onchain JWT design is preserved at `SECURITY_REVIEW.md`. This file covers the **current attestor-based design** plus residual risk for both.

## Trust roots (and only these)

1. **The IdP's identity infrastructure.** Twitch's OAuth backend and authentication systems. If a Twitch account is compromised, the funds in its twin can be drained — by design.
2. **The attestor's ECDSA private key.** If the key leaks, an attacker can sign arbitrary attestations and drain every twin bound to that verifier.
3. **Base sequencer + Ethereum L1.** Standard L2 trust.
4. **EVM precompiles** (ecrecover for ECDSA).

The contracts themselves are immutable and have no admin. There is no fourth-or-later trust root.

## What is guaranteed

| Property | Mechanism |
|---|---|
| Cross-user isolation | `TwinAccount` has immutable `userId`; verifier checks attestation binds same `userId`; action hash includes `address(this)`. |
| Permissionless submission | No `msg.sender` check on `execute()`. Front-runners gain nothing because funds flow to `target`, not the submitter. |
| Deterministic address | CREATE2 with fully-known inputs. No selfdestruct path in `TwinAccount`. Post-EIP-6780, address is permanent. |
| Replay protection | Action hash binds chainid, twin address, userId, target, value, data hash, nonce, deadline. Nonce moves on every successful call. |
| Freshness | `MAX_PROOF_AGE = 5 minutes` past, `MAX_CLOCK_SKEW = 60 seconds` future. |
| No admin | Factory and verifier are immutable; no setters; no upgrade proxy. |
| Reentrancy safety | `nonReentrant` modifier + effects-before-interactions on nonce. |

## What is NOT guaranteed

| Risk | Why | Mitigation |
|---|---|---|
| Twitch account compromise | The whole protocol delegates identity to Twitch. | None at the protocol layer. Standard Twitch account security (strong password, 2FA, no credential reuse). |
| Attestor key compromise | The verifier accepts any signature from the approved set. | Hardware key storage (HSM, KMS, secure enclave). Air-gap signing. Multi-attestor 1-of-N reduces but doesn't eliminate. Future N-of-M threshold verifier would. |
| Verifier rotation | Verifier is immutable; new approved-attestor sets require a new verifier (and new factory) deployment. Old twins are stranded with the old verifier. | Plan rotation overlap windows: keep the old key signing valid attestations until users migrate. |
| Phishing | A user who clicks "Sign in with Twitch" on a malicious site authorizes whatever `action_hash` that site put in the OAuth URL. The contract can't tell the difference between a legitimate dApp and a phishing site. | URL bar awareness. `force_verify=true` on the attestor side. Future: standardized signing surfaces (similar to MetaMask's confirmation popup). |
| Long-lived attestor downtime | Without a live attestor, users can't spend their twins. | Run multiple attestor instances (`AttestorVerifier`'s 1-of-N support). Document a self-hosting playbook. |
| Compiler-level bugs | Solidity 0.8.24 (viaIR=true, optimizer=200) is the assumed compiler. Future compiler regressions could affect deployed bytecode. | Already-deployed contracts are unaffected by post-deploy compiler changes. New deployments should re-audit if the toolchain shifts. |

## Threat scenarios, walked through

### Attacker has my Twitch account
Same outcome as if they had my MetaMask seed phrase. They sign in to a dApp, authorize whatever action they want, the attestor signs, the twin executes. Protocol cannot fix this; it's the IdP's job.

### Attacker has the attestor's signing key
Catastrophic. They drain every twin bound to that verifier without any user interaction or Twitch involvement. This is why the attestor's key must be treated like a CA key: HSM-stored, rotated periodically, monitored for unusual signing activity.

### Attacker runs a malicious "Sign in with Twitch" page
The user redirects to twitch.tv (real Twitch URL bar), clicks Authorize, gets bounced back to the attacker's page. The attacker's page submits `execute()` with the attestation. Since action_hash binds `target`, the attacker would have set `target = attacker_wallet` in the original redirect — and the attestor signed for that action_hash. Drain.

This is unavoidable for OIDC-based identity. The user's defense:
- Bookmark the legitimate dApp URL.
- Don't click "Sign in with Twitch" from emails/DMs.
- Check the URL bar shows the expected dApp origin before clicking.

### Attacker intercepts the attestation in transit
The attestation lands in the URL fragment, which is client-side only — never sent to the server, never logged in Referer headers, never indexed by search engines. An attacker on the user's network can't see it. The only way to capture it is by controlling the dApp the user is using, which is the phishing case above.

### Attacker submits a captured attestation from someone else's flow
- Same `userId`: attacker doesn't have a twin for that userId, and the action_hash binds `target` which the attacker can't redirect.
- Different `userId`: AttestorVerifier digest binds `userId`; the recovered signer won't match the approved set.

### Replay across chains
The attestor digest binds `chainid` and the verifier `address(this)`. An attestation valid on Base is invalid on any other chain (different chainid → different digest → different recovered signer).

### Time attacks
The `MAX_PROOF_AGE` window is 5 minutes. The `MAX_CLOCK_SKEW` future-cap is 60 seconds. Both are enforced in `TwinAccount.execute`. Outside these windows, the verifier rejects.

## Audit history

| Date | Auditor | Scope | Outcome |
|---|---|---|---|
| 2026-05-27 | Internal security review | Original twin/JWT design | No critical/high findings. Three low-severity defensive fixes applied. Report: `SECURITY_REVIEW.md`. |
| TBD | External | `AttestorVerifier` + revised twin | Recommended before mainnet adoption with real value |

## Reporting vulnerabilities

Email `security@<your-org>` with reproducer. Bounty terms in `SECURITY_BOUNTY.md` (not yet drafted).
