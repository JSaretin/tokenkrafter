import { ethers } from 'hardhat';

async function main() {
	const [deployer] = await ethers.getSigners();
	console.log('Deployer:', deployer.address);
	console.log('Balance:', ethers.formatEther(await ethers.provider.getBalance(deployer.address)), 'BNB');

	const Factory = await ethers.getContractFactory('TradeLens');
	const contract = await Factory.deploy();
	await contract.waitForDeployment();
	const addr = await contract.getAddress();
	console.log('TradeLens deployed:', addr);

	// Fund with 0.001 BNB for tax simulations
	const bal = await ethers.provider.getBalance(deployer.address);
	if (bal > ethers.parseEther('0.002')) {
		const tx = await deployer.sendTransaction({ to: addr, value: ethers.parseEther('0.001') });
		await tx.wait();
		console.log('Funded with 0.001 BNB');
	} else {
		console.log('Low balance — fund manually');
	}
}

main().catch(e => { console.error(e); process.exit(1); });
