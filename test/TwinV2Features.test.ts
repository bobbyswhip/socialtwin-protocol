import { expect } from "chai";
import { ethers } from "hardhat";
import { generateKeyPairSync, KeyObject } from "crypto";
import jwt from "jsonwebtoken";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { TwinAccount, TwinFactory, TwitchJWTVerifier } from "../typechain-types";

const ISSUER = "https://id.twitch.tv/oauth2";
const KID = "1";
const ALICE = 12345n;
const BOB = 67890n;
const RESCUE_DELAY = 90 * 24 * 60 * 60; // 3 months

function rsaModulus(key: KeyObject): Buffer {
  const jwk = key.export({ format: "jwk" }) as any;
  const n = jwk.n as string;
  const padded = n + "=".repeat((4 - (n.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

describe("TwinAccount v2 — escape EOA + rescue", () => {
  let factory: TwinFactory;
  let verifier: TwitchJWTVerifier;
  let pk: KeyObject;
  let deployer: HardhatEthersSigner;
  let rescuer: HardhatEthersSigner;
  let aliceEOA: HardhatEthersSigner;
  let newEOA: HardhatEthersSigner;
  let mallory: HardhatEthersSigner;
  let recipient: HardhatEthersSigner;
  let communityEOA: HardhatEthersSigner;

  beforeEach(async () => {
    [deployer, rescuer, aliceEOA, newEOA, mallory, recipient, communityEOA] = await ethers.getSigners();
    const kp = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 });
    pk = kp.privateKey;
    const V = await ethers.getContractFactory("TwitchJWTVerifier");
    verifier = await V.deploy([KID], ["0x" + rsaModulus(kp.publicKey).toString("hex")], ["t"], deployer.address);
    await verifier.waitForDeployment();
    const F = await ethers.getContractFactory("TwinFactory");
    factory = await F.deploy(await verifier.getAddress(), rescuer.address);
    await factory.waitForDeployment();
  });

  function mint(sub: bigint, iat: number, nonce: string) {
    return jwt.sign(
      { iss: ISSUER, sub: sub.toString(), aud: "t", iat, exp: iat + 3600, nonce },
      pk.export({ type: "pkcs1", format: "pem" }) as string,
      { algorithm: "RS256", header: { alg: "RS256", typ: "JWT", kid: KID } }
    );
  }

  async function twinFor(userId: bigint): Promise<TwinAccount> {
    await factory.deployTwin(userId);
    return ethers.getContractAt("TwinAccount", await factory.predictAddress(userId));
  }

  async function now(): Promise<number> {
    const b = await ethers.provider.getBlock("latest");
    return Number(b!.timestamp);
  }

  // ─── Escape EOA ───────────────────────────────────────────────
  describe("setOwnerEOA (escape hatch)", () => {
    it("Twitch owner connects an EOA via JWT, then that EOA spends with no JWT", async () => {
      const twin = await twinFor(ALICE);
      await deployer.sendTransaction({ to: await twin.getAddress(), value: ethers.parseEther("1") });

      const n = await twin.nonce();
      const t = await now();
      const deadline = t + 600;
      const ah = await twin.computeSetOwnerHash(aliceEOA.address, n, deadline);
      const token = mint(ALICE, t, ah);
      await twin.setOwnerEOA(aliceEOA.address, n, deadline, t, ethers.toUtf8Bytes(token));

      expect(await twin.ownerEOA()).to.equal(aliceEOA.address);
      expect(await twin.activated()).to.equal(true);

      // Now Twitch can vanish — EOA spends directly, no JWT.
      const before = await ethers.provider.getBalance(recipient.address);
      await twin.connect(aliceEOA).executeAsOwner(recipient.address, ethers.parseEther("0.3"), "0x");
      expect(await ethers.provider.getBalance(recipient.address) - before).to.equal(ethers.parseEther("0.3"));
    });

    it("a non-owner EOA cannot spend via the owner path", async () => {
      const twin = await twinFor(ALICE);
      await deployer.sendTransaction({ to: await twin.getAddress(), value: ethers.parseEther("1") });
      const n = await twin.nonce();
      const t = await now();
      const deadline = t + 600;
      const ah = await twin.computeSetOwnerHash(aliceEOA.address, n, deadline);
      await twin.setOwnerEOA(aliceEOA.address, n, deadline, t, ethers.toUtf8Bytes(mint(ALICE, t, ah)));
      await expect(
        twin.connect(mallory).executeAsOwner(mallory.address, ethers.parseEther("0.5"), "0x")
      ).to.be.revertedWithCustomError(twin, "NotOwner");
    });

    it("executeAsOwner reverts before any owner is set", async () => {
      const twin = await twinFor(ALICE);
      await expect(
        twin.connect(aliceEOA).executeAsOwner(recipient.address, 0n, "0x")
      ).to.be.revertedWithCustomError(twin, "NotOwner");
    });

    it("a JWT for Alice cannot set the owner EOA on Bob's twin", async () => {
      const bob = await twinFor(BOB);
      const n = await bob.nonce();
      const t = await now();
      const deadline = t + 600;
      const ah = await bob.computeSetOwnerHash(mallory.address, n, deadline);
      // sign with ALICE's id against BOB's twin
      const token = mint(ALICE, t, ah);
      await expect(
        bob.setOwnerEOA(mallory.address, n, deadline, t, ethers.toUtf8Bytes(token))
      ).to.be.reverted; // verifier WrongSub
    });

    it("owner can rotate to a new EOA with no Twitch involvement", async () => {
      const twin = await twinFor(ALICE);
      const n = await twin.nonce();
      const t = await now();
      const deadline = t + 600;
      const ah = await twin.computeSetOwnerHash(aliceEOA.address, n, deadline);
      await twin.setOwnerEOA(aliceEOA.address, n, deadline, t, ethers.toUtf8Bytes(mint(ALICE, t, ah)));

      await twin.connect(aliceEOA).rotateOwnerEOA(newEOA.address);
      expect(await twin.ownerEOA()).to.equal(newEOA.address);
      // old EOA no longer works
      await expect(
        twin.connect(aliceEOA).executeAsOwner(recipient.address, 0n, "0x")
      ).to.be.revertedWithCustomError(twin, "NotOwner");
    });

    it("connecting an EOA disables the JWT/Twitch path FOREVER (one-way self-custody)", async () => {
      const twin = await twinFor(ALICE);
      await deployer.sendTransaction({ to: await twin.getAddress(), value: ethers.parseEther("1") });

      // user takes self-custody
      let n = await twin.nonce(); let t = await now(); let dl = t + 600;
      let ah = await twin.computeSetOwnerHash(aliceEOA.address, n, dl);
      await twin.setOwnerEOA(aliceEOA.address, n, dl, t, ethers.toUtf8Bytes(mint(ALICE, t, ah)));
      expect(await twin.selfCustody()).to.equal(true);

      // a perfectly valid Twitch JWT can no longer SPEND
      n = await twin.nonce(); t = await now(); dl = t + 600;
      ah = await twin.computeActionHash(mallory.address, ethers.parseEther("1"), "0x", n, dl);
      await expect(
        twin.execute(mallory.address, ethers.parseEther("1"), "0x", n, dl, t, ethers.toUtf8Bytes(mint(ALICE, t, ah)))
      ).to.be.revertedWithCustomError(twin, "SelfCustodyEnabled");

      // ...nor RE-POINT ownership (no Twitch-compromise hijack)
      ah = await twin.computeSetOwnerHash(mallory.address, n, dl);
      await expect(
        twin.setOwnerEOA(mallory.address, n, dl, t, ethers.toUtf8Bytes(mint(ALICE, t, ah)))
      ).to.be.revertedWithCustomError(twin, "SelfCustodyEnabled");

      // the owner EOA still spends fine (and can rotate without Twitch)
      const before = await ethers.provider.getBalance(recipient.address);
      await twin.connect(aliceEOA).executeAsOwner(recipient.address, ethers.parseEther("0.4"), "0x");
      expect(await ethers.provider.getBalance(recipient.address) - before).to.equal(ethers.parseEther("0.4"));
    });
  });

  // ─── Abandoned-funds rescue (intent-based: initiate → wait → complete) ──
  describe("rescue (initiateRescue → wait → completeRescue)", () => {
    it("rescuer initiates, then completes after RESCUE_DELAY", async () => {
      const twin = await twinFor(ALICE);
      await deployer.sendTransaction({ to: await twin.getAddress(), value: ethers.parseEther("2") });

      // Not rescuable until intent is signalled — even long after deploy.
      await ethers.provider.send("evm_increaseTime", [RESCUE_DELAY + 1]);
      await ethers.provider.send("evm_mine", []);
      expect(await twin.isRescuable()).to.equal(false);
      expect(await twin.rescueAllowedAt()).to.equal(0n);

      await expect(twin.connect(rescuer).initiateRescue()).to.emit(twin, "RescueInitiated");
      expect(await twin.isRescuable()).to.equal(false); // delay runs from intent, not deploy
      await ethers.provider.send("evm_increaseTime", [RESCUE_DELAY + 1]);
      await ethers.provider.send("evm_mine", []);
      expect(await twin.isRescuable()).to.equal(true);

      await expect(twin.connect(rescuer).completeRescue(communityEOA.address)).to.emit(twin, "Rescued");
      expect(await twin.ownerEOA()).to.equal(communityEOA.address);

      const before = await ethers.provider.getBalance(recipient.address);
      await twin.connect(communityEOA).executeAsOwner(recipient.address, ethers.parseEther("2"), "0x");
      expect(await ethers.provider.getBalance(recipient.address) - before).to.equal(ethers.parseEther("2"));
    });

    it("completeRescue is blocked before the timelock", async () => {
      const twin = await twinFor(ALICE);
      await twin.connect(rescuer).initiateRescue();
      await expect(twin.connect(rescuer).completeRescue(communityEOA.address))
        .to.be.revertedWithCustomError(twin, "RescueTooEarly");
    });

    it("completeRescue without a prior initiate reverts", async () => {
      const twin = await twinFor(ALICE);
      await ethers.provider.send("evm_increaseTime", [RESCUE_DELAY + 1]);
      await ethers.provider.send("evm_mine", []);
      await expect(twin.connect(rescuer).completeRescue(communityEOA.address))
        .to.be.revertedWithCustomError(twin, "RescueNotInitiated");
    });

    it("the owner showing up before completion cancels the rescue", async () => {
      const twin = await twinFor(ALICE);
      await twin.connect(rescuer).initiateRescue();
      // Alice appears and connects her EOA before the delay elapses.
      const n = await twin.nonce();
      const t = await now();
      const deadline = t + 600;
      const ah = await twin.computeSetOwnerHash(aliceEOA.address, n, deadline);
      await twin.setOwnerEOA(aliceEOA.address, n, deadline, t, ethers.toUtf8Bytes(mint(ALICE, t, ah)));

      await ethers.provider.send("evm_increaseTime", [RESCUE_DELAY + 1]);
      await ethers.provider.send("evm_mine", []);
      await expect(twin.connect(rescuer).completeRescue(mallory.address))
        .to.be.revertedWithCustomError(twin, "AlreadyActivated");
    });

    it("cannot even initiate on a twin already activated via JWT", async () => {
      const twin = await twinFor(ALICE);
      await deployer.sendTransaction({ to: await twin.getAddress(), value: ethers.parseEther("1") });
      const n = await twin.nonce();
      const t = await now();
      const deadline = t + 600;
      const ah = await twin.computeActionHash(recipient.address, 0n, "0x", n, deadline);
      await twin.execute(recipient.address, 0n, "0x", n, deadline, t, ethers.toUtf8Bytes(mint(ALICE, t, ah)));
      await expect(twin.connect(rescuer).initiateRescue())
        .to.be.revertedWithCustomError(twin, "AlreadyActivated");
    });

    it("only the factory's rescuer can initiate or complete", async () => {
      const twin = await twinFor(ALICE);
      await expect(twin.connect(mallory).initiateRescue())
        .to.be.revertedWithCustomError(twin, "NotRescuer");
      await twin.connect(rescuer).initiateRescue();
      await ethers.provider.send("evm_increaseTime", [RESCUE_DELAY + 1]);
      await ethers.provider.send("evm_mine", []);
      await expect(twin.connect(mallory).completeRescue(mallory.address))
        .to.be.revertedWithCustomError(twin, "NotRescuer");
    });

    it("the real owner can still reclaim via JWT after a rescue (Twitch alive)", async () => {
      const twin = await twinFor(ALICE);
      await deployer.sendTransaction({ to: await twin.getAddress(), value: ethers.parseEther("1") });
      await twin.connect(rescuer).initiateRescue();
      await ethers.provider.send("evm_increaseTime", [RESCUE_DELAY + 1]);
      await ethers.provider.send("evm_mine", []);
      await twin.connect(rescuer).completeRescue(communityEOA.address);
      // A rescue does NOT trigger self-custody, so the JWT path stays open for
      // the real streamer to reclaim.
      expect(await twin.selfCustody()).to.equal(false);

      // Alice finally appears with a valid JWT and re-points the owner EOA to herself.
      const n = await twin.nonce();
      const t = await now();
      const deadline = t + 600;
      const ah = await twin.computeSetOwnerHash(aliceEOA.address, n, deadline);
      await twin.setOwnerEOA(aliceEOA.address, n, deadline, t, ethers.toUtf8Bytes(mint(ALICE, t, ah)));
      expect(await twin.ownerEOA()).to.equal(aliceEOA.address);
    });

    it("rescuer can be transferred to a DAO/multisig, but never to zero", async () => {
      await expect(factory.connect(rescuer).transferRescuer(newEOA.address))
        .to.emit(factory, "RescuerTransferred");
      expect(await factory.rescuer()).to.equal(newEOA.address);
      await expect(
        factory.connect(rescuer).transferRescuer(mallory.address)
      ).to.be.revertedWithCustomError(factory, "NotRescuer");
      await expect(
        factory.connect(newEOA).transferRescuer(ethers.ZeroAddress)
      ).to.be.revertedWith("rescuer cannot be zero");
    });

    it("pre-deploy timing attack neutralized: clock runs from intent, not deploy", async () => {
      // Anyone can pre-deploy a victim's twin a long time ago...
      const twin = await twinFor(ALICE);
      await ethers.provider.send("evm_increaseTime", [365 * 24 * 60 * 60]); // a year passes
      await ethers.provider.send("evm_mine", []);
      // ...funds arrive only now...
      await deployer.sendTransaction({ to: await twin.getAddress(), value: ethers.parseEther("5") });
      // ...the rescuer still owes a fresh full RESCUE_DELAY window.
      expect(await twin.isRescuable()).to.equal(false);
      await twin.connect(rescuer).initiateRescue();
      await expect(twin.connect(rescuer).completeRescue(communityEOA.address))
        .to.be.revertedWithCustomError(twin, "RescueTooEarly");
    });
  });
});
