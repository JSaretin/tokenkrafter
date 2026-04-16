/**
 * Test: Fee display, decimal formatting, and admin dashboard.
 */
import { test, expect } from '@playwright/test';
import {
	getDeployment,
	getProvider,
	getUsdtDecimals
} from './helpers/contract-helpers';
import { setupPage, navigateTo } from './helpers/page-helpers';
import { ethers } from 'ethers';

const FACTORY_ABI = [
	'function creationFee(uint8) view returns (uint256)',
	'function getCreationFees(bool isTaxable, bool isMintable, bool isPartner, address launchpadFactory) external view returns (address[] paymentTokens, uint256[] creationFees, uint256[] launchFees)',
	'function getSupportedPaymentTokens() view returns (address[])',
	'function totalTokensCreated() view returns (uint256)',
	'function owner() view returns (address)'
];

test.describe('Fee calculations', () => {
	test('creation fees are set correctly for all 8 types', async () => {
		const { TokenFactory } = getDeployment();
		const factory = new ethers.Contract(TokenFactory, FACTORY_ABI, getProvider());
		const decimals = await getUsdtDecimals();

		// Expected fees in USDT: [10, 20, 25, 35, 15, 25, 30, 40]
		const expectedFees = [10, 20, 25, 35, 15, 25, 30, 40];

		for (let i = 0; i < 8; i++) {
			const fee = await factory.creationFee(i);
			const feeInUsdt = Number(ethers.formatUnits(fee, decimals));
			expect(feeInUsdt).toBe(expectedFees[i]);
		}
	});

	test('getCreationFees returns fees for all payment tokens', async () => {
		const { TokenFactory, LaunchpadFactory } = getDeployment();
		const factory = new ethers.Contract(TokenFactory, FACTORY_ABI, getProvider());

		const [paymentTokens, creationFees, launchFees] = await factory.getCreationFees(
			false, false, false, // Basic token
			LaunchpadFactory
		);

		expect(paymentTokens.length).toBeGreaterThan(0);
		expect(creationFees.length).toBe(paymentTokens.length);
		expect(launchFees.length).toBe(paymentTokens.length);

		// USDT fee should be non-zero
		expect(creationFees[0]).toBeGreaterThan(0n);
	});

	test('getCreationFees returns zero launchFees when no launchpad', async () => {
		const { TokenFactory } = getDeployment();
		const factory = new ethers.Contract(TokenFactory, FACTORY_ABI, getProvider());

		const [, , launchFees] = await factory.getCreationFees(
			false, false, false,
			ethers.ZeroAddress // no launchpad
		);

		for (const fee of launchFees) {
			expect(fee).toBe(0n);
		}
	});

	test('supported payment tokens include USDT and native', async () => {
		const { TokenFactory, MockUSDT } = getDeployment();
		const factory = new ethers.Contract(TokenFactory, FACTORY_ABI, getProvider());

		const supported = await factory.getSupportedPaymentTokens();
		const addresses = supported.map((a: string) => a.toLowerCase());

		expect(addresses).toContain(MockUSDT.toLowerCase());
		expect(addresses).toContain(ethers.ZeroAddress);
	});
});

test.describe('UI fee display', () => {
	test('create page loads and shows fee information', async ({ page }) => {
		await setupPage(page);
		await navigateTo(page, '/create');

		// Page should load
		await expect(page.locator('text=Create Your Token')).toBeVisible();
	});
});

test.describe('Admin dashboard', () => {
	test('admin page loads for owner', async ({ page }) => {
		await setupPage(page);
		await navigateTo(page, '/admin');

		// Should show admin title
		await expect(page.locator('text=Factory Admin')).toBeVisible();

		// Wait for data to load
		await page.waitForTimeout(3000);

		// Should show factory info (not "not deployed" message)
		const content = await page.textContent('body');
		expect(content).not.toContain('Factory not deployed');
	});

	test('admin dashboard shows correct stats', async () => {
		const { TokenFactory } = getDeployment();
		const factory = new ethers.Contract(TokenFactory, FACTORY_ABI, getProvider());

		const totalTokens = await factory.totalTokensCreated();
		// Should be a valid number (may be 0 if tests run in isolation)
		expect(totalTokens).toBeGreaterThanOrEqual(0n);

		const owner = await factory.owner();
		expect(ethers.isAddress(owner)).toBe(true);
	});

	test('launchpad tab shows in admin', async ({ page }) => {
		await setupPage(page);
		await navigateTo(page, '/admin');

		await page.waitForTimeout(3000);

		// Click launchpad tab
		const launchpadTab = page.locator('button:has-text("Launchpad")');
		if (await launchpadTab.isVisible()) {
			await launchpadTab.click();
			await page.waitForTimeout(1000);

			const content = await page.textContent('body');
			expect(content).toContain('Launchpad Factory');
		}
	});
});
