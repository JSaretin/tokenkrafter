/**
 * TokenKrafter Activity Bot — Real on-chain token creation
 *
 * Creates real tokens on BSC at random intervals to generate
 * organic-looking platform activity. Self-sustaining: withdraws
 * platform fees back to the bot wallet when balance runs low.
 *
 * Usage:
 *   PRIVATE_KEY=0x... npx hardhat run scripts/daemon/activity-bot.ts --network bsc
 *
 * Environment:
 *   PRIVATE_KEY         — Bot wallet private key (NOT the deployer/owner — use a separate hot wallet)
 *   SPEED               — burst | normal | slow (default: normal)
 *   MIN_BALANCE_BNB     — Withdraw fees when BNB drops below this (default: 0.05)
 *   OWNER_KEY           — Owner private key for withdrawing fees (optional, only if different from PRIVATE_KEY)
 */

import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

// ── Load .env ──
const envPath = path.resolve(__dirname, '../../../.env');
if (fs.existsSync(envPath)) {
	for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
		const m = line.match(/^([^#=]+)=(.*)$/);
		if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
	}
}

const SPEED = process.env.SPEED || 'normal';
const MIN_BALANCE = ethers.parseEther(process.env.MIN_BALANCE_BNB || '0.05');

// ── Speed configs (seconds between actions) ──
const SPEEDS: Record<string, { tokenMin: number; tokenMax: number; desc: string }> = {
	burst:  { tokenMin: 60,    tokenMax: 300,    desc: '1-5 min between tokens (3-day burst)' },
	normal: { tokenMin: 600,   tokenMax: 3600,   desc: '10-60 min between tokens (steady)' },
	slow:   { tokenMin: 3600,  tokenMax: 14400,  desc: '1-4 hours between tokens (background)' },
};

// ── Token name pools (Nigerian-themed, web3-themed, meme-themed) ──
const PREFIXES = [
	// Nigerian culture
	'Naija', 'Lagos', 'Abuja', 'Eko', 'Owambe', 'Gidi', 'Wahala', 'Chop',
	'Suya', 'Jollof', 'Amala', 'Pepper', 'Ankara', 'Nolly', 'Afro',
	'Hustle', 'Danfo', 'Agege', 'Bukka', 'Shayo', 'Palm', 'Oga',
	// Web3/DeFi
	'Moon', 'Yield', 'Stake', 'Degen', 'Alpha', 'Based', 'Mega',
	'Turbo', 'Hyper', 'Ultra', 'Quantum', 'Nova', 'Blaze', 'Surge',
	'Flux', 'Pulse', 'Apex', 'Zenith', 'Peak', 'Core', 'Prime',
	// Meme
	'Baby', 'Mini', 'Super', 'King', 'Lucky', 'Rich', 'Diamond',
	'Rocket', 'Power', 'Magic', 'Gold', 'Gem', 'Star', 'Fire',
];

const SUFFIXES = [
	'Token', 'Coin', 'Finance', 'Pay', 'Cash', 'Chain', 'Swap',
	'DAO', 'Protocol', 'Network', 'Labs', 'Hub', 'Bridge', 'Verse',
	'World', 'City', 'Club', 'Gang', 'Army', 'Nation', 'Empire',
	'', '', '', '', // often no suffix
];

const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const randInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

function generateToken(): { name: string; symbol: string; supply: bigint; typeKey: number } {
	const prefix = pick(PREFIXES);
	const suffix = pick(SUFFIXES);
	const name = suffix ? `${prefix} ${suffix}` : prefix;

	// Symbol: 3-6 chars from the name
	let symbol = prefix.toUpperCase().slice(0, randInt(3, 5));
	if (suffix && Math.random() > 0.5) {
		symbol = (prefix.slice(0, 2) + suffix.slice(0, 2)).toUpperCase();
	}

	// Supply: varied — 1M to 1T
	const supplyTiers = [
		1_000_000n,      // 1M
		10_000_000n,     // 10M
		100_000_000n,    // 100M
		1_000_000_000n,  // 1B
		10_000_000_000n, // 10B
		1_000_000_000_000n, // 1T
	];
	const supply = pick(supplyTiers) * BigInt(randInt(1, 9));

	// Type distribution (weighted toward basic + partner):
	// 0=basic(30%), 1=mintable(10%), 2=taxable(15%), 3=tax+mint(5%)
	// 4=partner(20%), 5=partner+mint(5%), 6=partner+tax(10%), 7=partner+tax+mint(5%)
	const typeWeights = [30, 10, 15, 5, 20, 5, 10, 5];
	const totalWeight = typeWeights.reduce((a, b) => a + b, 0);
	let roll = randInt(1, totalWeight);
	let typeKey = 0;
	for (let i = 0; i < typeWeights.length; i++) {
		roll -= typeWeights[i];
		if (roll <= 0) { typeKey = i; break; }
	}

	return { name, symbol, supply, typeKey };
}

// ── ABIs ──
const TOKEN_FACTORY_ABI = [
	'function createToken(string name, string symbol, uint256 totalSupply, uint8 decimals, uint8 tokenType, address paymentToken, address referral) external payable returns (address)',
	'function creationFee(uint8 tokenType) view returns (uint256)',
	'function convertFee(uint256 feeUsdt, address paymentToken) view returns (uint256)',
	'function getSupportedPaymentTokens() view returns (address[])',
	'function totalTokensCreated() view returns (uint256)',
	'function owner() view returns (address)',
	'function withdrawFees(address token) external',
];

const ERC20_ABI = [
	'function balanceOf(address) view returns (uint256)',
	'function approve(address, uint256) returns (bool)',
	'function decimals() view returns (uint8)',
];

async function main() {
	const provider = ethers.provider;
	const network = await provider.getNetwork();
	const chainId = Number(network.chainId);
	const speed = SPEEDS[SPEED] || SPEEDS.normal;

	// Load deployment
	const deployFile = chainId === 56 ? 'bsc' : chainId === 97 ? 'bscTestnet' : 'localhost';
	let deployment: any;
	try {
		deployment = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../deployments/${deployFile}.json`), 'utf-8'));
	} catch {
		console.error('❌ No deployment file found for chain', chainId);
		return;
	}

	// Use the first signer (from PRIVATE_KEY in hardhat config)
	const [bot] = await ethers.getSigners();
	const botAddress = bot.address;
	const balance = await provider.getBalance(botAddress);

	// Owner signer for fee withdrawal (may be different wallet)
	let ownerSigner = bot;
	if (process.env.OWNER_KEY) {
		ownerSigner = new ethers.Wallet(process.env.OWNER_KEY, provider);
	}

	const factory = new ethers.Contract(deployment.TokenFactory, TOKEN_FACTORY_ABI, bot);
	const factoryOwner = await factory.owner();
	const canWithdraw = factoryOwner.toLowerCase() === ownerSigner.address.toLowerCase();

	console.log(`
╔═══════════════════════════════════════════════════╗
║         TokenKrafter Activity Bot                 ║
╚═══════════════════════════════════════════════════╝
  Chain:        ${chainId} (${deployFile})
  Bot wallet:   ${botAddress}
  Balance:      ${ethers.formatEther(balance)} BNB
  Speed:        ${SPEED} — ${speed.desc}
  Min balance:  ${ethers.formatEther(MIN_BALANCE)} BNB
  Factory:      ${deployment.TokenFactory}
  Can withdraw: ${canWithdraw ? '✅ yes' : '❌ no (owner: ' + factoryOwner.slice(0, 10) + '...)'}
  Tokens so far: ${await factory.totalTokensCreated()}

  Press Ctrl+C to stop
`);

	if (balance < ethers.parseEther('0.01')) {
		console.error('❌ Bot wallet has insufficient BNB. Send at least 0.01 BNB to', botAddress);
		return;
	}

	let running = true;
	let tokensCreated = 0;
	let totalGasSpent = 0n;

	process.on('SIGINT', () => { running = false; console.log('\n⏹  Shutting down...'); });
	process.on('SIGTERM', () => { running = false; });

	while (running) {
		try {
			// ── Check balance, auto-withdraw if low ──
			const currentBalance = await provider.getBalance(botAddress);
			if (currentBalance < MIN_BALANCE && canWithdraw) {
				console.log(`\n  💰 Balance low (${ethers.formatEther(currentBalance)} BNB). Withdrawing fees...`);
				try {
					// Try to withdraw native token fees
					const factoryAsOwner = factory.connect(ownerSigner);
					const tx = await factoryAsOwner.withdrawFees(ethers.ZeroAddress);
					await tx.wait();
					const newBal = await provider.getBalance(botAddress);
					console.log(`  ✅ Withdrew fees. New balance: ${ethers.formatEther(newBal)} BNB`);
				} catch (e: any) {
					console.log(`  ⚠️  Withdraw failed: ${e.shortMessage || e.message?.slice(0, 60)}`);
				}
			}

			// ── Skip if too low even after withdrawal ──
			const balNow = await provider.getBalance(botAddress);
			if (balNow < ethers.parseEther('0.005')) {
				console.log(`  ⚠️  Balance too low (${ethers.formatEther(balNow)} BNB). Waiting...`);
				await new Promise(r => setTimeout(r, 60000));
				continue;
			}

			// ── Generate and create token ──
			const token = generateToken();
			const typeLabels = ['Basic', 'Mintable', 'Taxable', 'Tax+Mint', 'Partner', 'Partner+Mint', 'Partner+Tax', 'Partner+Tax+Mint'];
			const label = typeLabels[token.typeKey] || 'Basic';
			const supplyStr = ethers.formatUnits(token.supply * 10n ** 18n, 18);

			console.log(`\n  [${new Date().toLocaleTimeString()}] Creating: ${token.name} ($${token.symbol})`);
			console.log(`    Type: ${label} | Supply: ${Number(supplyStr).toLocaleString()}`);

			try {
				// Get creation fee
				const feeUsdt = await factory.creationFee(token.typeKey);
				let paymentToken = ethers.ZeroAddress; // pay with native
				let feeNative = 0n;

				if (feeUsdt > 0n) {
					try {
						feeNative = await factory.convertFee(feeUsdt, ethers.ZeroAddress);
					} catch {
						// If conversion fails, try with a small fixed amount
						feeNative = ethers.parseEther('0.01');
					}
					// Add 10% buffer for price movement
					feeNative = feeNative * 11n / 10n;
				}

				const gasEstimate = await factory.createToken.estimateGas(
					token.name, token.symbol,
					token.supply * 10n ** 18n, // total supply in wei
					18, token.typeKey,
					paymentToken, ethers.ZeroAddress, // no referral
					{ value: feeNative }
				);

				const tx = await factory.createToken(
					token.name, token.symbol,
					token.supply * 10n ** 18n,
					18, token.typeKey,
					paymentToken, ethers.ZeroAddress,
					{ value: feeNative, gasLimit: gasEstimate * 12n / 10n }
				);

				const receipt = await tx.wait();
				const gasCost = receipt!.gasUsed * receipt!.gasPrice;
				totalGasSpent += gasCost;
				tokensCreated++;

				// Parse token address from event
				let tokenAddr = '';
				try {
					const iface = new ethers.Interface(['event TokenCreated(address indexed creator, address indexed tokenAddress, uint8 tokenType, string name, string symbol, uint256 totalSupply, uint8 decimals)']);
					for (const log of receipt!.logs) {
						try {
							const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
							if (parsed?.name === 'TokenCreated') { tokenAddr = parsed.args[1]; break; }
						} catch {}
					}
				} catch {}

				console.log(`    ✅ Created! Token: ${tokenAddr.slice(0, 10)}...`);
				console.log(`    Gas: ${ethers.formatEther(gasCost)} BNB | Fee: ${ethers.formatEther(feeNative)} BNB`);
				console.log(`    Total: ${tokensCreated} tokens | Gas spent: ${ethers.formatEther(totalGasSpent)} BNB`);

			} catch (e: any) {
				console.log(`    ❌ Failed: ${e.shortMessage || e.message?.slice(0, 80)}`);
			}

		} catch (e: any) {
			console.error(`  ❌ Error: ${e.message?.slice(0, 80)}`);
		}

		// ── Random delay before next token ──
		const delaySec = randInt(speed.tokenMin, speed.tokenMax);
		const delayMin = (delaySec / 60).toFixed(1);
		console.log(`  ⏳ Next token in ~${delayMin} min`);

		// Wait in small chunks so we can respond to SIGINT
		const endTime = Date.now() + delaySec * 1000;
		while (running && Date.now() < endTime) {
			await new Promise(r => setTimeout(r, 5000));
		}
	}

	console.log(`\n✅ Bot stopped. Created ${tokensCreated} tokens. Total gas: ${ethers.formatEther(totalGasSpent)} BNB`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
