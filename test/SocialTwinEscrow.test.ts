import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { MockVerifier, SocialTwinEscrow } from "../typechain-types";

const ALICE_ID = 12345n;
const BOB_ID = 67890n;

async function signClaim(
  attestor: HardhatEthersSigner,
  userId: bigint,
  actionHash: string,
  oauthExchangeEpoch: bigint
): Promise<string> {
  const digest = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "uint64", "bytes32", "uint256"],
      ["MockVerifier:v2:freshOAuth", userId, actionHash, oauthExchangeEpoch]
    )
  );
  return attestor.signMessage(ethers.getBytes(digest));
}

async function buildClaim(
  escrow: SocialTwinEscrow,
  attestor: HardhatEthersSigner,
  depositIds: bigint[],
  userId: bigint,
  destination: string,
  opts: { deadline?: bigint; epoch?: bigint } = {}
) {
  const block = await ethers.provider.getBlock("latest");
  const now = BigInt(block!.timestamp);
  const deadline = opts.deadline ?? now + 600n;
  const epoch = opts.epoch ?? now;
  const actionHash = await escrow.computeClaimHash(depositIds, userId, destination, deadline);
  const proof = await signClaim(attestor, userId, actionHash, epoch);
  return { deadline, epoch, proof, actionHash };
}

describe("SocialTwinEscrow", () => {
  let escrow: SocialTwinEscrow;
  let verifier: MockVerifier;
  let attestor: HardhatEthersSigner;
  let deployer: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let charlie: HardhatEthersSigner;
  let mallory: HardhatEthersSigner;

  beforeEach(async () => {
    [deployer, attestor, alice, bob, charlie, mallory] = await ethers.getSigners();

    const MockVerifier = await ethers.getContractFactory("MockVerifier");
    verifier = await MockVerifier.deploy(attestor.address);
    await verifier.waitForDeployment();

    const Escrow = await ethers.getContractFactory("SocialTwinEscrow");
    escrow = await Escrow.deploy(await verifier.getAddress());
    await escrow.waitForDeployment();
  });

  // ============================================================
  // Happy paths
  // ============================================================
  describe("Deposit + claim happy path", () => {
    it("anyone can deposit ETH for any userId", async () => {
      await expect(
        escrow.connect(charlie).depositETH(ALICE_ID, 0, { value: ethers.parseEther("1") })
      ).to.emit(escrow, "Deposited");
      const d = await escrow.deposits(1);
      expect(d.userId).to.equal(ALICE_ID);
      expect(d.sender).to.equal(charlie.address);
      expect(d.amount).to.equal(ethers.parseEther("1"));
    });

    it("alice claims her ETH deposit to her own address", async () => {
      await escrow.connect(charlie).depositETH(ALICE_ID, 0, { value: ethers.parseEther("1") });
      const args = await buildClaim(escrow, attestor, [1n], ALICE_ID, alice.address);
      const balBefore = await ethers.provider.getBalance(alice.address);
      const tx = await escrow.connect(alice).claim([1n], ALICE_ID, args.deadline, args.epoch, args.proof);
      const r = await tx.wait();
      const gas = r!.gasUsed * r!.gasPrice;
      const balAfter = await ethers.provider.getBalance(alice.address);
      expect(balAfter - balBefore + gas).to.equal(ethers.parseEther("1"));
    });

    it("alice batch-claims multiple ETH deposits in one tx", async () => {
      await escrow.connect(charlie).depositETH(ALICE_ID, 0, { value: ethers.parseEther("1") });
      await escrow.connect(bob).depositETH(ALICE_ID, 0, { value: ethers.parseEther("2") });
      const args = await buildClaim(escrow, attestor, [1n, 2n], ALICE_ID, alice.address);
      await escrow.connect(alice).claim([1n, 2n], ALICE_ID, args.deadline, args.epoch, args.proof);
      const balDelta = (await ethers.provider.getBalance(await escrow.getAddress()));
      expect(balDelta).to.equal(0n);
    });

    it("supports ERC20 deposit + claim", async () => {
      const Token = await ethers.getContractFactory("MockERC20");
      const token = await Token.deploy("Mock", "MOCK", ethers.parseEther("1000"));
      await token.waitForDeployment();
      await token.connect(deployer).transfer(charlie.address, ethers.parseEther("100"));
      await token.connect(charlie).approve(await escrow.getAddress(), ethers.parseEther("50"));
      await escrow.connect(charlie).depositERC20(ALICE_ID, await token.getAddress(), ethers.parseEther("50"), 0);

      const args = await buildClaim(escrow, attestor, [1n], ALICE_ID, alice.address);
      await escrow.connect(alice).claim([1n], ALICE_ID, args.deadline, args.epoch, args.proof);
      expect(await token.balanceOf(alice.address)).to.equal(ethers.parseEther("50"));
    });
  });

  // ============================================================
  // Property P1: Cross-user fund isolation
  // ============================================================
  describe("P1: cross-user fund isolation", () => {
    it("Bob (proven via Bob's user_id) cannot claim Alice's deposit", async () => {
      await escrow.connect(charlie).depositETH(ALICE_ID, 0, { value: ethers.parseEther("1") });
      const args = await buildClaim(escrow, attestor, [1n], BOB_ID, bob.address);
      await expect(
        escrow.connect(bob).claim([1n], BOB_ID, args.deadline, args.epoch, args.proof)
      ).to.be.revertedWithCustomError(escrow, "UserIdMismatch");
    });

    it("an attacker with a valid proof for their own user_id cannot redirect Alice's funds", async () => {
      await escrow.connect(charlie).depositETH(ALICE_ID, 0, { value: ethers.parseEther("1") });
      // Mallory has a proof for HER user_id (say, 99999) but tries to claim Alice's deposit
      const MALLORY_ID = 99999n;
      const args = await buildClaim(escrow, attestor, [1n], MALLORY_ID, mallory.address);
      await expect(
        escrow.connect(mallory).claim([1n], MALLORY_ID, args.deadline, args.epoch, args.proof)
      ).to.be.revertedWithCustomError(escrow, "UserIdMismatch");
    });

    it("a batch with mixed user_ids reverts atomically (no partial claim)", async () => {
      await escrow.connect(charlie).depositETH(ALICE_ID, 0, { value: ethers.parseEther("1") });
      await escrow.connect(charlie).depositETH(BOB_ID, 0, { value: ethers.parseEther("1") });
      const args = await buildClaim(escrow, attestor, [1n, 2n], ALICE_ID, alice.address);
      await expect(
        escrow.connect(alice).claim([1n, 2n], ALICE_ID, args.deadline, args.epoch, args.proof)
      ).to.be.revertedWithCustomError(escrow, "UserIdMismatch");
      // First deposit not consumed
      expect((await escrow.deposits(1)).status).to.equal(0); // ACTIVE
    });
  });

  // ============================================================
  // Property P2: No persistent per-user state to race for
  // ============================================================
  describe("P2: no account race — there is no account", () => {
    it("the contract has no per-userId mutable state slot", async () => {
      // There is no setOwner / registerKey / claim-once function. The only
      // userId-tagged storage lives inside per-deposit structs, which are
      // independently created by deposit() and consumed by claim()/refund().
      // We verify this by introspection: ensure no `userOwner(uint64)` style
      // function exists.
      const fragment = escrow.interface.fragments.find(
        (f) => f.type === "function" && (f as any).name?.toLowerCase().includes("owner")
      );
      expect(fragment, "no per-user ownership function should exist").to.be.undefined;
    });

    it("even if a deposit gets phish-claimed via a one-off fresh OAuth, future deposits stay claimable by the real user", async () => {
      // Worst-case context: Mallory pulls off a one-time OAuth phishing flow
      // against Alice (Alice clicked Authorize on a malicious consent screen),
      // producing a single fresh OAuth proof. Mallory claims deposit #1.
      //
      // The contract has NO per-userId mutable state that gets populated by
      // this — no owner registration, no key binding. So deposit #2, arriving
      // later, is still fully claimable by Alice with a fresh OAuth of her
      // own. The attack does not cascade.
      await escrow.connect(charlie).depositETH(ALICE_ID, 0, { value: ethers.parseEther("1") });
      const malloryArgs = await buildClaim(escrow, attestor, [1n], ALICE_ID, mallory.address);
      await escrow.connect(mallory).claim([1n], ALICE_ID, malloryArgs.deadline, malloryArgs.epoch, malloryArgs.proof);

      await escrow.connect(bob).depositETH(ALICE_ID, 0, { value: ethers.parseEther("2") });
      const aliceArgs = await buildClaim(escrow, attestor, [2n], ALICE_ID, alice.address);
      await expect(
        escrow.connect(alice).claim([2n], ALICE_ID, aliceArgs.deadline, aliceArgs.epoch, aliceArgs.proof)
      ).to.emit(escrow, "Claimed");
      expect((await escrow.deposits(2)).status).to.equal(1); // CLAIMED
    });
  });

  // ============================================================
  // Property P3: Claim requires a valid ZK proof
  // ============================================================
  describe("P3: claim requires a valid ZK proof", () => {
    it("rejects an unsigned (empty) proof", async () => {
      await escrow.connect(charlie).depositETH(ALICE_ID, 0, { value: ethers.parseEther("1") });
      const block = await ethers.provider.getBlock("latest");
      const deadline = BigInt(block!.timestamp) + 600n;
      const epoch = BigInt(block!.timestamp);
      await expect(
        escrow
          .connect(alice)
          .claim([1n], ALICE_ID, deadline, epoch, "0x" + "00".repeat(65))
      ).to.be.reverted;
    });

    it("rejects a proof signed by the wrong attestor", async () => {
      await escrow.connect(charlie).depositETH(ALICE_ID, 0, { value: ethers.parseEther("1") });
      // Sign with `mallory` (not the attestor)
      const block = await ethers.provider.getBlock("latest");
      const deadline = BigInt(block!.timestamp) + 600n;
      const epoch = BigInt(block!.timestamp);
      const actionHash = await escrow.computeClaimHash([1n], ALICE_ID, alice.address, deadline);
      const fakeProof = await signClaim(mallory, ALICE_ID, actionHash, epoch);
      await expect(
        escrow.connect(alice).claim([1n], ALICE_ID, deadline, epoch, fakeProof)
      ).to.be.revertedWithCustomError(escrow, "InvalidProof");
    });
  });

  // ============================================================
  // Property P4: Destination binding — cannot redirect mid-claim
  // ============================================================
  describe("P4: destination binding", () => {
    it("a proof bound to Alice cannot be used by a relayer to redirect to themselves", async () => {
      await escrow.connect(charlie).depositETH(ALICE_ID, 0, { value: ethers.parseEther("1") });
      const args = await buildClaim(escrow, attestor, [1n], ALICE_ID, alice.address);
      // Submit from a different account — msg.sender becomes a different destination, action_hash doesn't match.
      await expect(
        escrow.connect(mallory).claim([1n], ALICE_ID, args.deadline, args.epoch, args.proof)
      ).to.be.revertedWithCustomError(escrow, "InvalidProof");
    });

    it("changing depositIds invalidates the proof", async () => {
      await escrow.connect(charlie).depositETH(ALICE_ID, 0, { value: ethers.parseEther("1") });
      await escrow.connect(charlie).depositETH(ALICE_ID, 0, { value: ethers.parseEther("1") });
      const args = await buildClaim(escrow, attestor, [1n], ALICE_ID, alice.address);
      // Try to use the proof to claim deposit 2 instead.
      await expect(
        escrow.connect(alice).claim([2n], ALICE_ID, args.deadline, args.epoch, args.proof)
      ).to.be.revertedWithCustomError(escrow, "InvalidProof");
    });
  });

  // ============================================================
  // Property P5: Replay protection
  // ============================================================
  describe("P5: replay protection", () => {
    it("a claimed deposit cannot be claimed again", async () => {
      await escrow.connect(charlie).depositETH(ALICE_ID, 0, { value: ethers.parseEther("1") });
      const args = await buildClaim(escrow, attestor, [1n], ALICE_ID, alice.address);
      await escrow.connect(alice).claim([1n], ALICE_ID, args.deadline, args.epoch, args.proof);
      await expect(
        escrow.connect(alice).claim([1n], ALICE_ID, args.deadline, args.epoch, args.proof)
      ).to.be.revertedWithCustomError(escrow, "DepositNotActive");
    });

    it("rejects proofs after deadline", async () => {
      await escrow.connect(charlie).depositETH(ALICE_ID, 0, { value: ethers.parseEther("1") });
      const block = await ethers.provider.getBlock("latest");
      const pastDeadline = BigInt(block!.timestamp) - 1n;
      const epoch = BigInt(block!.timestamp);
      const actionHash = await escrow.computeClaimHash([1n], ALICE_ID, alice.address, pastDeadline);
      const proof = await signClaim(attestor, ALICE_ID, actionHash, epoch);
      await expect(
        escrow.connect(alice).claim([1n], ALICE_ID, pastDeadline, epoch, proof)
      ).to.be.revertedWithCustomError(escrow, "DeadlinePassed");
    });

    it("rejects stale oauthExchangeEpoch beyond MAX_PROOF_AGE", async () => {
      await escrow.connect(charlie).depositETH(ALICE_ID, 0, { value: ethers.parseEther("1") });
      const block = await ethers.provider.getBlock("latest");
      const deadline = BigInt(block!.timestamp) + 600n;
      const staleEpoch = BigInt(block!.timestamp) - 6n * 60n; // > 5 min
      const actionHash = await escrow.computeClaimHash([1n], ALICE_ID, alice.address, deadline);
      const proof = await signClaim(attestor, ALICE_ID, actionHash, staleEpoch);
      await expect(
        escrow.connect(alice).claim([1n], ALICE_ID, deadline, staleEpoch, proof)
      ).to.be.revertedWithCustomError(escrow, "ProofTooOld");
    });
  });

  // ============================================================
  // Property P11: Bearer-token replay defense
  // ============================================================
  describe("P11: bearer-token replay defense (no draining without fresh OAuth)", () => {
    it("rejects a proof whose OAuth exchange happened more than MAX_PROOF_AGE ago", async () => {
      // Scenario: a malicious app holds Alice's OAuth token, captured weeks ago
      // from a different app where Alice signed in. The attacker can call
      // /2/users/me indefinitely with that token, but to produce a VALID proof
      // they need a fresh /2/oauth2/token exchange — which requires a fresh
      // `code` from Twitter, which requires Alice to click "Authorize" in a
      // top-level browser navigation in the last few minutes.
      //
      // Simulating: the witness signs over an oauthExchangeEpoch that is older
      // than MAX_PROOF_AGE. The contract rejects.
      await escrow.connect(charlie).depositETH(ALICE_ID, 0, { value: ethers.parseEther("5") });
      const block = await ethers.provider.getBlock("latest");
      const deadline = BigInt(block!.timestamp) + 600n;
      const ancientEpoch = BigInt(block!.timestamp) - 60n * 60n * 24n * 7n; // 1 week old
      const actionHash = await escrow.computeClaimHash([1n], ALICE_ID, mallory.address, deadline);
      const proof = await signClaim(attestor, ALICE_ID, actionHash, ancientEpoch);
      await expect(
        escrow.connect(mallory).claim([1n], ALICE_ID, deadline, ancientEpoch, proof)
      ).to.be.revertedWithCustomError(escrow, "ProofTooOld");
    });

    it("a fresh OAuth proof for Alice cannot be reused after MAX_PROOF_AGE expires", async () => {
      // Even if the attacker captures a freshly-minted proof from Alice's
      // claim transaction in the mempool, they cannot replay it later: the
      // proof's oauthExchangeEpoch ages out.
      await escrow.connect(charlie).depositETH(ALICE_ID, 0, { value: ethers.parseEther("1") });
      await escrow.connect(charlie).depositETH(ALICE_ID, 0, { value: ethers.parseEther("1") });
      const initial = await ethers.provider.getBlock("latest");
      const epoch = BigInt(initial!.timestamp);
      // Alice claims deposit 1 fresh
      const aliceArgs = await buildClaim(escrow, attestor, [1n], ALICE_ID, alice.address, { epoch });
      await escrow.connect(alice).claim([1n], ALICE_ID, aliceArgs.deadline, epoch, aliceArgs.proof);
      // Time passes (> MAX_PROOF_AGE = 5min)
      await ethers.provider.send("evm_increaseTime", [10 * 60]);
      await ethers.provider.send("evm_mine", []);
      // Attacker tries to claim deposit 2 with a proof using the same stale epoch
      const malloryArgs = await buildClaim(escrow, attestor, [2n], ALICE_ID, mallory.address, { epoch });
      await expect(
        escrow.connect(mallory).claim([2n], ALICE_ID, malloryArgs.deadline, epoch, malloryArgs.proof)
      ).to.be.revertedWithCustomError(escrow, "ProofTooOld");
    });
  });

  // ============================================================
  // Property P7: Refund safety
  // ============================================================
  describe("P7: refund safety", () => {
    it("only the original sender can refund", async () => {
      const block = await ethers.provider.getBlock("latest");
      const expiry = BigInt(block!.timestamp) + 2n * 24n * 60n * 60n;
      await escrow
        .connect(charlie)
        .depositETH(ALICE_ID, expiry, { value: ethers.parseEther("1") });
      await ethers.provider.send("evm_increaseTime", [3 * 24 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);
      await expect(escrow.connect(mallory).refund(1)).to.be.revertedWithCustomError(escrow, "NotSender");
      await expect(escrow.connect(charlie).refund(1)).to.emit(escrow, "Refunded");
    });

    it("cannot refund before expiry", async () => {
      const block = await ethers.provider.getBlock("latest");
      const expiry = BigInt(block!.timestamp) + 2n * 24n * 60n * 60n;
      await escrow
        .connect(charlie)
        .depositETH(ALICE_ID, expiry, { value: ethers.parseEther("1") });
      await expect(escrow.connect(charlie).refund(1)).to.be.revertedWithCustomError(escrow, "NotYetExpired");
    });

    it("permanent deposits (expiry=0) cannot be refunded ever", async () => {
      await escrow.connect(charlie).depositETH(ALICE_ID, 0, { value: ethers.parseEther("1") });
      await ethers.provider.send("evm_increaseTime", [3650 * 24 * 60 * 60]); // 10 years
      await ethers.provider.send("evm_mine", []);
      await expect(escrow.connect(charlie).refund(1)).to.be.revertedWithCustomError(escrow, "NotYetExpired");
    });

    it("cannot refund a claimed deposit", async () => {
      const block = await ethers.provider.getBlock("latest");
      const expiry = BigInt(block!.timestamp) + 2n * 24n * 60n * 60n;
      await escrow
        .connect(charlie)
        .depositETH(ALICE_ID, expiry, { value: ethers.parseEther("1") });
      const args = await buildClaim(escrow, attestor, [1n], ALICE_ID, alice.address);
      await escrow.connect(alice).claim([1n], ALICE_ID, args.deadline, args.epoch, args.proof);
      await ethers.provider.send("evm_increaseTime", [3 * 24 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);
      await expect(escrow.connect(charlie).refund(1)).to.be.revertedWithCustomError(escrow, "DepositNotActive");
    });

    it("rejects depositETH with expiry shorter than MIN_REFUND_DELAY", async () => {
      const block = await ethers.provider.getBlock("latest");
      const tooSoon = BigInt(block!.timestamp) + 60n; // 1 minute
      await expect(
        escrow.connect(charlie).depositETH(ALICE_ID, tooSoon, { value: ethers.parseEther("1") })
      ).to.be.revertedWithCustomError(escrow, "ExpiryTooSoon");
    });

    it("cannot claim an expired deposit", async () => {
      const block = await ethers.provider.getBlock("latest");
      const expiry = BigInt(block!.timestamp) + 2n * 24n * 60n * 60n;
      await escrow
        .connect(charlie)
        .depositETH(ALICE_ID, expiry, { value: ethers.parseEther("1") });
      await ethers.provider.send("evm_increaseTime", [3 * 24 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);
      const args = await buildClaim(escrow, attestor, [1n], ALICE_ID, alice.address);
      await expect(
        escrow.connect(alice).claim([1n], ALICE_ID, args.deadline, args.epoch, args.proof)
      ).to.be.revertedWithCustomError(escrow, "AlreadyExpired");
    });
  });

  // ============================================================
  // Property P9: No admin
  // ============================================================
  describe("P9: no admin / no upgrade", () => {
    it("contract exposes no owner / admin / upgrade entrypoints", async () => {
      const dangerous = ["owner", "transferOwnership", "upgradeTo", "upgradeToAndCall", "pause", "unpause", "setVerifier"];
      for (const name of dangerous) {
        const f = escrow.interface.fragments.find((x: any) => x.name === name);
        expect(f, `${name} must not exist`).to.be.undefined;
      }
    });
  });

  // ============================================================
  // Reject zero-amount deposits
  // ============================================================
  describe("Misc input validation", () => {
    it("depositETH with 0 value reverts", async () => {
      await expect(escrow.connect(charlie).depositETH(ALICE_ID, 0)).to.be.revertedWithCustomError(escrow, "ZeroAmount");
    });
  });
});
