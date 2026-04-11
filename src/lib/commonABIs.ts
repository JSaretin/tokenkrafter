/**
 * Shared minimal ABIs. Import from here instead of inlining ABI strings in
 * route/component files — keeps the surface small and avoids per-component
 * drift when a contract interface changes.
 *
 * These are deliberately narrow: each ABI lists only the methods actually
 * called from the frontend so ethers can type them precisely without pulling
 * the full generated interface. For heavier use cases (write paths,
 * full contract state reads) prefer the specific helper modules:
 *   - tokenCrafter.ts   — TokenFactory + token creation flows
 *   - tradeRouter.ts    — TradeRouter swap + withdrawal paths
 *   - tradeLens.ts      — MultiCallLens batch reads for the trade UI
 */

/** Minimal ERC20 read surface (name/symbol/decimals/totalSupply/balance). */
export const TOKEN_READ_ABI = [
	'function name() view returns (string)',
	'function symbol() view returns (string)',
	'function decimals() view returns (uint8)',
	'function totalSupply() view returns (uint256)',
	'function balanceOf(address) view returns (uint256)',
	'function owner() view returns (address)',
] as const;

/** Just decimals — the minimum needed to scale an amount before a swap. */
export const ERC20_DECIMALS_ABI = [
	'function decimals() view returns (uint8)',
] as const;

/** Just totalSupply — used by list views that snapshot supply on load. */
export const ERC20_SUPPLY_ABI = [
	'function totalSupply() view returns (uint256)',
] as const;

/**
 * Lightweight Uniswap V2 router surface used for price lookups + WETH
 * discovery across multiple routes. Does NOT include write paths — those
 * are called via the full router ABI from tradeRouter.ts / PlatformRouter.
 */
export const ROUTER_ABI_LITE = [
	'function WETH() view returns (address)',
	'function factory() view returns (address)',
	'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])',
] as const;

/** Factory ABI surface used by the explore/server loader + daemon. */
export const TOKEN_FACTORY_READ_ABI = [
	'function totalTokensCreated() view returns (uint256)',
	'function getTokenByIndex(uint256 index) view returns (address)',
	'function getTokens(uint256 offset, uint256 limit) view returns (address[] tokens, uint256 total)',
	'function getTokensInfo(uint256 offset, uint256 limit) view returns (tuple(address tokenAddress, string name, string symbol, uint8 decimals, uint256 totalSupply, address creator, bool isMintable, bool isTaxable, bool isPartnership)[] views, uint256 total)',
	'function getCreatedTokens(address creator) view returns (address[])',
	'function tokenInfo(address) view returns (address creator, bool isMintable, bool isTaxable, bool isPartnership)',
] as const;
