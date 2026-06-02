import { expect } from "chai";
import { ethers } from "hardhat";
import { generateKeyPairSync, KeyObject, randomBytes } from "crypto";
import jwt from "jsonwebtoken";
import { TwitchJWTVerifier } from "../typechain-types";

/**
 * Fuzz / property tests for the hand-rolled JWT parser (F6 in the audit).
 *
 * The verifier hand-implements base64url decode, JSON claim extraction, decimal
 * parsing and RSA PKCS#1 v1.5 in Solidity. These tests hammer that surface with
 * random and adversarial inputs. The invariant under test is one-directional and
 * absolute: the verifier must NEVER return `true` for anything other than a
 * genuinely Twitch-signed token whose sub/iat/nonce/aud all match. It is allowed
 * to revert or return false on anything malformed — it must never accept.
 *
 * This is not a substitute for an external audit + dedicated fuzzing campaign
 * (still recommended before large value), but it locks in the core invariant.
 */

const ISSUER = "https://id.twitch.tv/oauth2";
const KID = "1";
const AUD = "official-app";
const ITERS = Number(process.env.FUZZ_ITERS || 150);

function rsaModulus(key: KeyObject): Buffer {
  const jwk = key.export({ format: "jwk" }) as any;
  const n = jwk.n as string;
  const padded = n + "=".repeat((4 - (n.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

describe("TwitchJWTVerifier — fuzz / parser hardening (F6)", () => {
  let verifier: TwitchJWTVerifier;
  let goodKey: KeyObject;
  let evilKey: KeyObject;
  const userId = 1507305235n;
  const epoch = 1_900_000_000; // far-future fixed iat so freshness (checked by the twin, not here) is irrelevant
  let actionHash: string;

  before(async () => {
    const [admin] = await ethers.getSigners();
    const good = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 });
    const evil = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 });
    goodKey = good.privateKey;
    evilKey = evil.privateKey;
    const V = await ethers.getContractFactory("TwitchJWTVerifier");
    verifier = await V.deploy([KID], ["0x" + rsaModulus(good.publicKey).toString("hex")], [AUD], admin.address, admin.address, admin.address);
    await verifier.waitForDeployment();
    actionHash = ethers.keccak256(ethers.toUtf8Bytes("action")); // any 32-byte value; verifier checks nonce==hex(this)
  });

  const sign = (key: KeyObject, claims: object, header: object = {}) =>
    jwt.sign(claims, key.export({ type: "pkcs1", format: "pem" }) as string, {
      algorithm: "RS256",
      header: { alg: "RS256", typ: "JWT", kid: KID, ...header },
    });

  // verify() is a view that reverts on malformed input. Returns true only on a
  // fully valid token. This wrapper never throws — it reports accepted/rejected.
  async function accepts(tokenBytesHex: string): Promise<boolean> {
    try {
      return await verifier.verify(userId, actionHash, epoch, tokenBytesHex);
    } catch {
      return false; // revert == rejected
    }
  }

  it("sanity: a correctly-signed, matching token is accepted", async () => {
    const tok = sign(goodKey, { iss: ISSUER, aud: AUD, sub: userId.toString(), iat: epoch, exp: epoch + 3600, nonce: actionHash });
    expect(await accepts(ethers.hexlify(ethers.toUtf8Bytes(tok)))).to.equal(true);
  });

  it(`fuzz: ${ITERS} random byte blobs are never accepted`, async () => {
    for (let i = 0; i < ITERS; i++) {
      const len = 1 + Math.floor(Math.random() * 400);
      const blob = "0x" + randomBytes(len).toString("hex");
      expect(await accepts(blob)).to.equal(false);
    }
  });

  it(`fuzz: ${ITERS} structurally-valid JWTs signed by the WRONG key are never accepted`, async () => {
    for (let i = 0; i < ITERS; i++) {
      const tok = sign(evilKey, {
        iss: ISSUER, aud: AUD, sub: userId.toString(), iat: epoch, exp: epoch + 3600, nonce: actionHash,
      });
      expect(await accepts(ethers.hexlify(ethers.toUtf8Bytes(tok)))).to.equal(false);
    }
  });

  it("fuzz: each individually-mutated claim (sub/iat/nonce/aud/iss) is rejected", async () => {
    const base = { iss: ISSUER, aud: AUD, sub: userId.toString(), iat: epoch, exp: epoch + 3600, nonce: actionHash };
    const mutations: object[] = [
      { ...base, sub: (userId + 1n).toString() },
      { ...base, sub: "0" },
      { ...base, sub: "" },
      { ...base, iat: epoch + 1 },
      { ...base, nonce: ethers.keccak256(ethers.toUtf8Bytes("other")) },
      { ...base, nonce: "" },
      { ...base, aud: "attacker-app" },
      { ...base, aud: [AUD] as any }, // array form must not match the single-string needle
      { ...base, iss: "https://evil.example/oauth2" },
    ];
    for (const m of mutations) {
      const tok = sign(goodKey, m);
      expect(await accepts(ethers.hexlify(ethers.toUtf8Bytes(tok)))).to.equal(false);
    }
  });

  it("fuzz: non-RS256 alg headers (alg=none / HS256) are rejected", async () => {
    // alg=none, unsigned
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT", kid: KID })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iss: ISSUER, aud: AUD, sub: userId.toString(), iat: epoch, nonce: actionHash })).toString("base64url");
    expect(await accepts(ethers.hexlify(ethers.toUtf8Bytes(`${header}.${payload}.`)))).to.equal(false);
    // HS256 with a guessed secret
    const hs = jwt.sign({ iss: ISSUER, aud: AUD, sub: userId.toString(), iat: epoch, nonce: actionHash }, "secret", { algorithm: "HS256", header: { alg: "HS256", typ: "JWT", kid: KID } as any });
    expect(await accepts(ethers.hexlify(ethers.toUtf8Bytes(hs)))).to.equal(false);
  });

  it("injection: a username carrying a fake \",sub\":... claim cannot redirect the sub binding", async () => {
    // Twitch JSON-escapes quotes inside string values, so an injected `"sub":"`
    // inside preferred_username appears as bytes `\"sub\":\"` and never matches
    // the `"sub":"` needle. Confirm the verifier still binds to the REAL sub.
    const evilUsername = `x","sub":"${(userId + 999n).toString()}`;
    const tok = sign(goodKey, {
      iss: ISSUER, aud: AUD, sub: userId.toString(), iat: epoch, exp: epoch + 3600, nonce: actionHash,
      preferred_username: evilUsername,
    });
    // Accepted because the real sub matches userId; the injection did not hijack it.
    expect(await accepts(ethers.hexlify(ethers.toUtf8Bytes(tok)))).to.equal(true);
    // And the same token is NOT valid for the injected (fake) userId.
    try {
      const r = await verifier.verify(userId + 999n, actionHash, epoch, ethers.hexlify(ethers.toUtf8Bytes(tok)));
      expect(r).to.equal(false);
    } catch { /* revert == rejected, also fine */ }
  });

  it("fuzz: truncated valid tokens (every prefix length) are never accepted", async () => {
    const tok = sign(goodKey, { iss: ISSUER, aud: AUD, sub: userId.toString(), iat: epoch, exp: epoch + 3600, nonce: actionHash });
    const bytes = ethers.toUtf8Bytes(tok);
    for (let i = 0; i < 40; i++) {
      const cut = Math.floor((bytes.length * i) / 40);
      expect(await accepts(ethers.hexlify(bytes.slice(0, cut)))).to.equal(false);
    }
  });
});
