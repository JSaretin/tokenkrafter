import { ethers, run, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Redeploys LaunchpadFactory + PlatformRouter on top of an existing
 * TokenFactory deployment, then rewires TokenFactory.authorizedRouter
 * and the new LaunchpadFactory.authorizedRouter. Verification happens
 * in the same process so it uses the exact build-info the deploy
 * consumed — avoids the viaIR non-determinism that blocked the prior
 * verification attempt.
 *
 * Why we're redeploying:
 *   The original LaunchpadFactory deployed at the first run was
 *   compiled by a build-info file that hardhat's incremental cache
 *   discarded between deploy and verify. Without that exact build
 *   artifact we can't reproduce the on-chain bytecode byte-for-byte,
 *   so BscScan rejects verification. Same metadata hash, 2-byte core
 *   divergence — a known solc 0.8.20 viaIR issue when compilation
 *   units differ across sessions.
 *
 * Existing (untouched) addresses:
 *   TokenFactory       0x70bb8128F7d20bC992Aa2419325a5CC71FEf6D21
 *   BondingCurve       0x47632552723206e7Cd3234BD7C349012c86777cB
 *   LaunchInstance     0xa82c0580C1340D0d4E99037C93C20FC5C62ca999
 *   TradeRouter        0xA56922F77D003F7F87F11b53242B108541C147BB
 *   TradeLens          0x140E75A9cDb31b52048b3310eEd9784aC4850057
 *
 * Gets replaced:
 *   LaunchpadFactory   (new)
 *   PlatformRouter     (new)  — immutable reference to launchpadFactory,
 *                               so replacing the factory forces a
 *                               router replacement too.
 */

const TOKEN_FACTORY = "0x70bb8128F7d20bC992Aa2419325a5CC71FEf6D21";
const LAUNCH_IMPL = "0xa82c0580C1340D0d4E99037C93C20FC5C62ca999";

const USDT = "0x55d398326f99059fF775485246999027B3197955";
const DEX_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";

const LAUNCH_FEE_USDT = ethers.parseUnits("200", 18);

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
			console.log(`  ✗ ${e.message?.slice(0, 180)}`);
		}
	}
}

async function main() {
	const [deployer] = await ethers.getSigners();
	const platformWallet = process.env.PLATFORM_WALLET || deployer.address;

	console.log("\n" + "═".repeat(60));
	console.log("  Redeploy LaunchpadFactory + PlatformRouter");
	console.log("═".repeat(60));
	console.log(`  Deployer: ${deployer.address}`);
	console.log(
		`  Balance:  ${ethers.formatEther(
			await ethers.provider.getBalance(deployer.address)
		)} BNB`
	);
	console.log(`  Wallet:   ${platformWallet}`);
	console.log("─".repeat(60));

	// New LaunchpadFactory
	console.log("\n[1/2] LaunchpadFactory...");
	const LaunchpadFactory = await ethers.getContractFactory("LaunchpadFactory");
	const launchpadFactory = await LaunchpadFactory.deploy(
		platformWallet,
		DEX_ROUTER,
		USDT,
		LAUNCH_IMPL
	);
	await launchpadFactory.waitForDeployment();
	const launchpadFactoryAddr = await launchpadFactory.getAddress();
	console.log(`  → ${launchpadFactoryAddr}`);

	// New PlatformRouter pointing at the new LaunchpadFactory
	console.log("\n[2/2] PlatformRouter...");
	const PlatformRouter = await ethers.getContractFactory("PlatformRouter");
	const platformRouter = await PlatformRouter.deploy(
		TOKEN_FACTORY,
		launchpadFactoryAddr,
		DEX_ROUTER
	);
	await platformRouter.waitForDeployment();
	const platformRouterAddr = await platformRouter.getAddress();
	console.log(`  → ${platformRouterAddr}`);

	// Configure
	console.log("\n" + "─".repeat(60));
	console.log("  Configuring...\n");

	process.stdout.write("  LaunchpadFactory.setLaunchFee($200)... ");
	await (await launchpadFactory.setLaunchFee(LAUNCH_FEE_USDT)).wait();
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

	process.stdout.write("  LaunchpadFactory.setAuthorizedRouter(PlatformRouter)... ");
	await (await launchpadFactory.setAuthorizedRouter(platformRouterAddr)).wait();
	console.log("✓");

	// Point TokenFactory at the new router
	const tokenFactory = await ethers.getContractAt("TokenFactory", TOKEN_FACTORY);
	process.stdout.write("  TokenFactory.setAuthorizedRouter(PlatformRouter)... ");
	await (await tokenFactory.setAuthorizedRouter(platformRouterAddr)).wait();
	console.log("✓");

	// Verify — uses the same build-info the deploy consumed
	if (network.name !== "hardhat" && network.name !== "localhost") {
		console.log("\n" + "─".repeat(60));
		console.log("  Verifying on BscScan...\n");
		console.log("  Waiting 20s for explorer indexing...");
		await new Promise((r) => setTimeout(r, 20000));

		await verify(launchpadFactoryAddr, [
			platformWallet,
			DEX_ROUTER,
			USDT,
			LAUNCH_IMPL,
		]);
		await verify(platformRouterAddr, [
			TOKEN_FACTORY,
			launchpadFactoryAddr,
			DEX_ROUTER,
		]);
	}

	// Persist addresses so the Supabase update script can pick them up
	const dir = path.join(__dirname, "..", "deployments");
	const existing = JSON.parse(
		fs.readFileSync(path.join(dir, "bsc.json"), "utf8")
	);
	existing.LaunchpadFactory_Old = existing.LaunchpadFactory;
	existing.PlatformRouter_Old = existing.PlatformRouter;
	existing.LaunchpadFactory = launchpadFactoryAddr;
	existing.PlatformRouter = platformRouterAddr;
	fs.writeFileSync(
		path.join(dir, "bsc.json"),
		JSON.stringify(existing, null, 2)
	);

	console.log("\n" + "═".repeat(60));
	console.log("  REDEPLOY COMPLETE");
	console.log("═".repeat(60));
	console.log(`  LaunchpadFactory  ${launchpadFactoryAddr}`);
	console.log(`  PlatformRouter    ${platformRouterAddr}`);
	console.log(`\n  Update Supabase networks.router_address → ${platformRouterAddr}`);
	console.log(`  Update Supabase networks.launchpad_address → ${launchpadFactoryAddr}`);
	console.log("═".repeat(60));
}

main().catch((e) => {
	console.error(e);
	process.exitCode = 1;
});
