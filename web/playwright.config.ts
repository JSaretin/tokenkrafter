import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: './tests/e2e',
	timeout: 120_000,
	retries: 0,
	workers: 1, // sequential — shared Hardhat node state
	use: {
		baseURL: 'http://localhost:5173',
		headless: true,
		screenshot: 'only-on-failure',
		trace: 'retain-on-failure'
	},
	projects: [
		{
			name: 'chromium',
			use: { browserName: 'chromium' }
		}
	],
	webServer: {
		command: 'npm run dev',
		port: 5173,
		reuseExistingServer: true,
		timeout: 30_000
	}
});
