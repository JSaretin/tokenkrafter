# TokenKrafter

A decentralized token creation and launchpad platform built with SvelteKit and Solidity. Create custom ERC20 tokens with advanced tokenomics and launch them via bonding curve presales — all from a single interface.

## Features

### Token Creation
- One-click ERC20 token deployment with customizable tokenomics
- Configurable buy/sell tax rates
- Anti-whale protection (max wallet, max transaction limits)
- Automatic liquidity provisioning on Uniswap V2-compatible DEXs
- Referral tracking system

### Bonding Curve Launchpad
- Four bonding curve types: Linear, Square Root, Quadratic, and Exponential
- USDT-denominated presales with multi-token payment support (native coin, USDT, other ERC20s)
- Configurable soft/hard caps, duration, and max buy per wallet
- Creator token allocation with cliff + linear vesting
- Auto-graduation to DEX with permanent liquidity (LP tokens burned)
- Refund mechanism if soft cap is not reached

### Admin Dashboard
- Platform fee management and analytics
- Daily launch/graduation stats
- Curve parameter defaults configuration

## Tech Stack

- **Frontend:** SvelteKit 5, TailwindCSS 4, TypeScript
- **Smart Contracts:** Solidity ^0.8.20, Hardhat, OpenZeppelin
- **Web3:** ethers.js v6, Reown AppKit, WalletConnect
- **Backend:** Supabase
- **Package Manager:** Bun

## Supported Networks

- Binance Smart Chain (BSC)
- BSC Testnet
- Ethereum Mainnet
- Sepolia Testnet

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) (v1.0+)
- [Node.js](https://nodejs.org/) (v20+)

### Installation

```bash
bun install
```

### Development

```bash
bun run dev
```

### Build

```bash
bun run build
```

### Smart Contracts

```bash
cd solidty-contracts
npx hardhat compile
npx hardhat run scripts/deploy.ts --network bsc
```

## Project Structure

```
├── src/
│   ├── lib/                    # Shared libraries and components
│   │   ├── tokenCrafter.ts     # Token factory contract interactions
│   │   ├── launchpad.ts        # Launchpad contract interactions
│   │   ├── structure.ts        # Type definitions and chain config
│   │   └── BondingCurveChart.svelte
│   └── routes/
│       ├── create/             # Token creation flow
│       ├── launchpad/          # Launchpad pages
│       ├── admin/              # Admin dashboard
│       ├── tokens/             # Token detail pages
│       └── manage-tokens/      # Token management
├── solidty-contracts/
│   ├── contracts/
│   │   ├── tokenKrafter-v1.sol          # Token factory + ERC20 template
│   │   └── tokenKrafterLaunchpad.sol    # Bonding curve launchpad
│   ├── scripts/                # Deploy and verify scripts
│   └── deployments/            # Deployment artifacts
└── static/                     # Static assets
```

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.