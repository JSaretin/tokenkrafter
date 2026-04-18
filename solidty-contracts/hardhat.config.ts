import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "dotenv/config";

const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY || "0x" + "0".repeat(64);

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.20",
    settings: {
      viaIR: true,
      optimizer: { enabled: true, runs: 100 },
    },
  },
  networks: {
    hardhat: {
      accounts: { count: 30 },
    },
    bsc: {
      url: process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org/",
      chainId: 56,
      accounts: [DEPLOYER_KEY],
      // Public endpoints rate-limit / close sockets during multi-tx runs.
      // Override via BSC_RPC_URL (e.g. an Ankr / QuickNode endpoint) for
      // long deploy scripts.
      timeout: 60000,
    },
    bscTestnet: {
      url: process.env.BSC_TESTNET_RPC_URL || "https://data-seed-prebsc-1-s1.binance.org:8545/",
      chainId: 97,
      accounts: [DEPLOYER_KEY],
      timeout: 60000,
    },
    ethereum: {
      url: process.env.ETH_RPC_URL || "https://eth.llamarpc.com",
      chainId: 1,
      accounts: [DEPLOYER_KEY],
    },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "https://rpc.sepolia.org",
      chainId: 11155111,
      accounts: [DEPLOYER_KEY],
    },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEYS?.split(",")[0] || process.env.ETHERSCAN_API_KEY || "",
  },
  sourcify: {
    enabled: true,
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};

export default config;
