# `contracts/`

Solidity sources for the SocialTwin protocol on Base.

## Files

| File | Role |
|---|---|
| [`TwinFactory.sol`](./TwinFactory.sol) | CREATE2 factory; predicts + deploys deterministic twin addresses; holds the `rescuer` role |
| [`TwinAccount.sol`](./TwinAccount.sol) | Per-user smart account. JWT path (`execute`/`executeBatch`), self-custody owner path (`executeAsOwner`/`setOwnerEOA`/`rotateOwnerEOA`), two-phase rescue (`initiateRescue`/`completeRescue`) |
| [`TwitchJWTVerifier.sol`](./TwitchJWTVerifier.sol) | **The deployed verifier.** Verifies Twitch RS256 id_tokens entirely onchain (modexp precompile); timelocked `aud` allowlist + off-switch |
| [`interfaces/IVerifier.sol`](./interfaces/IVerifier.sol) | Pluggable verifier interface: `verify(userId, actionHash, epoch, proof)` |
| `SocialTwinEscrow.sol` | Legacy escrow-model prototype; **not deployed**; retained for reference |
| `mocks/MockVerifier.sol` | Test helper — single-key ECDSA verifier (used by the legacy escrow tests) |
| `mocks/MockERC20.sol` | Test helper — minimal ERC-20 |

> The optional `AttestorVerifier` (a 1-of-N attestor model) was **removed in v1.1** — see [`../AUDIT_RESPONSE.md`](../AUDIT_RESPONSE.md), Finding 4.

## Toolchain

- Solidity `0.8.24` with `viaIR=true`, `optimizer.runs=200`, `evmVersion=cancun`
- Hardhat for tests + deploy; `@openzeppelin/contracts` ^5.1.0

Reproducible builds matter for CREATE2 prediction: changing compiler settings changes every twin address (and the SDK's `TWIN_ACCOUNT_INIT_CODE`).

## Tests

```bash
npx hardhat test                              # full suite
npx hardhat test test/TwinAccount.test.ts
npx hardhat test test/TwinV2Features.test.ts  # escape-EOA + two-phase rescue
npx hardhat test test/TwitchJWTVerifier.test.ts
npx hardhat test test/FuzzVerifier.test.ts    # parser fuzzing (audit Finding 6)
npx hardhat test test/RedTeam.test.ts         # adversarial vectors
```

## Deploying

See [`../docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md) and [`../scripts/deploy-twin-stack.ts`](../scripts/deploy-twin-stack.ts) (deploys `TwitchJWTVerifier` + `TwinFactory`).
