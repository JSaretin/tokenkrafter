#!/usr/bin/env bun
/**
 * Sync .envs/prod/web.env → Cloudflare Pages env vars (as secrets) via wrangler.
 *
 * Usage:
 *   bun scripts/sync-cf-env.mjs                            # uses CF_PAGES_PROJECT env / first project
 *   bun scripts/sync-cf-env.mjs <project-name>             # explicit project name
 *
 * Cloudflare Pages doesn't distinguish "secret" vs "var" at the storage layer
 * for our purposes — both are write-only, both are exposed to the Functions
 * runtime. We treat everything in web.env as a secret. PUBLIC_* values are
 * still injected at build time on CF Pages because the SvelteKit adapter reads
 * them from process.env during the build step.
 *
 * After running, trigger a redeploy in the CF Pages dashboard (or push a
 * commit) so the new values take effect on the live site.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const ENV_FILE = join(ROOT, '.envs', 'prod', 'web.env');

const project = process.argv[2] || process.env.CF_PAGES_PROJECT;
if (!project) {
	console.error('Pass the Pages project name: bun scripts/sync-cf-env.mjs <project-name>');
	console.error('Or set CF_PAGES_PROJECT env var.');
	console.error('List projects with: wrangler pages project list');
	process.exit(1);
}

// Parse KEY=value lines. Strips wrapping quotes (single or double) since
// wrangler stores raw strings — quotes would become part of the value otherwise.
function parseEnvFile(path) {
	const src = readFileSync(path, 'utf8');
	const out = {};
	for (const raw of src.split('\n')) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
		if (!m) continue;
		let value = m[2];
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (!value) continue; // skip empty values
		out[m[1]] = value;
	}
	return out;
}

const vars = parseEnvFile(ENV_FILE);
const names = Object.keys(vars);
console.log(`Found ${names.length} variables in ${ENV_FILE}:`);
for (const k of names) {
	const masked = /SECRET|KEY|PASSWORD|TOKEN|MNEMONIC|URI/.test(k) ? '<redacted>' : vars[k];
	console.log(`  ${k}=${masked}`);
}
console.log();

// Bulk upload via wrangler. File-based input avoids shell escaping issues.
const tmp = mkdtempSync(join(tmpdir(), 'cf-sync-'));
const jsonPath = join(tmp, 'secrets.json');
writeFileSync(jsonPath, JSON.stringify(vars, null, 2));

console.log(`Pushing to Cloudflare Pages project: ${project}`);
const result = spawnSync(
	'wrangler',
	['pages', 'secret', 'bulk', jsonPath, `--project-name=${project}`],
	{ stdio: 'inherit' },
);

rmSync(tmp, { recursive: true, force: true });

if (result.status !== 0) {
	console.error(`\nwrangler exited with status ${result.status}`);
	process.exit(result.status ?? 1);
}

console.log('\nDone. Trigger a redeploy in the CF Pages dashboard so the new values take effect.');
