# `contracts/`

Solidity sources for the SocialTwin protocol on Base (and any EVM L2).

## Files

| File | Role |
|---|---|
| [`TwinFactory.sol`](./TwinFactory.sol) | CREATE2 factory; predicts and deploys twin addresses |
| [`TwinAccount.sol`](./TwinAccount.sol) | Per-user smart account; gates `execute()` on an `IVerifier` check |
| [`AttestorVerifier.sol`](./AttestorVerifier.sol) | **Default verifier.** ECDSA signatures from approved attestor(s) |
| [`TwitchJWTVerifier.sol`](./TwitchJWTVerifier.sol) | Legacy. Onchain RSA verification of Twitch id_tokens. Kept for adopters who want trust-minimized verification. |
| [`interfaces/IVerifier.sol`](./interfaces/IVerifier.sol) | Common verifier interface |
| [`interfaces/IReclaim.sol`](./interfaces/IReclaim.sol) | Vestigial; remove if you don't need Reclaim compatibility |
| `mocks/MockVerifier.sol` | Test helper — single-key ECDSA verifier |
| `mocks/MockERC20.sol` | Test helper — minimal ERC-20 |

## Toolchain

- Solidity `0.8.24` with `viaIR=true`, `optimizer.runs=200`, `evmVersion=cancun`
- Hardhat for tests + deploy
- @openzeppelin/contracts ^5.1.0

Reproducible builds matter for the CREATE2 prediction. If you change compiler settings, the twin addresses change.

## Tests

```bash
npx hardhat test                          # full suite
npx hardhat test test/TwinAccount.test.ts
npx hardhat test test/AttestorVerifier.test.ts
npx hardhat test test/TwitchJWTVerifier.test.ts
```

All tests pass against the deployed contracts; if you fork and change anything, re-run.

## Deploying

See [`../docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md).
