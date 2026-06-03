# Implementation Plan

> Design only. Phases are sequenced so we can validate the riskiest unknown (x402 path) before
> committing build effort, and so nothing touches mainnet or any public registry until cutover.

## Guiding constraints

- **Secrecy first.** No public skill, no npm publish, no Base skills-registry listing, no mainnet
  endpoints, no announcements until §Cutover. Build and demo on **Base Sepolia** only.
- **Reuse, don't rebuild.** Tips ride Base MCP's `send`; resolution rides `predictAddress`; launch
  reuses the existing `pairable_v1` launcher. The only new surface is two backend routes + one skill.
- **No fund custody.** Validated at every step (see [`ARCHITECTURE.md`](./ARCHITECTURE.md) §Security).

## Phase 0 — Validate the unknowns (no code that ships)

Resolve [`OPEN_QUESTIONS.md`](./OPEN_QUESTIONS.md) before building Launch.

- **Q1 (blocking, Launch only):** Determine how Base MCP pays x402. Spike each path against a throwaway
  Sepolia x402 endpoint:
  - A: does `web_request` (or a built-in capability) follow a `402` and pay via Base Account?
  - B: can Base MCP sign an arbitrary EIP-712 / EIP-3009 typed message we can wrap into `X-PAYMENT`?
  - C: stand up a minimal Vercel-`x402-mcp`-style companion server and confirm it pays.
- **Q2:** Confirm `send` accepts a bare address `to` (not only ENS) and supports both ETH and USDC on Base.
- **Q3:** Confirm the CDP facilitator covers Base Sepolia for staging, and the mainnet free-tier limit (≈1k/mo) is enough.

**Exit:** a one-paragraph decision in `OPEN_QUESTIONS.md` picking A/B/C, plus go/no-go on `send` for tips.

## Phase 1 — Resolve (skill + `/resolve`), Sepolia

- Backend: `GET /v1/st/resolve` (Twitch Helix lookup + `predictAddress` + deployed check). Cache 5 min.
- Twitch app token: client_credentials grant for client_id `epeocrogq8bm1af0lngd9e2rfvrwk1`, server-side, refreshed.
- Skill: Detection + Resolve sections (from [`SKILL_DRAFT.md`](./SKILL_DRAFT.md)).
- **Demo:** "twin for twitch.tv/<handle>?" returns the right address in a Base MCP client.

## Phase 2 — Tip (skill orchestrates `send`), Sepolia

- No new backend. Skill: resolve → `send { asset, amount, to: twinAddress, chain }`.
- Test the pre-deploy case: tip an undeployed twin, then deploy + claim it through the existing
  SocialTwin flow to prove funds were waiting at the CREATE2 address.
- Guardrail test: ensure the skill refuses to tip a raw user-supplied address (resolve-before-send).
- **Demo:** tip flows end-to-end with Base Account approval; streamer claims via Twitch JWT.

## Phase 3 — Launch (x402 `/launch`), Sepolia

- Backend: `POST /v1/st/launch` with x402 middleware (Express/Next pattern), CDP facilitator on Sepolia,
  `payTo` = SocialTwin treasury, `$1` USDC, idempotency table, verify-before-charge, refund queue.
- Wire to the `pairable_v1` launcher for the resolved `userId`.
- Skill: Launch section, using the Phase-0 decided x402 path.
- **Tests:** 402-then-pay happy path; bad login (no 402); already-launched (200, no charge); verify
  failure; settled-but-launch-reverts → refund record; double-submit replay rejected.
- **Demo:** "launch a coin for twitch.tv/<handle>" → $1 settles → coin address returned.

## Phase 4 — Hardening & monitoring

- Rate-limit `/resolve` and `/launch`; size-cap bodies; redact any token in logs.
- Alarms: facilitator settle failures, non-empty `pending_refunds`, Twitch token expiry, launcher revert rate.
- Idempotency soak: hammer `/launch` for one streamer concurrently → exactly one coin, at most one charge.
- Security review pass mirroring the contract red-team discipline (no new on-chain code, but review the
  route auth, the refund path, and the resolve→send guardrail).

## Phase 5 — Cutover (mainnet + publish)

Only after Phases 1–4 are green on Sepolia:
1. Point endpoints + skill `{{SOCIALTWIN_API}}` at the mainnet host; `network` → `eip155:8453`; USDC → `0x8335…2913`.
2. Smoke-test resolve/tip/launch on mainnet with a small real amount.
3. Publish the skill (npm / Base skills registry) and announce. **This is the first public moment.**

## Workstream split

| Workstream | Surface | Depends on |
|---|---|---|
| Backend routes | `/resolve`, `/launch` (x402), idempotency, refunds | Twitch token, facilitator, launcher |
| Skill | `SKILL.md` (3 capabilities) | Phase-0 x402 decision (Launch step) |
| Launcher wiring | `pairable_v1` call for a `userId` | existing launch contract |
| Infra/monitoring | rate limits, alarms, staging host | backend routes |

## Risks (honest)

- **R1 — x402-in-Base-MCP maturity (high/blocking for Launch).** If neither A nor B works, we need the
  companion server (C), which adds infra and a second connector for users. Resolve+Tip are unaffected.
- **R2 — Twitch handle ambiguity.** Renamed/typo'd handles resolve to a different (still valid) twin.
  Mitigation: always echo `displayName`+avatar before any send.
- **R3 — Facilitator dependency.** Settlement leans on CDP's facilitator (free tier, uptime). Mitigation:
  monitor; the protocol is open so an alternate facilitator is possible later.
- **R4 — Paid-but-unlaunched.** Settlement succeeds, launcher reverts. Mitigation: verify-before-charge
  where possible + a bounded, alarmed refund queue; never silently drop.
- **R5 — Secrecy leak.** A premature publish/registry entry tips our hand. Mitigation: staging-only hosts,
  no registry/npm until Phase 5, this folder stays in the private repo.

## Definition of done (per capability)

- Resolve: correct twin for any valid Twitch handle, in a real Base MCP client, < 1s p50.
- Tip: ETH + USDC, approval-gated, works pre- and post-deploy, refuses raw-address targets.
- Launch: exactly-once $1 charge, coin returned, idempotent, refund path proven for the revert case.
