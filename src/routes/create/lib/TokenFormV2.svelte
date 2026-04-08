<script lang="ts" module>
	// Re-export types for parent compatibility
	export type ListingPairConfig = { base: 'native' | 'usdt' | 'usdc'; amount: string };
	export type ListingConfig = {
		enabled: boolean; baseCoin: 'native' | 'usdt' | 'usdc';
		mode: 'manual' | 'price'; tokenAmount: string; baseAmount: string;
		pricePerToken: string; listBaseAmount: string; pairs: ListingPairConfig[];
	};
	export type LaunchConfig = {
		enabled: boolean; tokensForLaunchPct: number; curveType: number;
		softCap: string; hardCap: string; durationDays: string;
		maxBuyBps: string; creatorAllocationBps: string; vestingDays: string;
		launchPaymentToken: string;
	};
	export type ProtectionConfig = { maxWalletPct: string; maxTransactionPct: string; cooldownSeconds: string };
	export type TaxConfig = { buyTaxPct: string; sellTaxPct: string; transferTaxPct: string; wallets: { address: string; sharePct: string }[] };
	export type TokenMetadata = { logoUrl: string; description: string; website: string; twitter: string; telegram: string };
	export type TokenFormData = {
		name: string; symbol: string; totalSupply: string; decimals: number;
		isMintable: boolean; isTaxable: boolean; isPartner: boolean;
		network: any; existingTokenAddress?: string;
		listing: ListingConfig; launch: LaunchConfig; protection: ProtectionConfig; tax: TaxConfig;
		metadata?: TokenMetadata;
	};
	export type PreviewState = {
		name: string; symbol: string; totalSupply: string; decimals: number;
		isMintable: boolean; isTaxable: boolean; isPartner: boolean; networkName: string;
		launchEnabled: boolean; launchTokensPct: number; launchCurveType: number;
		launchSoftCap: string; launchHardCap: string; protectionEnabled: boolean;
		maxWalletPct: string; maxTransactionPct: string; buyTaxPct: string;
		sellTaxPct: string; transferTaxPct: string; wizardStep: string;
		logoUrl: string; description: string; website: string; twitter: string; telegram: string;
	};
</script>

<script lang="ts">
	import { getContext } from 'svelte';
	import { ethers } from 'ethers';
	import type { SupportedNetwork } from '$lib/structure';
	import { BasicInfo, Features, TaxConfig as TaxStep, ListingConfig as ListingStep, Review } from './steps';
	import BondingCurveChart from '$lib/BondingCurveChart.svelte';

	type WizardStep = 'basics' | 'features' | 'tax' | 'launch' | 'listing' | 'review';
	let wizardStep = $state<WizardStep>('basics');

	// ── Props ──────────────────────────────────────────────
	let {
		supportedNetworks, addFeedback, updateTokenInfo, onPreviewChange, initialData, autoSubmit, forceMode
	}: {
		supportedNetworks: SupportedNetwork[]; addFeedback: (f: { message: string; type: string }) => void;
		updateTokenInfo: (info: TokenFormData) => void; onPreviewChange?: (state: PreviewState) => void;
		initialData?: Partial<TokenFormData>; autoSubmit?: boolean;
		forceMode?: 'token' | 'both' | 'launch' | 'list';
	} = $props();

	// ── All form state (bindable to child components) ──
	let name = $state('');
	let symbol = $state('');
	let totalSupply = $state('');
	let decimals = $state(18);
	let chainId: number | undefined = $state();
	let useExistingToken = $state(false);
	let existingTokenAddress = $state('');

	// Token metadata (optional)
	let tokenLogoUrl = $state('');
	let tokenDescription = $state('');
	let tokenWebsite = $state('');
	let tokenTwitter = $state('');
	let tokenTelegram = $state('');

	let isMintable = $state(false);
	let isTaxable = $state(false);
	let isPartner = $state(false);
	let launchEnabled = $state(false);
	let listingEnabled = $state(false);

	let buyTaxPct = $state('');
	let sellTaxPct = $state('');
	let transferTaxPct = $state('');
	let taxWallets = $state<{ address: string; sharePct: string }[]>([{ address: '', sharePct: '100' }]);

	let protectionEnabled = $state(false);
	let maxWalletPct = $state('2');
	let maxTransactionPct = $state('1');
	let cooldownSeconds = $state('0');

	let launchTokensPct = $state(40);
	let launchCurveType = $state(0);
	let launchSoftCap = $state('5');
	let launchHardCap = $state('50');
	let launchDurationDays = $state('30');
	let launchMaxBuyPct = $state('2');
	let launchCreatorAllocPct = $state('0');
	let launchVestingDays = $state('0');

	let listingPoolPct = $state(80);
	type ListingPair = { base: 'native' | 'usdt' | 'usdc'; amount: string };
	let listingPairs = $state<ListingPair[]>([{ base: 'native', amount: '' }]);
	let listingPricePerToken = $state('');

	// ── Clone: detect token type from on-chain or DB ──────
	$effect(() => {
		if (!useExistingToken || !existingTokenAddress || !chainId) return;
		// Only in clone mode (create-only)
		if (launchEnabled || listingEnabled) return;
		if (!ethers.isAddress(existingTokenAddress)) return;

		const addr = existingTokenAddress.toLowerCase();
		const cid = chainId;

		// Check our DB for token type
		fetch(`/api/token-metadata?address=${addr}&chain_id=${cid}`)
			.then(r => r.ok ? r.json() : null)
			.then(data => {
				if (data) {
					if (data.is_taxable) isTaxable = true;
					if (data.is_mintable) isMintable = true;
					if (data.is_partner) isPartner = true;
				}
			}).catch(() => {});

		// Also try reading tax rates from on-chain
		const providers = getNetworkProviders();
		const provider = providers.get(cid);
		if (provider) {
			const contract = new ethers.Contract(addr, [
				'function buyTaxBps() view returns (uint256)',
				'function sellTaxBps() view returns (uint256)',
				'function transferTaxBps() view returns (uint256)',
			], provider);
			Promise.all([
				contract.buyTaxBps().catch(() => 0n),
				contract.sellTaxBps().catch(() => 0n),
				contract.transferTaxBps().catch(() => 0n),
			]).then(([b, s, t]) => {
				const buy = Number(b) / 100;
				const sell = Number(s) / 100;
				const transfer = Number(t) / 100;
				if (buy > 0 || sell > 0 || transfer > 0) {
					isTaxable = true;
					if (buy > 0) buyTaxPct = String(buy);
					if (sell > 0) sellTaxPct = String(sell);
					if (transfer > 0) transferTaxPct = String(transfer);
				}
			}).catch(() => {});
		}
	});

	// ── Derived ────────────────────────────────────────────
	let selectedNetwork = $derived(supportedNetworks.find(n => n.chain_id == chainId));
	let nativeCoin = $derived(selectedNetwork?.native_coin || 'BNB');
	let getNetworkProviders: () => Map<number, ethers.JsonRpcProvider> = getContext('networkProviders');

	// BNB price for listing preview
	let bnbPriceUsd = $state(0);
	$effect(() => {
		if (!selectedNetwork?.dex_router || !selectedNetwork?.usdt_address) return;
		const provider = getNetworkProviders?.()?.get(selectedNetwork.chain_id);
		if (!provider) return;
		const router = new ethers.Contract(selectedNetwork.dex_router, [
			'function getAmountsOut(uint256, address[]) view returns (uint256[])',
			'function WETH() view returns (address)'
		], provider);
		(async () => {
			try {
				const weth = await router.WETH();
				const amounts = await router.getAmountsOut(ethers.parseEther('1'), [weth, selectedNetwork.usdt_address]);
				bnbPriceUsd = parseFloat(ethers.formatUnits(amounts[1], 18));
			} catch {}
		})();
	});

	// Auto price from listing
	function pairUsd(pair: ListingPair): number {
		const amt = Number(pair.amount);
		if (!amt || amt <= 0) return 0;
		return pair.base === 'native' ? amt * bnbPriceUsd : amt;
	}
	let totalLiquidityUsd = $derived(listingPairs.reduce((s, p) => s + pairUsd(p), 0));
	let tokensForPool = $derived(Number(totalSupply) * (listingPoolPct / 100));
	let autoPrice = $derived.by(() => tokensForPool > 0 && totalLiquidityUsd > 0 ? totalLiquidityUsd / tokensForPool : 0);

	// ── Force mode ─────────────────────────────────────────
	// Set initial mode from pre-selection (user can change on Features step)
	if (forceMode === 'token') { launchEnabled = false; listingEnabled = false; }
	else if (forceMode === 'both') { launchEnabled = true; listingEnabled = false; }
	else if (forceMode === 'launch') { launchEnabled = true; listingEnabled = false; }
	else if (forceMode === 'list') { launchEnabled = false; listingEnabled = true; }
	// Only set useExistingToken if explicitly launching an existing token (URL param)
	if (forceMode === 'launch' && initialData?.existingTokenAddress) { useExistingToken = true; }

	// ── Initial data ───────────────────────────────────────
	if (initialData) {
		if ((initialData as any).existingTokenAddress) { useExistingToken = true; existingTokenAddress = (initialData as any).existingTokenAddress; }
		if (initialData.name) name = initialData.name;
		if (initialData.symbol) symbol = initialData.symbol;
		if (initialData.totalSupply) totalSupply = initialData.totalSupply;
		if (initialData.decimals != null) decimals = initialData.decimals;
		if (initialData.network) chainId = initialData.network.chain_id;
		if (initialData.isMintable != null) isMintable = initialData.isMintable;
		if (initialData.isTaxable != null) isTaxable = initialData.isTaxable;
		if (initialData.isPartner != null) isPartner = initialData.isPartner;
		if (initialData.launch?.enabled != null) {
			launchEnabled = initialData.launch.enabled;
			if (initialData.launch.tokensForLaunchPct) launchTokensPct = initialData.launch.tokensForLaunchPct;
			if (initialData.launch.curveType != null) launchCurveType = initialData.launch.curveType;
			if (initialData.launch.softCap) launchSoftCap = initialData.launch.softCap;
			if (initialData.launch.hardCap) launchHardCap = initialData.launch.hardCap;
			if (initialData.launch.durationDays) launchDurationDays = initialData.launch.durationDays;
		}
		if (initialData.tax) {
			if (initialData.tax.buyTaxPct) buyTaxPct = initialData.tax.buyTaxPct;
			if (initialData.tax.sellTaxPct) sellTaxPct = initialData.tax.sellTaxPct;
			if (initialData.tax.transferTaxPct) transferTaxPct = initialData.tax.transferTaxPct;
			if (initialData.tax.wallets?.length) taxWallets = initialData.tax.wallets;
		}
		if (initialData.protection) {
			if (initialData.protection.maxWalletPct !== '0' || initialData.protection.maxTransactionPct !== '0') protectionEnabled = true;
			if (initialData.protection.maxWalletPct) maxWalletPct = initialData.protection.maxWalletPct;
			if (initialData.protection.maxTransactionPct) maxTransactionPct = initialData.protection.maxTransactionPct;
			if (initialData.protection.cooldownSeconds) cooldownSeconds = initialData.protection.cooldownSeconds;
		}
		if (initialData.listing?.enabled != null) {
			listingEnabled = initialData.listing.enabled;
			if (initialData.listing.pricePerToken) listingPricePerToken = initialData.listing.pricePerToken;
			if (initialData.listing.pairs?.length) listingPairs = initialData.listing.pairs.map(p => ({ base: p.base, amount: p.amount }));
		}
	}

	// ── Step navigation ────────────────────────────────────
	// Clone mode: user toggled "clone" on BasicInfo step. They're creating a NEW token
	// with pre-filled data. Even if they later enable launch/list, it's still a new token.
	// Real existing token: only when entering via Launch flow with a pre-set token address.
	let isRealExistingToken = $derived(useExistingToken && !!initialData?.existingTokenAddress);

	let steps = $derived.by(() => {
		const s: { id: WizardStep; label: string }[] = [{ id: 'basics', label: 'Basics' }];
		if (!isRealExistingToken) s.push({ id: 'features', label: 'Features' });
		if (isTaxable && !isRealExistingToken) s.push({ id: 'tax', label: 'Tax' });
		if (launchEnabled) s.push({ id: 'launch', label: 'Launch' });
		if (listingEnabled && !launchEnabled) s.push({ id: 'listing', label: 'DEX Listing' });
		s.push({ id: 'review', label: 'Review' });
		return s;
	});

	let currentStepIdx = $derived(steps.findIndex(s => s.id === wizardStep));

	function nextStep() {
		const idx = currentStepIdx;
		if (idx < steps.length - 1) wizardStep = steps[idx + 1].id;
		else submit();
	}

	function prevStep() {
		const idx = currentStepIdx;
		if (idx > 0) wizardStep = steps[idx - 1].id;
	}

	// ── Submit ─────────────────────────────────────────────
	function submit() {
		const network = supportedNetworks.find(n => n.chain_id == chainId);
		if (!network) { addFeedback({ message: 'Please select a network', type: 'error' }); return; }
		if (!useExistingToken && (!name.trim() || !symbol.trim())) { addFeedback({ message: 'Token name and symbol are required', type: 'error' }); return; }
		if (!useExistingToken && (!totalSupply || Number(totalSupply) <= 0)) { addFeedback({ message: 'Total supply must be greater than 0', type: 'error' }); return; }
		const validWallets = taxWallets.filter(w => w.address.trim() && /^0x[a-fA-F0-9]{40}$/.test(w.address.trim()));
		const totalTokensForListing = listingPairs.reduce((sum, p) => {
			if (totalLiquidityUsd <= 0 || tokensForPool <= 0) return sum;
			return sum + tokensForPool * (pairUsd(p) / totalLiquidityUsd);
		}, 0);

		updateTokenInfo({
			name, symbol, totalSupply, decimals, isMintable, isTaxable, isPartner, network,
			existingTokenAddress: isRealExistingToken ? existingTokenAddress : undefined,
			listing: {
				enabled: listingEnabled, baseCoin: listingPairs[0]?.base ?? 'native',
				mode: 'price', tokenAmount: String(totalTokensForListing),
				baseAmount: listingPairs[0]?.amount ?? '', pricePerToken: listingPricePerToken,
				listBaseAmount: listingPairs[0]?.amount ?? '',
				pairs: listingPairs.filter(p => Number(p.amount) > 0),
			},
			launch: {
				enabled: launchEnabled, tokensForLaunchPct: launchTokensPct,
				curveType: launchCurveType, softCap: launchSoftCap, hardCap: launchHardCap,
				durationDays: launchDurationDays, maxBuyBps: String(Math.round(parseFloat(launchMaxBuyPct || '0') * 100)),
				creatorAllocationBps: String(Math.round(parseFloat(launchCreatorAllocPct || '0') * 100)), vestingDays: launchVestingDays,
				launchPaymentToken: '',
			},
			protection: { maxWalletPct: protectionEnabled ? maxWalletPct : '0', maxTransactionPct: protectionEnabled ? maxTransactionPct : '0', cooldownSeconds: protectionEnabled ? cooldownSeconds : '0' },
			tax: { buyTaxPct, sellTaxPct, transferTaxPct, wallets: validWallets },
			metadata: (tokenLogoUrl || tokenDescription || tokenWebsite || tokenTwitter || tokenTelegram) ? {
				logoUrl: tokenLogoUrl, description: tokenDescription,
				website: tokenWebsite, twitter: tokenTwitter, telegram: tokenTelegram,
			} : undefined,
		});
	}

	// ── Preview callback ───────────────────────────────────
	$effect(() => {
		onPreviewChange?.({
			name, symbol, totalSupply, decimals, isMintable, isTaxable, isPartner,
			networkName: selectedNetwork?.name ?? '', launchEnabled, launchTokensPct, launchCurveType,
			launchSoftCap, launchHardCap, protectionEnabled, maxWalletPct, maxTransactionPct,
			buyTaxPct, sellTaxPct, transferTaxPct, wizardStep,
			logoUrl: tokenLogoUrl, description: tokenDescription,
			website: tokenWebsite, twitter: tokenTwitter, telegram: tokenTelegram,
		});
	});

	// Auto-submit
	let didAutoSubmit = false;
	$effect(() => {
		if (autoSubmit && !didAutoSubmit && name && symbol && totalSupply && chainId) {
			didAutoSubmit = true; submit();
		}
	});

	const CURVE_LABELS = ['Linear', 'Square Root', 'Quadratic', 'Exponential'];
</script>

<div class="wz">
	<!-- Step indicator -->
	<div class="wz-steps">
		{#each steps as step, i}
			<button class="wz-step" class:wz-step-done={i < currentStepIdx} class:wz-step-active={step.id === wizardStep} tabindex="-1" onclick={() => { if (i <= currentStepIdx) wizardStep = step.id; }}>
				<span class="wz-step-num">{i < currentStepIdx ? '✓' : i + 1}</span>
				<span class="wz-step-label">{step.label}</span>
			</button>
			{#if i < steps.length - 1}
				<div class="wz-step-line" class:wz-step-line-done={i < currentStepIdx}></div>
			{/if}
		{/each}
	</div>

	<!-- Step content -->
	<div class="wz-content">
		{#if wizardStep === 'basics'}
			<BasicInfo bind:name bind:symbol bind:totalSupply bind:decimals bind:chainId bind:useExistingToken bind:existingTokenAddress bind:tokenLogoUrl bind:tokenDescription bind:tokenWebsite bind:tokenTwitter bind:tokenTelegram {supportedNetworks} {getNetworkProviders} isCreateOnly={!launchEnabled && !listingEnabled} />

		{:else if wizardStep === 'features'}
			<Features bind:isMintable bind:isTaxable bind:isPartner bind:launchEnabled bind:listingEnabled />

		{:else if wizardStep === 'tax'}
			<TaxStep bind:buyTaxPct bind:sellTaxPct bind:transferTaxPct bind:taxWallets bind:protectionEnabled bind:maxWalletPct bind:maxTransactionPct bind:cooldownSeconds />

		{:else if wizardStep === 'launch'}
			<div class="wz-section">
				<h2 class="wz-title">Bonding Curve Launch</h2>
				<div class="wz-field">
					<label class="wz-label">Tokens for launch ({launchTokensPct}%)</label>
					<input type="range" class="wz-slider" min="20" max="90" step="5" bind:value={launchTokensPct} />
				</div>
				<div class="wz-field">
					<label class="wz-label">Curve type</label>
					<div class="wz-radio-row">
						{#each CURVE_LABELS as label, i}
							<button class="wz-radio" class:wz-radio-active={launchCurveType === i} tabindex="-1" onclick={() => launchCurveType = i}>{label}</button>
						{/each}
					</div>
				</div>
				<div class="wz-row">
					<div class="wz-field"><label class="wz-label">Soft cap ($)</label><input class="input-field" type="text" bind:value={launchSoftCap} /></div>
					<div class="wz-field"><label class="wz-label">Hard cap ($)</label><input class="input-field" type="text" bind:value={launchHardCap} /></div>
				</div>
				<div class="wz-row">
					<div class="wz-field">
						<label class="wz-label">Duration</label>
						<select class="input-field" bind:value={launchDurationDays}>
							<option value="7">7 days</option>
							<option value="14">14 days</option>
							<option value="30">30 days</option>
							<option value="60">60 days</option>
							<option value="90">90 days</option>
						</select>
					</div>
					<div class="wz-field">
						<label class="wz-label">Max buy per wallet</label>
						<select class="input-field" bind:value={launchMaxBuyPct}>
							<option value="0.5">0.5%</option>
							<option value="1">1%</option>
							<option value="2">2%</option>
							<option value="3">3%</option>
							<option value="5">5%</option>
						</select>
						<span class="wz-field-hint">Max % of hard cap one wallet can buy</span>
					</div>
				</div>
				<div class="wz-row">
					<div class="wz-field">
						<label class="wz-label">Creator allocation</label>
						<select class="input-field" bind:value={launchCreatorAllocPct}>
							<option value="0">None</option>
							<option value="1">1%</option>
							<option value="2">2%</option>
							<option value="3">3%</option>
							<option value="5">5%</option>
							<option value="10">10%</option>
						</select>
						<span class="wz-field-hint">Tokens reserved for you (vested)</span>
					</div>
					<div class="wz-field">
						<label class="wz-label">Vesting period</label>
						<select class="input-field" bind:value={launchVestingDays}>
							<option value="0">No vesting</option>
							<option value="7">7 days</option>
							<option value="14">14 days</option>
							<option value="30">30 days</option>
							<option value="60">60 days</option>
							<option value="90">90 days</option>
						</select>
						<span class="wz-field-hint">Lock period for creator tokens</span>
					</div>
				</div>

				<!-- Anti-whale protection -->
				<div class="wz-toggle-card" class:wz-toggle-on={protectionEnabled}>
					<label class="wz-toggle-row">
						<div>
							<span class="wz-toggle-title">Anti-Whale Protection</span>
							<span class="wz-toggle-desc">Limit max wallet & transaction size</span>
						</div>
						<div class="wz-switch" class:wz-switch-on={protectionEnabled}>
							<div class="wz-switch-thumb"></div>
						</div>
						<input type="checkbox" bind:checked={protectionEnabled} class="sr-only" />
					</label>
					{#if protectionEnabled}
						<div class="wz-toggle-body">
							<div class="wz-row">
								<div class="wz-field"><label class="wz-label">Max wallet (%)</label><input class="input-field" type="text" bind:value={maxWalletPct} placeholder="2" /></div>
								<div class="wz-field"><label class="wz-label">Max transaction (%)</label><input class="input-field" type="text" bind:value={maxTransactionPct} placeholder="1" /></div>
							</div>
							<div class="wz-field"><label class="wz-label">Cooldown (seconds)</label><input class="input-field" type="text" bind:value={cooldownSeconds} placeholder="0" /></div>
						</div>
					{/if}
				</div>

				{#if typeof BondingCurveChart !== 'undefined'}
					<BondingCurveChart curveType={launchCurveType} softCap={Number(launchSoftCap)} hardCap={Number(launchHardCap)} />
				{/if}
			</div>

		{:else if wizardStep === 'listing'}
			<div class="wz-section">
				<h2 class="wz-title">DEX Listing</h2>
				<p class="wz-hint">Add liquidity and your token is instantly tradable.</p>
				<ListingStep bind:symbol bind:totalSupply bind:poolPct={listingPoolPct} bind:pairs={listingPairs} bind:pricePerToken={listingPricePerToken} {nativeCoin} {bnbPriceUsd} />
			</div>

		{:else if wizardStep === 'review'}
			<div class="wz-section">
				<h2 class="wz-title">Review</h2>
				<p class="wz-hint">Confirm your settings before deploying.</p>
				<Review {name} {symbol} {totalSupply} {decimals} network={selectedNetwork} {isMintable} {isTaxable} {isPartner} {launchEnabled} {listingEnabled} {buyTaxPct} {sellTaxPct} {transferTaxPct} {taxWallets} {protectionEnabled} {maxWalletPct} {maxTransactionPct} {cooldownSeconds} {launchTokensPct} {launchCurveType} {launchSoftCap} {launchHardCap} {launchDurationDays} launchMaxBuyPct={launchMaxBuyPct} launchCreatorAllocPct={launchCreatorAllocPct} {launchVestingDays} {listingPoolPct} {listingPairs} {autoPrice} {totalLiquidityUsd} {nativeCoin} {useExistingToken} {existingTokenAddress} />
			</div>
		{/if}
	</div>

	<!-- Navigation -->
	<div class="wz-nav">
		{#if currentStepIdx > 0}
			<button class="wz-btn wz-btn-back" onclick={prevStep}>Back</button>
		{:else}
			<div></div>
		{/if}
		<button class="wz-btn wz-btn-next" onclick={nextStep}>
			{wizardStep === 'review' ? (launchEnabled ? 'Deploy & Launch' : listingEnabled ? 'Deploy & List' : 'Deploy Token') : 'Next →'}
		</button>
	</div>
</div>


<style>
	.wz { max-width: 640px; margin: 0 auto; }

	/* Steps indicator */
	.wz-steps { display: flex; align-items: center; gap: 0; margin-bottom: 24px; padding: 0 8px; }
	.wz-step { display: flex; flex-direction: column; align-items: center; gap: 4px; background: none; border: none; cursor: pointer; padding: 0; }
	.wz-step-num { width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; font-family: 'Space Mono', monospace; border: 2px solid rgba(255,255,255,0.1); color: #64748b; background: transparent; transition: all 200ms; }
	.wz-step-active .wz-step-num { border-color: #00d2ff; color: #00d2ff; background: rgba(0,210,255,0.1); }
	.wz-step-done .wz-step-num { border-color: #10b981; color: #10b981; background: rgba(16,185,129,0.1); }
	.wz-step-label { font-size: 9px; color: #64748b; font-family: 'Space Mono', monospace; text-transform: uppercase; letter-spacing: 0.05em; white-space: nowrap; }
	.wz-step-active .wz-step-label { color: #00d2ff; }
	.wz-step-done .wz-step-label { color: #10b981; }
	.wz-step-line { flex: 1; height: 2px; background: rgba(255,255,255,0.06); min-width: 20px; margin: 0 4px; margin-bottom: 16px; }
	.wz-step-line-done { background: #10b981; }

	/* Content */
	.wz-content { background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06); border-radius: 16px; padding: 24px; margin-bottom: 16px; }
	.wz-section {}
	.wz-title { font-family: 'Syne', sans-serif; font-size: 20px; font-weight: 800; color: #fff; margin: 0 0 4px; }
	.wz-hint { font-size: 12px; color: #64748b; font-family: 'Space Mono', monospace; margin: 0 0 16px; }

	.wz-field { margin-bottom: 14px; }
	.wz-label { display: block; font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; font-family: 'Space Mono', monospace; margin-bottom: 6px; }
	.wz-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
	.wz-slider { width: 100%; -webkit-appearance: none; height: 6px; background: rgba(255,255,255,0.08); border-radius: 3px; outline: none; }
	.wz-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 18px; height: 18px; border-radius: 50%; background: #00d2ff; cursor: pointer; border: 2px solid #0a0a12; }
	.wz-radio-row { display: flex; gap: 6px; flex-wrap: wrap; }
	.wz-radio { padding: 6px 14px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.08); background: transparent; color: #64748b; font-family: 'Space Mono', monospace; font-size: 11px; cursor: pointer; transition: all 150ms; }
	.wz-radio:hover { border-color: rgba(0,210,255,0.3); color: #e2e8f0; }
	.wz-radio-active { border-color: rgba(0,210,255,0.4); color: #00d2ff; background: rgba(0,210,255,0.08); }

	.wz-field-hint { display: block; font-size: 10px; color: #64748b; font-family: 'Space Mono', monospace; margin-top: 3px; }
	.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); }

	/* Toggle card */
	.wz-toggle-card { border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; padding: 0; margin-top: 14px; overflow: hidden; transition: border-color 200ms; }
	.wz-toggle-on { border-color: rgba(245,158,11,0.25); }
	.wz-toggle-row { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; cursor: pointer; gap: 12px; }
	.wz-toggle-title { display: block; font-size: 13px; font-weight: 700; color: #e2e8f0; font-family: 'Syne', sans-serif; }
	.wz-toggle-desc { display: block; font-size: 10px; color: #64748b; font-family: 'Space Mono', monospace; margin-top: 1px; }
	.wz-toggle-body { padding: 0 14px 14px; }
	.wz-switch { width: 40px; height: 22px; border-radius: 11px; background: rgba(255,255,255,0.1); position: relative; flex-shrink: 0; transition: background 200ms; }
	.wz-switch-on { background: #f59e0b; }
	.wz-switch-thumb { width: 16px; height: 16px; border-radius: 50%; background: white; position: absolute; top: 3px; left: 3px; transition: transform 200ms; }
	.wz-switch-on .wz-switch-thumb { transform: translateX(18px); }

	/* Nav */
	.wz-nav { display: flex; justify-content: space-between; }
	.wz-btn { padding: 12px 28px; border-radius: 12px; border: none; cursor: pointer; font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 700; transition: all 200ms; }
	.wz-btn-back { background: rgba(255,255,255,0.05); color: #64748b; }
	.wz-btn-back:hover { background: rgba(255,255,255,0.08); color: #e2e8f0; }
	.wz-btn-next { background: linear-gradient(135deg, #00d2ff, #3a7bd5); color: white; }
	.wz-btn-next:hover { transform: translateY(-1px); box-shadow: 0 6px 28px rgba(0,210,255,0.3); }

	@media (max-width: 500px) {
		.wz-content { padding: 16px; }
		.wz-row { grid-template-columns: 1fr; }
		.wz-step-label { font-size: 8px; }
	}
</style>
