> **⚠️ Superseded (v1.1, post-audit):** This document predates the audit response and describes the earlier **attestor / off-chain-signer** model, which was **removed**. The deployed protocol verifies Twitch JWTs **entirely onchain** (`TwitchJWTVerifier`), with a two-phase abandoned-funds rescue and a timelocked `aud` allowlist. For the current design see [`README.md`](../README.md) and [`AUDIT_RESPONSE.md`](../AUDIT_RESPONSE.md); the onchain-JWT review is in [`SECURITY_REVIEW.md`](../SECURITY_REVIEW.md). Retained for historical context.

# Deployment guide

How to deploy the contracts to a new chain or with a new attestor set. The reference instance on Base mainnet is at:

- `TwinFactory` — `0x5204a18785ce8ab080B7194A679e5f0605A7b6Ec`
- `TwitchJWTVerifier` (legacy onchain JWT) — `0xE4CC251864B0271903D458a9F5731D38ed3eeA39`

For the new attestor-based path, you'll deploy your own `AttestorVerifier` and a new `TwinFactory` pointing at it.

## 1. Prepare the attestor signing key

```bash
# Generate a fresh ECDSA key (production should use HSM or KMS)
node -e "console.log('0x' + require('crypto').randomBytes(32).toString('hex'))"
# → 0xa1b2c3...

# Compute its address (this goes into the verifier constructor)
node -e "
  const { privateKeyToAddress } = require('viem/accounts');
  console.log(privateKeyToAddress('0xa1b2c3...'));
"
# → 0xATTESTOR_ADDRESS
```

Treat the private key like a CA root: HSM, KMS, or air-gapped storage. Anyone with this key can drain every twin bound to this verifier.

## 2. Deploy AttestorVerifier

```bash
cd contracts
# Set deployer key + RPC in .env, then:
npx hardhat run scripts/deploy-attestor-verifier.ts --network base
```

The script in `scripts/deploy-attestor-verifier.ts` (write this — see template below) deploys with a hardcoded set of approved attestor addresses:

```ts
const APPROVED_ATTESTORS = [
  "0xATTESTOR_ADDRESS",
  // add more here for 1-of-N federation
];
```

**Verify on Basescan immediately** so adopters can audit:

```bash
npx hardhat verify --network base <verifier_address> "[<addr1>,<addr2>]"
```

## 3. Deploy TwinFactory

Modify `scripts/deploy-twin-factory.ts`:

```ts
const VERIFIER_BY_CHAIN: Record<number, string> = {
  8453: "0xYOUR_NEW_ATTESTOR_VERIFIER",
};
```

Then:

```bash
npx hardhat run scripts/deploy-twin-factory.ts --network base
```

## 4. Document the addresses

Record in your fork's `README.md` and your `@yourorg/sdk` package's `abis.ts`:

```ts
export const TWIN_FACTORY_ADDRESS = "0x...";
export const VERIFIER_ADDRESS = "0x...";
```

## 5. Deploy the attestor backend

See [`ATTESTOR_OPERATIONS.md`](./ATTESTOR_OPERATIONS.md). Make sure `ATTESTOR_PRIVATE_KEY` matches an address in your `AttestorVerifier`'s approved set, and `VERIFIER_ADDRESS` matches the deployed verifier.

## 6. Smoke test

```bash
# As Alice (a real Twitch user):
# 1. Resolve Alice's user_id via Twitch Helix API
# 2. Predict her twin address with predictTwinAddress()
# 3. Send 0.0001 ETH to that address from any wallet
# 4. Connect Alice's wallet to your dApp
# 5. Click "Withdraw" → goes through your attestor → executes onchain
# 6. Verify the funds land in Alice's wallet
```

## Cost estimates (Base mainnet, mid-2026)

| Action | Gas | Cost @ 0.001 gwei |
|---|---|---|
| Deploy AttestorVerifier | ~500k | ~$0.0001 |
| Deploy TwinFactory | ~1.5M | ~$0.0003 |
| Deploy a TwinAccount (first execute) | ~400k | ~$0.0001 |
| Subsequent execute() | ~80k | ~$0.00002 |

Effectively free at Base prices.

## Redeploying after a config change

| Change | Requires redeploying |
|---|---|
| Add a new approved attestor | `AttestorVerifier` (immutable allowlist) + new `TwinFactory` (since twin addresses depend on verifier) |
| Rotate the attestor key | `AttestorVerifier` + new `TwinFactory` |
| Change `MAX_PROOF_AGE` or `MAX_CLOCK_SKEW` | `TwinAccount` constants → new TwinAccount bytecode → new TwinFactory |
| Add a new IdP | **Nothing onchain** — purely an attestor backend change |
| Change salt domain (`"SocialTwin:twitch:v1"` → `"SocialTwin:google:v1"`) | New `TwinFactory` (different address space) |

Twin addresses are stable as long as the factory and verifier addresses don't change. Migrations require a coordinated "withdraw from old, deposit into new" flow.
