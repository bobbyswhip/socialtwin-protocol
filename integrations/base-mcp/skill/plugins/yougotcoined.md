# You Got Coined — plugin

Base mainnet (chainId **8453**). API base: `https://api.waifi.app/v1/st`.

## Onboarding gate

> [!IMPORTANT]
> **STOP.** Before the first action in a session, complete Base MCP onboarding:
> call `get_wallets`, give the mandatory Terms of Service disclaimer from `SKILL.md`,
> and add:
> "Tips and coin purchases go to the streamer's on-chain account, which they claim by
> signing in with Twitch. You approve every transaction in your own wallet — this skill
> never holds your funds and will never ask for a seed phrase."
> Only then continue.

## Conventions

**Amounts** are decimal strings in the asset being spent: `"0.01"` for ETH, `"5"` for
USDC. No scientific notation, no thousands separators — both are rejected.

**Errors** are `{ "error": "...", "detail": "..." }`. Show `detail` to the user rather
than retrying blindly. Two shapes differ: `429` adds `limit` and `retryAfter`, and the
`402` from `/launch` is an x402 payment envelope (see Launch).

**Rate limit**: 20 requests/second per IP, counted across the whole service, in fixed
one-second windows. On `429`, wait for `Retry-After` (always `1`). Ask one question at a
time rather than fanning out.

**Status codes**: `400` you sent something wrong · `404` genuinely doesn't exist ·
`429` slow down · `503` we couldn't complete it right now, retry — **never** read a
`503` as a fact about the streamer or token.

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

`deployed: false` is normal and **not** a problem — the address is valid and can receive
funds before the contract exists.

> [!NOTE]
> The `userId` form returns `login: null` and `profile: null` — it derives the address
> without contacting Twitch. Use `login` when you need a display name or avatar.

### Resolve an address → the streamer

```
GET {base}/resolve?address=0x…
```

A **different shape** to the login form — identity fields are top level, with no
`profile` object and no `deployed`:

```json
{ "login": "mmorpg", "userId": "41684297",
  "twinAddress": "0x1dAb8db1e06db23bB41c1CD6b09e9bF784A7f970",
  "displayName": "Mmorpg", "avatarUrl": "https://...",
  "coin": null, "matchedVia": "twin", "chainId": 8453 }
```

`matchedVia` is `"twin"` when the address is the streamer's own account, `"owner"` when
it's their linked wallet. `coin` is `{ token, symbol }` if they have one, else `null`.

`404` means no streamer is on record for that address. `503` means we couldn't check.
Those are different, and only `404` says anything about the address.

### Resolving without this API

The forward direction is pure math and needs nothing from us:

1. Twitch login → numeric user id, via Twitch's public GQL endpoint
   (`https://gql.twitch.tv/gql`, client id `kimne78kx3ncx6brgo4mv6wki5h1ko`).
2. user id → address: `predictAddress(uint64 userId)` on the factory at
   `0x260C074c3afDc46A209D4619B5FAdB2964dF9a28`. CREATE2, so it's deterministic and
   permanent.

The **reverse** (address → Twitch) can't be derived — CREATE2 is one-way — so that needs
this API.

### Health

```
GET {base}/health
```

Returns `{ status, chainId, factory, facilitator, twitch, capabilities }`. A response
carrying `"degraded": true` came from the standby: resolves still work, but tips, buys
and launches are briefly unavailable — say so and retry rather than reporting a failure.

---

## Prepare endpoints

These return **unsigned calldata**. Nothing is signed or sent server-side.

### Tip a streamer

```
GET {base}/prepare/tip?login=<login>&amount=<decimal>[&token=0x…]
```

Omit `token` for ETH. Pass any ERC-20 address to tip that token — decimals are read
on-chain, so `amount=5` with USDC means 5 USDC.

```json
{ "action": "tip",
  "streamer": { "login": "mmorpg", "userId": "41684297",
                "twinAddress": "0x1dAb8db1e06db23bB41c1CD6b09e9bF784A7f970",
                "displayName": "Mmorpg" },
  "asset": "USDC", "token": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "decimals": 6, "amount": "5", "amountWei": "5000000",
  "calls": [ { "to": "0x8335…2913", "value": "0x0", "data": "0xa9059cbb…", "chainId": 8453 } ],
  "chain": "base", "chainId": 8453, "note": "..." }
```

ETH is a plain value transfer and has no `token` field; an ERC-20 is a single `transfer`
straight to the streamer — no approval, because nothing of ours sits in the middle.

### Buy a streamer's coin

```
GET {base}/prepare/buy?login=<login>&amount=<decimal>&pay=eth|usdc&recipient=0x…
GET {base}/prepare/buy?token=0x…&amount=<decimal>&pay=eth|usdc[&recipient=0x…]
```

| Parameter | |
|---|---|
| `pay` | `eth` or `usdc`. **Omitting it means ETH.** Anything else is rejected — the API will not guess which asset you meant to spend. |
| `recipient` | The buyer, from `get_wallets`. **Required** for coins launched here; the tokens are delivered straight to it. |
| `slip` | Slippage in basis points. Default **300 (3%)** on both paths. |

> [!TIP]
> **Prefer `pay=usdc` for a streamer's coin.** These coins are paired against USDC, so
> paying in USDC trades directly against the pair; paying in ETH adds a hop and returns
> fewer tokens for the same value. Measured on one coin: 2 USDC → 1152 tokens versus
> 0.001 ETH → 1073. The response carries a `tip` field saying so whenever you ask for
> ETH. Quote both and show the user the difference if they're unsure.

A coin launched here (`platformCoin: true`):

```json
{ "action": "buy", "token": "0xb200000000000000000000374f5BABa2B1672f3A",
  "streamer": { "login": "mr_mammal", "displayName": "Mr_Mammal", "symbol": "MAMMAL" },
  "platformCoin": true, "pay": "usdc",
  "amount": "2", "amountWei": "2000000", "recipient": "0x4025…0000",
  "quoted": "1152032661179953537792", "minOut": "1117471681344554931659",
  "slippageBps": 300, "quoteOk": true,
  "tickSpacing": 2000, "deadline": "1784563998",
  "calls": [ { "to": "0x8335…2913", "value": "0x0", "data": "0x095ea7b3…", "chainId": 8453 },
             { "to": "0x14d1…924F", "value": "0x0", "data": "0x0fbc337d…", "chainId": 8453 } ],
  "chain": "base", "chainId": 8453 }
```

Any other Base token (`platformCoin: false`) adds `venue`, `swappedWei` and `feeBps`:

```json
{ "platformCoin": false, "venue": "uni-v4",
  "amountWei": "5000000", "swappedWei": "4950000", "feeBps": 100,
  "quoted": "7599930764398735542", "minOut": "7371932841466773475", "slippageBps": 300 }
```

- **`platformCoin: true`** — launched here, bought through our own swap contract. A
  generic DEX aggregator will **not** find a route for these; use this endpoint.
- **`platformCoin: false`** — routed across Uniswap v2/v3/v4 and Aerodrome, the same way
  the website trades it. **A 1% fee is taken before the swap**: `swappedWei` is what
  reaches the pool, `feeBps: 100` is the fee. Include it when you show the cost.
- **`quoted`** is the expected output, **`minOut`** the floor after slippage. Both paths
  use `quoted`; the external path also repeats it as `quote` for older callers.
- If a trade can't be quoted you get **`503 quote_unavailable`** and no calldata at all.
  That's deliberate: an unquotable trade has no safe floor, and we won't hand you a
  transaction that would accept any price.

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

Costs **$1 USDC** via x402 — it deploys a contract, and the fee is what stops it being
spammed.

**Check first, it's free.** `POST {base}/launch` with `{ "login": "<twitch_login>" }` and
no payment header returns `200` immediately if that streamer already has a coin:

```json
{ "login": "mr_mammal", "userId": "44858482",
  "coinAddress": "0xb200000000000000000000374f5BABa2B1672f3A", "symbol": "MAMMAL",
  "twinAddress": "0x3794…7aC0", "launchTx": null,
  "alreadyExisted": true, "charged": false, "note": "..." }
```

That's a **success**: report the coin and stop. Don't pay, don't retry.

If they have no coin, the same request returns `402` with the x402 payment envelope:

1. `initiate_x402_request` → `POST {base}/launch`, `{ "login": "<twitch_login>" }`
2. Approve the $1, then `complete_x402_request` to retry with payment.

On success: `{ login, userId, coinAddress, twinAddress, launchTx, alreadyExisted: false }`.
Link the transaction as `https://basescan.org/tx/<launchTx>`.

Notes:
- The name and symbol are derived from the Twitch login server-side. They can't be
  chosen, so don't ask the user for them.
- The streamer doesn't need to consent or even know: the coin belongs to their account
  and they claim it by signing in. Tell the user that plainly before they pay.
- People signed in on yougotcoined.com launch free (one a day). The $1 applies to agents,
  which have no Twitch session to check.

---

## Worked examples

**"Tip ninja 0.01 eth"**
1. `GET /prepare/tip?login=ninja&amount=0.01`
2. Show the recipient, the amount, and that it lands in ninja's account.
3. `send_calls` with the returned call.

**"Buy $20 of mr_mammal's coin"**
1. `GET /prepare/buy?login=mr_mammal&amount=20&pay=usdc&recipient=<wallet>`
2. Show `quoted` tokens and the `minOut` floor.
3. `send_calls` with both calls, in order.

**"Who owns 0x1dAb…f970?"** → `GET /resolve?address=0x1dAb…f970`

**"Launch a coin for shroud"** → `POST /launch` first (free). If it returns `402`, tell
the user it costs $1 and what they're buying, then run the x402 flow.
