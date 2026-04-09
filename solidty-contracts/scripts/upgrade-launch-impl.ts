import { ethers, run, network } from "hardhat";

/**
 * Upgrade LaunchInstance Implementation
 *
 * Deploys a new LaunchInstance implementation and updates the LaunchpadFactory.
 * Existing launches (clones) are unaffected — only new launches use the new impl.
 *
 * Changes in this version:
 *   - Buy fees (1%) sent instantly to platform wallet on each buy
 *   - No longer accumulated until graduation/refund
 *
 * Usage:
 *   npx hardhat run scripts/upgrade-launch-impl.ts --network bsc
 *
 * Environment:
 *   LAUNCHPAD_FACTORY — LaunchpadFactory address (auto-detected from deployment file)
 */

const DEPLOYED: Record<string, { launchpadFactory: string; bondingCurve: string }> = {
	bsc: {
		launchpadFactory: "0xd6F218BAE3Aa2c34F0cd1Af2A1D9Ae2d489bD1Bc",
		bondingCurve: "0xC2618A07dA1188Ad24193643335E9c8d9994dA26", // existing deployed lib
	},
};

async function main() {
	const [deployer] = await ethers.getSigners();
	const chainName = network.name;
	const chainId = (await deployer.provider.getNetwork()).chainId;

	console.log(`\n🚀 Upgrading LaunchInstance on ${chainName} (chain ${chainId})`);
	console.log(`   Deployer: ${deployer.address}`);

	const config = DEPLOYED[chainName];
	const factoryAddr = process.env.LAUNCHPAD_FACTORY || config?.launchpadFactory;
	if (!factoryAddr) {
		console.error("❌ No LaunchpadFactory address. Set LAUNCHPAD_FACTORY env var.");
		process.exit(1);
	}
	console.log(`   LaunchpadFactory: ${factoryAddr}`);

	// 1. Deploy new LaunchInstance implementation (reuse existing BondingCurve library)
	const bondingCurveAddr = config.bondingCurve;
	console.log(`\n1. Deploying new LaunchInstance implementation...`);
	console.log(`   Using existing BondingCurve: ${bondingCurveAddr}`);

	const LaunchInstance = await ethers.getContractFactory("LaunchInstance", {
		libraries: { BondingCurve: bondingCurveAddr },
	});
	const launchImpl = await LaunchInstance.deploy();
	await launchImpl.waitForDeployment();
	const implAddr = await launchImpl.getAddress();
	console.log(`   New LaunchInstance impl: ${implAddr}`);

	// 2. Update factory to use new implementation
	console.log("\n2. Updating LaunchpadFactory...");
	const factory = await ethers.getContractAt(
		["function setLaunchImplementation(address) external", "function launchImplementation() view returns (address)"],
		factoryAddr,
		deployer,
	);

	const oldImpl = await factory.launchImplementation();
	console.log(`   Old impl: ${oldImpl}`);

	const tx = await factory.setLaunchImplementation(implAddr);
	await tx.wait();
	console.log(`   ✅ Updated to: ${implAddr}`);

	// 3. Verify on explorer
	if (chainName !== "localhost" && chainName !== "hardhat") {
		console.log("\n3. Verifying on explorer...");
		try {
			await run("verify:verify", { address: implAddr, constructorArguments: [], libraries: { BondingCurve: bondingCurveAddr } });
			console.log("   ✅ LaunchInstance verified");
		} catch (e: any) {
			console.log(`   ⚠️ LaunchInstance: ${e.message?.slice(0, 80)}`);
		}
	}

	console.log("\n✅ Done! New launches will use the updated implementation.");
	console.log(`   Old impl (existing launches): ${oldImpl}`);
	console.log(`   New impl (future launches):   ${implAddr}`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
