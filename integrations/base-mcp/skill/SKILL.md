---
name: yougotcoined
description: Every Twitch streamer has an on-chain account on Base. Resolve one, tip them in ETH or any token, buy their coin, or launch a coin for a streamer who doesn't have one — from a plain-language request.
version: 1.2.0
requires_mcp: base-mcp
homepage: https://yougotcoined.com
---

# You Got Coined

Every Twitch streamer has an on-chain account on Base — derived from their Twitch user
id, so it exists before they ever sign up. Anyone can pay a streamer there; the streamer
claims it later by signing in with Twitch. Streamers can also have a **coin** that anyone
can buy.

Four things, each starting from a Twitch handle:

| Do | You give | Endpoint |
|---|---|---|
| **Resolve** a streamer's address | a handle | `GET /resolve` |
| **Tip** a streamer | a handle + an amount | `GET /prepare/tip` |
| **Buy** a streamer's coin | a handle + an amount | `GET /prepare/buy` |
| **Launch** a coin for a streamer with none | just a handle | `POST /launch` |

API base: **`https://api.waifi.app/v1/st`** — Base mainnet (chainId 8453). Hitting the
base URL returns a manifest of everything below.

**How the money endpoints work:** you call the API, it returns **unsigned calldata** — the
transaction to run. You hand that to the Base MCP's batched-call tool; the user's wallet
signs and approves it. This API never signs, sends, or holds funds.

## Detection

The Base MCP exposes its tools when connected. If no Base MCP tool is callable, the
server isn't installed: point the user to https://docs.base.org/ai-agents/quickstart and
stop. Otherwise continue to Onboarding.

## Onboarding

Once per session, before the first action:

1. **Availability** — mention the user can check balances, send and swap tokens, sign
   messages, make x402 payments, and batch contract calls through their Base Account.

2. **Disclaimer** (verbatim):
   > By using the Base MCP, you agree to the [Base Account and Base App Terms of Service](https://wallet.coinbase.com/terms-of-service). Base MCP provides access to plugins that are built by third parties, not Base. Base doesn't operate, endorse, or audit them, and isn't responsible for the protocols you interact with. Transactions are irreversible — always review before approving.

3. **Wallet data** — show the address or balance only when asked, or when an action needs
   it (a buy needs the buyer's address, which you take from `get_wallets`).

The first time money moves, add:
   > Payments go to the streamer's on-chain account, which they claim by signing in with
   > Twitch. You approve every transaction in your own wallet — I never hold your funds
   > and will never ask for a seed phrase.

## Running the result

Every `prepare` response and the tip response contain a `calls` array. Run it with the
Base MCP's batched-call tool, in order, dropping `chainId` from each entry:

```json
{ "chain": "base", "calls": [ { "to": "0x…", "value": "0x…", "data": "0x…" } ] }
```

Two entries means approve-then-act — send them as **one** batch, never separately. `value`
is already hex wei; don't reconvert it. Everything else in the response is there for you
to show the user (amounts, the quote, the streamer) — you don't pass it anywhere.

Amounts are plain decimal strings in the asset being spent: `"0.01"` ETH, `"5"` USDC.
Errors come back as `{ error, detail }` — show `detail`. Rate limit is 20 requests/second.

---

## Resolve

**Send:** one of `login` (a handle), `userId`, or `address` (reverse lookup).

```
GET {base}/resolve?login=mmorpg
```

**Get back:** `twinAddress` — the streamer's account — plus their display name and avatar.
`deployed: false` is normal; the address works before the contract exists. The `address=`
form returns the streamer who owns an address (or `404` if unknown).

You can also resolve a handle yourself, with no call to us: Twitch login → user id via
Twitch's public GQL, then `predictAddress(uint64)` on factory
`0x260C074c3afDc46A209D4619B5FAdB2964dF9a28` (CREATE2 — deterministic).

## Tip

**Send:**

| Field | Required | |
|---|---|---|
| `login` | yes | the streamer's handle |
| `amount` | yes | how much, e.g. `0.01` |
| `token` | no | an ERC-20 address to tip that token; omit for ETH |

```
GET {base}/prepare/tip?login=mmorpg&amount=5&token=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
```

**Get back:** one `call` — a plain transfer to the streamer. Run it. (5 USDC in this
example; decimals are handled for you, so pass human amounts.)

## Buy

**Send:**

| Field | Required | |
|---|---|---|
| `login` *or* `token` | yes | the streamer's handle, or a token address directly |
| `amount` | yes | how much to spend |
| `pay` | no | `eth` or `usdc`; omit for ETH. Prefer **`usdc`** — these coins are USDC-paired, so ETH adds a hop and buys fewer tokens |
| `recipient` | for a streamer's coin | the buyer's address, from `get_wallets` (the tokens are sent straight to it) |

```
GET {base}/prepare/buy?login=mr_mammal&amount=20&pay=usdc&recipient=0xYourWallet
```

**Get back:** the `calls` to run, plus `quoted` (tokens you'll get) and `minOut` (the
floor after slippage) to show the user. If a coin can't be quoted you get `503` and no
calldata — so you never sign a trade with no price protection.

## Launch

**Send: just the handle.** That's the only input. The backend generates the ticker and
name, deploys the contract, and configures everything — the same way coins are launched on
the site. You don't pick or pass a symbol, name, or supply.

```
POST {base}/launch     body: { "login": "shroud" }
```

It costs **$1 USDC**, paid with x402 (the fee keeps it from being spammed):

1. Post with no payment. If the streamer already has a coin you get **`409`** with its
   address — a streamer can only have one, so buy that instead. Otherwise you get a `402`
   with the price.
2. `initiate_x402_request` → pay the $1 → `complete_x402_request` to retry.

**Get back:** `{ ok, coinAddress, symbol, twinAddress, launchTx }`. Link the tx as
`https://basescan.org/tx/<launchTx>`. The streamer doesn't need to know — the coin is
theirs and they claim it by signing in later. Say that before the user pays.

---

## Examples

- **"tip ninja 0.01 eth"** → `GET /prepare/tip?login=ninja&amount=0.01` → run the call.
- **"buy $20 of mr_mammal's coin"** → `GET /prepare/buy?login=mr_mammal&amount=20&pay=usdc&recipient=<wallet>`
  → show `quoted`, run the calls.
- **"who owns 0x1dAb…f970?"** → `GET /resolve?address=0x1dAb…f970`.
- **"launch a coin for shroud"** → `POST /launch {login:"shroud"}` → tell them it's $1,
  then run the x402 flow.

## Installation

```bash
npx skills add bobbyswhip/skills --skill yougotcoined
```

Or use it with no install — the hosted copy is always current:

```
web_request GET https://api.waifi.app/v1/st/skill
```
