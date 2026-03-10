<script lang="ts">
	import type { SupportedNetwork } from '$lib/structure';

	export type ListingConfig = {
		enabled: boolean;
		baseCoin: 'native' | 'usdt' | 'usdc';
		mode: 'manual' | 'price';
		tokenAmount: string;
		baseAmount: string;
		pricePerToken: string;
		listBaseAmount: string;
	};

	export type TokenFormData = {
		name: string;
		symbol: string;
		totalSupply: string;
		decimals: number;
		isMintable: boolean;
		isTaxable: boolean;
		isPartner: boolean;
		network: SupportedNetwork;
		listing: ListingConfig;
	};

	let name = $state('');
	let symbol = $state('');
	let totalSupply = $state('');
	let decimals = $state(18);
	let chainId: number | undefined = $state();
	let isMintable = $state(false);
	let isTaxable = $state(false);
	let isPartner = $state(false);

	// Listing settings
	let listingEnabled = $state(false);
	let listingBaseCoin = $state<'native' | 'usdt' | 'usdc'>('native');
	let listingMode = $state<'manual' | 'price'>('manual');
	let listingTokenAmount = $state('');
	let listingBaseAmount = $state('');
	let listingPricePerToken = $state('');
	let listingListBaseAmount = $state('');

	let {
		supportedNetworks,
		addFeedback,
		updateTokenInfo
	}: {
		supportedNetworks: SupportedNetwork[];
		addFeedback: (feedback: { message: string; type: string }) => void;
		updateTokenInfo: (tokenInfo: TokenFormData) => void;
	} = $props();

	let selectedNetwork = $derived(supportedNetworks.find((n) => n.chain_id == chainId));
	let nativeCoinSymbol = $derived(selectedNetwork?.native_coin ?? 'ETH');
	let baseCoinSymbol = $derived(
		listingBaseCoin === 'native' ? nativeCoinSymbol :
		listingBaseCoin === 'usdt' ? 'USDT' : 'USDC'
	);

	let calculatedTokenAmount = $derived(() => {
		if (!listingPricePerToken || !listingListBaseAmount || Number(listingPricePerToken) <= 0) return '';
		return (Number(listingListBaseAmount) / Number(listingPricePerToken)).toFixed(6);
	});

	// Validate listing amounts against total supply
	let listingTokenPct = $derived(() => {
		if (!totalSupply) return 0;
		const amount = listingMode === 'price' ? Number(calculatedTokenAmount()) : Number(listingTokenAmount);
		if (!amount || amount <= 0) return 0;
		return (amount / Number(totalSupply)) * 100;
	});

	function onsubmit(e: Event) {
		e.preventDefault();
		const network = supportedNetworks.find((n) => n.chain_id == chainId);
		if (!network) {
			addFeedback({ message: 'Please select a network', type: 'error' });
			return;
		}

		if (listingEnabled) {
			const tokenAmt = listingMode === 'price' ? calculatedTokenAmount() : listingTokenAmount;
			const baseAmt = listingMode === 'price' ? listingListBaseAmount : listingBaseAmount;
			if (!tokenAmt || !baseAmt || Number(tokenAmt) <= 0 || Number(baseAmt) <= 0) {
				addFeedback({ message: 'Please fill in all listing amounts.', type: 'error' });
				return;
			}
			if (Number(tokenAmt) > Number(totalSupply)) {
				addFeedback({ message: 'Listing token amount exceeds total supply.', type: 'error' });
				return;
			}
		}

		updateTokenInfo({
			name, symbol, totalSupply, decimals, isMintable, isTaxable, isPartner, network,
			listing: {
				enabled: listingEnabled,
				baseCoin: listingBaseCoin,
				mode: listingMode,
				tokenAmount: listingTokenAmount,
				baseAmount: listingBaseAmount,
				pricePerToken: listingPricePerToken,
				listBaseAmount: listingListBaseAmount
			}
		});
	}
</script>

<form {onsubmit} class="token-form" autocomplete="off">
	<div class="form-header">
		<h2 class="syne text-2xl font-bold text-white">Configure Token</h2>
		<p class="text-sm text-gray-400 font-mono mt-1">Fill in the details for your new token.</p>
	</div>

	<div class="form-body">
		<!-- Name + Symbol Row -->
		<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
			<div class="field-group">
				<label class="label-text" for="token-name">Token Name</label>
				<input
					id="token-name"
					required
					class="input-field"
					bind:value={name}
					placeholder="My Awesome Token"
				/>
			</div>
			<div class="field-group">
				<label class="label-text" for="token-symbol">Symbol</label>
				<input
					id="token-symbol"
					required
					class="input-field"
					bind:value={symbol}
					placeholder="MAT"
					maxlength="8"
				/>
				<span class="field-hint">{symbol.length}/8 chars</span>
			</div>
		</div>

		<!-- Supply + Decimals Row -->
		<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
			<div class="field-group">
				<label class="label-text" for="token-supply">Total Supply</label>
				<input
					id="token-supply"
					required
					class="input-field"
					bind:value={totalSupply}
					placeholder="1,000,000"
					type="number"
					min="1"
				/>
			</div>
			<div class="field-group">
				<label class="label-text" for="token-decimals">Decimals</label>
				<input
					id="token-decimals"
					required
					class="input-field"
					bind:value={decimals}
					type="number"
					min="0"
					max="18"
				/>
				<span class="field-hint">Standard: 18</span>
			</div>
		</div>

		<!-- Network -->
		<div class="field-group">
			<label class="label-text" for="token-network">Network</label>
			<select id="token-network" required class="input-field" bind:value={chainId}>
				<option value="">Select a network</option>
				{#each supportedNetworks.filter((n) => n.platform_address.length > 2) as n (n.chain_id)}
					<option value={n.chain_id}>{n.name} ({n.native_coin})</option>
				{/each}
			</select>
		</div>

		<!-- Feature Toggles -->
		<div class="toggles-section">
			<div class="label-text mb-3">Token Features</div>
			<div class="flex flex-col gap-3">
				<div>
					<label class="toggle-card {isMintable ? 'active' : ''}">
						<div class="toggle-info">
							<div class="toggle-icon">+</div>
							<div>
								<div class="text-sm font-semibold text-white syne">Mintable</div>
								<div class="text-xs text-gray-500 font-mono mt-0.5">Create new tokens after deploy</div>
							</div>
						</div>
						<div class="toggle-switch {isMintable ? 'on' : ''}">
							<div class="toggle-thumb"></div>
						</div>
						<input type="checkbox" bind:checked={isMintable} class="sr-only" />
					</label>
					{#if isMintable}
						<div class="feature-notice cyan">
							<span class="feature-notice-title">Mint & Burn</span>
							<span class="feature-notice-text">As the owner, you can mint new tokens to any wallet and increase total supply at any time. Token holders can also burn their own tokens to reduce supply.</span>
						</div>
					{/if}
				</div>

				<div>
					<label class="toggle-card {isTaxable ? 'active' : ''}">
						<div class="toggle-info">
							<div class="toggle-icon">%</div>
							<div>
								<div class="text-sm font-semibold text-white syne">Taxable</div>
								<div class="text-xs text-gray-500 font-mono mt-0.5">Apply fee on transfers</div>
							</div>
						</div>
						<div class="toggle-switch {isTaxable ? 'on' : ''}">
							<div class="toggle-thumb"></div>
						</div>
						<input type="checkbox" bind:checked={isTaxable} class="sr-only" />
					</label>
					{#if isTaxable}
						<div class="feature-notice amber">
							<span class="feature-notice-title">Custom Tax System</span>
							<span class="feature-notice-text">Set separate tax rates for buys, sells, and transfers (up to 25% combined). Distribute tax revenue to up to 10 wallets with custom share splits. Exempt specific addresses from taxes.</span>
						</div>
					{/if}
				</div>

				<div>
					<div class="partner-recommend-badge">Recommended</div>
					<label class="toggle-card partner-card {isPartner ? 'active' : ''}">
						<div class="toggle-info">
							<div class="toggle-icon partner-icon">P</div>
							<div>
								<div class="text-sm font-semibold text-white syne">Partnership</div>
								<div class="text-xs text-gray-500 font-mono mt-0.5">Get promoted across our platform</div>
							</div>
						</div>
						<div class="toggle-switch partner-switch {isPartner ? 'on' : ''}">
							<div class="toggle-thumb"></div>
						</div>
						<input type="checkbox" bind:checked={isPartner} class="sr-only" />
					</label>

					{#if isPartner}
						<div class="partner-perks">
							<div class="partner-perks-header">
								<span class="syne font-bold text-sm text-purple-300">Partner Perks</span>
							</div>
							<ul class="partner-perks-list">
								<li>Featured listing on TokenKrafter homepage & Explore page</li>
								<li>Promoted across all our social channels & community</li>
								<li>Auto-created DEX liquidity pools (PancakeSwap/Uniswap)</li>
								<li>Priority support & marketing guidance from our team</li>
							</ul>
							<div class="partner-terms">
								<span class="text-gray-500 text-[11px] font-mono">In exchange, a 1% fee is applied on buy & sell trades to sustain platform growth and your ongoing promotion.</span>
							</div>
						</div>
					{/if}
				</div>
			</div>
		</div>

		{#if isMintable || isTaxable || isPartner}
			<div class="fee-notice">
				<span class="text-amber-400 text-sm font-mono">Fee applies:</span>
				<span class="text-gray-400 text-xs font-mono ml-2">
					{[isMintable && 'Mintable', isTaxable && 'Taxable', isPartner && 'Partner'].filter(Boolean).join(' + ')}
					fee will be shown in the review step.
				</span>
			</div>
		{/if}

		<div class="protection-info">
			<span class="protection-info-title syne">Free Protection Features</span>
			<span class="protection-info-text">
				After deployment, configure anti-whale limits, max wallet, max transaction, cooldown, and blacklist settings from the Protection tab — all free. Set them up before enabling trading.
			</span>
		</div>

		<!-- Listing Settings (disabled for now) -->
		{#if false}
		<div class="listing-section">
			<label class="toggle-card {listingEnabled ? 'active listing-active' : ''}">
				<div class="toggle-info">
					<div class="toggle-icon listing-icon">$</div>
					<div>
						<div class="text-sm font-semibold text-white syne">Add Initial Liquidity</div>
						<div class="text-xs text-gray-500 font-mono mt-0.5">List your token on a DEX right after creation</div>
					</div>
				</div>
				<div class="toggle-switch {listingEnabled ? 'on listing-switch-on' : ''}">
					<div class="toggle-thumb"></div>
				</div>
				<input type="checkbox" bind:checked={listingEnabled} class="sr-only" />
			</label>

			{#if listingEnabled}
				<div class="listing-settings">
					<h4 class="syne text-sm font-bold text-white mb-3">Listing Settings</h4>

					<!-- Pair Type -->
					<div class="field-group">
						<label class="label-text">Pair With</label>
						<div class="pair-options">
							<button type="button" class="pair-option {listingBaseCoin === 'native' ? 'active' : ''}" onclick={() => (listingBaseCoin = 'native')}>
								{nativeCoinSymbol}
							</button>
							<button type="button" class="pair-option {listingBaseCoin === 'usdt' ? 'active' : ''}" onclick={() => (listingBaseCoin = 'usdt')}>
								USDT
							</button>
							<button type="button" class="pair-option {listingBaseCoin === 'usdc' ? 'active' : ''}" onclick={() => (listingBaseCoin = 'usdc')}>
								USDC
							</button>
						</div>
					</div>

					<!-- Mode Toggle -->
					<div class="field-group">
						<label class="label-text">Listing Mode</label>
						<div class="mode-toggle">
							<button type="button" class="mode-btn {listingMode === 'manual' ? 'active' : ''}" onclick={() => (listingMode = 'manual')}>Manual Amounts</button>
							<button type="button" class="mode-btn {listingMode === 'price' ? 'active' : ''}" onclick={() => (listingMode = 'price')}>Price-Based</button>
						</div>
					</div>

					{#if listingMode === 'manual'}
						<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
							<div class="field-group">
								<label class="label-text" for="list-token-amt">Token Amount</label>
								<div class="input-with-badge">
									<input
										id="list-token-amt"
										class="input-field"
										type="number"
										min="0"
										bind:value={listingTokenAmount}
										placeholder="100000"
									/>
									<span class="input-badge">{symbol || 'TOKEN'}</span>
								</div>
							</div>
							<div class="field-group">
								<label class="label-text" for="list-base-amt">{baseCoinSymbol} Amount</label>
								<div class="input-with-badge">
									<input
										id="list-base-amt"
										class="input-field"
										type="number"
										min="0"
										step="any"
										bind:value={listingBaseAmount}
										placeholder="0.5"
									/>
									<span class="input-badge">{baseCoinSymbol}</span>
								</div>
							</div>
						</div>
					{:else}
						<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
							<div class="field-group">
								<label class="label-text" for="list-price">Price per Token</label>
								<div class="input-with-badge">
									<input
										id="list-price"
										class="input-field"
										type="number"
										min="0"
										step="any"
										bind:value={listingPricePerToken}
										placeholder="0.001"
									/>
									<span class="input-badge">{baseCoinSymbol}</span>
								</div>
								<span class="field-hint">How much 1 {symbol || 'token'} costs in {baseCoinSymbol}</span>
							</div>
							<div class="field-group">
								<label class="label-text" for="list-base-total">{baseCoinSymbol} to List</label>
								<div class="input-with-badge">
									<input
										id="list-base-total"
										class="input-field"
										type="number"
										min="0"
										step="any"
										bind:value={listingListBaseAmount}
										placeholder="1.0"
									/>
									<span class="input-badge">{baseCoinSymbol}</span>
								</div>
							</div>
						</div>

						{#if calculatedTokenAmount()}
							<div class="calc-result">
								<span class="text-gray-500 text-xs font-mono">Tokens to list:</span>
								<span class="text-white text-sm font-mono font-bold">
									{Number(calculatedTokenAmount()).toLocaleString()} {symbol || 'tokens'}
								</span>
							</div>
						{/if}
					{/if}

					{#if listingTokenPct() > 0}
						<div class="listing-pct-bar">
							<div class="flex justify-between text-xs font-mono mb-1">
								<span class="text-gray-500">Supply allocated to liquidity</span>
								<span class="text-cyan-400">{listingTokenPct().toFixed(1)}%</span>
							</div>
							<div class="pct-track">
								<div class="pct-fill" style="width: {Math.min(listingTokenPct(), 100)}%"></div>
							</div>
						</div>
					{/if}

					<div class="listing-info-box">
						<span class="text-gray-500 text-[11px] font-mono">Liquidity will be added automatically after your token is deployed. You'll need {baseCoinSymbol} in your wallet for the pair. LP tokens go to your wallet.</span>
					</div>
				</div>
			{/if}
		</div>
		{/if}

		<button type="submit" class="submit-btn w-full syne">
			{listingEnabled ? 'Review Transaction & Listing ->' : 'Review Transaction ->'}
		</button>
	</div>
</form>

<style>
	.token-form {
		max-width: 580px;
		width: 100%;
		margin: 0 auto;
	}

	.form-header {
		margin-bottom: 24px;
	}

	.form-body {
		display: flex;
		flex-direction: column;
		gap: 20px;
		background: rgba(255,255,255,0.02);
		border: 1px solid rgba(255,255,255,0.07);
		border-radius: 20px;
		padding: 28px;
	}

	.field-group { position: relative; }

	.field-hint {
		font-size: 11px;
		color: #4b5563;
		font-family: 'Space Mono', monospace;
		margin-top: 4px;
		display: block;
	}

	.toggles-section {
		padding: 16px;
		background: rgba(255,255,255,0.02);
		border-radius: 12px;
		border: 1px solid rgba(255,255,255,0.05);
	}

	.toggle-card {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 14px;
		border-radius: 10px;
		border: 1px solid rgba(255,255,255,0.07);
		cursor: pointer;
		transition: all 0.2s;
		background: rgba(255,255,255,0.02);
	}
	.toggle-card:hover { border-color: rgba(0,210,255,0.25); background: rgba(0,210,255,0.03); }
	.toggle-card.active {
		border-color: rgba(0,210,255,0.3);
		background: rgba(0,210,255,0.05);
	}

	/* Partner card - visually distinct recommended style */
	.partner-recommend-badge {
		display: inline-block;
		font-family: 'Syne', sans-serif;
		font-size: 10px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: #c084fc;
		background: linear-gradient(135deg, rgba(139,92,246,0.15), rgba(168,85,247,0.1));
		border: 1px solid rgba(139,92,246,0.3);
		padding: 3px 10px;
		border-radius: 999px;
		margin-bottom: 6px;
	}
	.toggle-card.partner-card {
		border: 1px solid rgba(139,92,246,0.2);
		background: linear-gradient(135deg, rgba(139,92,246,0.04), rgba(168,85,247,0.02));
		position: relative;
	}
	.toggle-card.partner-card:hover {
		border-color: rgba(139,92,246,0.35);
		background: linear-gradient(135deg, rgba(139,92,246,0.08), rgba(168,85,247,0.04));
		box-shadow: 0 0 20px rgba(139,92,246,0.08);
	}
	.toggle-card.partner-card.active {
		border-color: rgba(139,92,246,0.45);
		background: linear-gradient(135deg, rgba(139,92,246,0.1), rgba(168,85,247,0.06));
		box-shadow: 0 0 24px rgba(139,92,246,0.12);
	}
	.partner-icon {
		background: rgba(139,92,246,0.15) !important;
		color: #a78bfa !important;
	}
	.partner-switch.on {
		background: rgba(139,92,246,0.5) !important;
	}

	.toggle-info { display: flex; align-items: center; gap: 10px; }
	.toggle-icon {
		font-size: 16px;
		font-weight: 800;
		width: 32px;
		height: 32px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 8px;
		background: rgba(255,255,255,0.05);
		color: #94a3b8;
	}

	.toggle-switch {
		width: 36px;
		height: 20px;
		border-radius: 999px;
		background: rgba(255,255,255,0.1);
		position: relative;
		transition: all 0.2s;
		flex-shrink: 0;
	}
	.toggle-switch.on { background: rgba(0,210,255,0.5); }

	.toggle-thumb {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: white;
		position: absolute;
		top: 3px;
		left: 3px;
		transition: all 0.2s;
	}
	.toggle-switch.on .toggle-thumb { transform: translateX(16px); }

	.feature-notice {
		margin-top: 8px;
		padding: 10px 12px;
		border-radius: 8px;
		animation: fadeIn 0.2s ease-out;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.feature-notice.cyan {
		background: rgba(0,210,255,0.05);
		border: 1px solid rgba(0,210,255,0.15);
	}
	.feature-notice.amber {
		background: rgba(245,158,11,0.05);
		border: 1px solid rgba(245,158,11,0.15);
	}
	.feature-notice-title {
		font-family: 'Syne', sans-serif;
		font-size: 12px;
		font-weight: 700;
		color: #e2e8f0;
	}
	.feature-notice.cyan .feature-notice-title { color: #67e8f9; }
	.feature-notice.amber .feature-notice-title { color: #fbbf24; }
	.feature-notice-text {
		font-size: 11px;
		color: #9ca3af;
		font-family: 'Space Mono', monospace;
		line-height: 1.5;
	}

	.partner-perks {
		margin-top: 10px;
		padding: 14px;
		background: rgba(139,92,246,0.06);
		border: 1px solid rgba(139,92,246,0.2);
		border-radius: 10px;
		animation: fadeIn 0.2s ease-out;
	}
	@keyframes fadeIn {
		from { opacity: 0; transform: translateY(-4px); }
		to   { opacity: 1; transform: translateY(0); }
	}
	.partner-perks-header { margin-bottom: 8px; }
	.partner-perks-list {
		list-style: none;
		padding: 0;
		margin: 0 0 10px 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.partner-perks-list li {
		font-size: 12px;
		color: #c4b5fd;
		font-family: 'Space Mono', monospace;
		padding-left: 16px;
		position: relative;
		line-height: 1.4;
	}
	.partner-perks-list li::before {
		content: '+';
		position: absolute;
		left: 0;
		color: #8b5cf6;
		font-weight: 700;
	}
	.partner-terms {
		padding-top: 8px;
		border-top: 1px solid rgba(139,92,246,0.12);
	}

	.fee-notice {
		padding: 10px 14px;
		background: rgba(245,158,11,0.06);
		border: 1px solid rgba(245,158,11,0.15);
		border-radius: 8px;
	}

	.submit-btn {
		padding: 14px;
		background: linear-gradient(135deg, #00d2ff, #3a7bd5);
		color: white;
		font-weight: 700;
		font-size: 15px;
		border: none;
		border-radius: 12px;
		cursor: pointer;
		transition: all 0.2s;
		letter-spacing: 0.01em;
	}
	.submit-btn:hover {
		transform: translateY(-1px);
		box-shadow: 0 8px 32px rgba(0,210,255,0.3);
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0,0,0,0);
		white-space: nowrap;
		border-width: 0;
	}

	select option { background: #0d0d14; color: white; }
	.syne { font-family: 'Syne', sans-serif; }

	.protection-info {
		padding: 12px 14px;
		background: rgba(16,185,129,0.05);
		border: 1px solid rgba(16,185,129,0.15);
		border-radius: 10px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.protection-info-title {
		font-size: 12px;
		font-weight: 700;
		color: #34d399;
	}
	.protection-info-text {
		font-size: 11px;
		color: #9ca3af;
		font-family: 'Space Mono', monospace;
		line-height: 1.5;
	}

	/* Listing Settings */
	.listing-section {
		padding: 16px;
		background: rgba(255,255,255,0.02);
		border-radius: 12px;
		border: 1px solid rgba(255,255,255,0.05);
	}

	.listing-icon {
		background: rgba(16,185,129,0.12) !important;
		color: #10b981 !important;
	}
	.toggle-card.listing-active {
		border-color: rgba(16,185,129,0.3);
		background: rgba(16,185,129,0.05);
	}
	.toggle-card.listing-active:hover {
		border-color: rgba(16,185,129,0.4);
	}
	.listing-switch-on {
		background: rgba(16,185,129,0.5) !important;
	}

	.listing-settings {
		margin-top: 12px;
		padding: 16px;
		background: rgba(16,185,129,0.03);
		border: 1px solid rgba(16,185,129,0.12);
		border-radius: 10px;
		display: flex;
		flex-direction: column;
		gap: 14px;
		animation: fadeIn 0.2s ease-out;
	}

	.pair-options {
		display: flex;
		gap: 8px;
	}
	.pair-option {
		flex: 1;
		padding: 10px;
		border-radius: 8px;
		border: 1px solid rgba(255,255,255,0.08);
		background: rgba(255,255,255,0.03);
		color: #94a3b8;
		font-family: 'Space Mono', monospace;
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.15s;
		text-align: center;
	}
	.pair-option:hover {
		border-color: rgba(16,185,129,0.3);
		color: #e2e8f0;
	}
	.pair-option.active {
		border-color: rgba(16,185,129,0.5);
		background: rgba(16,185,129,0.1);
		color: #10b981;
	}

	.mode-toggle {
		display: flex;
		gap: 4px;
		background: rgba(255,255,255,0.03);
		border: 1px solid rgba(255,255,255,0.06);
		border-radius: 8px;
		padding: 3px;
	}
	.mode-btn {
		flex: 1;
		padding: 8px 12px;
		border-radius: 6px;
		border: none;
		background: transparent;
		color: #6b7280;
		font-family: 'Space Mono', monospace;
		font-size: 12px;
		cursor: pointer;
		transition: all 0.15s;
	}
	.mode-btn:hover { color: #e2e8f0; }
	.mode-btn.active {
		background: rgba(16,185,129,0.12);
		color: #10b981;
	}

	.input-with-badge {
		position: relative;
	}
	.input-with-badge .input-field {
		padding-right: 70px;
	}
	.input-badge {
		position: absolute;
		right: 12px;
		top: 50%;
		transform: translateY(-50%);
		font-size: 11px;
		font-family: 'Space Mono', monospace;
		color: #4b5563;
		pointer-events: none;
	}

	.calc-result {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 10px 12px;
		background: rgba(16,185,129,0.05);
		border: 1px solid rgba(16,185,129,0.12);
		border-radius: 8px;
	}

	.listing-pct-bar {
		padding: 10px 0;
	}
	.pct-track {
		height: 4px;
		background: rgba(255,255,255,0.06);
		border-radius: 999px;
		overflow: hidden;
	}
	.pct-fill {
		height: 100%;
		background: linear-gradient(90deg, #10b981, #00d2ff);
		border-radius: 999px;
		transition: width 0.3s;
	}

	.listing-info-box {
		padding: 10px 12px;
		background: rgba(255,255,255,0.02);
		border: 1px solid rgba(255,255,255,0.05);
		border-radius: 8px;
	}
</style>
