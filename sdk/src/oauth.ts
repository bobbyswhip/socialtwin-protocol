import type { SocialTwinConfig, SpendIntent, SpendFlow, AttestationResult } from "./types";
import { computeActionHash } from "./execute";
import type { Hex } from "viem";

/**
 * Build the URL that kicks off the attestor's OAuth round-trip.
 *
 * The dApp redirects the user to this URL (top-level navigation). After
 * the user completes the IdP flow, the attestor signs an attestation and
 * bounces back to `intent.returnTo#attestation=...&user_id=...`.
 */
export function buildSpendFlow(cfg: SocialTwinConfig, intent: SpendIntent): SpendFlow {
  const actionHash = computeActionHash({
    chainId: BigInt(cfg.chainId),
    twin: intent.twin,
    userId: 0n, // userId is bound implicitly through the twin's immutable userId on-chain
    target: intent.target,
    value: intent.value,
    data: intent.data,
    nonce: intent.nonce,
    deadline: intent.deadline,
  });

  const params = new URLSearchParams({
    action_hash: actionHash,
    return_to: intent.returnTo,
  });
  const redirectUrl = `${cfg.attestorOrigin.replace(/\/$/, "")}/attest/${cfg.provider}/start?${params.toString()}`;
  return { redirectUrl, actionHash };
}

/**
 * Parse the attestation the attestor put in the URL fragment after the
 * user returned from the IdP flow.
 */
export function parseReturnFragment(hash: string): AttestationResult {
  const trimmed = hash.startsWith("#") ? hash.slice(1) : hash;
  const params = new URLSearchParams(trimmed);
  const required = (k: string): string => {
    const v = params.get(k);
    if (!v) throw new Error(`Missing fragment param: ${k}`);
    return v;
  };
  return {
    attestation: required("attestation") as Hex,
    userId: BigInt(required("user_id")),
    epoch: BigInt(required("epoch")),
    actionHash: required("action_hash") as Hex,
    signer: required("signer") as `0x${string}`,
    provider: required("provider"),
    preferredUsername: params.get("preferred_username") ?? undefined,
    picture: params.get("picture") ?? undefined,
  };
}
