/**
 * Deploy the 8 permit-bearing token impls and wire them into the
 * existing TokenFactory via setImplementation(typeKey, impl) — one
 * call per slot so creationFee[typeKey] stays untouched.
 *
 * The factory's bytecode is unchanged; we're only swapping which
 * impls future Clones.cloneDeterministic calls bind to. Tokens
 * already deployed keep pointing at their original impl by design.
 *
 * Run:
 *   bunx hardhat run scripts/deploy-permit-impls.ts --network bsc
 *
 * Requires env (in .envs/prod/contracts.env):
 *   DEPLOYER_PRIVATE_KEY  — the factory owner's key
 *   TOKEN_FACTORY_ADDRESS — set on the command line:
 *     TOKEN_FACTORY_ADDRESS=0x... bunx hardhat run scripts/deploy-permit-impls.ts --network bsc
 */

import hre from "hardhat";
import { ethers } from "ethers";

const TYPES: { name: string; typeKey: number }[] = [
	{ name: "BasicTokenImpl",                  typeKey: 0 },
	{ name: "MintableTokenImpl",               typeKey: 1 },
	{ name: "TaxableTokenImpl",                typeKey: 2 },
	{ name: "TaxableMintableTokenImpl",        typeKey: 3 },
	{ name: "PartnerTokenImpl",                typeKey: 4 },
	{ name: "PartnerMintableTokenImpl",        typeKey: 5 },
	{ name: "PartnerTaxableTokenImpl",         typeKey: 6 },
	{ name: "PartnerTaxableMintableTokenImpl", typeKey: 7 },
];

async function main() {
	const factoryAddr = process.env.TOKEN_FACTORY_ADDRESS;
	if (!factoryAddr) throw new Error("TOKEN_FACTORY_ADDRESS env var required");

	const [signer] = await hre.ethers.getSigners();
	const signerAddr = await signer.getAddress();
	const balance = await hre.ethers.provider.getBalance(signerAddr);
	console.log("─".repeat(70));
	console.log("  Network:    ", (await hre.ethers.provider.getNetwork()).name, "/", (await hre.ethers.provider.getNetwork()).chainId);
	console.log("  Deployer:   ", signerAddr);
	console.log("  Balance:    ", ethers.formatEther(balance), "BNB");
	console.log("  Factory:    ", factoryAddr);
	console.log("─".repeat(70));

	const factory = await hre.ethers.getContractAt("TokenFactory", factoryAddr);
	const owner = await factory.owner();
	if (owner.toLowerCase() !== signerAddr.toLowerCase()) {
		throw new Error(`Deployer ${signerAddr} is not factory owner ${owner}`);
	}
	console.log("  ✓ Deployer is factory owner\n");

	// ── Snapshot current impls so we can diff after ────────────────
	console.log("  Current impls on chain:");
	const before: string[] = [];
	for (const t of TYPES) {
		const a = await factory.implementations(t.typeKey);
		before.push(a);
		console.log(`    ${String(t.typeKey).padStart(2)} ${t.name.padEnd(36)} ${a}`);
	}
	console.log();

	// ── Step 1: deploy each impl ───────────────────────────────────
	console.log("  Deploying impls:");
	const deployed: { typeKey: number; name: string; addr: string }[] = [];
	for (const t of TYPES) {
		const F = await hre.ethers.getContractFactory(t.name);
		const c = await F.deploy();
		await c.waitForDeployment();
		const addr = await c.getAddress();
		console.log(`    ✓ ${t.name.padEnd(36)} → ${addr}`);
		deployed.push({ typeKey: t.typeKey, name: t.name, addr });
	}
	console.log();

	// ── Step 2: setImplementation per slot (does NOT touch creationFee) ──
	console.log("  Wiring factory:");
	for (const d of deployed) {
		const tx = await factory.setImplementation(d.typeKey, d.addr);
		const receipt = await tx.wait();
		console.log(`    ✓ setImplementation(${d.typeKey}, ${d.addr})  tx=${receipt!.hash}  gas=${receipt!.gasUsed}`);
	}
	console.log();

	// ── Step 3: verify ─────────────────────────────────────────────
	console.log("  Verifying:");
	let allOk = true;
	for (const d of deployed) {
		const onChain = await factory.implementations(d.typeKey);
		const ok = onChain.toLowerCase() === d.addr.toLowerCase();
		if (!ok) allOk = false;
		console.log(`    ${ok ? "✓" : "✗"} type ${d.typeKey} → ${onChain}`);
	}
	if (!allOk) throw new Error("post-wire verification failed");

	const balanceAfter = await hre.ethers.provider.getBalance(signerAddr);
	console.log("\n─".repeat(70));
	console.log("  Done. New permit-bearing impls live for typeKeys 0-7.");
	console.log("  Spent:", ethers.formatEther(balance - balanceAfter), "BNB");
	console.log("─".repeat(70));

	// Print a copy-pasteable verify-on-bscscan command list
	console.log("\nVerify on BscScan (run after a brief delay so the indexer catches up):");
	for (const d of deployed) {
		console.log(`  bunx hardhat verify --network bsc ${d.addr}`);
	}
}

main().catch((e) => { console.error(e); process.exit(1); });
