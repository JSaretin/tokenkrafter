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
			<p class="mb-3">We collect the following types of information when you use TokenKrafter:</p>
			<ul class="list-disc pl-5 space-y-2" style="color: var(--text-muted);">
				<li><strong style="color: var(--text);">Wallet addresses</strong> — your public blockchain address when you connect your wallet. We do not have access to your private keys.</li>
				<li><strong style="color: var(--text);">Transaction data</strong> — on-chain transaction hashes, token creation details, and launchpad participation records. This data is already publicly available on the blockchain.</li>
				<li><strong style="color: var(--text);">Payment details</strong> — if you use our fiat off-ramp (Sell to Bank), we collect your bank account number, bank name, and account holder name. This data is encrypted at rest using AES-256-GCM encryption.</li>
				<li><strong style="color: var(--text);">Usage data</strong> — pages visited, features used, and general platform interaction patterns. We do not use third-party analytics trackers.</li>
			</ul>
		</section>

		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">2. How We Use Your Information</h2>
			<ul class="list-disc pl-5 space-y-2" style="color: var(--text-muted);">
				<li>To process token creation, launchpad operations, and trades on the platform.</li>
				<li>To process fiat withdrawals via our payment partners (Flutterwave).</li>
				<li>To display platform statistics and activity feeds (wallet addresses are truncated).</li>
				<li>To detect and prevent fraudulent activity.</li>
				<li>To improve the platform and user experience.</li>
			</ul>
		</section>

		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">3. Data Storage & Security</h2>
			<p class="mb-3">Your data is stored securely:</p>
			<ul class="list-disc pl-5 space-y-2" style="color: var(--text-muted);">
				<li><strong style="color: var(--text);">Database</strong> — hosted on Supabase with row-level security policies and encrypted connections.</li>
				<li><strong style="color: var(--text);">Payment details</strong> — encrypted with AES-256-GCM before storage. Even in the event of a database breach, payment details cannot be read without the encryption key.</li>
				<li><strong style="color: var(--text);">Authentication</strong> — we use cryptographic wallet signatures to verify your identity. We never store passwords because we don't use password-based authentication.</li>
				<li><strong style="color: var(--text);">Smart contracts</strong> — funds are held in audited smart contracts on the blockchain, not in our database.</li>
			</ul>
		</section>

		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">4. Third-Party Services</h2>
			<p class="mb-3">We share limited data with the following service providers:</p>
			<ul class="list-disc pl-5 space-y-2" style="color: var(--text-muted);">
				<li><strong style="color: var(--text);">Flutterwave</strong> — processes bank transfers for our fiat off-ramp. Receives your bank account details only when you initiate a withdrawal. Subject to <a href="https://flutterwave.com/privacy-policy" target="_blank" class="text-cyan-400 hover:underline">Flutterwave's Privacy Policy</a>.</li>
				<li><strong style="color: var(--text);">Blockchain networks</strong> — all token creation, launches, and trades are recorded on public blockchains (BSC, Ethereum). This data is publicly accessible by design.</li>
				<li><strong style="color: var(--text);">WalletConnect / Reown</strong> — facilitates wallet connections. Subject to their own privacy policies.</li>
			</ul>
			<p class="mt-3">We do not sell, rent, or trade your personal information to any third parties.</p>
		</section>

		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">5. Cookies</h2>
			<p class="mb-3">TokenKrafter uses minimal cookies:</p>
			<ul class="list-disc pl-5 space-y-2" style="color: var(--text-muted);">
				<li><strong style="color: var(--text);">Essential cookies</strong> — required for the platform to function (wallet connection state, theme preference, language selection). These cannot be disabled.</li>
				<li><strong style="color: var(--text);">Local storage</strong> — we store your preferences (theme, language, favorites) in your browser's local storage. This data never leaves your device.</li>
			</ul>
			<p class="mt-3">We do not use tracking cookies, advertising cookies, or third-party analytics cookies.</p>
		</section>

		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">6. Data Retention</h2>
			<ul class="list-disc pl-5 space-y-2" style="color: var(--text-muted);">
				<li>Transaction records are kept indefinitely as they correspond to permanent blockchain records.</li>
				<li>Payment details for completed withdrawals are retained for 90 days, then deleted.</li>
				<li>Incomplete withdrawal requests (awaiting_trade) are automatically deleted after 30 minutes.</li>
				<li>Account data is retained as long as your wallet has interacted with the platform.</li>
			</ul>
		</section>

		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">7. Your Rights</h2>
			<p class="mb-3">You have the right to:</p>
			<ul class="list-disc pl-5 space-y-2" style="color: var(--text-muted);">
				<li><strong style="color: var(--text);">Access</strong> — request a copy of the data we hold about your wallet address.</li>
				<li><strong style="color: var(--text);">Deletion</strong> — request deletion of your off-chain data (payment details, comments, metadata). Note: on-chain data cannot be deleted as it is part of the public blockchain.</li>
				<li><strong style="color: var(--text);">Correction</strong> — update your payment details or launch metadata at any time.</li>
			</ul>
			<p class="mt-3">To exercise these rights, contact us at <a href="mailto:support@tokenkrafter.com" class="text-cyan-400 hover:underline">support@tokenkrafter.com</a>.</p>
		</section>

		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">8. Children</h2>
			<p>TokenKrafter is not intended for use by individuals under the age of 18. We do not knowingly collect data from minors.</p>
		</section>

		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">9. Changes to This Policy</h2>
			<p>We may update this Privacy Policy from time to time. Changes will be posted on this page with an updated date. Continued use of the platform after changes constitutes acceptance of the updated policy.</p>
		</section>

		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">10. Contact</h2>
			<p>For privacy-related questions or data requests, contact us at <a href="mailto:support@tokenkrafter.com" class="text-cyan-400 hover:underline">support@tokenkrafter.com</a>.</p>
		</section>

	</div>
</div>

<style>
	.syne { font-family: 'Syne', sans-serif; }
</style>
