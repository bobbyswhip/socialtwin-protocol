# SocialTwin Protocol

**Every Twitch user already has a smart account on Base — they just haven't claimed it yet.**

SocialTwin gives every Twitch account a deterministic smart-contract wallet (a "twin") whose address is derived purely from the Twitch numeric `user_id`. Anyone can send funds to a streamer by their Twitch identity — community-coin trading fees, tips, rewards — **before that streamer has ever connected a wallet, signed a transaction, or even heard of the protocol**. The streamer later claims and controls the twin by signing in with Twitch, with the login proof **verified entirely onchain**. There is no oracle, no witness network, and no off-chain protocol in the trust path.

> **Status:** Live on Base mainnet (**v1.3**), Basescan-verified. Security rests on the design itself — deterministic addresses, fully onchain JWT verification, **one-way self-custody** (linking a wallet permanently disables the Twitch path for that twin), and **timelocked signing-key rotation** (a Twitch key rotation can't permanently lock funds) — backed by 84 tests including 22+ adversarial vectors and a parser fuzz suite. Findings from internal red-teaming and an external review are addressed in [`AUDIT_RESPONSE.md`](AUDIT_RESPONSE.md). **Not yet formally audited — commission a full external audit of the JWT verifier before routing large value.**

---

## Why this exists

The hard problem with "send crypto to a social handle" is custody: how do you address funds to someone who has no wallet, guarantee only *they* can ever spend it, and not rely on a company staying online to make that true?

SocialTwin solves it with two ideas borrowed from the design of cross-chain bridges:

1. **Deterministic addresses.** A twin's address is a pure function of the Twitch `user_id` via `CREATE2`. You can compute it offline and fund it before the contract exists.
2. **Permissionless settlement.** Spending is authorized by a fresh Twitch OIDC `id_token` that the contract verifies onchain (RSA-2048 / SHA-256). *Anyone* can broadcast the transaction — the JWT is the authorization, not the sender. If our servers vanish, any wallet on Earth can still submit a user's withdrawal.

The result: fund-by-identity with self-custody guarantees, no trusted relayer in the spend path, and a clean upgrade path to a self-custody wallet the user fully owns.

---

## Live deployment — v1.3 (Base mainnet · chainId 8453)

The current stack: intent-based rescue + timelocked aud allowlist (v1.1), one-way self-custody (v1.2), timelocked signing-key rotation (v1.3). Source-verified on Basescan.

| Contract | Address | Role |
|---|---|---|
| `TwinFactory` (v1.3) | [`0x260C074c3afDc46A209D4619B5FAdB2964dF9a28`](https://basescan.org/address/0x260C074c3afDc46A209D4619B5FAdB2964dF9a28#code) | Derives & deploys twins (`CREATE2`) |
| `TwitchJWTVerifier` (v1.3) | [`0xBDfC552469f11843802BCD7ec9a8372c8020fee8`](https://basescan.org/address/0xBDfC552469f11843802BCD7ec9a8372c8020fee8#code) | Onchain Twitch OIDC JWT verification; 2-day `aud` timelock + 7-day signing-key rotation |
| Treasury (multisig) | [`0xD1EC8245c8850A151843ce8a3AFdca3b19747706`](https://basescan.org/address/0xD1EC8245c8850A151843ce8a3AFdca3b19747706) | `audAdmin` + `guardian` (signing-key rotation veto) + abandoned-funds `rescuer` |
| `keyAdmin` (operator) | `0xa825094B04D5a3710bd41C4fbC902F75cF333333` | queues/commits signing-key rotations; a hot key distinct from the cold treasury `guardian`, so the cold key holds the veto |

Source-verified. Salt domain: `"SocialTwin:twitch:v2"`. Twitch issuer `https://id.twitch.tv/oauth2`, signing key `kid="1"`. Sample twin (`yougotcoined`): [`0xcBeaF766D4a7DD61558d4E80ee58B8B8379d4CEf`](https://basescan.org/address/0xcBeaF766D4a7DD61558d4E80ee58B8B8379d4CEf).

---

## How it works

```
                       send funds by identity (anyone, anytime)
                                      │
   user_id ──CREATE2──►  TWIN ADDRESS ◄──── ETH / ERC-20 sit here, fully owned, before any claim
   (Twitch)             0xTWIN…
                            │
            ┌───────────────┴────────────────┐
            │                                 │
   ① Twitch JWT path                  ② Owner path (self-custody)
   execute(... , jwt)                 executeAsOwner(...)
   • JWT verified ONCHAIN            • after setOwnerEOA links a wallet
   • permissionless to submit        • plain wallet signature, NO Twitch
   • bootstrap + recovery            • everyday spending, survives Twitch
```

### 1. Deterministic address
```
salt     = keccak256(abi.encodePacked("SocialTwin:twitch:v2", uint64(userId)))
initCode = TwinAccount.creationCode ++ abi.encode(uint64(userId), address(verifier))
twin     = CREATE2(factory, salt, keccak256(initCode))
```
Compute it onchain with `TwinFactory.predictAddress(userId)` or offline with the SDK's `predictTwinAddress(...)`. Fund it by sending to that address. Deploy the bytecode lazily with `TwinFactory.deployTwin(userId)` (permissionless, idempotent) the first time someone needs to call a function on it.

### 2. Claiming via Twitch (onchain JWT verification)
The action a user wants to take is hashed and embedded into the OAuth `nonce`:
```
actionHash = keccak256(abi.encode("TwinAccount:v2:execute",
               chainid, twin, userId, target, value, keccak256(data), nonce, deadline))
```
The user is sent through Twitch's OIDC **implicit flow** (`response_type=id_token`, `scope=openid`, `nonce=actionHash`, `force_verify=true`). Twitch returns a signed `id_token`. That raw JWT is passed to `twin.execute(...)`, and `TwitchJWTVerifier` checks, onchain:

- header `alg == RS256`, `kid` known;
- RSA-2048 PKCS#1 v1.5 + SHA-256 signature valid against the baked-in Twitch modulus;
- `iss == "https://id.twitch.tv/oauth2"`;
- **`aud` is an allowlisted app** (anti-phishing — see [Decentralization](#decentralization--the-app-allowlist-lever));
- `sub == userId` (this is what stops one user touching another's twin);
- `iat == oauthExchangeEpoch` and within a 5-minute freshness window;
- `nonce == hex(actionHash)` (binds the JWT to *this exact action on this exact twin on this exact chain*).

Because the binding includes the twin's incrementing `nonce`, chain id, twin address, and the full calldata, a JWT cannot be replayed, redirected to another contract, reused on another chain, or pointed at a different twin.

### 3. Self-custody escape hatch
A user can call `setOwnerEOA(wallet, …)` (Twitch-gated, once) to link their own EOA or smart wallet. From then on they spend with `executeAsOwner(...)` — a normal wallet signature, **no Twitch involvement** — which keeps working forever even if Twitch disappears or rotates keys. This is also the everyday-cheap path (~50k gas vs ~1.4M for the onchain-RSA JWT path).

### 4. Abandoned-funds recovery
Community funds sent to a twin that is *never* claimed are not lost forever. The treasury `rescuer` can call `rescueAbandoned(designatedEOA)` — but **only** on a twin that has never been activated and only after a 90-day delay. It can never touch a twin a user has ever used.

---

## Quick start

```bash
npm install
npm run compile
npm test            # full suite incl. red-team vectors
```

### Predict & fund a twin (offline, no deploy needed)
```ts
import { predictTwinAddress } from "@socialtwin/sdk";

const twin = predictTwinAddress({
  factory:  "0x260C074c3afDc46A209D4619B5FAdB2964dF9a28", // v1.3
  verifier: "0xBDfC552469f11843802BCD7ec9a8372c8020fee8", // v1.3
  userId:   1507305235n,            // Twitch numeric user_id
});
// → send ETH / ERC-20 to `twin`. Done. No setup on the recipient's side.
```

### Build a claim
```ts
import { buildSpendFlow, parseReturnFragment, buildExecuteCall } from "@socialtwin/sdk";

const cfg = {
  chainId: 8453,
  factoryAddress: "0x260C074c3afDc46A209D4619B5FAdB2964dF9a28", // v1.3
  twitchClientId: "<your Twitch app client_id>", // must be allowlisted as an `aud`
  redirectUri: "https://yourapp.example/claim",  // must match the Twitch app exactly
};
// IMPORTANT: show the user the exact action (recipient, amount) in YOUR UI before redirecting —
// the Twitch consent screen can't display it. The action hash binds the JWT to this exact call.
const { redirectUrl } = buildSpendFlow(cfg, {
  twin, userId, target: recipient, value, data: "0x", nonce, deadline,
});
window.location.href = redirectUrl;                 // Twitch OIDC (response_type=id_token)

// …on return:
const jwt = parseReturnFragment(window.location.hash);  // reads the id_token from the fragment
await walletClient.writeContract(buildExecuteCall(intent, jwt)); // or relay it gaslessly
```

See [`docs/INTEGRATION.md`](docs/INTEGRATION.md) and [`docs/FRONTEND_SDK.md`](docs/FRONTEND_SDK.md) for the full flow, and [`sdk/`](sdk/) for the helper library.

---

## Security model

**Trust roots:** Twitch's RSA signing key for identity · the Base sequencer/L1 · the EVM `modexp` precompile · a treasury multisig for app curation and abandoned-fund rescue. **No server sits in the spend path.**

| Guarantee | How |
|---|---|
| No user can spend another user's twin | verifier enforces `sub == userId`; action hash binds `userId` + twin address |
| Permissionless settlement | `execute` has no `msg.sender` check — any wallet can submit a valid JWT |
| No replay / cross-twin / cross-chain reuse | action hash binds chainid, twin, nonce, deadline, target, value, calldata; 5-min freshness |
| Anti-phishing | only allowlisted OAuth `aud`s accepted (a malicious site's own Twitch app yields a different `aud` → rejected); new `aud`s are timelocked 2 days |
| Survives operator death | deterministic addresses + permissionless `execute` + wallet-owned `executeAsOwner` |
| Self-custody severs Twitch | once a user links an EOA (`setOwnerEOA`), the JWT/Twitch path is **permanently disabled** for that twin — a compromised or phished Twitch login can no longer drain or re-point it (one-way; no Twitch-based recovery thereafter) |
| No admin over user funds | treasury can curate the app allowlist and recover *never-claimed* twins via a two-phase rescue (signal intent → 90-day public window → complete) — nothing more, and never a twin whose owner showed up |

**Honest residual risks:**
- The onchain JWT verifier (RSA + base64url + JSON parsing in Solidity) is intricate and **not yet externally audited**. Internally red-teamed with 22+ adversarial vectors (forged signatures, `alg=none`/confusion, JSON injection, cross-user, replay, audience phishing) plus a fuzz suite; findings and fixes in [`RED_TEAM_FINDINGS.md`](RED_TEAM_FINDINGS.md) and [`AUDIT_RESPONSE.md`](AUDIT_RESPONSE.md).
- OAuth phishing narrows to "the user authorizes a malicious *allowlisted* app." Same ceiling as any "Sign in with X"; **once a user self-custodies (links a wallet), the JWT path is permanently disabled** so this risk disappears for that twin. `force_verify=true` forces the consent screen each time.
- If Twitch rotates its signing key, `keyAdmin` rotates the modulus **in place** behind a **7-day timelock** the `guardian` can veto and anyone can verify against Twitch's live JWKS — so the JWT path resumes on the same twins (a legit rotation just pauses claims for the timelock; funds are never permanently locked). Self-custodied twins use no JWT and are unaffected. Residual trust: `keyAdmin`+`guardian` both compromised, unnoticed for 7 days, could install a forged key — see [`SECURITY.md`](SECURITY.md) and [`AUDIT_RESPONSE.md`](AUDIT_RESPONSE.md) Finding 5.

Full write-ups: [`SECURITY.md`](SECURITY.md) · [`PERMANENCE.md`](PERMANENCE.md) · [`AUDIT_RESPONSE.md`](AUDIT_RESPONSE.md).

---

## Decentralization & the app-allowlist lever

The protocol is designed to **survive the operator disappearing**: deterministic addresses, onchain verification, and permissionless `execute` mean any relayer can serve the contracts and any user can self-submit. The one piece of curated trust today is the **`aud` (audience) allowlist** on `TwitchJWTVerifier`, which is what makes phishing hard: only JWTs issued to an approved Twitch OAuth `client_id` are accepted.

This is a deliberate dial, not a permanent gatekeeper:

- **Today (curated):** the treasury `audAdmin` approves apps with `queueAud(clientId)` → `commitAud` (a 2-day timelock, so a compromised admin can't *instantly* allowlist a phishing app). Anyone building on SocialTwin requests allowlisting of their Twitch app's `client_id` and, after the timelock, their users work against the same twins. This is the safe default while the verifier is pending external audit.
- **The lever — full decentralization:** once the verifier is audited and we're confident open mode is safe, the allowlist can be switched off, either reversibly with `setAudCheckEnabled(false)` or **permanently and irreversibly** with `lockOpenForever()` — which disables the audience check *and* zeroes out the admin in the same call. After that, **any** Twitch app's JWTs are accepted and there is no admin role left at all. That accepts the same phishing surface every wallet already lives with (a user logging into a compromised site), in exchange for removing the last point of operator control.

So the trust dial reads: *curated allowlist now (we approve your app on request) → audited → flip to open / lock-open-forever for a fully permissionless, admin-less protocol.* Details and rationale in [`PERMANENCE.md`](PERMANENCE.md) and [`SECURITY.md`](SECURITY.md).

---

## Contracts

| File | Purpose |
|---|---|
| [`contracts/TwinFactory.sol`](contracts/TwinFactory.sol) | `CREATE2` factory; `predictAddress`, `deployTwin`, `rescuer` role |
| [`contracts/TwinAccount.sol`](contracts/TwinAccount.sol) | Per-user account: `execute`/`executeBatch` (JWT), `executeAsOwner` (wallet), `setOwnerEOA`, `initiateRescue`/`completeRescue` |
| [`contracts/TwitchJWTVerifier.sol`](contracts/TwitchJWTVerifier.sol) | Onchain RSA/SHA-256 JWT verification + timelocked `aud` allowlist + off-switch |
| [`contracts/interfaces/IVerifier.sol`](contracts/interfaces/IVerifier.sol) | `verify(userId, actionHash, epoch, proof)` — pluggable verifier interface |

Per-function reference: [`contracts/README.md`](contracts/README.md) and [`ARCHITECTURE.md`](ARCHITECTURE.md). JWT format and binding spec: [`PROTOCOL.md`](PROTOCOL.md).

---

## Repository layout

```
contracts/     Solidity sources (TwinFactory, TwinAccount, TwitchJWTVerifier, IVerifier, test mocks)
test/          Hardhat suite: TwinAccount, TwinV2Features, TwitchJWTVerifier, FuzzVerifier, RedTeam, E2EJourney
scripts/       Deployment scripts (stack, factory, local)
sdk/           TypeScript SDK: off-chain address prediction + Twitch-OIDC flow helpers + ABIs
clear-signing/ ERC-7730 descriptor for the owner-EOA wallet path
monitoring/    JWKS watchdog — key-rotation early warning (run on a schedule)
docs/          INTEGRATION, DEPLOYMENT, index
*.md           ARCHITECTURE, PROTOCOL, SECURITY, PERMANENCE, AUDIT_RESPONSE, RED_TEAM_FINDINGS, CHANGELOG
```

## Build, test, deploy

```bash
npm install
npm run compile
npm test                       # full suite

cp .env.example .env           # set PRIVATE_KEY, BASE_RPC_URL, BASESCAN_API_KEY
npm run deploy:stack:base      # deploy verifier + factory to Base mainnet
```
Deployment and operations details: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md), [`docs/KEY_MANAGEMENT.md`](docs/KEY_MANAGEMENT.md).

---

## License

MIT — see [`LICENSE`](LICENSE).

> Experimental software pending external audit. No warranty. Verify addresses against Basescan before sending funds.
