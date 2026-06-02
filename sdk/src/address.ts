import {
  encodeAbiParameters,
  getContractAddress,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { TWIN_ACCOUNT_INIT_CODE } from "./abis";

/**
 * Pure off-chain prediction of a twin's address. Matches
 * `TwinFactory.predictAddress(userId)` byte-for-byte — anyone can derive
 * the address without an RPC round-trip.
 *
 *   salt = keccak256("SocialTwin:twitch:v2" || uint64(userId))
 *   bytecode = TwinAccount.creationCode || abi.encode(userId, verifier)
 *   address = CREATE2(factory, salt, keccak256(bytecode))
 */
const SALT_DOMAIN = "SocialTwin:twitch:v2";

export function saltFor(userId: bigint): Hex {
  // Match Solidity's `keccak256(abi.encodePacked(string, uint64))` exactly.
  const domain = new TextEncoder().encode(SALT_DOMAIN);
  const idBytes = new Uint8Array(8);
  const view = new DataView(idBytes.buffer);
  view.setBigUint64(0, userId, false); // big-endian
  const packed = new Uint8Array(domain.length + 8);
  packed.set(domain, 0);
  packed.set(idBytes, domain.length);
  return keccak256(packed) as Hex;
}

export function predictTwinAddress(opts: {
  factory: Address;
  verifier: Address;
  userId: bigint;
}): Address {
  const initCode = (TWIN_ACCOUNT_INIT_CODE +
    encodeAbiParameters(
      [{ type: "uint64" }, { type: "address" }],
      [opts.userId, opts.verifier]
    ).slice(2)) as Hex;
  return getContractAddress({
    bytecode: initCode,
    from: opts.factory,
    opcode: "CREATE2",
    salt: saltFor(opts.userId),
  });
}
