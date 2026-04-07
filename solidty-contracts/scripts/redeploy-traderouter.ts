import { ethers, run, network } from "hardhat";
import * as fs from "fs";

async function main() {
	const [deployer] = await ethers.getSigners();
	console.log("Deployer:", deployer.address);
	console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "BNB");

	const dexRouter = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
	const usdt = "0x55d398326f99059fF775485246999027B3197955";
	const platformWallet = process.env.PLATFORM_WALLET || deployer.address;

	console.log("Deploying TradeRouter...");
	const F = await ethers.getContractFactory("TradeRouter");
	const c = await F.deploy(dexRouter, usdt, platformWallet);
	await c.waitForDeployment();
	const addr = await c.getAddress();
	console.log("TradeRouter:", addr);

	await (await c.setMaxSlippage(2000)).wait();
	console.log("MaxSlippage set to 2000 (20%)");

	// Update deployment file
	const dep = JSON.parse(fs.readFileSync("deployments/bsc.json", "utf8"));
	dep.TradeRouter = addr;
	fs.writeFileSync("deployments/bsc.json", JSON.stringify(dep, null, 2));
	console.log("Updated deployments/bsc.json");

	// Verify
	if (network.name !== "hardhat" && network.name !== "localhost") {
		console.log("Waiting 15s for BSCScan...");
		await new Promise(r => setTimeout(r, 15000));
		try {
			await run("verify:verify", { address: addr, constructorArguments: [dexRouter, usdt, platformWallet] });
			console.log("Verified");
		} catch (e: any) {
			console.log("Verification:", e.message?.slice(0, 80));
		}
	}

	console.log("\nUpdate Supabase trade_router_address:", addr);
}

main().catch(e => { console.error(e); process.exit(1); });
