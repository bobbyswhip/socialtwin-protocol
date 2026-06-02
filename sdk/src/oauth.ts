import type { SocialTwinConfig, SpendIntent, SpendFlow, JwtResult } from "./types";
import { computeActionHash } from "./execute";
import type { Hex } from "viem";

const TWITCH_AUTHORIZE = "https://id.twitch.tv/oauth2/authorize";

/**
 * Build the URL that starts the Twitch OIDC implicit flow. The dApp redirects
 * the user here (top-level navigation). The action being authorized is bound
 * into the OAuth `nonce` as the twin's action hash; Twitch echoes it into the
 * signed id_token, which `TwitchJWTVerifier` checks onchain.
 *
 * ⚠ ANTI BLIND-SIGNING — IMPORTANT: the user only sees Twitch's generic
 * consent screen and CANNOT see target/value there. Your dApp MUST display the
 * exact action (recipient, amount, twin) to the user BEFORE calling this. The
 * action hash binds the JWT to that exact call so a tampered call reverts
 * onchain, but the human approving still needs to see what they're approving.
 */
export function buildSpendFlow(cfg: SocialTwinConfig, intent: SpendIntent): SpendFlow {
  const actionHash = computeActionHash({
    chainId: BigInt(cfg.chainId),
    twin: intent.twin,
    userId: intent.userId, // bind the REAL userId — the verifier enforces sub == userId
    target: intent.target,
    value: intent.value,
    data: intent.data,
    nonce: intent.nonce,
    deadline: intent.deadline,
  });

  const params = new URLSearchParams({
    client_id: cfg.twitchClientId,
    redirect_uri: cfg.redirectUri,
    response_type: "id_token",
    scope: "openid",
    nonce: actionHash, // the binding mechanism (OIDC §3.1.2.1)
    force_verify: "true", // re-prompt consent every time (freshness + phishing resistance)
  });
  return { redirectUrl: `${TWITCH_AUTHORIZE}?${params.toString()}`, actionHash };
}

/** Base64url-decode a JWT segment to a UTF-8 string (browser + Node). */
function b64urlToString(seg: string): string {
  const pad = (4 - (seg.length % 4)) % 4;
  const b64 = seg.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  if (typeof atob === "function") {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  // Node fallback
  return Buffer.from(b64, "base64").toString("utf-8");
}

/**
 * Decode a JWT payload (claims) WITHOUT verifying — verification happens
 * entirely onchain in `TwitchJWTVerifier`. Use this only to read sub/iat/nonce
 * client-side; never trust it as proof.
 */
export function decodeJwtPayload(idToken: string): Record<string, any> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("malformed JWT");
  return JSON.parse(b64urlToString(parts[1]));
}

/**
 * Parse the id_token Twitch placed in the URL fragment after the user returned.
 * Throws if Twitch returned an error or no token.
 */
export function parseReturnFragment(hash: string): JwtResult {
  const trimmed = hash.startsWith("#") ? hash.slice(1) : hash;
  const params = new URLSearchParams(trimmed);
  const idToken = params.get("id_token");
  if (!idToken) {
    const err = params.get("error_description") || params.get("error");
    throw new Error(err ? `Twitch returned: ${err}` : "Missing id_token in URL fragment");
  }
  const claims = decodeJwtPayload(idToken);
  return {
    idToken,
    userId: BigInt(String(claims.sub)),
    epoch: BigInt(Number(claims.iat)),
    actionHash: String(claims.nonce) as Hex,
    aud: String(claims.aud),
    preferredUsername: claims.preferred_username,
    picture: claims.picture,
  };
}
