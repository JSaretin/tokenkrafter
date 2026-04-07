import { ethers, run, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * TokenKrafter V2 — Full Clean Deployment
 *
 * Deploys ALL contracts from scratch:
 *   1. BondingCurve library
 *   2. LaunchInstance implementation (for cloning)
 *   3. 8 Token implementations
 *   4. TokenFactory
 *   5. LaunchpadFactory (with LaunchInstance impl)
 *   6. PlatformRouter
 *   7. TradeRouter
 *   8. TradeLens
 *   9. PlatformLens
 *
 * Post-deploy: configures all cross-references, fees, and payment tokens.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-v2.ts --network bsc
 *
 * Environment:
 *   DEPLOYER_PRIVATE_KEY  — deployer wallet (in hardhat.config.ts)
 *   PLATFORM_WALLET       — fee recipient (defaults to deployer)
 */

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

// Creation fees in USDT (18 decimals on BSC)
// type 0=basic, 1=mintable, 2=taxable, 3=tax+mint, 4=partner, 5=partner+mint, 6=partner+tax, 7=partner+tax+mint
const CREATION_FEES_USDT: Record<number, bigint> = {
	0: ethers.parseUnits("50", 18),     // $50 basic
	1: ethers.parseUnits("100", 18),    // $100 mintable
	2: ethers.parseUnits("100", 18),    // $100 taxable
	3: ethers.parseUnits("150", 18),    // $150 taxable + mintable
	4: ethers.parseUnits("150", 18),    // $150 partner
	5: ethers.parseUnits("200", 18),    // $200 partner + mintable
	6: ethers.parseUnits("200", 18),    // $200 partner + taxable
	7: ethers.parseUnits("250", 18),    // $250 partner + taxable + mintable
};

const LAUNCH_FEE_USDT = ethers.parseUnits("200", 18); // $200 launch fee

async function verify(address: string, constructorArguments: any[] = [], libraries?: Record<string, string>) {
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
			console.log(`  ✗ ${e.message?.slice(0, 100)}`);
		}
	}
}

function saveDeployment(networkName: string, data: Record<string, string>) {
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
	const files = fs.readdirSync(buildInfoDir).filter(f => f.endsWith(".json"));
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
	console.log("  TokenKrafter V2 — Full Clean Deployment");
	console.log("═".repeat(60));
	console.log(`  Network:  ${networkName} (chainId: ${chainId})`);
	console.log(`  Deployer: ${deployer.address}`);
	console.log(`  Balance:  ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} BNB`);
	console.log("─".repeat(60));

	// Resolve network config
	const cfg = NETWORK_CONFIG[networkName] || {
		usdt: process.env.USDT_ADDRESS!,
		dexRouter: process.env.DEX_ROUTER_ADDRESS!,
		usdc: process.env.USDC_ADDRESS,
	};
	if (!cfg.usdt || !cfg.dexRouter) throw new Error(`No config for "${networkName}"`);

	const usdt = cfg.usdt;
	const dexRouter = cfg.dexRouter;
	const usdc = cfg.usdc;
	const platformWallet = process.env.PLATFORM_WALLET || deployer.address;

	console.log(`  USDT:     ${usdt}`);
	console.log(`  DEX:      ${dexRouter}`);
	console.log(`  Wallet:   ${platformWallet}`);
	if (usdc) console.log(`  USDC:     ${usdc}`);
	console.log("─".repeat(60));

	const deployed: Record<string, string> = {
		USDT: usdt,
		DEXRouter: dexRouter,
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
	const tokenFactory = await TokenFactory.deploy(usdt, dexRouter, platformWallet);
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
		platformWallet, dexRouter, usdt, launchImplAddr
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
	const platformRouter = await PlatformRouter.deploy(tokenFactoryAddr, launchpadFactoryAddr, dexRouter);
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
	// 9. PlatformLens (optional — deploy if exists)
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
		console.log("  Skipped (not found or compile error)");
	}

	// ════════════════════════════════════════════════════════
	// Configure everything
	// ════════════════════════════════════════════════════════
	console.log("\n" + "─".repeat(60));
	console.log("  Configuring...\n");

	// Token implementations
	for (const impl of IMPL_CONTRACTS) {
		process.stdout.write(`  setImplementation(${impl.typeKey})... `);
		await (await tokenFactory.setImplementation(impl.typeKey, implAddresses[impl.typeKey])).wait();
		console.log("✓");
	}

	// Creation fees
	for (const [typeKey, fee] of Object.entries(CREATION_FEES_USDT)) {
		process.stdout.write(`  setCreationFee(${typeKey}, $${ethers.formatUnits(fee, 18)})... `);
		await (await tokenFactory.setCreationFee(Number(typeKey), fee)).wait();
		console.log("✓");
	}

	// Payment tokens
	if (usdc) {
		process.stdout.write(`  addPaymentToken(USDC)... `);
		await (await tokenFactory.addPaymentToken(usdc)).wait();
		console.log("✓");
	}

	// Authorized router on both factories
	process.stdout.write("  setAuthorizedRouter (TokenFactory)... ");
	await (await tokenFactory.setAuthorizedRouter(platformRouterAddr)).wait();
	console.log("✓");

	process.stdout.write("  setAuthorizedRouter (LaunchpadFactory)... ");
	await (await launchpadFactory.setAuthorizedRouter(platformRouterAddr)).wait();
	console.log("✓");

	// Launchpad: set launch fee + curve defaults + payment tokens
	process.stdout.write(`  setLaunchFee($${ethers.formatUnits(LAUNCH_FEE_USDT, 18)})... `);
	await (await launchpadFactory.setLaunchFee(LAUNCH_FEE_USDT)).wait();
	console.log("✓");

	process.stdout.write("  setCurveDefaults... ");
	await (await launchpadFactory.setCurveDefaults({
		linearSlope: 0n,
		linearIntercept: BigInt(1e16),
		sqrtCoefficient: BigInt(1e16),
		quadraticCoefficient: 1n,
		expBase: BigInt(1e16),
		expKFactor: BigInt(1e12),
	})).wait();
	console.log("✓");

	// Add USDT as launchpad payment token
	process.stdout.write("  addPaymentToken(USDT) on LaunchpadFactory... ");
	await (await launchpadFactory.addPaymentToken(usdt)).wait();
	console.log("✓");

	if (usdc) {
		process.stdout.write("  addPaymentToken(USDC) on LaunchpadFactory... ");
		await (await launchpadFactory.addPaymentToken(usdc)).wait();
		console.log("✓");
	}

	// TradeRouter: set max slippage
	process.stdout.write("  setMaxSlippage(2000 = 20%)... ");
	await (await tradeRouter.setMaxSlippage(2000)).wait();
	console.log("✓");

	// ════════════════════════════════════════════════════════
	// Verify all contracts
	// ════════════════════════════════════════════════════════
	if (network.name !== "hardhat" && network.name !== "localhost") {
		console.log("\n" + "─".repeat(60));
		console.log("  Verifying on BSCScan...\n");
		console.log("  Waiting 20s for explorer indexing...");
		await new Promise(r => setTimeout(r, 20000));

		await verify(bondingCurveAddr);
		await verify(launchImplAddr, [], { BondingCurve: bondingCurveAddr });
		for (const impl of IMPL_CONTRACTS) await verify(implAddresses[impl.typeKey]);
		await verify(tokenFactoryAddr, [usdt, dexRouter, platformWallet]);
		await verify(launchpadFactoryAddr, [platformWallet, dexRouter, usdt, launchImplAddr]);
		await verify(platformRouterAddr, [tokenFactoryAddr, launchpadFactoryAddr, dexRouter]);
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

	const summary = [
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
		console.log(`    [${impl.typeKey}] ${impl.name.padEnd(30)} ${implAddresses[impl.typeKey]}`);
	}

	console.log("\n  Fees:");
	for (const [typeKey, fee] of Object.entries(CREATION_FEES_USDT)) {
		console.log(`    Type ${typeKey}: $${ethers.formatUnits(fee, 18)}`);
	}
	console.log(`    Launch: $${ethers.formatUnits(LAUNCH_FEE_USDT, 18)}`);
	console.log(`    Buy fee: 1% (per buy on bonding curve)`);
	console.log(`    Graduation fee: 1% (USDT + tokens)`);

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

main().catch(e => { console.error(e); process.exitCode = 1; });
