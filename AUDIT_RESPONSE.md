# Audit Response

External review by **Sterling Crispin** (commit `1aeed2e`, branch `main`) — original report:
<https://gist.github.com/sterlingcrispin/b008338c386dd4c27ef88c8b921d8c9d>

The review found **no "anyone can forge and drain" vulnerability** and confirmed all 103 tests passed and the SDK initcode matched the compiled artifact. It raised seven design/implementation issues. This document records each one and exactly what changed in response.

> **Deployment status:** the v1.1 stack is **deployed and Basescan-verified** on Base mainnet:
> `TwinFactory` [`0x4318db7BeDF879A43B77fa608248bBF78423bBDa`](https://basescan.org/address/0x4318db7BeDF879A43B77fa608248bBF78423bBDa#code) · `TwitchJWTVerifier` [`0xEaD1e986407d899fD00A8733F48Fd87DeeB33A4e`](https://basescan.org/address/0xEaD1e986407d899fD00A8733F48Fd87DeeB33A4e#code).
> Verified source ⇒ the deployed bytecode equals the code reviewed here and exercised by the test suite. The pre-audit v1.0 stack is deprecated (see README). A live adversarial matrix was run post-deploy (see "Post-deploy red-team" below).

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | Abandoned-twin rescue timing | High | ✅ Fixed (contract) |
| 2 | OAuth blind-signing / allowlist trust | High | ✅ Mitigated (timelock + 7730 + docs) |
| 3 | SDK hash computation bug | High/Med | ✅ Fixed (SDK) |
| 4 | AttestorVerifier 1-of-N trust | Med | ✅ Removed |
| 5 | JWT key-rotation risk | Med | ✅ Documented (playbook + watchdog) |
| 6 | Custom parsing needs fuzzing | Med | ✅ Fuzz suite added; external audit still recommended |
| 7 | Documentation / script drift | Low/Med | ✅ Fixed |

---

## Finding 1 — Abandoned-twin rescue timing (High) ✅ Fixed

**Issue.** `deployTwin` is permissionless and the old rescue clock started at `deployedAt` (deploy time). An attacker could pre-deploy a victim's twin to start the 90-day clock early; once it elapsed, the rescuer could take funds that arrived *at any later time* — including funds deposited that same day. The "90 days since the funds arrived" protection was effectively defeated.

**Fix.** Rescue is now **two-phase and intent-based** (`contracts/TwinAccount.sol`):

1. `initiateRescue()` — the factory's rescuer signals intent; this starts a fresh `RESCUE_DELAY` (90-day) countdown from **now**, and emits `RescueInitiated`.
2. `completeRescue(designatedEOA)` — allowed only after the delay elapses **and** the twin is still never-activated.

Because the clock runs from the rescuer's public signal — not from deploy — the owner always gets a full 90-day window regardless of when the twin was deployed or funded, and the pre-deploy attack is neutralized. Any JWT `execute`/`setOwnerEOA` activates the twin and permanently blocks rescue (the owner "showing up" is the cancel). New errors: `RescueNotInitiated`. Regression test: *"pre-deploy timing attack neutralized: clock runs from intent, not deploy"* in `test/TwinV2Features.test.ts` and `test/RedTeam.test.ts` (F4).

## Finding 2 — OAuth blind-signing / allowlist trust (High) ✅ Mitigated

**Issue.** Twitch users authorize via the Twitch consent screen, which can't display transaction details ("blind signing"). Security leans on the `aud` allowlist curated by `audAdmin`; a compromised admin (or open mode) widens the phishing surface.

**On the ERC-7730 "clear signing" idea:** clear signing is a *wallet transaction-display* standard. It does **not** fix the Twitch-consent blind-signing, because that authorization happens at the OIDC provider, not in a wallet. It *does* improve the self-custody **owner-EOA** path (`executeAsOwner`/`setOwnerEOA`), which are ordinary wallet transactions. So we addressed F2 three ways:

1. **Timelocked allowlist additions** (`TwitchJWTVerifier`): `addAud` is replaced by `queueAud` → wait `AUD_TIMELOCK` (2 days) → `commitAud`. A compromised `audAdmin` can no longer *instantly* allowlist a phishing app — the pending add is public for 2 days. `removeAud`, `setAudCheckEnabled(false)`, and `lockOpenForever()` stay **immediate** (safety direction is never delayed). Operationally, `audAdmin` should remain a multisig.
2. **ERC-7730 descriptor** (`clear-signing/socialtwin.7730.json`) so wallets clear-sign the owner-EOA path.
3. **dApp requirement, documented:** integrators MUST show the exact action (recipient, amount, twin) in their own UI before redirecting to Twitch. The action hash binds the JWT to that exact call, so a tampered call reverts onchain — but the human approving still needs to see what they approve. This is now called out in the SDK (`buildSpendFlow` docstring) and `PROTOCOL.md`.

## Finding 3 — SDK hash computation bug (High/Med) ✅ Fixed

**Issue.** `sdk/src/oauth.ts` hardcoded `userId: 0n` in `buildSpendFlow`, with a comment claiming it was "bound implicitly." But `computeActionHash` encodes `userId` as a `uint64` field and the contract uses the real `userId`, so the SDK produced a hash that never matched onchain → verification reverts. (The live claim site was unaffected — it reads `computeActionHash` from the contract directly — but SDK integrators were broken.)

**Fix.** `SpendIntent` now carries `userId`, and `buildSpendFlow` threads the real value into the hash. While here, the SDK was also **reframed from the vestigial attestor model to the deployed Twitch-JWT flow** (it now builds the `id.twitch.tv/oauth2/authorize` URL and parses the returned `id_token`), resolving the same drift noted in Findings 4 and 7.

## Finding 4 — AttestorVerifier 1-of-N trust (Medium) ✅ Removed

**Issue.** The optional `AttestorVerifier` used a 1-of-N approved-signer model — an oracle/guardian, contradicting the protocol's decentralization claims. It was **never part of the deployed stack** (deployed verifier is `TwitchJWTVerifier`).

**Fix.** Removed `contracts/AttestorVerifier.sol`, its tests, the `ATTESTOR_VERIFIER_ABI` SDK export, and `docs/ATTESTOR_OPERATIONS.md`; the SDK was reframed off the attestor model (Finding 3). Attestor-era design docs are retained with a deprecation banner for historical context only.

## Finding 5 — JWT key-rotation risk (Medium) ✅ Documented

**Issue.** Twitch's RSA moduli are baked into the verifier at construction; if Twitch rotates keys, the JWT path could stall.

**Resolution (deliberately not a code change).** We considered an admin `addKey(kid, modulus)` and **rejected it**: letting any admin inject an RSA modulus would let them forge "Twitch" JWTs and drain any twin — strictly worse than the rotation risk. Instead, key rotation follows a transparent, observable playbook (deploy a new verifier+factory with the new modulus; users migrate or use their escape-EOA). Mitigations already present: the **escape-EOA path is unaffected** (no JWT), and the **JWKS watchdog** alerts on `kid`/modulus changes with weeks of lead time. See `SECURITY.md` → "Twitch key rotation."

## Finding 6 — Custom parsing needs fuzzing (Medium) ✅ Suite added

**Issue.** The verifier hand-rolls base64url decode, JSON claim extraction, decimal parsing, and RSA PKCS#1 v1.5 in Solidity — correctness-critical, easy to get subtly wrong, and unfuzzed.

**Fix.** Added `test/FuzzVerifier.test.ts` — a property suite asserting the one-directional invariant *"never accept anything but a genuine, matching Twitch token"* against: random byte blobs, structurally-valid tokens signed by the wrong key, each individually-mutated claim, `alg=none`/`HS256` confusion, truncation at every prefix length, and a quote-injection attempt in `preferred_username` (confirming JSON escaping prevents sub-hijacking). An external audit + a dedicated fuzzing campaign of this code remain **recommended before large value** — this suite locks the invariant, it does not replace specialist review.

## Finding 7 — Documentation / script drift (Low/Med) ✅ Fixed

- Deploy scripts: `scripts/deploy-local.ts` called the verifier constructor with 2 of its 4 args — fixed to `(kids, moduli, auds, audAdmin)` and now disables the aud check for the local harness. `scripts/deploy-twin-factory.ts` referenced a nonexistent `renounceRescuer()` — corrected to `transferRescuer`.
- `TwinFactory.sol` NatSpec claimed the rescuer was "renounceable (set to address(0))" while the code forbids zero — corrected to "non-renounceable, transferable."
- Privileged roles (`audAdmin`, `rescuer`) are now enumerated in `ARCHITECTURE.md`.
- v1→v2 / attestor→JWT references across docs updated; attestor-era docs banner-marked.

---

## Post-deploy red-team (v1.1, live on Base mainnet)

After deploying + verifying, an adversarial `eth_call` matrix was run against the live contracts and a real twin (`0xa6743f05Aca670d69DFC04Ab7Ab30678ef2A0Ec9`). All checks passed — every malicious call reverts and every honest invariant holds:

**Rescue (the focus):**
- `completeRescue()` with no prior `initiateRescue()` → reverts `RescueNotInitiated` ✓
- `initiateRescue()` / `completeRescue()` from a non-rescuer → reverts `NotRescuer` ✓
- `completeRescue(address(0))` → reverts `ZeroAddress` ✓
- `initiateRescue()` from the treasury rescuer → permitted (intended) ✓
- fresh twin: `rescueAllowedAt() == 0`, `isRescuable() == false`, `ownerEOA == 0`, `activated == false` ✓
- The 90-day timelock (clock from intent, not deploy), activation-cancels-rescue, and the pre-deploy-attack-neutralized property are proven by the time-traveled hardhat tests against this exact Basescan-verified bytecode.

**Other paths:**
- `executeAsOwner` by a non-owner → reverts `NotOwner` ✓
- `execute` with a bogus JWT → reverts (`ProofFromFuture` / verifier rejection) ✓
- `queueAud` by a non-admin → reverts `NotAudAdmin` ✓
- `commitAud` of an un-queued aud → reverts `"not queued"` ✓

This is access-control + revert-path coverage on the live deployment; it complements (does not replace) the recommended external audit + fuzzing of the JWT verifier.

## Not changed (and why)

- **Slither / static analysis:** not run in the original review; recommended as part of the external audit.
- **44 transitive dev-dependency advisories:** dev-only (Hardhat toolchain), not in any deployed artifact. Tracked, not blocking.
- **`SocialTwinEscrow.sol`:** legacy prototype, never deployed; retained as reference and clearly labeled.
