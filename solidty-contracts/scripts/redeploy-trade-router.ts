import { ethers, run, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const USDT = "0x55d398326f99059fF775485246999027B3197955";
const DEX_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";

async function main() {
  const [deployer] = await ethers.getSigners();
  const platformWallet = process.env.PLATFORM_WALLET || deployer.address;
  const adminKey = process.env.ADMIN_KEY;

  console.log("\n" + "=".repeat(60));
  console.log("  Redeploy TradeRouter");
  console.log("=".repeat(60));
  console.log("  Deployer:", deployer.address);
  console.log("  Balance: ", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "BNB");
  console.log("  Wallet:  ", platformWallet);

  let adminAddress = "";
  if (adminKey) {
    const w = new ethers.Wallet(adminKey.startsWith("0x") ? adminKey : "0x" + adminKey);
    adminAddress = w.address;
    console.log("  Admin:   ", adminAddress);
  }
  console.log("-".repeat(60));

  console.log("\n[1/1] TradeRouter...");
  const TradeRouter = await ethers.getContractFactory("TradeRouter");
  const tradeRouter = await TradeRouter.deploy(DEX_ROUTER, USDT, platformWallet);
  await tradeRouter.waitForDeployment();
  const addr = await tradeRouter.getAddress();
  console.log("  ->", addr);

  console.log("\n  Configuring...");
  process.stdout.write("  setMaxSlippage(2000)... ");
  await (await tradeRouter.setMaxSlippage(2000)).wait();
  console.log("done");

  if (adminAddress) {
    process.stdout.write("  addAdmin(" + adminAddress.slice(0, 10) + "...)... ");
    await (await tradeRouter.addAdmin(adminAddress)).wait();
    console.log("done");
  }

  const bscPath = path.join(__dirname, "..", "deployments", "bsc.json");
  const d = JSON.parse(fs.readFileSync(bscPath, "utf8"));
  d.TradeRouter_Old = d.TradeRouter;
  d.TradeRouter = addr;
  fs.writeFileSync(bscPath, JSON.stringify(d, null, 2));

  if (network.name !== "hardhat" && network.name !== "localhost") {
    console.log("\n  Verifying...");
    await new Promise(r => setTimeout(r, 20000));
    try {
      await run("verify:verify", { address: addr, constructorArguments: [DEX_ROUTER, USDT, platformWallet] });
      console.log("  Verified");
    } catch (e: any) {
      if (e.message?.includes("already verified")) console.log("  Already verified");
      else console.log("  Verify failed:", e.message?.slice(0, 150));
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("  TradeRouter:", addr);
  if (adminAddress) console.log("  Admin:", adminAddress);
  console.log("=".repeat(60));
}

main().catch(e => { console.error(e); process.exitCode = 1; });
