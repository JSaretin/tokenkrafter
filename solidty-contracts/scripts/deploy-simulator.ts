/**
 * Deploy TokenSimulator on-chain.
 * Fund it with a small BNB so simulate() works via eth_call.
 *
 * Usage: npx hardhat run scripts/deploy-simulator.ts --network bsc
 */
import { ethers, run, network } from 'hardhat';

async function main() {
	const [deployer] = await ethers.getSigners();
	console.log('Deployer:', deployer.address);
	console.log('Balance:', ethers.formatEther(await ethers.provider.getBalance(deployer.address)), 'BNB');

	const Factory = await ethers.getContractFactory('TokenSimulator');
	const simulator = await Factory.deploy();
	await simulator.waitForDeployment();
	const addr = await simulator.getAddress();
	console.log('TokenSimulator deployed:', addr);

	// Fund with 0.05 BNB for simulations
	const fundTx = await deployer.sendTransaction({
		to: addr,
		value: ethers.parseEther('0.05')
	});
	await fundTx.wait();
	console.log('Funded with 0.05 BNB');

	// Verify
	if (network.name !== 'hardhat' && network.name !== 'localhost') {
		console.log('Waiting 15s for explorer indexing...');
		await new Promise(r => setTimeout(r, 15000));
		try {
			await run('verify:verify', { address: addr, constructorArguments: [] });
			console.log('Verified');
		} catch (e: any) {
			console.log('Verification:', e.message?.includes('already') ? 'Already verified' : e.message?.slice(0, 80));
		}
	}

	console.log('\nAdd to platform_config:');
	console.log(`  simulator_address: "${addr}"`);
}

main().catch(e => { console.error(e); process.exit(1); });
