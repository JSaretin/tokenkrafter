import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "dotenv/config";

const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY || "0x" + "0".repeat(64);

const config: HardhatUserConfig = {
  solidity: {
    // Multi-compiler:
    //   - Default 0.8.20 (Shanghai) — matches the on-chain bytecode of
    //     every existing contract (TokenFactory, PlatformRouter,
    //     TradeRouter, LaunchInstance, etc.), so re-verification on
    //     BscScan stays byte-equivalent and we don't need to swap any
    //     of them just because permit was added.
    //   - 0.8.26 (Cancun) for the 4 token impls only (see overrides
    //     below). OZ 5.6 ERC20PermitUpgradeable + EIP712Upgradeable
    //     pin pragma `^0.8.24` because they use Cancun-era opcodes
    //     (mcopy via OZ's Bytes.sol). BSC's Pascal upgrade (June 2025)
    //     made Cancun safe on mainnet.
    //   - viaIR + runs:1 for the token compiler. Earlier we tried
    //     making 0.8.26/cancun the global default and LaunchInstance
    //     hit "Stack too deep" in Yul on its deep struct returns;
    //     keeping LaunchInstance on 0.8.20 sidesteps that entirely.
    // Two compilers, route by pragma:
    //   - 0.8.20 (default everything): matches files pinned `^0.8.20`,
    //     i.e. every existing on-chain contract. No viaIR — keeps
    //     LaunchInstance off the Yul "stack too deep" path.
    //   - 0.8.26 + Cancun + viaIR: only files pinned `^0.8.24` (the
    //     four token impls + their OZ permit deps) end up here, since
    //     0.8.20 doesn't satisfy that range.
    // Hardhat picks the *highest* matching compiler for files whose
    // pragma matches multiple — so anything `^0.8.20` would otherwise
    // route to 0.8.26 + viaIR, where LaunchInstance lights up Yul's
    // "Stack too deep" on its deep struct returns. Explicit override
    // pins LaunchInstance back to 0.8.20 (no viaIR), where it fits.
    compilers: [
      {
        version: "0.8.20",
        settings: { optimizer: { enabled: true, runs: 200 } },
      },
      {
        version: "0.8.26",
        settings: {
          evmVersion: "cancun",
          viaIR: true,
          optimizer: { enabled: true, runs: 1 },
        },
      },
    ],
    // Pin every existing on-chain contract back to 0.8.20 — Hardhat
    // would otherwise route any `^0.8.20` source to the 0.8.26+viaIR
    // entry below (it picks the highest matching version), and a few
    // of these (LaunchInstance, LaunchpadFactory, LaunchLens, etc.)
    // hit Yul "Stack too deep" on viaIR. The token impls in
    // `contracts/tokens/*` pin their own pragma at `^0.8.24` so they
    // only match 0.8.26 and route correctly without needing entries
    // here.
    overrides: {
      ...Object.fromEntries(
        [
          "contracts/Affiliate.sol",
          "contracts/LaunchInstance.sol",
          "contracts/LaunchMath.sol",
          "contracts/LaunchpadFactory.sol",
          "contracts/mocks/MockDEX.sol",
          "contracts/PlatformRouter.sol",
          "contracts/shared/DexInterfaces.sol",
          "contracts/shared/IAffiliate.sol",
          "contracts/shared/TokenInterfaces.sol",
          "contracts/simulators/AdminLens.sol",
          "contracts/simulators/ExploreLens.sol",
          "contracts/simulators/LaunchLens.sol",
          "contracts/simulators/LaunchPreflight.sol",
          "contracts/simulators/MultiCallLens.sol",
          "contracts/simulators/PlatformLens.sol",
          "contracts/simulators/PlatformLensV2.sol",
          "contracts/simulators/RouteFinder.sol",
          "contracts/simulators/SafuLens.sol",
          "contracts/simulators/TradeLens.sol",
          "contracts/simulators/TradeLensV2.sol",
          "contracts/TradeRouter.sol",
        ].map((p) => [p, { version: "0.8.20", settings: { viaIR: true, optimizer: { enabled: true, runs: 1 } } }])
      ),
      // TokenFactory directly imports the token impls (BasicToken,
      // TaxableToken). Solidity inlines the imported contracts when
      // compiling, so TokenFactory has to use the same compiler that
      // satisfies the token files' OZ permit deps (^0.8.24). Compiles
      // here at 0.8.26 + cancun + viaIR. The on-chain TokenFactory
      // bytecode is unchanged because we don't redeploy it; this is
      // purely so artifacts / typechain bindings build.
      "contracts/TokenFactory.sol": {
        version: "0.8.26",
        settings: { evmVersion: "cancun", viaIR: true, optimizer: { enabled: true, runs: 1 } },
      },
    },
  },
  networks: {
    hardhat: {
      accounts: { count: 30 },
      // LaunchInstance is over the 24576-byte mainnet code limit on
      // some compiler builds. Local tests deploy regardless so the
      // suite keeps running; production deploys still need the
      // optimiser settings that make it fit.
      allowUnlimitedContractSize: true,
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
