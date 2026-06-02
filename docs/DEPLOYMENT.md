# Deployment guide

Deploying the SocialTwin stack (`TwitchJWTVerifier` + `TwinFactory`) to Base. The live v1.2 addresses are in the root [`README.md`](../README.md) — you only redeploy when you change a contract.

## Prerequisites

```bash
npm install
npm run compile
npm test          # 101 passing
cp .env.example .env
```

`.env`:
```
PRIVATE_KEY=0x...            # deployer (needs a little Base ETH for gas)
BASE_RPC_URL=https://...     # a reliable Base RPC (defaults to mainnet.base.org)
BASESCAN_API_KEY=...         # for source verification
```

> Public RPCs sometimes rate-limit `eth_sendTransaction` or lag on read-after-write. If a deploy errors mid-flight, the tx usually still landed — recover the address from the deployer nonce (`getCreateAddress`) rather than redeploying.

## What the scripts do

| Script | Deploys |
|---|---|
| `scripts/deploy-twin-stack.ts` | Full stack: `TwitchJWTVerifier(kids, moduli, auds, audAdmin)` **and** a `TwinFactory(verifier, rescuer)`. `audAdmin` and `rescuer` are set to the treasury. |
| `scripts/deploy-twin-factory.ts` | A `TwinFactory` pointing at an **existing** verifier (`VERIFIER_BY_CHAIN`). Use this when only `TwinAccount`/`TwinFactory` changed and you want to reuse the live verifier. |
| `scripts/deploy-local.ts` | Full stack to a local hardhat node with a generated test RSA key (the verifier's `aud` check is turned off for the harness). |

Constructor inputs the stack script hard-codes: Twitch `kid="1"` + its RSA-2048 modulus, the official `client_id` as the initial `aud`, and the treasury as `audAdmin` + `rescuer`.

## Deploy + verify

```bash
npm run deploy:stack:base       # verifier + factory
# or, reuse the live verifier and deploy only a new factory:
npm run deploy:factory:base
```

Then verify on Basescan (the stack script attempts this automatically; otherwise):

```bash
npx hardhat verify --network base <verifier> '["1"]' '["0x<modulus>"]' '["<client_id>"]' <treasury>
npx hardhat verify --network base <factory> <verifier> <treasury>
```

Verified source ⇒ the deployed bytecode provably equals this repo, which is what makes the test suite meaningful for the live contracts.

## After a CONTRACT change (important)

Changing `TwinAccount` changes its creation code, which changes **every twin address** and the factory bytecode. So:

1. `npm run compile`, then re-sync the SDK's `TWIN_ACCOUNT_INIT_CODE` from `artifacts/contracts/TwinAccount.sol/TwinAccount.json` → `sdk/src/abis.ts`.
2. Cross-check: the SDK's `predictTwinAddress(...)` must equal the new `factory.predictAddress(...)` for a sample id before anyone funds an address.
3. Deploy a **new factory** (the verifier can be reused if it didn't change).
4. Repoint integrations (frontend env, relayer's factory address) and mark the old factory deprecated. Funds in old twins stay controlled by the old contracts.

## Post-deploy checks

- `factory.verifier()` and `factory.rescuer()` are the intended addresses.
- `verifier.audCheckEnabled()`, `verifier.audAdmin()`, the official `client_id` is allowlisted, `kid="1"` modulus is 256 bytes.
- An adversarial `eth_call` matrix (non-rescuer rescue → reverts, `execute` with a bogus JWT → reverts, etc.) passes against a freshly-deployed twin — see the "Post-deploy red-team" section of [`AUDIT_RESPONSE.md`](../AUDIT_RESPONSE.md).

## Operational keys

`audAdmin` and `rescuer` should be a multisig (see [`SECURITY.md`](../SECURITY.md)). The deployer key only needs gas and holds no protocol power after deployment.
