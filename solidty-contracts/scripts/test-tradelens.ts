/**
 * Test TradeLens via state override on BSC
 * Usage: npx hardhat run scripts/test-tradelens.ts --network bsc
 */
import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

const artifact = JSON.parse(
	fs.readFileSync(path.resolve(__dirname, '../artifacts/contracts/TradeLens.sol/TradeLens.json'), 'utf-8')
);

const ABI = [
	`function query(address router, address[] tokens, address user, address simulateTax, uint256 simBuyAmount) external returns (
		tuple(
			address weth,
			address factory,
			uint256 nativeBalance,
			tuple(address token, string symbol, string name, uint8 decimals, uint256 reserveToken, uint256 reserveBase, address pairAddress, bool hasLiquidity, uint256 balance)[] tokens,
			tuple(bool success, bool canBuy, bool canSell, uint256 buyTaxBps, uint256 sellTaxBps, uint256 buyGas, uint256 sellGas, string buyError, string sellError) taxInfo,
			address taxToken
		)
	)`
];

const PANCAKE_ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
const USDT = '0x55d398326f99059fF775485246999027B3197955';
const USDC = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';
const WKC = ethers.getAddress('0x6Ec90334d89dBdc89E08A133271be3d104128Edb');
const CAKE = '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82';
const USER = '0xC3Bd82Ac0913f71a9bbDcc72898ecA85CEa53652'; // your wallet

async function main() {
	const provider = ethers.provider;
	const iface = new ethers.Interface(ABI);
	const simAddr = '0x' + '3'.repeat(40);

	const tokens = [USDT, USDC, WKC, CAKE];

	console.log('='.repeat(60));
	console.log('TradeLens Test — BSC');
	console.log('='.repeat(60));
	console.log(`Tokens: USDT, USDC, WKC, CAKE`);
	console.log(`Simulate tax for: WKC`);
	console.log(`User balances for: ${USER.slice(0, 10)}...`);
	console.log('-'.repeat(60));

	const calldata = iface.encodeFunctionData('query', [
		PANCAKE_ROUTER,
		tokens,
		USER,
		WKC,
		ethers.parseEther('0.001')
	]);

	try {
		const result = await provider.send('eth_call', [
			{ to: simAddr, data: calldata },
			'latest',
			{ [simAddr]: { code: artifact.deployedBytecode, balance: ethers.toBeHex(ethers.parseEther('10')) } }
		]);

		const r = iface.decodeFunctionResult('query', result)[0];

		console.log(`\nWETH: ${r.weth}`);
		console.log(`Factory: ${r.factory}`);
		console.log(`Native balance: ${ethers.formatEther(r.nativeBalance)} BNB`);

		console.log('\n── Token Info ──');
		for (const t of r.tokens) {
			const bal = ethers.formatUnits(t.balance, t.decimals);
			const resT = t.hasLiquidity ? ethers.formatUnits(t.reserveToken, t.decimals) : '0';
			const resB = t.hasLiquidity ? ethers.formatEther(t.reserveBase) : '0';
			console.log(`  ${t.symbol.padEnd(6)} dec=${t.decimals} bal=${bal} liq=${t.hasLiquidity ? '✅' : '❌'} reserves=${resT} / ${resB} BNB`);
		}

		console.log('\n── Tax Simulation (WKC) ──');
		const tax = r.taxInfo;
		console.log(`  Can Buy:   ${tax.canBuy ? '✅' : '❌'} ${tax.buyError || ''}`);
		console.log(`  Can Sell:  ${tax.canSell ? '✅' : '❌'} ${tax.sellError || ''}`);
		console.log(`  Buy Tax:   ${Number(tax.buyTaxBps) / 100}%`);
		console.log(`  Sell Tax:  ${Number(tax.sellTaxBps) / 100}%`);
		console.log(`  Honeypot:  ${tax.success ? 'NO ✅' : 'YES ⚠️'}`);

	} catch (e: any) {
		console.log('FAILED:', e.message?.slice(0, 200));
		if (e.data) console.log('Data:', e.data?.slice(0, 40));
	}
}

main().catch(e => { console.error(e); process.exit(1); });
