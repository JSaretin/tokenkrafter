/**
 * Playwright page object helpers for navigating the UI.
 */
import type { Page } from '@playwright/test';
import { getMockProviderScript } from '../fixtures/mock-provider';

/**
 * Set up a page with the mock wallet provider injected.
 */
export async function setupPage(page: Page) {
	await page.addInitScript({ content: getMockProviderScript() });
}

/**
 * Wait for wallet to be connected (provider ready).
 */
export async function waitForWalletConnected(page: Page) {
	// Wait for the app to detect the injected provider
	await page.waitForTimeout(2000);
}

/**
 * Navigate and wait for page load.
 */
export async function navigateTo(page: Page, path: string) {
	await page.goto(path, { waitUntil: 'networkidle' });
	await waitForWalletConnected(page);
}

/**
 * Get text content from a selector, trimmed.
 */
export async function getText(page: Page, selector: string): Promise<string> {
	const el = page.locator(selector).first();
	return (await el.textContent() ?? '').trim();
}

/**
 * Wait for a feedback toast message.
 */
export async function waitForFeedback(page: Page, textContains: string, timeout = 30000) {
	await page.waitForFunction(
		(text) => {
			const toasts = document.querySelectorAll('.feedback-item, [class*="feedback"]');
			return Array.from(toasts).some(t => t.textContent?.includes(text));
		},
		textContains,
		{ timeout }
	);
}

/**
 * Check if an element with specific text exists on the page.
 */
export async function hasText(page: Page, text: string): Promise<boolean> {
	const count = await page.locator(`text="${text}"`).count();
	return count > 0;
}
