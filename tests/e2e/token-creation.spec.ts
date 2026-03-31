/**
 * Test: Create each of the 8 token types via direct contract calls.
 * Verifies that the TokenFactory correctly creates all token types.
 */
import { test, expect } from '@playwright/test';
import {
	createTokenDirect,
	TOKEN_TYPES,
	getDeployment,
	getSigner,
	getProvider
} from './helpers/contract-helpers';
import { setupPage, navigateTo } from './helpers/page-helpers';
import { ethers } from 'ethers';

const FACTORY_ABI = [
	'function getCreatedTokens(address creator) view returns (address[])',
	'function totalTokensCreated() view returns (uint256)'
];

const TOKEN_ABI = [
	'function name() view returns (string)',
	'function symbol() view returns (string)',
	'function decimals() view returns (uint8)',
	'function totalSupply() view returns (uint256)',
	'function owner() view returns (address)'
];

for (const [index, tokenType] of TOKEN_TYPES.entries()) {
	test(`creates ${tokenType.name} token (type ${index})`, async () => {
		const name = `Test${tokenType.name}`;
		const symbol = `T${index}`;
		const supply = 1_000_000;

		const tokenAddress = await createTokenDirect(name, symbol, supply, {
			isTaxable: tokenType.isTaxable,
			isMintable: tokenType.isMintable,
			isPartner: tokenType.isPartner
		});

		expect(tokenAddress).toBeTruthy();
		expect(ethers.isAddress(tokenAddress)).toBe(true);

		// Verify token metadata on-chain
		const token = new ethers.Contract(tokenAddress, TOKEN_ABI, getProvider());
		expect(await token.name()).toBe(name);
		expect(await token.symbol()).toBe(symbol);
		expect(Number(await token.decimals())).toBe(18);

		const expectedSupply = ethers.parseUnits(String(supply), 18);
		expect(await token.totalSupply()).toBe(expectedSupply);

		// Verify factory tracked it
		const { TokenFactory } = getDeployment();
		const factory = new ethers.Contract(TokenFactory, FACTORY_ABI, getProvider());
		const created = await factory.getCreatedTokens(await getSigner().getAddress());
		expect(created).toContain(tokenAddress);
	});
}

test('factory totalTokensCreated increments correctly', async () => {
	const { TokenFactory } = getDeployment();
	const factory = new ethers.Contract(TokenFactory, FACTORY_ABI, getProvider());

	const before = Number(await factory.totalTokensCreated());
	await createTokenDirect('CountTest', 'CNT', 100_000);
	const after = Number(await factory.totalTokensCreated());

	expect(after).toBe(before + 1);
});

test('UI shows create token page', async ({ page }) => {
	await setupPage(page);
	await navigateTo(page, '/create');

	// Check page loaded
	await expect(page.locator('text=Create Your Token')).toBeVisible();

	// Check form elements exist
	await expect(page.locator('#token-name, input[placeholder*="My Awesome"]')).toBeVisible();
});
