# Permanence & Decentralization

The definitive answer to: **"If the operator disappears, can users still access their funds?"**

Short answer: **Yes.** The production deployment verifies Twitch identity entirely onchain. No operator, server, attestor, or off-chain service is required to spend from a twin. The only scenario requiring action is a Twitch signing-key rotation, which is detectable months in advance and has a documented migration path.

## The production spend path

```
┌──────────┐   OAuth      ┌─────────────┐  signed JWT   ┌──────────────┐  execute()  ┌──────────────────┐
│  User    │ ───────────▶ │  Twitch     │ ────────────▶ │  User submits│ ──────────▶ │  TwinAccount     │
│  browser │ ◀─────────── │  (the IdP)  │               │  to Base     │             │  on Base mainnet │
└──────────┘   id_token   └─────────────┘               └──────────────┘             └────────┬─────────┘
                                                                                              │ verifies RSA
                                                                                              │ signature
                                                                                              ▼
                                                                                    ┌──────────────────┐
                                                                                    │ TwitchJWTVerifier│
                                                                                    │ (immutable)      │
                                                                                    └──────────────────┘
```

Every participant in this path is one of:
- **The user** (their browser, their wallet)
- **Twitch** (the identity provider — unavoidable for any "sign in with Twitch" system)
- **Base / Ethereum** (the chain)
- **Immutable contracts** (no admin, no upgrade, no operator)

The operator's infrastructure (`wolverine` backend, keeper, indexer, attestor, claim site) does **not** appear. All of it is convenience tooling that can be replaced by anyone, or bypassed entirely.

## Deployed addresses (Base mainnet)

| Contract | Address | Mutable? |
|---|---|---|
| `TwinFactory` (v2) | `0x201830519A39596E755Fe5Fc429EF75a14537dE4` | No — immutable. `rescuer` role is permanent + transferable (not renounceable). |
| `TwitchJWTVerifier` | `0xE4CC251864B0271903D458a9F5731D38ed3eeA39` | No — RSA modulus baked in at deploy |
| `TwinAccount` (per user) | derived via CREATE2 | No — no selfdestruct, permanent once deployed |

## The escape hatch removes the Twitch-rotation lock for connected users

v2 twins let the real Twitch owner connect a self-custody EOA (`setOwnerEOA`, JWT-gated). Once connected, that EOA can spend via `executeAsOwner` with **no JWT, ever** — so a connected user is immune to Twitch rotating their key or shutting down OIDC entirely. The product flow prompts every user to connect their own wallet on first login precisely so that the Twitch-rotation caveat below never applies to anyone who has logged in once.

The rotation caveat therefore only affects funds in twins that were **never connected** — and those are exactly the funds the abandoned-rescue path (below) can recover.

## What can and cannot lock funds

| Event | Funds locked? | Why |
|---|---|---|
| Operator's server crashes | **No** | No server in the spend path |
| Operator abandons the project | **No** | Contracts are immutable and self-contained |
| Operator's company dissolves | **No** | Nothing operator-controlled gates spending |
| Keeper / indexer goes offline | **No** | Read-only tooling; users can scan the chain directly |
| Claim site goes offline | **No** | Anyone can submit `execute()` from any interface (Etherscan write tab, a script, a forked UI) |
| Attestor service goes offline | **No** | Attestor is not used by this deployment; it's optional adopter tooling |
| RPC provider goes down | **No** | Any RPC works; users pick their own |
| Base sequencer halts | **Temporarily** | Standard L2 liveness; funds recoverable via L1 escape hatches per Base's design |
| **Twitch rotates `kid="1"` signing key** — user HAS connected an escape EOA | **No** | EOA spends via `executeAsOwner`, no JWT needed |
| **Twitch rotates `kid="1"` signing key** — user NEVER connected | **Until migration** | The verifier knows only the baked-in key; see below |
| User loses Twitch account access — but connected an EOA | **No** | The EOA still controls the twin |
| User loses Twitch account access — never connected an EOA | **For that user** | Same as losing a wallet key |
| Streamer never connects for 3+ months (abandoned funds) | **Recoverable by rescuer** | `rescueAbandoned` delegates to a designated EOA; see below |

## The Twitch key-rotation caveat (the only real one)

### Why it exists

`TwitchJWTVerifier` has Twitch's RSA-2048 public key for `kid="1"` hardcoded at deployment. To verify a JWT, the contract checks the signature against this key. If Twitch starts signing with a different key, those JWTs won't verify, and twins bound to this verifier can't be spent.

### Why it can't be trustlessly fixed

A contract can only learn Twitch's public key two ways:
1. **Hardcoded at deploy** — trustless, but frozen to that key.
2. **Updatable later** — but *whoever can supply a "new Twitch key" can forge every user's identity*, because they'd know the private key for the modulus they submit. Twitch doesn't sign their key rotations with the old key (no OIDC provider does), so a contract has no way to cryptographically verify that a replacement key genuinely belongs to Twitch.

This means **immutability is the safest design** — an updatable key would be a universal forgery backdoor. The cost of safety is that rotation requires a migration rather than an in-place update.

### Why it's low-risk in practice

- Twitch's key id is `"1"` and their JWKS contains exactly one key. Frequent-rotation providers (e.g., Google rotates ~weekly) use many keys with random or date-based ids. A lone static `kid="1"` is the fingerprint of a long-lived key that has not rotated since Twitch launched OIDC.
- OIDC convention (which Twitch follows) is to publish a new key to the JWKS *before* retiring the old one, giving an overlap window of weeks to months.

### How rotation is handled if it ever happens

1. The JWKS watchdog (see `docs/ATTESTOR_OPERATIONS.md` / the `wolverine` route) detects a new key in Twitch's JWKS and alerts.
2. We deploy a new `TwitchJWTVerifier` carrying both the old and the new modulus, and a new `TwinFactory` bound to it.
3. During the overlap window (while Twitch still honors the old key), users migrate: spend from their old twin into their new twin (or into any wallet). See `docs/MIGRATION.md`.
4. After Twitch retires the old key, only the new factory's twins are active.

The watchdog converts "rotation = surprise lockup" into "rotation = months of scheduled migration."

### Residual honesty

If, despite the watchdog, a user never migrates before Twitch retires the old key, that user's old-twin funds become unspendable. This is the single permanence gap, and it requires both (a) a Twitch rotation — historically not observed for `kid="1"` — and (b) a user ignoring migration notices through the entire overlap window. We document it rather than hide it.

## Comparison: what we gave up by choosing pure-JWT over the attestor

| | Pure onchain JWT (deployed) | Attestor (optional) |
|---|---|---|
| Server required to spend | **None** | Yes — attestor must be live |
| Funds locked if operator vanishes | **No** | Yes (if key also lost) |
| Gas per spend | ~700k (~$0.01–0.02 on Base) | ~30k (~$0.0002) |
| Trust roots | Twitch + chain | Twitch + chain + attestor key |
| Permanence | Yes (modulo Twitch rotation) | No (operator-dependent) |

You chose permanence over the gas savings. At Base gas prices, a spend costs roughly one to two US cents — a price worth paying for "nobody can ever lock your funds."

## How a user spends with zero operator cooperation

Even with every operator service dead, a technically-capable user can:

1. Complete Twitch OAuth in any OIDC client to obtain an `id_token` (JWT). The `nonce` parameter must equal the `actionHash` for their intended call.
2. Compute `actionHash = twin.computeActionHash(target, value, data, nonce, deadline)` via any RPC `eth_call`.
3. Submit `twin.execute(target, value, data, nonce, deadline, iat, jwtBytes)` from any wallet or block explorer.

The `docs/INTEGRATION.md` and `sdk/` make this easy, but they are not *required* — they're conveniences over a fully self-contained onchain system. Anyone can rebuild the UI from the public ABI.

## Abandoned-funds rescue (the deliberate, scoped trust)

The community creates coins for streamers; trading fees accrue to a streamer's twin before that streamer has ever connected. If a streamer never shows up, those funds would be stuck forever. To recover genuinely-abandoned value, the factory holds a `rescuer` role that can delegate control of a twin to a designated EOA — but only under tight constraints enforced onchain:

- **Only if the twin was NEVER activated** — never executed, never set an EOA. The instant a streamer demonstrates control even once, rescue is permanently impossible for that twin (`activated` flag).
- **Only after `RESCUE_DELAY` (3 months)** from the twin's deployment.
- **Only by the current `rescuer`** (initially the deployer), which is a **permanent, retained** capability — transferable to a DAO/multisig but not renounceable (and never settable to zero).

This is an honest, bounded trust assumption — it exists solely to recover funds that would otherwise be lost, and can never touch an active user's twin. The real Twitch owner, if they ever appear (while Twitch lives), can still reclaim via a JWT even after a rescue.

## Verdict

**This is decentralized.** No operator dependency exists in the critical path. The system survives the complete disappearance of its creators. The single caveat — Twitch key rotation — is a fundamental property of delegating identity to Twitch, is historically improbable for `kid="1"`, is detectable months in advance, and has a documented migration path.

This is the maximally-decentralized design achievable for a Twitch-identity-bound smart account. Going further would require Twitch itself to publish onchain-verifiable key rotation proofs, which is outside anyone's control but Twitch's.
