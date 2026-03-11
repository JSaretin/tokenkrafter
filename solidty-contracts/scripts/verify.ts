import { run } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const NETWORK_CONFIG: Record<string, { usdt: string; dexRouter: string }> = {
  bsc: {
    usdt: "0x55d398326f99059fF775485246999027B3197955",
    dexRouter: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
  },
  bscTestnet: {
    usdt: "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd",
    dexRouter: "0xD99D1c33F9fC3444f8101754aBC46c52416550D1",
  },
};

const IMPL_NAMES = [
  "BasicTokenImpl",
  "MintableTokenImpl",
  "TaxableTokenImpl",
  "TaxableMintableTokenImpl",
  "PartnerTokenImpl",
  "PartnerMintableTokenImpl",
  "PartnerTaxableTokenImpl",
  "PartnerTaxableMintableTokenImpl",
];

async function verify(
  address: string,
  constructorArguments: any[] = []
) {
  console.log(`\n  Verifying ${address}...`);
  try {
    await run("verify:verify", { address, constructorArguments });
    console.log(`  ✓ Verified`);
    return true;
  } catch (e: any) {
    if (e.message?.toLowerCase().includes("already verified")) {
      console.log(`  ✓ Already verified`);
      return true;
    }
    console.log(`  ✗ Failed: ${e.message}`);
    return false;
  }
}

async function main() {
  const networkName = process.env.HARDHAT_NETWORK || "bsc";
  const deploymentsFile = path.join(
    __dirname,
    "..",
    "deployments",
    `${networkName}.json`
  );

  if (!fs.existsSync(deploymentsFile)) {
    throw new Error(
      `No deployment file found at ${deploymentsFile}. Deploy first.`
    );
  }

  const deployed = JSON.parse(fs.readFileSync(deploymentsFile, "utf-8"));
  const cfg = NETWORK_CONFIG[networkName];
  if (!cfg) throw new Error(`No config for network: ${networkName}`);

  const platformWallet =
    process.env.PLATFORM_WALLET || "0xa559780067BF808499E53dfE6a8dF07e193159BE";

  console.log("=".repeat(60));
  console.log(`Verifying contracts on ${networkName}`);
  console.log("=".repeat(60));

  let passed = 0;
  let failed = 0;

  // BondingCurve library (no constructor args)
  console.log("\n— BondingCurve Library —");
  (await verify(deployed.BondingCurve)) ? passed++ : failed++;

  // Implementation contracts (no constructor args)
  console.log("\n— Token Implementations —");
  for (const name of IMPL_NAMES) {
    (await verify(deployed[name])) ? passed++ : failed++;
  }

  // TokenFactory(usdt, dexRouter)
  console.log("\n— TokenFactory —");
  (await verify(deployed.TokenFactory, [cfg.usdt, cfg.dexRouter]))
    ? passed++
    : failed++;

  // LaunchpadFactory(platformWallet, dexRouter, usdt)
  console.log("\n— LaunchpadFactory —");
  (await verify(deployed.LaunchpadFactory, [
    platformWallet,
    cfg.dexRouter,
    cfg.usdt,
  ]))
    ? passed++
    : failed++;

  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${passed} verified, ${failed} failed`);
  console.log("=".repeat(60));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
