#!/usr/bin/env node
/**
 * Batch verify contracts using Etherscan V2 API (works for BscScan).
 * Uses the full build-info input (Standard JSON) to avoid viaIR non-determinism.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || 'FHBC8QKNHVXFMFAEKXVDQK3TYKJUXKIEZD';
const API_BASE = 'https://api.etherscan.io/v2/api';
const CHAIN_ID = 56; // BSC

// Load build-info
const biPath = path.join(__dirname, '..', 'deployments', 'bsc-build-info.json');
const bi = JSON.parse(fs.readFileSync(biPath, 'utf8'));
const compilerVersion = `v${bi.solcLongVersion}`;
const sourceCode = JSON.stringify(bi.input);

const contracts = [
  { name: 'BasicTokenImpl', address: '0x9b83614480FE5cE1ac121fB08675B5f49C788b57', path: 'contracts/tokens/BasicToken.sol:BasicTokenImpl', args: '' },
  { name: 'MintableTokenImpl', address: '0x488Bb7019E30e10Ad1Da83EC2C3FfBD12Ac09cD2', path: 'contracts/tokens/BasicToken.sol:MintableTokenImpl', args: '' },
  { name: 'TaxableTokenImpl', address: '0x58432A08136ed23DD0564149506C2bB97B731607', path: 'contracts/tokens/TaxableToken.sol:TaxableTokenImpl', args: '' },
  { name: 'TaxableMintableTokenImpl', address: '0x01A0bA6799ACD4D3774cAE60aC06b04035E17Fe0', path: 'contracts/tokens/TaxableToken.sol:TaxableMintableTokenImpl', args: '' },
  { name: 'PartnerTokenImpl', address: '0x18D51D198897D356C459a70f4373DEC88E0ce71e', path: 'contracts/tokens/PartnerToken.sol:PartnerTokenImpl', args: '' },
  { name: 'PartnerMintableTokenImpl', address: '0xb30a8e256834309E395BF1a8136e95ed05b95349', path: 'contracts/tokens/PartnerToken.sol:PartnerMintableTokenImpl', args: '' },
  { name: 'PartnerTaxableTokenImpl', address: '0xac820a5051cE0E86FDDEE526fbBB27f751D65840', path: 'contracts/tokens/PartnerTaxableToken.sol:PartnerTaxableTokenImpl', args: '' },
  { name: 'PartnerTaxableMintableTokenImpl', address: '0x5b0A316b36FA37A4c2b75148018e71Cc476a9273', path: 'contracts/tokens/PartnerTaxableToken.sol:PartnerTaxableMintableTokenImpl', args: '' },
  {
    name: 'TokenFactory',
    address: '0x2262BB0148308e134e1be09fB4b2Bc22680c1cC3',
    path: 'contracts/TokenFactory.sol:TokenFactory',
    // constructor(address _usdt, address _dexRouter, address _platformWallet)
    args: '00000000000000000000000055d398326f99059ff775485246999027b319795500000000000000000000000010ed43c718714eb63d5aa57b78b54704e256024e000000000000000000000000d2e349b0556fac6232a6623ac363259877891108',
  },
  {
    name: 'PlatformRouter',
    address: '0x0e5c469e715e3520Cfdd11FA81d403075a5f1b56',
    path: 'contracts/PlatformRouter.sol:PlatformRouter',
    // constructor(address _tokenFactory, address _launchpadFactory, address _dexRouter)
    args: '0000000000000000000000002262bb0148308e134e1be09fb4b2bc22680c1cc3000000000000000000000000d5ddd90e38c5cdab02ddcdd14b92639588451774000000000000000000000000' + '10ed43c718714eb63d5aa57b78b54704e256024e',
  },
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
  const data = await res.json();
  return data;
}

async function checkStatus(guid) {
  const url = `${API_BASE}?chainid=${CHAIN_ID}&apikey=${ETHERSCAN_API_KEY}&module=contract&action=checkverifystatus&guid=${guid}`;
  const res = await fetch(url);
  return res.json();
}

async function main() {
  console.log(`Compiler: ${compilerVersion}`);
  console.log(`Verifying ${contracts.length} contracts on BSC (chain ${CHAIN_ID})...\n`);

  const guids = [];

  for (const c of contracts) {
    process.stdout.write(`  ${c.name}... `);
    try {
      const result = await submitVerification(c);
      if (result.status === '1' || result.result) {
        const guid = result.result;
        guids.push({ name: c.name, guid });
        console.log(`submitted (guid: ${guid})`);
      } else {
        console.log(`FAILED: ${result.result || result.message}`);
      }
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
    }
    // Rate limit
    await new Promise(r => setTimeout(r, 1500));
  }

  // Wait and check results
  console.log('\nWaiting 30s for verification processing...');
  await new Promise(r => setTimeout(r, 30000));

  console.log('\nResults:');
  for (const { name, guid } of guids) {
    try {
      const result = await checkStatus(guid);
      const status = result.result || result.message;
      const ok = status?.includes('Pass') || status?.includes('Already Verified');
      console.log(`  ${ok ? '✓' : '✗'} ${name}: ${status}`);
    } catch (e) {
      console.log(`  ? ${name}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }
}

main().catch(console.error);
