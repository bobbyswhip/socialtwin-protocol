# `docs/`

Adopter and operator guides. Start at the root [`README.md`](../README.md) for what this is and the live addresses.

## Build on it
- [`INTEGRATION.md`](./INTEGRATION.md) — integrate into a dApp (read state, fund by identity, Twitch-JWT claim, self-custody, gasless relaying)
- [`../sdk/README.md`](../sdk/README.md) — the `@socialtwin/sdk` TypeScript helpers

## Run / deploy it
- [`DEPLOYMENT.md`](./DEPLOYMENT.md) — deploy + verify the stack; what to do after a contract change
- [`VERIFICATION.md`](./VERIFICATION.md) — (re)verify any contract on Basescan, incl. the per-twin case that doesn't auto-verify on deploy
- [`../monitoring/`](../monitoring/) — the JWKS watchdog: run on a schedule to catch a Twitch key rotation (and a malicious queued key) within the timelock window

## Understand / evaluate it
- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — how the pieces fit
- [`../PROTOCOL.md`](../PROTOCOL.md) — exact wire formats (CREATE2, action-hash binding, OIDC flow, verification)
- [`../SECURITY.md`](../SECURITY.md) — threat model, trust roots, privileged roles, residual risks
- [`../PERMANENCE.md`](../PERMANENCE.md) — does it survive the operator disappearing?
- [`../AUDIT_RESPONSE.md`](../AUDIT_RESPONSE.md) — external review (Sterling Crispin) + fixes + live red-team
- [`../RED_TEAM_FINDINGS.md`](../RED_TEAM_FINDINGS.md) — internal adversarial vectors
- [`../CHANGELOG.md`](../CHANGELOG.md) — version history
