// src/lib/wagmiConfig.ts
import { createConfig, http } from '@wagmi/core';
import { mainnet, bsc } from 'viem/chains'; // import more as needed
import { injected, walletConnect } from '@wagmi/connectors';

export const wagmiConfig = createConfig({
  chains: [mainnet, bsc],
  transports: {
    [mainnet.id]: http(), // or your Alchemy/Infura RPC
    [bsc.id]: http(),
  },
  connectors: [
    injected(), // MetaMask etc.
    walletConnect({ projectId: 'YOUR_WALLET_CONNECT_PROJECT_ID' }), // optional WC
  ],
});