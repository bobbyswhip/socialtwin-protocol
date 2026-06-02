import { expect } from "chai";
import { ethers } from "hardhat";
import { generateKeyPairSync, createPublicKey, KeyObject } from "crypto";
import jwt from "jsonwebtoken";
import { TwitchJWTVerifier } from "../typechain-types";

const ISSUER = "https://id.twitch.tv/oauth2";
const KID = "1";
const ALICE_USER_ID = 44322889n;

function rsaModulusBytes(key: KeyObject): Buffer {
  const jwk = key.export({ format: "jwk" }) as any;
  const n = jwk.n as string;
  const padded = n + "=".repeat((4 - (n.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function signJwt(payload: object, privateKey: KeyObject, kid = KID) {
  return jwt.sign(payload, privateKey.export({ type: "pkcs1", format: "pem" }) as string, {
    algorithm: "RS256",
    header: { alg: "RS256", typ: "JWT", kid },
  });
}

describe("TwitchJWTVerifier", () => {
  let verifier: TwitchJWTVerifier;
  let privateKey: KeyObject;
  let publicKey: KeyObject;

  before(async () => {
    const [deployer] = await ethers.getSigners();
    const kp = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 });
    privateKey = kp.privateKey;
    publicKey = kp.publicKey;
    const modulus = rsaModulusBytes(publicKey);
    expect(modulus.length).to.equal(256);

    const Verifier = await ethers.getContractFactory("TwitchJWTVerifier");
    verifier = await Verifier.deploy([KID], ["0x" + modulus.toString("hex")], ["test-app"], deployer.address, deployer.address, deployer.address);
    await verifier.waitForDeployment();
  });

  function actionHash(): string {
    return ethers.keccak256(ethers.toUtf8Bytes("test-action-" + Math.random()));
  }

  function mintToken(opts: {
    sub?: string;
    iat?: number;
    iss?: string;
    nonce?: string;
    kid?: string;
    privateKey?: KeyObject;
  } = {}) {
    const sub = opts.sub ?? ALICE_USER_ID.toString();
    const iat = opts.iat ?? Math.floor(Date.now() / 1000);
    const iss = opts.iss ?? ISSUER;
    const nonce = opts.nonce ?? "0x" + "00".repeat(32);
    return signJwt({ iss, sub, aud: "test-app", iat, exp: iat + 3600, nonce }, opts.privateKey ?? privateKey, opts.kid);
  }

  // ───────── Happy path ─────────
  it("accepts a valid Twitch-format JWT", async () => {
    const ah = actionHash();
    const iat = Math.floor(Date.now() / 1000);
    const token = mintToken({ nonce: ah, iat });
    const ok = await verifier.verify(ALICE_USER_ID, ah, BigInt(iat), ethers.toUtf8Bytes(token));
    expect(ok).to.equal(true);
  });

  // ───────── Signature integrity ─────────
  it("rejects a token signed by the wrong key", async () => {
    const wrong = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 });
    const ah = actionHash();
    const iat = Math.floor(Date.now() / 1000);
    const token = mintToken({ nonce: ah, iat, privateKey: wrong.privateKey });
    await expect(
      verifier.verify(ALICE_USER_ID, ah, BigInt(iat), ethers.toUtf8Bytes(token))
    ).to.be.revertedWithCustomError(verifier, "BadSignature");
  });

  it("rejects a token whose payload bytes were tampered after signing", async () => {
    const ah = actionHash();
    const iat = Math.floor(Date.now() / 1000);
    const token = mintToken({ nonce: ah, iat });
    // Flip one byte in the payload section
    const tampered = token.replace(/A/, "B");
    await expect(
      verifier.verify(ALICE_USER_ID, ah, BigInt(iat), ethers.toUtf8Bytes(tampered))
    ).to.be.reverted;
  });

  // ───────── Key id / algorithm ─────────
  it("rejects a JWT with unknown kid", async () => {
    const ah = actionHash();
    const iat = Math.floor(Date.now() / 1000);
    const token = mintToken({ nonce: ah, iat, kid: "99" });
    await expect(
      verifier.verify(ALICE_USER_ID, ah, BigInt(iat), ethers.toUtf8Bytes(token))
    ).to.be.revertedWithCustomError(verifier, "UnknownKey");
  });

  it("rejects a JWT with non-RS256 algorithm", async () => {
    // Manually craft a JWT with alg=none and matching header
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT", kid: KID })).toString("base64url");
    const ah = actionHash();
    const iat = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(JSON.stringify({
      iss: ISSUER, sub: ALICE_USER_ID.toString(), aud: "x", iat, exp: iat + 3600, nonce: ah,
    })).toString("base64url");
    const token = `${header}.${payload}.`;
    await expect(
      verifier.verify(ALICE_USER_ID, ah, BigInt(iat), ethers.toUtf8Bytes(token))
    ).to.be.revertedWithCustomError(verifier, "WrongAlgorithm");
  });

  // ───────── Claim binding ─────────
  it("rejects when sub claim differs from userId argument", async () => {
    const ah = actionHash();
    const iat = Math.floor(Date.now() / 1000);
    const token = mintToken({ nonce: ah, iat, sub: "99999999" });
    await expect(
      verifier.verify(ALICE_USER_ID, ah, BigInt(iat), ethers.toUtf8Bytes(token))
    ).to.be.revertedWithCustomError(verifier, "WrongSub");
  });

  it("rejects when iat differs from oauthExchangeEpoch", async () => {
    const ah = actionHash();
    const iat = Math.floor(Date.now() / 1000);
    const token = mintToken({ nonce: ah, iat });
    await expect(
      verifier.verify(ALICE_USER_ID, ah, BigInt(iat + 1), ethers.toUtf8Bytes(token))
    ).to.be.revertedWithCustomError(verifier, "WrongIat");
  });

  it("rejects when nonce doesn't match action_hash", async () => {
    const correctAh = actionHash();
    const wrongAh = actionHash();
    const iat = Math.floor(Date.now() / 1000);
    const token = mintToken({ nonce: wrongAh, iat });
    await expect(
      verifier.verify(ALICE_USER_ID, correctAh, BigInt(iat), ethers.toUtf8Bytes(token))
    ).to.be.revertedWithCustomError(verifier, "WrongNonce");
  });

  it("rejects when issuer is not Twitch", async () => {
    const ah = actionHash();
    const iat = Math.floor(Date.now() / 1000);
    const token = mintToken({ nonce: ah, iat, iss: "https://accounts.google.com" });
    await expect(
      verifier.verify(ALICE_USER_ID, ah, BigInt(iat), ethers.toUtf8Bytes(token))
    ).to.be.revertedWithCustomError(verifier, "WrongIssuer");
  });
});
