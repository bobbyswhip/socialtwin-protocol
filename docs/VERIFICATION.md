# Contract Verification

Everything needed to (re)verify the SocialTwin contracts on Basescan, including
the per-twin case that does **not** auto-verify on deploy.

Pairs with [`DEPLOYMENT.md`](./DEPLOYMENT.md) (which deploys + verifies the core
stack in one step) and the audit trail in [`../AUDIT_RESPONSE.md`](../AUDIT_RESPONSE.md).

---

## TL;DR

- **Core stack** (`TwinFactory`, `TwitchJWTVerifier`) is verified automatically by
  `scripts/deploy-twin-stack.ts` right after deploy — no manual step in the normal flow.
- **Twins** (`TwinAccount`) are deployed by the factory via CREATE2, so Basescan
  never receives their source on deploy. The **first** twin of a given stack must
  be verified manually; later twins usually inherit "Similar Match Source Code"
  but that is **not guaranteed** (see [Twins & similar-match](#twins--similar-match)).
- All three contract types share the **same compiler settings** below.

---

## Live addresses — v1.3 (Base mainnet · chainId 8453)

| Contract | Address | Basescan |
|---|---|---|
| `TwinFactory` | `0x260C074c3afDc46A209D4619B5FAdB2964dF9a28` | [code](https://basescan.org/address/0x260C074c3afDc46A209D4619B5FAdB2964dF9a28#code) |
| `TwitchJWTVerifier` | `0xBDfC552469f11843802BCD7ec9a8372c8020fee8` | [code](https://basescan.org/address/0xBDfC552469f11843802BCD7ec9a8372c8020fee8#code) |
| `TwinAccount` (reference twin, `userId 1507305235`) | `0xcBeaF766D4a7DD61558d4E80ee58B8B8379d4CEf` | [code](https://basescan.org/address/0xcBeaF766D4a7DD61558d4E80ee58B8B8379d4CEf#code) |

The reference twin is the canonical verified `TwinAccount` other twins similar-match against.

---

## Compiler settings (must match exactly)

From [`../hardhat.config.ts`](../hardhat.config.ts):

| Setting | Value |
|---|---|
| solc version | `0.8.24` |
| `viaIR` | `true` |
| `evmVersion` | `cancun` |
| optimizer | enabled, `runs: 200` |

Any drift in these breaks both manual verification and similar-match propagation.

---

## Source files

| Contract | Source |
|---|---|
| `TwinFactory` | [`../contracts/TwinFactory.sol`](../contracts/TwinFactory.sol) |
| `TwitchJWTVerifier` | [`../contracts/TwitchJWTVerifier.sol`](../contracts/TwitchJWTVerifier.sol) |
| `TwinAccount` | [`../contracts/TwinAccount.sol`](../contracts/TwinAccount.sol) |
| `IVerifier` (interface) | [`../contracts/interfaces/IVerifier.sol`](../contracts/interfaces/IVerifier.sol) |

---

## Constructor arguments

### `TwitchJWTVerifier`
Signature: `(string[] kids, bytes[] moduli, string[] auds, address audAdmin, address keyAdmin, address guardian)`

| Arg | Value (v1.3) |
|---|---|
| `kids` | `["1"]` |
| `moduli` | `[MODULUS]` (the 256-byte RSA-2048 modulus below) |
| `auds` | `["epeocrogq8bm1af0lngd9e2rfvrwk1"]` (yougotcoined client_id) |
| `audAdmin` | `0xD1EC8245c8850A151843ce8a3AFdca3b19747706` (treasury) |
| `keyAdmin` | `0xa825094B04D5a3710bd41C4fbC902F75cF333333` |
| `guardian` | `0xD1EC8245c8850A151843ce8a3AFdca3b19747706` (treasury) |

`MODULUS` (Twitch live `kid="1"`, cross-checked against `https://id.twitch.tv/oauth2/keys`):
```
0xea5abd310faaea1731afb90e529fad1e51ed75c0ec54bc15230d77897502bee0ce7828b4552bb1082518e9498c8f2e77757d348a1d84e18e14be5ae69aeacad1e1b6e9bf8730d340bc21ac5571d4dd1711855a070da3b01f053bda3edba479fd5db3f74378de6d7e8a21f35b7a2d8c891d16c9bf1164713e69985160ef3ffa4f46d86c9c4e9bdcfb6181b0ff151cb50a29f02cd81eac5b7ab7ca653a3342fe7055e467d7c7927f5e8ecfaca993e1309c6d04f071a142144054e0bf85574d2bfdd787ff624370f848eec1b8305ccbe9cabd3a1327c89b11e8c6c66415807ea81607b5a3314e716c641afa7e7f076b626a4f58683fb679af9c310eedc64212a41f
```

### `TwinFactory`
Signature: `(IVerifier verifier, address rescuer)`

| Arg | Value (v1.3) |
|---|---|
| `verifier` | `0xBDfC552469f11843802BCD7ec9a8372c8020fee8` |
| `rescuer` | `0xD1EC8245c8850A151843ce8a3AFdca3b19747706` (treasury) |

### `TwinAccount` (a twin)
Signature: `(uint64 userId, IVerifier verifier)` — both `immutable`.

| Arg | Value |
|---|---|
| `userId` | the twin's Twitch numeric user id (per-twin) |
| `verifier` | `0xBDfC552469f11843802BCD7ec9a8372c8020fee8` (constant for the v1.3 stack) |

`factory` and `deployedAt` are also `immutable`, but they're set internally by the
factory and are **not** constructor args — you don't pass them to `verify`.

---

## Secrets / `.env`

`BASESCAN_API_KEY` (and `BASE_RPC_URL`, `PRIVATE_KEY`) live in `../zkx402/.env`,
outside this repo. `hardhat.config.ts` reads `./.env` in the project root, which
is **gitignored**. Stage just what verification needs, then delete it:

```bash
# from socialtwin-protocol/
grep -E '^(BASESCAN_API_KEY|BASE_RPC_URL)=' ../zkx402/.env > .env
# ... run the verify command ...
rm -f .env
```

Verification needs only `BASESCAN_API_KEY` (no private key — verify sends no tx).

---

## Verifying the core stack

Normally automatic — `scripts/deploy-twin-stack.ts` calls `run("verify:verify", …)`
~30s after deploy. To re-run manually:

```bash
# TwitchJWTVerifier — args via a JS module (arrays/bytes are awkward on the CLI)
npx hardhat verify --network base \
  --constructor-args scripts/verify-args/verifier.js \
  0xBDfC552469f11843802BCD7ec9a8372c8020fee8

# TwinFactory — simple args inline
npx hardhat verify --network base \
  0x260C074c3afDc46A209D4619B5FAdB2964dF9a28 \
  0xBDfC552469f11843802BCD7ec9a8372c8020fee8 \
  0xD1EC8245c8850A151843ce8a3AFdca3b19747706
```

Where `scripts/verify-args/verifier.js` exports the array:
```js
module.exports = [
  ["1"],
  ["0xea5abd31…41f"],                       // full MODULUS above
  ["epeocrogq8bm1af0lngd9e2rfvrwk1"],
  "0xD1EC8245c8850A151843ce8a3AFdca3b19747706", // audAdmin
  "0xa825094B04D5a3710bd41C4fbC902F75cF333333", // keyAdmin
  "0xD1EC8245c8850A151843ce8a3AFdca3b19747706", // guardian
];
```

---

## Verifying a twin

A twin's only per-instance arg is `userId`; `verifier` is constant. Always pin the
contract with `--contract` (Basescan can't pick `TwinAccount` from bytecode alone
once multiple contracts share a metadata profile):

```bash
npx hardhat verify --network base \
  --contract contracts/TwinAccount.sol:TwinAccount \
  <TWIN_ADDRESS> <userId> 0xBDfC552469f11843802BCD7ec9a8372c8020fee8
```

Example (the reference twin):
```bash
npx hardhat verify --network base \
  --contract contracts/TwinAccount.sol:TwinAccount \
  0xcBeaF766D4a7DD61558d4E80ee58B8B8379d4CEf 1507305235 \
  0xBDfC552469f11843802BCD7ec9a8372c8020fee8
```

### Getting a twin's `userId` (if you only have the address)
Read it on-chain — `userId` and `verifier` are public views:
```js
const { ethers } = require("ethers");
const p = new ethers.JsonRpcProvider("https://mainnet.base.org");
const t = new ethers.Contract(TWIN, [
  "function userId() view returns (uint64)",
  "function verifier() view returns (address)",
], p);
console.log((await t.userId()).toString(), await t.verifier());
```

### Listing every deployed twin
Twins emit `TwinDeployed(uint64 indexed userId, address indexed twin)` from the factory
(both fields indexed → read from topics, data is empty):
```js
const topic = ethers.id("TwinDeployed(uint64,address)");
const logs = await p.getLogs({ address: FACTORY, topics: [topic], fromBlock, toBlock });
for (const l of logs) {
  const userId = ethers.toBigInt(l.topics[1]).toString();
  const twin   = ethers.getAddress("0x" + l.topics[2].slice(26));
}
```

---

## Twins & similar-match

Once one `TwinAccount` is verified, Basescan auto-flags later twins as
**"Similar Match Source Code"** when their bytecode matches. Twins differ only in
the `immutable` slots (`userId`, `deployedAt`; `verifier`/`factory` are constant),
which Basescan masks during matching — so propagation **usually** works within
minutes. Caveats:

- Not contractually guaranteed by Basescan; it can lag or miss.
- Breaks silently if compiler/metadata settings ever drift from the table above.
- The first twin of any new stack has nothing to match against → always manual.

To confirm a given twin's status without opening the browser:
```js
const url = `https://api.etherscan.io/v2/api?chainid=8453&module=contract` +
            `&action=getsourcecode&address=${ADDR}&apikey=${KEY}`;
const j = await (await fetch(url)).json();
const verified = !!(j.result?.[0]?.SourceCode);
```
(`SourceCode` is empty string when unverified.)

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Already Verified` | Nothing to do — Basescan already has matching source. |
| `Fail - Unable to verify` on a twin | Wrong `userId`, or missing `--contract`. Re-read `userId()` on-chain. |
| Bytecode mismatch on the stack | Compiler settings drift — confirm solc `0.8.24` + `viaIR` + `cancun` + `runs 200`. |
| `Invalid API Key` | `.env` not staged, or pulled the wrong line from `../zkx402/.env`. |
| Verify hangs on "Waiting for result" | Basescan indexing lag; the contract must have ≥1 confirmation first. |

---

## External references

- Basescan: <https://basescan.org>
- Etherscan v2 multichain API (chainid 8453 = Base): <https://docs.etherscan.io/etherscan-v2>
- Hardhat verify plugin: <https://hardhat.org/hardhat-runner/plugins/nomicfoundation-hardhat-verify>
- Twitch OIDC JWKS (key cross-check): <https://id.twitch.tv/oauth2/keys>
