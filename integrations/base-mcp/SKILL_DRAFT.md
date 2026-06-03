# SKILL_DRAFT — the Base MCP skill we'd ship

> Draft of the actual skill artifact, following Base MCP's skill conventions (frontmatter +
> sections: Description, Detection, Onboarding, Tools, Plugins, Installation; lazy loading;
> "local-first, web-fallback" reference loading via `web_request`). This is the file a user would
> install into Base MCP. **Do not publish until cutover.**

The block below is the candidate `SKILL.md`. Endpoints point at staging until cutover.

---

```markdown
---
name: socialtwin
description: Resolve Twitch streamers to their SocialTwin twin address, tip them in ETH/USDC, and launch streamer coins on Base.
version: 0.0.1
requires_mcp: base-mcp
---

# SocialTwin Skill

Lets a Base MCP user interact with SocialTwin: per-Twitch-streamer smart accounts ("twins") on Base.
Three things: **resolve** a Twitch handle to its twin, **tip** a streamer, **launch** a streamer coin.

## Detection
- Confirm Base MCP is connected: the tools `get_wallets`, `send`, and `web_request` must be advertised.
  If not, tell the user to add the Base MCP connector (`https://mcp.base.org`) and stop.
- Base URL for SocialTwin endpoints: `{{SOCIALTWIN_API}}` (default `https://api.socialtwin.example/v1/st`).

## Onboarding (once per session, before the first action)
> [!IMPORTANT]
> Say briefly: "SocialTwin tips go to the streamer's on-chain twin; they claim with their Twitch
> login. Launching a coin costs $1 USDC (anti-spam). All payments are approved in your Base wallet."
> Never ask for a private key or seed phrase.

## Tools (how to do each task)

### Resolve a streamer
1. `web_request GET {{SOCIALTWIN_API}}/resolve?login=<twitch_username>`.
2. Echo back `displayName`, `twinAddress`, and whether it's `deployed`. If `deployed:false`, note
   that tips still work and the streamer claims later — it is NOT a blocker.

### Tip a streamer (ETH or USDC)
1. Resolve the handle first (above). Show the user the resolved streamer + twin address and the
   amount, and get a clear go-ahead.
2. Call the Base MCP **`send`** tool: `{ asset: <ETH|USDC>, amount: <amount>, to: <twinAddress>,
   chain: "base" }`. Base Account shows the approval modal; the user confirms there.
3. On success, report the tx hash and remind them the streamer claims via their Twitch login.
> [!IMPORTANT] Never send to anything but the `twinAddress` returned by `/resolve`. Do not accept a
> raw address from the user as the tip target — always resolve from the Twitch handle.

### Launch a streamer coin ($1 USDC via x402)
1. Resolve the handle. Confirm with the user that launching costs **$1 USDC**.
2. `web_request POST {{SOCIALTWIN_API}}/launch` with body `{ "login": "<handle>" }`.
3. The endpoint is x402-gated: it will respond `402 Payment Required` with payment requirements.
   Complete the x402 payment using Base MCP's payment/sign capability (pay exactly $1 USDC on Base
   to the stated recipient), then retry the request with the payment attached.
   - If Base MCP cannot drive the x402 flow, STOP and tell the user the launch flow isn't available
     in this client yet — do not attempt a manual transfer as a substitute.
4. On `200`, report `coinAddress` and the launch tx. If `alreadyExisted:true`, tell the user the coin
   already existed and **no charge** was made.

## Plugins
- None required. This skill rides on Base MCP's native `send` / `web_request` / signing tools.
  (If a companion `socialtwin-x402` MCP server is later introduced for Launch, document it here and
  load it lazily only when the user asks to launch.)

## Installation
`npx @socialtwin/base-skill install`  (placeholder — not published yet)
```

---

## Authoring notes (not part of the shipped skill)

- **Lazy loading:** keep the skill short; if we add long reference docs (e.g. a launch-params guide),
  put them in sibling files and load via `web_request` only when launching, per Base's pattern.
- **`{{SOCIALTWIN_API}}` templating:** ship pointing at staging; flip to the mainnet host at cutover.
- **The x402 step (step 3 of Launch) is deliberately abstract** because the exact mechanism depends on
  [`OPEN_QUESTIONS.md`](./OPEN_QUESTIONS.md) Q1. Once the path (A/B/C) is decided, rewrite that step
  concretely (e.g. "use the `pay`/`sign_typed_data` tool with these EIP-3009 fields").
- **Tone/safety:** mirrors Base's skill conventions — explicit disclaimer in Onboarding, approvals via
  Base Account, never handle secrets. Resolve-before-send is enforced in the Tip instructions to stop
  the agent from sending to an arbitrary address.
