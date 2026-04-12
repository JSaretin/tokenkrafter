// Read and pretty-print the current BSC entry in platform_config.networks.
import { createClient } from '@supabase/supabase-js';

const url = process.env.PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
	console.error('Missing PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
	process.exit(1);
}

const admin = createClient(url, key);
const { data, error } = await admin
	.from('platform_config')
	.select('value, updated_at')
	.eq('key', 'networks')
	.single();

if (error) {
	console.error('read failed:', error.message);
	process.exit(1);
}

const bsc = (data.value || []).find((n) => Number(n.chain_id) === 56);
if (!bsc) {
	console.log('no BSC entry found');
	process.exit(1);
}

console.log('updated_at:', data.updated_at);
console.log(JSON.stringify(bsc, null, 2));
