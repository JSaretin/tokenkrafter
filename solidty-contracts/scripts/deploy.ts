import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * TokenKrafter — Final consolidated deployment script.
 *
 * Deploys the full contract stack from scratch on the target network and
 * writes addresses to deployments/{network}.json.
 *
 *   1. BondingCurve library
 *   2. LaunchInstance impl
 *   3. 8 token impls
 *   4. TokenFactory
 *   5. LaunchpadFactory
 *   6. PlatformRouter
 *   7. TradeRouter
 *   8. TradeLens
 *
 * Then configures:
 *   - setImplementationsAndFees on TokenFactory (new pricing)
 *   - setDefaultPartnerBases on TokenFactory (USDT, WBNB, USDC)
 *   - setAuthorizedRouter on both factories
 *   - setCurveDefaults on LaunchpadFactory
 *   - setMaxSlippage on TradeRouter
 *   - setFeeBps(150) on TradeRouter
 *
 * Verification + Supabase update + VPS daemon refresh are done by
 * separate scripts after this completes:
 *   - bun scripts/verify-v2-batch.mjs           (BscScan via Etherscan V2)
 *   - bun ../scripts/_update-bsc-config.mjs     (Supabase platform_config)
 *   - bash scripts/redeploy-vps-daemons.sh      (VPS systemd restart)
 *
 * Usage: npx hardhat run scripts/deploy.ts --network bsc
 *
 * Env vars:
 *   DEPLOYER_PRIVATE_KEY  — owner wallet (read by hardhat.config.ts)
 *   PLATFORM_WALLET       — platform fee recipient (defaults to deployer)
 *   USDT_ADDRESS / DEX_ROUTER_ADDRESS / WBNB_ADDRESS / USDC_ADDRESS
 *     — override the built-in NETWORK_CONFIG for unknown chains
 */

const NETWORK_CONFIG: Record<
  string,
  { usdt: string; dexRouter: string; wbnb: string; usdc?: string }
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
};

const IMPL_NAMES = [
  "BasicTokenImpl",
  "MintableTokenImpl",
  "TaxableTokenImpl",
  "TaxableMintableTokenImpl",
  "PartnerTokenImpl",
  "PartnerMintableTokenImpl",
  "PartnerTaxableTokenImpl",
  "PartnerTaxableMintableTokenImpl",
];

// Creation fees in whole USDT.
// Basic $5, +Mint +$5, +Tax +$5, Partner $100 floor (premium tier).
const CREATION_FEES_WHOLE = [5, 10, 10, 15, 100, 120, 120, 150];

// TradeRouter off-ramp config.
const TRADE_ROUTER_FEE_BPS = 150; // 1.5%
const TRADE_ROUTER_MAX_SLIPPAGE_BPS = 2000; // 20% ceiling for user-passed slippage

function archiveOld(existing: any, key: string) {
  if (existing[key]) existing[`${key}_Old`] = existing[key];
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const networkName = network.name;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  const cfg =
    NETWORK_CONFIG[networkName] ?? {
      usdt: process.env.USDT_ADDRESS!,
      dexRouter: process.env.DEX_ROUTER_ADDRESS!,
      wbnb: process.env.WBNB_ADDRESS!,
      usdc: process.env.USDC_ADDRESS,
    };
  if (!cfg.usdt || !cfg.dexRouter || !cfg.wbnb) {
    throw new Error(
      `Missing config for "${networkName}". Set USDT_ADDRESS / DEX_ROUTER_ADDRESS / WBNB_ADDRESS env vars.`
    );
  }

  const platformWallet = process.env.PLATFORM_WALLET || deployer.address;
  const usdt = await ethers.getContractAt(
    ["function decimals() view returns (uint8)"],
    cfg.usdt
  );
  const usdtDecimals = Number(await usdt.decimals());

  console.log(`
╔══════════════════════════════════════════════════════════╗
║        TokenKrafter — Final Stack Deployment             ║
╚══════════════════════════════════════════════════════════╝
  Network:        ${networkName} (chainId ${chainId})
  Deployer:       ${deployer.address}
  Balance:        ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} BNB
  Platform wallet:${platformWallet}
  USDT:           ${cfg.usdt} (${usdtDecimals} decimals)
  DEX router:     ${cfg.dexRouter}
  WBNB:           ${cfg.wbnb}
  USDC:           ${cfg.usdc ?? "—"}
──────────────────────────────────────────────────────────`);

  const scaleFee = (whole: number) =>
    ethers.parseUnits(String(whole), usdtDecimals);

  const deployed: Record<string, any> = {
    Network: networkName,
    ChainId: chainId,
    USDT: cfg.usdt,
    DEXRouter: cfg.dexRouter,
    WBNB: cfg.wbnb,
    PlatformWallet: platformWallet,
  };
  if (cfg.usdc) deployed.USDC = cfg.usdc;

  // ── Load existing deployment so we can archive old addresses ──
  const dir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const bscPath = path.join(dir, `${networkName}.json`);
  let existing: any = {};
  if (fs.existsSync(bscPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(bscPath, "utf8"));
    } catch {}
  }

  // 1. BondingCurve
  console.log("\n[1/8] BondingCurve library...");
  const BondingCurve = await ethers.getContractFactory("BondingCurve");
  const bondingCurve = await (await BondingCurve.deploy()).waitForDeployment();
  const bondingCurveAddr = await bondingCurve.getAddress();
  deployed.BondingCurve = bondingCurveAddr;
  console.log(`  → ${bondingCurveAddr}`);

  // 2. LaunchInstance impl
  console.log("\n[2/8] LaunchInstance impl...");
  const LaunchInstance = await ethers.getContractFactory("LaunchInstance", {
    libraries: { BondingCurve: bondingCurveAddr },
  });
  const launchImpl = await (await LaunchInstance.deploy()).waitForDeployment();
  const launchImplAddr = await launchImpl.getAddress();
  deployed.LaunchInstanceImpl = launchImplAddr;
  console.log(`  → ${launchImplAddr}`);

  // 3. 8 token impls
  console.log("\n[3/8] Token impls...");
  const implAddresses: string[] = [];
  for (let i = 0; i < IMPL_NAMES.length; i++) {
    const F = await ethers.getContractFactory(IMPL_NAMES[i]);
    const c = await (await F.deploy()).waitForDeployment();
    const addr = await c.getAddress();
    implAddresses.push(addr);
    deployed[IMPL_NAMES[i]] = addr;
    console.log(`  [${i}] ${IMPL_NAMES[i]}: ${addr}`);
  }

  // 4. TokenFactory
  console.log("\n[4/8] TokenFactory...");
  const TokenFactory = await ethers.getContractFactory("TokenFactory");
  const tokenFactory = await (
    await TokenFactory.deploy(cfg.usdt, cfg.dexRouter, platformWallet)
  ).waitForDeployment();
  const tokenFactoryAddr = await tokenFactory.getAddress();
  deployed.TokenFactory = tokenFactoryAddr;
  console.log(`  → ${tokenFactoryAddr}`);

  // 5. LaunchpadFactory
  console.log("\n[5/8] LaunchpadFactory...");
  const LaunchpadFactory = await ethers.getContractFactory("LaunchpadFactory");
  const launchpadFactory = await (
    await LaunchpadFactory.deploy(
      platformWallet,
      cfg.dexRouter,
      cfg.usdt,
      launchImplAddr
    )
  ).waitForDeployment();
  const launchpadFactoryAddr = await launchpadFactory.getAddress();
  deployed.LaunchpadFactory = launchpadFactoryAddr;
  console.log(`  → ${launchpadFactoryAddr}`);

  // 6. PlatformRouter
  console.log("\n[6/8] PlatformRouter...");
  const PlatformRouter = await ethers.getContractFactory("PlatformRouter");
  const platformRouter = await (
    await PlatformRouter.deploy(
      tokenFactoryAddr,
      launchpadFactoryAddr,
      cfg.dexRouter
    )
  ).waitForDeployment();
  const platformRouterAddr = await platformRouter.getAddress();
  deployed.PlatformRouter = platformRouterAddr;
  console.log(`  → ${platformRouterAddr}`);

  // 7. TradeRouter
  console.log("\n[7/8] TradeRouter...");
  const TradeRouter = await ethers.getContractFactory("TradeRouter");
  const tradeRouter = await (
    await TradeRouter.deploy(cfg.dexRouter, cfg.usdt, platformWallet)
  ).waitForDeployment();
  const tradeRouterAddr = await tradeRouter.getAddress();
  deployed.TradeRouter = tradeRouterAddr;
  console.log(`  → ${tradeRouterAddr}`);

  // 8. TradeLens
  console.log("\n[8/8] TradeLens...");
  const TradeLens = await ethers.getContractFactory("TradeLens");
  const tradeLens = await (await TradeLens.deploy()).waitForDeployment();
  const tradeLensAddr = await tradeLens.getAddress();
  deployed.TradeLens = tradeLensAddr;
  console.log(`  → ${tradeLensAddr}`);

  // ── Configure ──
  console.log("\n──────────────────────────────────────────────────────────");
  console.log("  Configuring contracts...\n");

  const fees = CREATION_FEES_WHOLE.map(scaleFee) as [
    bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint
  ];
  process.stdout.write("  TokenFactory.setImplementationsAndFees... ");
  await (
    await tokenFactory.setImplementationsAndFees(
      implAddresses as [string, string, string, string, string, string, string, string],
      fees
    )
  ).wait();
  console.log("✓");

  const partnerBases = [cfg.usdt, cfg.wbnb];
  if (cfg.usdc) partnerBases.push(cfg.usdc);
  process.stdout.write(`  TokenFactory.setDefaultPartnerBases (${partnerBases.length})... `);
  await (await tokenFactory.setDefaultPartnerBases(partnerBases)).wait();
  console.log("✓");
  deployed.DefaultPartnerBases = partnerBases;

  process.stdout.write("  TokenFactory.setAuthorizedRouter... ");
  await (await tokenFactory.setAuthorizedRouter(platformRouterAddr)).wait();
  console.log("✓");

  process.stdout.write("  LaunchpadFactory.setAuthorizedRouter... ");
  await (
    await launchpadFactory.setAuthorizedRouter(platformRouterAddr)
  ).wait();
  console.log("✓");

  process.stdout.write("  LaunchpadFactory.setCurveDefaults... ");
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

  process.stdout.write(`  TradeRouter.setFeeBps(${TRADE_ROUTER_FEE_BPS})... `);
  await (await tradeRouter.setFeeBps(TRADE_ROUTER_FEE_BPS)).wait();
  console.log("✓");

  process.stdout.write(
    `  TradeRouter.setMaxSlippage(${TRADE_ROUTER_MAX_SLIPPAGE_BPS} bps)... `
  );
  await (
    await tradeRouter.setMaxSlippage(TRADE_ROUTER_MAX_SLIPPAGE_BPS)
  ).wait();
  console.log("✓");

  // Add the off-ramp daemon's wallet as TradeRouter admin so it can call
  // confirm() / refund() on user withdrawals. ADMIN_ADDRESS (or derived
  // from ADMIN_KEY in the project root .env) is required for off-ramp to
  // work — without it only the deployer can confirm.
  const adminAddr = process.env.ADMIN_ADDRESS;
  if (adminAddr && ethers.isAddress(adminAddr) && adminAddr.toLowerCase() !== deployer.address.toLowerCase()) {
    process.stdout.write(`  TradeRouter.addAdmin(${adminAddr})... `);
    await (await tradeRouter.addAdmin(adminAddr)).wait();
    console.log("✓");
  } else {
    console.log("  TradeRouter.addAdmin: skipped (ADMIN_ADDRESS env not set)");
  }

  // ── Save deployment ──
  // Archive old addresses under _Old keys so we can roll back if needed.
  for (const key of [
    "TokenFactory",
    "LaunchpadFactory",
    "PlatformRouter",
    "TradeRouter",
    "TradeLens",
    "BondingCurve",
    "LaunchInstanceImpl",
    ...IMPL_NAMES,
  ]) {
    archiveOld(existing, key);
  }
  Object.assign(existing, deployed);
  fs.writeFileSync(bscPath, JSON.stringify(existing, null, 2));
  console.log(`\n  Deployment saved to ${bscPath}`);

  // Save build-info for verification. The deployed contracts reference
  // their build-info via the .dbg.json sibling file, so read that instead
  // of guessing — handles the case where artifacts/build-info/ has stale
  // files from earlier compilations.
  const biDir = path.join(__dirname, "..", "artifacts", "build-info");
  const dbgPath = path.join(
    __dirname,
    "..",
    "artifacts",
    "contracts",
    "TokenFactory.sol",
    "TokenFactory.dbg.json"
  );
  if (fs.existsSync(dbgPath) && fs.existsSync(biDir)) {
    const dbg = JSON.parse(fs.readFileSync(dbgPath, "utf8"));
    const biFile = path.basename(dbg.buildInfo);
    const biSrc = path.join(biDir, biFile);
    if (fs.existsSync(biSrc)) {
      fs.copyFileSync(biSrc, path.join(dir, `${networkName}-build-info.json`));
      console.log(`  Build-info ${biFile} saved to ${networkName}-build-info.json`);
    }
  }

  // ── Summary ──
  console.log(`
╔══════════════════════════════════════════════════════════╗
║                    DEPLOYMENT COMPLETE                   ║
╚══════════════════════════════════════════════════════════╝

  TokenFactory       ${tokenFactoryAddr}
  LaunchpadFactory   ${launchpadFactoryAddr}
  PlatformRouter     ${platformRouterAddr}
  TradeRouter        ${tradeRouterAddr}
  TradeLens          ${tradeLensAddr}
  BondingCurve       ${bondingCurveAddr}
  LaunchInstanceImpl ${launchImplAddr}

  Token impls:
${IMPL_NAMES.map((n, i) => `    [${i}] ${n.padEnd(34)} ${implAddresses[i]}`).join("\n")}

──────────────────────────────────────────────────────────
  NEXT STEPS:

  1. Verify on BscScan:
       node scripts/verify-v2-batch.mjs

  2. Push addresses to Supabase:
       cd .. && bun scripts/_update-bsc-config.mjs

  3. Refresh VPS daemons (rebuild + restart):
       cd .. && bash scripts/redeploy-vps-daemons.sh
──────────────────────────────────────────────────────────`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
