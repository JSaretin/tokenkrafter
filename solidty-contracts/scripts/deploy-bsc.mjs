#!/usr/bin/env node
// Thin wrapper: read platform_config.networks from Supabase, pick BSC's
// daemon_rpc (private RPC, same as the off-ramp daemon uses), expose it
// as BSC_RPC_URL, then exec the hardhat deploy script. This keeps the
// deploy away from flaky public endpoints.
//
// Supabase creds are read from ../../web/.env (single source of truth).
// Uses PostgREST directly via fetch — no @supabase/supabase-js dep.

import { readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const webEnvPath = join(here, '..', '..', 'web', '.env');

function readEnv(path, key) {
	const src = readFileSync(path, 'utf8');
	const m = src.match(new RegExp(`^${key}=(.*)$`, 'm'));
	return m ? m[1].replace(/^["']|["']$/g, '').trim() : undefined;
}

const SUPA_URL = process.env.PUBLIC_SUPABASE_URL || readEnv(webEnvPath, 'PUBLIC_SUPABASE_URL');
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || readEnv(webEnvPath, 'SUPABASE_SERVICE_ROLE_KEY');

if (!SUPA_URL || !SUPA_KEY) {
	console.error('Missing PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in web/.env');
	process.exit(1);
}

const res = await fetch(
	`${SUPA_URL.replace(/\/$/, '')}/rest/v1/platform_config?key=eq.networks&select=value`,
	{ headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` } },
);
if (!res.ok) {
	console.error(`Supabase read failed: ${res.status} ${await res.text()}`);
	process.exit(1);
}
const rows = await res.json();
const networks = Array.isArray(rows?.[0]?.value) ? rows[0].value : [];
const bsc = networks.find((n) => Number(n.chain_id) === 56);
if (!bsc) {
	console.error('No BSC (chain_id 56) entry in platform_config.networks');
	process.exit(1);
}

// daemon_rpc is the preferred private endpoint. Strip ws(s):// — hardhat's
// JsonRpcProvider wants HTTP only.
const daemonRpc = (bsc.daemon_rpc || '').trim();
const isWs = daemonRpc.startsWith('ws://') || daemonRpc.startsWith('wss://');
const rpcUrl = (!isWs && daemonRpc) || bsc.rpc || 'https://bsc-dataseed.binance.org/';

console.log(`Using BSC RPC: ${rpcUrl}${isWs ? ' (daemon_rpc is ws, fell back to public rpc)' : ''}`);

const hardhatScript = process.argv[2] || 'scripts/deploy.ts';
const result = spawnSync(
	'npx',
	['hardhat', 'run', hardhatScript, '--network', 'bsc'],
	{
		cwd: join(here, '..'),
		stdio: 'inherit',
		env: { ...process.env, BSC_RPC_URL: rpcUrl },
	},
);
process.exit(result.status ?? 1);
