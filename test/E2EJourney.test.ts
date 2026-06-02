import { expect } from "chai";
import { ethers } from "hardhat";
import { generateKeyPairSync, KeyObject } from "crypto";
import jwt from "jsonwebtoken";

// Full streamer journey, programmatically — the deterministic substrate the
// UI mirrors and the red-team builds on. Mirrors deploy-local.ts + the e2e app.
const ISSUER = "https://id.twitch.tv/oauth2";
const KID = "1";
const STREAMER_ID = 1000000001n;

function modHex(k: KeyObject) {
  const j = k.export({ format: "jwk" }) as any;
  const n = j.n as string;
  const pad = n + "=".repeat((4 - (n.length % 4)) % 4);
  return "0x" + Buffer.from(pad.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("hex");
}

describe("E2E streamer journey (mock Twitch)", () => {
  it("coin → claim via JWT → connect EOA → spend with Twitch dead", async () => {
    const [deployer, community, streamerEOA, attacker] = await ethers.getSigners();
    const kp = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 });
    const priv = kp.privateKey.export({ type: "pkcs1", format: "pem" }) as string;

    const V = await ethers.getContractFactory("TwitchJWTVerifier");
    const verifier = await V.deploy([KID], [modHex(kp.publicKey)], ["e2e"], deployer.address, deployer.address, deployer.address);
    const F = await ethers.getContractFactory("TwinFactory");
    const factory = await F.deploy(await verifier.getAddress(), deployer.address);

    const mint = (sub: bigint, nonce: string, iat: number) =>
      jwt.sign({ iss: ISSUER, sub: sub.toString(), aud: "e2e", iat, exp: iat + 3600, nonce }, priv,
        { algorithm: "RS256", header: { alg: "RS256", typ: "JWT", kid: KID } });

    const twinAddr = await factory.predictAddress(STREAMER_ID);

    // ① community coins the streamer BEFORE the twin exists
    await community.sendTransaction({ to: twinAddr, value: ethers.parseEther("2") });
    expect(await ethers.provider.getBalance(twinAddr)).to.equal(ethers.parseEther("2"));

    // deploy twin (anyone)
    await factory.deployTwin(STREAMER_ID);
    const twin = await ethers.getContractAt("TwinAccount", twinAddr);

    const now = async () => Number((await ethers.provider.getBlock("latest"))!.timestamp);

    // ② streamer withdraws 1 ETH via Twitch JWT, relayed by a random account
    {
      const dest = streamerEOA.address;
      const n = await twin.nonce();
      const dl = BigInt(await now() + 600);
      const ah = await twin.computeActionHash(dest, ethers.parseEther("1"), "0x", n, dl);
      const iat = await now();
      const token = mint(STREAMER_ID, ah, iat);
      const before = await ethers.provider.getBalance(dest);
      // relayed by attacker (permissionless) — funds still go to dest, not relayer
      await twin.connect(attacker).execute(dest, ethers.parseEther("1"), "0x", n, dl, iat, ethers.toUtf8Bytes(token));
      expect(await ethers.provider.getBalance(dest) - before).to.equal(ethers.parseEther("1"));
    }

    // ③ streamer connects escape EOA
    {
      const n = await twin.nonce();
      const dl = BigInt(await now() + 600);
      const ah = await twin.computeSetOwnerHash(streamerEOA.address, n, dl);
      const iat = await now();
      await twin.setOwnerEOA(streamerEOA.address, n, dl, iat, ethers.toUtf8Bytes(mint(STREAMER_ID, ah, iat)));
      expect(await twin.ownerEOA()).to.equal(streamerEOA.address);
      expect(await twin.activated()).to.equal(true);
    }

    // ④ Twitch is now "dead" — streamer still spends the remaining 1 ETH as owner, no JWT
    {
      const bal = await ethers.provider.getBalance(twinAddr);
      const before = await ethers.provider.getBalance(streamerEOA.address);
      const tx = await twin.connect(streamerEOA).executeAsOwner(streamerEOA.address, bal, "0x");
      const r = await tx.wait();
      const gas = r!.gasUsed * r!.gasPrice;
      expect(await ethers.provider.getBalance(streamerEOA.address)).to.equal(before + bal - gas);
      expect(await ethers.provider.getBalance(twinAddr)).to.equal(0n);
    }

    // ⑤ red-team smoke: attacker's JWT for THEIR id cannot touch this twin
    {
      await community.sendTransaction({ to: twinAddr, value: ethers.parseEther("0.5") });
      const ATTACKER_ID = 999999999n;
      const n = await twin.nonce();
      const dl = BigInt(await now() + 600);
      const ah = await twin.computeActionHash(attacker.address, ethers.parseEther("0.5"), "0x", n, dl);
      const iat = await now();
      // attacker gets Twitch to sign for THEIR own id, aims at the streamer's twin
      const token = mint(ATTACKER_ID, ah, iat);
      await expect(
        twin.connect(attacker).execute(attacker.address, ethers.parseEther("0.5"), "0x", n, dl, iat, ethers.toUtf8Bytes(token))
      ).to.be.reverted; // WrongSub in verifier
      // and the owner-path is gated to the connected EOA, not the attacker
      await expect(
        twin.connect(attacker).executeAsOwner(attacker.address, ethers.parseEther("0.5"), "0x")
      ).to.be.revertedWithCustomError(twin, "NotOwner");
    }
  });
});
