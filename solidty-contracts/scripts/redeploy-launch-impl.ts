import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Deploy a new LaunchInstance impl and wire it into the existing
 * LaunchpadFactory. Used after bug-fix patches to the LaunchInstance
 * source — existing launches (cloned from the old impl) keep running
 * their old code; only new launches will use the new impl.
 *
 * Usage: npx hardhat run scripts/redeploy-launch-impl.ts --network bsc
 */
async function main() {
	const [deployer] = await ethers.getSigners();
	const dir = path.join(__dirname, "..", "deployments");
	const bscPath = path.join(dir, `${network.name}.json`);
	const dep = JSON.parse(fs.readFileSync(bscPath, "utf8"));

	console.log(`
╔══════════════════════════════════════════════════════════╗
║     LaunchInstance impl redeploy                         ║
╚══════════════════════════════════════════════════════════╝
  Network:    ${network.name}
  Deployer:   ${deployer.address}
  Balance:    ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} BNB
  Factory:    ${dep.LaunchpadFactory}
  Old impl:   ${dep.LaunchInstanceImpl}
  BondingCurve: ${dep.BondingCurve}
──────────────────────────────────────────────────────────`);

	// LaunchMath library now sits between LaunchInstance and
	// BondingCurve. If the deployment file already has a LaunchMath
	// address (from a previous deploy with this layout) reuse it;
	// otherwise deploy a fresh one linked against the existing
	// BondingCurve.
	let launchMathAddr = dep.LaunchMath;
	if (!launchMathAddr) {
		const LaunchMath = await ethers.getContractFactory("LaunchMath", {
			libraries: { BondingCurve: dep.BondingCurve },
		});
		const lm = await (await LaunchMath.deploy()).waitForDeployment();
		launchMathAddr = await lm.getAddress();
		dep.LaunchMath = launchMathAddr;
		console.log(`  New LaunchMath:           ${launchMathAddr}`);
	}

	// Deploy new LaunchInstance linked against LaunchMath only.
	const LaunchInstance = await ethers.getContractFactory("LaunchInstance", {
		libraries: { LaunchMath: launchMathAddr },
	});
	const newImpl = await (await LaunchInstance.deploy()).waitForDeployment();
	const newImplAddr = await newImpl.getAddress();
	console.log(`\n  New LaunchInstance impl: ${newImplAddr}`);

	// Wire into the factory (instant — Ownable, no timelock).
	const factory = await ethers.getContractAt("LaunchpadFactory", dep.LaunchpadFactory);
	process.stdout.write("  LaunchpadFactory.setLaunchImplementation... ");
	await (await factory.setLaunchImplementation(newImplAddr)).wait();
	console.log("✓");

	// Archive old impl and save
	dep.LaunchInstanceImpl_Old = dep.LaunchInstanceImpl;
	dep.LaunchInstanceImpl = newImplAddr;
	fs.writeFileSync(bscPath, JSON.stringify(dep, null, 2));
	console.log(`\n  Saved to ${bscPath}`);

	// Save build-info for verification
	const biDir = path.join(__dirname, "..", "artifacts", "build-info");
	const dbgPath = path.join(
		__dirname, "..", "artifacts", "contracts", "LaunchInstance.sol", "LaunchInstance.dbg.json"
	);
	if (fs.existsSync(dbgPath)) {
		const dbg = JSON.parse(fs.readFileSync(dbgPath, "utf8"));
		const biFile = path.basename(dbg.buildInfo);
		const biSrc = path.join(biDir, biFile);
		if (fs.existsSync(biSrc)) {
			fs.copyFileSync(biSrc, path.join(dir, `${network.name}-build-info.json`));
			console.log(`  Build-info ${biFile} saved`);
		}
	}

	console.log(`\n  Next: node scripts/verify-v2-batch.mjs\n`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
