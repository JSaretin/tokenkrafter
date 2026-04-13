import { ethers, run, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Redeploy: 8 token impls + TokenFactory + PlatformRouter
 *
 * Triggered by the tax-ceiling refactor:
 *   - TaxableToken: per-field ceiling lock, caps 4/4/2, forceRelaxTaxes
 *   - PartnerTaxable: caps 3.5/3.5/2, PARTNERSHIP_BPS=50 (0.5%)
 *   - PartnerToken: PARTNERSHIP_BPS=50 (0.5%)
 *   - TokenFactory: forceRelaxTaxes admin function
 *   - PlatformRouter: lockTaxCeiling wired into both config helpers
 *
 * Keeps existing:
 *   - BondingCurve library
 *   - LaunchInstance impl (5yr sweep delay, just deployed)
 *   - LaunchpadFactory (only setAuthorizedRouter updated)
 *   - TradeRouter, TradeLens
 */

const EXISTING = {
	BondingCurve: "0x47632552723206e7Cd3234BD7C349012c86777cB",
	LaunchInstanceImpl: "0xEDA3Ba8466bEfb064Eb5d126A92b1130BD6A238F",
	LaunchpadFactory: "0xD5ddd90e38c5cDab02DDcdd14B92639588451774",
	TradeRouter: "0x68113B973e303488996C9a7356a00Bfff50DC876",
	TradeLens: "0x140E75A9cDb31b52048b3310eEd9784aC4850057",
};

const USDT = "0x55d398326f99059fF775485246999027B3197955";
const DEX_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";

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

const LAUNCH_FEE_USDT = ethers.parseUnits("200", 18);

async function main() {
	const [deployer] = await ethers.getSigners();
	const platformWallet = process.env.PLATFORM_WALLET || deployer.address;

	console.log("\n" + "═".repeat(60));
	console.log("  Redeploy: Tax Ceiling + 0.5% Partner Fee");
	console.log("═".repeat(60));
	console.log(`  Deployer: ${deployer.address}`);
	console.log(`  Balance:  ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} BNB`);
	console.log(`  Wallet:   ${platformWallet}`);
	console.log("─".repeat(60));

	const deployed: Record<string, any> = { ...EXISTING };

	// ═══════════════════════════════════════════
	// 1. Token implementations (all 8)
	// ═══════════════════════════════════════════
	console.log("\n[1/3] Token implementations...");
	const implAddresses: string[] = [];
	for (let i = 0; i < IMPL_NAMES.length; i++) {
		const F = await ethers.getContractFactory(IMPL_NAMES[i]);
		const c = await F.deploy();
		await c.waitForDeployment();
		const addr = await c.getAddress();
		implAddresses.push(addr);
		deployed[IMPL_NAMES[i]] = addr;
		console.log(`  [${i}] ${IMPL_NAMES[i]}: ${addr}`);
	}

	// ═══════════════════════════════════════════
	// 2. TokenFactory
	// ═══════════════════════════════════════════
	console.log("\n[2/3] TokenFactory...");
	const TokenFactory = await ethers.getContractFactory("TokenFactory");
	const tokenFactory = await TokenFactory.deploy(USDT, DEX_ROUTER, platformWallet);
	await tokenFactory.waitForDeployment();
	const tokenFactoryAddr = await tokenFactory.getAddress();
	deployed.TokenFactory = tokenFactoryAddr;
	console.log(`  → ${tokenFactoryAddr}`);

	// ═══════════════════════════════════════════
	// 3. PlatformRouter
	// ═══════════════════════════════════════════
	console.log("\n[3/3] PlatformRouter...");
	const PlatformRouter = await ethers.getContractFactory("PlatformRouter");
	const platformRouter = await PlatformRouter.deploy(
		tokenFactoryAddr,
		EXISTING.LaunchpadFactory,
		DEX_ROUTER
	);
	await platformRouter.waitForDeployment();
	const platformRouterAddr = await platformRouter.getAddress();
	deployed.PlatformRouter = platformRouterAddr;
	console.log(`  → ${platformRouterAddr}`);

	// ═══════════════════════════════════════════
	// Configure
	// ═══════════════════════════════════════════
	console.log("\n" + "─".repeat(60));
	console.log("  Configuring...\n");

	// Batch set all 8 impls + fees
	const usdtDec = 18;
	const fees: bigint[] = [5, 15, 15, 25, 105, 115, 115, 125].map(
		(f) => ethers.parseUnits(String(f), usdtDec)
	);
	process.stdout.write("  setImplementationsAndFees (batch)... ");
	await (
		await tokenFactory.setImplementationsAndFees(
			implAddresses as [string, string, string, string, string, string, string, string],
			fees as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]
		)
	).wait();
	console.log("✓");

	// Partner default bases
	process.stdout.write("  setDefaultPartnerBases... ");
	await (await tokenFactory.setDefaultPartnerBases([USDT, WBNB, USDC])).wait();
	console.log("✓");

	// Authorized router on TokenFactory
	process.stdout.write("  TokenFactory.setAuthorizedRouter... ");
	await (await tokenFactory.setAuthorizedRouter(platformRouterAddr)).wait();
	console.log("✓");

	// Authorized router on LaunchpadFactory (existing)
	const launchpadFactory = await ethers.getContractAt(
		"LaunchpadFactory",
		EXISTING.LaunchpadFactory
	);
	process.stdout.write("  LaunchpadFactory.setAuthorizedRouter... ");
	await (await launchpadFactory.setAuthorizedRouter(platformRouterAddr)).wait();
	console.log("✓");

	// ═══════════════════════════════════════════
	// Save deployment
	// ═══════════════════════════════════════════
	const dir = path.join(__dirname, "..", "deployments");
	const bscPath = path.join(dir, "bsc.json");
	const existing = JSON.parse(fs.readFileSync(bscPath, "utf8"));

	// Archive old addresses
	existing.TokenFactory_Old = existing.TokenFactory;
	existing.PlatformRouter_Old = existing.PlatformRouter;
	for (const name of IMPL_NAMES) {
		existing[`${name}_Old`] = existing[name];
	}

	// Write new
	Object.assign(existing, deployed);
	existing.TokenFactory = tokenFactoryAddr;
	existing.PlatformRouter = platformRouterAddr;
	fs.writeFileSync(bscPath, JSON.stringify(existing, null, 2));
	console.log(`\n  Saved to ${bscPath}`);

	// Save build-info for verification
	const biDir = path.join(__dirname, "..", "artifacts", "build-info");
	const biFiles = fs.readdirSync(biDir).filter((f) => f.endsWith(".json"));
	if (biFiles.length > 0) {
		fs.copyFileSync(
			path.join(biDir, biFiles[biFiles.length - 1]),
			path.join(dir, "bsc-build-info.json")
		);
	}

	// ═══════════════════════════════════════════
	// Verify (in-session)
	// ═══════════════════════════════════════════
	if (network.name !== "hardhat" && network.name !== "localhost") {
		console.log("\n" + "─".repeat(60));
		console.log("  Verifying on BscScan...");
		console.log("  Waiting 20s for explorer indexing...");
		await new Promise((r) => setTimeout(r, 20000));

		for (let i = 0; i < IMPL_NAMES.length; i++) {
			try {
				await run("verify:verify", { address: implAddresses[i], constructorArguments: [] });
				console.log(`  ✓ ${IMPL_NAMES[i]}`);
			} catch (e: any) {
				if (e.message?.includes("already verified")) console.log(`  ✓ ${IMPL_NAMES[i]} (already)`);
				else console.log(`  ✗ ${IMPL_NAMES[i]}: ${e.message?.slice(0, 100)}`);
			}
		}

		try {
			await run("verify:verify", { address: tokenFactoryAddr, constructorArguments: [USDT, DEX_ROUTER, platformWallet] });
			console.log("  ✓ TokenFactory");
		} catch (e: any) {
			if (e.message?.includes("already verified")) console.log("  ✓ TokenFactory (already)");
			else console.log(`  ✗ TokenFactory: ${e.message?.slice(0, 100)}`);
		}

		try {
			await run("verify:verify", { address: platformRouterAddr, constructorArguments: [tokenFactoryAddr, EXISTING.LaunchpadFactory, DEX_ROUTER] });
			console.log("  ✓ PlatformRouter");
		} catch (e: any) {
			if (e.message?.includes("already verified")) console.log("  ✓ PlatformRouter (already)");
			else console.log(`  ✗ PlatformRouter: ${e.message?.slice(0, 100)}`);
		}
	}

	// ═══════════════════════════════════════════
	// Summary
	// ═══════════════════════════════════════════
	console.log("\n" + "═".repeat(60));
	console.log("  REDEPLOY COMPLETE");
	console.log("═".repeat(60));
	console.log(`  TokenFactory      ${tokenFactoryAddr}`);
	console.log(`  PlatformRouter    ${platformRouterAddr}`);
	console.log(`  LaunchpadFactory  ${EXISTING.LaunchpadFactory} (unchanged, re-wired)`);
	console.log("\n  Token Impls:");
	for (let i = 0; i < IMPL_NAMES.length; i++) {
		console.log(`    [${i}] ${IMPL_NAMES[i].padEnd(32)} ${implAddresses[i]}`);
	}
	console.log("\n  Tax caps: 4/4/2 (plain), 3.5/3.5/2 (partner)");
	console.log("  Partner fee: 0.5% (was 1%)");
	console.log("  Tax ceiling: locks at launch/listing, unlocks on launch failure");
	console.log("═".repeat(60));
}

main().catch((e) => {
	console.error(e);
	process.exitCode = 1;
});
