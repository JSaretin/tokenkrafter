import { ethers, run, network } from "hardhat";

/**
 * Deploy PlatformRouter V2
 *
 * Deploys the new router with:
 *   - Ownable + Pausable
 *   - burnLP flag on listing
 *   - createTokenOnly
 *   - addLiquidityToExisting
 *   - withdrawStuckTokens
 *   - setMinLiquidity
 *
 * Then updates both factories to use the new router.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-router-v2.ts --network bsc
 */

const DEPLOYED: Record<string, { tokenFactory: string; launchpadFactory: string; dexRouter: string }> = {
	bsc: {
		tokenFactory: "0x34765e4E0803984CC18098AeaA851B5A4b0EFf8b",
		launchpadFactory: "0xd6F218BAE3Aa2c34F0cd1Af2A1D9Ae2d489bD1Bc",
		dexRouter: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
	},
};

async function main() {
	const [deployer] = await ethers.getSigners();
	const chainName = network.name;
	const chainId = (await deployer.provider.getNetwork()).chainId;

	console.log(`\n🚀 Deploying PlatformRouter V2 on ${chainName} (chain ${chainId})`);
	console.log(`   Deployer: ${deployer.address}`);

	const config = DEPLOYED[chainName];
	if (!config) {
		console.error(`❌ No config for network: ${chainName}`);
		process.exit(1);
	}

	console.log(`   TokenFactory: ${config.tokenFactory}`);
	console.log(`   LaunchpadFactory: ${config.launchpadFactory}`);
	console.log(`   DEX Router: ${config.dexRouter}`);

	// 1. Deploy new router
	console.log("\n1. Deploying PlatformRouter...");
	const Router = await ethers.getContractFactory("PlatformRouter");
	const router = await Router.deploy(config.tokenFactory, config.launchpadFactory, config.dexRouter);
	await router.waitForDeployment();
	const routerAddr = await router.getAddress();
	console.log(`   ✅ PlatformRouter: ${routerAddr}`);

	// 2. Update TokenFactory.setAuthorizedRouter
	console.log("\n2. Updating TokenFactory authorizedRouter...");
	const tokenFactory = await ethers.getContractAt(
		["function setAuthorizedRouter(address) external", "function authorizedRouter() view returns (address)"],
		config.tokenFactory, deployer
	);
	const oldTfRouter = await tokenFactory.authorizedRouter();
	const tx1 = await tokenFactory.setAuthorizedRouter(routerAddr);
	await tx1.wait();
	console.log(`   Old: ${oldTfRouter}`);
	console.log(`   ✅ New: ${routerAddr}`);

	// 3. Update LaunchpadFactory.setAuthorizedRouter
	console.log("\n3. Updating LaunchpadFactory authorizedRouter...");
	const launchpadFactory = await ethers.getContractAt(
		["function setAuthorizedRouter(address) external", "function authorizedRouter() view returns (address)"],
		config.launchpadFactory, deployer
	);
	const oldLpRouter = await launchpadFactory.authorizedRouter();
	const tx2 = await launchpadFactory.setAuthorizedRouter(routerAddr);
	await tx2.wait();
	console.log(`   Old: ${oldLpRouter}`);
	console.log(`   ✅ New: ${routerAddr}`);

	// 4. Verify
	if (chainName !== "localhost" && chainName !== "hardhat") {
		console.log("\n4. Verifying on explorer...");
		try {
			await run("verify:verify", {
				address: routerAddr,
				constructorArguments: [config.tokenFactory, config.launchpadFactory, config.dexRouter],
			});
			console.log("   ✅ Verified");
		} catch (e: any) {
			console.log(`   ⚠️ ${e.message?.slice(0, 100)}`);
		}
	}

	console.log(`\n✅ Done!`);
	console.log(`   Old router: ${oldTfRouter}`);
	console.log(`   New router: ${routerAddr}`);
	console.log(`   Both factories updated.`);
	console.log(`\n   Don't forget to update router_address in admin config!`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
