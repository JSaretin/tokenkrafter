import { ethers } from "hardhat";

/**
 * Network-specific addresses.
 * Add/update entries as needed before deploying to a new chain.
 */
const NETWORK_CONFIG: Record<string, { usdt: string; dexRouter: string; usdc?: string }> = {
  bsc: {
    usdt: "0x55d398326f99059fF775485246999027B3197955",
    dexRouter: "0x10ED43C718714eb63d5aA57B78B54704E256024E", // PancakeSwap V2
    usdc: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  },
  bscTestnet: {
    usdt: "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd", // testnet USDT
    dexRouter: "0xD99D1c33F9fC3444f8101754aBC46c52416550D1", // PancakeSwap V2 testnet
  },
  ethereum: {
    usdt: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    dexRouter: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D", // Uniswap V2
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
  sepolia: {
    usdt: "0x7169D38820dfd117C3FA1f22a697dBA58d90BA06", // mock USDT on sepolia
    dexRouter: "0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3", // uniswap v2 sepolia
  },
};

/**
 * Token type keys (bitfield):
 *   0 = basic
 *   1 = mintable
 *   2 = taxable
 *   3 = taxable + mintable
 *   4 = partner
 *   5 = partner + mintable
 *   6 = partner + taxable
 *   7 = partner + taxable + mintable
 */
const IMPL_CONTRACTS: { typeKey: number; name: string }[] = [
  { typeKey: 0, name: "BasicTokenImpl" },
  { typeKey: 1, name: "MintableTokenImpl" },
  { typeKey: 2, name: "TaxableTokenImpl" },
  { typeKey: 3, name: "TaxableMintableTokenImpl" },
  { typeKey: 4, name: "PartnerTokenImpl" },
  { typeKey: 5, name: "PartnerMintableTokenImpl" },
  { typeKey: 6, name: "PartnerTaxableTokenImpl" },
  { typeKey: 7, name: "PartnerTaxableMintableTokenImpl" },
];

async function main() {
  const [deployer] = await ethers.getSigners();
  const networkName = (await ethers.provider.getNetwork()).name;
  const chainId = (await ethers.provider.getNetwork()).chainId;

  console.log("=".repeat(60));
  console.log("TokenKrafter V1 - Deployment Script");
  console.log("=".repeat(60));
  console.log(`Network:  ${networkName} (chainId: ${chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH/BNB`);
  console.log("-".repeat(60));

  // Resolve network config
  // hardhat local fork might report chain name differently
  const configKey = Object.keys(NETWORK_CONFIG).find(
    (k) => networkName.includes(k) || k === networkName
  );

  let usdt: string;
  let dexRouter: string;
  let usdc: string | undefined;

  if (configKey) {
    const cfg = NETWORK_CONFIG[configKey];
    usdt = cfg.usdt;
    dexRouter = cfg.dexRouter;
    usdc = cfg.usdc;
  } else {
    // Fallback: read from environment
    usdt = process.env.USDT_ADDRESS!;
    dexRouter = process.env.DEX_ROUTER_ADDRESS!;
    usdc = process.env.USDC_ADDRESS;
    if (!usdt || !dexRouter) {
      throw new Error(
        `No config for network "${networkName}". Set USDT_ADDRESS and DEX_ROUTER_ADDRESS env vars.`
      );
    }
  }

  console.log(`USDT:       ${usdt}`);
  console.log(`DEX Router: ${dexRouter}`);
  if (usdc) console.log(`USDC:       ${usdc}`);
  console.log("-".repeat(60));

  // ──────────────────────────────────────────────
  // Step 1: Deploy all token implementations
  // ──────────────────────────────────────────────
  console.log("\n[1/3] Deploying token implementations...\n");

  const implAddresses: Record<number, string> = {};

  for (const impl of IMPL_CONTRACTS) {
    process.stdout.write(`  Deploying ${impl.name} (type ${impl.typeKey})... `);
    const Factory = await ethers.getContractFactory(impl.name);
    const contract = await Factory.deploy();
    await contract.waitForDeployment();
    const addr = await contract.getAddress();
    implAddresses[impl.typeKey] = addr;
    console.log(addr);
  }

  // ──────────────────────────────────────────────
  // Step 2: Deploy TokenFactory
  // ──────────────────────────────────────────────
  console.log("\n[2/3] Deploying TokenFactory...\n");

  const TokenFactoryFactory = await ethers.getContractFactory("TokenFactory");
  const tokenFactory = await TokenFactoryFactory.deploy(usdt, dexRouter);
  await tokenFactory.waitForDeployment();
  const factoryAddr = await tokenFactory.getAddress();
  console.log(`  TokenFactory deployed at: ${factoryAddr}`);

  // ──────────────────────────────────────────────
  // Step 3: Register implementations + payment tokens
  // ──────────────────────────────────────────────
  console.log("\n[3/3] Configuring factory...\n");

  for (const impl of IMPL_CONTRACTS) {
    process.stdout.write(`  setImplementation(${impl.typeKey}, ${implAddresses[impl.typeKey]})... `);
    const tx = await tokenFactory.setImplementation(impl.typeKey, implAddresses[impl.typeKey]);
    await tx.wait();
    console.log("done");
  }

  // Add USDC as payment token if available
  if (usdc) {
    process.stdout.write(`  addPaymentToken(USDC: ${usdc})... `);
    const tx = await tokenFactory.addPaymentToken(usdc);
    await tx.wait();
    console.log("done");
  }

  // ──────────────────────────────────────────────
  // Summary
  // ──────────────────────────────────────────────
  console.log("\n" + "=".repeat(60));
  console.log("DEPLOYMENT COMPLETE");
  console.log("=".repeat(60));
  console.log(`\nTokenFactory: ${factoryAddr}\n`);
  console.log("Implementations:");
  for (const impl of IMPL_CONTRACTS) {
    console.log(`  [${impl.typeKey}] ${impl.name}: ${implAddresses[impl.typeKey]}`);
  }
  console.log("\nSupported payment tokens:");
  console.log(`  USDT (auto):   ${usdt}`);
  console.log(`  Native (auto): 0x0000000000000000000000000000000000000000`);
  if (usdc) console.log(`  USDC (added):  ${usdc}`);

  console.log("\n" + "-".repeat(60));
  console.log("Update your frontend SupportedNetwork.platform_address with:");
  console.log(`  "${factoryAddr}"`);
  console.log("-".repeat(60));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
