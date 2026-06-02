import { ethers, network, run } from "hardhat";

// Deploys the aud-bound TwitchJWTVerifier + a fresh TwinFactory pointing at it.
// aud allowlist is seeded with the official yougotcoined client_id; the
// curating admin (and the factory rescuer) is the treasury vault.

const KID = "1";
// Twitch live kid="1" RSA-2048 modulus (verified against id.twitch.tv/oauth2/keys).
const MODULUS =
  "0xea5abd310faaea1731afb90e529fad1e51ed75c0ec54bc15230d77897502bee0ce7828b4552bb1082518e9498c8f2e77757d348a1d84e18e14be5ae69aeacad1e1b6e9bf8730d340bc21ac5571d4dd1711855a070da3b01f053bda3edba479fd5db3f74378de6d7e8a21f35b7a2d8c891d16c9bf1164713e69985160ef3ffa4f46d86c9c4e9bdcfb6181b0ff151cb50a29f02cd81eac5b7ab7ca653a3342fe7055e467d7c7927f5e8ecfaca993e1309c6d04f071a142144054e0bf85574d2bfdd787ff624370f848eec1b8305ccbe9cabd3a1327c89b11e8c6c66415807ea81607b5a3314e716c641afa7e7f076b626a4f58683fb679af9c310eedc64212a41f";
const OFFICIAL_CLIENT_ID = "epeocrogq8bm1af0lngd9e2rfvrwk1"; // yougotcoined Twitch app (aud)
const TREASURY = "0xD1EC8245c8850A151843ce8a3AFdca3b19747706"; // audAdmin + GUARDIAN (cold veto) + factory rescuer
// keyAdmin queues/commits signing-key rotations. A hot operational key, kept
// DISTINCT from the guardian (treasury) so the cold key holds the veto. Override via env.
const KEY_ADMIN = process.env.KEY_ADMIN_ADDRESS || "0xa825094B04D5a3710bd41C4fbC902F75cF333333";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Network: ${network.name} | deployer: ${deployer.address}`);

  const V = await ethers.getContractFactory("TwitchJWTVerifier");
  // constructor: (kids, moduli, auds, audAdmin, keyAdmin, guardian)
  const verifier = await V.deploy([KID], [MODULUS], [OFFICIAL_CLIENT_ID], TREASURY, KEY_ADMIN, TREASURY);
  await verifier.waitForDeployment();
  const verifierAddr = await verifier.getAddress();
  console.log(`TwitchJWTVerifier (aud-bound): ${verifierAddr}`);
  console.log(`  aud allowlist: ["${OFFICIAL_CLIENT_ID}"] | audAdmin: ${TREASURY}`);

  const F = await ethers.getContractFactory("TwinFactory");
  const factory = await F.deploy(verifierAddr, TREASURY);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log(`TwinFactory: ${factoryAddr} | rescuer: ${TREASURY}`);

  const sample = await factory.predictAddress(1507305235n);
  console.log(`yougotcoined twin (new): ${sample}`);

  if (network.name !== "hardhat") {
    console.log("Waiting 30s for indexing…");
    await new Promise((r) => setTimeout(r, 30_000));
    try {
      await run("verify:verify", { address: verifierAddr, constructorArguments: [[KID], [MODULUS], [OFFICIAL_CLIENT_ID], TREASURY, KEY_ADMIN, TREASURY] });
      await run("verify:verify", { address: factoryAddr, constructorArguments: [verifierAddr, TREASURY] });
    } catch (e: any) { console.warn(`verify: ${e.message ?? e}`); }
  }
  console.log(`\nDone.\n  VERIFIER=${verifierAddr}\n  FACTORY=${factoryAddr}\n  TWIN(yougotcoined)=${sample}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
