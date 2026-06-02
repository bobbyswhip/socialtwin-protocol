import { ethers, network } from "hardhat";
import { generateKeyPairSync } from "crypto";
import * as fs from "fs";
import * as path from "path";

// Deploys the FULL stack to a local hardhat node (npx hardhat node) with a
// TEST RSA key standing in for Twitch. The e2e app reads the resulting
// deploy.local.json to (a) talk to the contracts and (b) mint mock-Twitch
// JWTs signed by the same key the deployed verifier trusts.
//
// This exercises the REAL onchain verification path — only the JWT issuer
// is local instead of id.twitch.tv.
//
// Usage:
//   Terminal A:  npx hardhat node
//   Terminal B:  npx hardhat run scripts/deploy-local.ts --network localhost

const KID = "1";
const YOUGOTCOINED_USER_ID = 1000000001n; // mock Twitch numeric id for the demo streamer

// Well-known hardhat default accounts (THROWAWAY — local only, never funded on mainnet)
const COMMUNITY_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // acct #0
const STREAMER_EOA_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // acct #1

function rsaModulusHex(publicKeyPem: string): string {
  const { createPublicKey } = require("crypto");
  const jwk = createPublicKey(publicKeyPem).export({ format: "jwk" }) as any;
  const n = jwk.n as string;
  const padded = n + "=".repeat((4 - (n.length % 4)) % 4);
  return "0x" + Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("hex");
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Network: ${network.name}`);
  console.log(`Deployer: ${deployer.address}`);

  // 1. Generate the TEST "Twitch" RSA keypair.
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 });
  const privPem = privateKey.export({ type: "pkcs1", format: "pem" }) as string;
  const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  const modulusHex = rsaModulusHex(pubPem);

  // 2. Deploy verifier with the test modulus. Constructor is
  //    (kids, moduli, auds, audAdmin). For the local harness we seed a dummy
  //    aud and then turn the aud check OFF so the mock issuer can use any
  //    client_id without coordination.
  const Verifier = await ethers.getContractFactory("TwitchJWTVerifier");
  const verifier = await Verifier.deploy([KID], [modulusHex], ["local-dev"], deployer.address, deployer.address, deployer.address);
  await verifier.waitForDeployment();
  await (await verifier.setAudCheckEnabled(false)).wait();
  const verifierAddr = await verifier.getAddress();
  console.log(`TwitchJWTVerifier (TEST key, aud-check off for local): ${verifierAddr}`);

  // 3. Deploy factory (rescuer = deployer for the harness).
  const Factory = await ethers.getContractFactory("TwinFactory");
  const factory = await Factory.deploy(verifierAddr, deployer.address);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log(`TwinFactory v2: ${factoryAddr}`);

  // 4. Deploy a mock ERC-20 to simulate "trading fee" rewards.
  const Token = await ethers.getContractFactory("MockERC20");
  const coin = await Token.deploy("StreamCoin", "STREAM", ethers.parseEther("1000000"));
  await coin.waitForDeployment();
  const coinAddr = await coin.getAddress();
  console.log(`MockERC20 (StreamCoin): ${coinAddr}`);

  // 5. Pre-coin the yougotcoined twin so the demo has funds waiting on first load.
  const twin = await factory.predictAddress(YOUGOTCOINED_USER_ID);
  await (await deployer.sendTransaction({ to: twin, value: ethers.parseEther("3.5") })).wait();
  await (await coin.transfer(twin, ethers.parseEther("125000"))).wait();
  console.log(`Pre-coined yougotcoined twin ${twin}: 3.5 ETH + 125000 STREAM`);

  // 6. Fund the streamer's escape EOA with a little gas.
  await (await deployer.sendTransaction({ to: new ethers.Wallet(STREAMER_EOA_PK).address, value: ethers.parseEther("1") })).wait();

  // 7. Write config for the e2e app.
  const liveChainId = Number((await ethers.provider.getNetwork()).chainId);
  const out = {
    rpcUrl: "http://127.0.0.1:8545",
    chainId: liveChainId,
    contracts: { factory: factoryAddr, verifier: verifierAddr, coin: coinAddr },
    twitch: { kid: KID, privateKeyPem: privPem, issuer: "https://id.twitch.tv/oauth2" },
    demoStreamer: {
      login: "yougotcoined",
      displayName: "yougotcoined",
      userId: YOUGOTCOINED_USER_ID.toString(),
      twin,
    },
    testAccounts: {
      community: { pk: COMMUNITY_PK, address: new ethers.Wallet(COMMUNITY_PK).address },
      streamerEOA: { pk: STREAMER_EOA_PK, address: new ethers.Wallet(STREAMER_EOA_PK).address },
    },
  };
  const outPath = path.join(__dirname, "..", "e2e", "deploy.local.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${outPath}`);
  console.log(`\nNext: cd e2e && npm install && npm run dev   → http://localhost:3000`);
}

main().catch((e) => { console.error(e); process.exit(1); });
