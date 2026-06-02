#!/usr/bin/env node
/**
 * SocialTwin JWKS watchdog — standalone, dependency-light (ethers + fetch).
 *
 * The verifier holds Twitch's RSA modulus onchain and a contract can't fetch
 * JWKS, so this is the off-chain early-warning that makes the 7-day key-rotation
 * timelock useful. Run it on a schedule (cron / CI) and alert on a non-zero exit.
 *
 * Each run it:
 *   1. Fetches https://id.twitch.tv/oauth2/keys.
 *   2. For every kid the verifier already knows, checks its onchain modulus still
 *      matches the live JWKS (a mismatch ⇒ Twitch rotated ⇒ queue a rotation).
 *   3. Flags a new Twitch kid the verifier doesn't have yet (overlap window).
 *   4. Reads the verifier's pendingKeyFor(kid): if a rotation is QUEUED, it
 *      compares the pending modulus to the live JWKS — a mismatch is CRITICAL
 *      (likely a malicious key; the guardian must cancelKey before the timelock).
 *
 * Exit code: 0 = ok, 1 = warn, 2 = critical, 3 = error. Prints one JSON line.
 *
 * Env: VERIFIER, GUARDIAN, BASE_RPC_URL (all optional; default to the live v1.3 stack).
 */
const { ethers } = require("ethers");

const JWKS_URL = "https://id.twitch.tv/oauth2/keys";
const VERIFIER = process.env.VERIFIER || "0xBDfC552469f11843802BCD7ec9a8372c8020fee8"; // v1.3
const GUARDIAN = process.env.GUARDIAN || "0xD1EC8245c8850A151843ce8a3AFdca3b19747706"; // treasury (veto)
const RPCS = [process.env.BASE_RPC_URL, "https://base-rpc.publicnode.com", "https://mainnet.base.org"].filter(Boolean);
const ABI = [
  "function modulusOf(bytes32) view returns (bytes)",
  "function pendingKeyFor(string) view returns (bytes, uint256)",
];

const kidHash = (kid) => ethers.keccak256(ethers.toUtf8Bytes(kid));
const b64urlToHex = (s) => "0x" + Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4), "base64").toString("hex");

async function getProvider() {
  for (const u of RPCS) { try { const p = new ethers.JsonRpcProvider(u, 8453); await p.getBlockNumber(); return p; } catch {} }
  throw new Error("no working Base RPC");
}

(async () => {
  const res = await fetch(JWKS_URL, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`JWKS http ${res.status}`);
  const keys = (await res.json()).keys || [];
  const liveKids = keys.map((k) => k.kid);
  const v = new ethers.Contract(VERIFIER, ABI, await getProvider());

  let status = "ok";
  const notes = [];
  const escalate = (s) => { if (s === "critical" || (s === "warn" && status === "ok")) status = s; };

  // kid="1" is the verifier's primary key — it must stay in the JWKS
  if (!liveKids.includes("1")) { escalate("critical"); notes.push(`kid="1" is GONE from Twitch JWKS — queue a rotation to the current key`); }

  for (const k of keys) {
    const onchain = String(await v.modulusOf(kidHash(k.kid))).toLowerCase();
    const liveHex = b64urlToHex(k.n).toLowerCase();
    if (onchain === "0x") {
      escalate("warn");
      notes.push(`new Twitch kid="${k.kid}" not yet in the verifier — queue a rotation during the overlap window`);
    } else if (onchain !== liveHex) {
      escalate("critical");
      notes.push(`kid="${k.kid}" modulus DIFFERS between the verifier and live JWKS — Twitch rotated; queue a rotation`);
    }
  }

  // queued-rotation cross-check — the teeth behind KEY_TIMELOCK
  for (const kid of Array.from(new Set(["1", ...liveKids]))) {
    let pmod, eta;
    try { [pmod, eta] = await v.pendingKeyFor(kid); } catch { continue; }
    if (!eta || eta === 0n) continue;
    const when = new Date(Number(eta) * 1000).toISOString();
    const live = keys.find((k) => k.kid === kid);
    if (live && String(pmod).toLowerCase() === b64urlToHex(live.n).toLowerCase()) {
      escalate("warn");
      notes.push(`a rotation for kid="${kid}" is QUEUED and matches the live JWKS (commits ~${when}); confirm it was your keyAdmin`);
    } else {
      escalate("critical");
      notes.push(`🚨 a rotation for kid="${kid}" is QUEUED that does NOT match the live JWKS${live ? "" : " (kid not in JWKS)"} — guardian ${GUARDIAN} must cancelKey("${kid}") before ~${when}`);
    }
  }

  console.log(JSON.stringify({ ts: new Date().toISOString(), status, verifier: VERIFIER, liveKids, notes }));
  process.exit(status === "critical" ? 2 : status === "warn" ? 1 : 0);
})().catch((e) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), status: "error", error: e.message || String(e) }));
  process.exit(3);
});
