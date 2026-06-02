# `@socialtwin/sdk`

Browser-side TypeScript SDK for integrating SocialTwin into a dApp. Predicts twin addresses, builds the **Twitch OIDC** authorize URL, parses the returned **id_token**, and produces `writeContract` args. The id_token is verified entirely onchain by `TwitchJWTVerifier` — there is no attestor / off-chain signer in the trust path.

UI-agnostic. Pass the redirect URL to `window.location.href` (or your framework's navigation primitive).

## Status

Reference module. Not published to npm yet. Path-import it or copy into your dApp:

```json
{ "dependencies": { "@socialtwin/sdk": "file:../socialtwin-protocol/sdk" } }
```

## Exports

```ts
import {
  // Configuration
  type SocialTwinConfig,   // { chainId, factoryAddress, verifierAddress?, twitchClientId, redirectUri }
  type SpendIntent,        // { twin, userId, target, value, data, nonce, deadline }
  type SpendFlow,
  type JwtResult,          // parsed id_token: { idToken, userId, epoch, actionHash, aud, ... }

  // Address derivation (pure off-chain CREATE2 prediction)
  predictTwinAddress,
  saltFor,

  // Twitch OIDC flow
  buildSpendFlow,          // → { redirectUrl, actionHash }
  parseReturnFragment,     // window.location.hash → JwtResult
  decodeJwtPayload,        // read claims client-side (NOT a verification)

  // Contract calls
  computeActionHash,       // mirrors TwinAccount.computeActionHash (binds the REAL userId)
  buildExecuteCall,        // (intent, jwt) → writeContract args for twin.execute(...)

  // ABIs
  TWIN_FACTORY_ABI,
  TWIN_ACCOUNT_ABI,
  TWIN_ACCOUNT_INIT_CODE,
} from "@socialtwin/sdk";
```

> ⚠️ **Anti blind-signing:** the Twitch consent screen cannot show transaction details. Your UI MUST display the exact action (recipient, amount, twin) before calling `buildSpendFlow`. The action hash binds the JWT to that exact call, so a tampered call reverts onchain — but the human still needs to see what they approve. See [`../AUDIT_RESPONSE.md`](../AUDIT_RESPONSE.md), Finding 2.

## File layout

```
src/
├── index.ts        # Re-exports
├── types.ts        # SocialTwinConfig, SpendIntent, JwtResult, SpendFlow
├── address.ts      # predictTwinAddress + saltFor
├── oauth.ts        # buildSpendFlow + parseReturnFragment + decodeJwtPayload
├── execute.ts      # computeActionHash + buildExecuteCall
└── abis.ts         # Contract ABIs + TwinAccount initcode
```

## A note on `TWIN_ACCOUNT_INIT_CODE`

`predictTwinAddress` needs the compiled `TwinAccount` creation bytecode to derive addresses off-chain, hardcoded in `abis.ts`. If you change `TwinAccount.sol`, re-extract and re-paste:

```bash
npx hardhat compile
node -e "console.log(require('./artifacts/contracts/TwinAccount.sol/TwinAccount.json').bytecode)"
# paste into sdk/src/abis.ts → TWIN_ACCOUNT_INIT_CODE
```

This keeps the SDK hermetic (offline prediction, no RPC) at the cost of binding it to a specific compiler version + settings.

## Peer dependency

`viem` is a peer dependency — your dApp installs it.
