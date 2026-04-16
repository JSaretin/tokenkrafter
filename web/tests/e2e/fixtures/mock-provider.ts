/**
 * Returns a script string that, when injected via page.addInitScript(),
 * creates a mock EIP-1193 provider on window.ethereum backed by a Hardhat account.
 * This bypasses AppKit/WalletConnect entirely.
 */

const HARDHAT_ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const HARDHAT_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CHAIN_ID = '0x7a69'; // 31337 in hex
const RPC_URL = 'http://127.0.0.1:8545';

export function getMockProviderScript() {
	return `
(function() {
	const ACCOUNT = '${HARDHAT_ACCOUNT}';
	const CHAIN_ID = '${CHAIN_ID}';
	const RPC_URL = '${RPC_URL}';
	const PRIVATE_KEY = '${HARDHAT_PRIVATE_KEY}';

	let requestId = 0;
	const listeners = {};

	async function rpcCall(method, params) {
		const res = await fetch(RPC_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params })
		});
		const json = await res.json();
		if (json.error) throw new Error(json.error.message);
		return json.result;
	}

	// Minimal keccak256 + secp256k1 signing via ethers loaded in-page
	// We defer signing to the RPC node using eth_sendTransaction with unlocked account
	// Hardhat node auto-unlocks all accounts

	const mockProvider = {
		isMetaMask: true,
		isConnected: () => true,
		selectedAddress: ACCOUNT,
		chainId: CHAIN_ID,
		networkVersion: '31337',

		on(event, handler) {
			if (!listeners[event]) listeners[event] = [];
			listeners[event].push(handler);
		},
		removeListener(event, handler) {
			if (listeners[event]) {
				listeners[event] = listeners[event].filter(h => h !== handler);
			}
		},
		removeAllListeners(event) {
			if (event) delete listeners[event];
			else Object.keys(listeners).forEach(k => delete listeners[k]);
		},
		emit(event, ...args) {
			if (listeners[event]) {
				listeners[event].forEach(h => { try { h(...args); } catch(e) { console.error(e); } });
			}
		},

		async request({ method, params }) {
			switch (method) {
				case 'eth_requestAccounts':
				case 'eth_accounts':
					return [ACCOUNT];
				case 'eth_chainId':
					return CHAIN_ID;
				case 'net_version':
					return '31337';
				case 'wallet_switchEthereumChain':
					return null;
				case 'wallet_addEthereumChain':
					return null;

				case 'eth_sendTransaction': {
					// Hardhat node has the account unlocked, so just forward
					const tx = params[0];
					tx.from = tx.from || ACCOUNT;
					return await rpcCall('eth_sendTransaction', [tx]);
				}

				case 'personal_sign': {
					// params: [message, account]
					return await rpcCall('personal_sign', [params[0], ACCOUNT]);
				}

				case 'eth_signTypedData_v4': {
					// Forward to Hardhat
					return await rpcCall('eth_signTypedData_v4', [ACCOUNT, params[1]]);
				}

				default:
					// Proxy all other calls to the RPC
					return await rpcCall(method, params || []);
			}
		}
	};

	// Install before anything else runs
	window.ethereum = mockProvider;

	// Mark as test environment
	window.__TEST_PROVIDER__ = true;
	window.__TEST_ACCOUNT__ = ACCOUNT;

	// Fire connect event after a microtask to let listeners attach
	setTimeout(() => {
		mockProvider.emit('connect', { chainId: CHAIN_ID });
		mockProvider.emit('accountsChanged', [ACCOUNT]);
		mockProvider.emit('chainChanged', CHAIN_ID);
	}, 100);
})();
`;
}

export { HARDHAT_ACCOUNT, HARDHAT_PRIVATE_KEY, CHAIN_ID, RPC_URL };
