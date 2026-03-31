import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Local deployment script for Hardhat node testing.
 * Deploys mock USDT, mock DEX router, then the full platform.
 *
 * Usage:
 *   Terminal 1: npx hardhat node
 *   Terminal 2: npx hardhat run scripts/deploy-local.ts --network localhost
 */

const IMPL_CONTRACTS = [
  { name: "BasicTokenImpl", typeKey: 0 },
  { name: "MintableTokenImpl", typeKey: 1 },
  { name: "TaxableTokenImpl", typeKey: 2 },
  { name: "TaxableMintableTokenImpl", typeKey: 3 },
  { name: "PartnerTokenImpl", typeKey: 4 },
  { name: "PartnerMintableTokenImpl", typeKey: 5 },
  { name: "PartnerTaxableTokenImpl", typeKey: 6 },
  { name: "PartnerTaxableMintableTokenImpl", typeKey: 7 },
];

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = (await ethers.provider.getNetwork()).chainId;

  console.log("=".repeat(60));
  console.log("TokenKrafter — Local Deployment");
  console.log("=".repeat(60));
  console.log(`Network:  ${network.name} (chainId: ${chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(
    `Balance:  ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`
  );
  console.log("-".repeat(60));

  // ── Deploy Mock USDT ──
  console.log("\n[0a] Deploying Mock USDT...");
  const MockUSDT = await ethers.getContractFactory("MockUSDT");
  const usdt = await MockUSDT.deploy();
  await usdt.waitForDeployment();
  const usdtAddr = await usdt.getAddress();
  console.log(`  Mock USDT (6 decimals): ${usdtAddr}`);

  // ── Deploy Mock WETH + Factory + Router ──
  console.log("\n[0b] Deploying Mock DEX (WETH + Factory + Router)...");
  const MockWETH = await ethers.getContractFactory("MockWETH");
  const weth = await MockWETH.deploy();
  await weth.waitForDeployment();
  const wethAddr = await weth.getAddress();

  const MockFactory = await ethers.getContractFactory("MockUniswapV2Factory");
  const dexFactory = await MockFactory.deploy();
  await dexFactory.waitForDeployment();
  const dexFactoryAddr = await dexFactory.getAddress();

  const MockRouter = await ethers.getContractFactory("MockUniswapV2Router");
  const router = await MockRouter.deploy(wethAddr, dexFactoryAddr);
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();
  // Set WETH ↔ USDT price: 1 WETH = 2000 USDT (6 decimals)
  await router.setMockPrice(wethAddr, usdtAddr, ethers.parseUnits("2000", 6));
  await router.setMockPrice(usdtAddr, wethAddr, ethers.parseUnits("0.0005", 18)); // inverse
  console.log(`  Mock WETH: ${wethAddr}`);
  console.log(`  Mock Factory: ${dexFactoryAddr}`);
  console.log(`  Mock Router: ${routerAddr}`);
  console.log("  WETH/USDT price set (1 ETH = 2000 USDT)");

  // ── Deploy BondingCurve library ──
  console.log("\n[1/7] Deploying BondingCurve library...");
  const BondingCurve = await ethers.getContractFactory("BondingCurve");
  const bondingCurve = await BondingCurve.deploy();
  await bondingCurve.waitForDeployment();
  const bondingCurveAddr = await bondingCurve.getAddress();
  console.log(`  BondingCurve: ${bondingCurveAddr}`);

  // ── Deploy token implementations ──
  console.log("\n[2/7] Deploying token implementations...");
  const implAddresses: Record<number, string> = {};
  for (const impl of IMPL_CONTRACTS) {
    const Factory = await ethers.getContractFactory(impl.name);
    const contract = await Factory.deploy();
    await contract.waitForDeployment();
    const addr = await contract.getAddress();
    implAddresses[impl.typeKey] = addr;
    console.log(`  [${impl.typeKey}] ${impl.name}: ${addr}`);
  }

  // ── Deploy TokenFactory ──
  console.log("\n[3/7] Deploying TokenFactory...");
  const TokenFactory = await ethers.getContractFactory("TokenFactory");
  const tokenFactory = await TokenFactory.deploy(usdtAddr, routerAddr);
  await tokenFactory.waitForDeployment();
  const tokenFactoryAddr = await tokenFactory.getAddress();
  console.log(`  TokenFactory: ${tokenFactoryAddr}`);

  // ── Deploy LaunchpadFactory ──
  console.log("\n[4/7] Deploying LaunchpadFactory...");
  const LaunchpadFactory = await ethers.getContractFactory("LaunchpadFactory", {
    libraries: { BondingCurve: bondingCurveAddr },
  });
  const launchpadFactory = await LaunchpadFactory.deploy(
    deployer.address, // platformWallet
    routerAddr,
    usdtAddr
  );
  await launchpadFactory.waitForDeployment();
  const launchpadFactoryAddr = await launchpadFactory.getAddress();
  console.log(`  LaunchpadFactory: ${launchpadFactoryAddr}`);

  // ── Configure ──
  console.log("\n[5/7] Configuring...");
  for (const impl of IMPL_CONTRACTS) {
    await (await tokenFactory.setImplementation(impl.typeKey, implAddresses[impl.typeKey])).wait();
  }
  console.log("  Implementations registered");

  // Set curve defaults tuned for 6-decimal USDT with baseScale normalization.
  // Curve math works in 18-dec virtual space, output divided by baseScale (1e12).
  // These defaults target 1M-token launches with $1K-$50K hardcaps.
  // Linear: intercept = start price per token in virtual units
  //   1e16 → $0.01/token after /1e12. Slope kept tiny to avoid overflow with large supplies.
  await (await launchpadFactory.setCurveDefaults({
    linearSlope: 0n,             // flat-rate linear (price = intercept per token)
    linearIntercept: BigInt(1e16), // $0.01/token after baseScale
    sqrtCoefficient: BigInt(1e16), // moderate sqrt curve
    quadraticCoefficient: 1n,      // tiny quadratic (grows with supply^2)
    expBase: BigInt(1e16),
    expKFactor: BigInt(1e12)
  })).wait();
  console.log("  Curve defaults set for 6-decimal USDT");

  // ── Deploy PlatformRouter ──
  console.log("\n[6/7] Deploying PlatformRouter...");
  const PlatformRouter = await ethers.getContractFactory("PlatformRouter");
  const platformRouter = await PlatformRouter.deploy(tokenFactoryAddr, launchpadFactoryAddr, routerAddr);
  await platformRouter.waitForDeployment();
  const platformRouterAddr = await platformRouter.getAddress();
  console.log(`  PlatformRouter: ${platformRouterAddr}`);

  // ── Deploy TradeRouter ──
  console.log("\n[7/7] Deploying TradeRouter...");
  const TradeRouter = await ethers.getContractFactory("TradeRouter");
  const tradeRouter = await TradeRouter.deploy(routerAddr, usdtAddr, deployer.address);
  await tradeRouter.waitForDeployment();
  const tradeRouterAddr = await tradeRouter.getAddress();
  console.log(`  TradeRouter: ${tradeRouterAddr}`);

  // Whitelist the router on both factories so it can call routerCreateToken / routerCreateLaunch
  await (await tokenFactory.setAuthorizedRouter(platformRouterAddr)).wait();
  console.log("  TokenFactory → Router whitelisted");
  await (await launchpadFactory.setAuthorizedRouter(platformRouterAddr)).wait();
  console.log("  LaunchpadFactory → Router whitelisted");

  // ── Summary ──
  console.log("\n" + "=".repeat(60));
  console.log("LOCAL DEPLOYMENT COMPLETE");
  console.log("=".repeat(60));
  console.log(`\nMock USDT:        ${usdtAddr}`);
  console.log(`Mock DEX Router:  ${routerAddr}`);
  console.log(`BondingCurve:     ${bondingCurveAddr}`);
  console.log(`TokenFactory:     ${tokenFactoryAddr}`);
  console.log(`LaunchpadFactory: ${launchpadFactoryAddr}`);
  console.log(`PlatformRouter:   ${platformRouterAddr}`);
  console.log(`TradeRouter:      ${tradeRouterAddr}`);

  console.log("\n" + "-".repeat(60));
  console.log("Update your frontend +layout.svelte with:");
  console.log(`  chain_id: ${chainId},`);
  console.log(`  platform_address: "${tokenFactoryAddr}",`);
  console.log(`  launchpad_address: "${launchpadFactoryAddr}",`);
  console.log(`  router_address: "${platformRouterAddr}",`);
  console.log(`  rpc: "http://127.0.0.1:8545",`);
  console.log("-".repeat(60));

  // Save deployment JSON
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir);
  const filePath = path.join(deploymentsDir, "localhost.json");
  const deployment = {
    MockUSDT: usdtAddr,
    MockRouter: routerAddr,
    BondingCurve: bondingCurveAddr,
    TokenFactory: tokenFactoryAddr,
    LaunchpadFactory: launchpadFactoryAddr,
    PlatformRouter: platformRouterAddr,
    TradeRouter: tradeRouterAddr,
    ...Object.fromEntries(
      IMPL_CONTRACTS.map((i) => [i.name, implAddresses[i.typeKey]])
    ),
  };
  fs.writeFileSync(filePath, JSON.stringify(deployment, null, 2));
  console.log(`\nDeployment saved to ${filePath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
