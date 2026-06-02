import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import type { AttestationResult, SpendIntent } from "./types";
import { TWIN_ACCOUNT_ABI } from "./abis";

const EXECUTE_DOMAIN = "TwinAccount:v2:execute";

/**
 * Mirrors `TwinAccount.computeActionHash` on-chain. Used by the SDK
 * before redirecting, and by your dApp to confirm the attestor signed
 * exactly the action you intended.
 */
export function computeActionHash(opts: {
  chainId: bigint;
  twin: Address;
  userId: bigint;
  target: Address;
  value: bigint;
  data: Hex;
  nonce: bigint;
  deadline: bigint;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "uint256" },
        { type: "address" },
        { type: "uint64" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [
        EXECUTE_DOMAIN,
        opts.chainId,
        opts.twin,
        opts.userId,
        opts.target,
        opts.value,
        keccak256(opts.data),
        opts.nonce,
        opts.deadline,
      ]
    )
  );
}

/**
 * Build the wagmi/viem-compatible writeContract args for `twin.execute(...)`.
 */
export function buildExecuteCall(intent: SpendIntent, attestation: AttestationResult) {
  return {
    address: intent.twin,
    abi: TWIN_ACCOUNT_ABI,
    functionName: "execute" as const,
    args: [
      intent.target,
      intent.value,
      intent.data,
      intent.nonce,
      intent.deadline,
      attestation.epoch,
      attestation.attestation,
    ] as const,
  };
}
