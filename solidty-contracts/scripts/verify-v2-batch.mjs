#!/usr/bin/env node
/**
 * Batch verify all deployed contracts on BscScan via Etherscan V2 API.
 * Reads addresses from deployments/{network}.json and constructor args
 * from the same file. Uses the build-info Standard JSON to avoid the
 * viaIR non-determinism that breaks hardhat-verify.
 *
 * Usage: node scripts/verify-v2-batch.mjs [network]
 *   network defaults to "bsc"
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || process.env.ETHERSCAN_API_KEYS?.split(',')[0] || '';
if (!ETHERSCAN_API_KEY) {
	console.error('❌ ETHERSCAN_API_KEY required');
	process.exit(1);
}

const NETWORK = process.argv[2] || 'bsc';
const CHAIN_IDS = { bsc: 56, bscTestnet: 97 };
const CHAIN_ID = CHAIN_IDS[NETWORK];
if (!CHAIN_ID) {
	console.error(`❌ Unknown network: ${NETWORK}`);
	process.exit(1);
}

const API_BASE = 'https://api.etherscan.io/v2/api';

const dep = JSON.parse(
	fs.readFileSync(path.join(__dirname, '..', 'deployments', `${NETWORK}.json`), 'utf8')
);
const bi = JSON.parse(
	fs.readFileSync(path.join(__dirname, '..', 'deployments', `${NETWORK}-build-info.json`), 'utf8')
);
const compilerVersion = `v${bi.solcLongVersion}`;
const sourceCode = JSON.stringify(bi.input);

// ABI-encode constructor args to hex (no 0x prefix).
function encodeArgs(types, values) {
	const { AbiCoder } = require('ethers');
	return new AbiCoder().encode(types, values).slice(2);
}

// Use viem-free encoding via a tiny inline function to avoid pulling ethers
// into this script. Args are short and known, so we just template the hex.
function pad(addr) {
	return addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

const argsTokenFactory = pad(dep.USDT) + pad(dep.DEXRouter) + pad(dep.PlatformWallet);
const argsLaunchpadFactory =
	pad(dep.PlatformWallet) + pad(dep.DEXRouter) + pad(dep.USDT) + pad(dep.LaunchInstanceImpl);
const argsPlatformRouter =
	pad(dep.TokenFactory) + pad(dep.LaunchpadFactory) + pad(dep.DEXRouter);
const argsTradeRouter = pad(dep.DEXRouter) + pad(dep.USDT) + pad(dep.PlatformWallet);
// Affiliate constructor = (address usdt, address admin). deploy.ts sets
// admin = deployer (not PlatformWallet) so onlyOwner setters can be
// called from the script without a separate transferOwnership tx.
const argsAffiliate = pad(dep.USDT) + pad(dep.Deployer);

const contracts = [
	// Token impls (no constructor args)
	{ name: 'BasicTokenImpl', address: dep.BasicTokenImpl, path: 'contracts/tokens/BasicToken.sol:BasicTokenImpl', args: '' },
	{ name: 'MintableTokenImpl', address: dep.MintableTokenImpl, path: 'contracts/tokens/BasicToken.sol:MintableTokenImpl', args: '' },
	{ name: 'TaxableTokenImpl', address: dep.TaxableTokenImpl, path: 'contracts/tokens/TaxableToken.sol:TaxableTokenImpl', args: '' },
	{ name: 'TaxableMintableTokenImpl', address: dep.TaxableMintableTokenImpl, path: 'contracts/tokens/TaxableToken.sol:TaxableMintableTokenImpl', args: '' },
	{ name: 'PartnerTokenImpl', address: dep.PartnerTokenImpl, path: 'contracts/tokens/PartnerToken.sol:PartnerTokenImpl', args: '' },
	{ name: 'PartnerMintableTokenImpl', address: dep.PartnerMintableTokenImpl, path: 'contracts/tokens/PartnerToken.sol:PartnerMintableTokenImpl', args: '' },
	{ name: 'PartnerTaxableTokenImpl', address: dep.PartnerTaxableTokenImpl, path: 'contracts/tokens/PartnerTaxableToken.sol:PartnerTaxableTokenImpl', args: '' },
	{ name: 'PartnerTaxableMintableTokenImpl', address: dep.PartnerTaxableMintableTokenImpl, path: 'contracts/tokens/PartnerTaxableToken.sol:PartnerTaxableMintableTokenImpl', args: '' },
	// Libraries + impl. BondingCurve was moved into LaunchMath.sol when
	// the curve dispatch was extracted into LaunchMath; LaunchInstance
	// now links against LaunchMath only (which links BondingCurve).
	{ name: 'BondingCurve', address: dep.BondingCurve, path: 'contracts/LaunchMath.sol:BondingCurve', args: '' },
	{ name: 'LaunchMath', address: dep.LaunchMath, path: 'contracts/LaunchMath.sol:LaunchMath', args: '' },
	{ name: 'LaunchInstance', address: dep.LaunchInstanceImpl, path: 'contracts/LaunchInstance.sol:LaunchInstance', args: '' },
	// Core contracts with constructor args
	{ name: 'TokenFactory', address: dep.TokenFactory, path: 'contracts/TokenFactory.sol:TokenFactory', args: argsTokenFactory },
	{ name: 'LaunchpadFactory', address: dep.LaunchpadFactory, path: 'contracts/LaunchpadFactory.sol:LaunchpadFactory', args: argsLaunchpadFactory },
	{ name: 'PlatformRouter', address: dep.PlatformRouter, path: 'contracts/PlatformRouter.sol:PlatformRouter', args: argsPlatformRouter },
	{ name: 'TradeRouter', address: dep.TradeRouter, path: 'contracts/TradeRouter.sol:TradeRouter', args: argsTradeRouter },
	{ name: 'Affiliate', address: dep.Affiliate, path: 'contracts/Affiliate.sol:Affiliate', args: argsAffiliate },
];

async function submitVerification(c) {
	const url = `${API_BASE}?chainid=${CHAIN_ID}`;
	const params = new URLSearchParams();
	params.append('apikey', ETHERSCAN_API_KEY);
	params.append('module', 'contract');
	params.append('action', 'verifysourcecode');
	params.append('contractaddress', c.address);
	params.append('sourceCode', sourceCode);
	params.append('codeformat', 'solidity-standard-json-input');
	params.append('contractname', c.path);
	params.append('compilerversion', compilerVersion);
	if (c.args) params.append('constructorArguements', c.args);

	const res = await fetch(url, { method: 'POST', body: params });
	return res.json();
}

async function checkStatus(guid) {
	const url = `${API_BASE}?chainid=${CHAIN_ID}&apikey=${ETHERSCAN_API_KEY}&module=contract&action=checkverifystatus&guid=${guid}`;
	const res = await fetch(url);
	return res.json();
}

async function main() {
	console.log(`Compiler: ${compilerVersion}`);
	console.log(`Verifying ${contracts.length} contracts on chain ${CHAIN_ID}…\n`);

	const guids = [];
	for (const c of contracts) {
		if (!c.address) {
			console.log(`  ${c.name}: skipped (no address)`);
			continue;
		}
		process.stdout.write(`  ${c.name}... `);
		try {
			const result = await submitVerification(c);
			if (result.status === '1' || result.result) {
				const guid = result.result;
				guids.push({ name: c.name, guid });
				console.log(`submitted (${guid})`);
			} else {
				console.log(`FAILED: ${result.result || result.message}`);
			}
		} catch (e) {
			console.log(`ERROR: ${e.message}`);
		}
		await new Promise(r => setTimeout(r, 1500)); // rate limit
	}

	console.log('\nWaiting 30s for processing...');
	await new Promise(r => setTimeout(r, 30000));

	console.log('\nResults:');
	for (const { name, guid } of guids) {
		try {
			const result = await checkStatus(guid);
			const status = result.result || result.message;
			const ok = status?.includes('Pass') || status?.includes('Already');
			console.log(`  ${ok ? '✓' : '✗'} ${name}: ${status}`);
		} catch (e) {
			console.log(`  ? ${name}: ${e.message}`);
		}
		await new Promise(r => setTimeout(r, 500));
	}
}

main().catch(console.error);
