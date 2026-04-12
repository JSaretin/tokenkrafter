// One-shot: patch the BSC (chain_id 56) entry in platform_config.networks
// with the addresses from the 2026-04-11 clean deploy + default_bases.
//
// Reads SUPABASE_SERVICE_ROLE_KEY + PUBLIC_SUPABASE_URL from the root .env.
// Leaves every other network entry in the array untouched.
// Bun auto-loads .env from CWD, so no dotenv import needed.
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

// Hydrate router + launchpad addresses from the canonical deployment artifact
// so this script always reflects the latest redeploy without manual edits.
const bscDeployment = JSON.parse(
	readFileSync('solidty-contracts/deployments/bsc.json', 'utf8')
);

const url = process.env.PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
	console.error('Missing PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
	process.exit(1);
}

const admin = createClient(url, key);

const BSC_PATCH = {
	chain_id: 56,
	name: 'BSC',
	symbol: 'BSC',
	native_coin: 'BNB',
	usdt_address: '0x55d398326f99059fF775485246999027B3197955',
	usdc_address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
	platform_address: bscDeployment.TokenFactory,
	// launchpad_address + router_address come from the deployment artifact so
	// a redeploy flows through automatically.
	launchpad_address: bscDeployment.LaunchpadFactory,
	router_address: bscDeployment.PlatformRouter,
	trade_router_address: bscDeployment.TradeRouter,
	trade_lens_address: bscDeployment.TradeLens,
	dex_router: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
	rpc: 'https://bsc-dataseed.binance.org/',
	explorer_url: 'https://bscscan.com',
	gecko_network: 'bsc',
	default_bases: [
		{
			address: '0x55d398326f99059fF775485246999027B3197955',
			symbol: 'USDT',
			name: 'Tether USD',
		},
		{
			address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
			symbol: 'WBNB',
			name: 'Wrapped BNB',
		},
		{
			address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
			symbol: 'USDC',
			name: 'USD Coin',
		},
	],
};

const { data: row, error: readErr } = await admin
	.from('platform_config')
	.select('value')
	.eq('key', 'networks')
	.single();

if (readErr) {
	console.error('Read failed:', readErr.message);
	process.exit(1);
}

const current = Array.isArray(row?.value) ? row.value : [];
let existingBsc = current.find((n) => Number(n.chain_id) === 56);
// Merge field-by-field so any custom keys (e.g. icons, priority) stay intact.
const merged = existingBsc ? { ...existingBsc, ...BSC_PATCH } : BSC_PATCH;
const others = current.filter((n) => Number(n.chain_id) !== 56);
const next = [...others, merged];

const { error: writeErr } = await admin
	.from('platform_config')
	.update({ value: next })
	.eq('key', 'networks');

if (writeErr) {
	console.error('Write failed:', writeErr.message);
	process.exit(1);
}

console.log('✓ platform_config.networks patched');
console.log(`  BSC entry ${existingBsc ? 'updated' : 'inserted'}`);
console.log(`  total networks: ${next.length}`);
console.log(`  default_bases: ${BSC_PATCH.default_bases.length}`);
