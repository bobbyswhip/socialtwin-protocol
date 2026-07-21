---
name: yougotcoined
description: Every Twitch streamer has an on-chain account on Base. Resolve one, tip them in ETH or any token, buy their coin, or launch a coin for a streamer who doesn't have one — from a plain-language request.
version: 1.1.0
requires_mcp: base-mcp
homepage: https://yougotcoined.com
---

# You Got Coined

Every Twitch streamer has an on-chain account on Base — derived from their Twitch user
id, so it exists before they ever sign up. Anyone can pay a streamer there; the streamer
claims it later by signing in with Twitch. Streamers can also have a **coin** that anyone
can buy.

You do four things, each from a Twitch handle:

| Do | You give | Endpoint |
|---|---|---|
| **Resolve** — find a streamer's address (or whose address one is) | a handle, or an address | `GET /resolve` |
| **Tip** — pay a streamer in ETH or any ERC-20 | handle + amount | `GET /prepare/tip` |
| **Buy** — buy a streamer's coin | handle + amount | `GET /prepare/buy` |
| **Launch** — create a coin for a streamer who has none | just the handle | `POST /launch` |

API base: **`https://api.waifi.app/v1/st`** — Base mainnet, chainId 8453. Hitting the
base URL returns a manifest of everything below.

Every money endpoint returns **unsigned calldata** — the transaction to run, never a
signature. The user's own wallet signs it and approves it in Base Account. This API never
holds funds and never asks for a key.

## Detection

The Base MCP exposes its tools when connected. If no Base MCP tool is callable, the
server isn't installed: point the user to https://docs.base.org/ai-agents/quickstart and
stop. Otherwise continue to Onboarding.

Liveness: `web_request GET {base}/health`. A response with `"degraded": true` is the
standby answering — resolves still work, but tips, buys and launches are briefly down, so
say so and retry rather than reporting failure.

## Onboarding

Once per session, before the first action:

1. **Availability** — mention the user can check balances, send and swap tokens, sign
   messages, make x402 payments, and batch contract calls through their Base Account.

2. **Disclaimer** (verbatim):
   > By using the Base MCP, you agree to the [Base Account and Base App Terms of Service](https://wallet.coinbase.com/terms-of-service). Base MCP provides access to plugins that are built by third parties, not Base. Base doesn't operate, endorse, or audit them, and isn't responsible for the protocols you interact with. Transactions are irreversible — always review before approving.

3. **Wallet data** — show the address or balance only when asked, or when an action needs
   it (a buy needs the buyer's address).

The first time money moves, add:
   > Tips and coin purchases go to the streamer's on-chain account, which they claim by
   > signing in with Twitch. You approve every transaction in your own wallet — I never
   > hold your funds and will never ask for a seed phrase.

## Tools

Read the tool catalog the Base MCP advertises — it's the source of truth and can change;
don't assume a fixed list. This skill adds no tools of its own: it fetches its API with
`web_request` and runs the returned calldata with the MCP's batched-call tool.

## Conventions

- **Amounts** are decimal strings in the asset spent: `"0.01"` ETH, `"5"` USDC. No
  scientific notation or thousands separators.
- **Errors** are `{ "error", "detail" }` — read `detail` to the user, don't blind-retry.
- **Rate limit** — 20 requests/second per IP. On `429`, wait for `Retry-After` (1s).
- **Status** — `400` bad input · `404` doesn't exist · `429` slow down · `503` couldn't
  complete, retry. A `503` never means the streamer or token doesn't exist.
- **send_calls** — pass a response's `calls` array in order, dropping `chainId` from each:
  `{ "chain": "base", "calls": [ { "to", "value", "data" } ] }`. Two calls means
  approve-then-act; send them as **one** batch, never separately. `value` is already hex
  wei — don't convert it again.

---

## Resolve

```
GET {base}/resolve?login=<handle>        # streamer → their address
GET {base}/resolve?userId=<twitch_id>    # same, without contacting Twitch (login/profile come back null)
GET {base}/resolve?address=0x…           # address → the streamer who owns it
```

```json
{ "login": "mmorpg", "userId": "41684297",
  "twinAddress": "0x1dAb8db1e06db23bB41c1CD6b09e9bF784A7f970",
  "deployed": false, "chainId": 8453,
  "profile": { "displayName": "Mmorpg", "avatarUrl": "https://…" } }
```

`deployed: false` is normal — the address is valid and can receive funds before the
contract exists. The `address=` form returns the identity flat (no `profile`) plus
`matchedVia` (`"twin"` = the streamer's own account, `"owner"` = their linked wallet) and
`coin`. On `address=`, `404` means unknown, `503` means we couldn't check — only `404`
says anything about the address.

**You can resolve a handle without this API:** Twitch login → user id via Twitch's public
GQL (`https://gql.twitch.tv/gql`, client id `kimne78kx3ncx6brgo4mv6wki5h1ko`), then user
id → address via `predictAddress(uint64)` on the factory
`0x260C074c3afDc46A209D4619B5FAdB2964dF9a28`. It's CREATE2 — deterministic and permanent.
The reverse (address → Twitch) can't be derived, so that one needs us.

## Tip

```
GET {base}/prepare/tip?login=<handle>&amount=<decimal>[&token=0x…]
```

Omit `token` for ETH; pass any ERC-20 to tip that token (decimals read on-chain, so
`amount=5` with USDC means 5 USDC). Returns one call — an ETH transfer, or a single ERC-20
`transfer` straight to the streamer. No approval, because nothing of ours sits in between.

```json
{ "action": "tip", "asset": "USDC", "amount": "5", "amountWei": "5000000",
  "streamer": { "login": "mmorpg", "twinAddress": "0x1dAb…f970", "displayName": "Mmorpg" },
  "calls": [ { "to": "0x8335…2913", "value": "0x0", "data": "0xa9059cbb…", "chainId": 8453 } ],
  "chain": "base", "chainId": 8453 }
```

## Buy

```
GET {base}/prepare/buy?login=<handle>&amount=<decimal>&pay=eth|usdc&recipient=0x…
GET {base}/prepare/buy?token=0x…&amount=<decimal>&pay=eth|usdc[&recipient=0x…]
```

- `pay` — `eth` or `usdc`. Omitting it means ETH; anything else is rejected (we won't
  guess which asset you're spending).
- `recipient` — the buyer, from `get_wallets`. **Required** for a coin launched here; the
  tokens are sent straight to it.
- `slip` — slippage in bps, default `300` (3%).

> **Prefer `pay=usdc` for a streamer's coin.** These coins are USDC-paired, so paying in
> USDC trades directly against the pair; ETH adds a hop and returns fewer tokens. The
> response flags this in a `tip` field whenever you ask for ETH.

```json
{ "action": "buy", "token": "0xb200…2f3a", "platformCoin": true, "pay": "usdc",
  "streamer": { "login": "mr_mammal", "symbol": "MAMMAL" },
  "amount": "2", "amountWei": "2000000", "recipient": "0x4025…0000",
  "quoted": "1152032661179953537792", "minOut": "1117471681344554931659",
  "slippageBps": 300, "quoteOk": true,
  "calls": [ { "to": "0x8335…2913", "value": "0x0", "data": "0x095ea7b3…", "chainId": 8453 },
             { "to": "0x14d1…924F", "value": "0x0", "data": "0x0fbc337d…", "chainId": 8453 } ],
  "chain": "base", "chainId": 8453 }
```

- `platformCoin: true` — a coin launched here, bought through our own contract. A generic
  DEX aggregator finds no route for these; use this endpoint.
- `platformCoin: false` — any other Base token, routed across Uniswap/Aerodrome. It adds
  `venue` and takes a 1% fee before the swap (`swappedWei` is what reaches the pool,
  `feeBps: 100`) — mention it when you show the cost.
- `quoted` is the expected output, `minOut` the floor after slippage. If a trade can't be
  quoted you get `503 quote_unavailable` and **no** calldata — deliberate, so you never
  sign a swap with no price protection.

## Launch

**Give one thing: the streamer's Twitch handle.** The backend derives the ticker and
name, deploys the contract, and configures everything. You don't choose or send a symbol,
name, or supply — there are no other inputs.

```
POST {base}/launch          body: { "login": "<handle>" }
```

It costs **$1 USDC**, paid with x402 (the fee is what keeps it from being spammed).

1. **Check first — it's free.** Post with no payment. If the streamer already has a coin
   you get `200` right away:
   ```json
   { "login": "mr_mammal", "coinAddress": "0xb200…2f3a", "symbol": "MAMMAL",
     "twinAddress": "0x3794…7aC0", "alreadyExisted": true, "charged": false }
   ```
   That's a success — report the coin and stop. Don't pay, don't retry.

2. If they have no coin, the same request returns `402` with the x402 payment details.
   `initiate_x402_request` → pay the $1 → `complete_x402_request` to retry. On success:
   `{ login, userId, coinAddress, twinAddress, launchTx, alreadyExisted: false }`. Link
   the tx as `https://basescan.org/tx/<launchTx>`.

The streamer doesn't need to consent or even know — the coin belongs to their account and
they claim it by signing in later. Say that plainly before the user pays. (On
yougotcoined.com people launch free, one a day; the $1 is the agent path, since an agent
has no Twitch login to rate-limit against.)

---

## Examples

- **"tip ninja 0.01 eth"** → `GET /prepare/tip?login=ninja&amount=0.01` → show it lands in
  ninja's account → `send_calls`.
- **"buy $20 of mr_mammal's coin"** → `GET /prepare/buy?login=mr_mammal&amount=20&pay=usdc&recipient=<wallet>`
  → show `quoted` and `minOut` → `send_calls` (both calls, in order).
- **"who owns 0x1dAb…f970?"** → `GET /resolve?address=0x1dAb…f970`.
- **"launch a coin for shroud"** → `POST /launch {login:"shroud"}`. If `402`, tell them
  it's $1 and what they're getting, then run the x402 flow.

## Installation

```bash
npx skills add bobbyswhip/skills --skill yougotcoined
```

Or use it with no install — the hosted copy is always current:

```
web_request GET https://api.waifi.app/v1/st/skill
```
