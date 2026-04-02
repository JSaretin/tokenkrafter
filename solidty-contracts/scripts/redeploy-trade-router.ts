import { ethers, network, run } from "hardhat";

async function main() {
	const [deployer] = await ethers.getSigners();
	const dexRouter = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
	const usdt = "0x55d398326f99059fF775485246999027B3197955";
	const platformWallet = deployer.address;

	console.log("Deployer:", deployer.address);
	console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "BNB");

	const Factory = await ethers.getContractFactory("TradeRouter");
	const tradeRouter = await Factory.deploy(dexRouter, usdt, platformWallet);
	await tradeRouter.waitForDeployment();
	const addr = await tradeRouter.getAddress();
	console.log("TradeRouter deployed:", addr);

	// Verify
	if (network.name !== "hardhat" && network.name !== "localhost") {
		console.log("Waiting 15s for explorer indexing...");
		await new Promise(r => setTimeout(r, 15000));
		try {
			await run("verify:verify", { address: addr, constructorArguments: [dexRouter, usdt, platformWallet] });
			console.log("Verified");
		} catch (e: any) {
			console.log("Verification:", e.message?.includes("already") ? "Already verified" : e.message);
		}
	}

	console.log("\nUpdate DB platform_config:");
	console.log(`  trade_router_address: "${addr}"`);
}

main().catch(e => { console.error(e); process.exit(1); });
