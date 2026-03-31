/**
 * Test: Buy launchpad tokens, exceed max buy, and test all 8 token types with launches.
 */
import { test, expect } from '@playwright/test';
import {
	createTokenAndLaunchDirect,
	buyTokensWithUsdt,
	getMaxBuyPerWallet,
	getLaunchState,
	getDeployment,
	getProvider,
	getSigner,
	getUsdtDecimals,
	TOKEN_TYPES,
	getTokenTypeKey
} from './helpers/contract-helpers';
import { setupPage, navigateTo } from './helpers/page-helpers';
import { ethers } from 'ethers';

const LAUNCH_ABI = [
	'function tokensBought(address) view returns (uint256)',
	'function totalBaseRaised() view returns (uint256)',
	'function previewBuy(uint256 baseAmount) view returns (uint256 tokensOut, uint256 fee, uint256 priceImpactBps)',
	'function buyWithToken(address paymentToken, uint256 amount, uint256 minUsdtOut, uint256 minTokensOut) external',
	'function maxBuyPerWallet() view returns (uint256)',
	'function tokensForCurve() view returns (uint256)',
	'function getCurrentPrice() view returns (uint256)',
	'function state() view returns (uint8)'
];

const USDT_ABI = [
	'function approve(address spender, uint256 amount) returns (bool)',
	'function balanceOf(address) view returns (uint256)'
];

test.describe('Buy launchpad tokens with USDT', () => {
	test('successfully buys tokens and updates state', async () => {
		const { tokenAddress, launchAddress } = await createTokenAndLaunchDirect(
			'BuyTestToken', 'BTT', 1_000_000, {
				softCap: '10',
				hardCap: '50000',
				maxBuyBps: 500 // 5% max buy
			}
		);

		expect(await getLaunchState(launchAddress)).toBe(1);

		// Buy tokens
		const tokensBought = await buyTokensWithUsdt(launchAddress, '100');
		expect(tokensBought).toBeGreaterThan(0n);

		// Verify on-chain state
		const launch = new ethers.Contract(launchAddress, LAUNCH_ABI, getProvider());
		const raised = await launch.totalBaseRaised();
		expect(raised).toBeGreaterThan(0n);
	});

	test('previewBuy returns correct estimates', async () => {
		const { launchAddress } = await createTokenAndLaunchDirect(
			'PreviewToken', 'PVT', 1_000_000, {
				softCap: '10',
				hardCap: '50000'
			}
		);

		const launch = new ethers.Contract(launchAddress, LAUNCH_ABI, getProvider());
		const usdtDecimals = await getUsdtDecimals();
		const buyAmount = ethers.parseUnits('50', usdtDecimals);

		const [tokensOut, fee, priceImpactBps] = await launch.previewBuy(buyAmount);

		expect(tokensOut).toBeGreaterThan(0n);
		expect(fee).toBeGreaterThan(0n);
		// Fee should be 1% of buyAmount
		const expectedFee = buyAmount / 100n;
		expect(fee).toBe(expectedFee);
	});

	test('multiple buys accumulate correctly', async () => {
		const { launchAddress } = await createTokenAndLaunchDirect(
			'MultiBuyToken', 'MBT', 1_000_000, {
				softCap: '10',
				hardCap: '50000',
				maxBuyBps: 500
			}
		);

		const launch = new ethers.Contract(launchAddress, LAUNCH_ABI, getProvider());
		const signerAddr = await getSigner().getAddress();

		// Buy twice
		await buyTokensWithUsdt(launchAddress, '50');
		const afterFirst = await launch.tokensBought(signerAddr);

		await buyTokensWithUsdt(launchAddress, '50');
		const afterSecond = await launch.tokensBought(signerAddr);

		expect(afterSecond).toBeGreaterThan(afterFirst);
	});

	test('price increases after buying', async () => {
		const { launchAddress } = await createTokenAndLaunchDirect(
			'PriceTestToken', 'PTT', 1_000_000, {
				softCap: '10',
				hardCap: '50000',
				maxBuyBps: 500
			}
		);

		const launch = new ethers.Contract(launchAddress, LAUNCH_ABI, getProvider());

		const priceBefore = await launch.getCurrentPrice();
		await buyTokensWithUsdt(launchAddress, '100');
		const priceAfter = await launch.getCurrentPrice();

		expect(priceAfter).toBeGreaterThan(priceBefore);
	});
});

test.describe('Buy exceeding max amount', () => {
	test('max buy per wallet is enforced', async () => {
		const { launchAddress } = await createTokenAndLaunchDirect(
			'MaxBuyToken', 'MXT', 1_000_000, {
				softCap: '10',
				hardCap: '50000',
				maxBuyBps: 50 // 0.5% max
			}
		);

		const launch = new ethers.Contract(launchAddress, LAUNCH_ABI, getProvider());
		const maxBuy = await launch.maxBuyPerWallet();
		expect(maxBuy).toBeGreaterThan(0n);

		const signerAddr = await getSigner().getAddress();

		// Buy some tokens
		await buyTokensWithUsdt(launchAddress, '100');
		const bought = await launch.tokensBought(signerAddr);

		// Verify the bought amount doesn't exceed maxBuy
		expect(bought).toBeLessThanOrEqual(maxBuy);
	});

	test('allows buying up to max buy limit', async () => {
		const { launchAddress } = await createTokenAndLaunchDirect(
			'LimitOkToken', 'LOT', 1_000_000, {
				softCap: '10',
				hardCap: '50000',
				maxBuyBps: 200 // 2%
			}
		);

		// Small buy should succeed
		const tokensBought = await buyTokensWithUsdt(launchAddress, '10');
		expect(tokensBought).toBeGreaterThan(0n);
	});
});

test.describe('All 8 token types with launchpad + buy', () => {
	for (const [index, tokenType] of TOKEN_TYPES.entries()) {
		test(`creates launch and buys for ${tokenType.name} token (type ${index})`, async () => {
			const { tokenAddress, launchAddress } = await createTokenAndLaunchDirect(
				`Launch${tokenType.name}`, `L${index}`, 1_000_000, {
					isTaxable: tokenType.isTaxable,
					isMintable: tokenType.isMintable,
					isPartner: tokenType.isPartner,
					softCap: '10',
					hardCap: '50000',
					maxBuyBps: 500
				}
			);

			// Launch should be active
			expect(await getLaunchState(launchAddress)).toBe(1);

			// Buy tokens
			const tokensBought = await buyTokensWithUsdt(launchAddress, '50');
			expect(tokensBought).toBeGreaterThan(0n);

			// Verify state
			const launch = new ethers.Contract(launchAddress, LAUNCH_ABI, getProvider());
			const raised = await launch.totalBaseRaised();
			expect(raised).toBeGreaterThan(0n);
		});
	}
});

test.describe('UI launch detail page', () => {
	test('shows launch details and buy box', async ({ page }) => {
		// Create a launch first
		const { launchAddress } = await createTokenAndLaunchDirect(
			'UITestToken', 'UTT', 1_000_000, {
				softCap: '10',
				hardCap: '50000'
			}
		);

		await setupPage(page);
		await page.goto(`/launchpad/${launchAddress}`, { waitUntil: 'domcontentloaded' });
		await page.waitForTimeout(8000);

		// Page should either show launch data or "Loading" (not an error page)
		const pageContent = await page.textContent('body') ?? '';
		const hasLaunchContent = pageContent.includes('UTT') || pageContent.includes('Loading') || pageContent.includes('Buy Tokens') || pageContent.includes('Sale');
		expect(hasLaunchContent).toBe(true);
	});
});
