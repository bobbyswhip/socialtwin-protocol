import { expect } from "chai";
import { ethers } from "hardhat";
import { generateKeyPairSync, KeyObject } from "crypto";
import jwt from "jsonwebtoken";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { TwinAccount, TwinFactory, TwitchJWTVerifier } from "../typechain-types";

const ISSUER = "https://id.twitch.tv/oauth2";
const KID = "1";
const ALICE_USER_ID = 12345n;
const BOB_USER_ID = 67890n;

function rsaModulus(key: KeyObject): Buffer {
  const jwk = key.export({ format: "jwk" }) as any;
  const n = jwk.n as string;
  const padded = n + "=".repeat((4 - (n.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function mintToken(privateKey: KeyObject, opts: {
  sub: bigint;
  iat?: number;
  nonce: string;
  iss?: string;
}) {
  const iat = opts.iat ?? Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iss: opts.iss ?? ISSUER, sub: opts.sub.toString(), aud: "test", iat, exp: iat + 3600, nonce: opts.nonce },
    privateKey.export({ type: "pkcs1", format: "pem" }) as string,
    { algorithm: "RS256", header: { alg: "RS256", typ: "JWT", kid: KID } }
  );
}

describe("TwinFactory + TwinAccount", () => {
  let factory: TwinFactory;
  let verifier: TwitchJWTVerifier;
  let privateKey: KeyObject;
  let deployer: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let randomSubmitter: HardhatEthersSigner;
  let mallory: HardhatEthersSigner;
  let recipient: HardhatEthersSigner;

  beforeEach(async () => {
    [deployer, alice, bob, randomSubmitter, mallory, recipient] = await ethers.getSigners();

    const kp = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 });
    privateKey = kp.privateKey;
    const modulus = rsaModulus(kp.publicKey);

    const VerifierFactory = await ethers.getContractFactory("TwitchJWTVerifier");
    verifier = await VerifierFactory.deploy([KID], ["0x" + modulus.toString("hex")], ["test"], deployer.address, deployer.address, deployer.address);
    await verifier.waitForDeployment();

    const TwinFactoryFactory = await ethers.getContractFactory("TwinFactory");
    factory = await TwinFactoryFactory.deploy(await verifier.getAddress(), deployer.address);
    await factory.waitForDeployment();
  });

  async function aliceTwin(): Promise<TwinAccount> {
    await factory.deployTwin(ALICE_USER_ID);
    const addr = await factory.predictAddress(ALICE_USER_ID);
    return ethers.getContractAt("TwinAccount", addr);
  }

  // ─── Deterministic address ───────────────────────────────────────────
  describe("address derivation", () => {
    it("predictAddress matches the deployed address", async () => {
      const predicted = await factory.predictAddress(ALICE_USER_ID);
      const tx = await factory.deployTwin(ALICE_USER_ID);
      const r = await tx.wait();
      const ev = r!.logs.find((l: any) => l.fragment?.name === "TwinDeployed") as any;
      expect(ev.args.twin).to.equal(predicted);
    });

    it("different userIds → different addresses", async () => {
      const a = await factory.predictAddress(ALICE_USER_ID);
      const b = await factory.predictAddress(BOB_USER_ID);
      expect(a).to.not.equal(b);
    });

    it("deployTwin is idempotent", async () => {
      await factory.deployTwin(ALICE_USER_ID);
      await expect(factory.deployTwin(ALICE_USER_ID)).to.not.be.reverted;
    });

    it("anyone can pre-fund the twin before it exists", async () => {
      const addr = await factory.predictAddress(ALICE_USER_ID);
      await deployer.sendTransaction({ to: addr, value: ethers.parseEther("0.5") });
      expect(await ethers.provider.getBalance(addr)).to.equal(ethers.parseEther("0.5"));
      // Twin not yet deployed
      expect(await ethers.provider.getCode(addr)).to.equal("0x");
      // Funds survive deployment
      await factory.deployTwin(ALICE_USER_ID);
      expect(await ethers.provider.getBalance(addr)).to.equal(ethers.parseEther("0.5"));
    });
  });

  // ─── Execute happy path ──────────────────────────────────────────────
  describe("execute()", () => {
    it("sends ETH out when the JWT correctly binds the action", async () => {
      const twin = await aliceTwin();
      await deployer.sendTransaction({ to: await twin.getAddress(), value: ethers.parseEther("1") });

      const target = recipient.address;
      const value = ethers.parseEther("0.2");
      const data = "0x";
      const nonce = await twin.nonce();
      const block = await ethers.provider.getBlock("latest");
      const now = Number(block!.timestamp);
      const deadline = BigInt(now + 600);
      const actionHash = await twin.computeActionHash(target, value, data, nonce, deadline);
      const iat = now;
      const token = mintToken(privateKey, { sub: ALICE_USER_ID, iat, nonce: actionHash });

      const balBefore = await ethers.provider.getBalance(target);
      await twin.connect(randomSubmitter).execute(target, value, data, nonce, deadline, BigInt(iat), ethers.toUtf8Bytes(token));
      expect(await ethers.provider.getBalance(target) - balBefore).to.equal(value);
      expect(await twin.nonce()).to.equal(nonce + 1n);
    });

    it("permissionless: any submitter can land the tx", async () => {
      const twin = await aliceTwin();
      await deployer.sendTransaction({ to: await twin.getAddress(), value: ethers.parseEther("0.1") });
      const target = recipient.address;
      const value = 0n;
      const data = "0x";
      const nonce = await twin.nonce();
      const block = await ethers.provider.getBlock("latest");
      const now = Number(block!.timestamp);
      const deadline = BigInt(now + 600);
      const actionHash = await twin.computeActionHash(target, value, data, nonce, deadline);
      const iat = now;
      const token = mintToken(privateKey, { sub: ALICE_USER_ID, iat, nonce: actionHash });
      // Submit from a totally unrelated address.
      await expect(
        twin.connect(mallory).execute(target, value, data, nonce, deadline, BigInt(iat), ethers.toUtf8Bytes(token))
      ).to.emit(twin, "Executed");
    });
  });

  // ─── Replay + binding ────────────────────────────────────────────────
  describe("replay + binding", () => {
    it("rejects the same JWT submitted twice (nonce moves)", async () => {
      const twin = await aliceTwin();
      await deployer.sendTransaction({ to: await twin.getAddress(), value: ethers.parseEther("0.5") });
      const args = await buildExecuteArgs(twin, ALICE_USER_ID, recipient.address, ethers.parseEther("0.01"), "0x");
      await twin.execute(recipient.address, ethers.parseEther("0.01"), "0x", args.nonce, args.deadline, BigInt(args.iat), ethers.toUtf8Bytes(args.token));
      await expect(
        twin.execute(recipient.address, ethers.parseEther("0.01"), "0x", args.nonce, args.deadline, BigInt(args.iat), ethers.toUtf8Bytes(args.token))
      ).to.be.revertedWithCustomError(twin, "WrongNonce");
    });

    it("rejects mutated target", async () => {
      const twin = await aliceTwin();
      const args = await buildExecuteArgs(twin, ALICE_USER_ID, recipient.address, 0n, "0x");
      await expect(
        twin.execute(deployer.address, 0n, "0x", args.nonce, args.deadline, BigInt(args.iat), ethers.toUtf8Bytes(args.token))
      ).to.be.reverted; // verifier reverts inside verify() with WrongNonce(JWT nonce vs computed action_hash)
    });

    it("rejects mutated value", async () => {
      const twin = await aliceTwin();
      const args = await buildExecuteArgs(twin, ALICE_USER_ID, recipient.address, ethers.parseEther("0.01"), "0x");
      await expect(
        twin.execute(recipient.address, ethers.parseEther("0.5"), "0x", args.nonce, args.deadline, BigInt(args.iat), ethers.toUtf8Bytes(args.token))
      ).to.be.reverted;
    });

    it("rejects mutated data", async () => {
      const twin = await aliceTwin();
      const args = await buildExecuteArgs(twin, ALICE_USER_ID, recipient.address, 0n, "0xdeadbeef");
      await expect(
        twin.execute(recipient.address, 0n, "0xcafebabe", args.nonce, args.deadline, BigInt(args.iat), ethers.toUtf8Bytes(args.token))
      ).to.be.reverted;
    });
  });

  // ─── Time / freshness ────────────────────────────────────────────────
  describe("time", () => {
    it("rejects past deadline", async () => {
      const twin = await aliceTwin();
      const block = await ethers.provider.getBlock("latest");
      const pastDeadline = BigInt(block!.timestamp) - 1n;
      const nonce = await twin.nonce();
      const actionHash = await twin.computeActionHash(recipient.address, 0n, "0x", nonce, pastDeadline);
      const iat = Math.floor(Date.now() / 1000);
      const token = mintToken(privateKey, { sub: ALICE_USER_ID, iat, nonce: actionHash });
      await expect(
        twin.execute(recipient.address, 0n, "0x", nonce, pastDeadline, BigInt(iat), ethers.toUtf8Bytes(token))
      ).to.be.revertedWithCustomError(twin, "DeadlinePassed");
    });

    it("rejects stale OAuth (iat older than MAX_PROOF_AGE)", async () => {
      const twin = await aliceTwin();
      const block = await ethers.provider.getBlock("latest");
      const staleIat = Number(block!.timestamp) - 6 * 60; // 6 min old
      const nonce = await twin.nonce();
      const deadline = BigInt(block!.timestamp) + 600n;
      const actionHash = await twin.computeActionHash(recipient.address, 0n, "0x", nonce, deadline);
      const token = mintToken(privateKey, { sub: ALICE_USER_ID, iat: staleIat, nonce: actionHash });
      await expect(
        twin.execute(recipient.address, 0n, "0x", nonce, deadline, BigInt(staleIat), ethers.toUtf8Bytes(token))
      ).to.be.revertedWithCustomError(twin, "ProofTooOld");
    });
  });

  // ─── Cross-user isolation ────────────────────────────────────────────
  describe("cross-user isolation", () => {
    it("a JWT for Alice cannot drain Bob's twin", async () => {
      await factory.deployTwin(ALICE_USER_ID);
      await factory.deployTwin(BOB_USER_ID);
      const bobTwinAddr = await factory.predictAddress(BOB_USER_ID);
      const bobTwin = await ethers.getContractAt("TwinAccount", bobTwinAddr);
      await deployer.sendTransaction({ to: bobTwinAddr, value: ethers.parseEther("0.1") });

      // Build args targeting Bob's twin, but sign with Alice's user_id.
      const block = await ethers.provider.getBlock("latest");
      const now = Number(block!.timestamp);
      const nonce = await bobTwin.nonce();
      const deadline = BigInt(now + 600);
      const actionHash = await bobTwin.computeActionHash(recipient.address, 0n, "0x", nonce, deadline);
      const iat = now;
      const token = mintToken(privateKey, { sub: ALICE_USER_ID, iat, nonce: actionHash });
      await expect(
        bobTwin.execute(recipient.address, 0n, "0x", nonce, deadline, BigInt(iat), ethers.toUtf8Bytes(token))
      ).to.be.reverted; // verifier WrongSub
    });
  });

  // ─── Batch ───────────────────────────────────────────────────────────
  describe("executeBatch()", () => {
    it("runs multiple calls atomically under one JWT", async () => {
      const twin = await aliceTwin();
      await deployer.sendTransaction({ to: await twin.getAddress(), value: ethers.parseEther("1") });
      const targets = [recipient.address, mallory.address];
      const values = [ethers.parseEther("0.1"), ethers.parseEther("0.2")];
      const datas = ["0x", "0x"];
      const block = await ethers.provider.getBlock("latest");
      const now = Number(block!.timestamp);
      const nonce = await twin.nonce();
      const deadline = BigInt(now + 600);
      const actionHash = await twin.computeBatchHash(targets, values, datas, nonce, deadline);
      const iat = now;
      const token = mintToken(privateKey, { sub: ALICE_USER_ID, iat, nonce: actionHash });

      const b1Before = await ethers.provider.getBalance(recipient.address);
      const b2Before = await ethers.provider.getBalance(mallory.address);
      await twin.executeBatch(targets, values, datas, nonce, deadline, BigInt(iat), ethers.toUtf8Bytes(token));
      expect(await ethers.provider.getBalance(recipient.address) - b1Before).to.equal(values[0]);
      expect(await ethers.provider.getBalance(mallory.address) - b2Before).to.equal(values[1]);
    });

    it("rejects empty batch", async () => {
      const twin = await aliceTwin();
      const block = await ethers.provider.getBlock("latest");
      await expect(
        twin.executeBatch([], [], [], 0n, BigInt(block!.timestamp) + 600n, BigInt(block!.timestamp), "0x")
      ).to.be.revertedWithCustomError(twin, "EmptyBatch");
    });
  });

  // ─── helper ──────────────────────────────────────────────────────────
  async function buildExecuteArgs(
    twin: TwinAccount,
    sub: bigint,
    target: string,
    value: bigint,
    data: string
  ) {
    const block = await ethers.provider.getBlock("latest");
    const now = Number(block!.timestamp);
    const nonce = await twin.nonce();
    const deadline = BigInt(now + 600);
    const iat = now;
    const actionHash = await twin.computeActionHash(target, value, data, nonce, deadline);
    const token = mintToken(privateKey, { sub, iat, nonce: actionHash });
    return { nonce, deadline, iat, token };
  }
});
