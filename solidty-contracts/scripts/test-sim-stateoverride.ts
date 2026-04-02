/**
 * Test TokenSimulator via state override (no deployment needed)
 * Usage: npx hardhat run scripts/test-sim-stateoverride.ts --network bsc
 */
import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

const artifact = JSON.parse(
	fs.readFileSync(path.resolve(__dirname, '../artifacts/contracts/TokenSimulator.sol/TokenSimulator.json'), 'utf-8')
);

const SIM_RESULT_TUPLE = 'tuple(bool success, bool canBuy, bool canSell, uint256 buyTaxBps, uint256 sellTaxBps, uint256 buyGas, uint256 sellGas, uint256 expectedBuy, uint256 actualBuy, uint256 expectedSell, uint256 actualSell, string buyError, string sellError, string tokenName, string tokenSymbol, uint8 tokenDecimals, uint256 tokenTotalSupply, uint256 pairReserveToken, uint256 pairReserveETH, address pairAddress)';
const SIMULATOR_ABI = [
	`function simulate(address router, address token, uint256 buyAmount) external returns (${SIM_RESULT_TUPLE})`,
	`function simulateWithPath(address router, address token, uint256 buyAmount, address[] buyPath) public returns (${SIM_RESULT_TUPLE})`
];

const PANCAKE_ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
const CAKE = '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82';

async function main() {
	const provider = ethers.provider;
	const simAddr = '0x' + '1'.repeat(40);
	const iface = new ethers.Interface(SIMULATOR_ABI);
	const buyAmount = ethers.parseEther('0.001');

	console.log('Testing state override (no deploy) with CAKE...\n');

	const calldata = iface.encodeFunctionData('simulate', [PANCAKE_ROUTER, CAKE, buyAmount]);

	try {
		const result = await provider.send('eth_call', [
			{ to: simAddr, data: calldata },
			'latest',
			{
				[simAddr]: {
					code: artifact.deployedBytecode,
					balance: ethers.toBeHex(ethers.parseEther('10'))
				}
			}
		]);

		const d = iface.decodeFunctionResult('simulate', result)[0];
		console.log('SUCCESS — State override works on this RPC!\n');
		console.log(`Token:     ${d.tokenName} (${d.tokenSymbol})`);
		console.log(`Can Buy:   ${d.canBuy ? '✅' : '❌'} ${d.buyError || ''}`);
		console.log(`Can Sell:  ${d.canSell ? '✅' : '❌'} ${d.sellError || ''}`);
		console.log(`Buy Tax:   ${Number(d.buyTaxBps) / 100}%`);
		console.log(`Sell Tax:  ${Number(d.sellTaxBps) / 100}%`);
		console.log(`Honeypot:  ${d.success ? 'NO ✅' : 'YES ⚠️'}`);
		// ── Test WKC via WBNB → USDT → WKC path ──
		console.log('\n' + '─'.repeat(50));
		console.log('Testing WIKI CAT (WKC) via WBNB → USDT → WKC...\n');

		const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
		const USDT = '0x55d398326f99059fF775485246999027B3197955';
		const WKC = ethers.getAddress('0x6Ec90334d89dBdc89E08A133271be3d104128Edb');

		// Direct WBNB → WKC path (pair exists)
		const wkcCalldata = iface.encodeFunctionData('simulate', [
			PANCAKE_ROUTER, WKC, buyAmount
		]);

		try {
			const wkcResult = await provider.send('eth_call', [
				{ to: simAddr, data: wkcCalldata },
				'latest',
				{
					[simAddr]: {
						code: artifact.deployedBytecode,
						balance: ethers.toBeHex(ethers.parseEther('10'))
					}
				}
			]);

			const w = iface.decodeFunctionResult('simulate', wkcResult)[0];
			console.log(`Token:     ${w.tokenName} (${w.tokenSymbol})`);
			console.log(`Can Buy:   ${w.canBuy ? '✅' : '❌'} ${w.buyError || ''}`);
			console.log(`Can Sell:  ${w.canSell ? '✅' : '❌'} ${w.sellError || ''}`);
			console.log(`Buy Tax:   ${Number(w.buyTaxBps) / 100}%`);
			console.log(`Sell Tax:  ${Number(w.sellTaxBps) / 100}%`);
			console.log(`Expected:  ${ethers.formatUnits(w.expectedBuy, w.tokenDecimals)} ${w.tokenSymbol}`);
			console.log(`Actual:    ${ethers.formatUnits(w.actualBuy, w.tokenDecimals)} ${w.tokenSymbol}`);
			console.log(`Honeypot:  ${w.success ? 'NO ✅' : 'YES ⚠️'}`);
		} catch (e2: any) {
			console.log('WKC simulation failed:', e2.message?.slice(0, 150));
		}

	} catch (e: any) {
		console.log('State override FAILED:', e.message?.slice(0, 150));
		console.log('\nFalling back to deployed contract...\n');

		// Fallback: use deployed simulator with staticCall
		const deployed = '0xD32a223791FdbD063E09153C523979f8eC9bB0E2';
		const sim = new ethers.Contract(deployed, SIMULATOR_ABI, provider);
		try {
			const d = await sim.simulate.staticCall(PANCAKE_ROUTER, CAKE, buyAmount, { gasLimit: 15000000 });
			console.log('DEPLOYED CONTRACT — staticCall works!\n');
			console.log(`Token:     ${d.tokenName} (${d.tokenSymbol})`);
			console.log(`Can Buy:   ${d.canBuy ? '✅' : '❌'} ${d.buyError || ''}`);
			console.log(`Can Sell:  ${d.canSell ? '✅' : '❌'} ${d.sellError || ''}`);
			console.log(`Buy Tax:   ${Number(d.buyTaxBps) / 100}%`);
			console.log(`Sell Tax:  ${Number(d.sellTaxBps) / 100}%`);
			console.log(`Honeypot:  ${d.success ? 'NO ✅' : 'YES ⚠️'}`);
		} catch (e2: any) {
			console.log('Deployed contract also failed:', e2.message?.slice(0, 150));
		}
	}
}

main().catch(e => { console.error(e); process.exit(1); });
