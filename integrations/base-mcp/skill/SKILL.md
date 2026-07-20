---
name: yougotcoined
description: Resolve Twitch streamers to their on-chain account on Base, tip them in ETH or any ERC-20, buy their coin, and launch a coin for a streamer who doesn't have one.
version: 1.0.0
requires_mcp: base-mcp
homepage: https://yougotcoined.com
---

# You Got Coined

Every Twitch streamer has an on-chain account on Base — a **twin** — derived from their
Twitch user id. Anyone can pay a streamer there before they've ever signed up; the
streamer claims it later with their Twitch login. Streamers can also have a **coin**,
tradeable by anyone.

This skill does four things:

| Want to | Use |
|---|---|
| Find a streamer's address, or whose address this is | `resolve` |
| Pay a streamer in ETH or any ERC-20 | `tip` |
| Buy a streamer's coin | `buy` |
| Launch a coin for a streamer ($1 USDC) | `launch` |

## Detection

Confirm Base MCP is connected — `get_wallets`, `send_calls`, `web_request`,
`initiate_x402_request` and `complete_x402_request` must be advertised. If they aren't,
tell the user to add the Base MCP connector (`https://mcp.base.org`) and stop.

- API base: `https://api.waifi.app/v1/st`
- Liveness: `web_request GET {base}/health` → `{ "status": "ok" }`

## Plugins

| Plugin | File | Loads when |
|---|---|---|
| You Got Coined | `plugins/yougotcoined.md` | the user mentions a Twitch streamer, tipping, a streamer coin, or launching one |

Load on demand, local-first with a web fallback:
`web_request GET https://api.waifi.app/v1/st/skill/plugins/yougotcoined.md`

## Installation

```bash
npx skills add yougotcoined
```

Or load it straight from the hosted copy, no install:

```
web_request GET https://api.waifi.app/v1/st/skill/SKILL.md
```

## Safety

Every value-moving step is unsigned calldata returned by this API and executed through
Base MCP's `send_calls`, so the user approves it in their own wallet. This skill never
asks for a private key or seed phrase, and the API never holds funds.
