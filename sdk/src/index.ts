/**
 * @socialtwin/sdk
 *
 * Browser-side client for the SocialTwin protocol. UI-agnostic — gives
 * you primitives (predict address, build OAuth URL, parse attestation,
 * encode execute call) and you wire them into your own React/Vue/Svelte
 * components.
 *
 * Usage in three lines:
 *   const sdk = createSocialTwinClient({ chain, attestorOrigin, factoryAddress });
 *   const flow = sdk.startSpend({ twin, target, value, data, deadline });
 *   window.location.href = flow.redirectUrl; // user signs in with their IdP, returns to your page
 *
 * On return:
 *   const result = sdk.parseReturnFragment(window.location.hash);
 *   await walletClient.writeContract(sdk.buildExecuteCall(result, ...));
 */

export * from "./address";
export * from "./oauth";
export * from "./types";
export * from "./execute";
export { TWIN_ACCOUNT_ABI, TWIN_FACTORY_ABI } from "./abis";
