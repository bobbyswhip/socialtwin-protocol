# You Got Coined — plugin

Base mainnet (chainId **8453**). API base: `https://api.waifi.app/v1/st`.

## Onboarding gate

> [!IMPORTANT]
> **STOP.** Before the first action in a session, complete Base MCP onboarding:
> call `get_wallets`, and tell the user, briefly:
> "Tips go to the streamer's on-chain account, which they claim with their Twitch
> login. Every transaction is approved in your own wallet — I never hold your funds
> and will never ask for a seed phrase."
> Only then continue.

Amounts are decimal strings in the asset being spent (`"0.01"` ETH, `"5"` USDC).
Every endpoint returns errors as `{ "error": "...", "detail": "..." }` — read `detail`
aloud to the user rather than retrying blindly.

Read endpoints are rate limited to **20 requests/second per IP** (burst 40). On `429`
respect `Retry-After`. Batch by asking one question at a time rather than fanning out.

---

## Read endpoints

### Resolve a streamer → their address

```
GET {base}/resolve?login=<twitch_login>
GET {base}/resolve?userId=<twitch_user_id>
```

```json
{ "login": "mmorpg", "userId": "41684297",
  "twinAddress": "0x1dAb8db1e06db23bB41c1CD6b09e9bF784A7f970",
  "deployed": false, "chainId": 8453,
  "profile": { "displayName": "Mmorpg", "avatarUrl": "https://..." } }
```

`deployed: false` is normal and **not** a problem — the address is valid and can
receive funds before the contract exists.

### Resolve an address → the streamer

```
GET {base}/resolve?address=0x…
```

Returns the same identity plus `matchedVia` (`"twin"` if it's the streamer's own
account, `"owner"` if it's their linked wallet) and `coin` when they have one. `404`
means we have no record of that address — it is not proof the address is unowned.

### Resolving without this API

The forward direction is pure math and needs nothing from us — useful if you'd rather
not depend on this service:

1. Twitch login → numeric user id, via Twitch's public GQL endpoint
   (`https://gql.twitch.tv/gql`, client id `kimne78kx3ncx6brgo4mv6wki5h1ko`).
2. user id → twin address: `predictAddress(uint64 userId)` on the factory at
   `0x260C074c3afDc46A209D4619B5FAdB2964dF9a28`. It's CREATE2, so the answer is
   deterministic and permanent.

The **reverse** direction (address → Twitch) can't be derived — CREATE2 is one-way —
so that one needs this API.

### Health

```
GET {base}/health → { "status": "ok" }
```

---

## Prepare endpoints

These return **unsigned calldata**. Nothing is signed or sent server-side.

### Tip a streamer

```
GET {base}/prepare/tip?login=<login>&amount=<decimal>[&token=0x…]
```

Omit `token` for ETH. Pass any ERC-20 address to tip that token — decimals are read
on-chain, so pass human amounts (`amount=5` with USDC means 5 USDC).

```json
{ "action": "tip",
  "streamer": { "login": "mmorpg", "twinAddress": "0x1dAb…f970", "displayName": "Mmorpg" },
  "asset": "USDC", "decimals": 6, "amount": "5", "amountWei": "5000000",
  "calls": [ { "to": "0x8335…2913", "value": "0x0", "data": "0xa9059cbb…", "chainId": 8453 } ],
  "chain": "base", "chainId": 8453 }
```

ETH is a plain value transfer; an ERC-20 is a single `transfer` straight to the
streamer — no approval, because nothing of ours sits in the middle.

### Buy a streamer's coin

```
GET {base}/prepare/buy?login=<login>&amount=<decimal>&pay=eth|usdc&recipient=0x…
GET {base}/prepare/buy?token=0x…&amount=<decimal>&pay=eth|usdc[&recipient=0x…]
```

`recipient` is the buyer — use the address from `get_wallets`. It is **required** for
coins launched here, because the tokens are delivered straight to it.

> [!TIP]
> **Prefer `pay=usdc` for a streamer's coin.** These coins are paired against USDC, so
> paying in USDC trades directly against the pair; paying in ETH adds a hop and
> normally returns fewer tokens for the same value. The response carries a `tip` field
> saying so whenever you ask for ETH. Quote both and show the user the difference if
> they're unsure.

```json
{ "action": "buy", "token": "0xb200…2f3a",
  "streamer": { "login": "mr_mammal", "symbol": "MAMMAL" },
  "platformCoin": true, "pay": "usdc",
  "amount": "2", "amountWei": "2000000",
  "quoted": "1152032661179953537792", "minOut": "1036829395061958183", "quoteOk": true,
  "calls": [ { "to": "0x8335…2913", "value": "0x0", "data": "0x095ea7b3…", "chainId": 8453 },
             { "to": "0x14d1…924F", "value": "0x0", "data": "0x0fbc337d…", "chainId": 8453 } ],
  "chain": "base", "chainId": 8453 }
```

- `platformCoin: true` — launched here. Bought through our own swap contract, which
  fills from inventory first and the pool otherwise. A generic DEX aggregator will
  **not** find a route for these; use this endpoint.
- `platformCoin: false` — any other Base token. Routed across Uniswap v2/v3/v4 and
  Aerodrome, the same way the website trades it. `venue` names the venue used.
- `quoted` is the expected output, `minOut` the slippage floor (default 10%, override
  with `&slip=<bps>`).
- `quoteOk: false` means the quote failed — usually no liquidity yet. `minOut` falls
  back to `1`, which is **no protection at all**, and a `warning` explains it. Tell the
  user before sending anything.

---

## send_calls mapping

Take `calls` verbatim, drop `chainId` from each entry, and pass the array in order:

```json
{ "chain": "base",
  "calls": [ { "to": "0x…", "value": "0x0", "data": "0x…" } ] }
```

Two calls means approve-then-act and the order matters — send them as **one** batch,
never separately. Values are already hex-encoded wei; do not convert them again.

---

## Launch a coin for a streamer

Costs **$1 USDC** via x402. This is a paid endpoint because it deploys a contract, and
the fee is what stops it being spammed.

1. `initiate_x402_request` → `POST {base}/launch` with `{ "login": "<twitch_login>" }`.
   Unpaid, it answers `402` with the price and payment details.
2. Approve the $1 in the wallet, then `complete_x402_request` to retry with payment.

```json
{ "ok": true, "login": "somestreamer", "userId": "12345678",
  "coinAddress": "0xb200…", "twinAddress": "0x…", "paid": true, "payer": "0x…" }
```

Notes:
- **One coin per streamer.** If they already have one you get `alreadyLaunched: true`
  with the existing address — that's success, not an error. Don't retry.
- The name and symbol are derived from the Twitch login server-side. They can't be
  chosen, so don't ask the user for them.
- The streamer doesn't need to consent or even know: the coin belongs to their twin and
  they claim it by signing in. Tell the user that plainly.
- People signed in on yougotcoined.com launch free (one a day). The $1 applies to
  agents, which have no Twitch session to check.

---

## Worked examples

**"Tip ninja 0.01 eth"**
1. `GET /prepare/tip?login=ninja&amount=0.01`
2. Show: recipient, amount, that it lands in ninja's twin.
3. `send_calls` with the returned call.

**"Buy $20 of caedrel's coin"**
1. `GET /prepare/buy?login=caedrel&amount=20&pay=usdc&recipient=<wallet>`
2. Show `quoted` tokens and `minOut`; flag any `warning`.
3. `send_calls` with both calls, in order.

**"Who owns 0x1dAb…f970?"** → `GET /resolve?address=0x1dAb…f970`

**"Launch a coin for shroud"** → x402 flow above, after telling them it costs $1.
