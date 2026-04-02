/**
 * Deploy PlatformRouter + TradeRouter and configure everything.
 * Run after the main deploy script already deployed BondingCurve, implementations,
 * TokenFactory, and LaunchpadFactory.
 *
 * Usage: npx hardhat run scripts/deploy-remaining.ts --network bsc
 */
import { ethers, run, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const NETWORK_CONFIG: Record<string, { usdt: string; dexRouter: string; usdc?: string }> = {
  bsc: {
    usdt: "0x55d398326f99059fF775485246999027B3197955",
    dexRouter: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
    usdc: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  },
  bscTestnet: {
    usdt: "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd",
    dexRouter: "0xD99D1c33F9fC3444f8101754aBC46c52416550D1",
  },
  ethereum: {
    usdt: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    dexRouter: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
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

  // Already deployed addresses from previous run
  const tokenFactoryAddr = "0xeFd79e68d09692e663b0D6ADEc3071cf5422F17f";
  const launchpadFactoryAddr = "0x5D8BE067E78d35f0316d0024AF5d6385038D1033";

  const configKey = Object.keys(NETWORK_CONFIG).find(k => networkName.includes(k) || k === networkName);
  if (!configKey) throw new Error(`No config for network "${networkName}"`);

  const { usdt, dexRouter, usdc } = NETWORK_CONFIG[configKey];
  const platformWallet = process.env.PLATFORM_WALLET || deployer.address;

  console.log("=".repeat(60));
  console.log("TokenKrafter — Deploy Remaining (PlatformRouter + TradeRouter)");
  console.log("=".repeat(60));
  console.log(`Network:          ${networkName}`);
  console.log(`Deployer:         ${deployer.address}`);
  console.log(`Balance:          ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} BNB`);
  console.log(`TokenFactory:     ${tokenFactoryAddr}`);
  console.log(`LaunchpadFactory: ${launchpadFactoryAddr}`);
  console.log("-".repeat(60));

  // ── Configure LaunchpadFactory ──
  console.log("\n[1/5] Configuring LaunchpadFactory...");
  const LaunchpadFactoryFactory = await ethers.getContractFactory("LaunchpadFactory", {
    libraries: { BondingCurve: "0xC60E3b203a64Bb1Da710360a8A9AdB0973dddea6" }
  });
  const launchpadFactory = LaunchpadFactoryFactory.attach(launchpadFactoryAddr).connect(deployer) as any;

  process.stdout.write("  setCurveDefaults... ");
  await (await launchpadFactory.setCurveDefaults({
    linearSlope: 0n,
    linearIntercept: BigInt(1e16),
    sqrtCoefficient: BigInt(1e16),
    quadraticCoefficient: 1n,
    expBase: BigInt(1e16),
    expKFactor: BigInt(1e12)
  })).wait();
  console.log("done");

  // Add USDC to launchpad if available
  if (usdc) {
    process.stdout.write(`  addPaymentToken(USDC)... `);
    try {
      await (await launchpadFactory.addPaymentToken(usdc)).wait();
      console.log("done");
    } catch (e: any) {
      console.log(`skipped (${e.message?.slice(0, 50)})`);
    }
  }

  // ── Configure TokenFactory ──
  console.log("\n[2/5] Configuring TokenFactory...");
  const TokenFactoryFactory = await ethers.getContractFactory("TokenFactory");
  const tokenFactory = TokenFactoryFactory.attach(tokenFactoryAddr).connect(deployer) as any;

  if (usdc) {
    process.stdout.write(`  addPaymentToken(USDC)... `);
    try {
      await (await tokenFactory.addPaymentToken(usdc)).wait();
      console.log("done");
    } catch (e: any) {
      console.log(`skipped (${e.message?.slice(0, 50)})`);
    }
  }

  // ── Deploy PlatformRouter ──
  console.log("\n[3/5] Deploying PlatformRouter...");
  const PlatformRouterFactory = await ethers.getContractFactory("PlatformRouter");
  const platformRouter = await PlatformRouterFactory.deploy(tokenFactoryAddr, launchpadFactoryAddr, dexRouter);
  await platformRouter.waitForDeployment();
  const platformRouterAddr = await platformRouter.getAddress();
  console.log(`  PlatformRouter: ${platformRouterAddr}`);

  // ── Deploy TradeRouter ──
  console.log("\n[4/5] Deploying TradeRouter...");
  const TradeRouterFactory = await ethers.getContractFactory("TradeRouter");
  const tradeRouter = await TradeRouterFactory.deploy(dexRouter, usdt, platformWallet);
  await tradeRouter.waitForDeployment();
  const tradeRouterAddr = await tradeRouter.getAddress();
  console.log(`  TradeRouter: ${tradeRouterAddr}`);

  // Whitelist PlatformRouter
  process.stdout.write("  setAuthorizedRouter on TokenFactory... ");
  await (await tokenFactory.setAuthorizedRouter(platformRouterAddr)).wait();
  console.log("done");

  process.stdout.write("  setAuthorizedRouter on LaunchpadFactory... ");
  await (await launchpadFactory.setAuthorizedRouter(platformRouterAddr)).wait();
  console.log("done");

  // ── Verify ──
  console.log("\n[5/5] Verifying on explorer...");
  if (network.name !== "hardhat" && network.name !== "localhost") {
    console.log("  Waiting 15s for explorer indexing...");
    await new Promise(r => setTimeout(r, 15000));
  }
  await verify(platformRouterAddr, [tokenFactoryAddr, launchpadFactoryAddr, dexRouter]);
  await verify(tradeRouterAddr, [dexRouter, usdt, platformWallet]);

  // ── Save ──
  console.log("\n" + "=".repeat(60));
  console.log("DEPLOYMENT COMPLETE");
  console.log("=".repeat(60));

  const deployment = {
    BondingCurve: "0xC60E3b203a64Bb1Da710360a8A9AdB0973dddea6",
    TokenFactory: tokenFactoryAddr,
    LaunchpadFactory: launchpadFactoryAddr,
    PlatformRouter: platformRouterAddr,
    TradeRouter: tradeRouterAddr,
    USDT: usdt,
    DEXRouter: dexRouter,
    USDC: usdc || "",
    PlatformWallet: platformWallet,
    BasicTokenImpl: "0x0698D9eAcA1D5286aC36fA7b381A8A4CFfF17288",
    MintableTokenImpl: "0x266a29a17543fF2b81AF6a77a06d5376d4Da94Ce",
    TaxableTokenImpl: "0x2865781945569221642b006D63fc5284BD4187d5",
    TaxableMintableTokenImpl: "0x2C84EC4DF5D7FCCc6B2587ebE10EAbBfF491213E",
    PartnerTokenImpl: "0x13D10a391A0D70A482962f9487d294AbC060c2a2",
    PartnerMintableTokenImpl: "0x96BcA27d4A63a99E30b2C5dA023Ef1383Ae3Ec27",
    PartnerTaxableTokenImpl: "0xF6514b1aa306c46fBB087A43aF88d95E1D46B294",
    PartnerTaxableMintableTokenImpl: "0x8A66Bc2E5A1574857482e3546852326af9DcA144",
  };

  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir);
  const filePath = path.join(deploymentsDir, `${networkName}.json`);
  fs.writeFileSync(filePath, JSON.stringify(deployment, null, 2));
  console.log(`\nDeployment saved to: ${filePath}`);

  console.log("\nFor DB platform_config:");
  console.log(JSON.stringify({
    chain_id: 56,
    name: "BNB Smart Chain",
    symbol: "BSC",
    native_coin: "BNB",
    usdt_address: usdt,
    usdc_address: usdc || "",
    platform_address: tokenFactoryAddr,
    launchpad_address: launchpadFactoryAddr,
    router_address: platformRouterAddr,
    dex_router: dexRouter,
    trade_router_address: tradeRouterAddr,
    rpc: "https://bsc-dataseed.binance.org/"
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
