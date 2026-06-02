import { ethers, network, run } from "hardhat";

// Reuses the existing TwitchJWTVerifier on Base mainnet.
const VERIFIER_BY_CHAIN: Record<number, string> = {
  8453: "0xF1Ff265EcA9983a21992808B9d764F8c6F2F9d25", // aud-bound verifier
};

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  console.log(`Network: ${network.name} (chainId ${chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);

  const verifierAddr = VERIFIER_BY_CHAIN[chainId];
  if (!verifierAddr) throw new Error(`No verifier known for chain ${chainId}`);
  console.log(`\nUsing TwitchJWTVerifier: ${verifierAddr}`);

  // Rescuer = deployer by default. The role is NOT renounceable, but it is
  // transferable to a multisig/DAO later via factory.transferRescuer(newAddr).
  const rescuer = process.env.RESCUER_ADDRESS || deployer.address;
  const Factory = await ethers.getContractFactory("TwinFactory");
  const factory = await Factory.deploy(verifierAddr, rescuer);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log(`TwinFactory: ${factoryAddr}`);
  console.log(`  rescuer: ${rescuer}`);

  // Sanity print: predict the twin address for a sample user_id.
  const sample = 44322889n;
  const predicted = await factory.predictAddress(sample);
  console.log(`Example: twin for Twitch user_id ${sample} → ${predicted}`);

  if (network.name !== "hardhat") {
    console.log("\nWaiting 30s for explorer indexing...");
    await new Promise((r) => setTimeout(r, 30_000));
    try {
      await run("verify:verify", {
        address: factoryAddr,
        constructorArguments: [verifierAddr, rescuer],
      });
    } catch (e: any) {
      console.warn(`Verification: ${e.message ?? e}`);
    }
  }

  console.log(`\nDone.
  TwinFactory:         ${factoryAddr}
  TwitchJWTVerifier:   ${verifierAddr}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
