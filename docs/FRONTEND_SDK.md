> **⚠️ Superseded (v1.1, post-audit):** This document predates the audit response and describes the earlier **attestor / off-chain-signer** model, which was **removed**. The deployed protocol verifies Twitch JWTs **entirely onchain** (`TwitchJWTVerifier`), with a two-phase abandoned-funds rescue and a timelocked `aud` allowlist. For the current design see [`README.md`](../README.md) and [`AUDIT_RESPONSE.md`](../AUDIT_RESPONSE.md); the onchain-JWT review is in [`SECURITY_REVIEW.md`](../SECURITY_REVIEW.md). Retained for historical context.

# Frontend SDK

The `@socialtwin/sdk` package (in [`sdk/`](../sdk/)) is a small UI-agnostic TypeScript module. It gives you four things:

1. `predictTwinAddress` — pure off-chain CREATE2 prediction.
2. `buildSpendFlow` — constructs the attestor redirect URL.
3. `parseReturnFragment` — extracts the attestation from the post-redirect URL hash.
4. `buildExecuteCall` — produces wagmi/viem-compatible `writeContract` args.

Plus the contract ABIs and TwinAccount initcode (the latter is required by `predictTwinAddress`).

## Installation

The SDK isn't published to npm yet. Either:

- Copy the `sdk/` directory into your dApp's repo.
- Use it as a path dependency: `"@socialtwin/sdk": "file:../SocialTwinContracts/sdk"`.

Once stable we'll publish under `@socialtwin/sdk`.

## End-to-end example (React + wagmi + viem)

```tsx
"use client";

import { useState, useEffect } from "react";
import { useAccount, useWriteContract, usePublicClient } from "wagmi";
import {
  predictTwinAddress,
  buildSpendFlow,
  parseReturnFragment,
  buildExecuteCall,
  TWIN_ACCOUNT_ABI,
  type SocialTwinConfig,
  type SpendIntent,
} from "@socialtwin/sdk";

const CFG: SocialTwinConfig = {
  chainId: 8453,
  factoryAddress: "0x5204a18785ce8ab080B7194A679e5f0605A7b6Ec",
  verifierAddress: "0xE4CC251864B0271903D458a9F5731D38ed3eeA39",
  attestorOrigin: "https://attestor.socialtwin.xyz",
  provider: "twitch",
};

function bigJsonReplacer(_k: string, v: unknown) {
  return typeof v === "bigint" ? v.toString() : v;
}
function bigJsonReviver(_k: string, v: unknown) {
  // Heuristic: revive decimal-only strings that aren't addresses or hex.
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  return v;
}

export function ClaimPage({ userId }: { userId: bigint }) {
  const { address } = useAccount();
  const { writeContractAsync, isPending } = useWriteContract();
  const publicClient = usePublicClient();
  const [status, setStatus] = useState("");

  // On mount: handle return-from-attestor URL fragment
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!window.location.hash.includes("attestation=")) return;
    const result = parseReturnFragment(window.location.hash);
    const intentRaw = sessionStorage.getItem("st_pending_intent");
    if (!intentRaw) return;
    const intent: SpendIntent = JSON.parse(intentRaw, bigJsonReviver);
    sessionStorage.removeItem("st_pending_intent");
    window.history.replaceState({}, "", window.location.pathname);
    setStatus("Submitting onchain…");
    writeContractAsync(buildExecuteCall(intent, result))
      .then((hash) => setStatus(`✓ submitted: ${hash}`))
      .catch((e) => setStatus(`✗ ${e.message}`));
  }, [writeContractAsync]);

  async function withdrawAll() {
    if (!address || !publicClient) return;
    const twin = predictTwinAddress({
      factory: CFG.factoryAddress,
      verifier: CFG.verifierAddress,
      userId,
    });
    const [nonce, balance] = await Promise.all([
      publicClient.readContract({ address: twin, abi: TWIN_ACCOUNT_ABI, functionName: "nonce" }) as Promise<bigint>,
      publicClient.getBalance({ address: twin }),
    ]);
    const intent: SpendIntent = {
      twin,
      target: address,
      value: balance,
      data: "0x",
      nonce,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
      returnTo: window.location.origin + window.location.pathname,
    };
    sessionStorage.setItem("st_pending_intent", JSON.stringify(intent, bigJsonReplacer));
    const { redirectUrl } = buildSpendFlow(CFG, intent);
    window.location.href = redirectUrl;
  }

  return (
    <button onClick={withdrawAll} disabled={isPending}>
      Withdraw {/* … format balance … */} from my twin
    </button>
  );
}
```

## Custom call (not just ETH transfer)

Set `target` to the contract you want to call, `value` to any ETH amount, and `data` to the encoded calldata:

```ts
import { encodeFunctionData, erc20Abi } from "viem";

const transferData = encodeFunctionData({
  abi: erc20Abi,
  functionName: "transfer",
  args: [recipientAddress, parseUnits("100", 6)],
});

const intent: SpendIntent = {
  twin,
  target: USDC_ADDRESS,
  value: 0n,
  data: transferData,
  nonce,
  deadline,
  returnTo,
};
```

Any contract call. Anything wagmi/viem can encode, the twin can execute.

## Batch execution

For multiple calls in one attestation, use `executeBatch` on the twin directly. The SDK doesn't wrap it yet — write it inline:

```ts
import { TWIN_ACCOUNT_ABI } from "@socialtwin/sdk";

const batchHash = await publicClient.readContract({
  address: twin,
  abi: TWIN_ACCOUNT_ABI,
  functionName: "computeBatchHash",
  args: [targets, values, datas, nonce, deadline],
});

// Use batchHash as actionHash in your attestor flow.
// On return, call twin.executeBatch instead of twin.execute.
```

## Trust expectations for dApp UX

The user is depending on YOUR dApp to:
- Construct the correct `target`/`value`/`data` for the action they think they're taking.
- Compute the correct `actionHash` from those inputs.
- Display human-readable details of what they're authorizing.

The attestor and contract have no way to know if your UX is honest. Build your confirmation surface carefully:

- Show `target` as a recognizable name (ENS, address book, contract name).
- Show `value` in the user's preferred currency display.
- For contract calls, decode the function and parameters where possible.
- Avoid silent retries with different intents.

## Reading the twin's state without spending

You don't need an attestation to read state — only to spend. Twin balances are just onchain balances:

```ts
const balance = await publicClient.getBalance({ address: twin });
const usdcBalance = await publicClient.readContract({
  address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [twin],
});
```

Use this for the "your twin holds X" UI without requiring the user to sign in.
