<script lang="ts" module>
	// Re-export types for parent compatibility
	export type ListingPairConfig = { base: 'native' | 'usdt' | 'usdc'; amount: string; tokenAmount?: string };
	export type ListingConfig = {
		enabled: boolean; baseCoin: 'native' | 'usdt' | 'usdc';
		mode: 'manual' | 'price'; tokenAmount: string; baseAmount: string;
		pricePerToken: string; listBaseAmount: string; pairs: ListingPairConfig[];
		// Anti-snipe window in seconds between deploy and first public swap.
		// Cap 24h. Default 60s closes the MEV front-run window on the seed tx.
		tradingDelay: string;
		// Burn LP tokens to 0xdead — makes liquidity permanent (cannot rug).
		burnLp: boolean;
	};
	export type LaunchConfig = {
		enabled: boolean; tokensForLaunchPct: number; curveType: number;
		softCap: string; hardCap: string; durationDays: string;
		maxBuyBps: string; creatorAllocationBps: string; vestingDays: string;
		// Anti-snipe window after curve graduation, in seconds. Cap 24h.
		// Default 1 hour gives buyers time to react before DEX trading opens.
		lockDurationAfterListing: string;
		// Anti-dust floor per buy in whole-USDT units (e.g. "1" = 1 USDT).
		// The frontend converts this to native USDT decimals at call time.
		minBuyUsdt: string;
		// Unix timestamp in seconds when launch opens. "0" = immediate.
		startTimestamp: string;
	};
	export type ProtectionConfig = { maxWalletPct: string; maxTransactionPct: string; cooldownSeconds: string; blacklistWindowSeconds: string };
	export type TaxConfig = { buyTaxPct: string; sellTaxPct: string; transferTaxPct: string; wallets: { address: string; sharePct: string }[] };
	export type TokenMetadata = { logoUrl: string; description: string; website: string; twitter: string; telegram: string };
	export type TokenFormData = {
		name: string; symbol: string; totalSupply: string; decimals: number;
		isMintable: boolean; isTaxable: boolean; isPartner: boolean;
		network: any; existingTokenAddress?: string;
		// Base token addresses passed to CreateTokenParams.bases at tx time.
		// Pre-populated from network.default_bases; user can add more in the
		// wizard. Pre-registering these as pools on the token closes the
		// grifter vector where someone opens a WBNB pair (or similar) with
		// a malicious initial price before the creator's real listing.
		bases: string[];
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
	import { ROUTER_ABI_LITE } from '$lib/commonABIs';
	import type { SupportedNetwork } from '$lib/structure';
	import { BasicInfo, Features, TaxConfig as TaxStep, ProtectionStep, ListingConfig as ListingStep, Review } from './steps';
	import BondingCurveChart from '$lib/BondingCurveChart.svelte';

	type WizardStep = 'mode' | 'basics' | 'features' | 'tax' | 'protection' | 'launch' | 'listing' | 'review';
	let wizardStep = $state<WizardStep>('basics');

	// ── Props ──────────────────────────────────────────────
	let {
		supportedNetworks, addFeedback, updateTokenInfo, onPreviewChange, initialData, autoSubmit, initialMode, onModeChange, resetSignal
	}: {
		supportedNetworks: SupportedNetwork[]; addFeedback: (f: { message: string; type: string }) => void;
		updateTokenInfo: (info: TokenFormData) => void; onPreviewChange?: (state: PreviewState) => void;
		initialData?: Partial<TokenFormData>; autoSubmit?: boolean;
		initialMode?: 'token' | 'both' | 'launch' | 'list';
		onModeChange?: (mode: 'token' | 'launch' | 'both' | 'list' | null) => void;
		resetSignal?: number;
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

	// Deploy mode — drives launchEnabled/listingEnabled
	let deployMode = $state<'token' | 'launch' | 'both' | 'list' | null>(initialMode ?? null);

	// Sync launch/listing toggles from deploy mode and notify parent
	$effect(() => {
		if (deployMode === 'token') { launchEnabled = false; listingEnabled = false; }
		else if (deployMode === 'both' || deployMode === 'launch') { launchEnabled = true; listingEnabled = false; }
		else if (deployMode === 'list') { launchEnabled = false; listingEnabled = true; }
		onModeChange?.(deployMode);
	});

	// React to parent reset signal (e.g. nav click)
	let _lastResetSignal = resetSignal ?? 0;
	$effect(() => {
		const current = resetSignal ?? 0;
		if (current !== _lastResetSignal) {
			_lastResetSignal = current;
			deployMode = null;
			wizardStep = 'mode';
			clearDraft();
		}
	});


	let buyTaxPct = $state('');
	let sellTaxPct = $state('');
	let transferTaxPct = $state('');
	let taxWallets = $state<{ address: string; sharePct: string }[]>([{ address: '', sharePct: '100' }]);

	let protectionEnabled = $state(false);
	let maxWalletPct = $state('2');
	let maxTransactionPct = $state('1');
	let cooldownSeconds = $state('0');
	let blacklistWindowSeconds = $state('0');
	let launchProtectionEnabled = $state(true);

	let launchTokensPct = $state(40);
	let supplyNum = $derived(parseFloat((totalSupply || '').replace(/,/g, '')) || 0);
	let launchTokenAmount = $derived(supplyNum > 0 ? (supplyNum * launchTokensPct) / 100 : 0);
	// Max buy per wallet in USDT = hardCap * maxBuyPct / 100. If the creator
	// sets a min buy higher than this, no one can actually buy (first buy
	// would exceed the wallet cap immediately). Surface the warning live.
	let launchHardCapNum = $derived(parseFloat(launchHardCap) || 0);
	let launchMinBuyNum = $derived(parseFloat(launchMinBuyUsdt) || 0);
	let launchMaxBuyUsdt = $derived(
		launchHardCapNum > 0 && launchProtectionEnabled
			? (launchHardCapNum * parseFloat(launchMaxBuyPct || '0')) / 100
			: 0
	);
	let minBuyExceedsMaxBuy = $derived(
		launchMaxBuyUsdt > 0 && launchMinBuyNum > 0 && launchMinBuyNum > launchMaxBuyUsdt
	);
	function formatTokenAmount(n: number): string {
		if (n === 0) return '0';
		if (n >= 1e9) return (n / 1e9).toFixed(n % 1e9 === 0 ? 0 : 2) + 'B';
		if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 2) + 'M';
		if (n >= 1e3) return (n / 1e3).toFixed(n % 1e3 === 0 ? 0 : 1) + 'K';
		return n.toLocaleString();
	}
	let launchCurveType = $state(0);
	let showCurveModal = $state(false);
	let launchSoftCap = $state('');
	let launchHardCap = $state('');
	let launchDurationDays = $state('30');
	let launchMaxBuyPct = $state('2');
	let launchCreatorAllocPct = $state('0');
	let launchVestingDays = $state('0');
	// Anti-snipe window after graduation — creator-configurable, default 1 hour.
	// Contract caps at 24h. UI displays as minutes.
	let launchLockDurationMinutes = $state('60');
	// Anti-dust floor per buy in whole USDT. Default 1 USDT.
	let launchMinBuyUsdt = $state('1');
	// Scheduled start — datetime-local string or "" for immediate.
	// Converted to unix seconds at submit time.
	let launchStartDateLocal = $state('');

	let listingPoolPct = $state(80);
	type ListingPair = { base: 'native' | 'usdt' | 'usdc'; amount: string };
	let listingPairs = $state<ListingPair[]>([{ base: 'native', amount: '' }]);
	let listingPricePerToken = $state('');
	// Anti-snipe window for direct listings — creator-configurable, default 60s.
	// Contract caps at 24h. UI displays as seconds.
	let listingTradingDelaySeconds = $state('60');
	// Burn LP tokens — sends LP to 0xdead, making liquidity permanent.
	// Strongly recommended. Without this, creator can remove liquidity (rug).
	let burnLp = $state(false);

	// Base tokens pre-registered as pools on the new token. The wizard seeds
	// these from `network.default_bases` (DB-driven, per-chain). Each entry is
	// `{ address, symbol, name }`. Pre-selected bases = every default + every
	// custom the user added. The resulting list becomes `CreateTokenParams.bases`
	// at tx time so the token's pool-lock gate blocks grifter-opened pairs
	// (malicious initial price) before the creator's real listing lands.
	type BaseOption = { address: string; symbol: string; name?: string; custom?: boolean };
	let baseSelection = $state<Record<string, boolean>>({});
	let customBases = $state<BaseOption[]>([]);
	let newBaseAddress = $state('');
	let baseLookupBusy = $state(false);
	let baseLookupError = $state<string | null>(null);

	/**
	 * Resolve a token address to {symbol, name, decimals}. Tries GeckoTerminal
	 * first (faster + has display name + curated data), falls back to an
	 * on-chain ERC20 read so unlisted tokens still work.
	 */
	async function lookupBaseInfo(
		net: SupportedNetwork,
		address: string
	): Promise<{ symbol: string; name: string; decimals: number } | null> {
		// Gecko's network slug = the chain's lowercase symbol (bsc, eth, base, …).
		// Set on the SupportedNetwork row in the DB.
		const slug = net.symbol?.toLowerCase();
		if (slug) {
			try {
				const res = await fetch(
					`https://api.geckoterminal.com/api/v2/networks/${slug}/tokens/${address}/info`,
					{ headers: { Accept: 'application/json;version=20230203' } }
				);
				if (res.ok) {
					const json = await res.json();
					const a = json?.data?.attributes;
					if (a?.symbol) {
						return {
							symbol: String(a.symbol),
							name: String(a.name || a.symbol),
							decimals: Number(a.decimals ?? 18),
						};
					}
				}
			} catch {}
		}
		// On-chain fallback. Use the network's RPC provider directly.
		try {
			const provider = getNetworkProviders?.()?.get(net.chain_id)
				?? new ethers.JsonRpcProvider(net.rpc);
			const c = new ethers.Contract(
				address,
				[
					'function name() view returns (string)',
					'function symbol() view returns (string)',
					'function decimals() view returns (uint8)',
				],
				provider
			);
			const [name, symbol, decimals] = await Promise.all([
				c.name().catch(() => ''),
				c.symbol().catch(() => ''),
				c.decimals().catch(() => 18),
			]);
			if (!symbol) return null;
			return { symbol: String(symbol), name: String(name || symbol), decimals: Number(decimals) };
		} catch {
			return null;
		}
	}

	// Handle preset loaded from BasicInfo's contract loader — resets all token features
	function handlePresetLoaded(data: { isTaxable: boolean; buyTaxPct: string; sellTaxPct: string; transferTaxPct: string }) {
		isTaxable = data.isTaxable;
		buyTaxPct = data.buyTaxPct;
		sellTaxPct = data.sellTaxPct;
		transferTaxPct = data.transferTaxPct;
		if (!data.isTaxable) {
			taxWallets = [{ address: '', sharePct: '100' }];
		}
		// Reset other features — user can re-enable manually
		isMintable = false;
		isPartner = false;
		protectionEnabled = false;
		maxWalletPct = '2';
		maxTransactionPct = '1';
		cooldownSeconds = '0';
		blacklistWindowSeconds = '0';
	}

	// ── Derived ────────────────────────────────────────────
	let selectedNetwork = $derived(supportedNetworks.find(n => n.chain_id == chainId));
	let nativeCoin = $derived(selectedNetwork?.native_coin || 'BNB');

	// Merge chain defaults + user customs into the displayed base options.
	// Defaults always render first; customs follow in insertion order.
	let baseOptions: BaseOption[] = $derived.by(() => {
		const defs: BaseOption[] = (selectedNetwork?.default_bases ?? [])
			.map(b => ({ address: b.address, symbol: b.symbol, name: b.name }));
		return [...defs, ...customBases];
	});

	// Auto-select all default bases whenever the chain changes. Merges
	// rather than replacing so a restored draft (sessionStorage) keeps its
	// per-base toggle state. New defaults pre-select to true; existing
	// entries — including the user's "I unchecked this default" decisions
	// — are preserved as-is.
	let _lastBaseChainId: number | undefined;
	$effect(() => {
		if (!selectedNetwork) return;
		if (_lastBaseChainId === selectedNetwork.chain_id) return;
		_lastBaseChainId = selectedNetwork.chain_id;
		const next: Record<string, boolean> = { ...baseSelection };
		for (const b of selectedNetwork.default_bases ?? []) {
			const k = b.address.toLowerCase();
			if (!(k in next)) next[k] = true;
		}
		baseSelection = next;
	});

	function toggleBase(address: string) {
		const k = address.toLowerCase();
		baseSelection = { ...baseSelection, [k]: !baseSelection[k] };
	}

	async function addCustomBase() {
		baseLookupError = null;
		const addr = newBaseAddress.trim();
		if (!ethers.isAddress(addr)) {
			baseLookupError = 'Invalid address';
			return;
		}
		const k = addr.toLowerCase();
		if (baseOptions.some(b => b.address.toLowerCase() === k)) {
			baseLookupError = 'Already in the list';
			return;
		}
		if (!selectedNetwork) {
			baseLookupError = 'Pick a network first';
			return;
		}
		baseLookupBusy = true;
		try {
			const info = await lookupBaseInfo(selectedNetwork, addr);
			if (!info) {
				baseLookupError = 'Could not resolve token. Check the address.';
				return;
			}
			customBases = [...customBases, { address: addr, symbol: info.symbol, name: info.name, custom: true }];
			baseSelection = { ...baseSelection, [k]: true };
			newBaseAddress = '';
		} finally {
			baseLookupBusy = false;
		}
	}

	function removeCustomBase(address: string) {
		const k = address.toLowerCase();
		customBases = customBases.filter(c => c.address.toLowerCase() !== k);
		const { [k]: _, ...rest } = baseSelection;
		baseSelection = rest;
	}

	let selectedBaseAddresses: string[] = $derived(
		baseOptions
			.filter(b => baseSelection[b.address.toLowerCase()])
			.map(b => b.address)
	);
	let getNetworkProviders: () => Map<number, ethers.JsonRpcProvider> = getContext('networkProviders');

	// For the "launch existing token" flow, BasicInfo isn't rendered (it's
	// replaced by a slim address-only form). We still need name/symbol/
	// decimals/totalSupply populated so the review modal and parseUnits
	// calls work — fetch them here whenever the user pastes a valid address.
	let _existingFetchTimeout: ReturnType<typeof setTimeout> | null = null;
	$effect(() => {
		if (_existingFetchTimeout) clearTimeout(_existingFetchTimeout);
		const addr = existingTokenAddress;
		const net = selectedNetwork;
		if (!useExistingToken || !addr || !/^0x[a-fA-F0-9]{40}$/.test(addr) || !net) return;
		_existingFetchTimeout = setTimeout(async () => {
			try {
				const provider = getNetworkProviders?.()?.get(net.chain_id);
				if (!provider) return;
				const token = new ethers.Contract(addr, [
					'function name() view returns (string)',
					'function symbol() view returns (string)',
					'function decimals() view returns (uint8)',
					'function totalSupply() view returns (uint256)',
				], provider);
				const [n, s, d, supply] = await Promise.all([
					token.name().catch(() => ''),
					token.symbol().catch(() => ''),
					token.decimals().catch(() => 18),
					token.totalSupply().catch(() => 0n),
				]);
				if (n) name = n;
				if (s) symbol = s;
				decimals = Number(d);
				totalSupply = ethers.formatUnits(supply, Number(d));
			} catch {}
		}, 500);
	});

	// BNB price for listing preview
	let bnbPriceUsd = $state(0);
	$effect(() => {
		if (!selectedNetwork?.dex_router || !selectedNetwork?.usdt_address) return;
		const provider = getNetworkProviders?.()?.get(selectedNetwork.chain_id);
		if (!provider) return;
		const router = new ethers.Contract(selectedNetwork.dex_router, ROUTER_ABI_LITE, provider);
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

	// Only set useExistingToken if explicitly launching an existing token (URL param)
	if (deployMode === 'launch' && initialData?.existingTokenAddress) { useExistingToken = true; }

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
			// Convert seconds back to minutes for the UI.
			if (initialData.launch.lockDurationAfterListing) {
				launchLockDurationMinutes = String(Math.round(parseFloat(initialData.launch.lockDurationAfterListing) / 60));
			}
			if (initialData.launch.minBuyUsdt) launchMinBuyUsdt = initialData.launch.minBuyUsdt;
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
			if (initialData.listing.tradingDelay) listingTradingDelaySeconds = initialData.listing.tradingDelay;
		}
	}

	// Restore custom base additions from initialData. Defaults are
	// re-auto-selected on network change by the chain-change effect above;
	// only user-added customs need explicit restore. Done in an effect so
	// it can wait for `selectedNetwork` to become available, and so reads
	// of $state values stay reactive.
	let _customBasesRestored = false;
	$effect(() => {
		if (_customBasesRestored) return;
		if (!selectedNetwork) return;
		const seed = (initialData as any)?.bases as string[] | undefined;
		if (!seed?.length) { _customBasesRestored = true; return; }
		const defaultSet = new Set(
			(selectedNetwork.default_bases ?? []).map((b: any) => b.address.toLowerCase())
		);
		for (const addr of seed) {
			if (!ethers.isAddress(addr)) continue;
			if (defaultSet.has(addr.toLowerCase())) continue;
			customBases = [...customBases, { address: addr, symbol: 'CUSTOM', custom: true }];
			baseSelection = { ...baseSelection, [addr.toLowerCase()]: true };
		}
		_customBasesRestored = true;
	});

	// ── Persist form state across OAuth redirects ──────────
	const FORM_STORAGE_KEY = 'tk_create_form_draft';

	function getFormSnapshot() {
		return {
			deployMode,
			name, symbol, totalSupply, decimals, chainId, useExistingToken, existingTokenAddress,
			tokenLogoUrl, tokenDescription, tokenWebsite, tokenTwitter, tokenTelegram,
			isMintable, isTaxable, isPartner, launchEnabled, listingEnabled,
			buyTaxPct, sellTaxPct, transferTaxPct, taxWallets,
			protectionEnabled, maxWalletPct, maxTransactionPct, cooldownSeconds,
			launchProtectionEnabled, launchLockDurationMinutes, launchMinBuyUsdt,
			launchStartDateLocal,
			launchTokensPct, launchCurveType, launchSoftCap, launchHardCap,
			launchDurationDays, launchMaxBuyPct, launchCreatorAllocPct, launchVestingDays,
			listingPoolPct, listingPairs, listingPricePerToken, burnLp, wizardStep,
			// Pool-base picker — both the toggle map AND the user-added customs
			// (which carry resolved name/symbol so we don't re-hit gecko on reload)
			customBases, baseSelection,
		};
	}

	function restoreFormSnapshot(s: any) {
		if (s.deployMode) deployMode = s.deployMode;
		if (s.name) name = s.name;
		if (s.symbol) symbol = s.symbol;
		if (s.totalSupply) totalSupply = s.totalSupply;
		if (s.decimals != null) decimals = s.decimals;
		if (s.chainId != null) chainId = s.chainId;
		if (s.useExistingToken) useExistingToken = s.useExistingToken;
		if (s.existingTokenAddress) existingTokenAddress = s.existingTokenAddress;
		if (s.tokenLogoUrl) tokenLogoUrl = s.tokenLogoUrl;
		if (s.tokenDescription) tokenDescription = s.tokenDescription;
		if (s.tokenWebsite) tokenWebsite = s.tokenWebsite;
		if (s.tokenTwitter) tokenTwitter = s.tokenTwitter;
		if (s.tokenTelegram) tokenTelegram = s.tokenTelegram;
		if (s.isMintable != null) isMintable = s.isMintable;
		if (s.isTaxable != null) isTaxable = s.isTaxable;
		if (s.isPartner != null) isPartner = s.isPartner;
		if (s.launchEnabled != null) launchEnabled = s.launchEnabled;
		if (s.listingEnabled != null) listingEnabled = s.listingEnabled;
		if (s.buyTaxPct) buyTaxPct = s.buyTaxPct;
		if (s.sellTaxPct) sellTaxPct = s.sellTaxPct;
		if (s.transferTaxPct) transferTaxPct = s.transferTaxPct;
		if (s.taxWallets?.length) taxWallets = s.taxWallets;
		if (s.protectionEnabled != null) protectionEnabled = s.protectionEnabled;
		if (s.maxWalletPct) maxWalletPct = s.maxWalletPct;
		if (s.maxTransactionPct) maxTransactionPct = s.maxTransactionPct;
		if (s.cooldownSeconds) cooldownSeconds = s.cooldownSeconds;
		if (s.launchProtectionEnabled != null) launchProtectionEnabled = s.launchProtectionEnabled;
		if (s.launchLockDurationMinutes) launchLockDurationMinutes = s.launchLockDurationMinutes;
		if (s.launchMinBuyUsdt) launchMinBuyUsdt = s.launchMinBuyUsdt;
		if (s.launchStartDateLocal) launchStartDateLocal = s.launchStartDateLocal;
		if (s.launchTokensPct != null) launchTokensPct = s.launchTokensPct;
		if (s.launchCurveType != null) launchCurveType = s.launchCurveType;
		if (s.launchSoftCap) launchSoftCap = s.launchSoftCap;
		if (s.launchHardCap) launchHardCap = s.launchHardCap;
		if (s.launchDurationDays) launchDurationDays = s.launchDurationDays;
		if (s.launchMaxBuyPct) launchMaxBuyPct = s.launchMaxBuyPct;
		if (s.launchCreatorAllocPct) launchCreatorAllocPct = s.launchCreatorAllocPct;
		if (s.launchVestingDays) launchVestingDays = s.launchVestingDays;
		if (s.listingPoolPct != null) listingPoolPct = s.listingPoolPct;
		if (s.listingPairs?.length) listingPairs = s.listingPairs;
		if (s.listingPricePerToken) listingPricePerToken = s.listingPricePerToken;
		if (s.burnLp != null) burnLp = s.burnLp;
		if (s.wizardStep) wizardStep = s.wizardStep;
		// Pool-base picker — restore customs first so the chain-change effect
		// can preserve their selection state. baseSelection holds the toggle
		// for both default and custom bases as a single { addrLower → bool }.
		if (Array.isArray(s.customBases)) customBases = s.customBases;
		if (s.baseSelection && typeof s.baseSelection === 'object') baseSelection = s.baseSelection;
	}

	// Restore draft if returning from OAuth redirect or page reload
	if (typeof sessionStorage !== 'undefined') {
		const saved = sessionStorage.getItem(FORM_STORAGE_KEY);
		if (saved) {
			try {
				const parsed = JSON.parse(saved);
				// Only restore if there's actual user input (not just defaults)
				if (parsed.name || parsed.symbol || parsed.totalSupply || parsed.existingTokenAddress) {
					restoreFormSnapshot(parsed);
					// Reconstruct pending logo file from data URL
					if (parsed.tokenLogoUrl && parsed.tokenLogoUrl.startsWith('data:')) {
						try {
							const [header, b64] = parsed.tokenLogoUrl.split(',');
							const mime = header.match(/:(.*?);/)?.[1] || 'image/png';
							const binary = atob(b64);
							const bytes = new Uint8Array(binary.length);
							for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
							(window as any).__pendingLogoFile = new File([bytes], `logo.${mime.split('/')[1]}`, { type: mime });
						} catch {}
					}
				}
			} catch {}
		}
	}

	// Save form state whenever it changes (debounced)
	let _saveTimer: ReturnType<typeof setTimeout>;
	$effect(() => {
		const snapshot = getFormSnapshot();
		clearTimeout(_saveTimer);
		_saveTimer = setTimeout(() => {
			try { sessionStorage.setItem(FORM_STORAGE_KEY, JSON.stringify(snapshot)); } catch {}
		}, 500);
	});

	/** Clear saved draft */
	function clearDraft() {
		try { sessionStorage.removeItem(FORM_STORAGE_KEY); } catch {}
	}

	// ── Step navigation ────────────────────────────────────
	// Real existing token: user wants to launch/list an already-deployed token.
	// Set via URL param (?token=0x...) OR via the "Launch existing token" toggle
	// in the basics step when deployMode is 'launch' or 'both'.
	let isRealExistingToken = $derived(useExistingToken && !!existingTokenAddress);

	let steps = $derived.by(() => {
		const s: { id: WizardStep; label: string }[] = [{ id: 'basics', label: 'Basics' }];
		if (!isRealExistingToken) s.push({ id: 'features', label: 'Features' });
		if (isTaxable && !isRealExistingToken) s.push({ id: 'tax', label: 'Tax' });
		if (!isRealExistingToken) s.push({ id: 'protection', label: 'Protection' });
		if (launchEnabled) s.push({ id: 'launch', label: 'Launch' });
		if (listingEnabled && !launchEnabled) s.push({ id: 'listing', label: 'DEX Listing' });
		s.push({ id: 'review', label: 'Review' });
		return s;
	});

	let currentStepIdx = $derived(steps.findIndex(s => s.id === wizardStep));
	// Track the farthest step the user has reached so they can jump back
	// to any already-visited step via the stepper header.
	let maxReachedStepIdx = $state(0);
	// When user clicks a future step, we walk forward one step at a time,
	// validating each step's form as we go. Lands on the target step if
	// all pass, or on the first invalid step (browser auto-focuses it).
	let targetStepIdx = $state<number | null>(null);
	let wzFormEl: HTMLFormElement | undefined = $state();

	function nextStep() {
		const idx = currentStepIdx;
		if (idx < steps.length - 1) {
			wizardStep = steps[idx + 1].id;
			if (idx + 1 > maxReachedStepIdx) maxReachedStepIdx = idx + 1;
			// If we're walking toward a later target, keep going.
			// setTimeout gives Svelte a tick to render the new step
			// so requestSubmit validates the right fields.
			if (targetStepIdx != null && idx + 1 < targetStepIdx) {
				setTimeout(() => wzFormEl?.requestSubmit(), 0);
			} else {
				targetStepIdx = null;
			}
		} else {
			targetStepIdx = null;
			submit();
		}
	}

	function prevStep() {
		const idx = currentStepIdx;
		if (idx > 0) wizardStep = steps[idx - 1].id;
	}

	function jumpToStep(i: number) {
		if (i === currentStepIdx) return;
		if (i < currentStepIdx) {
			// Going back — no validation needed
			wizardStep = steps[i].id;
			return;
		}
		// Going forward — walk through each step, validating as we go
		targetStepIdx = i;
		wzFormEl?.requestSubmit();
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
		// Pre-compute per-pair token amounts using USD-normalized liquidity. This is the
		// single source of truth for listing math — every downstream consumer must use
		// pair.tokenAmount and never re-derive from (baseAmount / price), because BNB/USD
		// ≠ USDT/USD and re-deriving mixes units, producing mispriced pools.
		const pairsWithTokens: ListingPairConfig[] = listingPairs
			.filter(p => Number(p.amount) > 0)
			.map(p => {
				const tokens = totalLiquidityUsd > 0 && tokensForPool > 0
					? tokensForPool * (pairUsd(p) / totalLiquidityUsd)
					: 0;
				return { base: p.base, amount: p.amount, tokenAmount: String(tokens) };
			});

		updateTokenInfo({
			name, symbol, totalSupply, decimals, isMintable, isTaxable, isPartner, network,
			existingTokenAddress: isRealExistingToken ? existingTokenAddress : undefined,
			bases: selectedBaseAddresses,
			listing: {
				enabled: listingEnabled, baseCoin: listingPairs[0]?.base ?? 'native',
				mode: 'price', tokenAmount: String(totalTokensForListing),
				baseAmount: listingPairs[0]?.amount ?? '', pricePerToken: listingPricePerToken,
				listBaseAmount: listingPairs[0]?.amount ?? '',
				pairs: pairsWithTokens,
				tradingDelay: listingTradingDelaySeconds,
				burnLp,
			},
			launch: {
				enabled: launchEnabled, tokensForLaunchPct: launchTokensPct,
				curveType: launchCurveType, softCap: launchSoftCap, hardCap: launchHardCap,
				durationDays: launchDurationDays,
				// When protection disabled, use max 5% buy cap (contract min 0.5%, max 5%) and no anti-snipe
				maxBuyBps: String(Math.round(parseFloat((launchProtectionEnabled ? launchMaxBuyPct : '5') || '0') * 100)),
				creatorAllocationBps: String(Math.round(parseFloat(launchCreatorAllocPct || '0') * 100)), vestingDays: launchVestingDays,
				// Convert minutes to seconds for the contract (contract caps at 24h = 1440 min).
				lockDurationAfterListing: String(Math.round(parseFloat((launchProtectionEnabled ? launchLockDurationMinutes : '0') || '0') * 60)),
				minBuyUsdt: launchProtectionEnabled ? launchMinBuyUsdt : '1',
				// Convert datetime-local (browser local time) to unix seconds.
				// Empty string → "0" = immediate start.
				startTimestamp: launchStartDateLocal
					? String(Math.floor(new Date(launchStartDateLocal).getTime() / 1000))
					: '0',
			},
			protection: { maxWalletPct: protectionEnabled ? maxWalletPct : '0', maxTransactionPct: protectionEnabled ? maxTransactionPct : '0', cooldownSeconds: protectionEnabled ? cooldownSeconds : '0', blacklistWindowSeconds: protectionEnabled ? blacklistWindowSeconds : '0' },
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

	// Simple curve path for mini thumbnails (no axes, no labels — just the line)
	function curveMiniPath(type: number, w: number, h: number): string {
		const pad = 2;
		const pw = w - pad * 2, ph = h - pad * 2;
		const pts: string[] = [];
		const steps = 30;
		for (let i = 0; i <= steps; i++) {
			const x = i / steps;
			let y: number;
			switch (type) {
				case 0: y = x; break;
				case 1: y = Math.sqrt(x); break;
				case 2: y = x * x; break;
				case 3: y = (Math.exp(x * 3) - 1) / (Math.E ** 3 - 1); break;
				default: y = x;
			}
			const px = pad + x * pw;
			const py = pad + ph - y * ph;
			pts.push(`${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`);
		}
		return pts.join(' ');
	}
</script>

<div class="wz">
	<!-- Step indicator -->
	<div class="wz-steps">
		{#each steps as step, i}
			<button
				class="wz-step"
				class:wz-step-done={i < currentStepIdx}
				class:wz-step-active={step.id === wizardStep}
				class:wz-step-locked={i > maxReachedStepIdx}
				tabindex="-1"
				onclick={() => jumpToStep(i)}
			>
				<span class="wz-step-num">{i < currentStepIdx ? '✓' : i + 1}</span>
				<span class="wz-step-label">{step.label}</span>
			</button>
			{#if i < steps.length - 1}
				<div class="wz-step-line" class:wz-step-line-done={i < currentStepIdx}></div>
			{/if}
		{/each}
	</div>

	<!-- Step content + nav wrapped in a form so native validation blocks
	     Next when required fields are empty. The form submission handler
	     calls nextStep() — failed validation auto-focuses the first invalid
	     input, no manual checks or alerts needed. -->
	<form bind:this={wzFormEl} onsubmit={(e) => { e.preventDefault(); nextStep(); }}>
	<div class="wz-content">
		{#if wizardStep === 'basics'}
			{#if launchEnabled}
				<!-- New / Existing tab switcher -->
				<div class="token-src-tabs">
					<button class="token-src-tab" class:token-src-active={!useExistingToken} onclick={() => { useExistingToken = false; existingTokenAddress = ''; }}>
						Create new token
					</button>
					<button class="token-src-tab" class:token-src-active={useExistingToken} onclick={() => useExistingToken = true}>
						Use existing token
					</button>
				</div>
			{/if}

			{#if !isRealExistingToken}
				<BasicInfo bind:name bind:symbol bind:totalSupply bind:decimals bind:chainId bind:useExistingToken bind:existingTokenAddress bind:tokenLogoUrl bind:tokenDescription bind:tokenWebsite bind:tokenTwitter bind:tokenTelegram {supportedNetworks} {getNetworkProviders} isCreateOnly={!launchEnabled && !listingEnabled} onPresetLoaded={handlePresetLoaded} />
			{:else}
				<!-- Existing token: address + network -->
				<div class="existing-token-form">
					<div class="field-group mb-4">
						<label class="wz-label" for="existing-token-addr">Token contract address</label>
						<input
							id="existing-token-addr"
							class="input-field"
							bind:value={existingTokenAddress}
							placeholder="0x..."
						/>
						{#if existingTokenAddress && !/^0x[a-fA-F0-9]{40}$/.test(existingTokenAddress)}
							<p class="text-red-400 text-xs font-mono mt-1">Invalid address</p>
						{/if}
					</div>
					<div class="field-group">
						<label class="wz-label" for="existing-token-network">Network</label>
						<select id="existing-token-network" class="input-field" bind:value={chainId}>
							<option value="">Select network</option>
							{#each supportedNetworks.filter((n) => n.platform_address && n.platform_address.length > 2) as n (n.chain_id)}
								<option value={n.chain_id}>{n.name} ({n.native_coin})</option>
							{/each}
						</select>
					</div>
					<p class="text-gray-600 text-[10px] font-mono mt-3">
						Your token must be owned by your connected wallet. The router will temporarily take ownership to configure the launch, then return it.
					</p>
				</div>
			{/if}

		{:else if wizardStep === 'features'}
			<Features bind:isMintable bind:isTaxable bind:isPartner />

		{:else if wizardStep === 'tax'}
			<TaxStep bind:buyTaxPct bind:sellTaxPct bind:transferTaxPct bind:taxWallets {isPartner} />

		{:else if wizardStep === 'protection'}
			<div class="wz-section">
				<h2 class="wz-title">Protection</h2>
				<p class="wz-hint">Anti-whale limits and pool pre-registration — permanent safeguards for your token.</p>
				<ProtectionStep bind:protectionEnabled bind:maxWalletPct bind:maxTransactionPct bind:cooldownSeconds bind:blacklistWindowSeconds />

				<!-- Base-token pre-registration. Every checked base gets a pool
				     created on the token at initialize() time, which means the
				     pool-lock gate blocks anyone from trading it before the
				     creator's real listing opens. Without this, a grifter can
				     open e.g. the WBNB pair with a malicious initial price and
				     drain it as soon as trading flips on. -->
				{#if baseOptions.length > 0 || selectedNetwork}
				<div style="margin-top: 18px;">
					<h3 class="wz-subtitle">Protect Liquidity Pool</h3>
					<p class="wz-hint" style="margin-bottom: 10px;">
						Pre-register DEX pools against these base tokens. Blocks grifters from opening a pair at a malicious price before you list.
					</p>
					<div class="base-grid">
						{#each baseOptions as b (b.address.toLowerCase())}
							<label class="base-pill" class:base-pill-on={baseSelection[b.address.toLowerCase()]} title={b.name || b.symbol}>
								<input
									type="checkbox"
									checked={!!baseSelection[b.address.toLowerCase()]}
									onchange={() => toggleBase(b.address)}
								/>
								<span class="base-sym">{b.symbol}</span>
								{#if b.custom}
									<button
										type="button"
										class="base-remove"
										onclick={(e) => { e.preventDefault(); removeCustomBase(b.address); }}
										title="Remove"
									>×</button>
								{/if}
							</label>
						{/each}
					</div>
					<div class="base-add-row">
						<input
							class="input-field base-add-addr"
							type="text"
							placeholder="0x… add custom base"
							bind:value={newBaseAddress}
							disabled={baseLookupBusy}
						/>
						<button
							type="button"
							class="base-add-btn"
							onclick={addCustomBase}
							disabled={!newBaseAddress.trim() || baseLookupBusy}
						>{baseLookupBusy ? '…' : 'Add'}</button>
					</div>
					{#if baseLookupError}
						<p class="base-error">{baseLookupError}</p>
					{/if}
				</div>
				{/if}
			</div>

		{:else if wizardStep === 'launch'}
			<div class="wz-section">
				<h2 class="wz-title">Bonding Curve Launch</h2>
				<div class="wz-field">
					<label class="wz-label">
						Tokens for launch ({launchTokensPct}%{#if launchTokenAmount > 0} — {formatTokenAmount(launchTokenAmount)} {symbol || 'tokens'}{/if})
					</label>
					<input type="range" class="wz-slider" min="20" max="90" step="5" bind:value={launchTokensPct} />
					{#if launchTokenAmount > 0}
						<span class="wz-field-hint">Remaining {formatTokenAmount(supplyNum - launchTokenAmount)} {symbol || 'tokens'} goes to: LP seeding (on graduation) + creator allocation (if any) + burn</span>
					{/if}
				</div>
				<div class="wz-field">
					<label class="wz-label">Curve type</label>
					<button class="curve-pick-btn" type="button" onclick={() => showCurveModal = true}>
						<svg class="curve-pick-preview" viewBox="0 0 60 32" fill="none"><path d={curveMiniPath(launchCurveType, 60, 32)} stroke="#00d2ff" stroke-width="2" stroke-linecap="round" fill="none"/></svg>
						<span class="curve-pick-name">{CURVE_LABELS[launchCurveType]}</span>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
					</button>
				</div>
				<div class="wz-row">
					<div class="wz-field"><label class="wz-label" for="launchSoftCap">Soft cap ($)</label><input id="launchSoftCap" class="input-field" type="number" min="1" step="any" required bind:value={launchSoftCap} placeholder="50,000" /></div>
					<div class="wz-field"><label class="wz-label" for="launchHardCap">Hard cap ($)</label><input id="launchHardCap" class="input-field" type="number" min="1" step="any" required bind:value={launchHardCap} placeholder="100,000" /></div>
				</div>
				<div class="wz-row">
					<div class="wz-field">
						<label class="wz-label" for="launchDuration">Duration</label>
						<select id="launchDuration" class="input-field" bind:value={launchDurationDays}>
							<option value="7">7 days</option>
							<option value="14">14 days</option>
							<option value="30">30 days</option>
							<option value="60">60 days</option>
							<option value="90">90 days</option>
						</select>
					</div>
					<div class="wz-field">
						<label class="wz-label" for="launchStart">Start date (optional)</label>
						<input
							id="launchStart"
							type="datetime-local"
							class="input-field"
							bind:value={launchStartDateLocal}
							min={new Date(Date.now() + 60000).toISOString().slice(0, 16)}
						/>
						<span class="wz-field-hint">{launchStartDateLocal ? 'Launch opens at this local time' : 'Leave empty to start immediately after deploy'}</span>
					</div>
				</div>
				<div class="wz-row">
					<div class="wz-field">
						<label class="wz-label">Creator allocation</label>
						<select class="input-field" bind:value={launchCreatorAllocPct}>
							<option value="0">None</option>
							<option value="1">1% of supply</option>
							<option value="2">2% of supply</option>
							<option value="3">3% of supply</option>
							<option value="5">5% of supply</option>
							<option value="10">10% of supply</option>
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

				<!-- Launchpad anti-whale protection -->
				<div class="wz-toggle-card" class:wz-toggle-on={launchProtectionEnabled}>
					<label class="wz-toggle-row">
						<div>
							<span class="wz-toggle-title">Launchpad Anti-Whale Protection</span>
							<span class="wz-toggle-desc">Applies during the bonding curve only</span>
						</div>
						<div class="wz-switch" class:wz-switch-on={launchProtectionEnabled}>
							<div class="wz-switch-thumb"></div>
						</div>
						<input type="checkbox" bind:checked={launchProtectionEnabled} class="sr-only" />
					</label>
					{#if launchProtectionEnabled}
						<div class="wz-toggle-body">
							<div class="wz-row">
								<div class="wz-field">
									<label class="wz-label">Max buy per wallet</label>
									<select class="input-field" bind:value={launchMaxBuyPct}>
										<option value="0.5">0.5% of hard cap</option>
										<option value="1">1% of hard cap</option>
										<option value="2">2% of hard cap</option>
										<option value="3">3% of hard cap</option>
										<option value="5">5% of hard cap</option>
									</select>
									<span class="wz-field-hint">
										One wallet can't buy more than this share of the total raise
										{#if launchMaxBuyUsdt > 0} — ${launchMaxBuyUsdt.toLocaleString(undefined, { maximumFractionDigits: 2 })} at your hard cap{/if}
									</span>
								</div>
								<div class="wz-field">
									<label class="wz-label" for="launchMinBuyUsdt">Min buy (USDT)</label>
									<input id="launchMinBuyUsdt" class="input-field" type="text" bind:value={launchMinBuyUsdt} placeholder="1" />
									<span class="wz-field-hint">Anti-dust floor per buy. Must be &gt; 0 and ≤ soft cap.</span>
								</div>
							</div>
							{#if minBuyExceedsMaxBuy}
								<div class="wz-warn-box">
									⚠ Your min buy (${launchMinBuyNum}) exceeds the max-wallet allowance (${launchMaxBuyUsdt.toLocaleString(undefined, { maximumFractionDigits: 2 })}) — no one will be able to buy. Either lower min buy, raise hard cap, or increase max-buy %.
								</div>
							{/if}
							<div class="wz-field">
								<label class="wz-label" for="launchLockDurationMinutes">Anti-snipe delay (minutes)</label>
								<select id="launchLockDurationMinutes" class="input-field" bind:value={launchLockDurationMinutes}>
									<option value="0">None (open immediately)</option>
									<option value="5">5 min</option>
									<option value="15">15 min</option>
									<option value="30">30 min</option>
									<option value="60">1 hour</option>
									<option value="240">4 hours</option>
									<option value="720">12 hours</option>
									<option value="1440">24 hours (max)</option>
								</select>
								<span class="wz-field-hint">How long DEX trading stays locked after graduation — blocks snipers from front-running the listing block.</span>
							</div>
						</div>
					{/if}
				</div>

				<!-- Curve chart moved into modal -->
			</div>

		{:else if wizardStep === 'listing'}
			<div class="wz-section">
				<h2 class="wz-title">DEX Listing</h2>
				<p class="wz-hint">Add liquidity and your token is instantly tradable.</p>
				<ListingStep bind:symbol bind:totalSupply bind:poolPct={listingPoolPct} bind:pairs={listingPairs} bind:pricePerToken={listingPricePerToken} {nativeCoin} {bnbPriceUsd} />

				<!-- Burn LP toggle -->
				<div class="burn-lp-card mt-6" class:burn-on={burnLp} class:burn-off={!burnLp}>
					<label class="burn-lp-toggle">
						<div class="burn-lp-left">
							<span class="burn-lp-icon">{burnLp ? '🔥' : '⚠️'}</span>
							<div>
								<span class="burn-lp-title syne">{burnLp ? 'LP Burned (Permanent)' : 'LP NOT Burned (Removable)'}</span>
								<span class="burn-lp-desc">{burnLp ? 'Liquidity is permanent. Investors see this as safe.' : 'You can remove liquidity anytime. No SAFU badge.'}</span>
							</div>
						</div>
						<div class="wz-switch" class:wz-switch-on={burnLp}>
							<div class="wz-switch-thumb"></div>
						</div>
						<input type="checkbox" bind:checked={burnLp} class="sr-only" />
					</label>
				</div>

				<!-- Anti-snipe delay for direct listings -->
				<div class="wz-field mt-6">
					<label class="wz-label" for="listingTradingDelaySeconds">Anti-snipe delay (seconds)</label>
					<select id="listingTradingDelaySeconds" class="input-field" bind:value={listingTradingDelaySeconds}>
						<option value="0">None (open immediately)</option>
						<option value="30">30 sec</option>
						<option value="60">1 min</option>
						<option value="300">5 min</option>
						<option value="900">15 min</option>
						<option value="3600">1 hour</option>
					</select>
					<span class="wz-field-hint">Blocks public swaps for this many seconds after your listing transaction confirms. Stops MEV bots from front-running your seed tx with a buy in the same block.</span>
				</div>
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
			<button type="button" class="wz-btn wz-btn-back" onclick={prevStep}>Back</button>
		{:else}
			<div></div>
		{/if}
		<button type="submit" class="wz-btn wz-btn-next">
			{wizardStep === 'review' ? (launchEnabled ? 'Deploy & Launch' : listingEnabled ? 'Deploy & List' : 'Deploy Token') : 'Next →'}
		</button>
	</div>
	</form>
</div>

<!-- Curve Type Picker Modal -->
{#if showCurveModal}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="curve-modal-overlay" onclick={() => showCurveModal = false} role="presentation">
		<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
		<div class="curve-modal" onclick={(e) => e.stopPropagation()} role="dialog" aria-label="Choose curve type" tabindex="-1">
			<div class="curve-modal-header">
				<h3 class="curve-modal-title">Choose Curve Type</h3>
				<button class="curve-modal-close" aria-label="Close" onclick={() => showCurveModal = false}>
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
				</button>
			</div>

			<div class="curve-modal-body">
				<div class="curve-modal-chart">
					<BondingCurveChart curveType={launchCurveType} width={320} height={200} />
				</div>

				<div class="curve-modal-options">
					{#each CURVE_LABELS as label, i}
						<button
							class="curve-option"
							class:curve-option-active={launchCurveType === i}
							onclick={() => launchCurveType = i}
						>
							<svg class="curve-option-mini" viewBox="0 0 48 28" fill="none"><path d={curveMiniPath(i, 48, 28)} stroke={launchCurveType === i ? '#00d2ff' : '#475569'} stroke-width="2" stroke-linecap="round" fill="none"/></svg>
							<div class="curve-option-info">
								<span class="curve-option-name">{label}</span>
								<span class="curve-option-desc">
									{#if i === 0}Price rises steadily as tokens sell
									{:else if i === 1}Cheaper early, flattens later
									{:else if i === 2}Cheap early, expensive late
									{:else}Slow start, rapid price surge
									{/if}
								</span>
							</div>
							{#if launchCurveType === i}
								<svg class="curve-option-check" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00d2ff" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
							{/if}
						</button>
					{/each}
				</div>
			</div>

			<button class="curve-modal-done" onclick={() => showCurveModal = false}>
				Done
			</button>
		</div>
	</div>
{/if}

<style>
	.wz { max-width: 640px; margin: 0 auto; }

	/* Token source tabs (new vs existing) */
	.token-src-tabs {
		display: flex; gap: 0; margin-bottom: 20px;
		background: rgba(255,255,255,0.02); border-radius: 10px;
		border: 1px solid rgba(255,255,255,0.04); overflow: hidden;
	}
	.token-src-tab {
		flex: 1; padding: 10px 16px; border: none; background: transparent;
		font-family: 'Syne', sans-serif; font-size: 12px; font-weight: 600;
		color: #475569; cursor: pointer; transition: all 0.15s;
		border-right: 1px solid rgba(255,255,255,0.04);
	}
	.token-src-tab:last-child { border-right: none; }
	.token-src-tab:hover { color: #94a3b8; background: rgba(255,255,255,0.02); }
	.token-src-active {
		color: #00d2ff; background: rgba(0,210,255,0.06);
		box-shadow: inset 0 -2px 0 #00d2ff;
	}
	.existing-token-form {
		padding: 20px; border-radius: 12px;
		background: rgba(255,255,255,0.015); border: 1px solid rgba(255,255,255,0.04);
	}

	/* Burn LP toggle card */
	.burn-lp-card {
		padding: 14px 16px; border-radius: 12px; transition: all 0.2s;
	}
	.burn-on {
		background: rgba(16,185,129,0.04); border: 1.5px solid rgba(16,185,129,0.2);
	}
	.burn-off {
		background: rgba(245,158,11,0.04); border: 1.5px solid rgba(245,158,11,0.2);
	}
	.burn-lp-toggle {
		display: flex; align-items: center; justify-content: space-between; gap: 12px; cursor: pointer;
	}
	.burn-lp-left { display: flex; align-items: center; gap: 10px; }
	.burn-lp-icon { font-size: 20px; flex-shrink: 0; }
	.burn-lp-title { display: block; font-size: 13px; font-weight: 700; color: #fff; }
	.burn-lp-desc { display: block; font-size: 10px; color: #64748b; font-family: 'Space Mono', monospace; margin-top: 2px; }

	/* Steps indicator */
	.wz-steps { display: flex; align-items: center; gap: 0; margin-bottom: 24px; padding: 0 8px; }
	.wz-step { display: flex; flex-direction: column; align-items: center; gap: 4px; background: none; border: none; cursor: pointer; padding: 0; }
	.wz-step-num { width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; font-family: 'Space Mono', monospace; border: 2px solid var(--border-input); color: var(--text-dim); background: transparent; transition: all 200ms; }
	.wz-step-active .wz-step-num { border-color: #00d2ff; color: #00d2ff; background: rgba(0,210,255,0.1); }
	.wz-step-done .wz-step-num { border-color: #10b981; color: #10b981; background: rgba(16,185,129,0.1); }
	.wz-step-label { font-size: 9px; color: var(--text-dim); font-family: 'Space Mono', monospace; text-transform: uppercase; letter-spacing: 0.05em; white-space: nowrap; }
	.wz-step-active .wz-step-label { color: #00d2ff; }
	.wz-step-done .wz-step-label { color: #10b981; }
	.wz-step-locked { cursor: not-allowed; opacity: 0.5; }
	.wz-step-line { flex: 1; height: 2px; background: var(--bg-surface-hover); min-width: 20px; margin: 0 4px; margin-bottom: 16px; }
	.wz-step-line-done { background: #10b981; }

	/* Content */
	.wz-content { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 16px; padding: 24px; margin-bottom: 16px; }
	.wz-section {}
	.wz-title { font-family: 'Syne', sans-serif; font-size: 20px; font-weight: 800; color: var(--text-heading); margin: 0 0 4px; }
	.wz-hint { font-size: 12px; color: var(--text-dim); font-family: 'Space Mono', monospace; margin: 0 0 16px; }

	.wz-field { margin-bottom: 14px; }
	.wz-label { display: block; font-size: 11px; font-weight: 700; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; font-family: 'Space Mono', monospace; margin-bottom: 6px; }
	.wz-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
	.wz-slider { width: 100%; -webkit-appearance: none; height: 6px; background: var(--bg-surface-hover); border-radius: 3px; outline: none; }
	.wz-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 18px; height: 18px; border-radius: 50%; background: #00d2ff; cursor: pointer; border: 2px solid var(--bg); }
	.wz-radio-row { display: flex; gap: 6px; flex-wrap: wrap; }
	.wz-radio { padding: 6px 14px; border-radius: 8px; border: 1px solid var(--border); background: transparent; color: var(--text-dim); font-family: 'Space Mono', monospace; font-size: 11px; cursor: pointer; transition: all 150ms; }
	.wz-radio:hover { border-color: rgba(0,210,255,0.3); color: var(--text); }
	.wz-radio-active { border-color: rgba(0,210,255,0.4); color: #00d2ff; background: rgba(0,210,255,0.08); }

	.wz-field-hint { display: block; font-size: 10px; color: var(--text-dim); font-family: 'Space Mono', monospace; margin-top: 3px; }
	.wz-warn-box {
		margin-top: 8px; padding: 8px 10px; border-radius: 6px;
		background: rgba(248,113,113,0.08); border: 1px solid rgba(248,113,113,0.25);
		color: #fca5a5; font-size: 11px; font-family: 'Space Mono', monospace; line-height: 1.5;
	}
	.wz-subtitle { font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 700; color: var(--text); margin: 0 0 6px; }
	.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); }

	/* Base-token multi-select */
	.base-grid { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
	.base-pill {
		display: inline-flex; align-items: center; gap: 6px;
		padding: 7px 12px; border-radius: 10px;
		border: 1px solid var(--border-input);
		background: transparent; color: var(--text-dim);
		font-family: 'Space Mono', monospace; font-size: 11px;
		cursor: pointer; transition: all 150ms;
	}
	.base-pill input { position: absolute; opacity: 0; pointer-events: none; }
	.base-pill:hover { border-color: rgba(0,210,255,0.3); color: var(--text); }
	.base-pill-on { border-color: rgba(0,210,255,0.4); color: #00d2ff; background: rgba(0,210,255,0.08); }
	.base-sym { font-weight: 700; }
	.base-remove {
		background: none; border: none; color: inherit; cursor: pointer;
		font-size: 14px; line-height: 1; padding: 0 2px;
		opacity: 0.6;
	}
	.base-remove:hover { opacity: 1; }
	.base-add-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
	.base-add-addr { font-size: 11px; }
	.base-error { font-size: 11px; color: #f87171; font-family: 'Space Mono', monospace; margin-top: 6px; }
	.base-add-btn {
		padding: 8px 16px; border-radius: 10px;
		border: 1px solid rgba(0,210,255,0.4); background: rgba(0,210,255,0.08);
		color: #00d2ff; font-family: 'Space Mono', monospace; font-size: 11px;
		cursor: pointer; transition: all 150ms;
	}
	.base-add-btn:hover:not(:disabled) { background: rgba(0,210,255,0.15); }
	.base-add-btn:disabled { opacity: 0.4; cursor: not-allowed; }

	/* Toggle card */
	.wz-toggle-card { border: 1px solid var(--border); border-radius: 12px; padding: 0; margin-top: 14px; overflow: hidden; transition: border-color 200ms; }
	.wz-toggle-on { border-color: rgba(245,158,11,0.25); }
	.wz-toggle-row { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; cursor: pointer; gap: 12px; }
	.wz-toggle-title { display: block; font-size: 13px; font-weight: 700; color: var(--text); font-family: 'Syne', sans-serif; }
	.wz-toggle-desc { display: block; font-size: 10px; color: var(--text-dim); font-family: 'Space Mono', monospace; margin-top: 1px; }
	.wz-toggle-body { padding: 0 14px 14px; }
	.wz-switch { width: 40px; height: 22px; border-radius: 11px; background: var(--toggle-track); border: 1px solid var(--border); position: relative; flex-shrink: 0; transition: background 200ms; }
	.wz-switch-on { background: #f59e0b; border-color: rgba(245,158,11,0.5); }
	.wz-switch-thumb { width: 16px; height: 16px; border-radius: 50%; background: var(--toggle-thumb-off); box-shadow: 0 1px 3px rgba(0,0,0,0.2); position: absolute; top: 2px; left: 2px; transition: transform 200ms; }
	.wz-switch-on .wz-switch-thumb { transform: translateX(18px); background: var(--toggle-thumb); }

	/* Nav */
	.wz-nav { display: flex; justify-content: space-between; }
	.wz-btn { padding: 12px 28px; border-radius: 12px; border: none; cursor: pointer; font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 700; transition: all 200ms; }
	.wz-btn-back { background: var(--bg-surface-hover); color: var(--text-dim); }
	.wz-btn-back:hover { background: var(--bg-surface-hover); color: var(--text); }
	.wz-btn-next { background: linear-gradient(135deg, #00d2ff, #3a7bd5); color: white; }
	.wz-btn-next:hover { transform: translateY(-1px); box-shadow: 0 6px 28px rgba(0,210,255,0.3); }

	/* Curve picker button */
	.curve-pick-btn {
		display: flex; align-items: center; gap: 10px;
		width: 100%; padding: 10px 14px; border-radius: 10px;
		background: var(--bg-surface-hover, rgba(255,255,255,0.04));
		border: 1px solid var(--border-input, rgba(255,255,255,0.08));
		color: var(--text); cursor: pointer; transition: all 150ms;
	}
	.curve-pick-btn:hover { border-color: rgba(0,210,255,0.3); background: rgba(0,210,255,0.04); }
	.curve-pick-preview { width: 60px; height: 32px; flex-shrink: 0; }
	.curve-pick-name { flex: 1; text-align: left; font-family: 'Syne', sans-serif; font-weight: 600; font-size: 14px; }
	.curve-pick-btn svg { color: var(--text-dim); flex-shrink: 0; }

	/* Curve modal */
	.curve-modal-overlay {
		position: fixed; inset: 0; z-index: 80;
		background: rgba(0,0,0,0.7); backdrop-filter: blur(4px);
		display: flex; align-items: center; justify-content: center; padding: 16px;
	}
	.curve-modal {
		width: 100%; max-width: 440px;
		background: var(--bg, #07070d); border: 1px solid var(--border);
		border-radius: 20px; overflow: hidden;
		animation: curveModalIn 200ms ease-out;
		box-shadow: 0 24px 80px rgba(0,0,0,0.5);
	}
	@keyframes curveModalIn {
		from { opacity: 0; transform: scale(0.95) translateY(8px); }
		to { opacity: 1; transform: scale(1) translateY(0); }
	}
	.curve-modal-header {
		display: flex; align-items: center; justify-content: space-between;
		padding: 18px 20px 0;
	}
	.curve-modal-title { font-family: 'Syne', sans-serif; font-size: 16px; font-weight: 700; color: var(--text-heading); margin: 0; }
	.curve-modal-close {
		width: 32px; height: 32px; border-radius: 8px; border: none;
		background: var(--bg-surface-hover); color: var(--text-dim);
		display: flex; align-items: center; justify-content: center; cursor: pointer; transition: all 150ms;
	}
	.curve-modal-close:hover { background: var(--border-input); color: var(--text-heading); }

	.curve-modal-body { padding: 16px 20px; }
	.curve-modal-chart {
		background: var(--bg-surface); border: 1px solid var(--border-subtle);
		border-radius: 12px; padding: 12px; margin-bottom: 14px;
	}

	.curve-modal-options { display: flex; flex-direction: column; gap: 6px; }
	.curve-option {
		display: flex; align-items: center; gap: 10px;
		padding: 10px 12px; border-radius: 10px;
		background: var(--bg-surface); border: 1px solid var(--border-subtle);
		color: inherit; cursor: pointer; transition: all 150ms; width: 100%;
	}
	.curve-option:hover { background: var(--bg-surface-hover); border-color: var(--border-input); }
	.curve-option-active { background: rgba(0,210,255,0.06); border-color: rgba(0,210,255,0.25); }
	.curve-option-mini { width: 48px; height: 28px; flex-shrink: 0; }
	.curve-option-info { flex: 1; display: flex; flex-direction: column; gap: 1px; text-align: left; }
	.curve-option-name { font-family: 'Syne', sans-serif; font-size: 13px; font-weight: 600; color: var(--text); }
	.curve-option-active .curve-option-name { color: #00d2ff; }
	.curve-option-desc { font-family: 'Space Mono', monospace; font-size: 10px; color: var(--text-dim); line-height: 1.3; }
	.curve-option-check { flex-shrink: 0; }

	.curve-modal-done {
		display: block; width: calc(100% - 40px); margin: 0 20px 18px;
		padding: 12px; border-radius: 10px; border: none;
		background: linear-gradient(135deg, #00d2ff, #3a7bd5); color: white;
		font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 700;
		cursor: pointer; transition: all 200ms;
	}
	.curve-modal-done:hover { transform: translateY(-1px); box-shadow: 0 6px 28px rgba(0,210,255,0.3); }

	@media (max-width: 500px) {
		.wz-content { padding: 16px; }
		.wz-row { grid-template-columns: 1fr; }
		.wz-step-label { font-size: 8px; }
		.curve-modal { max-width: 100%; border-radius: 16px; }
	}
</style>
