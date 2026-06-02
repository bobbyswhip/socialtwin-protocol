import type { Address, Hex } from "viem";

/** Configuration passed once to the SDK. */
export interface SocialTwinConfig {
  /** Chain id where the factory is deployed (e.g. 8453 for Base). */
  chainId: number;
  /** Deployed `TwinFactory` address. */
  factoryAddress: Address;
  /** Deployed `TwitchJWTVerifier` address (read from the factory if omitted). */
  verifierAddress?: Address;
  /** Twitch OAuth client_id — this is the `aud` the verifier allowlists. */
  twitchClientId: string;
  /** Registered redirect URI. Must match the Twitch app EXACTLY (trailing slash matters). */
  redirectUri: string;
}

/** What the dApp asks the SDK to authorize. */
export interface SpendIntent {
  /** Twin contract that will execute the call. */
  twin: Address;
  /**
   * The twin's Twitch numeric user_id. Bound into the action hash AND checked
   * by the verifier (`sub == userId`), so it MUST be the real id — not 0.
   */
  userId: bigint;
  /** External call target. */
  target: Address;
  /** ETH to send with the call. */
  value: bigint;
  /** Call data (0x for a plain ETH transfer). */
  data: Hex;
  /** Current twin nonce (read onchain before redirecting). */
  nonce: bigint;
  /** Unix seconds after which the call is invalid. */
  deadline: bigint;
}

/** Parsed Twitch id_token returned in the post-redirect URL fragment. */
export interface JwtResult {
  /** Raw id_token (`header.payload.signature`). Pass to `twin.execute` as bytes. */
  idToken: string;
  /** Twitch numeric user_id (`sub`). */
  userId: bigint;
  /** Issued-at (`iat`). Pass as `oauthExchangeEpoch`. */
  epoch: bigint;
  /** Echoed `nonce` — equals the action hash. */
  actionHash: Hex;
  /** `aud` (the Twitch client_id). */
  aud: string;
  preferredUsername?: string;
  picture?: string;
}

export interface SpendFlow {
  /** URL to navigate to — sends the user into the Twitch OIDC implicit flow. */
  redirectUrl: string;
  /** Pre-computed action hash (the value placed in the OAuth `nonce`). */
  actionHash: Hex;
}
