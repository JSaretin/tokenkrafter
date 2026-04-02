/**
 * Test TokenSimulator against WIKI CAT (WKC) on BSC
 * WKC has 2% buy, 2% sell, 2% transfer tax
 *
 * Usage: npx hardhat run scripts/test-simulator.ts --network bsc
 */
import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

const PANCAKE_ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
const WIKI_CAT = ethers.getAddress('0x6Ec90334d89dBdc89E08A133271be3d104128Edb'); // WKC on BSC

// Load simulator bytecode from compiled artifact
const artifact = JSON.parse(
	fs.readFileSync(
		path.resolve(__dirname, '../artifacts/contracts/TokenSimulator.sol/TokenSimulator.json'),
		'utf-8'
	)
);

const SIMULATOR_ABI = [
	'function simulate(address router, address token, uint256 buyAmount) external returns (tuple(bool success, bool canBuy, bool canSell, uint256 buyTaxBps, uint256 sellTaxBps, uint256 buyGas, uint256 sellGas, uint256 expectedBuy, uint256 actualBuy, uint256 expectedSell, uint256 actualSell, string buyError, string sellError, string tokenName, string tokenSymbol, uint8 tokenDecimals, uint256 tokenTotalSupply, uint256 pairReserveToken, uint256 pairReserveETH, address pairAddress))'
];

async function main() {
	const provider = ethers.provider;


	const simAddr = '0xD32a223791FdbD063E09153C523979f8eC9bB0E2';
	const buyAmount = ethers.parseEther('0.0001'); // simulate with 0.0001 BNB

	console.log('='.repeat(60));
	console.log('TokenSimulator Test — WIKI CAT (WKC) on BSC');
	console.log('='.repeat(60));
	console.log(`Simulator addr: ${simAddr} (virtual, not deployed)`);
	console.log(`DEX Router:     ${PANCAKE_ROUTER}`);
	console.log(`Token:          ${WIKI_CAT}`);
	console.log(`Buy amount:     ${ethers.formatEther(buyAmount)} BNB`);
	console.log('-'.repeat(60));

	try {
		// Use staticCall on the funded deployed contract — works on any RPC
		const simulator = new ethers.Contract(simAddr, SIMULATOR_ABI, provider);
		const r = await simulator.simulate.staticCall(PANCAKE_ROUTER, WIKI_CAT, buyAmount);

		console.log('\n📊 SIMULATION RESULTS\n');

		console.log(`Token:          ${r.tokenName} (${r.tokenSymbol})`);
		console.log(`Decimals:       ${r.tokenDecimals}`);
		console.log(`Total Supply:   ${ethers.formatUnits(r.tokenTotalSupply, r.tokenDecimals)}`);
		console.log(`Pair:           ${r.pairAddress}`);
		console.log(`Reserves:       ${ethers.formatUnits(r.pairReserveToken, r.tokenDecimals)} ${r.tokenSymbol} / ${ethers.formatEther(r.pairReserveETH)} BNB`);

		console.log('\n── Buy ──');
		console.log(`Can Buy:        ${r.canBuy ? '✅ YES' : '❌ NO'}`);
		if (r.buyError) console.log(`Buy Error:      ${r.buyError}`);
		console.log(`Expected:       ${ethers.formatUnits(r.expectedBuy, r.tokenDecimals)} ${r.tokenSymbol}`);
		console.log(`Actual:         ${ethers.formatUnits(r.actualBuy, r.tokenDecimals)} ${r.tokenSymbol}`);
		console.log(`Buy Tax:        ${Number(r.buyTaxBps) / 100}%`);
		console.log(`Buy Gas:        ${r.buyGas.toString()}`);

		console.log('\n── Sell ──');
		console.log(`Can Sell:        ${r.canSell ? '✅ YES' : '❌ NO (HONEYPOT!)'}`);
		if (r.sellError) console.log(`Sell Error:      ${r.sellError}`);
		console.log(`Expected:       ${ethers.formatEther(r.expectedSell)} BNB`);
		console.log(`Actual:         ${ethers.formatEther(r.actualSell)} BNB`);
		console.log(`Sell Tax:        ${Number(r.sellTaxBps) / 100}%`);
		console.log(`Sell Gas:        ${r.sellGas.toString()}`);

		console.log('\n── Overall ──');
		console.log(`Success:        ${r.success ? '✅ SAFE — can buy and sell' : '⚠️  RISKY'}`);
		console.log(`Total Tax:      ${(Number(r.buyTaxBps) + Number(r.sellTaxBps)) / 100}% (buy + sell)`);

		if (!r.canSell) {
			console.log('\n🚨 HONEYPOT DETECTED — users cannot sell this token!');
		}

	} catch (e: any) {
		console.error('Simulation failed:', e.message?.slice(0, 200));
		if (e.data) console.error('Data:', e.data);
	}
}

main().catch(e => { console.error(e); process.exit(1); });
