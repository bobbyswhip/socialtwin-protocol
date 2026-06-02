# SocialTwin Protocol

**Every Twitch user already has a smart account on Base — they just haven't claimed it yet.**

SocialTwin gives every Twitch account a deterministic smart-contract wallet (a "twin") whose address is derived purely from the Twitch numeric `user_id`. Anyone can send funds to a streamer by their Twitch identity — community-coin trading fees, tips, rewards — **before that streamer has ever connected a wallet, signed a transaction, or even heard of the protocol**. The streamer later claims and controls the twin by signing in with Twitch, with the login proof **verified entirely onchain**. There is no oracle, no witness network, and no off-chain protocol in the trust path.

> **Status:** Live on Base mainnet. Internally red-teamed (0 critical/high on the contracts). **Not yet externally audited — do not route large value until it is.** This repository is under private review.

---

## Why this exists

The hard problem with "send crypto to a social handle" is custody: how do you address funds to someone who has no wallet, guarantee only *they* can ever spend it, and not rely on a company staying online to make that true?

SocialTwin solves it with two ideas borrowed from the design of cross-chain bridges:

1. **Deterministic addresses.** A twin's address is a pure function of the Twitch `user_id` via `CREATE2`. You can compute it offline and fund it before the contract exists.
2. **Permissionless settlement.** Spending is authorized by a fresh Twitch OIDC `id_token` that the contract verifies onchain (RSA-2048 / SHA-256). *Anyone* can broadcast the transaction — the JWT is the authorization, not the sender. If our servers vanish, any wallet on Earth can still submit a user's withdrawal.

The result: fund-by-identity with self-custody guarantees, no trusted relayer in the spend path, and a clean upgrade path to a self-custody wallet the user fully owns.

---

## Live deployment (Base mainnet · chainId 8453)

| Contract | Address | Role |
|---|---|---|
| `TwinFactory` | [`0x942C079aA7458fDc89cFd1FAc00555fA6Beb77Ff`](https://basescan.org/address/0x942C079aA7458fDc89cFd1FAc00555fA6Beb77Ff) | Derives & deploys twins (`CREATE2`) |
| `TwitchJWTVerifier` | [`0xF1Ff265EcA9983a21992808B9d764F8c6F2F9d25`](https://basescan.org/address/0xF1Ff265EcA9983a21992808B9d764F8c6F2F9d25) | Onchain Twitch OIDC JWT verification |
| Treasury (multisig role) | [`0xD1EC8245c8850A151843ce8a3AFdca3b19747706`](https://basescan.org/address/0xD1EC8245c8850A151843ce8a3AFdca3b19747706) | `audAdmin` + abandoned-funds `rescuer` |

All contracts are immutable and source-verified on Basescan. Salt domain: `"SocialTwin:twitch:v2"`. Twitch issuer `https://id.twitch.tv/oauth2`, signing key `kid="1"`.

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
  factory:  "0x942C079aA7458fDc89cFd1FAc00555fA6Beb77Ff",
  verifier: "0xF1Ff265EcA9983a21992808B9d764F8c6F2F9d25",
  userId:   1507305235n,            // Twitch numeric user_id
});
// → send ETH / ERC-20 to `twin`. Done. No setup on the recipient's side.
```

### Build a claim
```ts
import { buildSpendFlow } from "@socialtwin/sdk";

const { redirectUrl, actionHash } = buildSpendFlow(config, {
  twin, userId, target: recipient, value, data: "0x",
});
// 1. redirect the user to `redirectUrl` (Twitch consent)
// 2. read id_token from the return URL fragment
// 3. call twin.execute(target, value, data, nonce, deadline, iat, jwtBytes)
//    — from the user's wallet, OR via any relayer (the JWT is the auth)
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
| Anti-phishing | only allowlisted OAuth `aud`s accepted (a malicious site's own Twitch app yields a different `aud` → rejected) |
| Survives operator death | deterministic addresses + permissionless `execute` + wallet-owned `executeAsOwner` |
| No admin over user funds | treasury can curate the app allowlist and rescue *never-claimed* twins after 90 days — nothing more |

**Honest residual risks:**
- The onchain JWT verifier (RSA + base64url + JSON parsing in Solidity) is intricate and **not yet externally audited**. Internally red-teamed with 22+ adversarial vectors (forged signatures, `alg=none`/confusion, JSON injection, cross-user, replay, audience phishing); findings and fixes in [`RED_TEAM_FINDINGS.md`](RED_TEAM_FINDINGS.md) and [`SECURITY_REVIEW.md`](SECURITY_REVIEW.md).
- OAuth phishing narrows to "the user authorizes a malicious *allowlisted* app." Same ceiling as any "Sign in with X"; the wallet-owned escape path defends everyday spending. `force_verify=true` forces the consent screen each time.
- If Twitch rotates its signing key, JWT-path access pauses until a new verifier/factory is deployed and users migrate. A key-rotation watchdog provides advance warning; wallets linked via `setOwnerEOA` are unaffected (they don't use JWTs).

Full write-ups: [`SECURITY.md`](SECURITY.md) · [`PERMANENCE.md`](PERMANENCE.md) · [`docs/TRUST_MODEL.md`](docs/TRUST_MODEL.md).

---

## Decentralization & the app-allowlist lever

The protocol is designed to **survive the operator disappearing**: deterministic addresses, onchain verification, and permissionless `execute` mean any relayer can serve the contracts and any user can self-submit. The one piece of curated trust today is the **`aud` (audience) allowlist** on `TwitchJWTVerifier`, which is what makes phishing hard: only JWTs issued to an approved Twitch OAuth `client_id` are accepted.

This is a deliberate dial, not a permanent gatekeeper:

- **Today (curated):** the treasury `audAdmin` approves apps with `addAud(clientId)`. Anyone building on SocialTwin requests allowlisting of their Twitch app's `client_id` and their users immediately work against the same twins. This is the safe default while the verifier is pending external audit.
- **The lever — full decentralization:** once the verifier is audited and we're confident open mode is safe, the allowlist can be switched off, either reversibly with `setAudCheckEnabled(false)` or **permanently and irreversibly** with `lockOpenForever()` — which disables the audience check *and* zeroes out the admin in the same call. After that, **any** Twitch app's JWTs are accepted and there is no admin role left at all. That accepts the same phishing surface every wallet already lives with (a user logging into a compromised site), in exchange for removing the last point of operator control.

So the trust dial reads: *curated allowlist now (we approve your app on request) → audited → flip to open / lock-open-forever for a fully permissionless, admin-less protocol.* Details and rationale in [`docs/FEDERATION.md`](docs/FEDERATION.md), [`docs/ADDING_PROVIDERS.md`](docs/ADDING_PROVIDERS.md), and [`PERMANENCE.md`](PERMANENCE.md).

---

## Contracts

| File | Purpose |
|---|---|
| [`contracts/TwinFactory.sol`](contracts/TwinFactory.sol) | `CREATE2` factory; `predictAddress`, `deployTwin`, `rescuer` role |
| [`contracts/TwinAccount.sol`](contracts/TwinAccount.sol) | Per-user account: `execute`/`executeBatch` (JWT), `executeAsOwner` (wallet), `setOwnerEOA`, `rescueAbandoned` |
| [`contracts/TwitchJWTVerifier.sol`](contracts/TwitchJWTVerifier.sol) | Onchain RSA/SHA-256 JWT verification + `aud` allowlist + off-switch |
| [`contracts/interfaces/IVerifier.sol`](contracts/interfaces/IVerifier.sol) | `verify(userId, actionHash, epoch, proof)` — pluggable verifier interface |
| [`contracts/AttestorVerifier.sol`](contracts/AttestorVerifier.sol) | Optional ECDSA-attestor verifier (~30k gas alternative; trades onchain verification for an attestor set) — not part of the deployed stack |
| `contracts/SocialTwinEscrow.sol` | Legacy escrow-model prototype, retained for reference; not deployed |

Per-function reference: [`contracts/README.md`](contracts/README.md) and [`ARCHITECTURE.md`](ARCHITECTURE.md). JWT format and binding spec: [`PROTOCOL.md`](PROTOCOL.md).

---

## Repository layout

```
contracts/     Solidity sources (core + optional verifiers + test mocks)
test/          Hardhat test suite, incl. RedTeam.test.ts adversarial vectors
scripts/       Deployment scripts (stack, factory, local)
sdk/           TypeScript SDK: off-chain address prediction + OAuth flow helpers + ABIs
docs/          Architecture, integration, trust model, federation, key management, migration
*.md           Protocol spec, security, permanence, red-team findings, roadmap
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
