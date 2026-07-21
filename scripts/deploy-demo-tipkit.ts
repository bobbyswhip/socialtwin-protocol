import { ethers } from "hardhat";

// Deploys the /testnet demo kit (DemoUSD + TipJar) to Base Sepolia.
//   PRIVATE_KEY=<key> npx hardhat run scripts/deploy-demo-tipkit.ts --network baseSepolia
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("deployer:", await deployer.getAddress());

  const USD = await ethers.getContractFactory("DemoUSD");
  const usd = await USD.deploy();
  await usd.waitForDeployment();
  const usdAddr = await usd.getAddress();
  console.log("DemoUSD:", usdAddr);

  const Jar = await ethers.getContractFactory("TipJar");
  const jar = await Jar.deploy();
  await jar.waitForDeployment();
  const jarAddr = await jar.getAddress();
  console.log("TipJar:", jarAddr);

  console.log(JSON.stringify({ demoUsd: usdAddr, tipJar: jarAddr }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
