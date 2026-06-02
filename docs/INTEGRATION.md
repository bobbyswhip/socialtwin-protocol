# Integration guide

How to build on SocialTwin from a dApp. Uses the [`sdk/`](../sdk/) helpers + viem. Live v1.2 addresses are in the root [`README.md`](../README.md). Wire-format details: [`PROTOCOL.md`](../PROTOCOL.md).

## Config

```ts
const cfg = {
  chainId: 8453,
  factoryAddress: "0x260C074c3afDc46A209D4619B5FAdB2964dF9a28", // v1.3
  verifierAddress: "0xBDfC552469f11843802BCD7ec9a8372c8020fee8",
  twitchClientId: "<your Twitch app client_id>", // must be an allowlisted `aud`
  redirectUri: "https://yourapp.example/claim",  // EXACT match in the Twitch app (trailing slash matters)
};
```

To onboard your own frontend, ask the treasury to `queueAud(yourClientId)` (live after the 2-day timelock). Your Twitch app's redirect URL must point at *your* domain — that's what makes the allowlist anti-phishing.

## 1. Read state (no auth)

```ts
import { predictTwinAddress } from "@socialtwin/sdk";

const twin = predictTwinAddress({ factory: cfg.factoryAddress, verifier: cfg.verifierAddress, userId });
const balance = await publicClient.getBalance({ address: twin });        // "claimable rewards"
const linked  = await publicClient.readContract({ address: twin, abi: TWIN_ACCOUNT_ABI, functionName: "selfCustody" });
```

Show the twin balance separately from the user's connected-wallet balance — funds live in the twin until moved.

## 2. Fund a streamer by identity

Just transfer ETH/ERC-20 to `predictTwinAddress(userId)`. No recipient setup, no deploy needed first.

## 3. Claim / act via Twitch (JWT path)

Only while the twin is **not** self-custodied (`selfCustody == false`). Show the exact action in your UI first — the Twitch screen can't.

```ts
import { buildSpendFlow, parseReturnFragment, buildExecuteCall } from "@socialtwin/sdk";

// before redirect: read the twin nonce, pick target/value/deadline
const { redirectUrl } = buildSpendFlow(cfg, { twin, userId, target, value, data: "0x", nonce, deadline });
window.location.href = redirectUrl;                       // Twitch OIDC

// on return:
const jwt = parseReturnFragment(window.location.hash);    // { idToken, userId, epoch, ... }
await walletClient.writeContract(buildExecuteCall(intent, jwt));   // OR relay it gaslessly (below)
```

## 4. Self-custody (recommended for real value)

`setOwnerEOA(ownerWallet, …, jwt)` (JWT-gated, once) links the user's wallet and **permanently disables the Twitch path** for that twin. After that, spend with `executeAsOwner(target, value, data)` — a normal wallet signature, ~50k gas, no Twitch and no relayer. Your UI should detect `selfCustody == true` and switch to the owner path (hide the Twitch claim button — it would revert `SelfCustodyEnabled`).

## 5. Gasless relaying (optional)

Run a funded relayer EOA that submits JWT-authorized calls so users pay no gas. It is powerless (the JWT is the authority), but it **must** guard against burning gas on junk:

```ts
const sub = jwtSub(idToken);                              // the `sub` claim
const canonical = await factory.read.predictAddress([sub]);
if (twin.toLowerCase() !== canonical.toLowerCase()) reject("twin_not_canonical");
// simulate, cap gas, then submit from the relayer key
```

The owner path (`executeAsOwner`) is `onlyOwner` and so is **not** relayable as-is — sponsor it with a paymaster, or add an EIP-712 + ERC-1271 `executeAsOwnerWithSig` (not in this repo) if you want gasless owner spends.

## 6. Resolve a handle → user_id

Server-side via Twitch Helix `GET /helix/users?login=<handle>` with an App Access Token (client-credentials grant). Keep the client secret server-only.

## Gotchas

- Re-derive addresses after **any** contract change; cross-check `predictTwinAddress` (offchain) vs `factory.predictAddress` (onchain) before funding.
- Read through a single RPC / proxy you control — load-balanced public RPCs can return stale `0x` right after a deploy/tx.
- Version your client-side identity cache so a stale twin address (from an old factory) doesn't trip the relayer's canonical-twin guard.
- A new `aud` only works after its 2-day timelock; `execute` with an un-allowlisted `aud` reverts `WrongAudience`.
