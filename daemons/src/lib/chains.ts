/**
 * Multi-chain context loader, shared by the indexer daemons.
 *
 * Each daemon used to be pinned to a single chain via env (CHAIN_ID +
 * RPC_URL). Now they fetch every enabled network from
 * /api/config?keys=networks at startup and run a per-chain inner
 * loop. Adding a new chain in the DB picks it up on the next daemon
 * restart — no compose changes.
 */

export type Network = {
	chain_id: number;
	rpc: string;
	ws_rpc?: string;
	daemon_rpc?: string;
	trade_router_address?: string;
	platform_address?: string;
	affiliate_address?: string;
	launchpad_address?: string;
	router_address?: string;
	usdt_address?: string;
	usdc_address?: string;
	name?: string;
	native_coin?: string;
	explorer_url?: string;
	gecko_network?: string;
	onramp_gas_drip?: number;
	[key: string]: unknown;
};

/** Pick the best RPC URL for daemon-side reads/writes, preferring the
 *  private daemon_rpc (typically MEV-protected) over the public one. */
export function pickDaemonRpc(net: Network): { http: string; ws: string } {
	const dr = (net.daemon_rpc as string) || '';
	const isWs = dr.startsWith('wss://') || dr.startsWith('ws://');
	return {
		http: !isWs && dr ? dr : net.rpc || '',
		ws: isWs ? dr : (net.ws_rpc as string) || '',
	};
}

/** Load every enabled network entry from the backend config. The
 *  authHeader is used for daemon_rpc which is a private field gated by
 *  the daemon SYNC_SECRET on the API side. */
export async function loadNetworks(apiBase: string, authHeader?: string): Promise<Network[]> {
	const headers: Record<string, string> = {};
	if (authHeader) headers.Authorization = authHeader;
	const res = await fetch(`${apiBase}/api/config?keys=networks`, { headers });
	if (!res.ok) throw new Error(`/api/config?keys=networks → ${res.status}`);
	const body = await res.json().catch(() => ({}));
	const networks = body?.networks;
	if (!Array.isArray(networks)) return [];
	return networks
		.map((n: any) => ({ ...n, chain_id: Number(n?.chain_id) }))
		.filter((n: Network) => Number.isFinite(n.chain_id) && (n.rpc || n.ws_rpc || n.daemon_rpc));
}
