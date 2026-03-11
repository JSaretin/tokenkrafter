<script lang="ts">
	import type { SupportedNetwork } from '$lib/structure';
	import BondingCurveChart from '$lib/BondingCurveChart.svelte';

	export type ListingConfig = {
		enabled: boolean;
		baseCoin: 'native' | 'usdt' | 'usdc';
		mode: 'manual' | 'price';
		tokenAmount: string;
		baseAmount: string;
		pricePerToken: string;
		listBaseAmount: string;
	};

	export type LaunchConfig = {
		enabled: boolean;
		tokensForLaunchPct: number;
		curveType: number;
		softCap: string;
		hardCap: string;
		durationDays: string;
		maxBuyBps: string;
		creatorAllocationBps: string;
		vestingDays: string;
		launchPaymentToken: string;
	};

	export type ProtectionConfig = {
		maxWalletPct: string;
		maxTransactionPct: string;
		cooldownSeconds: string;
	};

	export type TaxConfig = {
		buyTaxPct: string;
		sellTaxPct: string;
		transferTaxPct: string;
		wallets: { address: string; sharePct: string }[];
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
		launch: LaunchConfig;
		protection: ProtectionConfig;
		tax: TaxConfig;
	};

	// --- State ---
	type WizardStep = 'basics' | 'features' | 'tax' | 'launch';
	let wizardStep = $state<WizardStep>('basics');

	// Step 1: Basics
	let name = $state('');
	let symbol = $state('');
	let totalSupply = $state('');
	let decimals = $state(18);
	let chainId: number | undefined = $state();

	// Step 2: Features
	let isMintable = $state(false);
	let isTaxable = $state(false);
	let isPartner = $state(false);
	let launchEnabled = $state(false);

	// Step 3: Tax (if taxable/partner)
	let buyTaxPct = $state('');
	let sellTaxPct = $state('');
	let transferTaxPct = $state('');
	let taxWallets = $state<{ address: string; sharePct: string }[]>([
		{ address: '', sharePct: '100' }
	]);

	// Step 4: Launch
	let launchTokensPct = $state(40);
	let launchCurveType = $state(0);
	let launchSoftCap = $state('5');
	let launchHardCap = $state('50');
	let launchDurationDays = $state('30');
	let launchMaxBuyBps = $state('200');
	let launchCreatorAllocBps = $state('0');
	let launchVestingDays = $state('0');

	// Protection (within launch step)
	let protectionEnabled = $state(false);
	let maxWalletPct = $state('2');
	let maxTransactionPct = $state('1');
	let cooldownSeconds = $state('0');

	// Listing (disabled for now)
	let listingEnabled = $state(false);
	let listingBaseCoin = $state<'native' | 'usdt' | 'usdc'>('native');
	let listingMode = $state<'manual' | 'price'>('manual');
	let listingTokenAmount = $state('');
	let listingBaseAmount = $state('');
	let listingPricePerToken = $state('');
	let listingListBaseAmount = $state('');

	const CURVE_TYPES_LABEL = ['Linear', 'Square Root', 'Quadratic', 'Exponential'] as const;

	export type PreviewState = {
		name: string;
		symbol: string;
		totalSupply: string;
		decimals: number;
		isMintable: boolean;
		isTaxable: boolean;
		isPartner: boolean;
		networkName: string;
		launchEnabled: boolean;
		launchTokensPct: number;
		launchCurveType: number;
		launchSoftCap: string;
		launchHardCap: string;
		protectionEnabled: boolean;
		maxWalletPct: string;
		maxTransactionPct: string;
		buyTaxPct: string;
		sellTaxPct: string;
		transferTaxPct: string;
		wizardStep: string;
	};

	let {
		supportedNetworks,
		addFeedback,
		updateTokenInfo,
		onPreviewChange
	}: {
		supportedNetworks: SupportedNetwork[];
		addFeedback: (feedback: { message: string; type: string }) => void;
		updateTokenInfo: (tokenInfo: TokenFormData) => void;
		onPreviewChange?: (state: PreviewState) => void;
	} = $props();

	let selectedNetwork = $derived(supportedNetworks.find((n) => n.chain_id == chainId));
	let nativeCoinSymbol = $derived(selectedNetwork?.native_coin ?? 'ETH');

	// Emit preview state on every change
	$effect(() => {
		onPreviewChange?.({
			name, symbol, totalSupply, decimals,
			isMintable, isTaxable, isPartner,
			networkName: selectedNetwork?.name ?? '',
			launchEnabled, launchTokensPct, launchCurveType: launchCurveType,
			launchSoftCap, launchHardCap,
			protectionEnabled, maxWalletPct, maxTransactionPct,
			buyTaxPct, sellTaxPct, transferTaxPct,
			wizardStep
		});
	});

	let launchTokensAmount = $derived(() => {
		if (!totalSupply || launchTokensPct <= 0) return '0';
		return Math.floor(Number(totalSupply) * launchTokensPct / 100).toString();
	});

	// Tax validation
	let totalTaxPct = $derived(() => {
		return (parseFloat(buyTaxPct) || 0) + (parseFloat(sellTaxPct) || 0) + (parseFloat(transferTaxPct) || 0);
	});
	let maxBuyTax = $derived(isPartner ? 9 : 10);
	let maxSellTax = $derived(isPartner ? 9 : 10);
	let maxTotalTax = $derived(isPartner ? 24 : 25);
	let totalSharePct = $derived(() => {
		return taxWallets.reduce((sum, w) => sum + (parseFloat(w.sharePct) || 0), 0);
	});

	// --- Inline validation ---
	let touched = $state<Record<string, boolean>>({});
	function markTouched(field: string) { touched[field] = true; }

	let nameError = $derived(touched['name'] && !name.trim() ? 'Required' : '');
	let symbolError = $derived(touched['symbol'] && !symbol.trim() ? 'Required' : '');
	let supplyError = $derived(touched['supply'] && (!totalSupply || Number(totalSupply) <= 0) ? 'Must be > 0' : '');
	let networkError = $derived(touched['network'] && !chainId ? 'Select a network' : '');

	// Tax inline validation
	let buyTaxError = $derived(() => {
		if (!touched['buyTax']) return '';
		const v = parseFloat(buyTaxPct) || 0;
		return v > maxBuyTax ? `Max ${maxBuyTax}%` : '';
	});
	let sellTaxError = $derived(() => {
		if (!touched['sellTax']) return '';
		const v = parseFloat(sellTaxPct) || 0;
		return v > maxSellTax ? `Max ${maxSellTax}%` : '';
	});
	let transferTaxError = $derived(() => {
		if (!touched['transferTax']) return '';
		const v = parseFloat(transferTaxPct) || 0;
		return v > 5 ? 'Max 5%' : '';
	});
	let totalTaxError = $derived(() => {
		if (!touched['buyTax'] && !touched['sellTax'] && !touched['transferTax']) return '';
		return totalTaxPct() > maxTotalTax ? `Total exceeds ${maxTotalTax}%` : '';
	});

	// --- Step navigation ---
	let stepList = $derived(() => {
		const s: { id: WizardStep; label: string }[] = [
			{ id: 'basics', label: 'Basics' },
			{ id: 'features', label: 'Features' }
		];
		if (isTaxable) s.push({ id: 'tax', label: 'Tax' });
		if (launchEnabled) s.push({ id: 'launch', label: 'Launch' });
		return s;
	});

	let currentStepIndex = $derived(stepList().findIndex((s) => s.id === wizardStep));

	function validateBasics(): boolean {
		touched = { ...touched, name: true, symbol: true, supply: true, network: true };
		if (!name.trim()) { addFeedback({ message: 'Token name is required', type: 'error' }); return false; }
		if (!symbol.trim()) { addFeedback({ message: 'Token symbol is required', type: 'error' }); return false; }
		if (!totalSupply || Number(totalSupply) <= 0) { addFeedback({ message: 'Total supply must be > 0', type: 'error' }); return false; }
		if (!chainId) { addFeedback({ message: 'Please select a network', type: 'error' }); return false; }
		return true;
	}

	function validateTax(): boolean {
		touched = { ...touched, buyTax: true, sellTax: true, transferTax: true };
		const buy = parseFloat(buyTaxPct) || 0;
		const sell = parseFloat(sellTaxPct) || 0;
		const transfer = parseFloat(transferTaxPct) || 0;
		if (buy > maxBuyTax) { addFeedback({ message: `Buy tax must be <= ${maxBuyTax}%`, type: 'error' }); return false; }
		if (sell > maxSellTax) { addFeedback({ message: `Sell tax must be <= ${maxSellTax}%`, type: 'error' }); return false; }
		if (transfer > 5) { addFeedback({ message: 'Transfer tax must be <= 5%', type: 'error' }); return false; }
		if (buy + sell + transfer > maxTotalTax) { addFeedback({ message: `Total tax must be <= ${maxTotalTax}%`, type: 'error' }); return false; }

		// Validate wallets if any tax is set
		if (buy > 0 || sell > 0 || transfer > 0) {
			const hasWallets = taxWallets.some((w) => w.address.trim());
			if (hasWallets) {
				const sharePctSum = totalSharePct();
				if (sharePctSum > 100.01) {
					addFeedback({ message: `Tax wallet shares cannot exceed 100% (currently ${sharePctSum.toFixed(1)}%)`, type: 'error' });
					return false;
				}
				for (const w of taxWallets) {
					if (w.address.trim() && !/^0x[a-fA-F0-9]{40}$/.test(w.address.trim())) {
						addFeedback({ message: `Invalid wallet address: ${w.address}`, type: 'error' });
						return false;
					}
				}
			}
		}
		return true;
	}

	function validateLaunch(): boolean {
		const network = supportedNetworks.find((n) => n.chain_id == chainId);
		if (!network?.launchpad_address || network.launchpad_address === '0x') {
			addFeedback({ message: 'Launchpad not available on this network yet.', type: 'error' });
			return false;
		}
		if (!launchSoftCap || !launchHardCap || parseFloat(launchHardCap) < parseFloat(launchSoftCap)) {
			addFeedback({ message: 'Hard cap must be >= soft cap.', type: 'error' });
			return false;
		}
		if (launchTokensPct <= 0 || launchTokensPct > 100) {
			addFeedback({ message: 'Launch token % must be 1-100.', type: 'error' });
			return false;
		}
		return true;
	}

	function nextStep() {
		if (wizardStep === 'basics') {
			if (!validateBasics()) return;
			wizardStep = 'features';
		} else if (wizardStep === 'features') {
			if (isTaxable) wizardStep = 'tax';
			else if (launchEnabled) wizardStep = 'launch';
			else submit();
		} else if (wizardStep === 'tax') {
			if (!validateTax()) return;
			if (launchEnabled) wizardStep = 'launch';
			else submit();
		} else if (wizardStep === 'launch') {
			if (!validateLaunch()) return;
			submit();
		}
	}

	function prevStep() {
		if (wizardStep === 'features') wizardStep = 'basics';
		else if (wizardStep === 'tax') wizardStep = 'features';
		else if (wizardStep === 'launch') {
			if (isTaxable) wizardStep = 'tax';
			else wizardStep = 'features';
		}
	}

	function addTaxWallet() {
		if (taxWallets.length >= 10) return;
		taxWallets = [...taxWallets, { address: '', sharePct: '' }];
	}

	function removeTaxWallet(index: number) {
		if (taxWallets.length <= 1) return;
		taxWallets = taxWallets.filter((_, i) => i !== index);
	}

	function submit() {
		const network = supportedNetworks.find((n) => n.chain_id == chainId);
		if (!network) return;

		// Filter valid tax wallets
		const validWallets = taxWallets.filter((w) => w.address.trim() && /^0x[a-fA-F0-9]{40}$/.test(w.address.trim()));

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
			},
			launch: {
				enabled: launchEnabled,
				tokensForLaunchPct: launchTokensPct,
				curveType: launchCurveType,
				softCap: launchSoftCap,
				hardCap: launchHardCap,
				durationDays: launchDurationDays,
				maxBuyBps: launchMaxBuyBps,
				creatorAllocationBps: launchCreatorAllocBps,
				vestingDays: launchVestingDays,
				launchPaymentToken: '0x0000000000000000000000000000000000000000'
			},
			protection: {
				maxWalletPct: (launchEnabled && protectionEnabled) ? maxWalletPct : '0',
				maxTransactionPct: (launchEnabled && protectionEnabled) ? maxTransactionPct : '0',
				cooldownSeconds: (launchEnabled && protectionEnabled) ? cooldownSeconds : '0'
			},
			tax: {
				buyTaxPct: isTaxable ? buyTaxPct : '0',
				sellTaxPct: isTaxable ? sellTaxPct : '0',
				transferTaxPct: isTaxable ? transferTaxPct : '0',
				wallets: isTaxable ? validWallets : []
			}
		});
	}
</script>

<form class="wizard" autocomplete="off" onsubmit={(e) => e.preventDefault()}>
	<!-- Step Indicator -->
	<div class="step-indicator">
		{#each stepList() as step, i}
			<button
				type="button"
				class="step-dot {step.id === wizardStep ? 'active' : i < currentStepIndex ? 'done' : ''}"
				onclick={() => {
					// Allow going back to completed steps
					if (i < currentStepIndex) wizardStep = step.id;
				}}
			>
				<span class="step-num">{i < currentStepIndex ? 'v' : i + 1}</span>
				<span class="step-label">{step.label}</span>
			</button>
			{#if i < stepList().length - 1}
				<div class="step-line {i < currentStepIndex ? 'done' : ''}"></div>
			{/if}
		{/each}
	</div>

	<!-- ==================== STEP: BASICS ==================== -->
	{#if wizardStep === 'basics'}
		<div class="wizard-step" style="animation: fadeIn 0.2s ease-out">
			<div class="step-header">
				<h2 class="syne text-xl font-bold text-white">Token Basics</h2>
				<p class="text-sm text-gray-500 font-mono mt-1">The identity of your token on the blockchain.</p>
			</div>

			<div class="step-body">
				<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
					<div class="field-group">
						<label class="label-text" for="token-name">Token Name</label>
						<input id="token-name" required class="input-field" class:field-error={nameError} bind:value={name} onblur={() => markTouched('name')} placeholder="My Awesome Token" />
						{#if nameError}<span class="field-error-text">{nameError}</span>{:else}<div class="tip">The full name shown on explorers and wallets. Pick something memorable and unique.</div>{/if}
					</div>
					<div class="field-group">
						<label class="label-text" for="token-symbol">Symbol</label>
						<input id="token-symbol" required class="input-field" class:field-error={symbolError} bind:value={symbol} onblur={() => markTouched('symbol')} placeholder="MAT" maxlength="8" />
						{#if symbolError}<span class="field-error-text">{symbolError}</span>{:else}<div class="tip">The ticker symbol (like BTC, ETH). 3-5 characters is standard. Shown in wallets and exchanges.</div>{/if}
						<span class="field-hint">{symbol.length}/8 chars</span>
					</div>
				</div>

				<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
					<div class="field-group">
						<label class="label-text" for="token-supply">Total Supply</label>
						<input id="token-supply" required class="input-field" class:field-error={supplyError} bind:value={totalSupply} onblur={() => markTouched('supply')} placeholder="1,000,000" type="number" min="1" />
						{#if supplyError}<span class="field-error-text">{supplyError}</span>{:else}<div class="tip">How many tokens exist in total. Common amounts: 1M, 100M, 1B. This is the maximum supply unless Mintable is enabled.</div>{/if}
					</div>
					<div class="field-group">
						<label class="label-text" for="token-decimals">Decimals</label>
						<input id="token-decimals" required class="input-field" bind:value={decimals} type="number" min="0" max="18" />
						<div class="tip">How divisible your token is. 18 is standard (like ETH). Use less for non-fractional tokens (e.g. 0 for NFT-like items).</div>
						<span class="field-hint">Standard: 18</span>
					</div>
				</div>

				<div class="field-group">
					<label class="label-text" for="token-network">Network</label>
					<select id="token-network" required class="input-field" class:field-error={networkError} bind:value={chainId} onblur={() => markTouched('network')}>
						<option value="">Select a network</option>
						{#each supportedNetworks.filter((n) => n.platform_address.length > 2) as n (n.chain_id)}
							<option value={n.chain_id}>{n.name} ({n.native_coin})</option>
						{/each}
					</select>
					{#if networkError}<span class="field-error-text">{networkError}</span>{:else}<div class="tip">Which blockchain to deploy on. BSC has low fees and fast transactions. Ethereum has the largest DeFi ecosystem.</div>{/if}
				</div>
			</div>
		</div>

	<!-- ==================== STEP: FEATURES ==================== -->
	{:else if wizardStep === 'features'}
		<div class="wizard-step" style="animation: fadeIn 0.2s ease-out">
			<div class="step-header">
				<h2 class="syne text-xl font-bold text-white">Token Features</h2>
				<p class="text-sm text-gray-500 font-mono mt-1">Choose what your token can do. Features affect the creation fee.</p>
			</div>

			<div class="step-body">
				<div class="flex flex-col gap-4">
					<!-- Mintable -->
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
							<div class="edu-box cyan">
								<div class="edu-title">What is Mintable?</div>
								<div class="edu-text">As the owner, you can create new tokens anytime. Useful for staking rewards, airdrops, or game economies. Holders can also burn (destroy) their own tokens. Be transparent about minting plans — unlimited minting can dilute existing holders.</div>
							</div>
						{/if}
					</div>

					<!-- Taxable -->
					<div>
						<label class="toggle-card {isTaxable ? 'active tax-active' : ''}">
							<div class="toggle-info">
								<div class="toggle-icon tax-icon">%</div>
								<div>
									<div class="text-sm font-semibold text-white syne">Taxable</div>
									<div class="text-xs text-gray-500 font-mono mt-0.5">Collect fee on every trade</div>
								</div>
							</div>
							<div class="toggle-switch {isTaxable ? 'on tax-switch-on' : ''}">
								<div class="toggle-thumb"></div>
							</div>
							<input type="checkbox" bind:checked={isTaxable} class="sr-only" />
						</label>
						{#if isTaxable}
							<div class="edu-box amber">
								<div class="edu-title">What is a Token Tax?</div>
								<div class="edu-text">A small percentage is automatically deducted on buys, sells, or transfers. The tax is split between wallets you configure (marketing, development, rewards, etc). You'll set the exact rates and wallets in the next step. <strong>Max rates:</strong> buy 10%, sell 10%, transfer 5%, total 25%{isPartner ? ' (reduced by 1% for partner fee)' : ''}.</div>
							</div>
						{/if}
					</div>

					<!-- Partner -->
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
							<div class="edu-box purple">
								<div class="edu-title">Partner Benefits</div>
								<div class="edu-text">Your token gets featured on our homepage, promoted across our social channels, and receives auto-created DEX liquidity pools. In exchange, a built-in 1% fee on buy &amp; sell sustains your ongoing promotion. You can add your own tax on top (up to 9% buy/sell).</div>
							</div>
						{/if}
					</div>

					<!-- Divider -->
					<div class="section-divider"></div>

					<!-- Launch toggle -->
					<div>
						<label class="toggle-card {launchEnabled ? 'active launch-active' : ''}">
							<div class="toggle-info">
								<div class="toggle-icon launch-icon">R</div>
								<div>
									<div class="text-sm font-semibold text-white syne">Launch on Launchpad</div>
									<div class="text-xs text-gray-500 font-mono mt-0.5">Bonding curve launch with auto DEX graduation</div>
								</div>
							</div>
							<div class="toggle-switch {launchEnabled ? 'on launch-switch-on' : ''}">
								<div class="toggle-thumb"></div>
							</div>
							<input type="checkbox" bind:checked={launchEnabled} class="sr-only" />
						</label>
						{#if launchEnabled}
							<div class="edu-box cyan">
								<div class="edu-title">How does a Bonding Curve Launch work?</div>
								<div class="edu-text">Your token starts at a low price that increases as people buy. Early buyers get a better price — rewarding early supporters. When the fundraise hits the <strong>hard cap</strong>, the token automatically "graduates" and gets listed on a DEX (like PancakeSwap) with real liquidity. If the <strong>soft cap</strong> isn't reached by the deadline, all buyers get a full refund. Everything happens in one click — no manual setup needed. You'll configure the curve and caps in the launch step.</div>
							</div>
						{:else}
							<div class="tip mt-2">
								Skip the launchpad to deploy a standard token. You can add DEX liquidity manually from Manage Tokens after deployment. You'll also need to configure protection settings and enable trading separately.
							</div>
						{/if}
					</div>
				</div>

				{#if isMintable || isTaxable || isPartner}
					<div class="fee-notice mt-4">
						<span class="text-amber-400 text-sm font-mono">Fee applies:</span>
						<span class="text-gray-400 text-xs font-mono ml-2">
							{[isMintable && 'Mintable', isTaxable && 'Taxable', isPartner && 'Partner'].filter(Boolean).join(' + ')}
							fee will be shown in the review step.
						</span>
					</div>
				{/if}
			</div>
		</div>

	<!-- ==================== STEP: TAX ==================== -->
	{:else if wizardStep === 'tax'}
		<div class="wizard-step" style="animation: fadeIn 0.2s ease-out">
			<div class="step-header">
				<h2 class="syne text-xl font-bold text-white">Tax Configuration</h2>
				<p class="text-sm text-gray-500 font-mono mt-1">
					Set fees collected on every trade and where they go.{isPartner ? ' Partner tokens also have a built-in 1% platform fee on top.' : ''}
				</p>
			</div>

			<div class="step-body">
				<!-- Tax Rates -->
				<div class="subsection">
					<h3 class="subsection-title syne">Tax Rates</h3>

					<div class="edu-box amber compact mb-4">
						<div class="edu-text">Taxes are automatically deducted from every transaction. A 3% buy tax means for every $100 purchase, $3 goes to your configured wallets. Set to 0 to disable a tax type. You can change rates anytime after deployment.</div>
					</div>

					<div class="grid grid-cols-3 gap-3">
						<div class="field-group">
							<label class="label-text" for="tax-buy">Buy Tax %</label>
							<input id="tax-buy" type="number" class="input-field" class:field-error={buyTaxError()} bind:value={buyTaxPct} onblur={() => markTouched('buyTax')} min="0" max={maxBuyTax} step="0.5" placeholder="0" />
							{#if buyTaxError()}<span class="field-error-text">{buyTaxError()}</span>{:else}<div class="tip">Charged when someone buys on a DEX. Typical: 2-5%.</div>{/if}
						</div>
						<div class="field-group">
							<label class="label-text" for="tax-sell">Sell Tax %</label>
							<input id="tax-sell" type="number" class="input-field" class:field-error={sellTaxError()} bind:value={sellTaxPct} onblur={() => markTouched('sellTax')} min="0" max={maxSellTax} step="0.5" placeholder="0" />
							{#if sellTaxError()}<span class="field-error-text">{sellTaxError()}</span>{:else}<div class="tip">Charged when someone sells. Higher = discourages selling, but can deter new buyers.</div>{/if}
						</div>
						<div class="field-group">
							<label class="label-text" for="tax-transfer">Transfer %</label>
							<input id="tax-transfer" type="number" class="input-field" class:field-error={transferTaxError()} bind:value={transferTaxPct} onblur={() => markTouched('transferTax')} min="0" max="5" step="0.5" placeholder="0" />
							{#if transferTaxError()}<span class="field-error-text">{transferTaxError()}</span>{:else}<div class="tip">On wallet-to-wallet transfers. Usually 0 unless you want to discourage OTC trading.</div>{/if}
						</div>
					</div>

					{#if totalTaxError()}
						<div class="field-error-text mt-2">{totalTaxError()}</div>
					{/if}

					{#if totalTaxPct() > 0}
						<div class="tax-summary">
							<span class="text-gray-400 text-xs font-mono">Total tax:</span>
							<span class="text-white text-sm font-mono font-bold {totalTaxPct() > maxTotalTax ? 'text-red-400' : ''}">{totalTaxPct().toFixed(1)}%</span>
							<span class="text-gray-600 text-xs font-mono">/ {maxTotalTax}% max</span>
							{#if isPartner}
								<span class="text-purple-400 text-xs font-mono ml-2">+ 1% partner fee</span>
							{/if}
						</div>
					{/if}
				</div>

				<!-- Tax Wallets -->
				{#if totalTaxPct() > 0}
					<div class="subsection">
						<h3 class="subsection-title syne">Tax Distribution</h3>

						<div class="edu-box cyan compact mb-4">
							<div class="edu-text">Where the collected tax goes. Split it across multiple wallets — for example, 50% to marketing, 30% to development, 20% to a rewards pool. Shares must total 100%. You can change wallets and shares after deployment.</div>
						</div>

						<div class="flex flex-col gap-3">
							{#each taxWallets as wallet, i}
								<div class="wallet-row">
									<div class="wallet-fields">
										<input
											class="input-field wallet-addr"
											bind:value={wallet.address}
											placeholder="0x... wallet address"
										/>
										<div class="share-input-wrap">
											<input
												class="input-field share-input"
												type="number"
												bind:value={wallet.sharePct}
												placeholder="50"
												min="1"
												max="100"
												step="1"
											/>
											<span class="share-suffix">%</span>
										</div>
										{#if taxWallets.length > 1}
											<button type="button" class="remove-wallet-btn" onclick={() => removeTaxWallet(i)}>x</button>
										{/if}
									</div>
									{#if i === 0}
										<div class="tip">Paste a wallet address. This could be your marketing wallet, a multi-sig, or any address.</div>
									{/if}
								</div>
							{/each}
						</div>

						{#if taxWallets.length < 10}
							<button type="button" class="add-wallet-btn" onclick={addTaxWallet}>
								+ Add wallet ({taxWallets.length}/10)
							</button>
						{/if}

						<div class="tax-summary">
							<span class="text-gray-400 text-xs font-mono">Share total:</span>
							<span class="text-sm font-mono font-bold {totalSharePct() > 100.01 ? 'text-red-400' : 'text-emerald-400'}">
								{totalSharePct().toFixed(0)}%
							</span>
							<span class="text-gray-600 text-xs font-mono">/ 100% max</span>
							{#if totalSharePct() > 0 && totalSharePct() < 99.99}
								<span class="text-amber-400 text-xs font-mono ml-1">({(100 - totalSharePct()).toFixed(0)}% burned)</span>
							{/if}
						</div>
					</div>

					<div class="edu-box subtle mt-2">
						{#if totalSharePct() > 0 && totalSharePct() < 99.99}
							<div class="edu-text">Shares total less than 100% — the remaining <strong>{(100 - totalSharePct()).toFixed(0)}%</strong> of collected tax will be <strong>burned</strong> (sent to the zero address), permanently reducing supply. This is a deflationary mechanism.</div>
						{:else}
							<div class="edu-text">No wallets configured? Tax will accumulate in the token contract. You can set up wallets later from the Manage Tokens page.</div>
						{/if}
					</div>
				{:else}
					<div class="edu-box subtle">
						<div class="edu-text">All tax rates are set to 0 — no tax will be collected. You can enable taxes later from the Manage Tokens page since tax settings are never locked.</div>
					</div>
				{/if}
			</div>
		</div>

	<!-- ==================== STEP: LAUNCH ==================== -->
	{:else if wizardStep === 'launch'}
		<div class="wizard-step" style="animation: fadeIn 0.2s ease-out">
			<div class="step-header">
				<h2 class="syne text-xl font-bold text-white">Launch Configuration</h2>
				<p class="text-sm text-gray-500 font-mono mt-1">Configure your bonding curve launch. Everything happens in one click.</p>
			</div>

			<div class="step-body">
				<!-- Tokens % -->
				<div class="field-group">
					<label class="label-text" for="launch-pct">Tokens for Launch ({launchTokensPct}%)</label>
					<input
						id="launch-pct"
						type="range"
						min="10" max="90" step="5"
						bind:value={launchTokensPct}
						class="range-input"
					/>
					<div class="flex justify-between text-[10px] font-mono text-gray-600">
						<span>10%</span>
						<span class="text-cyan-400">{launchTokensAmount()} {symbol || 'tokens'} (70% curve / 30% LP+alloc)</span>
						<span>90%</span>
					</div>
					<div class="tip">How much of the total supply goes into the bonding curve. The rest goes to your wallet. 70% of launch tokens are sold on the curve, 30% goes to DEX liquidity + creator allocation.</div>
				</div>

				<!-- Curve Type -->
				<div class="field-group">
					<label class="label-text" for="launch-curve">Bonding Curve Shape</label>
					<select id="launch-curve" class="input-field" bind:value={launchCurveType}>
						{#each CURVE_TYPES_LABEL as ct, i}
							<option value={i}>{ct}</option>
						{/each}
					</select>
					<div class="mt-2">
						<BondingCurveChart curveType={launchCurveType} width={240} height={130} />
					</div>
					<div class="tip">
						{#if launchCurveType === 0}
							<strong>Linear:</strong> Price increases at a constant rate. Simplest and most predictable. Good for steady, fair launches.
						{:else if launchCurveType === 1}
							<strong>Square Root:</strong> Price rises fast early, then slows down. Rewards early buyers more, but later buyers still get a reasonable price.
						{:else if launchCurveType === 2}
							<strong>Quadratic:</strong> Price starts slow, then accelerates sharply. Gives latecomers time to buy, but final price can be high.
						{:else}
							<strong>Exponential:</strong> Price grows exponentially. Creates a strong FOMO effect. Biggest reward for very early buyers.
						{/if}
					</div>
				</div>

				<!-- Caps -->
				<div class="grid grid-cols-2 gap-3">
					<div class="field-group">
						<label class="label-text" for="launch-soft">Soft Cap (USDT)</label>
						<input id="launch-soft" type="number" class="input-field" bind:value={launchSoftCap} step="any" min="0" placeholder="500" />
						<div class="tip">Minimum to raise. If not reached by deadline, all buyers get a full refund.</div>
					</div>
					<div class="field-group">
						<label class="label-text" for="launch-hard">Hard Cap (USDT)</label>
						<input id="launch-hard" type="number" class="input-field" bind:value={launchHardCap} step="any" min="0" placeholder="5000" />
						<div class="tip">Maximum raise. When hit, the token auto-graduates to a DEX with liquidity.</div>
					</div>
				</div>

				<!-- Duration + Max Buy -->
				<div class="grid grid-cols-2 gap-3">
					<div class="field-group">
						<label class="label-text" for="launch-dur">Duration</label>
						<select id="launch-dur" class="input-field" bind:value={launchDurationDays}>
							{#each [7, 14, 21, 30, 45, 60, 90] as d}
								<option value={String(d)}>{d} days</option>
							{/each}
						</select>
						<div class="tip">How long the bonding curve stays open. After this, if soft cap isn't met, refunds are enabled.</div>
					</div>
					<div class="field-group">
						<label class="label-text" for="launch-max">Max Buy / Wallet</label>
						<select id="launch-max" class="input-field" bind:value={launchMaxBuyBps}>
							<option value="50">0.5%</option>
							<option value="100">1%</option>
							<option value="200">2%</option>
							<option value="300">3%</option>
							<option value="500">5%</option>
						</select>
						<div class="tip">Max % of curve tokens one wallet can buy. Prevents one person from buying the entire launch.</div>
					</div>
				</div>

				<!-- Creator Alloc + Vesting -->
				<div class="grid grid-cols-2 gap-3">
					<div class="field-group">
						<label class="label-text" for="launch-alloc">Creator Allocation</label>
						<select id="launch-alloc" class="input-field" bind:value={launchCreatorAllocBps} onchange={() => { if (launchCreatorAllocBps !== '0' && launchVestingDays === '0') launchVestingDays = '30'; }}>
							<option value="0">None</option>
							<option value="100">1%</option>
							<option value="200">2%</option>
							<option value="300">3%</option>
							<option value="500">5%</option>
						</select>
						<div class="tip">% of launch tokens reserved for you (the creator), released over the vesting period. Builds investor trust via locked tokens.</div>
					</div>
					{#if launchCreatorAllocBps !== '0'}
						<div class="field-group">
							<label class="label-text" for="launch-vest">Vesting Period</label>
							<select id="launch-vest" class="input-field" bind:value={launchVestingDays}>
								<option value="30">30 days</option>
								<option value="60">60 days</option>
								<option value="90">90 days</option>
							</select>
							<div class="tip">Your allocated tokens unlock gradually over this period. Longer vesting signals stronger commitment.</div>
						</div>
					{/if}
				</div>

				<!-- Section divider -->
				<div class="section-divider"></div>

				<!-- Anti-Whale Protection -->
				<div class="subsection">
					<label class="toggle-card mini {protectionEnabled ? 'active protection-active' : ''}">
						<div class="toggle-info">
							<div>
								<div class="text-xs font-semibold text-white syne">Anti-Whale Protection</div>
								<div class="text-[10px] text-gray-500 font-mono mt-0.5">Limit max wallet &amp; transaction size</div>
							</div>
						</div>
						<div class="toggle-switch small {protectionEnabled ? 'on protection-switch-on' : ''}">
							<div class="toggle-thumb"></div>
						</div>
						<input type="checkbox" bind:checked={protectionEnabled} class="sr-only" />
					</label>

					{#if protectionEnabled}
						<div class="edu-box amber compact mt-3 mb-3">
							<div class="edu-text">Anti-whale limits prevent large holders from manipulating the price. Once trading is enabled (which happens automatically during launch), these limits are <strong>permanently locked</strong> — they can only be relaxed or removed, never made more restrictive. This protects investors from rug pulls via limit manipulation.</div>
						</div>

						<div class="grid grid-cols-2 gap-3">
							<div class="field-group">
								<label class="label-text" for="prot-wallet">Max Wallet (%)</label>
								<select id="prot-wallet" class="input-field" bind:value={maxWalletPct}>
									<option value="0">No limit</option>
									<option value="1">1%</option>
									<option value="2">2%</option>
									<option value="3">3%</option>
									<option value="5">5%</option>
									<option value="10">10%</option>
								</select>
								<div class="tip">Max tokens one wallet can hold. 2% = no one can hold more than 2% of supply.</div>
							</div>
							<div class="field-group">
								<label class="label-text" for="prot-tx">Max Transaction (%)</label>
								<select id="prot-tx" class="input-field" bind:value={maxTransactionPct}>
									<option value="0">No limit</option>
									<option value="0.5">0.5%</option>
									<option value="1">1%</option>
									<option value="2">2%</option>
									<option value="3">3%</option>
									<option value="5">5%</option>
								</select>
								<div class="tip">Max tokens per transaction. Prevents large single buys or sells that could crash the price.</div>
							</div>
						</div>
						<div class="field-group">
							<label class="label-text" for="prot-cool">Buy Cooldown</label>
							<select id="prot-cool" class="input-field" bind:value={cooldownSeconds}>
								<option value="0">Disabled</option>
								<option value="30">30 seconds</option>
								<option value="60">1 minute</option>
								<option value="300">5 minutes</option>
							</select>
							<div class="tip">Time between buys from the same wallet. Slows down bots that try to frontrun or snipe.</div>
						</div>
					{:else}
						<div class="tip mt-2">No whale protection — anyone can buy or hold any amount. You can't add limits later since trading is enabled at launch.</div>
					{/if}
				</div>

				<div class="edu-box subtle mt-2">
					<div class="edu-text">Token is created and launched in one transaction. Remaining supply goes to your wallet. 1% buy fee + 3% graduation fee applies.</div>
				</div>
			</div>
		</div>
	{/if}

	<!-- Navigation Buttons -->
	<div class="wizard-nav">
		{#if wizardStep !== 'basics'}
			<button type="button" class="nav-btn back" onclick={prevStep}>
				Back
			</button>
		{:else}
			<div></div>
		{/if}

		<button type="button" class="nav-btn next syne" onclick={nextStep}>
			{#if wizardStep === stepList()[stepList().length - 1]?.id}
				{launchEnabled ? 'Review Token & Launch' : 'Review Transaction'} ->
			{:else}
				Next ->
			{/if}
		</button>
	</div>
</form>

<style>
	.wizard {
		max-width: 580px;
		width: 100%;
		margin: 0 auto;
	}

	/* Inline validation */
	:global(.field-error) {
		border-color: rgba(239, 68, 68, 0.5) !important;
		box-shadow: 0 0 0 2px rgba(239, 68, 68, 0.1) !important;
	}
	.field-error-text {
		font-size: 11px;
		color: #f87171;
		font-family: 'Space Mono', monospace;
	}

	/* Step indicator */
	.step-indicator {
		display: flex;
		align-items: center;
		gap: 0;
		margin-bottom: 28px;
		padding: 0 4px;
	}
	.step-dot {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
		cursor: default;
		background: none;
		border: none;
		padding: 0;
		min-width: 48px;
	}
	.step-dot.done { cursor: pointer; }
	.step-num {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 12px;
		font-weight: 700;
		font-family: 'Space Mono', monospace;
		background: rgba(255,255,255,0.06);
		color: #4b5563;
		border: 2px solid rgba(255,255,255,0.08);
		transition: all 0.2s;
	}
	.step-dot.active .step-num {
		background: rgba(0,210,255,0.15);
		color: #00d2ff;
		border-color: rgba(0,210,255,0.4);
		box-shadow: 0 0 12px rgba(0,210,255,0.2);
	}
	.step-dot.done .step-num {
		background: rgba(16,185,129,0.15);
		color: #10b981;
		border-color: rgba(16,185,129,0.4);
	}
	.step-label {
		font-size: 10px;
		font-family: 'Space Mono', monospace;
		color: #4b5563;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}
	.step-dot.active .step-label { color: #00d2ff; }
	.step-dot.done .step-label { color: #10b981; }

	.step-line {
		flex: 1;
		height: 2px;
		background: rgba(255,255,255,0.06);
		margin: 0 4px;
		margin-bottom: 18px;
		transition: background 0.3s;
	}
	.step-line.done { background: rgba(16,185,129,0.4); }

	/* Wizard step content */
	.wizard-step {
		background: rgba(255,255,255,0.02);
		border: 1px solid rgba(255,255,255,0.07);
		border-radius: 20px;
		padding: 28px;
	}

	.step-header { margin-bottom: 20px; }
	.step-body { display: flex; flex-direction: column; gap: 16px; }

	.subsection { display: flex; flex-direction: column; gap: 12px; }
	.subsection-title {
		font-size: 13px;
		font-weight: 700;
		color: #e2e8f0;
	}

	.section-divider {
		height: 1px;
		background: rgba(255,255,255,0.06);
		margin: 4px 0;
	}

	/* Fields */
	.field-group { position: relative; display: flex; flex-direction: column; gap: 4px; }
	.field-hint {
		font-size: 11px;
		color: #4b5563;
		font-family: 'Space Mono', monospace;
	}

	/* Educational tips */
	.tip {
		font-size: 11px;
		color: #6b7280;
		font-family: 'Space Mono', monospace;
		line-height: 1.5;
		padding: 0 2px;
	}
	.tip strong { color: #9ca3af; }

	.edu-box {
		padding: 12px 14px;
		border-radius: 10px;
		animation: fadeIn 0.2s ease-out;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.edu-box.compact { padding: 10px 12px; }
	.edu-box.cyan {
		background: rgba(0,210,255,0.04);
		border: 1px solid rgba(0,210,255,0.12);
	}
	.edu-box.amber {
		background: rgba(245,158,11,0.04);
		border: 1px solid rgba(245,158,11,0.12);
	}
	.edu-box.purple {
		background: rgba(139,92,246,0.04);
		border: 1px solid rgba(139,92,246,0.12);
	}
	.edu-box.subtle {
		background: rgba(255,255,255,0.02);
		border: 1px solid rgba(255,255,255,0.06);
	}
	.edu-title {
		font-family: 'Syne', sans-serif;
		font-size: 12px;
		font-weight: 700;
		color: #e2e8f0;
	}
	.edu-box.cyan .edu-title { color: #67e8f9; }
	.edu-box.amber .edu-title { color: #fbbf24; }
	.edu-box.purple .edu-title { color: #c4b5fd; }
	.edu-text {
		font-size: 11px;
		color: #9ca3af;
		font-family: 'Space Mono', monospace;
		line-height: 1.6;
	}
	.edu-text strong { color: #d1d5db; }

	/* Toggle cards */
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
	.toggle-card.mini { padding: 10px 14px; }

	.toggle-card.tax-active { border-color: rgba(245,158,11,0.3); background: rgba(245,158,11,0.05); }
	.toggle-card.tax-active:hover { border-color: rgba(245,158,11,0.4); }
	.tax-icon { background: rgba(245,158,11,0.12) !important; color: #f59e0b !important; }
	.tax-switch-on { background: rgba(245,158,11,0.5) !important; }

	.toggle-card.launch-active { border-color: rgba(0,210,255,0.3); background: rgba(0,210,255,0.05); }
	.launch-icon { background: rgba(0,210,255,0.12) !important; color: #00d2ff !important; }
	.launch-switch-on { background: rgba(0,210,255,0.5) !important; }

	.toggle-card.protection-active { border-color: rgba(245,158,11,0.3); background: rgba(245,158,11,0.05); }
	.toggle-card.protection-active:hover { border-color: rgba(245,158,11,0.4); }
	.protection-switch-on { background: rgba(245,158,11,0.5) !important; }

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
	}
	.toggle-card.partner-card:hover {
		border-color: rgba(139,92,246,0.35);
		background: linear-gradient(135deg, rgba(139,92,246,0.08), rgba(168,85,247,0.04));
	}
	.toggle-card.partner-card.active {
		border-color: rgba(139,92,246,0.45);
		background: linear-gradient(135deg, rgba(139,92,246,0.1), rgba(168,85,247,0.06));
	}
	.partner-icon { background: rgba(139,92,246,0.15) !important; color: #a78bfa !important; }
	.partner-switch.on { background: rgba(139,92,246,0.5) !important; }

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
	.toggle-switch.small { width: 36px; min-width: 36px; height: 20px; }

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
	.toggle-switch.small .toggle-thumb { width: 14px; height: 14px; }

	/* Tax-specific */
	.tax-summary {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 8px 12px;
		background: rgba(255,255,255,0.02);
		border: 1px solid rgba(255,255,255,0.06);
		border-radius: 8px;
		margin-top: 4px;
	}

	.wallet-row { display: flex; flex-direction: column; gap: 4px; }
	.wallet-fields {
		display: flex;
		gap: 6px;
		align-items: center;
	}
	.wallet-addr { flex: 1; font-size: 12px !important; }
	.share-input-wrap {
		position: relative;
		width: 80px;
		flex-shrink: 0;
	}
	.share-input {
		width: 100%;
		padding-right: 24px !important;
		text-align: right;
	}
	.share-suffix {
		position: absolute;
		right: 8px;
		top: 50%;
		transform: translateY(-50%);
		font-size: 11px;
		color: #4b5563;
		pointer-events: none;
		font-family: 'Space Mono', monospace;
	}
	.remove-wallet-btn {
		width: 28px;
		height: 28px;
		border-radius: 6px;
		background: rgba(239,68,68,0.1);
		border: 1px solid rgba(239,68,68,0.2);
		color: #ef4444;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 12px;
		flex-shrink: 0;
		transition: all 0.15s;
	}
	.remove-wallet-btn:hover { background: rgba(239,68,68,0.2); }

	.add-wallet-btn {
		padding: 8px 14px;
		border-radius: 8px;
		background: rgba(255,255,255,0.03);
		border: 1px dashed rgba(255,255,255,0.1);
		color: #6b7280;
		font-family: 'Space Mono', monospace;
		font-size: 12px;
		cursor: pointer;
		transition: all 0.15s;
		margin-top: 4px;
	}
	.add-wallet-btn:hover { border-color: rgba(0,210,255,0.3); color: #00d2ff; }

	/* Fee notice */
	.fee-notice {
		padding: 10px 14px;
		background: rgba(245,158,11,0.06);
		border: 1px solid rgba(245,158,11,0.15);
		border-radius: 8px;
	}

	/* Navigation */
	.wizard-nav {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-top: 16px;
		gap: 12px;
	}
	.nav-btn {
		padding: 12px 24px;
		border-radius: 10px;
		font-size: 14px;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.2s;
		border: none;
	}
	.nav-btn.back {
		background: rgba(255,255,255,0.05);
		color: #94a3b8;
		font-family: 'Space Mono', monospace;
	}
	.nav-btn.back:hover { background: rgba(255,255,255,0.08); color: white; }
	.nav-btn.next {
		background: linear-gradient(135deg, #00d2ff, #3a7bd5);
		color: white;
		flex: 1;
		max-width: 300px;
		text-align: center;
	}
	.nav-btn.next:hover {
		transform: translateY(-1px);
		box-shadow: 0 8px 32px rgba(0,210,255,0.3);
	}

	/* Range input */
	.range-input {
		width: 100%;
		-webkit-appearance: none;
		appearance: none;
		height: 6px;
		border-radius: 3px;
		background: rgba(255,255,255,0.1);
		outline: none;
		margin: 8px 0;
	}
	.range-input::-webkit-slider-thumb {
		-webkit-appearance: none;
		appearance: none;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: linear-gradient(135deg, #00d2ff, #3a7bd5);
		cursor: pointer;
		border: 2px solid rgba(0,0,0,0.3);
	}
	.range-input::-moz-range-thumb {
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: linear-gradient(135deg, #00d2ff, #3a7bd5);
		cursor: pointer;
		border: 2px solid rgba(0,0,0,0.3);
	}

	/* Utility */
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

	@keyframes fadeIn {
		from { opacity: 0; transform: translateY(-4px); }
		to   { opacity: 1; transform: translateY(0); }
	}
</style>
