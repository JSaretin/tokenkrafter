/**
 * TokenKrafter Activity Bot — Multi-wallet token creation
 *
 * Creates real tokens on BSC from rotating derived wallets so
 * on-chain activity looks organic (different creator addresses).
 *
 * Master wallet (factory owner) scatters BNB to derived wallets
 * and withdraws factory fees back when balances run low.
 *
 * Usage:
 *   BOT_MNEMONIC="..." npx hardhat run scripts/daemon/activity-bot.ts --network bsc
 *
 * Environment:
 *   BOT_MNEMONIC        — 12/24-word mnemonic to derive bot wallets from
 *   WALLET_COUNT         — Number of derived wallets (default: 10)
 *   SPEED                — burst | normal | slow (default: normal)
 *   MIN_BALANCE_BNB      — Refund wallet when BNB drops below this (default: 0.02)
 *   FUND_AMOUNT_BNB      — Amount to send when refunding a wallet (default: 0.05)
 *   OWNER_KEY            — Factory owner private key for withdrawing fees & funding
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
const WALLET_COUNT = parseInt(process.env.WALLET_COUNT || '10', 10);
const MIN_BALANCE = ethers.parseEther(process.env.MIN_BALANCE_BNB || '0.02');
const FUND_AMOUNT = ethers.parseEther(process.env.FUND_AMOUNT_BNB || '0.05');

// ── Speed configs (seconds between actions) ──
const SPEEDS: Record<string, { tokenMin: number; tokenMax: number; desc: string }> = {
	burst:  { tokenMin: 60,    tokenMax: 300,    desc: '1-5 min between tokens' },
	normal: { tokenMin: 600,   tokenMax: 3600,   desc: '10-60 min between tokens' },
	slow:   { tokenMin: 3600,  tokenMax: 14400,  desc: '1-4 hours between tokens' },
};

// ── Token name pools ──
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

	let symbol = prefix.toUpperCase().slice(0, randInt(3, 5));
	if (suffix && Math.random() > 0.5) {
		symbol = (prefix.slice(0, 2) + suffix.slice(0, 2)).toUpperCase();
	}

	const supplyTiers = [
		1_000_000n, 10_000_000n, 100_000_000n,
		1_000_000_000n, 10_000_000_000n, 1_000_000_000_000n,
	];
	const supply = pick(supplyTiers) * BigInt(randInt(1, 9));

	// Type distribution: 0=basic(30%), 1=mintable(10%), 2=taxable(15%), 3=tax+mint(5%)
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
	'function totalTokensCreated() view returns (uint256)',
	'function owner() view returns (address)',
	'function withdrawFees(address token) external',
];

// ── Derive wallets from mnemonic ──
function deriveWallets(mnemonic: string, count: number, provider: any): ethers.Wallet[] {
	const hdNode = ethers.HDNodeWallet.fromMnemonic(
		ethers.Mnemonic.fromPhrase(mnemonic),
		"m/44'/60'/0'/0"
	);
	const wallets: ethers.Wallet[] = [];
	for (let i = 0; i < count; i++) {
		const child = hdNode.deriveChild(i);
		wallets.push(new ethers.Wallet(child.privateKey, provider));
	}
	return wallets;
}

async function main() {
	const provider = ethers.provider;
	const network = await provider.getNetwork();
	const chainId = Number(network.chainId);
	const speed = SPEEDS[SPEED] || SPEEDS.normal;

	// ── Validate mnemonic ──
	const mnemonic = process.env.BOT_MNEMONIC;
	if (!mnemonic) {
		console.error('❌ BOT_MNEMONIC is required. Generate one with:');
		console.error('   node -e "console.log(require(\'ethers\').Wallet.createRandom().mnemonic.phrase)"');
		return;
	}

	// ── Load deployment ──
	const deployFile = chainId === 56 ? 'bsc' : chainId === 97 ? 'bscTestnet' : 'localhost';
	let deployment: any;
	try {
		deployment = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../deployments/${deployFile}.json`), 'utf-8'));
	} catch {
		console.error('❌ No deployment file found for chain', chainId);
		return;
	}

	// ── Owner signer (for fee withdrawal & funding) ──
	const ownerKey = process.env.OWNER_KEY || process.env.DEPLOYER_PRIVATE_KEY;
	if (!ownerKey) {
		console.error('❌ OWNER_KEY or DEPLOYER_PRIVATE_KEY is required (factory owner, funds the wallets)');
		return;
	}
	const owner = new ethers.Wallet(ownerKey, provider);

	// ── Derive bot wallets ──
	const wallets = deriveWallets(mnemonic, WALLET_COUNT, provider);

	// ── Check factory ownership ──
	const factory = new ethers.Contract(deployment.TokenFactory, TOKEN_FACTORY_ABI, owner);
	const factoryOwner = await factory.owner();
	const canWithdraw = factoryOwner.toLowerCase() === owner.address.toLowerCase();

	// ── Print balances ──
	const ownerBalance = await provider.getBalance(owner.address);
	const walletBalances = await Promise.all(wallets.map(w => provider.getBalance(w.address)));

	console.log(`
╔═══════════════════════════════════════════════════╗
║         TokenKrafter Activity Bot v2              ║
║         Multi-Wallet Mode                         ║
╚═══════════════════════════════════════════════════╝
  Chain:          ${chainId} (${deployFile})
  Speed:          ${SPEED} — ${speed.desc}
  Factory:        ${deployment.TokenFactory}
  Owner:          ${owner.address}
  Owner balance:  ${ethers.formatEther(ownerBalance)} BNB
  Can withdraw:   ${canWithdraw ? '✅ yes' : '❌ no (owner: ' + factoryOwner.slice(0, 10) + '...)'}
  Tokens so far:  ${await factory.totalTokensCreated()}

  Bot Wallets (${WALLET_COUNT}):
${wallets.map((w, i) => `    [${i}] ${w.address}  ${ethers.formatEther(walletBalances[i])} BNB`).join('\n')}

  Min balance:    ${ethers.formatEther(MIN_BALANCE)} BNB
  Fund amount:    ${ethers.formatEther(FUND_AMOUNT)} BNB

  Press Ctrl+C to stop
`);

	// ── Initial funding: top up any wallet below minimum ──
	await fundWallets(owner, wallets, provider);

	let running = true;
	let tokensCreated = 0;
	let totalGasSpent = 0n;

	process.on('SIGINT', () => { running = false; console.log('\n⏹  Shutting down...'); });
	process.on('SIGTERM', () => { running = false; });

	while (running) {
		try {
			// ── Pick a random wallet ──
			const walletIdx = randInt(0, wallets.length - 1);
			const wallet = wallets[walletIdx];
			const walletBal = await provider.getBalance(wallet.address);

			// ── Fund if low ──
			if (walletBal < MIN_BALANCE) {
				console.log(`\n  💰 Wallet [${walletIdx}] low (${ethers.formatEther(walletBal)} BNB). Funding...`);
				const funded = await fundSingle(owner, wallet.address, provider, canWithdraw ? factory : null);
				if (!funded) {
					console.log(`  ⚠️  Could not fund wallet [${walletIdx}]. Trying another...`);
					// Try to pick a funded wallet instead
					const funded_wallet = await pickFundedWallet(wallets, provider);
					if (!funded_wallet) {
						console.log(`  ❌ All wallets underfunded. Waiting 60s...`);
						await sleep(60000, () => running);
						continue;
					}
					// Use the funded wallet this round
					await createToken(funded_wallet.wallet, funded_wallet.idx, factory, provider, deployment);
					tokensCreated++;
					continue;
				}
			}

			// ── Create token ──
			const result = await createToken(wallet, walletIdx, factory, provider, deployment);
			if (result) {
				totalGasSpent += result.gasCost;
				tokensCreated++;
				console.log(`    Total: ${tokensCreated} tokens | Gas spent: ${ethers.formatEther(totalGasSpent)} BNB`);
			}

		} catch (e: any) {
			console.error(`  ❌ Error: ${e.message?.slice(0, 80)}`);
		}

		// ── Random delay ──
		const delaySec = randInt(speed.tokenMin, speed.tokenMax);
		console.log(`  ⏳ Next token in ~${(delaySec / 60).toFixed(1)} min`);
		await sleep(delaySec * 1000, () => running);
	}

	console.log(`\n✅ Bot stopped. Created ${tokensCreated} tokens. Total gas: ${ethers.formatEther(totalGasSpent)} BNB`);
}

// ── Create a token from a specific wallet ──
async function createToken(
	wallet: ethers.Wallet,
	walletIdx: number,
	factory: ethers.Contract,
	provider: any,
	deployment: any
): Promise<{ gasCost: bigint } | null> {
	const token = generateToken();
	const typeLabels = ['Basic', 'Mintable', 'Taxable', 'Tax+Mint', 'Partner', 'Partner+Mint', 'Partner+Tax', 'Partner+Tax+Mint'];
	const label = typeLabels[token.typeKey] || 'Basic';
	const supplyStr = ethers.formatUnits(token.supply * 10n ** 18n, 18);

	console.log(`\n  [${new Date().toLocaleTimeString()}] Wallet [${walletIdx}] ${wallet.address.slice(0, 10)}...`);
	console.log(`    Creating: ${token.name} ($${token.symbol}) | ${label} | Supply: ${Number(supplyStr).toLocaleString()}`);

	try {
		const factoryAsWallet = factory.connect(wallet);

		// Get creation fee
		const feeUsdt = await factory.creationFee(token.typeKey);
		let feeNative = 0n;

		if (feeUsdt > 0n) {
			try {
				feeNative = await factory.convertFee(feeUsdt, ethers.ZeroAddress);
			} catch {
				feeNative = ethers.parseEther('0.01');
			}
			feeNative = feeNative * 11n / 10n; // 10% buffer
		}

		const gasEstimate = await factoryAsWallet.createToken.estimateGas(
			token.name, token.symbol,
			token.supply * 10n ** 18n,
			18, token.typeKey,
			ethers.ZeroAddress, ethers.ZeroAddress,
			{ value: feeNative }
		);

		const tx = await factoryAsWallet.createToken(
			token.name, token.symbol,
			token.supply * 10n ** 18n,
			18, token.typeKey,
			ethers.ZeroAddress, ethers.ZeroAddress,
			{ value: feeNative, gasLimit: gasEstimate * 12n / 10n }
		);

		const receipt = await tx.wait();
		const gasCost = receipt!.gasUsed * receipt!.gasPrice;

		// Parse token address from event
		let tokenAddr = '';
		try {
			const iface = new ethers.Interface([
				'event TokenCreated(address indexed creator, address indexed tokenAddress, uint8 tokenType, string name, string symbol, uint256 totalSupply, uint8 decimals)'
			]);
			for (const log of receipt!.logs) {
				try {
					const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
					if (parsed?.name === 'TokenCreated') { tokenAddr = parsed.args[1]; break; }
				} catch {}
			}
		} catch {}

		console.log(`    ✅ Created! Token: ${tokenAddr.slice(0, 10)}...`);
		console.log(`    Gas: ${ethers.formatEther(gasCost)} BNB | Fee: ${ethers.formatEther(feeNative)} BNB`);

		return { gasCost };
	} catch (e: any) {
		console.log(`    ❌ Failed: ${e.shortMessage || e.message?.slice(0, 80)}`);
		return null;
	}
}

// ── Fund a single wallet from owner ──
async function fundSingle(
	owner: ethers.Wallet,
	to: string,
	provider: any,
	factory: ethers.Contract | null
): Promise<boolean> {
	const ownerBal = await provider.getBalance(owner.address);

	// If owner is low, try withdrawing factory fees first
	if (ownerBal < FUND_AMOUNT * 2n && factory) {
		console.log(`  💰 Owner low too. Withdrawing factory fees...`);
		try {
			const tx = await factory.withdrawFees(ethers.ZeroAddress);
			await tx.wait();
			const newBal = await provider.getBalance(owner.address);
			console.log(`  ✅ Withdrew fees. Owner balance: ${ethers.formatEther(newBal)} BNB`);
		} catch (e: any) {
			console.log(`  ⚠️  Fee withdrawal failed: ${e.shortMessage || e.message?.slice(0, 60)}`);
		}
	}

	// Check again
	const bal = await provider.getBalance(owner.address);
	if (bal < FUND_AMOUNT + ethers.parseEther('0.005')) {
		console.log(`  ❌ Owner balance too low to fund (${ethers.formatEther(bal)} BNB)`);
		return false;
	}

	try {
		const tx = await owner.sendTransaction({ to, value: FUND_AMOUNT });
		await tx.wait();
		console.log(`  ✅ Sent ${ethers.formatEther(FUND_AMOUNT)} BNB → ${to.slice(0, 10)}...`);
		return true;
	} catch (e: any) {
		console.log(`  ❌ Fund tx failed: ${e.shortMessage || e.message?.slice(0, 60)}`);
		return false;
	}
}

// ── Fund all wallets that are below minimum ──
async function fundWallets(owner: ethers.Wallet, wallets: ethers.Wallet[], provider: any) {
	const balances = await Promise.all(wallets.map(w => provider.getBalance(w.address)));
	const needFunding = wallets.filter((_, i) => balances[i] < MIN_BALANCE);

	if (needFunding.length === 0) {
		console.log('  ✅ All wallets funded');
		return;
	}

	console.log(`\n  💰 Funding ${needFunding.length} wallet(s)...`);
	for (const w of needFunding) {
		const ownerBal = await provider.getBalance(owner.address);
		if (ownerBal < FUND_AMOUNT + ethers.parseEther('0.005')) {
			console.log(`  ⚠️  Owner out of funds. Remaining wallets unfunded.`);
			break;
		}
		try {
			const tx = await owner.sendTransaction({ to: w.address, value: FUND_AMOUNT });
			await tx.wait();
			console.log(`    ✅ ${w.address.slice(0, 10)}... funded`);
		} catch (e: any) {
			console.log(`    ❌ ${w.address.slice(0, 10)}... failed: ${e.shortMessage || e.message?.slice(0, 60)}`);
		}
	}
}

// ── Pick a wallet that has enough balance ──
async function pickFundedWallet(wallets: ethers.Wallet[], provider: any): Promise<{ wallet: ethers.Wallet; idx: number } | null> {
	// Shuffle to avoid always picking the same one
	const indices = Array.from({ length: wallets.length }, (_, i) => i);
	for (let i = indices.length - 1; i > 0; i--) {
		const j = randInt(0, i);
		[indices[i], indices[j]] = [indices[j], indices[i]];
	}

	for (const idx of indices) {
		const bal = await provider.getBalance(wallets[idx].address);
		if (bal >= MIN_BALANCE) return { wallet: wallets[idx], idx };
	}
	return null;
}

// ── Interruptible sleep ──
async function sleep(ms: number, isRunning: () => boolean) {
	const end = Date.now() + ms;
	while (isRunning() && Date.now() < end) {
		await new Promise(r => setTimeout(r, 5000));
	}
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
