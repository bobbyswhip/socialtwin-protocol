# Implementation Plan

> Design only. Phases are sequenced so we can validate the riskiest unknown (x402 path) before
> committing build effort, and so nothing touches mainnet or any public registry until cutover.

## Status update

The **skill is already shipped and public** — `yougotcoined` in
[`bobbyswhip/skills`](https://github.com/bobbyswhip/skills). So the Skill workstream is done and the
old "secrecy first / no public skill until cutover" constraint no longer applies. The **remaining
work is the `api.waifi.app/v1/st` backend** (`/resolve`, `/launch` x402, `/health`) per
[`API.md`](./API.md), plus the launcher wiring. The phases below are kept as the backend build/test
sequence; ignore the secrecy gating.

## Guiding constraints

- **Reuse, don't rebuild.** Tips ride Base MCP's `send`; resolution rides `predictAddress`; launch
  reuses the existing `pairable_v1` launcher. The only new surface is the backend routes.
- **No fund custody.** Validated at every step (see [`ARCHITECTURE.md`](./ARCHITECTURE.md) §Security).

## Phase 0 — Validate the unknowns (no code that ships)

The original blocker (how Base MCP pays x402) is **already answered** by the Base docs: native
`initiate_x402_request` / `complete_x402_request` tools, Base + USDC only — see
[`OPEN_QUESTIONS.md`](./OPEN_QUESTIONS.md) Q1. Launch is therefore skill-only like the rest. Remaining
checks (non-blocking, can run alongside Phase 1):

- **Q2:** Confirm `send` accepts a bare address `to` (not only ENS) and supports both ETH and USDC on Base.
- **Q3:** Confirm the CDP facilitator covers Base Sepolia for staging, and the mainnet free-tier limit (≈1k/mo) is enough.
- **Smoke:** pay a throwaway $0.001 Sepolia x402 endpoint via `initiate_x402_request`/`complete_x402_request` from a real Base MCP client to confirm the tool round-trip end to end.

**Exit:** Q2/Q3 answered in `OPEN_QUESTIONS.md`; x402 tool round-trip confirmed on Sepolia.

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
- Skill: Launch section calling `initiate_x402_request` (`maxPayment:"1.00"`) → `complete_x402_request`.
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

- **R1 — x402-in-Base-MCP maturity — RESOLVED.** Base MCP ships native `initiate_x402_request` /
  `complete_x402_request` (Base + USDC). No companion server, no manual signing. Was the feared blocker; isn't.
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
