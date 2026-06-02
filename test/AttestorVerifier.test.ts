import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { AttestorVerifier, TwinAccount, TwinFactory } from "../typechain-types";

const ALICE = 12345n;
const BOB = 67890n;

async function signAttestation(
  attestor: HardhatEthersSigner,
  verifier: AttestorVerifier,
  userId: bigint,
  actionHash: string,
  epoch: bigint
): Promise<string> {
  const digest = await verifier.computeDigest(userId, actionHash, epoch);
  return attestor.signMessage(ethers.getBytes(digest));
}

describe("AttestorVerifier", () => {
  let verifier: AttestorVerifier;
  let factory: TwinFactory;
  let attestor: HardhatEthersSigner;
  let attestor2: HardhatEthersSigner;
  let deployer: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let mallory: HardhatEthersSigner;
  let recipient: HardhatEthersSigner;
  let randomSubmitter: HardhatEthersSigner;

  beforeEach(async () => {
    [deployer, attestor, attestor2, alice, mallory, recipient, randomSubmitter] = await ethers.getSigners();
    const V = await ethers.getContractFactory("AttestorVerifier");
    verifier = await V.deploy([attestor.address]);
    await verifier.waitForDeployment();

    const F = await ethers.getContractFactory("TwinFactory");
    factory = await F.deploy(await verifier.getAddress(), deployer.address);
    await factory.waitForDeployment();
  });

  async function aliceTwin(): Promise<TwinAccount> {
    await factory.deployTwin(ALICE);
    return ethers.getContractAt("TwinAccount", await factory.predictAddress(ALICE));
  }

  // ─── Constructor validation ─────────────────────────────────────────
  describe("constructor", () => {
    it("rejects empty attestor list", async () => {
      const V = await ethers.getContractFactory("AttestorVerifier");
      await expect(V.deploy([])).to.be.revertedWithCustomError(V, "NoAttestors");
    });
    it("rejects zero address", async () => {
      const V = await ethers.getContractFactory("AttestorVerifier");
      await expect(V.deploy([ethers.ZeroAddress])).to.be.revertedWithCustomError(V, "ZeroAddress");
    });
    it("rejects duplicates", async () => {
      const V = await ethers.getContractFactory("AttestorVerifier");
      await expect(V.deploy([attestor.address, attestor.address])).to.be.revertedWithCustomError(V, "DuplicateAttestor");
    });
    it("accepts multiple distinct attestors", async () => {
      const V = await ethers.getContractFactory("AttestorVerifier");
      const v = await V.deploy([attestor.address, attestor2.address]);
      expect(await v.attestorCount()).to.equal(2);
      expect(await v.isApproved(attestor.address)).to.equal(true);
      expect(await v.isApproved(attestor2.address)).to.equal(true);
    });
  });

  // ─── verify() ───────────────────────────────────────────────────────
  describe("verify()", () => {
    it("accepts a signature from the approved attestor", async () => {
      const actionHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      const block = await ethers.provider.getBlock("latest");
      const epoch = BigInt(block!.timestamp);
      const sig = await signAttestation(attestor, verifier, ALICE, actionHash, epoch);
      expect(await verifier.verify(ALICE, actionHash, epoch, sig)).to.equal(true);
    });

    it("rejects a signature from a non-approved signer", async () => {
      const actionHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      const block = await ethers.provider.getBlock("latest");
      const epoch = BigInt(block!.timestamp);
      const sig = await signAttestation(mallory, verifier, ALICE, actionHash, epoch);
      await expect(verifier.verify(ALICE, actionHash, epoch, sig))
        .to.be.revertedWithCustomError(verifier, "UnapprovedSigner");
    });

    it("rejects mutated userId", async () => {
      const actionHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      const block = await ethers.provider.getBlock("latest");
      const epoch = BigInt(block!.timestamp);
      const sig = await signAttestation(attestor, verifier, ALICE, actionHash, epoch);
      // Same signature, different userId arg → digest changes, recovered != attestor.
      await expect(verifier.verify(BOB, actionHash, epoch, sig))
        .to.be.revertedWithCustomError(verifier, "UnapprovedSigner");
    });

    it("rejects mutated actionHash", async () => {
      const realHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      const otherHash = ethers.keccak256(ethers.toUtf8Bytes("other"));
      const block = await ethers.provider.getBlock("latest");
      const epoch = BigInt(block!.timestamp);
      const sig = await signAttestation(attestor, verifier, ALICE, realHash, epoch);
      await expect(verifier.verify(ALICE, otherHash, epoch, sig))
        .to.be.revertedWithCustomError(verifier, "UnapprovedSigner");
    });

    it("rejects mutated epoch", async () => {
      const actionHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      const block = await ethers.provider.getBlock("latest");
      const epoch = BigInt(block!.timestamp);
      const sig = await signAttestation(attestor, verifier, ALICE, actionHash, epoch);
      await expect(verifier.verify(ALICE, actionHash, epoch + 1n, sig))
        .to.be.revertedWithCustomError(verifier, "UnapprovedSigner");
    });

    it("rejects bad signature length", async () => {
      await expect(verifier.verify(ALICE, ethers.ZeroHash, 0n, "0x1234"))
        .to.be.revertedWithCustomError(verifier, "BadSignatureLength");
    });

    it("rejects signature replay on a different chainid (defended by chainid in digest)", async () => {
      // The digest includes block.chainid via the contract. On a forked chain
      // with a different chainid, the same signature would produce a different
      // recovered signer (since the signed digest's chainid was the original).
      // We simulate by signing a digest with a hand-altered chainid.
      const actionHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      const block = await ethers.provider.getBlock("latest");
      const epoch = BigInt(block!.timestamp);

      // Hand-craft a digest with a wrong chainid (simulating cross-chain replay attempt)
      const wrongDigest = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "uint256", "address", "uint64", "bytes32", "uint256"],
          [
            "SocialTwin:AttestorVerifier:v1",
            999999n, // wrong chainid
            await verifier.getAddress(),
            ALICE,
            actionHash,
            epoch,
          ]
        )
      );
      const sig = await attestor.signMessage(ethers.getBytes(wrongDigest));
      await expect(verifier.verify(ALICE, actionHash, epoch, sig))
        .to.be.revertedWithCustomError(verifier, "UnapprovedSigner");
    });
  });

  // ─── End-to-end with TwinFactory + TwinAccount ──────────────────────
  describe("end-to-end with twin contracts", () => {
    it("execute() succeeds with an attestor-signed proof", async () => {
      const twin = await aliceTwin();
      await deployer.sendTransaction({ to: await twin.getAddress(), value: ethers.parseEther("1") });

      const target = recipient.address;
      const value = ethers.parseEther("0.1");
      const data = "0x";
      const nonce = await twin.nonce();
      const block = await ethers.provider.getBlock("latest");
      const now = BigInt(block!.timestamp);
      const deadline = now + 600n;
      const actionHash = await twin.computeActionHash(target, value, data, nonce, deadline);
      const sig = await signAttestation(attestor, verifier, ALICE, actionHash, now);

      const before = await ethers.provider.getBalance(target);
      await twin.connect(randomSubmitter).execute(target, value, data, nonce, deadline, now, sig);
      expect(await ethers.provider.getBalance(target) - before).to.equal(value);
      expect(await twin.nonce()).to.equal(nonce + 1n);
    });

    it("execute() rejects when attestor signs for a different user_id (cross-user)", async () => {
      await factory.deployTwin(ALICE);
      await factory.deployTwin(BOB);
      const bobAddr = await factory.predictAddress(BOB);
      const bobTwin = await ethers.getContractAt("TwinAccount", bobAddr);
      await deployer.sendTransaction({ to: bobAddr, value: ethers.parseEther("0.1") });

      const target = recipient.address;
      const nonce = await bobTwin.nonce();
      const block = await ethers.provider.getBlock("latest");
      const now = BigInt(block!.timestamp);
      const deadline = now + 600n;
      const actionHash = await bobTwin.computeActionHash(target, 0n, "0x", nonce, deadline);
      // Attestor signs for ALICE's userId, not BOB's. Twin.userId == BOB.
      const sig = await signAttestation(attestor, verifier, ALICE, actionHash, now);
      await expect(
        bobTwin.execute(target, 0n, "0x", nonce, deadline, now, sig)
      ).to.be.reverted;
    });
  });

  // ─── Federation ─────────────────────────────────────────────────────
  describe("federation (1-of-N)", () => {
    it("accepts signatures from any approved attestor", async () => {
      const V = await ethers.getContractFactory("AttestorVerifier");
      const fed = await V.deploy([attestor.address, attestor2.address]);
      const actionHash = ethers.keccak256(ethers.toUtf8Bytes("federated"));
      const block = await ethers.provider.getBlock("latest");
      const epoch = BigInt(block!.timestamp);

      const sigA = await signAttestation(attestor, fed, ALICE, actionHash, epoch);
      const sigB = await signAttestation(attestor2, fed, ALICE, actionHash, epoch);

      expect(await fed.verify(ALICE, actionHash, epoch, sigA)).to.equal(true);
      expect(await fed.verify(ALICE, actionHash, epoch, sigB)).to.equal(true);
    });
  });
});
