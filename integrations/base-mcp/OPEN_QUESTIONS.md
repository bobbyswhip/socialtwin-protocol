# Open Questions (validate before building)

Answer these in Phase 0. Q1 blocks **Launch only**; Resolve + Tip can proceed in parallel.

## Q1 — How does Base MCP pay an x402 endpoint? **(blocking, Launch)**
x402 "exact" needs a signed **EIP-3009 `transferWithAuthorization`** in an `X-PAYMENT` header — not a
plain transfer. Determine which path Base MCP supports today, in priority order:
- **A (transparent):** `web_request` (or a built-in x402 capability) auto-follows `402` and pays via Base Account.
- **B (skill-orchestrated):** Base MCP exposes arbitrary EIP-712 / EIP-3009 typed-data signing we can wrap into `X-PAYMENT`.
- **C (companion plugin):** run a small x402-enabled MCP server (cf. Vercel `x402-mcp`) exposing one `socialtwin_launch` tool.

**Test:** stand up a throwaway Sepolia x402 endpoint ($0.001) and try to pay it from a Base MCP client via A, then B, then C.
**Output:** pick A/B/C here, then rewrite the Launch step in [`SKILL_DRAFT.md`](./SKILL_DRAFT.md) concretely.

> _Answer:_ _(TBD)_

## Q2 — Does Base MCP's `send` take a bare address + both assets on Base?
Confirm `send { to: <0x address>, asset: ETH|USDC, amount, chain: base }` works (not ENS-only), and the
approval modal shows asset/amount/recipient. **Output:** go/no-go for Tip (Phase 2).

> _Answer:_ _(TBD)_

## Q3 — CDP facilitator coverage + limits
Does the CDP facilitator support **Base Sepolia** (for staging) and Base mainnet, and is the free tier
(~1,000 settlements/mo) enough for expected launch volume? Is there a fee beyond gas? **Output:** facilitator config + whether we need a paid tier at cutover.

> _Answer:_ _(TBD)_

## Q4 — Skill distribution mechanics
How is a third-party skill installed/updated in Base MCP (npm package? GitHub release upload? registry
listing?) and can we keep it **unlisted** during staging while still loading it into our own client for
testing? **Output:** the secrecy-preserving install path for Phases 1–4.

> _Answer:_ _(TBD)_

## Q5 — Launcher interface for a `userId`
Exact `pairable_v1` entry point to launch a coin bound to a Twitch `userId`/twin: function signature,
who deploys (our key vs the user), and whether a coin is one-per-streamer (drives the idempotency key).
**Output:** the call `/launch` makes after settlement.

> _Answer:_ _(TBD)_

## Q6 — Treasury recipient for the $1
Which address is the x402 `payTo` for launch fees — the existing treasury `0xD1EC…` or a dedicated
revenue address? **Output:** the `payTo` constant in the 402 requirements.

> _Answer:_ _(TBD)_
