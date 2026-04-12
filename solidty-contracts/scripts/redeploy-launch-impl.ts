import { ethers, run, network } from "hardhat";

/**
 * Deploys a new LaunchInstance implementation (the clone template used
 * by LaunchpadFactory) and points the factory at it. Used when the only
 * thing changing is the LaunchInstance source — e.g. the
 * STRANDED_SWEEP_DELAY constant update from 90 days to 5 years.
 *
 * Cheap (~0.002 BNB). Existing clones are unaffected — they keep
 * whatever logic they were minted from. New clones created after the
 * `setLaunchImplementation` tx use the new template.
 *
 * Depends on the existing BSC deployment's BondingCurve library address
 * since LaunchInstance links against it.
 */

const BSC_ADDRESSES = {
	BondingCurve: "0x47632552723206e7Cd3234BD7C349012c86777cB",
	LaunchpadFactory: "0xD5ddd90e38c5cDab02DDcdd14B92639588451774",
};

async function main() {
	const [deployer] = await ethers.getSigners();
	console.log("\n" + "═".repeat(60));
	console.log("  Redeploy LaunchInstance impl — STRANDED_SWEEP_DELAY=5y");
	console.log("═".repeat(60));
	console.log(`  Deployer: ${deployer.address}`);
	console.log(
		`  Balance:  ${ethers.formatEther(
			await ethers.provider.getBalance(deployer.address)
		)} BNB`
	);
	console.log("─".repeat(60));

	// 1. Deploy the new LaunchInstance impl linked against the existing BondingCurve
	console.log("\n[1/2] LaunchInstance implementation...");
	const LaunchInstance = await ethers.getContractFactory("LaunchInstance", {
		libraries: { BondingCurve: BSC_ADDRESSES.BondingCurve },
	});
	const launchImpl = await LaunchInstance.deploy();
	await launchImpl.waitForDeployment();
	const newImplAddr = await launchImpl.getAddress();
	console.log(`  → ${newImplAddr}`);

	// 2. Point the LaunchpadFactory at the new impl
	console.log("\n[2/2] LaunchpadFactory.setLaunchImplementation...");
	const factory = await ethers.getContractAt(
		"LaunchpadFactory",
		BSC_ADDRESSES.LaunchpadFactory
	);
	const tx = await factory.setLaunchImplementation(newImplAddr);
	console.log(`  tx: ${tx.hash}`);
	await tx.wait();
	console.log(`  ✓ factory now clones from ${newImplAddr}`);

	// Verify — in-session so the build-info matches the on-chain bytecode
	if (network.name !== "hardhat" && network.name !== "localhost") {
		console.log("\n" + "─".repeat(60));
		console.log("  Verifying on BscScan...");
		console.log("  Waiting 20s for explorer indexing...");
		await new Promise((r) => setTimeout(r, 20000));
		try {
			await run("verify:verify", {
				address: newImplAddr,
				constructorArguments: [],
				libraries: { BondingCurve: BSC_ADDRESSES.BondingCurve },
			});
			console.log(`  ✓ Verified`);
		} catch (e: any) {
			if (e.message?.toLowerCase().includes("already verified")) {
				console.log(`  ✓ Already verified`);
			} else {
				console.log(`  ✗ hardhat verify failed: ${e.message?.slice(0, 180)}`);
				console.log(`  Fallback: retry manually via standard-json-input POST.`);
			}
		}
	}

	console.log("\n" + "═".repeat(60));
	console.log(`  New LaunchInstance impl: ${newImplAddr}`);
	console.log(`  STRANDED_SWEEP_DELAY:    5 years (1825 days)`);
	console.log("═".repeat(60));
}

main().catch((e) => {
	console.error(e);
	process.exitCode = 1;
});
