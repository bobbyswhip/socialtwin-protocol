import { expect } from "chai";
import { ethers } from "hardhat";
import { generateKeyPairSync, KeyObject, createHmac } from "crypto";
import jwt from "jsonwebtoken";
import { TwinAccount, TwinFactory, TwitchJWTVerifier } from "../typechain-types";

// ════════════════════════════════════════════════════════════════════════
// RED TEAM — every attack we could think of against the deployed contract
// bytecode. The "Twitch" key here is a test key WE control, which is the
// strongest possible attacker assumption short of holding Twitch's real key:
// it lets us forge "validly signed" tokens and probe binding/parsing. Every
// test asserts the attack FAILS.
// ════════════════════════════════════════════════════════════════════════

const ISSUER = "https://id.twitch.tv/oauth2";
const KID = "1";
const ALICE = 1507305235n; // yougotcoined
const BOB = 99887766n;

function modHex(k: KeyObject) {
  const j = k.export({ format: "jwk" }) as any;
  const n = j.n as string;
  const p = n + "=".repeat((4 - (n.length % 4)) % 4);
  return "0x" + Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("hex");
}
const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("RED TEAM", () => {
  let factory: TwinFactory, verifier: TwitchJWTVerifier;
  let twitchKey: KeyObject;      // the legit signing key (test stand-in for Twitch)
  let attackerKey: KeyObject;    // an attacker's own RSA key
  let deployer: any, relayer: any, attacker: any, aliceEOA: any, dest: any, rescuer: any;

  beforeEach(async () => {
    [deployer, relayer, attacker, aliceEOA, dest, rescuer] = await ethers.getSigners();
    twitchKey = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 }).privateKey
      .export({ type: "pkcs1", format: "pem" }) as any;
    const kp = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 });
    const kpPriv = kp.privateKey; const kpPub = kp.publicKey;
    // store the actual KeyObjects
    (twitchKey as any) = kp.privateKey; // legit key
    attackerKey = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 }).privateKey;

    const V = await ethers.getContractFactory("TwitchJWTVerifier");
    verifier = await V.deploy([KID], [modHex(kpPub)], ["a"], deployer.address);
    const F = await ethers.getContractFactory("TwinFactory");
    factory = await F.deploy(await verifier.getAddress(), rescuer.address);
  });

  async function twinFor(uid: bigint): Promise<TwinAccount> {
    await factory.deployTwin(uid);
    return ethers.getContractAt("TwinAccount", await factory.predictAddress(uid));
  }
  async function now(): Promise<number> {
    return Number((await ethers.provider.getBlock("latest"))!.timestamp);
  }
  function sign(key: KeyObject, payload: object, header: object = { alg: "RS256", typ: "JWT", kid: KID }) {
    return jwt.sign(payload, key.export({ type: "pkcs1", format: "pem" }) as string, { algorithm: "RS256", header } as any);
  }
  // build a withdraw JWT bound to a twin's current action_hash
  async function withdrawJwt(twin: TwinAccount, signWith: KeyObject, sub: bigint, opts: { iat?: number } = {}) {
    const n = await twin.nonce();
    const t = await now();
    const dl = BigInt(t + 600);
    const bal = await ethers.provider.getBalance(await twin.getAddress());
    const ah = await twin.computeActionHash(dest.address, bal, "0x", n, dl);
    const iat = opts.iat ?? t;
    const token = sign(signWith, { iss: ISSUER, sub: sub.toString(), aud: "a", iat, exp: iat + 3600, nonce: ah });
    return { token, n, dl, iat, bal, ah };
  }
  async function fund(twin: TwinAccount, eth = "0.01") {
    await deployer.sendTransaction({ to: await twin.getAddress(), value: ethers.parseEther(eth) });
  }

  // ── A. Signature forgery ────────────────────────────────────────────
  it("A1 rejects a token signed by an ATTACKER key", async () => {
    const twin = await twinFor(ALICE); await fund(twin);
    const { token, n, dl, iat, bal } = await withdrawJwt(twin, attackerKey, ALICE);
    await expect(twin.connect(relayer).execute(dest.address, bal, "0x", n, dl, iat, ethers.toUtf8Bytes(token)))
      .to.be.revertedWithCustomError(verifier, "BadSignature");
  });

  it("A2 rejects alg=none", async () => {
    const twin = await twinFor(ALICE); await fund(twin);
    const n = await twin.nonce(); const t = await now(); const dl = BigInt(t + 600);
    const bal = await ethers.provider.getBalance(await twin.getAddress());
    const ah = await twin.computeActionHash(dest.address, bal, "0x", n, dl);
    const header = b64url(JSON.stringify({ alg: "none", typ: "JWT", kid: KID }));
    const payload = b64url(JSON.stringify({ iss: ISSUER, sub: ALICE.toString(), iat: t, exp: t + 3600, nonce: ah }));
    const token = `${header}.${payload}.`;
    await expect(twin.connect(relayer).execute(dest.address, bal, "0x", n, dl, t, ethers.toUtf8Bytes(token)))
      .to.be.revertedWithCustomError(verifier, "WrongAlgorithm");
  });

  it("A3 rejects HS256 alg-confusion (sign with HMAC over the modulus)", async () => {
    const twin = await twinFor(ALICE); await fund(twin);
    const n = await twin.nonce(); const t = await now(); const dl = BigInt(t + 600);
    const bal = await ethers.provider.getBalance(await twin.getAddress());
    const ah = await twin.computeActionHash(dest.address, bal, "0x", n, dl);
    const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT", kid: KID }));
    const payload = b64url(JSON.stringify({ iss: ISSUER, sub: ALICE.toString(), iat: t, exp: t + 3600, nonce: ah }));
    const mac = b64url(createHmac("sha256", "anything").update(`${header}.${payload}`).digest());
    const token = `${header}.${payload}.${mac}`;
    await expect(twin.connect(relayer).execute(dest.address, bal, "0x", n, dl, t, ethers.toUtf8Bytes(token)))
      .to.be.revertedWithCustomError(verifier, "WrongAlgorithm");
  });

  it("A4 rejects a bit-flipped signature on an otherwise-valid token", async () => {
    const twin = await twinFor(ALICE); await fund(twin);
    const { token, n, dl, iat, bal } = await withdrawJwt(twin, twitchKey, ALICE);
    const parts = token.split("."); const sig = Buffer.from(parts[2].replace(/-/g, "+").replace(/_/g, "/"), "base64");
    sig[10] ^= 0xff; parts[2] = b64url(sig);
    await expect(twin.connect(relayer).execute(dest.address, bal, "0x", n, dl, iat, ethers.toUtf8Bytes(parts.join("."))))
      .to.be.reverted;
  });

  it("A5 rejects a tampered payload (sub changed after signing)", async () => {
    const twin = await twinFor(ALICE); await fund(twin);
    const { token, n, dl, iat, bal } = await withdrawJwt(twin, twitchKey, ALICE);
    const parts = token.split(".");
    const p = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    p.sub = BOB.toString(); parts[1] = b64url(JSON.stringify(p));
    await expect(twin.connect(relayer).execute(dest.address, bal, "0x", n, dl, iat, ethers.toUtf8Bytes(parts.join("."))))
      .to.be.reverted;
  });

  it("A6 rejects unknown kid", async () => {
    const twin = await twinFor(ALICE); await fund(twin);
    const n = await twin.nonce(); const t = await now(); const dl = BigInt(t + 600);
    const bal = await ethers.provider.getBalance(await twin.getAddress());
    const ah = await twin.computeActionHash(dest.address, bal, "0x", n, dl);
    const token = sign(twitchKey, { iss: ISSUER, sub: ALICE.toString(), iat: t, exp: t + 3600, nonce: ah }, { alg: "RS256", typ: "JWT", kid: "evil" });
    await expect(twin.connect(relayer).execute(dest.address, bal, "0x", n, dl, t, ethers.toUtf8Bytes(token)))
      .to.be.revertedWithCustomError(verifier, "UnknownKey");
  });

  // ── B. Claim spoofing / JSON robustness ─────────────────────────────
  it("B1 JSON-injection in preferred_username cannot spoof sub (escaping defeats it)", async () => {
    const twin = await twinFor(ALICE); await fund(twin);
    const n = await twin.nonce(); const t = await now(); const dl = BigInt(t + 600);
    const bal = await ethers.provider.getBalance(await twin.getAddress());
    const ah = await twin.computeActionHash(dest.address, bal, "0x", n, dl);
    // attacker-controlled-looking username that tries to inject a fake sub BEFORE the real one
    const evil = `x","sub":"${BOB}`;
    const token = sign(twitchKey, { iss: ISSUER, aud: "a", preferred_username: evil, sub: ALICE.toString(), iat: t, exp: t + 3600, nonce: ah });
    // The contract is told userId=ALICE (real). It must still verify against the REAL sub, not the injected BOB.
    // If the parser were fooled into reading BOB, calling with ALICE would revert WrongSub — so success here proves it read ALICE.
    await expect(twin.connect(relayer).execute(dest.address, bal, "0x", n, dl, t, ethers.toUtf8Bytes(token)))
      .to.emit(twin, "Executed");
  });

  it("B3 PHISHING: a JWT from a different OAuth app (wrong aud) is rejected", async () => {
    const twin = await twinFor(ALICE); await fund(twin);
    const n = await twin.nonce(); const t = await now(); const dl = BigInt(t + 600);
    const bal = await ethers.provider.getBalance(await twin.getAddress());
    const ah = await twin.computeActionHash(dest.address, bal, "0x", n, dl);
    // Attacker runs their OWN Twitch app → their client_id ends up in `aud`.
    // Even though it's validly signed by Twitch's key and has the right sub,
    // the verifier rejects it because the aud isn't allowlisted.
    const token = sign(twitchKey, { iss: ISSUER, aud: "attacker-phishing-app", sub: ALICE.toString(), iat: t, exp: t + 3600, nonce: ah });
    await expect(twin.connect(attacker).execute(dest.address, bal, "0x", n, dl, t, ethers.toUtf8Bytes(token)))
      .to.be.revertedWithCustomError(verifier, "WrongAudience");
  });

  it("B4 aud allowlist is curated (timelocked add): admin queues+commits an app; remove kills it", async () => {
    const twin = await twinFor(ALICE); await fund(twin, "0.03");
    // a second official app id, not in the initial allowlist (["a"]).
    // Adds are timelocked: queue → wait AUD_TIMELOCK → commit.
    await verifier.connect(deployer).queueAud("second-official-app");
    await ethers.provider.send("evm_increaseTime", [2 * 24 * 60 * 60 + 1]); // AUD_TIMELOCK
    await ethers.provider.send("evm_mine", []);
    await verifier.connect(deployer).commitAud("second-official-app");
    // token with the newly-approved aud verifies
    {
      const n = await twin.nonce(); const t = await now(); const dl = BigInt(t + 600);
      const bal = await ethers.provider.getBalance(await twin.getAddress());
      const ah = await twin.computeActionHash(dest.address, bal, "0x", n, dl);
      const token = sign(twitchKey, { iss: ISSUER, aud: "second-official-app", sub: ALICE.toString(), iat: t, exp: t + 3600, nonce: ah });
      await expect(twin.connect(relayer).execute(dest.address, bal, "0x", n, dl, t, ethers.toUtf8Bytes(token))).to.emit(twin, "Executed");
    }
    // remove it → tokens for it are rejected again
    await verifier.connect(deployer).removeAud("second-official-app");
    {
      await fund(twin, "0.01");
      const n = await twin.nonce(); const t = await now(); const dl = BigInt(t + 600);
      const bal = await ethers.provider.getBalance(await twin.getAddress());
      const ah = await twin.computeActionHash(dest.address, bal, "0x", n, dl);
      const token = sign(twitchKey, { iss: ISSUER, aud: "second-official-app", sub: ALICE.toString(), iat: t, exp: t + 3600, nonce: ah });
      await expect(twin.connect(relayer).execute(dest.address, bal, "0x", n, dl, t, ethers.toUtf8Bytes(token)))
        .to.be.revertedWithCustomError(verifier, "WrongAudience");
    }
    // non-admin cannot curate
    await expect(verifier.connect(attacker).queueAud("evil-app")).to.be.revertedWithCustomError(verifier, "NotAudAdmin");
  });

  it("B5 open mode: aud check OFF accepts any app; lockOpenForever is irreversible", async () => {
    const twin = await twinFor(ALICE); await fund(twin, "0.03");
    const mk = async () => {
      const n = await twin.nonce(); const t = await now(); const dl = BigInt(t + 600);
      const bal = await ethers.provider.getBalance(await twin.getAddress());
      const ah = await twin.computeActionHash(dest.address, bal, "0x", n, dl);
      const token = sign(twitchKey, { iss: ISSUER, aud: "some-random-app", sub: ALICE.toString(), iat: t, exp: t + 3600, nonce: ah });
      return { token, n, dl, t, bal };
    };
    let a = await mk();
    await expect(twin.connect(relayer).execute(dest.address, a.bal, "0x", a.n, a.dl, a.t, ethers.toUtf8Bytes(a.token)))
      .to.be.revertedWithCustomError(verifier, "WrongAudience");
    await verifier.connect(deployer).setAudCheckEnabled(false);
    a = await mk();
    await expect(twin.connect(relayer).execute(dest.address, a.bal, "0x", a.n, a.dl, a.t, ethers.toUtf8Bytes(a.token)))
      .to.emit(twin, "Executed");
    await verifier.connect(deployer).setAudCheckEnabled(true);
    expect(await verifier.audCheckEnabled()).to.equal(true);
    await verifier.connect(deployer).lockOpenForever();
    expect(await verifier.audCheckEnabled()).to.equal(false);
    expect(await verifier.audAdmin()).to.equal(ethers.ZeroAddress);
    await expect(verifier.connect(deployer).setAudCheckEnabled(true)).to.be.revertedWithCustomError(verifier, "NotAudAdmin");
  });

  it("B2 rejects wrong issuer", async () => {
    const twin = await twinFor(ALICE); await fund(twin);
    const n = await twin.nonce(); const t = await now(); const dl = BigInt(t + 600);
    const bal = await ethers.provider.getBalance(await twin.getAddress());
    const ah = await twin.computeActionHash(dest.address, bal, "0x", n, dl);
    const token = sign(twitchKey, { iss: "https://accounts.google.com", sub: ALICE.toString(), iat: t, exp: t + 3600, nonce: ah });
    await expect(twin.connect(relayer).execute(dest.address, bal, "0x", n, dl, t, ethers.toUtf8Bytes(token)))
      .to.be.revertedWithCustomError(verifier, "WrongIssuer");
  });

  // ── C. Replay / binding ─────────────────────────────────────────────
  it("C1 cannot replay a JWT after it's been used (nonce advanced)", async () => {
    const twin = await twinFor(ALICE); await fund(twin, "0.02");
    const { token, n, dl, iat, bal } = await withdrawJwt(twin, twitchKey, ALICE);
    await twin.connect(relayer).execute(dest.address, bal, "0x", n, dl, iat, ethers.toUtf8Bytes(token));
    // replay the exact same call
    await expect(twin.connect(attacker).execute(dest.address, bal, "0x", n, dl, iat, ethers.toUtf8Bytes(token)))
      .to.be.revertedWithCustomError(twin, "WrongNonce");
  });

  it("C2 cannot mutate target after JWT issued", async () => {
    const twin = await twinFor(ALICE); await fund(twin);
    const { token, n, dl, iat, bal } = await withdrawJwt(twin, twitchKey, ALICE);
    await expect(twin.connect(attacker).execute(attacker.address, bal, "0x", n, dl, iat, ethers.toUtf8Bytes(token)))
      .to.be.reverted; // action_hash mismatch → verifier WrongNonce
  });

  it("C3 cannot mutate value after JWT issued", async () => {
    const twin = await twinFor(ALICE); await fund(twin);
    const { token, n, dl, iat } = await withdrawJwt(twin, twitchKey, ALICE);
    await expect(twin.connect(attacker).execute(dest.address, 1n, "0x", n, dl, iat, ethers.toUtf8Bytes(token)))
      .to.be.reverted;
  });

  it("C4 cannot replay a twin-A JWT on twin-B (address bound)", async () => {
    const twinA = await twinFor(ALICE); await fund(twinA);
    const twinB = await twinFor(BOB); await fund(twinB);
    const { token, n, dl, iat, bal } = await withdrawJwt(twinA, twitchKey, ALICE);
    // try the A-bound token on B (also need B's userId to match — it won't; double failure)
    await expect(twinB.connect(attacker).execute(dest.address, bal, "0x", n, dl, iat, ethers.toUtf8Bytes(token)))
      .to.be.reverted;
  });

  it("C5 rejects stale iat (ProofTooOld)", async () => {
    const twin = await twinFor(ALICE); await fund(twin);
    const t = await now();
    const { token, n, dl, bal } = await withdrawJwt(twin, twitchKey, ALICE, { iat: t - 6 * 60 });
    await expect(twin.connect(relayer).execute(dest.address, bal, "0x", n, dl, t - 6 * 60, ethers.toUtf8Bytes(token)))
      .to.be.revertedWithCustomError(twin, "ProofTooOld");
  });

  it("C6 rejects future iat (ProofFromFuture)", async () => {
    const twin = await twinFor(ALICE); await fund(twin);
    const t = await now();
    const { token, n, dl, bal } = await withdrawJwt(twin, twitchKey, ALICE, { iat: t + 5 * 60 });
    await expect(twin.connect(relayer).execute(dest.address, bal, "0x", n, dl, t + 5 * 60, ethers.toUtf8Bytes(token)))
      .to.be.revertedWithCustomError(twin, "ProofFromFuture");
  });

  // ── D. Cross-user isolation ─────────────────────────────────────────
  it("D1 Bob's valid JWT cannot touch Alice's twin", async () => {
    const aliceTwin = await twinFor(ALICE); await fund(aliceTwin);
    const n = await aliceTwin.nonce(); const t = await now(); const dl = BigInt(t + 600);
    const bal = await ethers.provider.getBalance(await aliceTwin.getAddress());
    const ah = await aliceTwin.computeActionHash(dest.address, bal, "0x", n, dl);
    // Bob gets a perfectly valid Twitch JWT for HIS id, aimed at Alice's twin
    const token = sign(twitchKey, { iss: ISSUER, aud: "a", sub: BOB.toString(), iat: t, exp: t + 3600, nonce: ah });
    await expect(aliceTwin.connect(attacker).execute(dest.address, bal, "0x", n, dl, t, ethers.toUtf8Bytes(token)))
      .to.be.revertedWithCustomError(verifier, "WrongSub");
  });

  // ── E. Escape EOA / owner path ──────────────────────────────────────
  it("E1 non-owner cannot call executeAsOwner", async () => {
    const twin = await twinFor(ALICE); await fund(twin);
    // set owner = aliceEOA first
    const n = await twin.nonce(); const t = await now(); const dl = BigInt(t + 600);
    const ah = await twin.computeSetOwnerHash(aliceEOA.address, n, dl);
    await twin.connect(relayer).setOwnerEOA(aliceEOA.address, n, dl, t, ethers.toUtf8Bytes(sign(twitchKey, { iss: ISSUER, aud: "a", sub: ALICE.toString(), iat: t, exp: t + 3600, nonce: ah })));
    await expect(twin.connect(attacker).executeAsOwner(attacker.address, ethers.parseEther("0.01"), "0x"))
      .to.be.revertedWithCustomError(twin, "NotOwner");
  });

  it("E2 attacker cannot rotate the owner EOA", async () => {
    const twin = await twinFor(ALICE); await fund(twin);
    const n = await twin.nonce(); const t = await now(); const dl = BigInt(t + 600);
    const ah = await twin.computeSetOwnerHash(aliceEOA.address, n, dl);
    await twin.connect(relayer).setOwnerEOA(aliceEOA.address, n, dl, t, ethers.toUtf8Bytes(sign(twitchKey, { iss: ISSUER, aud: "a", sub: ALICE.toString(), iat: t, exp: t + 3600, nonce: ah })));
    await expect(twin.connect(attacker).rotateOwnerEOA(attacker.address)).to.be.revertedWithCustomError(twin, "NotOwner");
  });

  it("E3 self-custodied twin: a fully valid Twitch JWT can neither drain nor re-point it", async () => {
    const twin = await twinFor(ALICE); await fund(twin);
    // user takes self-custody
    let n = await twin.nonce(); let t = await now(); let dl = BigInt(t + 600);
    let ah = await twin.computeSetOwnerHash(aliceEOA.address, n, dl);
    await twin.connect(relayer).setOwnerEOA(aliceEOA.address, n, dl, t, ethers.toUtf8Bytes(sign(twitchKey, { iss: ISSUER, aud: "a", sub: ALICE.toString(), iat: t, exp: t + 3600, nonce: ah })));
    expect(await twin.selfCustody()).to.equal(true);

    // a perfectly valid JWT (right sub, right aud, fresh) cannot SPEND
    n = await twin.nonce(); t = await now(); dl = BigInt(t + 600);
    const bal = await ethers.provider.getBalance(await twin.getAddress());
    ah = await twin.computeActionHash(attacker.address, bal, "0x", n, dl);
    await expect(twin.connect(attacker).execute(attacker.address, bal, "0x", n, dl, t, ethers.toUtf8Bytes(sign(twitchKey, { iss: ISSUER, aud: "a", sub: ALICE.toString(), iat: t, exp: t + 3600, nonce: ah }))))
      .to.be.revertedWithCustomError(twin, "SelfCustodyEnabled");

    // ...nor HIJACK ownership by re-pointing the owner EOA
    ah = await twin.computeSetOwnerHash(attacker.address, n, dl);
    await expect(twin.connect(attacker).setOwnerEOA(attacker.address, n, dl, t, ethers.toUtf8Bytes(sign(twitchKey, { iss: ISSUER, aud: "a", sub: ALICE.toString(), iat: t, exp: t + 3600, nonce: ah }))))
      .to.be.revertedWithCustomError(twin, "SelfCustodyEnabled");
  });

  // ── F. Rescue (intent-based: initiateRescue → wait → completeRescue) ──
  it("F1 non-rescuer cannot initiate or complete a rescue", async () => {
    const twin = await twinFor(ALICE); await fund(twin);
    await expect(twin.connect(attacker).initiateRescue()).to.be.revertedWithCustomError(twin, "NotRescuer");
    await twin.connect(rescuer).initiateRescue();
    await ethers.provider.send("evm_increaseTime", [91 * 24 * 60 * 60]); await ethers.provider.send("evm_mine", []);
    await expect(twin.connect(attacker).completeRescue(attacker.address)).to.be.revertedWithCustomError(twin, "NotRescuer");
  });

  it("F2 rescuer cannot complete before the timelock (clock runs from intent)", async () => {
    const twin = await twinFor(ALICE); await fund(twin);
    await twin.connect(rescuer).initiateRescue();
    await expect(twin.connect(rescuer).completeRescue(rescuer.address)).to.be.revertedWithCustomError(twin, "RescueTooEarly");
  });

  it("F2b completeRescue without a prior initiate reverts", async () => {
    const twin = await twinFor(ALICE); await fund(twin);
    await ethers.provider.send("evm_increaseTime", [91 * 24 * 60 * 60]); await ethers.provider.send("evm_mine", []);
    await expect(twin.connect(rescuer).completeRescue(rescuer.address)).to.be.revertedWithCustomError(twin, "RescueNotInitiated");
  });

  it("F3 rescuer cannot rescue an activated twin", async () => {
    const twin = await twinFor(ALICE); await fund(twin);
    const { token, n, dl, iat, bal } = await withdrawJwt(twin, twitchKey, ALICE);
    await twin.connect(relayer).execute(dest.address, bal, "0x", n, dl, iat, ethers.toUtf8Bytes(token)); // activates
    await expect(twin.connect(rescuer).initiateRescue()).to.be.revertedWithCustomError(twin, "AlreadyActivated");
  });

  it("F4 pre-deploy timing attack neutralized: a year-old twin still owes a fresh 90-day window", async () => {
    const twin = await twinFor(ALICE);
    await ethers.provider.send("evm_increaseTime", [365 * 24 * 60 * 60]); await ethers.provider.send("evm_mine", []);
    await fund(twin); // funds arrive only now
    expect(await twin.isRescuable()).to.equal(false);
    await twin.connect(rescuer).initiateRescue();
    await expect(twin.connect(rescuer).completeRescue(rescuer.address)).to.be.revertedWithCustomError(twin, "RescueTooEarly");
  });

  // ── G. Factory / determinism ────────────────────────────────────────
  it("G1 deployTwin(0) is rejected", async () => {
    await expect(factory.deployTwin(0n)).to.be.revertedWith("userId 0 not allowed");
  });

  it("G2 predictAddress is stable and re-deploy is idempotent", async () => {
    const a1 = await factory.predictAddress(ALICE);
    await factory.deployTwin(ALICE);
    await factory.deployTwin(ALICE); // no revert
    expect(await factory.predictAddress(ALICE)).to.equal(a1);
  });
});
