import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * TokenKrafter — Final consolidated deployment script.
 *
 * Deploys the full contract stack on the target network and writes
 * addresses to deployments/{network}.json.
 *
 *   1. BondingCurve library
 *   2. LaunchInstance impl
 *   3. 8 token impls
 *   4. TokenFactory
 *   5. LaunchpadFactory
 *   6. PlatformRouter
 *   7. TradeRouter
 *   8. Affiliate
 *
 * Lens contracts under `contracts/simulators/` (TradeLens, AdminLens,
 * ExploreLens, LaunchLens, LaunchPreflight, MultiCallLens, PlatformLensV2,
 * RouteFinder, SafuLens, TradeLensV2, PlatformLens) are eth_call / state-
 * override simulators and are NOT deployed here.
 *
 * Then configures:
 *   - setImplementationsAndFees on TokenFactory (new pricing)
 *   - setDefaultPartnerBases on TokenFactory (USDT, WBNB, USDC)
 *   - setAuthorizedRouter on both factories
 *   - setCurveDefaults on LaunchpadFactory
 *   - setMaxSlippage on TradeRouter
 *   - setFeeBps(150) on TradeRouter
 *   - Affiliate wiring: setAffiliate on TokenFactory / LaunchpadFactory /
 *     TradeRouter + Affiliate.setAuthorizedFactory(launchpadFactory) so
 *     clones auto-whitelist + Affiliate.setAuthorized for the two long-
 *     lived reporters (TokenFactory, TradeRouter)
 *
 * Resume / fail-safe behavior:
 *   - After each deploy step, the address is written to
 *     deployments/{network}.json IMMEDIATELY so a transport failure
 *     (RPC timeout, disconnect) doesn't lose progress.
 *   - On re-run, any key already present in the JSON is reused via
 *     getContractAt — no redeploy. Pass DEPLOY_FRESH=1 to force a clean
 *     redeploy (archives previous addresses under `{Key}_Old`).
 *
 * Verification + Supabase update + VPS daemon refresh are done by
 * separate scripts after this completes:
 *   - bun scripts/verify-v2-batch.mjs           (BscScan via Etherscan V2)
 *   - bun ../scripts/_update-bsc-config.mjs     (Supabase platform_config)
 *   - bash scripts/redeploy-vps-daemons.sh      (VPS systemd restart)
 *
 * Usage:
 *   - Direct:   npx hardhat run scripts/deploy.ts --network bsc
 *   - With DB RPC (recommended — pulls daemon_rpc from Supabase):
 *                bun scripts/deploy-bsc.mjs
 *
 * Env vars:
 *   DEPLOYER_PRIVATE_KEY  — owner wallet (read by hardhat.config.ts)
 *   PLATFORM_WALLET       — platform fee recipient (defaults to deployer)
 *   BSC_RPC_URL           — override public RPC (set by deploy-bsc.mjs)
 *   DEPLOY_FRESH=1        — archive existing addresses under _Old, deploy fresh
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

// Look up a key in ../web/.env — the off-ramp daemon lives there, so
// ADMIN_KEY is defined alongside its runtime.
function readEnvFromWeb(key: string): string | undefined {
  const webEnv = path.join(__dirname, "..", "..", "web", ".env");
  if (!fs.existsSync(webEnv)) return undefined;
  const src = fs.readFileSync(webEnv, "utf8");
  const m = src.match(new RegExp(`^${key}=(.*)$`, "m"));
  if (!m) return undefined;
  return m[1].replace(/^["']|["']$/g, "").trim();
}

function archiveOld(state: any, key: string) {
  if (state[key]) state[`${key}_Old`] = state[key];
  delete state[key];
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

  // ── Load / init deployment state (resumable) ──
  const dir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const statePath = path.join(dir, `${networkName}.json`);
  let state: any = {};
  if (fs.existsSync(statePath)) {
    try {
      state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    } catch {}
  }

  const fresh = process.env.DEPLOY_FRESH === "1";
  if (fresh) {
    // Move all tracked keys to `{Key}_Old` so nothing is deleted, but the
    // deploy loop sees them as unset and redeploys.
    for (const key of [
      "BondingCurve",
      "LaunchInstanceImpl",
      ...IMPL_NAMES,
      "TokenFactory",
      "LaunchpadFactory",
      "PlatformRouter",
      "TradeRouter",
      "Affiliate",
    ]) {
      archiveOld(state, key);
    }
    // Also reset config completion flags.
    state.ConfigDone = {};
  }

  state.Network = networkName;
  state.ChainId = chainId;
  state.USDT = cfg.usdt;
  state.DEXRouter = cfg.dexRouter;
  state.WBNB = cfg.wbnb;
  state.PlatformWallet = platformWallet;
  state.Deployer = deployer.address;
  if (cfg.usdc) state.USDC = cfg.usdc;
  state.ConfigDone = state.ConfigDone || {};

  const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  save(); // flush the header fields

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
  Mode:           ${fresh ? "FRESH (archiving prior addresses)" : "resume (reusing existing addresses)"}
──────────────────────────────────────────────────────────`);

  const scaleFee = (whole: number) =>
    ethers.parseUnits(String(whole), usdtDecimals);

  // Deploy-or-reuse helper: if state[key] is set, attach via getContractAt;
  // otherwise call `deploy()` and persist the new address immediately.
  async function deployOrReuse<T = any>(
    step: string,
    key: string,
    factoryName: string,
    deploy: (F: any) => Promise<any>,
    opts?: { libraries?: Record<string, string> }
  ): Promise<{ contract: T; addr: string }> {
    const existing = state[key];
    if (existing && ethers.isAddress(existing)) {
      console.log(`\n${step} ${factoryName}... (reuse)`);
      const c = await ethers.getContractAt(factoryName, existing);
      console.log(`  → ${existing}`);
      return { contract: c as any, addr: existing };
    }
    console.log(`\n${step} ${factoryName}...`);
    const F = opts?.libraries
      ? await ethers.getContractFactory(factoryName, { libraries: opts.libraries })
      : await ethers.getContractFactory(factoryName);
    const c = await (await deploy(F)).waitForDeployment();
    const addr = await c.getAddress();
    state[key] = addr;
    save();
    console.log(`  → ${addr}`);
    return { contract: c as any, addr };
  }

  // 1. BondingCurve
  const { addr: bondingCurveAddr } = await deployOrReuse(
    "[1/8]",
    "BondingCurve",
    "BondingCurve",
    (F) => F.deploy()
  );

  // 2a. LaunchMath library (links BondingCurve, then LaunchInstance
  //     links LaunchMath). Routing the curve dispatch + previewBuy
  //     math through LaunchMath kept LaunchInstance under EIP-170.
  const { addr: launchMathAddr } = await deployOrReuse(
    "[2/8]",
    "LaunchMath",
    "LaunchMath",
    (F) => F.deploy(),
    { libraries: { BondingCurve: bondingCurveAddr } }
  );

  // 2b. LaunchInstance impl (links LaunchMath only)
  const { addr: launchImplAddr } = await deployOrReuse(
    "[2/8]",
    "LaunchInstanceImpl",
    "LaunchInstance",
    (F) => F.deploy(),
    { libraries: { LaunchMath: launchMathAddr } }
  );

  // 3. 8 token impls
  console.log("\n[3/8] Token impls...");
  const implAddresses: string[] = [];
  for (let i = 0; i < IMPL_NAMES.length; i++) {
    const name = IMPL_NAMES[i];
    const existing = state[name];
    if (existing && ethers.isAddress(existing)) {
      console.log(`  [${i}] ${name}: ${existing} (reuse)`);
      implAddresses.push(existing);
      continue;
    }
    const F = await ethers.getContractFactory(name);
    const c = await (await F.deploy()).waitForDeployment();
    const addr = await c.getAddress();
    implAddresses.push(addr);
    state[name] = addr;
    save();
    console.log(`  [${i}] ${name}: ${addr}`);
  }

  // 4. TokenFactory
  const { contract: tokenFactory, addr: tokenFactoryAddr } = await deployOrReuse(
    "[4/8]",
    "TokenFactory",
    "TokenFactory",
    (F) => F.deploy(cfg.usdt, cfg.dexRouter, platformWallet)
  );

  // 5. LaunchpadFactory
  const { contract: launchpadFactory, addr: launchpadFactoryAddr } =
    await deployOrReuse(
      "[5/8]",
      "LaunchpadFactory",
      "LaunchpadFactory",
      (F) => F.deploy(platformWallet, cfg.dexRouter, cfg.usdt, launchImplAddr)
    );

  // 6. PlatformRouter
  const { addr: platformRouterAddr } = await deployOrReuse(
    "[6/8]",
    "PlatformRouter",
    "PlatformRouter",
    (F) => F.deploy(tokenFactoryAddr, launchpadFactoryAddr, cfg.dexRouter)
  );

  // 7. TradeRouter
  const { contract: tradeRouter, addr: tradeRouterAddr } = await deployOrReuse(
    "[7/8]",
    "TradeRouter",
    "TradeRouter",
    (F) => F.deploy(cfg.dexRouter, cfg.usdt, platformWallet)
  );

  // 8. Affiliate (admin = deployer so onlyOwner setters work from this
  //    script; hand off via transferOwnership later if you want a separate
  //    multisig owner).
  const { contract: affiliate, addr: affiliateAddr } = await deployOrReuse(
    "[8/8]",
    "Affiliate",
    "Affiliate",
    (F) => F.deploy(cfg.usdt, deployer.address)
  );

  // ── Configure ──
  console.log("\n──────────────────────────────────────────────────────────");
  console.log("  Configuring contracts...\n");

  // Idempotent config helper: skip if the step ID is already recorded in
  // state.ConfigDone. Setters are idempotent at the state level (same
  // value in → same value out), but tx costs gas — skipping saves both
  // gas and time on resume.
  async function configStep(id: string, label: string, run: () => Promise<any>) {
    if (state.ConfigDone[id]) {
      console.log(`  ${label} (done)`);
      return;
    }
    process.stdout.write(`  ${label}... `);
    const tx = await run();
    await tx.wait();
    state.ConfigDone[id] = true;
    save();
    console.log("✓");
  }

  const fees = CREATION_FEES_WHOLE.map(scaleFee) as [
    bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint
  ];
  await configStep(
    "TokenFactory.setImplementationsAndFees",
    "TokenFactory.setImplementationsAndFees",
    () =>
      tokenFactory.setImplementationsAndFees(
        implAddresses as [string, string, string, string, string, string, string, string],
        fees
      )
  );

  const partnerBases = [cfg.usdt, cfg.wbnb];
  if (cfg.usdc) partnerBases.push(cfg.usdc);
  await configStep(
    "TokenFactory.setDefaultPartnerBases",
    `TokenFactory.setDefaultPartnerBases (${partnerBases.length})`,
    () => tokenFactory.setDefaultPartnerBases(partnerBases)
  );
  state.DefaultPartnerBases = partnerBases;
  save();

  await configStep(
    "TokenFactory.setAuthorizedRouter",
    "TokenFactory.setAuthorizedRouter",
    () => tokenFactory.setAuthorizedRouter(platformRouterAddr)
  );

  await configStep(
    "LaunchpadFactory.setAuthorizedRouter",
    "LaunchpadFactory.setAuthorizedRouter",
    () => launchpadFactory.setAuthorizedRouter(platformRouterAddr)
  );

  await configStep(
    "LaunchpadFactory.setCurveDefaults",
    "LaunchpadFactory.setCurveDefaults",
    () =>
      launchpadFactory.setCurveDefaults({
        linearSlope: 0n,
        linearIntercept: BigInt(1e16),
        sqrtCoefficient: BigInt(1e16),
        quadraticCoefficient: 1n,
        expBase: BigInt(1e16),
        expKFactor: BigInt(1e12),
      })
  );

  await configStep(
    "TradeRouter.setFeeBps",
    `TradeRouter.setFeeBps(${TRADE_ROUTER_FEE_BPS})`,
    () => tradeRouter.setFeeBps(TRADE_ROUTER_FEE_BPS)
  );

  await configStep(
    "TradeRouter.setMaxSlippage",
    `TradeRouter.setMaxSlippage(${TRADE_ROUTER_MAX_SLIPPAGE_BPS} bps)`,
    () => tradeRouter.setMaxSlippage(TRADE_ROUTER_MAX_SLIPPAGE_BPS)
  );

  // Affiliate wiring — must happen after all three reporters exist.
  await configStep(
    "TokenFactory.setAffiliate",
    "TokenFactory.setAffiliate",
    () => tokenFactory.setAffiliate(affiliateAddr)
  );
  await configStep(
    "LaunchpadFactory.setAffiliate",
    "LaunchpadFactory.setAffiliate",
    () => launchpadFactory.setAffiliate(affiliateAddr)
  );
  await configStep(
    "TradeRouter.setAffiliate",
    "TradeRouter.setAffiliate",
    () => tradeRouter.setAffiliate(affiliateAddr)
  );
  await configStep(
    "Affiliate.setAuthorizedFactory",
    "Affiliate.setAuthorizedFactory(LaunchpadFactory)",
    () => affiliate.setAuthorizedFactory(launchpadFactoryAddr, true)
  );
  await configStep(
    "Affiliate.setAuthorized.TokenFactory",
    "Affiliate.setAuthorized(TokenFactory)",
    () => affiliate.setAuthorized(tokenFactoryAddr, true)
  );
  await configStep(
    "Affiliate.setAuthorized.TradeRouter",
    "Affiliate.setAuthorized(TradeRouter)",
    () => affiliate.setAuthorized(tradeRouterAddr, true)
  );

  // Add the off-ramp daemon's wallet as TradeRouter admin so it can call
  // confirm() / refund() on user withdrawals. Prefer ADMIN_ADDRESS if set;
  // otherwise derive from ADMIN_KEY (read from project root web/.env so a
  // single source of truth covers both deploy and the running daemon).
  let adminAddr: string | undefined = process.env.ADMIN_ADDRESS;
  if (!adminAddr) {
    const adminKey = process.env.ADMIN_KEY ?? readEnvFromWeb("ADMIN_KEY");
    if (adminKey) {
      try {
        adminAddr = new ethers.Wallet(adminKey).address;
      } catch {
        console.warn("  ADMIN_KEY present but invalid — cannot derive address");
      }
    }
  }
  if (
    adminAddr &&
    ethers.isAddress(adminAddr) &&
    adminAddr.toLowerCase() !== deployer.address.toLowerCase()
  ) {
    await configStep(
      `TradeRouter.addAdmin.${adminAddr.toLowerCase()}`,
      `TradeRouter.addAdmin(${adminAddr})`,
      () => tradeRouter.addAdmin(adminAddr!)
    );
  } else {
    console.log("  TradeRouter.addAdmin: skipped (no ADMIN_ADDRESS / ADMIN_KEY)");
  }

  // ── Save build-info for verification ──
  // The deployed contracts reference their build-info via the .dbg.json
  // sibling file, so read that instead of guessing — handles the case
  // where artifacts/build-info/ has stale files from earlier compilations.
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
      console.log(`\n  Build-info ${biFile} saved to ${networkName}-build-info.json`);
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
  Affiliate          ${affiliateAddr}
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
