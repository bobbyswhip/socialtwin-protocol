# Integration guide

How to build a dApp that uses the SocialTwin protocol — either as a sender (paying a Twitch user) or a recipient (spending from your twin).

## Sender integration

Senders need exactly one thing: the recipient's Twitch user_id. From it they derive the twin address with no on-chain reads.

### Step 1 — resolve handle to user_id

```ts
// Server-side, using a Twitch app's client credentials.
async function resolveHandleToUserId(handle: string): Promise<bigint> {
  const token = await getAppAccessToken();
  const res = await fetch(
    `https://api.twitch.tv/helix/users?login=${encodeURIComponent(handle)}`,
    { headers: { "Client-Id": CLIENT_ID, Authorization: `Bearer ${token}` } }
  );
  const { data } = await res.json();
  if (!data?.length) throw new Error("not found");
  return BigInt(data[0].id);
}
```

Cache aggressively — user_id never changes for a given Twitch account.

### Step 2 — predict the twin address

```ts
import { predictTwinAddress } from "@socialtwin/sdk";

const twin = predictTwinAddress({
  factory: "0x5204a18785ce8ab080B7194A679e5f0605A7b6Ec", // your factory address
  verifier: "0xE4CC251864B0271903D458a9F5731D38ed3eeA39", // your verifier address
  userId: 44322889n,
});
// twin === "0x3165Ba6eEe60B0A99A4ec22F9Eb23758a882801a"
```

### Step 3 — send

Just send ETH or ERC-20 to the predicted address. No setup needed. The twin doesn't even have to be deployed yet.

```ts
await walletClient.sendTransaction({ to: twin, value: parseEther("0.01") });
// or for ERC-20:
await walletClient.writeContract({
  address: USDC, abi: erc20Abi, functionName: "transfer", args: [twin, amount]
});
```

The recipient doesn't need to know anything happened until they choose to spend.

## Recipient integration

Recipients need a wallet (we recommend Coinbase Smart Wallet via wagmi) and access to an attestor service.

### Step 1 — connect wallet, learn user_id

You can either ask the user to type their Twitch handle (resolve server-side) or use an "identity-only" attestor flow:

```ts
const flow = sdk.startSpend({
  twin: PLACEHOLDER_TWIN, // we'll fix this after we learn the userId
  target: "0x0000000000000000000000000000000000000000",
  value: 0n,
  data: "0x",
  nonce: 0n,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
  returnTo: window.location.origin + "/",
});
window.location.href = flow.redirectUrl;
```

After the redirect, the attestation contains the user_id even if the attestation itself can't be used on-chain (it's bound to a placeholder action). Use it just to learn the user_id, then prompt the user to compose a real call.

The cleaner alternative: ask for the Twitch handle directly.

### Step 2 — compose the spend

Once you know the user_id and their wallet is connected:

```ts
import { predictTwinAddress, buildSpendFlow, parseReturnFragment, buildExecuteCall } from "@socialtwin/sdk";

const twin = predictTwinAddress({ factory, verifier, userId });
const nonce = await publicClient.readContract({
  address: twin, abi: TWIN_ACCOUNT_ABI, functionName: "nonce"
});
const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

const flow = buildSpendFlow(config, {
  twin,
  target: userWalletAddress,
  value: balance,
  data: "0x",
  nonce,
  deadline,
  returnTo: window.location.origin + "/",
});

// Optional: deploy the twin if it doesn't exist yet (idempotent).
if (!await isTwinDeployed(twin)) {
  await walletClient.writeContract({
    address: factory, abi: TWIN_FACTORY_ABI,
    functionName: "deployTwin", args: [userId],
  });
}

window.location.href = flow.redirectUrl;
```

### Step 3 — handle the return

```ts
const attestation = parseReturnFragment(window.location.hash);
const call = buildExecuteCall(intent, attestation);
const txHash = await walletClient.writeContract(call);
```

That's the whole integration. ~30 lines of code on the recipient side, ~15 on the sender side.

## End-to-end TypeScript example

A minimal recipient page:

```tsx
"use client";
import { useState } from "react";
import { useAccount, useWriteContract, usePublicClient } from "wagmi";
import {
  predictTwinAddress,
  buildSpendFlow,
  parseReturnFragment,
  buildExecuteCall,
  TWIN_ACCOUNT_ABI,
  TWIN_FACTORY_ABI,
} from "@socialtwin/sdk";

const CONFIG = {
  chainId: 8453,
  factoryAddress: "0x5204a18785ce8ab080B7194A679e5f0605A7b6Ec",
  verifierAddress: "0xE4CC251864B0271903D458a9F5731D38ed3eeA39",
  attestorOrigin: "https://attestor.socialtwin.xyz",
  provider: "twitch",
};

export default function Page() {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();

  async function withdraw(userId: bigint) {
    const twin = predictTwinAddress({
      factory: CONFIG.factoryAddress,
      verifier: CONFIG.verifierAddress,
      userId,
    });
    const nonce = await publicClient!.readContract({
      address: twin, abi: TWIN_ACCOUNT_ABI, functionName: "nonce",
    }) as bigint;
    const balance = await publicClient!.getBalance({ address: twin });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

    const intent = {
      twin, target: address!, value: balance, data: "0x",
      nonce, deadline, returnTo: window.location.origin + "/",
    };
    const { redirectUrl } = buildSpendFlow(CONFIG, intent);
    sessionStorage.setItem("st_pending", JSON.stringify(intent, (_, v) =>
      typeof v === "bigint" ? v.toString() : v
    ));
    window.location.href = redirectUrl;
  }

  // On page load, handle return-from-attestor fragment
  if (typeof window !== "undefined" && window.location.hash.includes("attestation=")) {
    const result = parseReturnFragment(window.location.hash);
    const intent = JSON.parse(sessionStorage.getItem("st_pending")!, (_, v) =>
      typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : v
    );
    writeContractAsync(buildExecuteCall(intent, result));
  }

  // ... return JSX
}
```

## Multi-instance / multi-attestor

A dApp can support multiple attestors at once — let the user choose, or default to the most reputable. The protocol is permissionless: any signature from any approved-attestor for the configured verifier works.

```ts
const ATTESTOR_OPTIONS = [
  { name: "Official", origin: "https://attestor.socialtwin.xyz" },
  { name: "Community", origin: "https://attestor.community.xyz" },
  { name: "Self-hosted", origin: "http://localhost:4001" }, // for development
];
```

## Don't have an attestor yet?

See [`docs/ATTESTOR_OPERATIONS.md`](./ATTESTOR_OPERATIONS.md) to run your own, or use the reference instance at `https://attestor.socialtwin.xyz` (once deployed — TBD).
