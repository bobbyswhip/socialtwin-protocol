import { encodeAbiParameters, keccak256, toHex, type Address, type Hex } from "viem";
import type { JwtResult, SpendIntent } from "./types";
import { TWIN_ACCOUNT_ABI } from "./abis";

const EXECUTE_DOMAIN = "TwinAccount:v2:execute";

/**
 * Mirrors `TwinAccount.computeActionHash` onchain. Used by the SDK
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
 * The raw id_token is passed as the `jwt` bytes argument (UTF-8 → hex).
 */
export function buildExecuteCall(intent: SpendIntent, jwt: JwtResult) {
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
      jwt.epoch, // oauthExchangeEpoch = the JWT's iat
      toHex(jwt.idToken), // raw JWT bytes (header.payload.signature)
    ] as const,
  };
}
