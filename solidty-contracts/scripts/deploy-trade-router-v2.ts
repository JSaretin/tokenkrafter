import { ethers, run, network } from "hardhat";

/**
 * Deploy TradeRouter V2
 *
 * Path-based routing: all swap functions accept address[] path
 * instead of individual tokenIn/tokenOut. Enables multi-hop swaps.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-trade-router-v2.ts --network bsc
 */

const DEPLOYED: Record<string, { dexRouter: string; usdt: string; platformWallet: string }> = {
	bsc: {
		dexRouter: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
		usdt: "0x55d398326f99059fF775485246999027B3197955",
		platformWallet: "0x501b90E6B9e0C27191F718Dd8f2407B0AF67409d",
	},
};

async function main() {
	const [deployer] = await ethers.getSigners();
	const chainName = network.name;
	const chainId = (await deployer.provider.getNetwork()).chainId;

	console.log(`\n🚀 Deploying TradeRouter V2 on ${chainName} (chain ${chainId})`);
	console.log(`   Deployer: ${deployer.address}`);

	const config = DEPLOYED[chainName];
	if (!config) {
		console.error(`❌ No config for network: ${chainName}`);
		process.exit(1);
	}

	// 1. Deploy
	console.log("\n1. Deploying TradeRouter...");
	const Router = await ethers.getContractFactory("TradeRouter");
	const router = await Router.deploy(config.dexRouter, config.usdt, config.platformWallet);
	await router.waitForDeployment();
	const routerAddr = await router.getAddress();
	console.log(`   ✅ TradeRouter: ${routerAddr}`);

	// 2. Verify
	if (chainName !== "localhost" && chainName !== "hardhat") {
		console.log("\n2. Verifying on explorer...");
		try {
			await run("verify:verify", {
				address: routerAddr,
				constructorArguments: [config.dexRouter, config.usdt, config.platformWallet],
			});
			console.log("   ✅ Verified");
		} catch (e: any) {
			console.log(`   ⚠️ ${e.message?.slice(0, 100)}`);
		}
	}

	console.log(`\n✅ Done!`);
	console.log(`   New TradeRouter: ${routerAddr}`);
	console.log(`\n   Update trade_router_address in admin config!`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
