# SocialTwin v2 — Adversarial Red-Team Findings

Scope: `contracts/TwitchJWTVerifier.sol`, `contracts/TwinAccount.sol`, `contracts/TwinFactory.sol`,
`claim-site/app/api/relay/route.ts`. Goal was attack vectors NOT already covered by the existing
test suites (`RedTeam.test.ts`, `TwitchJWTVerifier.test.ts`, `TwinV2Features.test.ts`, `E2EJourney.test.ts`).

Bottom line: the **onchain contracts are solid** — I could not break the JWT verifier, the action-hash
binding, the nonce/replay model, the PKCS#1 check, or the rescue gating. The **relayer endpoint has one real
Critical flaw** (no factory allowlist on the `twin` address) plus a couple of supporting Medium/Low issues.
Severities below are honest; I have not inflated anything.

---

## CRITICAL

### C-1 — Relayer accepts an arbitrary `twin` address → unauthenticated gas drain (and SSRF-style abuse)
**Location:** `claim-site/app/api/relay/route.ts`, lines 83–109, 114–138.

**The flaw.** The route validates only `isAddress(twin)`, `isHex(jwt)`, `method ∈ {execute, setOwnerEOA}`,
and the per-method arg shapes. It **never checks that `twin` was deployed by the trusted `TwinFactory`** (no
`predictAddress`/`isDeployed`/code-hash check exists in the file — confirmed by grep). It then calls
`twin.execute(...)` / `twin.setOwnerEOA(...)` from the funded `RELAYER_PRIVATE_KEY`, paying gas.

The endpoint's own comment claims it is "POWERLESS" because "any tampering reverts" and "producing a JWT already
requires a real Twitch login." **Both assumptions are false when `twin` is an attacker contract**, because the
attacker's contract implements `execute(address,uint256,bytes,uint256,uint256,uint256,bytes) returns(bytes)`
itself and simply ignores the JWT.

**Concrete exploit (no JWT, no Twitch login required):**
1. Attacker deploys a contract `Sink` on Base with a function
   `execute(address,uint256,bytes,uint256,uint256,uint256,bytes) returns (bytes)` that does heavy work
   (e.g. a `for` loop spinning until near the gas limit, or many `SSTORE`s) and then returns `0x`.
   It does **not** revert, so it succeeds identically under `eth_call` and onchain.
2. Attacker POSTs `{ method:"execute", twin: <Sink>, target:"0x..00", value:"0", data:"0x", nonce:"0",
   deadline:"0", oauthExchangeEpoch:"0", jwt:"0x00" }`. All shape checks pass (`isHex("0x00")` is true).
3. `simulateContract` runs `Sink.execute(...)` via eth_call → returns success (no revert) → the "we never pay
   gas for a reverting call" guard does **not** trigger.
4. `wallet.writeContract(call)` submits a real tx. **The relayer pays gas** for attacker-chosen computation.
5. Repeat up to `DAILY_TX_CAP` (default **500**) times per day. Each tx can be crafted to consume close to the
   per-tx gas the relayer's wallet will sign (gas is auto-estimated against the malicious contract, which can
   report/consume a very large amount). The relayer EOA is drained of ETH with zero attacker cost beyond
   one cheap `Sink` deployment and 500 HTTP requests.

**Impact.**
- **Direct:** unauthenticated, repeatable drain of the relayer's Base ETH (denial-of-service for all legitimate
  gasless users once the key is empty; ongoing operational cost). The daily cap bounds it per-day but does not
  prevent day-after-day depletion, and 500 max-gas txs is already a meaningful ETH loss.
- **Secondary (SSRF/confused-deputy):** every relayed call executes with `msg.sender = relayerEOA` against an
  attacker-controlled contract. Today the relayer is a bare EOA, so an attacker cannot pull its ETH via a call
  (you can't `transferFrom` an EOA's balance). **But** the moment that key is ever granted an ERC-20 allowance,
  made an admin/owner of any contract, or — per the file's own roadmap — swapped to **CDP-sponsored sends**
  (where being `msg.sender`/the sponsored origin has standing), the attacker contract becomes a lever to act
  *as the relayer*. This is a latent privilege-escalation, not just gas burn.

**Why existing tests miss it.** All tests construct `twin` from `factory.predictAddress(...)`; none feed a
hostile contract address to the relayer, and the relayer has no unit tests at all.

**Fix (defense in depth, do all three):**
1. **Allowlist by factory:** recompute the expected twin address and reject mismatches. The factory's
   `predictAddress(userId)` is pure CREATE2 — derive `userId` from the JWT `sub` (decode + verify client-side or
   re-derive) and require `twin === factory.predictAddress(sub)`. Cheaper alternative: `eth_getCode(twin)` and
   require the code hash equals the known `TwinAccount` runtime code hash, AND that the factory records it
   (`factory.isDeployed(userId)`). Reject anything else with 400.
2. **Authenticate before spending gas:** verify the JWT signature + freshness **server-side** (or via a cheap
   `eth_call` to the real verifier) before `writeContract`, so a request with a bogus/absent JWT never reaches
   the submit step regardless of `twin`.
3. **Cap gas per relayed tx** explicitly (`gas` field on `writeContract`) to a tight bound for the known
   `execute`/`setOwnerEOA` shapes, so even an accepted call can't consume an unbounded amount. Also make the
   daily cap per-source-IP / per-twin rather than a single global counter.

---

## MEDIUM

### M-1 — Relayer simulate→submit TOCTOU lets a passing simulation become a paid revert
**Location:** `route.ts` lines 114–138.

`simulateContract` (eth_call at the latest block) and `writeContract` are two separate RPC round-trips, and the
fallback transport may even route them to **different nodes** at **different block heights**. Between them, state
can change so that the simulated success becomes an onchain revert that the relayer still pays gas for:
- A legitimate `execute` simulates against `nonce = N`. Another relayed (or direct) tx consumes `nonce N` first.
  The submitted tx now reverts with `WrongNonce` — relayer pays the base/intrinsic gas of a reverting tx.
- The malicious-twin variant of C-1 can be made to **succeed in eth_call but revert onchain** (e.g. branch on
  `block.number`/`gasleft()` differences between simulation and mining), again forcing the relayer to pay for a
  revert.

**Impact.** Bounded gas griefing even after C-1's allowlist is added; lets an attacker (or just bad luck under
concurrency) make the relayer pay for reverting transactions. Lower severity than C-1 because cost per event is
the intrinsic gas of a revert, not full computation.

**Fix.** Pin both calls to the same `blockNumber`; serialize relayed sends per-twin to avoid self-induced nonce
races; accept that some reverts will be paid and cap exposure via the gas cap + per-twin/IP rate limit from C-1.

### M-2 — Relayer diagnostic path parses attacker-controlled JWT with `JSON.parse` and logs it unbounded
**Location:** `route.ts` lines 119–132.

On a would-revert, the handler does `Buffer.from(jwt.slice(2),"hex")`, `.split(".")`, base64-decodes, and
`JSON.parse` the header/payload, then `console.error`s the full decoded header/payload and request args. The
input is fully attacker-controlled (a request with `twin` = any address and arbitrary `jwt` hex always reaches
this branch when simulation reverts). Risks:
- **Log injection / log flooding:** attacker sends a megabyte-scale `jwt` hex (no length cap anywhere) →
  large buffers decoded and serialized into logs on every request, amplifying the C-1 DoS into log/disk/cost
  pressure. `JSON.parse` on attacker bytes is also a CPU sink.
- **Sensitive-data leakage** if logs are shipped to a shared sink: full JWTs (bearer credentials) are written to
  logs verbatim, which is a credential-handling anti-pattern.

**Fix.** Reject oversized bodies/`jwt` (e.g. cap `jwt` length to a few KB) before any work. Remove or gate the
verbose JWT logging behind a dev-only flag, and never log raw tokens (truncate/redact). Wrap `JSON.parse` in the
existing try/catch (it already is) but also bound input size first.

---

## LOW

### L-1 — `execute` allows attacker-relayed **no-op activation** that permanently kills the rescue path
**Location:** `TwinAccount.sol` `execute` (line 96 sets `activated = true`) and `rescueAbandoned` (line 223).

`execute`/`executeBatch`/`setOwnerEOA` set `activated = true` whenever a valid JWT is presented — including a
JWT that authorizes a **harmless no-op** (`target = anyAddr, value = 0, data = 0x`). The existing test
`"rescue is blocked once the twin executed even once via JWT"` treats this as intended.

The adversarial angle the tests don't consider: this requires a **valid JWT for that exact user**, so only the
real streamer (or someone who phished their Twitch login) can trigger it. That means it is **not** an external
griefing vector against a third party. The only residual risk: a streamer who does a single zero-value action
and then loses their key forever has *intentionally* forfeited the abandoned-funds rescue (rescue only ever
applies to never-activated twins). This is by design and acceptable; flagged as **Low/Info** only so the team is
explicit that "activated" is a one-way latch that disables rescue, and a user who activates-then-loses-keys with
no `ownerEOA` set has unrecoverable funds. Consider documenting this in user-facing copy.

### L-2 — `value` parameter trust in the relayer is fine onchain but unvalidated in the route
**Location:** `route.ts` line 98 (`BigInt(value)`).

`value` is `BigInt(value)` with no validation; a non-numeric `value` throws and is caught as `bad_args` (fine),
but the inner `value` is the **twin's own** spend amount (bound into the action_hash and JWT), so the relayer
mis-specifying it just causes an action-hash mismatch and a (simulated) revert. No fund risk. Noted for
completeness: the route does not and need not validate `value` semantically because the contract binding does.

---

## Areas I tried hard to break and could NOT (these HOLD)

These go beyond the team's enumerated list and are reported as **negative results** with the reasoning, so the
team knows they were actually checked rather than assumed.

**JWT parser smuggling (item #1) — solid.** The signature is computed over the **raw base64url segments**
(`sha256(headerB64 . "." . payloadB64)`, line 76), *not* over decoded bytes. The `_b64Decode` loop's
`else continue` (line 258) silently skips invalid characters, which is normally a smuggling risk — but here any
character you add/remove/alter to change the decoded JSON also changes the signed raw segment, breaking the RSA
check. You cannot make the decoded payload differ from what Twitch signed. Confirmed safe.

**Duplicate / mis-segment claims — solid.** `_indexOf` returns the *first* match, and header (`alg`,`kid`) vs
payload (`iss`,`sub`,`iat`,`nonce`) are parsed from **separate** decoded byte arrays, so a header claim can't be
read as a payload claim. A duplicate claim would have to exist inside the *Twitch-signed* payload to matter, and
an attacker can't alter signed bytes. The JSON-escaping defense (already tested as B1) blocks injecting a fake
earlier `"sub":"`/`"nonce":"` via username/picture fields because the injected `"` is emitted as `\"` (`0x5c22`)
and never matches the needle's bare `"` (`0x22`).

**`_parseDecimal` / `_extractNumberClaim` overflow & edge cases — solid.** `_parseDecimal` uses checked
arithmetic (0.8.24); a `sub` large enough to overflow uint256 reverts rather than wrapping, and any value is
compared exactly to the uint64 `userId`, so leading zeros (`"01507305235"`) still resolve to the *same* user —
not a cross-user attack. Missing `sub` → empty → `WrongSub`. `_extractNumberClaim` for `iat`: missing → returns
`0` → `0 != oauthExchangeEpoch` (which must be within 60s of now, hence non-zero) → `WrongIat`. A huge/overflow
`iat` can't pass because it's checked against `block.timestamp + MAX_CLOCK_SKEW`. Negative/scientific notation
aren't digits, so parsing stops at the first non-digit. All safe.

**`nonce` length/format — solid.** `_eq` checks length first; the nonce must be exactly the 66-char lowercase
`0x`+64-hex string produced by `_bytes32ToHexString`. Wrong length, uppercase, or missing `0x` → `WrongNonce`.

**PKCS#1 v1.5 strictness (item #2) — solid, no Bleichenbacher gap.** For the fixed 256-byte modexp output the
check covers **every byte**: `[0]=0x00`, `[1]=0x01`, `[2..203]=0xFF` (202 bytes), `[204]=0x00`,
`[205..223]`=19-byte DigestInfo, `[224..255]`=32-byte hash. 2+202+1+19+32 = 256, fully accounted. There is no
unchecked suffix/prefix region for a forged decoded value to hide in, and `e=65537` is enforced. Sound.

**modexp encoding (item #3) — solid.** `sig.length != 256 || mod.length != 256` is rejected up front
(line 196), exponent is the canonical 3-byte `0x010001`, the precompile input is the standard
`(len|len|len|base|exp|mod)` layout, output length is asserted == 256 (line 199), and `staticcall` failure
reverts. `sig = 0/1` simply produce a decoded block that fails the strict padding check.

**`executeBatch` action_hash collision (item #4) — solid.** `keccak256(abi.encodePacked(targets))`,
`...(values)`, `...(dataHashes)` each pack **fixed-width** elements (20-byte addresses, 32-byte uints, 32-byte
hashes). Packed encoding is only ambiguous across arrays of *different* element widths or with dynamic/variable
elements; here all three are uniform-width and the lengths are independently enforced equal
(`targets.length == values.length == datas.length`), so a re-split into different array boundaries changes the
total byte length and therefore the hash. No collision. (And the per-call `data` is hashed with `keccak256(datas[i])`
before packing, so variable-length `data` can't blur boundaries either.)

**Ignoring `exp`, replay within iat window (item #5) — safe.** The contract never reads `exp`, but
`iat + MAX_PROOF_AGE` (5 min) is a *tighter* bound than Twitch's typical 1-hour `exp`, so ignoring `exp` only
makes the acceptance window smaller. A captured-but-unused JWT is usable for at most 5 minutes and only for the
exact `_nonce` it was bound to; the moment any action advances `nonce`, the captured JWT yields `WrongNonce`.

**Reentrancy (item #6) — safe.** `nonce` is advanced and `activated` set **before** the external `target.call`
in both `execute` (lines 95–98) and the `executeBatch` loop (line 119 before line 124), and every external entry
point is `nonReentrant`. A reentrant call back into the same twin during the batch hits the guard (revert) or,
if it were a fresh tx, would see the already-advanced nonce. Cross-twin reentrancy gains nothing because each
twin has its own guard and its own nonce/JWT binding.

**`setOwnerEOA` replay / stale override (item #7) — safe.** A *fresh* phished setOwner JWT can repoint the owner
(documented and accepted). A *stale* setOwner JWT cannot: its `_nonce` was either already consumed (→ advanced)
or is for an old nonce (→ `WrongNonce`). The JWT path can override an EOA-set owner only with a fresh JWT, which
is the intended "Twitch-alive recovery" property (tested in V2 features).

**`rescueAbandoned` griefing (item #8) — safe.** `rescueAbandoned` sets `activated = true` and `ownerEOA`, so it
can run **at most once** (a second call hits `AlreadyActivated`). The rescuer cannot repeatedly re-point. The
real owner can still reclaim afterward via a fresh JWT (`setOwnerEOA`), which is intended. The rescuer role is
non-zero and non-renounceable by design; transfer is gated to the current rescuer.

**CREATE2 / factory (item #10) — safe.** `deployTwin` is idempotent (`if (twin.code.length == 0)`), no
`selfdestruct` exists so an address can't be vacated and re-squatted, `userId == 0` is rejected, and
front-running `deployTwin` is harmless because the address is fully determined by `(factory, userId, verifier)`
and the constructor takes no caller-controlled input. The deployer/relayer of a twin gains no privilege.

---

## Priority for the team
1. **Fix C-1 before real funds flow through the relayer** — add the factory allowlist + server-side JWT
   verification + per-tx gas cap. This is the one finding that is exploitable by an anonymous party today.
2. Address **M-1/M-2** as relayer hardening (block pinning, input-size caps, redact token logging).
3. Document **L-1** (activation is a permanent one-way latch that disables rescue) in user copy.

---

## Remediation status (applied 2026-06-02)

- **C-1 (Critical) — FIXED & VERIFIED.** `claim-site/app/api/relay/route.ts` now derives `sub` from the JWT and requires `twin == factory.predictAddress(sub)` before doing anything. An arbitrary/attacker contract address can't equal `predictAddress(sub)` (CREATE2 preimage), so the relayer only ever calls canonical factory twins. Verified: attacker address `0x…dEaD` → HTTP 403 `twin_not_canonical`; canonical twin → passes guard, reaches onchain verification. Also added: JWT length cap (`MAX_JWT_HEX_LEN`), per-tx gas cap (`MAX_GAS = 3M`, submit uses estimateGas×1.2), so a single relayed call can't burn unbounded gas.
- **M-1 (TOCTOU) — mitigated/accepted.** With C-1 in place, the only relayable calls are real twins executing real JWT-authorized actions; a simulate→submit race can at most waste one tx's gas (~$0.02) if someone front-runs the nonce. Bounded; acceptable. Gas cap limits the per-tx exposure.
- **M-2 (log flooding / token leak) — FIXED.** JWT length is capped before any processing, and the diagnostic log no longer dumps the full token/claims — only a truncated revert reason + twin/method/sub.
- **L-1 (activated latch) — documented.** Behavior is intended (activation permanently disables abandoned-rescue, and is only reachable with a valid JWT for that user). A user who activates, never connects an escape EOA, and loses Twitch access has unrecoverable funds — same fate as losing a wallet key; surfaced in PERMANENCE.md.

**Onchain contracts: no findings — clean.** 100/100 tests pass incl. the 22-vector RedTeam suite.

---

## Live mainnet red-team — v1.3 stack, against a funded twin (2026-06-03)

Unlike the sections above (local hardhat + relayer code review), this round was run **against the live
Base-mainnet v1.3 deployment**, attacking a **real twin holding real funds**:

- **Target twin:** [`0xcBeaF766D4a7DD61558d4E80ee58B8B8379d4CEf`](https://basescan.org/address/0xcBeaF766D4a7DD61558d4E80ee58B8B8379d4CEf) — Twitch `yougotcoined` (`userId 1507305235`), balance ~`0.0002 ETH`, state at test time: `nonce 0`, `ownerEOA 0x0`, `activated false`, `selfCustody false`.
- **Verifier:** `0xBDfC552469f11843802BCD7ec9a8372c8020fee8` · **Factory:** `0x260C074c3afDc46A209D4619B5FAdB2964dF9a28`.
- **Attacker:** a freshly-generated EOA with **no funds and no role** (audAdmin/keyAdmin/guardian/rescuer all held by other addresses).
- **Method:** each malicious transaction was run as an `eth_call` with `from = attacker` against the live contracts. `eth_call` requires no signature and executes the contract's real logic at head state, so a call that **does not revert** would prove the action is permitted (a real drain path); a revert proves the guard holds. No state was committed; the twin's balance was read before and after and was unchanged.

**Headline attempt — forged, perfectly-formed Twitch token.** I generated my own RSA-2048 keypair, built a JWT with **every claim correct** (`iss=https://id.twitch.tv/oauth2`, `aud=epeocrogq8bm1af0lngd9e2rfvrwk1`, `sub=1507305235`, fresh `iat`, and `nonce = computeActionHash(attacker, fullBalance, …)` read from the twin so the action-hash binding was exact), signed it with my key, and called `execute(...)` to send the whole balance to the attacker. The verifier rejected it with **`BadSignature()`** — the RSA modexp check against Twitch's modulus is the real gate, and forging it requires Twitch's private key. Same token straight to `verifier.verify()` → `BadSignature()`.

### Result: 29 attempts, 0 breaches, funds untouched (0.0002 → 0.0002 ETH)

| # | Attack (as unprivileged attacker) | Live result |
|---|---|---|
| A1 | `execute` drain w/ garbage JWT | `BadJwtShape()` |
| A2 | `execute` drain w/ **forged valid-shape token, attacker RSA key** | **`BadSignature()`** |
| A2b | `verifier.verify` on the forged token | `BadSignature()` |
| A3 | `execute` w/ `alg:"none"` confusion | `WrongAlgorithm()` |
| A4 | `executeBatch` drain w/ garbage JWT | `BadJwtShape()` |
| A5 | `setOwnerEOA(attacker)` hijack w/ garbage JWT | `BadJwtShape()` |
| A6 | `execute` w/ wrong nonce (5 vs 0) | `WrongNonce(0,5)` |
| A7 | `execute` w/ deadline in the past | `DeadlinePassed()` |
| A8 | `execute` w/ stale proof (`iat` 1h old) | `ProofTooOld()` |
| A9 | `execute` w/ future proof (`iat` +1h) | `ProofFromFuture()` |
| A10 | `execute` w/ forged token, unknown `kid=2` | `UnknownKey()` |
| B1 | `executeAsOwner` drain as non-owner | `NotOwner()` |
| B2 | `executeBatchAsOwner` drain as non-owner | `NotOwner()` |
| B3 | `rotateOwnerEOA(attacker)` as non-owner | `NotOwner()` |
| C1 | `initiateRescue()` as non-rescuer | `NotRescuer()` |
| C2 | `completeRescue(attacker)` as non-rescuer | `NotRescuer()` |
| D1 | `queueAud(attacker app)` | `NotAudAdmin()` |
| D2 | `removeAud(legit client_id)` (grief users) | `NotAudAdmin()` |
| D3 | `setAudCheckEnabled(false)` (open phishing) | `NotAudAdmin()` |
| D4 | `lockOpenForever()` | `NotAudAdmin()` |
| D5 | `transferAudAdmin(attacker)` | `NotAudAdmin()` |
| D6 | `queueKey(kid=1, attacker modulus)` (inject forging key) | `NotKeyAdmin()` |
| D7 | `commitKey(1)` | `NotKeyAdmin()` |
| D8 | `cancelKey(1)` (grief rotation) | `NotGuardianNorKeyAdmin()` |
| D9 | `transferKeyAdmin(attacker)` | `NotKeyAdmin()` |
| D10 | `transferGuardian(attacker)` | `NotGuardianNorKeyAdmin()` |
| E1 | `transferRescuer(attacker)` | `NotRescuer()` |
| E2 | `deployTwin(99999)` | **did not revert — permissionless by design** |
| E3 | `deployTwin(1507305235)` (re-deploy/squat) | **did not revert — idempotent no-op** |

**On E2/E3 (the only non-reverting calls).** Deploying twins is intentionally permissionless and **confers no control**: the address is fully determined by `(factory, userId, verifier)`, the constructor takes no caller input, `deployTwin` is idempotent (`if (twin.code.length == 0)`), and there is no `selfdestruct`, so an address can't be vacated and re-squatted. A twin's deployer cannot execute, cannot set an owner, and cannot rescue. With the rescue clock running from `initiateRescue()` intent (not deploy time), pre-deploying a victim's twin gains nothing — this is exactly the v1.1 fix to audit Finding 1, confirmed live.

**Conclusion.** From an unprivileged position, every fund-moving path (JWT execute/batch, owner path), every hijack path (`setOwnerEOA`, `rotateOwnerEOA`), the rescue flow, and every verifier/factory admin function rejected the attacker. The signature/binding/freshness guards fire in the right order (`WrongNonce` → `DeadlinePassed` → `ProofTooOld`/`ProofFromFuture` → `BadSignature`/`WrongAlgorithm`/`UnknownKey`), giving defense-in-depth. The residual risks remain the **documented** ones requiring privileged-key compromise or social engineering (audAdmin/keyAdmin+guardian collusion, phishing a streamer into signing a malicious bound action) — none reachable by an anonymous attacker, and none a contract-level bug. **No onchain findings.**
