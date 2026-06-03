# Open Questions (validate before building)

Answer these in Phase 0. (Q1 — the original blocker — is now **answered** by the Base docs.)

## Q1 — How does Base MCP pay an x402 endpoint? ✅ ANSWERED
**Answer:** Base MCP has native x402 tools — `initiate_x402_request(url, method, maxPayment, body?,
headers?, agentWalletId?)` then `complete_x402_request(requestId)` — and handles the challenge,
the Base Account signature, and the replay itself (per
<https://docs.base.org/ai-agents/guides/x402-payments>). The skill does **not** build an `X-PAYMENT`
header or sign EIP-3009; it just calls the two tools with `maxPayment:"1.00"`. x402 there is **Base /
Base Sepolia only** and **USDC only**, which matches our $1-USDC-on-Base launch fee. No companion
server is needed — Launch is skill-only, like Resolve and Tip. (The earlier A/B/C path tree is moot.)

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
