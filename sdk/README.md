# `@socialtwin/sdk`

Browser-side TypeScript SDK for integrating SocialTwin into a dApp. Predicts twin addresses, builds attestor redirect URLs, parses returned attestations, and produces `writeContract` args.

UI-agnostic. Not opinionated about React/Vue/Svelte — pass the redirect URL to `window.location.href` (or your framework's navigation primitive).

## Status

Reference module. Not published to npm yet. Path-import it or copy into your dApp:

```json
{
  "dependencies": {
    "@socialtwin/sdk": "file:../SocialTwinContracts/sdk"
  }
}
```

## Exports

```ts
import {
  // Configuration
  type SocialTwinConfig,
  type SpendIntent,
  type SpendFlow,
  type AttestationResult,

  // Address derivation (pure off-chain CREATE2 prediction)
  predictTwinAddress,
  saltFor,

  // OAuth flow
  buildSpendFlow,
  parseReturnFragment,

  // Contract calls
  computeActionHash,
  buildExecuteCall,

  // ABIs
  TWIN_FACTORY_ABI,
  TWIN_ACCOUNT_ABI,
  ATTESTOR_VERIFIER_ABI,
  TWIN_ACCOUNT_INIT_CODE,
} from "@socialtwin/sdk";
```

See [`../docs/FRONTEND_SDK.md`](../docs/FRONTEND_SDK.md) for the full integration guide, including an end-to-end React + wagmi example.

## File layout

```
src/
├── index.ts        # Re-exports
├── types.ts        # SocialTwinConfig, SpendIntent, AttestationResult, …
├── address.ts      # predictTwinAddress + saltFor
├── oauth.ts        # buildSpendFlow + parseReturnFragment
├── execute.ts      # computeActionHash + buildExecuteCall
└── abis.ts         # Contract ABIs + TwinAccount initcode
```

## A note on `TWIN_ACCOUNT_INIT_CODE`

The `predictTwinAddress` helper needs the compiled `TwinAccount` creation bytecode to derive addresses off-chain. The init code is hardcoded in `abis.ts` as a constant. If you change `TwinAccount.sol`, re-extract and re-paste:

```bash
npx hardhat compile
node -e "
  const art = require('./artifacts/contracts/TwinAccount.sol/TwinAccount.json');
  console.log(art.bytecode);
"
# Copy the output into sdk/src/abis.ts
```

This trade keeps the SDK hermetic — `predictTwinAddress` works offline, no RPC required. The cost is that the SDK is implicitly bound to a specific compiler version + settings.

## Peer dependency

`viem` is a peer dependency. Your dApp needs to install it (any version compatible with the SDK's typings).
