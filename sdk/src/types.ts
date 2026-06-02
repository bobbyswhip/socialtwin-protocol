import type { Address, Hex } from "viem";

/** Configuration passed once to `createSocialTwinClient`. */
export interface SocialTwinConfig {
  /** Chain id where the factory is deployed (e.g. 8453 for Base). */
  chainId: number;
  /** Deployed `TwinFactory` address. */
  factoryAddress: Address;
  /** Deployed `AttestorVerifier` address (read from factory if omitted). */
  verifierAddress?: Address;
  /** Origin of the attestor service that will sign attestations. */
  attestorOrigin: string;
  /** Identity provider key ("twitch", "google", …). */
  provider: string;
}

/** What the dApp asks the SDK to authorize. */
export interface SpendIntent {
  /** Twin contract that will execute the call. */
  twin: Address;
  /** External call target. */
  target: Address;
  /** ETH to send with the call. */
  value: bigint;
  /** Call data (0x for plain ETH transfer). */
  data: Hex;
  /** Current twin nonce (read onchain before redirecting). */
  nonce: bigint;
  /** Unix seconds after which the call is invalid. */
  deadline: bigint;
  /** Where the attestor should bounce the user back to. */
  returnTo: string;
}

/** Parsed attestation from the post-redirect URL fragment. */
export interface AttestationResult {
  attestation: Hex;
  userId: bigint;
  epoch: bigint;
  actionHash: Hex;
  signer: Address;
  provider: string;
  preferredUsername?: string;
  picture?: string;
}

export interface SpendFlow {
  /** URL to navigate to — sends the user into the attestor OAuth handshake. */
  redirectUrl: string;
  /** Pre-computed action hash; store it client-side if you want to detect tampering on return. */
  actionHash: Hex;
}
