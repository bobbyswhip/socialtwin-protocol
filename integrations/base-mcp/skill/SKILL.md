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
which anyone can buy.

| Want to | Ask for |
|---|---|
| Find a streamer's address, or whose address this is | resolve |
| Pay a streamer in ETH or any ERC-20 | tip |
| Buy a streamer's coin | buy |
| Launch a coin for a streamer who has none ($1 USDC) | launch |

API base: `https://api.waifi.app/v1/st` — Base mainnet, chainId 8453.

## Detection

The Base MCP exposes its tools to the harness when connected. If no Base MCP tool is
callable, the MCP server is not installed: direct the user to
https://docs.base.org/ai-agents/quickstart and stop.

If Base MCP tools are available, continue to Onboarding.

Optional liveness check for this skill's API: `web_request GET {base}/health` →
`{ "status": "ok" }`. A response with `"degraded": true` means the backup is answering:
resolves still work, but tips, buys and launches are briefly unavailable — say so and
retry rather than reporting a failure.

## Onboarding

Once per session, before any real work:

1. **Brief availability mention** — summarize that the user can check balances, send and
   swap tokens, sign messages, make x402 payments, and batch contract calls through
   their Base Account wallet.

2. **Mandatory disclaimer** (verbatim):
   > By using the Base MCP, you agree to the [Base Account and Base App Terms of Service](https://wallet.coinbase.com/terms-of-service). Base MCP provides access to plugins that are built by third parties, not Base. Base doesn't operate, endorse, or audit them, and isn't responsible for the protocols you interact with. Transactions are irreversible — always review before approving.

3. **Optional wallet data** — only show the address and balance when asked, or when an
   operation needs it (buying a coin requires the buyer's address).

Add one line specific to this skill the first time a payment comes up:

> Tips and coin purchases go to the streamer's on-chain account, which they claim by
> signing in with Twitch. You approve every transaction in your own wallet — this skill
> never holds your funds and will never ask for a seed phrase.

## Tools

The Base MCP advertises its own tool catalog to the harness. Read the tool descriptions
exposed by the MCP — they are the source of truth and may change. Do not assume a fixed
list and do not preload a catalog from this skill.

This skill contributes no tools of its own. It calls its HTTP API with `web_request`,
which returns **unsigned calldata**, and that calldata is executed with the MCP's own
batched-call tool. Nothing here signs or sends a transaction; the user approves each one.

## Plugins

| Plugin | File | Loads when |
|---|---|---|
| You Got Coined | `plugins/yougotcoined.md` | the user mentions a Twitch streamer, tipping one, a streamer coin, or launching a coin |

Load the plugin only when the request matches — don't preload it.

Loading is local-first: read `plugins/yougotcoined.md` from the skill directory, which is
canonical. Only if that fails, fall back to
`web_request GET https://api.waifi.app/v1/st/skill/plugins/yougotcoined.md`.

## Installation

```bash
npx skills add bobbyswhip/skills --skill yougotcoined
```

Or load it straight from the hosted copy, with no install:

```
web_request GET https://api.waifi.app/v1/st/skill/SKILL.md
```
