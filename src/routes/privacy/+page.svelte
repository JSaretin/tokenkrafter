<svelte:head>
	<title>Privacy Policy | TokenKrafter</title>
	<meta name="description" content="TokenKrafter Privacy Policy — how we collect, use, and protect your data." />
</svelte:head>

<div class="max-w-3xl mx-auto px-4 py-16">
	<h1 class="syne text-3xl md:text-4xl font-bold mb-2" style="color: var(--text-heading);">Privacy Policy</h1>
	<p class="text-sm mb-10" style="color: var(--text-muted);">Last updated: April 2026</p>

	<div class="space-y-10 text-sm leading-relaxed" style="color: var(--text);">

		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">1. Information We Collect</h2>
			<p class="mb-3">We believe in transparency. Here is exactly what we collect and why:</p>
			<ul class="list-disc pl-5 space-y-2" style="color: var(--text-muted);">
				<li><strong style="color: var(--text);">Wallet addresses</strong> — your public blockchain address when you connect an external wallet (MetaMask, Trust Wallet, etc.) or create an embedded wallet. Wallet addresses are publicly visible on the blockchain by design.</li>
				<li><strong style="color: var(--text);">Google account info (embedded wallet users)</strong> — if you sign in with Google to use our Quick Wallet, we receive your Google email address and user ID via Supabase Auth. We use this solely to authenticate you and link your encrypted wallet vault. We do not access your Google contacts, files, or any other Google data.</li>
				<li><strong style="color: var(--text);">Encrypted wallet vault (embedded wallet users)</strong> — your wallet's seed phrase is encrypted on your device using your PIN before it reaches our servers. We store the encrypted blob and a server-derived salt. We cannot read, decrypt, or recover your seed phrase. See Section 4 for full details.</li>
				<li><strong style="color: var(--text);">Transaction data</strong> — on-chain transaction hashes, token creation details, launchpad participation records, and trade history. This data is already publicly available on the blockchain; we index it for display purposes.</li>
				<li><strong style="color: var(--text);">Payment details (off-ramp users)</strong> — if you use our Sell to Bank feature, we collect your bank account number, bank name, and account holder name. This data is encrypted client-side with AES-256-GCM before being sent to our server. For PayPal or Wise withdrawals, we collect the email address you provide.</li>
				<li><strong style="color: var(--text);">Token metadata</strong> — if you create a token, you may optionally provide a logo, description, website URL, and social links (Twitter, Telegram, Discord). This information is publicly displayed on your token's detail page.</li>
				<li><strong style="color: var(--text);">Referral data</strong> — if you create or use a referral alias, we store the alias linked to your wallet address. Referral earnings are tracked on-chain in the smart contracts.</li>
				<li><strong style="color: var(--text);">Comments</strong> — if you post comments on a token launch, we store the comment text linked to your wallet address.</li>
				<li><strong style="color: var(--text);">Usage data</strong> — pages visited, features used, and visitor counts (browsing, creating, investing). We do not use third-party analytics trackers. Visitor tracking is aggregate and anonymous.</li>
			</ul>
		</section>

		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">2. How We Use Your Information</h2>
			<ul class="list-disc pl-5 space-y-2" style="color: var(--text-muted);">
				<li>To process token creation, launchpad operations, and trades on the platform.</li>
				<li>To authenticate you via wallet signature (external wallets) or Google OAuth (embedded wallet).</li>
				<li>To store and retrieve your encrypted wallet vault so you can access your embedded wallet across sessions and devices.</li>
				<li>To process fiat withdrawals via our payment partners (Flutterwave for bank transfers).</li>
				<li>To resolve your bank account holder name when you enter bank details (via Flutterwave's account verification API).</li>
				<li>To calculate and display exchange rates for fiat off-ramp transactions.</li>
				<li>To display platform statistics, activity feeds, and recent transaction tickers. Wallet addresses are shown in truncated form in activity feeds.</li>
				<li>To track referral relationships and distribute referral earnings via smart contracts.</li>
				<li>To detect and prevent fraudulent activity.</li>
			</ul>
		</section>

		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">3. What We Do NOT Collect or Have Access To</h2>
			<p class="mb-3">For full transparency:</p>
			<ul class="list-disc pl-5 space-y-2" style="color: var(--text-muted);">
				<li><strong style="color: var(--text);">Private keys</strong> — we never have access to your private keys, whether you use an external wallet or our embedded wallet.</li>
				<li><strong style="color: var(--text);">Seed phrases</strong> — embedded wallet seed phrases are encrypted on your device before being sent to our server. We store only the encrypted blob. Without your PIN, the seed phrase cannot be decrypted.</li>
				<li><strong style="color: var(--text);">PINs</strong> — your embedded wallet PIN never leaves your browser. It is used locally to encrypt/decrypt your seed phrase.</li>
				<li><strong style="color: var(--text);">Recovery codes</strong> — your 3 recovery codes are generated on your device and are not stored on our server in readable form. They are used as alternative decryption keys for your vault.</li>
				<li><strong style="color: var(--text);">Passwords</strong> — we do not use password-based authentication. External wallet users sign a cryptographic message; embedded wallet users authenticate via Google OAuth.</li>
				<li><strong style="color: var(--text);">KYC documents</strong> — we do not collect identity documents, selfies, or government IDs.</li>
			</ul>
		</section>

		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">4. Embedded Wallet: How Your Keys Are Protected</h2>
			<p class="mb-3">Our embedded wallet (Quick Wallet) uses a semi-custodial model. We want you to fully understand how it works:</p>
			<ul class="list-disc pl-5 space-y-2" style="color: var(--text-muted);">
				<li><strong style="color: var(--text);">Seed generation</strong> — your wallet's seed phrase (mnemonic) is generated entirely on your device using standard BIP-39. It is never transmitted to our servers in plaintext.</li>
				<li><strong style="color: var(--text);">Encryption</strong> — your seed phrase is encrypted in your browser using PBKDF2 (600,000 iterations) with your PIN + a server-provided salt, then sealed with AES-256-GCM. The result is an encrypted blob that is meaningless without your PIN.</li>
				<li><strong style="color: var(--text);">Server storage</strong> — we store the encrypted blob and a deterministic salt derived from your user ID. We also store up to 3 additional encrypted blobs corresponding to your recovery codes (each recovery code independently encrypts the same seed).</li>
				<li><strong style="color: var(--text);">PIN caching</strong> — for convenience, your PIN is cached in your browser's local storage for 24 hours after you enter it. This allows automatic unlock without re-entering your PIN. You can clear this by logging out.</li>
				<li><strong style="color: var(--text);">What this means</strong> — your wallet requires both our server (for the encrypted vault and salt) AND your PIN (or a recovery code) to unlock. If our platform were to become permanently unavailable and you had not exported your seed phrase or private keys, you would lose access to your wallet. <strong>We strongly recommend exporting your seed phrase as a backup.</strong> You can do this at any time from the Account Panel.</li>
				<li><strong style="color: var(--text);">Vault deletion</strong> — you can permanently delete your encrypted vault from our servers at any time. This action is irreversible. Ensure you have exported your seed phrase before deleting.</li>
			</ul>
		</section>

		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">5. Data Storage & Security</h2>
			<p class="mb-3">Your data is stored securely:</p>
			<ul class="list-disc pl-5 space-y-2" style="color: var(--text-muted);">
				<li><strong style="color: var(--text);">Database</strong> — hosted on Supabase with row-level security policies, encrypted connections, and service-role access control for write operations.</li>
				<li><strong style="color: var(--text);">Payment details</strong> — encrypted with AES-256-GCM on your device before storage. Even in the event of a database breach, payment details cannot be read without the encryption key.</li>
				<li><strong style="color: var(--text);">Wallet vaults</strong> — encrypted with AES-256-GCM using your PIN and a server salt. Even with full database access, the vault cannot be decrypted without the user's PIN.</li>
				<li><strong style="color: var(--text);">Authentication</strong> — external wallets are verified via cryptographic signatures with HMAC session tokens (7-day expiry). Embedded wallets authenticate via Supabase Auth (Google OAuth) with JWT verification on each request.</li>
				<li><strong style="color: var(--text);">Smart contracts</strong> — on-chain funds are held in smart contracts on the blockchain, not in our database. Off-ramp USDT is held in the TradeRouter escrow contract during withdrawal processing.</li>
			</ul>
		</section>

		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">6. Third-Party Services</h2>
			<p class="mb-3">We share limited data with the following service providers:</p>
			<ul class="list-disc pl-5 space-y-2" style="color: var(--text-muted);">
				<li><strong style="color: var(--text);">Flutterwave</strong> — processes bank transfers for our fiat off-ramp. Receives your bank account details (account number, bank code, account name) only when you initiate a withdrawal. Also used for bank account name verification when you enter payment details. Subject to <a href="https://flutterwave.com/privacy-policy" target="_blank" class="text-cyan-400 hover:underline">Flutterwave's Privacy Policy</a>.</li>
				<li><strong style="color: var(--text);">Google (via Supabase Auth)</strong> — if you use the embedded wallet, Google provides your email and user ID for authentication. We do not request access to any other Google data. Subject to <a href="https://policies.google.com/privacy" target="_blank" class="text-cyan-400 hover:underline">Google's Privacy Policy</a>.</li>
				<li><strong style="color: var(--text);">Supabase</strong> — provides our database hosting, authentication, and file storage (for token logos). Subject to <a href="https://supabase.com/privacy" target="_blank" class="text-cyan-400 hover:underline">Supabase's Privacy Policy</a>.</li>
				<li><strong style="color: var(--text);">Blockchain networks</strong> — all token creation, launches, and trades are recorded on public blockchains (BNB Smart Chain, Ethereum, and other supported networks). This data is publicly accessible and permanent by design.</li>
				<li><strong style="color: var(--text);">WalletConnect / Reown</strong> — facilitates external wallet connections. Subject to their own privacy policies.</li>
				<li><strong style="color: var(--text);">Exchange rate providers</strong> — we fetch fiat exchange rates (NGN, GBP, EUR, etc.) from third-party rate APIs to calculate off-ramp payouts. No user data is shared with these providers.</li>
			</ul>
			<p class="mt-3">We do not sell, rent, or trade your personal information to any third parties.</p>
		</section>

		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">7. Cookies & Local Storage</h2>
			<p class="mb-3">TokenKrafter uses minimal browser storage:</p>
			<ul class="list-disc pl-5 space-y-2" style="color: var(--text-muted);">
				<li><strong style="color: var(--text);">Essential cookies</strong> — required for the platform to function (wallet connection state, theme preference, language selection). These cannot be disabled.</li>
				<li><strong style="color: var(--text);">Local storage</strong> — we store your preferences (theme, language, slippage tolerance, imported tokens, favorites), session tokens (HMAC-signed, 7-day expiry), and cached PIN (encrypted, 24-hour expiry for embedded wallet users). This data stays on your device.</li>
			</ul>
			<p class="mt-3">We do not use tracking cookies, advertising cookies, or third-party analytics cookies.</p>
		</section>

		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">8. Data Retention</h2>
			<ul class="list-disc pl-5 space-y-2" style="color: var(--text-muted);">
				<li>Transaction records are kept indefinitely as they correspond to permanent blockchain records.</li>
				<li>Token metadata (name, logo, description, social links) is kept indefinitely as long as the token exists on-chain.</li>
				<li>Payment details for completed withdrawals are retained for 90 days, then deleted.</li>
				<li>Incomplete withdrawal requests (awaiting_trade) are automatically deleted after 30 minutes.</li>
				<li>Embedded wallet vaults are retained until you explicitly delete them or request deletion.</li>
				<li>Referral aliases are retained as long as the associated wallet is active.</li>
				<li>Comments on launches are retained indefinitely unless you request deletion.</li>
			</ul>
		</section>

		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">9. Your Rights</h2>
			<p class="mb-3">You have the right to:</p>
			<ul class="list-disc pl-5 space-y-2" style="color: var(--text-muted);">
				<li><strong style="color: var(--text);">Access</strong> — request a copy of the data we hold about your wallet address or Google account.</li>
				<li><strong style="color: var(--text);">Deletion</strong> — request deletion of your off-chain data (payment details, comments, metadata, wallet vault, referral alias). Note: on-chain data (transactions, token contracts, launch records) cannot be deleted as it is part of the public blockchain.</li>
				<li><strong style="color: var(--text);">Correction</strong> — update your payment details, token metadata, or referral alias at any time.</li>
				<li><strong style="color: var(--text);">Export</strong> — export your embedded wallet's seed phrase and private keys at any time from the Account Panel. Your data portability is guaranteed — you can use your exported keys with any Ethereum-compatible wallet.</li>
				<li><strong style="color: var(--text);">Vault deletion</strong> — permanently delete your encrypted wallet vault from our servers via the Account Panel or by contacting us.</li>
			</ul>
			<p class="mt-3">To exercise these rights, contact us at <a href="mailto:support@tokenkrafter.com" class="text-cyan-400 hover:underline">support@tokenkrafter.com</a>.</p>
		</section>

		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">10. Children</h2>
			<p>TokenKrafter is not intended for use by individuals under the age of 18. We do not knowingly collect data from minors.</p>
		</section>

		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">11. Changes to This Policy</h2>
			<p>We may update this Privacy Policy from time to time. Changes will be posted on this page with an updated date. Continued use of the platform after changes constitutes acceptance of the updated policy.</p>
		</section>

		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">12. Contact</h2>
			<p>For privacy-related questions or data requests, contact us at <a href="mailto:support@tokenkrafter.com" class="text-cyan-400 hover:underline">support@tokenkrafter.com</a>.</p>
		</section>

	</div>
</div>

<style>
	.syne { font-family: 'Syne', sans-serif; }
</style>
