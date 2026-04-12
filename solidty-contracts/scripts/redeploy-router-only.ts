import { ethers, run, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Redeploy PlatformRouter ONLY. Used when the only change is in
 * PlatformRouter.sol (e.g. _payFee native path fix).
 *
 * Re-wires TokenFactory.authorizedRouter and LaunchpadFactory.authorizedRouter.
 */

const TOKEN_FACTORY = "0x210a8021Bd40EADe495325749120679974EffE54";
const LAUNCHPAD_FACTORY = "0xD5ddd90e38c5cDab02DDcdd14B92639588451774";
const DEX_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";

async function main() {
	const [deployer] = await ethers.getSigners();
	console.log("\n" + "═".repeat(60));
	console.log("  Redeploy PlatformRouter only");
	console.log("═".repeat(60));
	console.log(`  Deployer: ${deployer.address}`);
	console.log(`  Balance:  ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} BNB`);
	console.log("─".repeat(60));

	console.log("\n[1/1] PlatformRouter...");
	const PlatformRouter = await ethers.getContractFactory("PlatformRouter");
	const router = await PlatformRouter.deploy(TOKEN_FACTORY, LAUNCHPAD_FACTORY, DEX_ROUTER);
	await router.waitForDeployment();
	const addr = await router.getAddress();
	console.log(`  → ${addr}`);

	console.log("\n  Configuring...");
	const tf = await ethers.getContractAt("TokenFactory", TOKEN_FACTORY);
	process.stdout.write("  TokenFactory.setAuthorizedRouter... ");
	await (await tf.setAuthorizedRouter(addr)).wait();
	console.log("✓");

	const lf = await ethers.getContractAt("LaunchpadFactory", LAUNCHPAD_FACTORY);
	process.stdout.write("  LaunchpadFactory.setAuthorizedRouter... ");
	await (await lf.setAuthorizedRouter(addr)).wait();
	console.log("✓");

	// Update bsc.json
	const bscPath = path.join(__dirname, "..", "deployments", "bsc.json");
	const d = JSON.parse(fs.readFileSync(bscPath, "utf8"));
	d.PlatformRouter_Old = d.PlatformRouter;
	d.PlatformRouter = addr;
	fs.writeFileSync(bscPath, JSON.stringify(d, null, 2));

	// Verify
	if (network.name !== "hardhat" && network.name !== "localhost") {
		console.log("\n  Verifying...");
		await new Promise(r => setTimeout(r, 20000));
		try {
			await run("verify:verify", {
				address: addr,
				constructorArguments: [TOKEN_FACTORY, LAUNCHPAD_FACTORY, DEX_ROUTER],
			});
			console.log("  ✓ Verified");
		} catch (e: any) {
			if (e.message?.includes("already verified")) console.log("  ✓ Already verified");
			else console.log(`  ✗ ${e.message?.slice(0, 150)}`);
		}
	}

	console.log("\n" + "═".repeat(60));
	console.log(`  PlatformRouter: ${addr}`);
	console.log("═".repeat(60));
}

main().catch(e => { console.error(e); process.exitCode = 1; });
