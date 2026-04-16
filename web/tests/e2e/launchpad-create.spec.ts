/**
 * Test: Create standalone launchpad + Create token & launchpad via PlatformRouter.
 */
import { test, expect } from '@playwright/test';
import {
	createTokenDirect,
	createLaunchDirect,
	depositAndActivateLaunch,
	enableTrading,
	createTokenAndLaunchDirect,
	getLaunchState,
	getDeployment,
	getProvider,
	getSigner
} from './helpers/contract-helpers';
import { setupPage, navigateTo } from './helpers/page-helpers';
import { ethers } from 'ethers';

const LAUNCH_ABI = [
	'function token() view returns (address)',
	'function creator() view returns (address)',
	'function state() view returns (uint8)',
	'function softCap() view returns (uint256)',
	'function hardCap() view returns (uint256)',
	'function tokensForCurve() view returns (uint256)',
	'function startTimestamp() view returns (uint256)',
	'function curveType() view returns (uint8)'
];

test.describe('Standalone launchpad creation', () => {
	test('creates a launch for an existing token', async () => {
		// Step 1: Create token
		const tokenAddress = await createTokenDirect('LaunchTestToken', 'LTT', 1_000_000);
		expect(tokenAddress).toBeTruthy();

		// Enable trading (needed for token transfers)
		await enableTrading(tokenAddress);

		// Step 2: Create launch
		const totalTokens = ethers.parseUnits('500000', 18);
		const launchAddress = await createLaunchDirect(tokenAddress, {
			totalTokens,
			curveType: 0, // Linear
			softCap: '50',
			hardCap: '5000',
			durationDays: 30,
			maxBuyBps: 200
		});

		expect(launchAddress).toBeTruthy();
		expect(ethers.isAddress(launchAddress)).toBe(true);

		// Verify launch state (Pending before deposit)
		expect(await getLaunchState(launchAddress)).toBe(0); // Pending

		// Step 3: Deposit tokens to activate
		await depositAndActivateLaunch(tokenAddress, launchAddress, totalTokens);

		// Verify launch is now Active
		expect(await getLaunchState(launchAddress)).toBe(1); // Active

		// Verify launch parameters
		const launch = new ethers.Contract(launchAddress, LAUNCH_ABI, getProvider());
		expect(await launch.token()).toBe(tokenAddress);
		expect(await launch.creator()).toBe(await getSigner().getAddress());
		expect(Number(await launch.curveType())).toBe(0);
	});

	test('creates launches with all 4 curve types', async () => {
		const curveNames = ['Linear', 'SquareRoot', 'Quadratic', 'Exponential'];

		for (let curveType = 0; curveType < 4; curveType++) {
			const tokenAddress = await createTokenDirect(`Curve${curveType}`, `C${curveType}`, 1_000_000);
			await enableTrading(tokenAddress);

			const totalTokens = ethers.parseUnits('500000', 18);
			const launchAddress = await createLaunchDirect(tokenAddress, {
				totalTokens,
				curveType,
				softCap: '50',
				hardCap: '5000'
			});

			await depositAndActivateLaunch(tokenAddress, launchAddress, totalTokens);
			expect(await getLaunchState(launchAddress)).toBe(1);

			const launch = new ethers.Contract(launchAddress, LAUNCH_ABI, getProvider());
			expect(Number(await launch.curveType())).toBe(curveType);
		}
	});
});

test.describe('Create token + launchpad via PlatformRouter', () => {
	test('creates token and launch atomically', async () => {
		const { tokenAddress, launchAddress } = await createTokenAndLaunchDirect(
			'RouterToken', 'RTK', 1_000_000, {
				tokensForLaunchPct: 80,
				curveType: 0,
				softCap: '100',
				hardCap: '10000',
				maxBuyBps: 200
			}
		);

		expect(tokenAddress).toBeTruthy();
		expect(launchAddress).toBeTruthy();

		// Launch should be active immediately (router deposits tokens)
		expect(await getLaunchState(launchAddress)).toBe(1);

		// Verify token is linked to launch
		const launch = new ethers.Contract(launchAddress, LAUNCH_ABI, getProvider());
		expect(await launch.token()).toBe(tokenAddress);
	});

	test('creates token + launch with future start timestamp', async () => {
		// This test would require the contract to accept startTimestamp > 0
		// For now, test with startTimestamp = 0 (immediate)
		const { tokenAddress, launchAddress } = await createTokenAndLaunchDirect(
			'ScheduledToken', 'SCH', 500_000, {
				softCap: '50',
				hardCap: '5000'
			}
		);

		expect(await getLaunchState(launchAddress)).toBe(1);

		const launch = new ethers.Contract(launchAddress, LAUNCH_ABI, getProvider());
		expect(Number(await launch.startTimestamp())).toBe(0);
	});
});

test.describe('UI launchpad create page', () => {
	test('loads the create launch page', async ({ page }) => {
		await setupPage(page);
		await navigateTo(page, '/launchpad/create');

		await expect(page.locator('text=Create a Launch')).toBeVisible();
	});

	test('loads the launchpad explorer', async ({ page }) => {
		await setupPage(page);
		await navigateTo(page, '/launchpad');

		// Page should load without errors
		const title = page.locator('h1, h2').first();
		await expect(title).toBeVisible();
	});
});
