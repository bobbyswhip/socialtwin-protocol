# Resource-server API + x402 design

> Design only. Endpoints are proposed contracts, not yet built. They live as new routes on the
> existing wolverine backend (EC2), namespaced under `/v1/st/` (SocialTwin). "stop using mock data
> for routes" applies — every route below reads real Twitch + on-chain data.

Base URL (staging): `https://<wolverine-host>/v1/st` on Base Sepolia first.

---

## `GET /v1/st/resolve`

Resolve a Twitch login (or numeric user_id) to its SocialTwin twin address.

**Query:** `login=<twitch_username>` **or** `userId=<numeric>` (exactly one).

**200 response:**
```json
{
  "login": "yougotcoined",
  "userId": "1507305235",
  "twinAddress": "0xcBeaF766D4a7DD61558d4E80ee58B8B8379d4CEf",
  "deployed": true,
  "chainId": 8453,
  "profile": { "displayName": "yougotcoined", "avatarUrl": "https://…" }
}
```

**Logic:**
1. If `login`: `GET https://api.twitch.tv/helix/users?login=<login>` with the app token
   (client_credentials for client_id `epeocrogq8bm1af0lngd9e2rfvrwk1`). 404 → `{error:"twitch_user_not_found"}`.
2. `twinAddress = TwinFactory(0x260C…).predictAddress(userId)` via `eth_call`.
3. `deployed = code.length > 0` at that address.

**Errors:** `400 bad_request` (neither/both params), `404 twitch_user_not_found`, `502 twitch_unavailable`.

**Notes:** read-only, cacheable (e.g. 5 min) per login. No payment. The address is deterministic, so
this is safe to expose; it leaks only the public mapping (Twitch id ↔ twin), which is already derivable.

---

## `POST /v1/st/launch`  (x402-gated, $1 USDC)

Launch a streamer coin for a resolved Twitch user. **x402 Payment Required.**

**Body:**
```json
{ "login": "somestreamer", "params": { /* optional launch params: name, symbol, … */ } }
```

### First call (no `X-PAYMENT`) → `402 Payment Required`

x402 payment requirements (the `accepts` array — "exact" scheme on Base):
```json
{
  "x402Version": 1,
  "accepts": [{
    "scheme": "exact",
    "network": "base",                              // CAIP-2 eip155:8453 (eip155:84532 on staging)
    "maxAmountRequired": "1000000",                 // 1 USDC, 6 decimals
    "resource": "/v1/st/launch",
    "description": "Launch a SocialTwin streamer coin (anti-spam fee)",
    "mimeType": "application/json",
    "payTo": "0x<SocialTwin treasury recipient>",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",  // USDC (Sepolia: 0x036C…CF7e)
    "maxTimeoutSeconds": 120,
    "extra": { "name": "USD Coin", "version": "2" } // EIP-712 domain for EIP-3009
  }]
}
```

### Retry with `X-PAYMENT` (base64 EIP-3009 authorization) → settle → launch

```json
// 200 OK  + header  X-PAYMENT-RESPONSE: <base64 settlement receipt>
{
  "login": "somestreamer",
  "userId": "44322889",
  "coinAddress": "0x…",
  "twinAddress": "0x…",
  "launchTx": "0x…",
  "alreadyExisted": false
}
```

**Server logic (order matters — verify before charge):**
1. Resolve `login → userId` (same as `/resolve`). Bad login → `404`, **no 402** (don't charge for a non-existent streamer).
2. **Idempotency:** if a coin already exists for `userId`, return it with `alreadyExisted:true` and **HTTP 200, no charge**. Never bill twice for one streamer.
3. Otherwise emit `402` with the requirements above.
4. On retry, forward `X-PAYMENT` to the **CDP facilitator** `/verify` then `/settle`. Reject on verify failure (`402` again). Free tier: 1,000 settlements/mo.
5. Only **after** settlement confirms `$1` received, call the `pairable_v1` launcher for `userId`, then return the coin. If the launch tx fails *after* settlement, queue a refund/retry (see below) — never leave a paid-but-unlaunched state silently.

**Anti-spam rationale:** the $1 is the spam cost, not revenue-maximizing. It makes mass coin-spam
uneconomical while staying trivial for a real fan. Tunable via the `maxAmountRequired` constant.

**Failure & refund policy:**
- Verify fails / expired authorization → `402` with fresh requirements (client re-signs).
- Settled but launcher reverts → record `{userId, paymentId}` to a `pending_refunds` table; expose a
  manual/automated refund of the $1 to the payer. Bound: at most one un-launched-but-paid record per
  payment id; alarm if the table is non-empty.
- Double-submit of the same `X-PAYMENT` → facilitator rejects replay; we also key idempotency on the
  authorization nonce.

---

## `GET /v1/st/health`

`{ "status":"ok", "chainId":8453, "factory":"0x260C…", "facilitator":"cdp", "twitch":"ok" }` —
liveness for the skill's Detection step and for monitoring.

---

## Idempotency & state (minimal)

We need a tiny store (one table) keyed by `userId`:

| field | use |
|---|---|
| `userId` (pk) | Twitch numeric id |
| `coinAddress` | set once launched; presence ⇒ idempotent short-circuit |
| `launchTx` | audit |
| `paymentId` | facilitator settlement id that paid for it |
| `status` | `launched` \| `paid_pending_launch` \| `refunded` |

No user balances are ever stored — we don't custody funds.

---

## What we deliberately do NOT build

- **No tip endpoint.** Tips use Base MCP's native `send`; adding a tip API would needlessly route
  user funds through us.
- **No custom on-chain "tip router".** A tip is a plain transfer to the twin; the existing claim
  path is the withdrawal.
- **No non-standard payment proof.** Launch uses real x402 (EIP-3009 + facilitator), nothing bespoke.
