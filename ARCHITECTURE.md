# Architecture

How the pieces fit. For exact wire formats see [`PROTOCOL.md`](./PROTOCOL.md); for the threat model see [`SECURITY.md`](./SECURITY.md).

## The idea

Every Twitch user has a smart-contract account (a "twin") at a **deterministic** Base address derived from their numeric `user_id`. Anyone can fund a streamer's twin by identity *before that streamer has done anything*. The streamer later claims/controls it by signing in with Twitch — and the login proof is verified **entirely onchain**. Once they connect their own wallet, the twin becomes ordinary self-custody and Twitch is cut out for good.

## Onchain contracts

| Contract | What it does |
|---|---|
| `TwinFactory` | Derives every twin address via `CREATE2` from `user_id`; deploys twins (permissionless, idempotent). Holds the `rescuer` role. Embeds the `TwinAccount` creation code, so a new `TwinAccount` ⇒ a new factory. |
| `TwinAccount` | The per-user account. Two spend paths (below), a one-way self-custody switch, and two-phase abandoned-funds rescue. Holds the user's ETH/tokens. |
| `TwitchJWTVerifier` | Verifies a Twitch OIDC `id_token` (RS256) **onchain** — RSA-2048 PKCS#1 v1.5 + SHA-256 via the `modexp` precompile, base64url + JSON claim parsing. Enforces a timelocked `aud` allowlist. Implements `IVerifier`. |
| `IVerifier` | The pluggable verification interface: `verify(userId, actionHash, oauthExchangeEpoch, proof)`. |

```
  fund by identity (anyone, anytime)
            │
 user_id ──CREATE2──►  TWIN ADDRESS  ◄── ETH / ERC-20 wait here, owned, before any claim
 (Twitch)             0xTWIN…
                          │
        ┌─────────────────┴──────────────────┐
   ① Twitch JWT path                    ② Owner path (self-custody)
   execute / executeBatch / setOwnerEOA  executeAsOwner / rotateOwnerEOA
   • id_token verified ONCHAIN           • plain wallet signature, NO Twitch
   • permissionless to submit            • the only path once self-custodied
   • the bootstrap                       • survives Twitch disappearing
```

## Two ways to spend

1. **Twitch JWT path** (`execute`, `executeBatch`, `setOwnerEOA`). Authorized by a fresh Twitch `id_token` whose OAuth `nonce` is bound to the exact action (see PROTOCOL). **Permissionless to submit** — the JWT is the authority, not `msg.sender`, so any wallet or relayer can broadcast it. This is the bootstrap path while a user has no wallet linked.

2. **Owner (self-custody) path** (`executeAsOwner`, `rotateOwnerEOA`). When the user calls `setOwnerEOA` (JWT-gated, once), the twin flips a one-way **`selfCustody`** flag: the entire JWT/Twitch path is **permanently disabled**, and only the owner EOA can act thereafter. A compromised or phished Twitch login can no longer drain or re-point the twin. Trade-off: no Twitch-based recovery once self-custodied — link a smart-contract wallet if you want key recovery.

## Abandoned-funds rescue (two-phase)

Funds sent to a twin whose streamer never shows up aren't lost forever. The factory's `rescuer` calls `initiateRescue()` (starts a public 90-day countdown from that signal — not from deploy), then `completeRescue(eoa)` after the delay. It only ever touches a **never-activated** twin; any JWT action or `setOwnerEOA` activates the twin and permanently blocks rescue. `completeRescue` does **not** set `selfCustody`, so a rescued twin can still be reclaimed by the real streamer via JWT.

## Privileged roles

Neither role can move an active user's funds.

- **`audAdmin`** (on `TwitchJWTVerifier`) — curates the anti-phishing `aud` allowlist. New `aud`s are **timelocked 2 days** (`queueAud` → `commitAud`); `removeAud`, `setAudCheckEnabled(false)`, and `lockOpenForever()` are immediate. Should be a multisig. `lockOpenForever()` permanently drops the role and accepts any app's JWTs (full decentralization).
- **`rescuer`** (on `TwinFactory`) — runs the two-phase rescue on never-activated twins only. Non-renounceable but transferable to a DAO/multisig.

Both are held by the treasury (`0xD1EC…`); live addresses are in [`README.md`](./README.md).

## Off-chain (convenience only — not in the trust path)

- **Relayer** — a funded EOA that submits JWT-authorized calls so users pay no gas. Powerless: it can only broadcast what a JWT already authorized; `execute` is permissionless so it's never a chokepoint. It must verify `twin == factory.predictAddress(jwt.sub)` before paying gas.
- **RPC proxy / resolver / deposit indexer** — UX helpers (hide node keys, resolve `@handle → user_id`, list deposits). All replaceable by anyone or bypassable entirely. The reference web app + backend live outside this repo.

The SDK ([`sdk/`](./sdk/)) reproduces address derivation and the OAuth flow off-chain so a dApp needs no server for the core path.
