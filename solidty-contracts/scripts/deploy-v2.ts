import { ethers, run, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * TokenKrafter — Full Clean Deployment (USDT-only fee model)
 *
 * Deploys the entire stack from scratch:
 *   1. BondingCurve library
 *   2. LaunchInstance implementation (for cloning)
 *   3. 8 Token implementations
 *   4. TokenFactory
 *   5. LaunchpadFactory (wired to LaunchInstance impl)
 *   6. PlatformRouter
 *   7. TradeRouter
 *   8. TradeLens
 *   9. PlatformLens (optional — skipped if contract is absent)
 *
 * Post-deploy config:
 *   - Registers all 8 implementations + USDT creation fees in ONE tx via
 *     `setImplementationsAndFees` (replaces 16 separate calls).
 *   - Authorizes PlatformRouter on both factories.
 *   - Seeds the TokenFactory's `defaultPartnerBases` list with the chain's
 *     canonical bases (USDT, WBNB, USDC). These are force-merged into any
 *     partner-variant token's `bases[]` so the platform always has
 *     liquidity on the bases that drive its 1% partner fee revenue.
 *   - Sets launch fee + curve defaults on LaunchpadFactory.
 *   - Sets TradeRouter max slippage.
 *
 * This deploy script reflects the USDT-only refactor:
 *   - NO `addPaymentToken` calls (the function was removed from both factories)
 *   - NO native BNB fee support (factories only accept USDT; PlatformRouter
 *     handles input-token → USDT swapping via the caller's `FeePayment.path`)
 *
 * Usage:
 *   npx hardhat run scripts/deploy-v2.ts --network bsc
 *
 * Environment:
 *   DEPLOYER_PRIVATE_KEY  — deployer wallet (in hardhat.config.ts)
 *   PLATFORM_WALLET       — fee recipient (defaults to deployer)
 *   USDT_ADDRESS / DEX_ROUTER_ADDRESS / WBNB_ADDRESS / USDC_ADDRESS — override
 *     the built-in NETWORK_CONFIG for unknown chains.
 */

const NETWORK_CONFIG: Record<
  string,
  {
    usdt: string;
    dexRouter: string;
    // Default partner bases. Must be real ERC20s — V2 factories cannot
    // create a pair with address(0). WBNB is what lives on the native-side
    // pair; the address(0) sentinel is only meaningful inside
    // PlatformRouter._payFee and LaunchInstance.buy.
    wbnb: string;
    usdc?: string;
  }
> = {
  bsc: {
    usdt: "0x55d398326f99059fF775485246999027B3197955",
    dexRouter: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
    wbnb: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    usdc: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  },
  bscTestnet: {
    usdt: "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd",
    dexRouter: "0xD99D1c33F9fC3444f8101754aBC46c52416550D1",
    wbnb: "0xae13d989dac2f0debff460ac112a837c89baa7cd",
  },
  ethereum: {
    usdt: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    dexRouter: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
    wbnb: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH on mainnet
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
};

const IMPL_CONTRACTS = [
  { typeKey: 0, name: "BasicTokenImpl" },
  { typeKey: 1, name: "MintableTokenImpl" },
  { typeKey: 2, name: "TaxableTokenImpl" },
  { typeKey: 3, name: "TaxableMintableTokenImpl" },
  { typeKey: 4, name: "PartnerTokenImpl" },
  { typeKey: 5, name: "PartnerMintableTokenImpl" },
  { typeKey: 6, name: "PartnerTaxableTokenImpl" },
  { typeKey: 7, name: "PartnerTaxableMintableTokenImpl" },
];

// Creation fees in USDT.
// Additive pricing: basic = $50, +$50 mint, +$50 tax, +$100 partner.
const CREATION_FEES_USDT_WHOLE: Record<number, number> = {
  0: 50,  // basic
  1: 100, // mintable
  2: 100, // taxable
  3: 150, // taxable + mintable
  4: 150, // partner
  5: 200, // partner + mintable
  6: 200, // partner + taxable
  7: 250, // partner + taxable + mintable
};

const LAUNCH_FEE_USDT_WHOLE = 200; // $200 launch fee

// TradeRouter slippage ceiling (bps). 2000 = 20%. Users pass tighter bounds
// on each swap; this is just the maximum the admin will ever allow.
const TRADE_ROUTER_MAX_SLIPPAGE_BPS = 2000;

async function verify(
  address: string,
  constructorArguments: any[] = [],
  libraries?: Record<string, string>
) {
  if (network.name === "hardhat" || network.name === "localhost") return;
  console.log(`  Verifying ${address}...`);
  try {
    const opts: any = { address, constructorArguments };
    if (libraries) opts.libraries = libraries;
    await run("verify:verify", opts);
    console.log(`  ✓ Verified`);
  } catch (e: any) {
    if (e.message?.toLowerCase().includes("already verified")) {
      console.log(`  ✓ Already verified`);
    } else {
      console.log(`  ✗ ${e.message?.slice(0, 120)}`);
    }
  }
}

function saveDeployment(networkName: string, data: Record<string, any>) {
  const dir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const filePath = path.join(dir, `${networkName}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`\nDeployment saved to: ${filePath}`);
}

function saveBuildInfo(networkName: string) {
  const buildInfoDir = path.join(__dirname, "..", "artifacts", "build-info");
  const dir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(buildInfoDir)) return;
  const files = fs.readdirSync(buildInfoDir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) return;
  const dest = path.join(dir, `${networkName}-build-info.json`);
  fs.copyFileSync(path.join(buildInfoDir, files[files.length - 1]), dest);
  console.log(`Build info saved to: ${dest}`);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const networkName = network.name;
  const chainId = (await ethers.provider.getNetwork()).chainId;

  console.log("\n" + "═".repeat(60));
  console.log("  TokenKrafter — Full Clean Deployment (USDT-only)");
  console.log("═".repeat(60));
  console.log(`  Network:  ${networkName} (chainId: ${chainId})`);
  console.log(`  Deployer: ${deployer.address}`);
  console.log(
    `  Balance:  ${ethers.formatEther(
      await ethers.provider.getBalance(deployer.address)
    )}`
  );
  console.log("─".repeat(60));

  // Resolve network config. Fall back to env overrides for unknown chains.
  const preset = NETWORK_CONFIG[networkName];
  const cfg = preset ?? {
    usdt: process.env.USDT_ADDRESS!,
    dexRouter: process.env.DEX_ROUTER_ADDRESS!,
    wbnb: process.env.WBNB_ADDRESS!,
    usdc: process.env.USDC_ADDRESS,
  };
  if (!cfg.usdt || !cfg.dexRouter || !cfg.wbnb) {
    throw new Error(
      `No config for "${networkName}". Set USDT_ADDRESS / DEX_ROUTER_ADDRESS / WBNB_ADDRESS env vars.`
    );
  }

  const { usdt, dexRouter, wbnb } = cfg;
  const usdc = cfg.usdc;
  const platformWallet = process.env.PLATFORM_WALLET || deployer.address;

  console.log(`  USDT:     ${usdt}`);
  console.log(`  DEX:      ${dexRouter}`);
  console.log(`  WBNB:     ${wbnb}`);
  if (usdc) console.log(`  USDC:     ${usdc}`);
  console.log(`  Wallet:   ${platformWallet}`);
  console.log("─".repeat(60));

  // Resolve USDT decimals once for fee scaling. BSC USDT is 18 decimals,
  // mainnet USDT is 6 — don't hard-code.
  const usdtContract = await ethers.getContractAt(
    ["function decimals() view returns (uint8)"],
    usdt
  );
  const usdtDecimals: number = Number(await usdtContract.decimals());
  console.log(`  USDT decimals: ${usdtDecimals}`);
  console.log("─".repeat(60));

  const scaleFee = (whole: number) =>
    ethers.parseUnits(String(whole), usdtDecimals);
  const CREATION_FEES_USDT: Record<number, bigint> = Object.fromEntries(
    Object.entries(CREATION_FEES_USDT_WHOLE).map(([k, v]) => [
      Number(k),
      scaleFee(v),
    ])
  ) as Record<number, bigint>;
  const LAUNCH_FEE_USDT = scaleFee(LAUNCH_FEE_USDT_WHOLE);

  const deployed: Record<string, any> = {
    Network: networkName,
    ChainId: Number(chainId),
    USDT: usdt,
    DEXRouter: dexRouter,
    WBNB: wbnb,
    PlatformWallet: platformWallet,
  };
  if (usdc) deployed.USDC = usdc;

  // ════════════════════════════════════════════════════════
  // 1. BondingCurve library
  // ════════════════════════════════════════════════════════
  console.log("\n[1/9] BondingCurve library...");
  const BondingCurve = await ethers.getContractFactory("BondingCurve");
  const bondingCurve = await BondingCurve.deploy();
  await bondingCurve.waitForDeployment();
  const bondingCurveAddr = await bondingCurve.getAddress();
  deployed.BondingCurve = bondingCurveAddr;
  console.log(`  → ${bondingCurveAddr}`);

  // ════════════════════════════════════════════════════════
  // 2. LaunchInstance implementation (for cloning)
  // ════════════════════════════════════════════════════════
  console.log("\n[2/9] LaunchInstance implementation...");
  const LaunchInstance = await ethers.getContractFactory("LaunchInstance", {
    libraries: { BondingCurve: bondingCurveAddr },
  });
  const launchImpl = await LaunchInstance.deploy();
  await launchImpl.waitForDeployment();
  const launchImplAddr = await launchImpl.getAddress();
  deployed.LaunchInstanceImpl = launchImplAddr;
  console.log(`  → ${launchImplAddr}`);

  // ════════════════════════════════════════════════════════
  // 3. Token implementations (8 types)
  // ════════════════════════════════════════════════════════
  console.log("\n[3/9] Token implementations...");
  const implAddresses: Record<number, string> = {};
  for (const impl of IMPL_CONTRACTS) {
    const F = await ethers.getContractFactory(impl.name);
    const c = await F.deploy();
    await c.waitForDeployment();
    const addr = await c.getAddress();
    implAddresses[impl.typeKey] = addr;
    deployed[impl.name] = addr;
    console.log(`  [${impl.typeKey}] ${impl.name}: ${addr}`);
  }

  // ════════════════════════════════════════════════════════
  // 4. TokenFactory
  // ════════════════════════════════════════════════════════
  console.log("\n[4/9] TokenFactory...");
  const TokenFactory = await ethers.getContractFactory("TokenFactory");
  const tokenFactory = await TokenFactory.deploy(
    usdt,
    dexRouter,
    platformWallet
  );
  await tokenFactory.waitForDeployment();
  const tokenFactoryAddr = await tokenFactory.getAddress();
  deployed.TokenFactory = tokenFactoryAddr;
  console.log(`  → ${tokenFactoryAddr}`);

  // ════════════════════════════════════════════════════════
  // 5. LaunchpadFactory
  // ════════════════════════════════════════════════════════
  console.log("\n[5/9] LaunchpadFactory...");
  const LaunchpadFactory = await ethers.getContractFactory("LaunchpadFactory");
  const launchpadFactory = await LaunchpadFactory.deploy(
    platformWallet,
    dexRouter,
    usdt,
    launchImplAddr
  );
  await launchpadFactory.waitForDeployment();
  const launchpadFactoryAddr = await launchpadFactory.getAddress();
  deployed.LaunchpadFactory = launchpadFactoryAddr;
  console.log(`  → ${launchpadFactoryAddr}`);

  // ════════════════════════════════════════════════════════
  // 6. PlatformRouter
  // ════════════════════════════════════════════════════════
  console.log("\n[6/9] PlatformRouter...");
  const PlatformRouter = await ethers.getContractFactory("PlatformRouter");
  const platformRouter = await PlatformRouter.deploy(
    tokenFactoryAddr,
    launchpadFactoryAddr,
    dexRouter
  );
  await platformRouter.waitForDeployment();
  const platformRouterAddr = await platformRouter.getAddress();
  deployed.PlatformRouter = platformRouterAddr;
  console.log(`  → ${platformRouterAddr}`);

  // ════════════════════════════════════════════════════════
  // 7. TradeRouter
  // ════════════════════════════════════════════════════════
  console.log("\n[7/9] TradeRouter...");
  const TradeRouter = await ethers.getContractFactory("TradeRouter");
  const tradeRouter = await TradeRouter.deploy(dexRouter, usdt, platformWallet);
  await tradeRouter.waitForDeployment();
  const tradeRouterAddr = await tradeRouter.getAddress();
  deployed.TradeRouter = tradeRouterAddr;
  console.log(`  → ${tradeRouterAddr}`);

  // ════════════════════════════════════════════════════════
  // 8. TradeLens
  // ════════════════════════════════════════════════════════
  console.log("\n[8/9] TradeLens...");
  const TradeLens = await ethers.getContractFactory("TradeLens");
  const tradeLens = await TradeLens.deploy();
  await tradeLens.waitForDeployment();
  const tradeLensAddr = await tradeLens.getAddress();
  deployed.TradeLens = tradeLensAddr;
  console.log(`  → ${tradeLensAddr}`);

  // ════════════════════════════════════════════════════════
  // 9. PlatformLens (optional)
  // ════════════════════════════════════════════════════════
  console.log("\n[9/9] PlatformLens...");
  try {
    const PlatformLens = await ethers.getContractFactory("PlatformLens");
    const platformLens = await PlatformLens.deploy();
    await platformLens.waitForDeployment();
    const platformLensAddr = await platformLens.getAddress();
    deployed.PlatformLens = platformLensAddr;
    console.log(`  → ${platformLensAddr}`);
  } catch {
    console.log("  Skipped (contract not found)");
  }

  // ════════════════════════════════════════════════════════
  // Configure TokenFactory
  // ════════════════════════════════════════════════════════
  console.log("\n" + "─".repeat(60));
  console.log("  Configuring TokenFactory...\n");

  // Batch-set all 8 implementations + creation fees in one tx.
  const implArr: [
    string, string, string, string, string, string, string, string
  ] = [
    implAddresses[0],
    implAddresses[1],
    implAddresses[2],
    implAddresses[3],
    implAddresses[4],
    implAddresses[5],
    implAddresses[6],
    implAddresses[7],
  ];
  const feeArr: [
    bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint
  ] = [
    CREATION_FEES_USDT[0],
    CREATION_FEES_USDT[1],
    CREATION_FEES_USDT[2],
    CREATION_FEES_USDT[3],
    CREATION_FEES_USDT[4],
    CREATION_FEES_USDT[5],
    CREATION_FEES_USDT[6],
    CREATION_FEES_USDT[7],
  ];
  process.stdout.write("  setImplementationsAndFees (batch)... ");
  await (await tokenFactory.setImplementationsAndFees(implArr, feeArr)).wait();
  console.log("✓");

  // Partner default bases. Order matters only for display; the factory
  // dedupes internally. Keep the order stable: USDT, WBNB, USDC.
  const defaultPartnerBases: string[] = [usdt, wbnb];
  if (usdc) defaultPartnerBases.push(usdc);
  process.stdout.write(
    `  setDefaultPartnerBases([${defaultPartnerBases.length}])... `
  );
  await (
    await tokenFactory.setDefaultPartnerBases(defaultPartnerBases)
  ).wait();
  console.log("✓");
  deployed.DefaultPartnerBases = defaultPartnerBases;

  // Authorize PlatformRouter to call routerCreateToken.
  process.stdout.write("  setAuthorizedRouter (TokenFactory)... ");
  await (await tokenFactory.setAuthorizedRouter(platformRouterAddr)).wait();
  console.log("✓");

  // ════════════════════════════════════════════════════════
  // Configure LaunchpadFactory
  // ════════════════════════════════════════════════════════
  console.log("\n  Configuring LaunchpadFactory...\n");

  process.stdout.write(`  setLaunchFee($${LAUNCH_FEE_USDT_WHOLE})... `);
  await (await launchpadFactory.setLaunchFee(LAUNCH_FEE_USDT)).wait();
  console.log("✓");

  process.stdout.write("  setCurveDefaults... ");
  await (
    await launchpadFactory.setCurveDefaults({
      linearSlope: 0n,
      linearIntercept: BigInt(1e16),
      sqrtCoefficient: BigInt(1e16),
      quadraticCoefficient: 1n,
      expBase: BigInt(1e16),
      expKFactor: BigInt(1e12),
    })
  ).wait();
  console.log("✓");

  process.stdout.write("  setAuthorizedRouter (LaunchpadFactory)... ");
  await (
    await launchpadFactory.setAuthorizedRouter(platformRouterAddr)
  ).wait();
  console.log("✓");

  // ════════════════════════════════════════════════════════
  // Configure TradeRouter
  // ════════════════════════════════════════════════════════
  console.log("\n  Configuring TradeRouter...\n");

  process.stdout.write(
    `  setMaxSlippage(${TRADE_ROUTER_MAX_SLIPPAGE_BPS} bps)... `
  );
  await (
    await tradeRouter.setMaxSlippage(TRADE_ROUTER_MAX_SLIPPAGE_BPS)
  ).wait();
  console.log("✓");

  // ════════════════════════════════════════════════════════
  // Verify all contracts on the explorer
  // ════════════════════════════════════════════════════════
  if (network.name !== "hardhat" && network.name !== "localhost") {
    console.log("\n" + "─".repeat(60));
    console.log("  Verifying on explorer...\n");
    console.log("  Waiting 20s for indexing...");
    await new Promise((r) => setTimeout(r, 20000));

    await verify(bondingCurveAddr);
    await verify(launchImplAddr, [], { BondingCurve: bondingCurveAddr });
    for (const impl of IMPL_CONTRACTS) {
      await verify(implAddresses[impl.typeKey]);
    }
    await verify(tokenFactoryAddr, [usdt, dexRouter, platformWallet]);
    await verify(launchpadFactoryAddr, [
      platformWallet,
      dexRouter,
      usdt,
      launchImplAddr,
    ]);
    await verify(platformRouterAddr, [
      tokenFactoryAddr,
      launchpadFactoryAddr,
      dexRouter,
    ]);
    await verify(tradeRouterAddr, [dexRouter, usdt, platformWallet]);
    await verify(tradeLensAddr);
    if (deployed.PlatformLens) await verify(deployed.PlatformLens);
  }

  // ════════════════════════════════════════════════════════
  // Summary
  // ════════════════════════════════════════════════════════
  console.log("\n" + "═".repeat(60));
  console.log("  DEPLOYMENT COMPLETE");
  console.log("═".repeat(60));
  console.log();

  const summary: [string, string][] = [
    ["BondingCurve", bondingCurveAddr],
    ["LaunchInstance (impl)", launchImplAddr],
    ["TokenFactory", tokenFactoryAddr],
    ["LaunchpadFactory", launchpadFactoryAddr],
    ["PlatformRouter", platformRouterAddr],
    ["TradeRouter", tradeRouterAddr],
    ["TradeLens", tradeLensAddr],
  ];
  if (deployed.PlatformLens) summary.push(["PlatformLens", deployed.PlatformLens]);

  for (const [name, addr] of summary) {
    console.log(`  ${name.padEnd(22)} ${addr}`);
  }

  console.log("\n  Token Implementations:");
  for (const impl of IMPL_CONTRACTS) {
    console.log(
      `    [${impl.typeKey}] ${impl.name.padEnd(30)} ${implAddresses[impl.typeKey]}`
    );
  }

  console.log("\n  Fees (USDT):");
  for (const [typeKey, fee] of Object.entries(CREATION_FEES_USDT)) {
    console.log(
      `    Type ${typeKey}: $${ethers.formatUnits(fee, usdtDecimals)}`
    );
  }
  console.log(
    `    Launch: $${ethers.formatUnits(LAUNCH_FEE_USDT, usdtDecimals)}`
  );
  console.log(`    Buy fee: 1% (per buy on bonding curve)`);
  console.log(`    Graduation fee: 1% (USDT + tokens)`);

  console.log("\n  Partner default bases:");
  for (const b of defaultPartnerBases) console.log(`    ${b}`);

  console.log("\n  Update Supabase supported_networks:");
  console.log(`    platform_address:      "${tokenFactoryAddr}"`);
  console.log(`    launchpad_address:     "${launchpadFactoryAddr}"`);
  console.log(`    router_address:        "${platformRouterAddr}"`);
  console.log(`    trade_router_address:  "${tradeRouterAddr}"`);
  console.log(`    trade_lens_address:    "${tradeLensAddr}"`);
  console.log("═".repeat(60));

  saveDeployment(networkName, deployed);
  saveBuildInfo(networkName);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
