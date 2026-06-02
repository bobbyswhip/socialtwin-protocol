/**
 * @socialtwin/sdk
 *
 * Browser-side client for the SocialTwin protocol. UI-agnostic — it gives you
 * primitives (predict address, build the Twitch OIDC URL, parse the returned
 * id_token, encode the execute call) and you wire them into your own UI.
 *
 * The flow is the deployed Twitch-JWT design — the id_token is verified
 * entirely onchain by TwitchJWTVerifier. There is no attestor / off-chain
 * signer in the trust path.
 *
 * Usage:
 *   const flow = buildSpendFlow(cfg, { twin, userId, target, value, data, nonce, deadline });
 *   window.location.href = flow.redirectUrl;     // user signs in with Twitch, returns to redirectUri
 *
 * On return:
 *   const jwt = parseReturnFragment(window.location.hash);
 *   await walletClient.writeContract(buildExecuteCall(intent, jwt)); // or relay it gaslessly
 */

export * from "./address";
export * from "./oauth";
export * from "./types";
export * from "./execute";
export { TWIN_ACCOUNT_ABI, TWIN_FACTORY_ABI } from "./abis";
