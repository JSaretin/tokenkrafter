import { ethers, run, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Network-specific addresses.
 * Add/update entries as needed before deploying to a new chain.
 */
const NETWORK_CONFIG: Record<
  string,
  { usdt: string; dexRouter: string; usdc?: string }
> = {
  bsc: {
    usdt: "0x55d398326f99059fF775485246999027B3197955",
    dexRouter: "0x10ED43C718714eb63d5aA57B78B54704E256024E", // PancakeSwap V2
    usdc: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  },
  bscTestnet: {
    usdt: "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd", // testnet USDT
    dexRouter: "0xD99D1c33F9fC3444f8101754aBC46c52416550D1", // PancakeSwap V2 testnet
  },
  ethereum: {
    usdt: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    dexRouter: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D", // Uniswap V2
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
  sepolia: {
    usdt: "0x7169D38820dfd117C3FA1f22a697dBA58d90BA06", // mock USDT on sepolia
    dexRouter: "0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3", // uniswap v2 sepolia
  },
};

/**
 * Token type keys (bitfield):
 *   0 = basic
 *   1 = mintable
 *   2 = taxable
 *   3 = taxable + mintable
 *   4 = partner
 *   5 = partner + mintable
 *   6 = partner + taxable
 *   7 = partner + taxable + mintable
 */
const IMPL_CONTRACTS: { typeKey: number; name: string }[] = [
  { typeKey: 0, name: "BasicTokenImpl" },
  { typeKey: 1, name: "MintableTokenImpl" },
  { typeKey: 2, name: "TaxableTokenImpl" },
  { typeKey: 3, name: "TaxableMintableTokenImpl" },
  { typeKey: 4, name: "PartnerTokenImpl" },
  { typeKey: 5, name: "PartnerMintableTokenImpl" },
  { typeKey: 6, name: "PartnerTaxableTokenImpl" },
  { typeKey: 7, name: "PartnerTaxableMintableTokenImpl" },
];

/** Attempt to verify a contract, swallowing "already verified" errors */
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

/** Save deployed addresses to a JSON file for frontend consumption */
function saveDeployment(
  networkName: string,
  data: Record<string, string>
) {
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir);
  const filePath = path.join(deploymentsDir, `${networkName}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`\nDeployment saved to: ${filePath}`);
}

/** Save Hardhat build info (standard JSON input) for the verification endpoint */
function saveBuildInfo(networkName: string) {
  const buildInfoDir = path.join(__dirname, "..", "artifacts", "build-info");
  const deploymentsDir = path.join(__dirname, "..", "deployments");

  if (!fs.existsSync(buildInfoDir)) {
    console.log("  No build-info directory found, skipping.");
    return;
  }

  const files = fs.readdirSync(buildInfoDir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    console.log("  No build-info files found, skipping.");
    return;
  }

  // Copy the latest build info
  const latestFile = files[files.length - 1];
  const destFile = path.join(deploymentsDir, `${networkName}-build-info.json`);
  fs.copyFileSync(path.join(buildInfoDir, latestFile), destFile);
  console.log(`Build info saved to: ${destFile}`);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const networkName = network.name;
  const chainId = (await ethers.provider.getNetwork()).chainId;

  console.log("=".repeat(60));
  console.log("TokenKrafter V1 — Full Deployment");
  console.log("=".repeat(60));
  console.log(`Network:  ${networkName} (chainId: ${chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(
    `Balance:  ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} native`
  );
  console.log("-".repeat(60));

  // ── Resolve network config ──
  const configKey = Object.keys(NETWORK_CONFIG).find(
    (k) => networkName.includes(k) || k === networkName
  );

  let usdt: string;
  let dexRouter: string;
  let usdc: string | undefined;

  if (configKey) {
    const cfg = NETWORK_CONFIG[configKey];
    usdt = cfg.usdt;
    dexRouter = cfg.dexRouter;
    usdc = cfg.usdc;
  } else {
    usdt = process.env.USDT_ADDRESS!;
    dexRouter = process.env.DEX_ROUTER_ADDRESS!;
    usdc = process.env.USDC_ADDRESS;
    if (!usdt || !dexRouter) {
      throw new Error(
        `No config for network "${networkName}". Set USDT_ADDRESS and DEX_ROUTER_ADDRESS env vars.`
      );
    }
  }

  const platformWallet =
    process.env.PLATFORM_WALLET || deployer.address;

  console.log(`USDT:            ${usdt}`);
  console.log(`DEX Router:      ${dexRouter}`);
  console.log(`Platform Wallet: ${platformWallet}`);
  if (usdc) console.log(`USDC:            ${usdc}`);
  console.log("-".repeat(60));

  const deployedAddresses: Record<string, string> = {};

  // ══════════════════════════════════════════════════
  // Step 1: Deploy BondingCurve library
  // ══════════════════════════════════════════════════
  console.log("\n[1/6] Deploying BondingCurve library...\n");

  let bondingCurveAddr = process.env.BONDING_CURVE_ADDRESS;

  if (bondingCurveAddr) {
    console.log(
      `  Using existing BondingCurve from .env: ${bondingCurveAddr}`
    );
  } else {
    const BondingCurveFactory = await ethers.getContractFactory(
      "BondingCurve"
    );
    const bondingCurve = await BondingCurveFactory.deploy();
    await bondingCurve.waitForDeployment();
    bondingCurveAddr = await bondingCurve.getAddress();
    console.log(`  BondingCurve deployed at: ${bondingCurveAddr}`);
    console.log(
      `  → Save this to .env as BONDING_CURVE_ADDRESS=${bondingCurveAddr}`
    );
  }
  deployedAddresses["BondingCurve"] = bondingCurveAddr;

  // ══════════════════════════════════════════════════
  // Step 2: Deploy all 8 token implementations
  // ══════════════════════════════════════════════════
  console.log("\n[2/6] Deploying token implementations...\n");

  const implAddresses: Record<number, string> = {};

  for (const impl of IMPL_CONTRACTS) {
    process.stdout.write(
      `  Deploying ${impl.name} (type ${impl.typeKey})... `
    );
    const Factory = await ethers.getContractFactory(impl.name);
    const contract = await Factory.deploy();
    await contract.waitForDeployment();
    const addr = await contract.getAddress();
    implAddresses[impl.typeKey] = addr;
    deployedAddresses[impl.name] = addr;
    console.log(addr);
  }

  // ══════════════════════════════════════════════════
  // Step 3: Deploy TokenFactory
  // ══════════════════════════════════════════════════
  console.log("\n[3/6] Deploying TokenFactory...\n");

  const TokenFactoryFactory = await ethers.getContractFactory(
    "TokenFactory"
  );
  const tokenFactory = await TokenFactoryFactory.deploy(usdt, dexRouter);
  await tokenFactory.waitForDeployment();
  const tokenFactoryAddr = await tokenFactory.getAddress();
  deployedAddresses["TokenFactory"] = tokenFactoryAddr;
  console.log(`  TokenFactory deployed at: ${tokenFactoryAddr}`);

  // ══════════════════════════════════════════════════
  // Step 4: Deploy LaunchpadFactory (linked to BondingCurve)
  // ══════════════════════════════════════════════════
  console.log("\n[4/6] Deploying LaunchpadFactory...\n");

  // Link BondingCurve library to LaunchpadFactory and LaunchInstance
  const LaunchpadFactoryFactory = await ethers.getContractFactory(
    "LaunchpadFactory",
    {
      libraries: {
        BondingCurve: bondingCurveAddr,
      },
    }
  );
  const launchpadFactory = await LaunchpadFactoryFactory.deploy(
    platformWallet,
    dexRouter,
    usdt
  );
  await launchpadFactory.waitForDeployment();
  const launchpadFactoryAddr = await launchpadFactory.getAddress();
  deployedAddresses["LaunchpadFactory"] = launchpadFactoryAddr;
  console.log(
    `  LaunchpadFactory deployed at: ${launchpadFactoryAddr}`
  );

  // ══════════════════════════════════════════════════
  // Step 5: Configure factories
  // ══════════════════════════════════════════════════
  console.log("\n[5/6] Configuring factories...\n");

  // Register implementations
  for (const impl of IMPL_CONTRACTS) {
    process.stdout.write(
      `  setImplementation(${impl.typeKey}, ${implAddresses[impl.typeKey]})... `
    );
    const tx = await tokenFactory.setImplementation(
      impl.typeKey,
      implAddresses[impl.typeKey]
    );
    await tx.wait();
    console.log("done");
  }

  // Add USDC as payment token if available
  if (usdc) {
    process.stdout.write(`  addPaymentToken(USDC: ${usdc})... `);
    const tx = await tokenFactory.addPaymentToken(usdc);
    await tx.wait();
    console.log("done");
  }

  // Set curve defaults for 6-decimal USDT
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

  // ══════════════════════════════════════════════════
  // Step 6: Deploy PlatformRouter
  // ══════════════════════════════════════════════════
  console.log("\n[6/8] Deploying PlatformRouter...\n");

  const PlatformRouterFactory = await ethers.getContractFactory("PlatformRouter");
  const platformRouter = await PlatformRouterFactory.deploy(
    tokenFactoryAddr,
    launchpadFactoryAddr,
    dexRouter
  );
  await platformRouter.waitForDeployment();
  const platformRouterAddr = await platformRouter.getAddress();
  deployedAddresses["PlatformRouter"] = platformRouterAddr;
  console.log(`  PlatformRouter deployed at: ${platformRouterAddr}`);

  // ══════════════════════════════════════════════════
  // Step 7: Deploy TradeRouter
  // ══════════════════════════════════════════════════
  console.log("\n[7/8] Deploying TradeRouter...\n");

  const TradeRouterFactory = await ethers.getContractFactory("TradeRouter");
  const tradeRouter = await TradeRouterFactory.deploy(
    dexRouter,
    usdt,
    platformWallet
  );
  await tradeRouter.waitForDeployment();
  const tradeRouterAddr = await tradeRouter.getAddress();
  deployedAddresses["TradeRouter"] = tradeRouterAddr;
  console.log(`  TradeRouter deployed at: ${tradeRouterAddr}`);

  // Whitelist PlatformRouter on both factories
  process.stdout.write("  setAuthorizedRouter on TokenFactory... ");
  await (await tokenFactory.setAuthorizedRouter(platformRouterAddr)).wait();
  console.log("done");

  process.stdout.write("  setAuthorizedRouter on LaunchpadFactory... ");
  await (await launchpadFactory.setAuthorizedRouter(platformRouterAddr)).wait();
  console.log("done");

  // ══════════════════════════════════════════════════
  // Step 8: Verify all contracts on explorer
  // ══════════════════════════════════════════════════
  console.log("\n[8/8] Verifying contracts on explorer...\n");

  // Wait for explorer to index (BSCScan needs ~15s)
  if (network.name !== "hardhat" && network.name !== "localhost") {
    console.log("  Waiting 15s for explorer indexing...");
    await new Promise((r) => setTimeout(r, 15000));
  }

  // Verify BondingCurve library
  await verify(bondingCurveAddr);

  // Verify implementations (no constructor args)
  for (const impl of IMPL_CONTRACTS) {
    await verify(implAddresses[impl.typeKey]);
  }

  // Verify TokenFactory
  await verify(tokenFactoryAddr, [usdt, dexRouter]);

  // Verify LaunchpadFactory
  await verify(launchpadFactoryAddr, [platformWallet, dexRouter, usdt]);

  // Verify PlatformRouter
  await verify(platformRouterAddr, [tokenFactoryAddr, launchpadFactoryAddr, dexRouter]);

  // Verify TradeRouter
  await verify(tradeRouterAddr, [dexRouter, usdt, platformWallet]);

  // ══════════════════════════════════════════════════
  // Summary
  // ══════════════════════════════════════════════════
  console.log("\n" + "=".repeat(60));
  console.log("DEPLOYMENT COMPLETE");
  console.log("=".repeat(60));

  console.log(`\nBondingCurve:     ${bondingCurveAddr}`);
  console.log(`TokenFactory:     ${tokenFactoryAddr}`);
  console.log(`LaunchpadFactory: ${launchpadFactoryAddr}`);
  console.log(`PlatformRouter:   ${platformRouterAddr}`);
  console.log(`TradeRouter:      ${tradeRouterAddr}\n`);

  console.log("Implementations:");
  for (const impl of IMPL_CONTRACTS) {
    console.log(
      `  [${impl.typeKey}] ${impl.name}: ${implAddresses[impl.typeKey]}`
    );
  }

  console.log("\nPayment tokens:");
  console.log(`  USDT (auto):   ${usdt}`);
  console.log(
    `  Native (auto): 0x0000000000000000000000000000000000000000`
  );
  if (usdc) console.log(`  USDC (added):  ${usdc}`);

  console.log("\n" + "-".repeat(60));
  console.log("Add to .env:");
  console.log(`  BONDING_CURVE_ADDRESS=${bondingCurveAddr}`);
  console.log("\nUpdate DB platform_config networks:");
  console.log(`  platform_address:      "${tokenFactoryAddr}"`);
  console.log(`  launchpad_address:     "${launchpadFactoryAddr}"`);
  console.log(`  router_address:        "${platformRouterAddr}"`);
  console.log(`  trade_router_address:  "${tradeRouterAddr}"`);
  console.log("-".repeat(60));

  // Save deployment JSON
  saveDeployment(networkName, deployedAddresses);

  // Save build info for verification endpoint
  saveBuildInfo(networkName);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
