import { expect } from "chai";
import { ethers } from "hardhat";
import { generateKeyPairSync, KeyObject } from "crypto";
import jwt from "jsonwebtoken";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { TwitchJWTVerifier } from "../typechain-types";

/**
 * v1.3 — timelocked, guardian-cancelable, JWKS-verifiable signing-key rotation.
 *
 * Guarantees a Twitch key rotation never permanently locks twins: keyAdmin can
 * rotate the modulus IN PLACE (same verifier address ⇒ same twin addresses),
 * but only after KEY_TIMELOCK, which a distinct guardian can veto, and the
 * pending modulus is public so anyone can compare it to id.twitch.tv/oauth2/keys.
 */

const ISSUER = "https://id.twitch.tv/oauth2";
const AUD = "rot-app";
const USER = 555n;
const KEY_TIMELOCK = 7 * 24 * 60 * 60;
const AH = ethers.keccak256(ethers.toUtf8Bytes("an-action")); // 0x + 64 hex
const EPOCH = 1_900_000_000;

function modHex(k: KeyObject): string {
  const jwk = k.export({ format: "jwk" }) as any;
  const n = jwk.n + "=".repeat((4 - (jwk.n.length % 4)) % 4);
  return "0x" + Buffer.from(n.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("hex");
}
function token(priv: KeyObject, kid = "1") {
  const t = jwt.sign(
    { iss: ISSUER, aud: AUD, sub: USER.toString(), iat: EPOCH, exp: EPOCH + 3600, nonce: AH },
    priv.export({ type: "pkcs1", format: "pem" }) as string,
    { algorithm: "RS256", header: { alg: "RS256", typ: "JWT", kid } }
  );
  return ethers.toUtf8Bytes(t);
}
async function warp(secs: number) {
  await ethers.provider.send("evm_increaseTime", [secs]);
  await ethers.provider.send("evm_mine", []);
}

describe("TwitchJWTVerifier — signing-key rotation (v1.3)", () => {
  let verifier: TwitchJWTVerifier;
  let deployer: HardhatEthersSigner, keyAdmin: HardhatEthersSigner, guardian: HardhatEthersSigner, attacker: HardhatEthersSigner;
  let oldPriv: KeyObject, oldPub: KeyObject, newPriv: KeyObject, newPub: KeyObject;

  beforeEach(async () => {
    [deployer, keyAdmin, guardian, attacker] = await ethers.getSigners();
    const ok = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 });
    const nk = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 });
    oldPriv = ok.privateKey; oldPub = ok.publicKey; newPriv = nk.privateKey; newPub = nk.publicKey;
    const V = await ethers.getContractFactory("TwitchJWTVerifier");
    verifier = await V.deploy(["1"], [modHex(oldPub)], [AUD], deployer.address, keyAdmin.address, guardian.address);
    await verifier.waitForDeployment();
  });

  it("the old key verifies before any rotation", async () => {
    expect(await verifier.verify(USER, AH, EPOCH, token(oldPriv))).to.equal(true);
  });

  it("only keyAdmin can queue a key", async () => {
    await expect(verifier.connect(attacker).queueKey("1", modHex(newPub))).to.be.revertedWithCustomError(verifier, "NotKeyAdmin");
    await expect(verifier.connect(guardian).queueKey("1", modHex(newPub))).to.be.revertedWithCustomError(verifier, "NotKeyAdmin");
    await expect(verifier.connect(keyAdmin).queueKey("1", modHex(newPub))).to.emit(verifier, "KeyQueued");
  });

  it("commitKey reverts without a queue, and before the timelock elapses", async () => {
    await expect(verifier.connect(keyAdmin).commitKey("1")).to.be.revertedWithCustomError(verifier, "KeyNotQueued");
    await verifier.connect(keyAdmin).queueKey("1", modHex(newPub));
    await expect(verifier.connect(keyAdmin).commitKey("1")).to.be.revertedWithCustomError(verifier, "KeyTimelockNotElapsed");
  });

  it("rejects a non-256-byte modulus", async () => {
    await expect(verifier.connect(keyAdmin).queueKey("1", "0x1234")).to.be.revertedWithCustomError(verifier, "BadModulusLength");
  });

  it("the guardian can VETO a pending key (and so can keyAdmin)", async () => {
    await verifier.connect(keyAdmin).queueKey("1", modHex(newPub));
    await expect(verifier.connect(attacker).cancelKey("1")).to.be.revertedWithCustomError(verifier, "NotGuardianNorKeyAdmin");
    await expect(verifier.connect(guardian).cancelKey("1")).to.emit(verifier, "KeyCancelled");
    await warp(KEY_TIMELOCK + 1);
    await expect(verifier.connect(keyAdmin).commitKey("1")).to.be.revertedWithCustomError(verifier, "KeyNotQueued");
  });

  it("ROTATES kid=1 in place: after commit, new key verifies and old key is rejected", async () => {
    const addrBefore = await verifier.getAddress();
    await verifier.connect(keyAdmin).queueKey("1", modHex(newPub));
    // public during the timelock so anyone can check it against Twitch's JWKS
    const [pendingMod, eta] = await verifier.pendingKeyFor("1");
    expect(pendingMod.toLowerCase()).to.equal(modHex(newPub).toLowerCase());
    expect(eta).to.be.greaterThan(0n);

    await warp(KEY_TIMELOCK + 1);
    await expect(verifier.connect(keyAdmin).commitKey("1")).to.emit(verifier, "KeyCommitted");

    // same verifier address — no migration, existing twins unaffected by address
    expect(await verifier.getAddress()).to.equal(addrBefore);
    // new Twitch key now works
    expect(await verifier.verify(USER, AH, EPOCH, token(newPriv))).to.equal(true);
    // tokens from the retired key no longer verify
    await expect(verifier.verify(USER, AH, EPOCH, token(oldPriv))).to.be.reverted;
  });

  it("can ADD a new kid while keeping the old one", async () => {
    await verifier.connect(keyAdmin).queueKey("2", modHex(newPub));
    await warp(KEY_TIMELOCK + 1);
    await verifier.connect(keyAdmin).commitKey("2");
    expect(await verifier.verify(USER, AH, EPOCH, token(newPriv, "2"))).to.equal(true); // new kid
    expect(await verifier.verify(USER, AH, EPOCH, token(oldPriv, "1"))).to.equal(true); // old kid still valid
  });

  it("only the guardian can transfer the guardian role (keyAdmin cannot neutralize its own veto)", async () => {
    await expect(verifier.connect(keyAdmin).transferGuardian(attacker.address)).to.be.revertedWithCustomError(verifier, "NotGuardianNorKeyAdmin");
    await expect(verifier.connect(guardian).transferGuardian(attacker.address)).to.emit(verifier, "GuardianTransferred");
    expect(await verifier.guardian()).to.equal(attacker.address);
  });

  it("keyAdmin is transferable but never to zero", async () => {
    await expect(verifier.connect(keyAdmin).transferKeyAdmin(ethers.ZeroAddress)).to.be.revertedWith("zero");
    await verifier.connect(keyAdmin).transferKeyAdmin(attacker.address);
    expect(await verifier.keyAdmin()).to.equal(attacker.address);
  });
});
