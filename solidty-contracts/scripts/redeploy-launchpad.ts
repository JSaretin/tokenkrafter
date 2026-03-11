import { ethers, run, network } from "hardhat";

/**
 * Redeploy only BondingCurve library + LaunchpadFactory.
 * Keeps existing TokenFactory and token implementations.
 *
 * Usage:
 *   npx hardhat run scripts/redeploy-launchpad.ts --network bsc
 */

const NETWORK_CONFIG: Record<string, { usdt: string; dexRouter: string }> = {
  bsc: {
    usdt: "0x55d398326f99059fF775485246999027B3197955",
    dexRouter: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
  },
  bscTestnet: {
    usdt: "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd",
    dexRouter: "0xD99D1c33F9fC3444f8101754aBC46c52416550D1",
  },
};

// Existing TokenFactory address — update if needed
const TOKEN_FACTORY: Record<string, string> = {
  bsc: "0x6128fd6CE07E5dE33B71691284B18B20e0a50cdC",
};

async function verify(address: string, constructorArguments: any[] = []) {
  if (network.name === "hardhat" || network.name === "localhost") return;
  console.log(`  Verifying ${address}...`);
  try {
    await run("verify:verify", { address, constructorArguments });
    console.log(`  ✓ Verified`);
  } catch (e: any) {
    if (e.message?.toLowerCase().includes("already verified")) {
      console.log(`  ✓ Already verified`);
    } else {
      console.log(`  ✗ Verification failed: ${e.message}`);
    }
  }
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const networkName = network.name;

  console.log("=".repeat(60));
  console.log("Redeploy BondingCurve + LaunchpadFactory");
  console.log("=".repeat(60));
  console.log(`Network:  ${networkName}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(
    `Balance:  ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} native`
  );
  console.log("-".repeat(60));

  const cfg = NETWORK_CONFIG[networkName];
  if (!cfg) throw new Error(`No config for network "${networkName}"`);

  const platformWallet = process.env.PLATFORM_WALLET || deployer.address;
  const tokenFactoryAddr = TOKEN_FACTORY[networkName];
  if (!tokenFactoryAddr) throw new Error(`No TokenFactory address for "${networkName}"`);

  // Step 1: Deploy new BondingCurve library
  console.log("\n[1/4] Deploying BondingCurve library...");
  const BondingCurveFactory = await ethers.getContractFactory("BondingCurve");
  const bondingCurve = await BondingCurveFactory.deploy();
  await bondingCurve.waitForDeployment();
  const bondingCurveAddr = await bondingCurve.getAddress();
  console.log(`  BondingCurve: ${bondingCurveAddr}`);

  // Step 2: Deploy new LaunchpadFactory linked to new BondingCurve
  console.log("\n[2/4] Deploying LaunchpadFactory...");
  const LaunchpadFactoryFactory = await ethers.getContractFactory(
    "LaunchpadFactory",
    { libraries: { BondingCurve: bondingCurveAddr } }
  );
  const launchpadFactory = await LaunchpadFactoryFactory.deploy(
    platformWallet,
    cfg.dexRouter,
    cfg.usdt
  );
  await launchpadFactory.waitForDeployment();
  const launchpadAddr = await launchpadFactory.getAddress();
  console.log(`  LaunchpadFactory: ${launchpadAddr}`);

  // Step 3: Configure — link TokenFactory ↔ LaunchpadFactory
  console.log("\n[3/4] Configuring...");

  // Set token factory on new launchpad
  process.stdout.write(`  setTokenFactory(${tokenFactoryAddr})... `);
  const tx1 = await launchpadFactory.setTokenFactory(tokenFactoryAddr);
  await tx1.wait();
  console.log("done");

  // Update launchpad factory on existing token factory
  const tokenFactory = await ethers.getContractAt("TokenFactory", tokenFactoryAddr);
  process.stdout.write(`  setLaunchpadFactory(${launchpadAddr})... `);
  const tx2 = await tokenFactory.setLaunchpadFactory(launchpadAddr);
  await tx2.wait();
  console.log("done");

  // Step 4: Verify
  console.log("\n[4/4] Verifying...");
  if (network.name !== "hardhat" && network.name !== "localhost") {
    console.log("  Waiting 15s for explorer indexing...");
    await new Promise((r) => setTimeout(r, 15000));
  }
  await verify(bondingCurveAddr);
  await verify(launchpadAddr, [platformWallet, cfg.dexRouter, cfg.usdt]);

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("REDEPLOYMENT COMPLETE");
  console.log("=".repeat(60));
  console.log(`\nBondingCurve:     ${bondingCurveAddr}`);
  console.log(`LaunchpadFactory: ${launchpadAddr}`);
  console.log(`TokenFactory:     ${tokenFactoryAddr} (unchanged)`);
  console.log(`\nUpdate frontend launchpad_address to: "${launchpadAddr}"`);
  console.log("=".repeat(60));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
