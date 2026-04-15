<script lang="ts">
	import { ethers } from 'ethers';
	import { t } from '$lib/i18n';
	import { pushPreferences } from '$lib/embeddedWallet';
	import { getContext, onDestroy } from 'svelte';
	import { page } from '$app/state';
	import type { SupportedNetwork, PaymentOption } from '$lib/structure';
	import { FACTORY_ABI, PLATFORM_ROUTER_ABI, ROUTER_ABI, ERC20_ABI, ZERO_ADDRESS } from '$lib/tokenCrafter';
	import { LAUNCHPAD_FACTORY_ABI, LAUNCH_INSTANCE_ABI, CURVE_TYPES, type CurveType } from '$lib/launchpad';
	import { apiFetch } from '$lib/apiFetch';
	import { friendlyError } from '$lib/errorDecoder';
	import QrCode from '$lib/QrCode.svelte';
	import { TOKEN_READ_ABI, ERC20_DECIMALS_ABI, ROUTER_ABI_LITE } from '$lib/commonABIs';
	import * as deployHelpers from './lib/deploy/helpers';
	import { getBaseTokenAddress, getBaseDecimals, getBaseSymbol, feeCacheKey } from './lib/deploy/helpers';
	import { SwapRouter } from '$lib/swapRouter.svelte';
	import { findBestRoute, isCacheLoaded, getWeth } from '$lib/tradeLens';
	import TokenForm from './lib/TokenForm.svelte';
	import type { ListingConfig, ListingPairConfig, TokenFormData, PreviewState } from './lib/TokenForm.svelte';

	let resetSignal = $state(0);
	import DisplayPreview from './lib/DisplayPreview.svelte';
	import Tooltip from '$lib/Tooltip.svelte';

	import { createMode, type CreateMode } from '$lib/createModeStore';

	// ─── Intent mode state (synced with global store) ───
	type IntentMode = 'token' | 'launch' | 'both' | 'list';
	let mode: IntentMode | null = $state(null);

	// Read URL params for pre-filling
	let modeFromUrl = $derived(page.url.searchParams.get('mode') as IntentMode | null);
	let launchFromUrl = $derived(page.url.searchParams.get('launch') === 'true');
	let tokenFromUrl = $derived(page.url.searchParams.get('token') || '');
	let chainFromUrl = $derived(page.url.searchParams.get('chain') || '');

	// Resolve mode from URL params on mount
	// Also auto-restore last-used mode from localStorage (tk_last_create_mode)
	// so repeat users skip the chooser. A "Change mode" link is rendered in the
	// wizard header to switch back.
	$effect(() => {
		if (mode !== null) return;
		let resolved: IntentMode | null = null;
		if (tokenFromUrl) {
			resolved = 'launch';
			launchTokenAddress = tokenFromUrl;
		} else if (modeFromUrl === 'token' || modeFromUrl === 'launch' || modeFromUrl === 'both' || modeFromUrl === 'list') {
			resolved = modeFromUrl;
		} else if (launchFromUrl) {
			resolved = 'both';
		} else {
			try {
				const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('tk_last_create_mode') : null;
				if (saved === 'token' || saved === 'launch' || saved === 'both' || saved === 'list') {
					resolved = saved;
				}
			} catch {}
		}
		if (resolved) {
			mode = resolved;
			// Sync store so nav click (setting store to null) triggers reset
			_ignoreStoreUpdate = true;
			createMode.set(resolved);
			_ignoreStoreUpdate = false;
		}
	});

	// Listen to store — nav clicks set it to null to reset to selection
	let _ignoreStoreUpdate = false;
	const unsubCreateMode = createMode.subscribe((val) => {
		if (_ignoreStoreUpdate) return;
		if (val === null && mode !== null) {
			selectMode(null);
			resetSignal++;
		}
	});
	onDestroy(unsubCreateMode);

	function selectMode(m: IntentMode | null) {
		mode = m;
		_ignoreStoreUpdate = true;
		createMode.set(m);
		_ignoreStoreUpdate = false;
		try { sessionStorage.removeItem('tk_create_form_draft'); } catch {}
		previewState = null;
		resetSignal++;
		// Remember last chosen mode so repeat users skip the chooser. Clearing
		// (m=null) leaves the previous choice intact so "Change mode" returns
		// them to the chooser without wiping their preference.
		if (m) {
			try { localStorage.setItem('tk_last_create_mode', m); } catch {}
		}
		// Sync URL
		const url = new URL(window.location.href);
		if (m) {
			url.searchParams.set('mode', m);
		} else {
			url.searchParams.delete('mode');
			url.searchParams.delete('launch');
			url.searchParams.delete('token');
			url.searchParams.delete('chain');
		}
		history.replaceState({}, '', m ? url.toString() : url.pathname);
	}

	function handleModeChange(_m: IntentMode | null) {
		// no-op — mode is managed by selectMode and store
	}

	let initialFormData = $derived.by(() => {
		const data: any = {};
		if (tokenFromUrl) {
			data.existingTokenAddress = tokenFromUrl;
		}
		if (chainFromUrl) {
			const net = supportedNetworks.find(n => n.symbol === chainFromUrl || String(n.chain_id) === chainFromUrl);
			if (net) data.chainId = net.chain_id;
		}
		return Object.keys(data).length > 0 ? data : undefined;
	});

	// Derived page title
	let pageTitle = $derived(
		mode === 'token' ? $t('ci.titleToken') :
		mode === 'launch' ? $t('ci.titleLaunch') :
		mode === 'both' ? $t('ci.titleBoth') :
		mode === 'list' ? 'Create & List on DEX' :
		$t('ci.pageTitle')
	);

	// ─── Launch Existing Token form state ───
	let launchTokenAddress = $state(tokenFromUrl || '');
	let launchTokenName = $state('');
	let launchTokenSymbol = $state('');
	let launchTokenDecimals = $state(18);
	let launchTokenBalance = $state(0n);
	let launchTokenSupply = $state(0n);
	let launchTokenLoading = $state(false);
	let launchAmount = $state('');
	let launchChainId: number | undefined = $state(undefined);
	let launchCurveType = $state<number>(0);
	let launchSoftCap = $state('5');
	let launchHardCap = $state('50');
	let launchDurationDays = $state('30');
	let launchMaxBuyPct = $state('2');
	let launchCreatorAllocPct = $state('0');
	let launchVestingDays = $state('0');
	let launchSubmitting = $state(false);
	let launchStep = $state<'idle' | 'fee' | 'approving-fee' | 'creating' | 'approving-tokens' | 'depositing' | 'saving' | 'done'>('idle');
	let launchDeployedAddress: string | null = $state(null);

	// Hoisted above $derived users below — context binding has no other deps.
	let _getNetworks: () => SupportedNetwork[] = getContext('supportedNetworks');
	let supportedNetworks = $derived(_getNetworks());

	let launchNetwork = $derived(supportedNetworks.find((n) => n.chain_id == launchChainId));
	let launchNetworks = $derived(supportedNetworks.filter((n) => n.launchpad_address && n.launchpad_address !== '0x'));

	// Auto-fetch token info when address + network change
	let launchTokenTimeout: ReturnType<typeof setTimeout> | null = null;
	$effect(() => {
		if (launchTokenTimeout) clearTimeout(launchTokenTimeout);
		const addr = launchTokenAddress;
		const net = launchNetwork;
		if (!addr || !ethers.isAddress(addr) || !net) return;
		launchTokenTimeout = setTimeout(async () => {
			launchTokenLoading = true;
			try {
				const pro = networkProviders.get(net.chain_id) ?? new ethers.JsonRpcProvider(net.rpc);
				const token = new ethers.Contract(addr, TOKEN_READ_ABI, pro);
				const ua = userAddress;
				const [n, s, d, bal, supply] = await Promise.all([
					token.name().catch(() => ''),
					token.symbol().catch(() => ''),
					token.decimals().catch(() => 18),
					ua ? token.balanceOf(ua).catch(() => 0n) : Promise.resolve(0n),
					token.totalSupply().catch(() => 0n)
				]);
				launchTokenName = n;
				launchTokenSymbol = s;
				launchTokenDecimals = Number(d);
				launchTokenBalance = bal;
				launchTokenSupply = supply;
			} catch {
				launchTokenName = '';
				launchTokenSymbol = '';
			} finally {
				launchTokenLoading = false;
			}
		}, 500);
	});

	function setLaunchAmountPct(pct: number) {
		if (launchTokenBalance <= 0n) return;
		const amt = (launchTokenBalance * BigInt(pct)) / 100n;
		launchAmount = ethers.formatUnits(amt, launchTokenDecimals);
	}

	async function submitLaunch() {
		if (!launchNetwork) { addFeedback({ message: 'Select a network.', type: 'error' }); return; }
		if (!ethers.isAddress(launchTokenAddress)) { addFeedback({ message: 'Invalid token address.', type: 'error' }); return; }
		if (!launchTokenName) { addFeedback({ message: 'Could not fetch token info.', type: 'error' }); return; }
		if (!launchAmount || parseFloat(launchAmount) <= 0) { addFeedback({ message: 'Enter token amount.', type: 'error' }); return; }
		if (!launchSoftCap || !launchHardCap || parseFloat(launchHardCap) < parseFloat(launchSoftCap)) { addFeedback({ message: 'Hard cap must be >= soft cap.', type: 'error' }); return; }

		if (!signer || !userAddress) {
			connectWallet();
			return;
		}

		// Ensure correct network
		try {
			const walletProvider = signer.provider;
			if (walletProvider) {
				const walletNetwork = await walletProvider.getNetwork();
				if (Number(walletNetwork.chainId) !== launchNetwork.chain_id) {
					addFeedback({ message: `Switching to ${launchNetwork.name}...`, type: 'info' });
					const switched = await switchNetwork(launchNetwork.chain_id);
					if (!switched) return;
				}
			}
		} catch {
			// Can't verify network — proceed anyway, wallet will reject if wrong
		}

		launchSubmitting = true;
		launchStep = 'fee';

		try {
			// Quick-launch flow for a token the user already owns. Uses
			// PlatformRouter.launchCreatedToken which does the full setup
			// atomically (ownership round-trip, exempt + authorize launch,
			// pull tokens, create launch, deposit). Fee is paid in USDT:
			// quick-launch UI doesn't offer payment-token selection, so
			// the creator must approve the router for the launch fee
			// ahead of time via the same allowance flow.
			const routerAddr = launchNetwork.router_address;
			if (!routerAddr || routerAddr === '0x') {
				addFeedback({ message: 'Router not configured for this chain.', type: 'error' });
				launchStep = 'idle';
				return;
			}
			const router = new ethers.Contract(routerAddr, PLATFORM_ROUTER_ABI, signer);

			// Launch fee in USDT
			const lpFactoryRead = new ethers.Contract(launchNetwork.launchpad_address, LAUNCHPAD_FACTORY_ABI, signer);
			const launchFee: bigint = await lpFactoryRead.launchFee();

			// USDT decimals
			let usdtDec = 18;
			try {
				const usdtC = new ethers.Contract(launchNetwork.usdt_address, ERC20_DECIMALS_ABI, signer);
				usdtDec = Number(await usdtC.decimals());
			} catch {}

			// Approve USDT for the router
			if (launchFee > 0n) {
				launchStep = 'approving-fee';
				addFeedback({ message: $t('ci.approvingFee'), type: 'info' });
				const usdtC = new ethers.Contract(launchNetwork.usdt_address, ERC20_ABI, signer);
				const allowance: bigint = await usdtC.allowance(userAddress, routerAddr);
				if (allowance < launchFee) {
					const approveTx = await usdtC.approve(routerAddr, launchFee);
					await approveTx.wait();
				}
			}

			const tokensForLaunch = ethers.parseUnits(launchAmount, launchTokenDecimals);

			// Transfer token ownership to the router (pre-condition).
			launchStep = 'approving-tokens';
			addFeedback({ message: 'Transferring ownership to router...', type: 'info' });
			const tokenC = new ethers.Contract(
				launchTokenAddress,
				['function owner() view returns (address)', 'function transferOwnership(address) external', 'function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)'],
				signer
			);
			const currentOwner: string = await tokenC.owner();
			if (currentOwner.toLowerCase() !== userAddress!.toLowerCase()) {
				addFeedback({ message: 'You must be the token owner to launch it.', type: 'error' });
				launchStep = 'idle';
				return;
			}
			const xferTx = await tokenC.transferOwnership(routerAddr);
			await xferTx.wait();

			// Approve launch tokens for the router to pull
			const tokenAllow: bigint = await tokenC.allowance(userAddress, routerAddr);
			if (tokenAllow < tokensForLaunch) {
				const approveTx = await tokenC.approve(routerAddr, tokensForLaunch);
				await approveTx.wait();
			}

			const launchParams = {
				tokensForLaunch,
				curveType: BigInt(launchCurveType),
				softCap: ethers.parseUnits(launchSoftCap, usdtDec),
				hardCap: ethers.parseUnits(launchHardCap, usdtDec),
				durationDays: BigInt(launchDurationDays),
				maxBuyBps: BigInt(Math.round(parseFloat(launchMaxBuyPct || '0') * 100)),
				creatorAllocationBps: BigInt(Math.round(parseFloat(launchCreatorAllocPct || '0') * 100)),
				vestingDays: BigInt(launchVestingDays),
				startTimestamp: 0n,
				lockDurationAfterListing: 3600n,
				minBuyUsdt: ethers.parseUnits('1', usdtDec),
			};
			const protectionParams = { maxWalletAmount: 0n, maxTransactionAmount: 0n, cooldownSeconds: 0n };
			const taxParams = {
				buyTaxBps: 0n, sellTaxBps: 0n, transferTaxBps: 0n,
				taxWallets: [] as string[], taxSharesBps: [] as number[],
			};
			// USDT-direct fee payment
			const feePayment = { path: [launchNetwork.usdt_address], maxAmountIn: 0n };

			launchStep = 'creating';
			addFeedback({ message: 'Creating launch...', type: 'info' });
			const tx = await router.launchCreatedToken(
				launchTokenAddress,
				launchParams,
				protectionParams,
				taxParams,
				false, // isTaxable — quick-launch UI does not collect tax params
				feePayment,
			);
			const receipt = await tx.wait();

			// Extract launch address
			let launchAddr: string | null = null;
			const event = receipt?.logs?.find((log: any) => {
				try {
					const parsed = router.interface.parseLog({ topics: [...log.topics], data: log.data });
					return parsed?.name === 'TokenLaunched';
				} catch { return false; }
			});
			if (event) {
				const parsed = router.interface.parseLog({ topics: [...event.topics], data: event.data });
				launchAddr = parsed?.args?.launch ?? null;
			}

			if (launchAddr) {
				launchStep = 'saving';
				launchDeployedAddress = launchAddr;
				launchStep = 'done';
				addFeedback({ message: $t('ci.launchSuccess'), type: 'success' });
			}
		} catch (e: any) {
			const msg = friendlyError(e);
			addFeedback({ message: `Error: ${msg}`, type: 'error' });
			launchStep = 'idle';
		} finally {
			launchSubmitting = false;
		}
	}

	let getProvider: () => ethers.BrowserProvider | null = getContext('provider');
	let getSigner: () => ethers.Signer | null = getContext('signer');
	let getUserAddress: () => string | null = getContext('userAddress');
	let connectWallet: () => Promise<boolean> = getContext('connectWallet');
	const addFeedback = getContext<(f: { message: string; type: string }) => void>('addFeedback');
	let getNetworkProviders: () => Map<number, ethers.JsonRpcProvider> = getContext('networkProviders');
	let getProvidersReady: () => boolean = getContext('providersReady');
	let getPaymentOptions: (network: SupportedNetwork) => PaymentOption[] = getContext('getPaymentOptions');

	let provider = $derived(getProvider());
	let signer = $derived(getSigner());
	let userAddress = $derived(getUserAddress());

	let networkProviders = $derived(getNetworkProviders());
	let providersReady = $derived(getProvidersReady());

	const COIN_LOGOS: Record<string, string> = {
		BNB: 'https://assets.coingecko.com/coins/images/825/small/bnb-icon2_2x.png',
		ETH: 'https://assets.coingecko.com/coins/images/279/small/ethereum.png',
		USDT: 'https://assets.coingecko.com/coins/images/325/small/Tether.png',
		USDC: 'https://assets.coingecko.com/coins/images/6319/small/usdc.png',
		BUSD: 'https://assets.coingecko.com/coins/images/9576/small/BUSD.png',
		MATIC: 'https://assets.coingecko.com/coins/images/4713/small/polygon.png',
	};

	let previewState: PreviewState | null = $state(null);
	function handlePreviewChange(state: PreviewState) {
		previewState = state;
	}

	let showPreview = $state(false);
	let showReviewDetails = $state(false);
	let showPaymentModal = $state(false);
	let isCreating = $state(false);
	let step = $state<'idle' | 'review' | 'checking-balance' | 'waiting-deposit' | 'approving' | 'creating' | 'approving-listing' | 'adding-liquidity' | 'done'>('idle');
	let deployAfterConnect = $state(
		typeof sessionStorage !== 'undefined' && sessionStorage.getItem('tk_deploy_after_connect') === 'true'
	);
	let deployedTokenAddress: string | null = $state(null);
	let deployTxHash: string | null = $state(null);

	// Local wrapper using supportedNetworks from context.
	function getExplorerUrl(chainId: number, type: 'tx' | 'address', hash: string) {
		return deployHelpers.getExplorerUrl(supportedNetworks, chainId, type, hash);
	}

	async function switchNetwork(chainId: number): Promise<boolean> {
		const result = await deployHelpers.switchWalletNetwork(chainId);
		if (result === 'ok') return true;
		if (result === 'not-added') {
			addFeedback({ message: 'Please add this network to your wallet first.', type: 'error' });
		} else {
			addFeedback({ message: 'Failed to switch network. Please switch manually.', type: 'error' });
		}
		return false;
	}

	// Fee data
	let feeTokens: string[] = $state([]);
	let feeAmounts: bigint[] = $state([]);
	let feeLoading = $state(false);
	let selectedPaymentIndex = $state(0);
	let paymentOptions: PaymentOption[] = $state([]);
	// Per-option balances + quoteFee results (populated when modal opens)
	let paymentBalances: bigint[] = $state([]);
	let paymentQuotes: bigint[] = $state([]); // amountIn per option
	let quoteFeeLoading = $state(false);
	// Custom token import in payment modal
	let payImportAddr = $state('');
	let payImportBusy = $state(false);
	let payImportError = $state<string | null>(null);

	// Preloaded fee cache: keyed by "chainId-typeKey".
	// USDT-only model: each entry holds the single USDT creation fee and
	// the single USDT launch fee. Per-payment-token amounts are computed
	// client-side in updateTokenInfo via dexRouter.getAmountsIn when the
	// user picks a non-USDT payment option.
	let feeCache = new Map<string, { creationFeeUsdt: bigint; launchFeeUsdt: bigint }>();
	let feeCacheReady = $state(false);

	async function preloadFees() {
		const networks = supportedNetworks.filter((n) => n.platform_address && n.platform_address !== '0x');
		const promises: Promise<void>[] = [];

		for (const net of networks) {
			const pro = networkProviders.get(net.chain_id) ?? new ethers.JsonRpcProvider(net.rpc);
			const factory = new ethers.Contract(net.platform_address, FACTORY_ABI, pro);
			const lpAddr = net.launchpad_address && net.launchpad_address !== '0x'
				? net.launchpad_address
				: ZERO_ADDRESS;

			for (const taxable of [false, true]) {
				for (const mintable of [false, true]) {
					for (const partner of [false, true]) {
						const key = feeCacheKey(net.chain_id, taxable, mintable, partner);
						promises.push(
							factory.getCreationFees(taxable, mintable, partner, lpAddr)
								.then(([creationFeeUsdt, launchFeeUsdt]: [bigint, bigint]) => {
									feeCache.set(key, { creationFeeUsdt, launchFeeUsdt });
								})
								.catch((e: any) => console.warn(`Fee preload failed for ${key}:`, e))
						);
					}
				}
			}
		}

		await Promise.allSettled(promises);
		feeCacheReady = true;
	}

	$effect(() => {
		if (providersReady) {
			preloadFees();
		}
	});

	// Auto-deploy after wallet connects if user clicked deploy before connecting
	$effect(() => {
		if (deployAfterConnect && signer && userAddress) {
			deployAfterConnect = false;
			try { sessionStorage.removeItem('tk_deploy_after_connect'); } catch {}
			confirmAndDeploy();
		}
	});

	// Balance check
	let userBalance: bigint = $state(0n);
	let balanceCheckInterval: ReturnType<typeof setInterval> | null = null;
	let requiredAmount: bigint = $state(0n);

	// DEX router addresses per chain
	const DEX_ROUTERS: Record<number, string> = {
		1: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',   // Uniswap V2
		56: '0x10ED43C718714eb63d5aA57B78B54704E256024E'     // PancakeSwap V2
	};

	let tokenInfo: (TokenFormData & { listing: ListingConfig }) | null = $state(null);

	// Derived: selected payment option
	let selectedPayment = $derived(paymentOptions[selectedPaymentIndex]);
	let selectedFee = $derived(feeAmounts[selectedPaymentIndex] ?? 0n);
	let selectedFeeFormatted = $derived(
		selectedPayment && selectedFee
			? parseFloat(ethers.formatUnits(selectedFee, selectedPayment.decimals)).toFixed(4)
			: '0'
	);
	let feeUsdAmount = $derived(
		feeAmounts.length > 0 && paymentOptions.length > 0
			? parseFloat(ethers.formatUnits(feeAmounts[0], paymentOptions[0]?.decimals ?? 6)).toFixed(4) // USDT is always first
			: '0'
	);
	let isNativePayment = $derived(selectedPayment?.address === ZERO_ADDRESS);
	let selectedQuote = $derived(paymentQuotes[selectedPaymentIndex] ?? 0n);
	// USDT direct: no swap, no slippage — show the exact fee.
	// Non-USDT: add 1% buffer because the swap may cost slightly more
	// than the quote by the time the tx lands. Excess is refunded.
	let isDirectUsdt = $derived(
		!!selectedPayment && !!tokenInfo &&
		selectedPayment.address.toLowerCase() === tokenInfo.network?.usdt_address?.toLowerCase()
	);
	let selectedFeeWithSlippage = $derived(
		isDirectUsdt ? selectedFee : (selectedQuote > 0n ? selectedQuote * 101n / 100n : selectedFee)
	);
	let selectedFeeDisplay = $derived(
		selectedPayment && selectedFeeWithSlippage > 0n
			? parseFloat(ethers.formatUnits(selectedFeeWithSlippage, selectedPayment.decimals)).toFixed(6)
			: selectedFeeFormatted
	);

	/// Fetch balances + fee quotes for every payment option.
	/// Phase 1: instant quotes from TradeLens cache (no RPC) for snappy render.
	/// Phase 2: on-chain validation via router.quoteFee (debounced, parallel).
	async function loadPaymentQuotes() {
		if (!tokenInfo || paymentOptions.length === 0) return;
		quoteFeeLoading = true;
		const net = tokenInfo.network;
		const usdtAddr = net.usdt_address;

		// ── Phase 1: TradeLens cache (instant, no RPC) ──
		if (isCacheLoaded()) {
			const weth = getWeth();
			const cachedQuotes: bigint[] = [];
			const cached = feeCache.get(feeCacheKey(net.chain_id, tokenInfo.isTaxable, tokenInfo.isMintable, tokenInfo.isPartner));
			const usdtFee = cached ? (cached.creationFeeUsdt + (tokenInfo.launch?.enabled ? cached.launchFeeUsdt : 0n)) : 0n;

			for (const opt of paymentOptions) {
				if (usdtFee === 0n) { cachedQuotes.push(0n); continue; }
				if (opt.address.toLowerCase() === usdtAddr.toLowerCase()) {
					cachedQuotes.push(usdtFee);
				} else {
					try {
						const resolvedIn = opt.address === ZERO_ADDRESS ? weth : opt.address;
						const best = findBestRoute(resolvedIn, usdtAddr, usdtFee);
						// findBestRoute gives amountOut for amountIn — we need the inverse
						// (how much input to get usdtFee output). Use the ratio as approx.
						if (best && best.amountOut > 0n) {
							cachedQuotes.push((usdtFee * usdtFee) / best.amountOut);
						} else {
							cachedQuotes.push(0n);
						}
					} catch { cachedQuotes.push(0n); }
				}
			}
			// Render instantly with cache data
			paymentQuotes = cachedQuotes;
			feeAmounts = cachedQuotes;
		}

		// ── Phase 2: on-chain validation (parallel, accurate) ──
		const prov = getProviderForNetwork(net.chain_id) ?? new ethers.JsonRpcProvider(net.rpc);
		try {
			const typeKey = (tokenInfo.isPartner ? 4 : 0) | (tokenInfo.isTaxable ? 2 : 0) | (tokenInfo.isMintable ? 1 : 0);
			const withLaunch = !!(tokenInfo.launch?.enabled);
			const routerAddr = net.router_address;
			const router = new ethers.Contract(routerAddr, PLATFORM_ROUTER_ABI, prov);

			// Fire all balance + quote fetches in parallel
			const results = await Promise.all(paymentOptions.map(async (opt) => {
				const path = SwapRouter.buildFeePath(opt.address, usdtAddr);
				const [bal, quote] = await Promise.all([
					// Balance
					(async () => {
						if (!userAddress) return 0n;
						try {
							return opt.address === ZERO_ADDRESS
								? await prov.getBalance(userAddress)
								: await new ethers.Contract(opt.address, ERC20_ABI, prov).balanceOf(userAddress);
						} catch { return 0n; }
					})(),
					// Quote via router.quoteFee
					(async () => {
						try {
							const [, amountIn] = await router.quoteFee(typeKey, withLaunch, path);
							return amountIn as bigint;
						} catch { return 0n; }
					})(),
				]);
				return { bal, quote };
			}));

			paymentBalances = results.map(r => r.bal);
			paymentQuotes = results.map(r => r.quote);
			feeAmounts = paymentQuotes;
		} catch (e) {
			console.warn('loadPaymentQuotes failed:', e);
		} finally {
			quoteFeeLoading = false;
		}
	}

	/// Import a custom token as a payment option via address paste.
	async function importPaymentToken() {
		payImportError = null;
		const addr = payImportAddr.trim();
		if (!ethers.isAddress(addr)) { payImportError = 'Invalid address'; return; }
		if (!tokenInfo) return;
		const net = tokenInfo.network;
		const k = addr.toLowerCase();
		if (paymentOptions.some(o => o.address.toLowerCase() === k)) {
			payImportError = 'Already in the list';
			return;
		}
		payImportBusy = true;
		try {
			const prov = getProviderForNetwork(net.chain_id) ?? new ethers.JsonRpcProvider(net.rpc);
			// Resolve token info via GeckoTerminal (fast) + on-chain fallback
			const slug = net.symbol?.toLowerCase?.() || 'bsc';
			let sym = '', name = '', decimals = 18;
			try {
				const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/${slug}/tokens/${addr}/info`,
					{ headers: { Accept: 'application/json;version=20230203' } });
				if (res.ok) {
					const a = (await res.json())?.data?.attributes;
					if (a?.symbol) { sym = a.symbol; name = a.name || a.symbol; decimals = Number(a.decimals ?? 18); }
				}
			} catch {}
			if (!sym) {
				const c = new ethers.Contract(addr, ERC20_ABI, prov);
				sym = await c.symbol().catch(() => '');
				name = await c.name().catch(() => sym);
				decimals = Number(await c.decimals().catch(() => 18));
			}
			if (!sym) { payImportError = 'Could not resolve token'; return; }

			const newOpt: PaymentOption = { symbol: sym, name: name || sym, address: addr, decimals };
			paymentOptions = [...paymentOptions, newOpt];
			payImportAddr = '';
			// Re-fetch quotes to include the new option
			await loadPaymentQuotes();
		} finally {
			payImportBusy = false;
		}
	}

	function getProviderForNetwork(chainId: number): ethers.JsonRpcProvider | null {
		return networkProviders.get(chainId) ?? null;
	}

	async function updateTokenInfo(info: TokenFormData) {
		showPreview = true;
		tokenInfo = info;
		step = 'review';
		selectedPaymentIndex = 0;

		// Set payment options for selected network
		const options = getPaymentOptions(info!.network);
		paymentOptions = options;

		const isExistingToken = !!(info as any).existingTokenAddress;

		// Fetch the single USDT fee for this type (cached by preloadFees).
		const key = feeCacheKey(info!.network.chain_id, info!.isTaxable, info!.isMintable, info!.isPartner);
		let cached = feeCache.get(key);

		if (!cached) {
			feeLoading = true;
			try {
				const pro = getProviderForNetwork(info!.network.chain_id)
					?? new ethers.JsonRpcProvider(info!.network.rpc);
				const factory = new ethers.Contract(info!.network.platform_address, FACTORY_ABI, pro);
				const lpAddr = info!.network.launchpad_address && info!.network.launchpad_address !== '0x'
					? info!.network.launchpad_address
					: ZERO_ADDRESS;
				const [creationFeeUsdt, launchFeeUsdt]: [bigint, bigint] = await factory.getCreationFees(
					info!.isTaxable, info!.isMintable, info!.isPartner, lpAddr
				);
				cached = { creationFeeUsdt, launchFeeUsdt };
				feeCache.set(key, cached);
			} catch (e) {
				console.warn('Fee fetch failed:', e);
				feeLoading = false;
				return;
			}
		}

		// The USDT amount we actually need to pay the router/factory.
		// Existing tokens: only the launch fee (no creation fee).
		// New tokens:      creation fee alone for listing/create-only paths,
		//                  creation + launch fee for create+launch (combined).
		let usdtFeeNeeded: bigint;
		if (isExistingToken) {
			usdtFeeNeeded = cached.launchFeeUsdt;
		} else if (info!.launch?.enabled) {
			usdtFeeNeeded = cached.creationFeeUsdt + cached.launchFeeUsdt;
		} else {
			usdtFeeNeeded = cached.creationFeeUsdt;
		}

		// Compute per-payment-option display amounts via dexRouter.getAmountsIn.
		// The on-chain fee is always USDT; these values only drive the UI
		// ("pay ~X BNB / Y BUSD / Z USDT"). The real payment happens via
		// the FeePayment struct at tx time (built from selectedPayment).
		feeTokens = options.map(o => o.address);
		feeAmounts = new Array(options.length).fill(0n);
		feeLoading = true;
		try {
			const pro = getProviderForNetwork(info!.network.chain_id)
				?? new ethers.JsonRpcProvider(info!.network.rpc);
			const dex = new ethers.Contract(info!.network.dex_router, ROUTER_ABI_LITE, pro);
			const usdtAddr = info!.network.usdt_address;

			const quoted = await Promise.all(
				options.map(async (opt) => {
					if (opt.address.toLowerCase() === usdtAddr.toLowerCase()) return usdtFeeNeeded;
					try {
						let tokenIn = opt.address;
						if (tokenIn === ZERO_ADDRESS) tokenIn = await dex.WETH();
						const amounts: bigint[] = await dex.getAmountsIn(usdtFeeNeeded, [tokenIn, usdtAddr]);
						return amounts[0];
					} catch {
						return 0n;
					}
				})
			);
			feeAmounts = quoted;
			paymentOptions = options;
		} catch (e) {
			console.error('Fee fetch error:', e);
			addFeedback({ message: 'Could not fetch fee. Check network.', type: 'error' });
		} finally {
			feeLoading = false;
		}
	}

	// Calculate total native needed (creation fee + liquidity if native pairs)
	let totalNativeNeeded = $derived.by(() => {
		let total = isNativePayment ? selectedFee * 108n / 100n : 0n; // fee with 8% buffer
		if (tokenInfo?.listing?.enabled && tokenInfo.listing.pairs) {
			for (const pair of tokenInfo.listing.pairs) {
				if (pair.base === 'native' && Number(pair.amount) > 0) {
					total += ethers.parseEther(String(pair.amount));
				}
			}
		}
		return total;
	});

	// Deposit modal: show the shortfall (need − balance), not the total needed.
	let depositNeededWei = $derived.by(() => {
		const dec = selectedPayment?.decimals ?? 18;
		if (isNativePayment) return totalNativeNeeded;
		try { return ethers.parseUnits(String(selectedFeeFormatted || '0'), dec); } catch { return 0n; }
	});
	let depositShortWei = $derived(depositNeededWei > userBalance ? depositNeededWei - userBalance : 0n);
	let depositShortFmt = $derived(parseFloat(ethers.formatUnits(depositShortWei, selectedPayment?.decimals ?? 18)).toFixed(4));

	async function checkBalance(): Promise<boolean> {
		if (!userAddress || !tokenInfo || !selectedPayment) return false;

		const pro = getProviderForNetwork(tokenInfo.network.chain_id)
			?? new ethers.JsonRpcProvider(tokenInfo.network.rpc);

		if (isNativePayment) {
			userBalance = await pro.getBalance(userAddress);
		} else {
			const erc20 = new ethers.Contract(selectedPayment.address, ERC20_ABI, pro);
			userBalance = await erc20.balanceOf(userAddress);
		}

		// For native payment: check fee + liquidity amounts
		if (isNativePayment) return userBalance >= totalNativeNeeded;
		return userBalance >= selectedFee;
	}

	function startBalancePolling() {
		stopBalancePolling();
		balanceCheckInterval = setInterval(async () => {
			const sufficient = await checkBalance();
			if (sufficient && step === 'waiting-deposit') {
				stopBalancePolling();
				addFeedback({ message: 'Deposit detected! Proceeding...', type: 'success' });
				proceedAfterBalance();
			}
		}, 5000);
	}

	function stopBalancePolling() {
		if (balanceCheckInterval) {
			clearInterval(balanceCheckInterval);
			balanceCheckInterval = null;
		}
	}

	onDestroy(() => stopBalancePolling());

	async function proceedAfterBalance() {
		if (!tokenInfo || !signer || !userAddress) return;

		// If ERC20 payment, check allowance and approve
		if (!isNativePayment) {
			step = 'approving';
			try {
				// When using router for launch or listing, approve the router; otherwise approve the factory
				const usesRouter = (tokenInfo.launch?.enabled || tokenInfo.listing?.enabled) && tokenInfo.network.router_address && tokenInfo.network.router_address !== '0x';
				const spender = usesRouter ? tokenInfo.network.router_address : tokenInfo.network.platform_address;
				const erc20 = new ethers.Contract(selectedPayment.address, ERC20_ABI, signer);
				const allowance = await erc20.allowance(userAddress, spender);
				if (allowance < selectedFee) {
					addFeedback({ message: `Approving ${selectedPayment.symbol} spend...`, type: 'info' });
					const tx = await erc20.approve(spender, selectedFee);
					await tx.wait();
					addFeedback({ message: `${selectedPayment.symbol} approved!`, type: 'success' });
				}
			} catch (e: any) {
				addFeedback({ message: friendlyError(e), type: 'error' });
				step = 'review';
				isCreating = false;
				return;
			}
		}

		// Create token (with optional launch via PlatformRouter)
		step = 'creating';
		try {
			const storedRef = localStorage.getItem('referral');
			const referral = storedRef && ethers.isAddress(storedRef) ? storedRef : ZERO_ADDRESS;

			// For existing tokens, totalSupply is formatted (e.g. "1000000.0"), parse it back to wei
			// For new tokens, totalSupply is a raw integer (e.g. "1000000"), contract scales internally
			const isExisting = !!tokenInfo.existingTokenAddress;

			// Guard against empty/unset totalSupply — happens when the user
			// advances the wizard before the on-chain fetch for an existing
			// token completes. ethers.parseUnits('', ...) would throw
			// "invalid FixedNumber string value" — fail fast with a clearer msg.
			const supplyStr = String(tokenInfo.totalSupply ?? '').trim();
			if (!supplyStr || supplyStr === '0' || !Number.isFinite(Number(supplyStr))) {
				addFeedback({ message: 'Token info still loading — wait a moment and try again.', type: 'error' });
				step = 'review';
				isCreating = false;
				return;
			}

			const totalSupplyRaw = isExisting
				? 0n // not used for existing token contract calls
				: BigInt(Math.floor(Number(supplyStr)));
			const totalSupplyWei = isExisting
				? ethers.parseUnits(supplyStr, tokenInfo.decimals)
				: totalSupplyRaw * (10n ** BigInt(tokenInfo.decimals));

			// Build FeePayment struct. Router validates path[last] == USDT.
			// ERC20 path uses a 10% buffer on maxAmountIn so minor price
			// movement between quote and swap doesn't revert the call.
			// Surplus USDT is refunded to the caller in USDT (not the input).
			const usdtAddr = tokenInfo.network.usdt_address;
			const feePath: string[] =
				selectedPayment.address === ZERO_ADDRESS
					? [ZERO_ADDRESS, usdtAddr]
					: selectedPayment.address.toLowerCase() === usdtAddr.toLowerCase()
						? [usdtAddr]
						: [selectedPayment.address, usdtAddr];
			const feeMaxAmountIn: bigint =
				feePath.length === 1 ? 0n
				: selectedPayment.address === ZERO_ADDRESS ? 0n // native: msg.value carries it
				: (selectedFee * 110n) / 100n; // 10% buffer on ERC20 input
			const feePayment = { path: feePath, maxAmountIn: feeMaxAmountIn };

			// Native `value` for router calls: fee (buffered) when paying with BNB,
			// plus any native LP base if createAndList uses a native pair.
			const nativeFeeWithBuffer =
				selectedPayment.address === ZERO_ADDRESS
					? (selectedFee * 110n) / 100n
					: 0n;

			// Approve ERC20 input token (if not native and not USDT-direct-zero-fee)
			// for the router's maxAmountIn. For USDT-direct, approve usdt for the
			// exact usdtFee.
			if (selectedPayment.address !== ZERO_ADDRESS && selectedFee > 0n) {
				const approvalAmount = feePath.length === 1 ? selectedFee : feeMaxAmountIn;
				const erc20 = new ethers.Contract(selectedPayment.address, ERC20_ABI, signer);
				const routerAddr = tokenInfo.network.router_address;
				const allowance: bigint = await erc20.allowance(userAddress, routerAddr);
				if (allowance < approvalAmount) {
					addFeedback({ message: `Approving ${selectedPayment.symbol} for fee...`, type: 'info' });
					const approveTx = await erc20.approve(routerAddr, approvalAmount);
					await approveTx.wait();
				}
			}

			const tokenParams = {
				name: tokenInfo.name,
				symbol: tokenInfo.symbol,
				totalSupply: totalSupplyRaw,
				decimals: tokenInfo.decimals,
				isTaxable: tokenInfo.isTaxable,
				isMintable: tokenInfo.isMintable,
				isPartner: tokenInfo.isPartner,
				bases: (tokenInfo as any).bases ?? []
			};

			if (tokenInfo.existingTokenAddress && tokenInfo.launch?.enabled) {
				// Existing token — use PlatformRouter.launchCreatedToken.
				// The router needs ownership to exempt + authorize the launch;
				// we transferOwnership(router) first, then it's returned to
				// the creator atomically at the end of the router call.
				addFeedback({ message: 'Preparing launch for existing token...', type: 'info' });

				let usdtDec = 18;
				try {
					const usdtC = new ethers.Contract(tokenInfo.network.usdt_address, ERC20_DECIMALS_ABI, signer);
					usdtDec = Number(await usdtC.decimals());
				} catch {}

				const tokensForLaunch = (totalSupplyWei * BigInt(tokenInfo.launch.tokensForLaunchPct)) / 100n;
				const routerAddr = tokenInfo.network.router_address;
				if (!routerAddr || routerAddr === '0x') {
					addFeedback({ message: 'Router not configured for this chain.', type: 'error' });
					step = 'review';
					isCreating = false;
					return;
				}

				// Transfer ownership to router (pre-condition for launchCreatedToken).
				addFeedback({ message: 'Transferring ownership to router...', type: 'info' });
				const tokenC = new ethers.Contract(
					tokenInfo.existingTokenAddress,
					['function owner() view returns (address)', 'function transferOwnership(address) external', 'function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)'],
					signer
				);
				const currentOwner: string = await tokenC.owner();
				if (currentOwner.toLowerCase() !== userAddress!.toLowerCase()) {
					addFeedback({ message: 'You must be the token owner to launch it.', type: 'error' });
					step = 'review';
					isCreating = false;
					return;
				}
				const xferTx = await tokenC.transferOwnership(routerAddr);
				await xferTx.wait();

				// Approve launch tokens for the router to pull.
				addFeedback({ message: 'Approving launch tokens...', type: 'info' });
				const tokenAllowance: bigint = await tokenC.allowance(userAddress, routerAddr);
				if (tokenAllowance < tokensForLaunch) {
					const approveTx = await tokenC.approve(routerAddr, tokensForLaunch);
					await approveTx.wait();
				}

				const launchParams = {
					tokensForLaunch,
					curveType: tokenInfo.launch.curveType,
					softCap: ethers.parseUnits(String(tokenInfo.launch.softCap), usdtDec),
					hardCap: ethers.parseUnits(String(tokenInfo.launch.hardCap), usdtDec),
					durationDays: BigInt(tokenInfo.launch.durationDays),
					maxBuyBps: BigInt(tokenInfo.launch.maxBuyBps),
					creatorAllocationBps: BigInt(tokenInfo.launch.creatorAllocationBps),
					vestingDays: BigInt(tokenInfo.launch.vestingDays),
					startTimestamp: BigInt(tokenInfo.launch.startTimestamp || '0'),
					lockDurationAfterListing: BigInt(tokenInfo.launch.lockDurationAfterListing || '3600'),
					minBuyUsdt: ethers.parseUnits(String(tokenInfo.launch.minBuyUsdt || '1'), usdtDec)
				};

				const protectionParams = {
					maxWalletAmount: tokenInfo.protection?.maxWalletPct
						? (totalSupplyWei * BigInt(Math.round(parseFloat(String(tokenInfo.protection.maxWalletPct)) * 100))) / 10000n
						: 0n,
					maxTransactionAmount: tokenInfo.protection?.maxTransactionPct
						? (totalSupplyWei * BigInt(Math.round(parseFloat(String(tokenInfo.protection.maxTransactionPct)) * 100))) / 10000n
						: 0n,
					cooldownSeconds: BigInt(tokenInfo.protection?.cooldownSeconds || 0)
				};

				const taxParams = {
					buyTaxBps: BigInt(Math.round(parseFloat(String(tokenInfo.tax?.buyTaxPct || '0')) * 100)),
					sellTaxBps: BigInt(Math.round(parseFloat(String(tokenInfo.tax?.sellTaxPct || '0')) * 100)),
					transferTaxBps: BigInt(Math.round(parseFloat(String(tokenInfo.tax?.transferTaxPct || '0')) * 100)),
					taxWallets: tokenInfo.tax?.wallets?.map((w: any) => w.address).filter((a: string) => ethers.isAddress(a)) || [],
					taxSharesBps: tokenInfo.tax?.wallets?.map((w: any) => Math.round(parseFloat(String(w.sharePct || '0')) * 100)) || []
				};

				addFeedback({ message: 'Launching...', type: 'info' });
				const router = new ethers.Contract(routerAddr, PLATFORM_ROUTER_ABI, signer);
				const tx = await router.launchCreatedToken(
					tokenInfo.existingTokenAddress,
					launchParams,
					protectionParams,
					taxParams,
					tokenInfo.isTaxable || tokenInfo.isPartner,
					feePayment,
					{ value: nativeFeeWithBuffer }
				);
				deployTxHash = tx.hash;
				const receipt = await tx.wait();

				// Extract launch from TokenLaunched event.
				const event = receipt?.logs?.find((log: any) => {
					try {
						const parsed = router.interface.parseLog({ topics: [...log.topics], data: log.data });
						return parsed?.name === 'TokenLaunched';
					} catch { return false; }
				});
				if (event) {
					const parsed = router.interface.parseLog({ topics: [...event.topics], data: event.data });
					deployedTokenAddress = parsed?.args?.token ?? tokenInfo.existingTokenAddress ?? null;
				} else {
					deployedTokenAddress = tokenInfo.existingTokenAddress ?? null;
				}

				addFeedback({ message: 'Launch is live!', type: 'success' });

			} else if (tokenInfo.launch?.enabled && tokenInfo.network.router_address && tokenInfo.network.router_address !== '0x') {
				// Use PlatformRouter for atomic Create + Launch
				addFeedback({ message: 'Creating token & launch...', type: 'info' });
				const router = new ethers.Contract(tokenInfo.network.router_address, PLATFORM_ROUTER_ABI, signer);

				const tokensForLaunch = (totalSupplyWei * BigInt(tokenInfo.launch.tokensForLaunchPct)) / 100n;

				// Fetch USDT decimals for cap parsing
				let usdtDec = 18;
				try {
					const usdtC = new ethers.Contract(tokenInfo.network.usdt_address, ERC20_DECIMALS_ABI, signer);
					usdtDec = Number(await usdtC.decimals());
				} catch {}

				const launchParams = {
					tokensForLaunch,
					curveType: tokenInfo.launch.curveType,
					softCap: ethers.parseUnits(String(tokenInfo.launch.softCap), usdtDec),
					hardCap: ethers.parseUnits(String(tokenInfo.launch.hardCap), usdtDec),
					durationDays: BigInt(tokenInfo.launch.durationDays),
					maxBuyBps: BigInt(tokenInfo.launch.maxBuyBps),
					creatorAllocationBps: BigInt(tokenInfo.launch.creatorAllocationBps),
					vestingDays: BigInt(tokenInfo.launch.vestingDays),
					startTimestamp: BigInt(tokenInfo.launch.startTimestamp || '0'),
					// Anti-snipe window after curve graduation — creator picks
					// this in the wizard (already in seconds via lockDurationAfterListing).
					// Default 3600 (1h) if wizard didn't set it.
					lockDurationAfterListing: BigInt(tokenInfo.launch.lockDurationAfterListing || '3600'),
					// Anti-dust floor per buy, whole USDT units in the wizard → native units here.
					minBuyUsdt: ethers.parseUnits(String(tokenInfo.launch.minBuyUsdt || '1'), usdtDec)
				};

				const protectionParams = {
					maxWalletAmount: tokenInfo.protection?.maxWalletPct
						? (totalSupplyWei * BigInt(Math.round(parseFloat(String(tokenInfo.protection.maxWalletPct)) * 100))) / 10000n
						: 0n,
					maxTransactionAmount: tokenInfo.protection?.maxTransactionPct
						? (totalSupplyWei * BigInt(Math.round(parseFloat(String(tokenInfo.protection.maxTransactionPct)) * 100))) / 10000n
						: 0n,
					cooldownSeconds: BigInt(tokenInfo.protection?.cooldownSeconds || 0)
				};

				const taxParams = {
					buyTaxBps: BigInt(Math.round(parseFloat(String(tokenInfo.tax?.buyTaxPct || '0')) * 100)),
					sellTaxBps: BigInt(Math.round(parseFloat(String(tokenInfo.tax?.sellTaxPct || '0')) * 100)),
					transferTaxBps: BigInt(Math.round(parseFloat(String(tokenInfo.tax?.transferTaxPct || '0')) * 100)),
					taxWallets: tokenInfo.tax?.wallets?.map((w: any) => w.address).filter((a: string) => ethers.isAddress(a)) || [],
					taxSharesBps: tokenInfo.tax?.wallets?.map((w: any) => Math.round(parseFloat(String(w.sharePct || '0')) * 100)) || []
				};

				const tx = await router.createTokenAndLaunch(
					tokenParams, launchParams, protectionParams, taxParams, feePayment, referral,
					{ value: nativeFeeWithBuffer }
				);
				deployTxHash = tx.hash;
				const receipt = await tx.wait();

				// Extract from TokenCreatedAndLaunched event
				const event = receipt?.logs?.find((log: any) => {
					try {
						const parsed = router.interface.parseLog({ topics: [...log.topics], data: log.data });
						return parsed?.name === 'TokenCreatedAndLaunched';
					} catch { return false; }
				});
				let launchAddr: string | null = null;
				if (event) {
					const parsed = router.interface.parseLog({ topics: [...event.topics], data: event.data });
					deployedTokenAddress = parsed?.args?.token ?? null;
					launchAddr = parsed?.args?.launch ?? null;
				}

				addFeedback({ message: 'Token created & launch activated!', type: 'success' });

				// Launch data indexed by daemon from on-chain events
			} else if (tokenInfo.listing?.enabled && tokenInfo.network.router_address && tokenInfo.network.router_address !== '0x') {
				// Atomic Create + List via PlatformRouter
				const listing = tokenInfo.listing;
				const pairs = listing.pairs?.length > 0 ? listing.pairs : [{ base: listing.baseCoin || 'native', amount: listing.baseAmount || listing.listBaseAmount || '0' }];
				const price = Number(listing.pricePerToken);

				if (!price || price <= 0) {
					addFeedback({ message: 'Invalid token price for listing.', type: 'error' });
					step = 'review';
					isCreating = false;
					return;
				}

				const router = new ethers.Contract(tokenInfo.network.router_address, PLATFORM_ROUTER_ABI, signer);
				const network = tokenInfo.network;

				const hasNativePair = pairs.some((p: any) => p.base === 'native' && Number(p.amount) > 0);
				const erc20Pairs = pairs.filter((p: any) => p.base !== 'native' && Number(p.amount) > 0);
				const nativePair = pairs.find((p: any) => p.base === 'native' && Number(p.amount) > 0);

				const protectionParams = {
					maxWalletAmount: tokenInfo.protection?.maxWalletPct
						? (totalSupplyWei * BigInt(Math.round(parseFloat(String(tokenInfo.protection.maxWalletPct)) * 100))) / 10000n
						: 0n,
					maxTransactionAmount: tokenInfo.protection?.maxTransactionPct
						? (totalSupplyWei * BigInt(Math.round(parseFloat(String(tokenInfo.protection.maxTransactionPct)) * 100))) / 10000n
						: 0n,
					cooldownSeconds: BigInt(tokenInfo.protection?.cooldownSeconds || 0)
				};

				const taxParams = {
					buyTaxBps: BigInt(Math.round(parseFloat(String(tokenInfo.tax?.buyTaxPct || '0')) * 100)),
					sellTaxBps: BigInt(Math.round(parseFloat(String(tokenInfo.tax?.sellTaxPct || '0')) * 100)),
					transferTaxBps: BigInt(Math.round(parseFloat(String(tokenInfo.tax?.transferTaxPct || '0')) * 100)),
					taxWallets: tokenInfo.tax?.wallets?.map((w: any) => w.address).filter((a: string) => ethers.isAddress(a)) || [],
					taxSharesBps: tokenInfo.tax?.wallets?.map((w: any) => Math.round(parseFloat(String(w.sharePct || '0')) * 100)) || []
				};

				// Approve base tokens for router
				step = 'approving-listing';
				for (const pair of erc20Pairs) {
					const baseAddress = getBaseTokenAddress(network, pair.base);
					const baseDecimals = getBaseDecimals(network, pair.base);
					const parsedBaseAmount = ethers.parseUnits(String(pair.amount), baseDecimals);
					const baseSymbol = getBaseSymbol(network, pair.base);

					const baseContract = new ethers.Contract(baseAddress, ERC20_ABI, signer);
					const balance = await baseContract.balanceOf(userAddress);
					if (balance < parsedBaseAmount) {
						addFeedback({ message: `Insufficient ${baseSymbol} balance. Need ${pair.amount} ${baseSymbol}.`, type: 'error' });
						step = 'review';
						isCreating = false;
						return;
					}
					const allowance = await baseContract.allowance(userAddress, network.router_address);
					if (allowance < parsedBaseAmount) {
						addFeedback({ message: `Approving ${baseSymbol}...`, type: 'info' });
						const approveTx = await baseContract.approve(network.router_address, parsedBaseAmount);
						await approveTx.wait();
					}
				}

				step = 'adding-liquidity';
				addFeedback({ message: 'Creating token & adding liquidity...', type: 'info' });

				// Build unified ListParams: address(0) = native pair, others = ERC20
				const bases: string[] = [];
				const baseAmounts: bigint[] = [];
				const tokenAmounts: bigint[] = [];
				let ethValue = 0n;

				// Native pair first (if any). tokenAmount is pre-computed in
				// TokenForm.submit() using USD-normalized liquidity. Never re-derive
				// from (baseAmount / price) — BNB/USD ≠ USDT/USD and mixing units
				// produces mispriced pools that get drained by cross-pool arbitrage.
				if (nativePair && Number(nativePair.amount) > 0) {
					if (!nativePair.tokenAmount || Number(nativePair.tokenAmount) <= 0) {
						addFeedback({ message: 'Missing token amount for native pair.', type: 'error' });
						step = 'review';
						isCreating = false;
						return;
					}
					const ethAmt = Number(nativePair.amount);
					bases.push(ethers.ZeroAddress);
					baseAmounts.push(ethers.parseEther(String(ethAmt)));
					tokenAmounts.push(ethers.parseUnits(Number(nativePair.tokenAmount).toFixed(6), tokenInfo.decimals));
					ethValue = ethers.parseEther(String(ethAmt));
				}

				// ERC20 pairs
				for (const pair of erc20Pairs) {
					if (!pair.tokenAmount || Number(pair.tokenAmount) <= 0) {
						addFeedback({ message: `Missing token amount for ${pair.base} pair.`, type: 'error' });
						step = 'review';
						isCreating = false;
						return;
					}
					const baseAddress = getBaseTokenAddress(network, pair.base);
					const baseDecimals = getBaseDecimals(network, pair.base);
					const baseAmt = Number(pair.amount);
					bases.push(baseAddress);
					baseAmounts.push(ethers.parseUnits(String(baseAmt), baseDecimals));
					tokenAmounts.push(ethers.parseUnits(Number(pair.tokenAmount).toFixed(6), tokenInfo.decimals));
				}

				// tradingDelay picked by creator in the listing step (seconds).
				// Default 60s if the field wasn't set. Capped at 24h by the contract.
				const listParams = {
					bases,
					baseAmounts,
					tokenAmounts,
					burnLP: tokenInfo.listing?.burnLp ?? false,
					tradingDelay: BigInt(tokenInfo.listing.tradingDelay || '60'),
				};
				// Native value budget: fee BNB (exact-output swap, only consumes
				// what's needed) + LP BNB (wrapped to WBNB for the pair). The
				// router handles the split internally — no longer reverts when
				// both fee and LP use native.
				const nativeValue = nativeFeeWithBuffer + ethValue;

				const tx = await router.createAndList(
					tokenParams, listParams,
					protectionParams, taxParams, feePayment, referral,
					{ value: nativeValue }
				);
				deployTxHash = tx.hash;
				const receipt = await tx.wait();

				const event = receipt?.logs?.find((log: any) => {
					try { return router.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === 'TokenCreatedAndListed'; } catch { return false; }
				});
				if (event) {
					const parsed = router.interface.parseLog({ topics: [...event.topics], data: event.data });
					deployedTokenAddress = parsed?.args?.token ?? null;
				}

				addFeedback({ message: 'Token created & listed on DEX!', type: 'success' });
			} else {
				// Token-only creation via PlatformRouter.createTokenOnly
				const router = new ethers.Contract(tokenInfo.network.router_address, PLATFORM_ROUTER_ABI, signer);

				const taxParams = {
					buyTaxBps: BigInt(Math.round(parseFloat(String(tokenInfo.tax?.buyTaxPct || '0')) * 100)),
					sellTaxBps: BigInt(Math.round(parseFloat(String(tokenInfo.tax?.sellTaxPct || '0')) * 100)),
					transferTaxBps: BigInt(Math.round(parseFloat(String(tokenInfo.tax?.transferTaxPct || '0')) * 100)),
					taxWallets: tokenInfo.tax?.wallets?.map((w: any) => w.address).filter((a: string) => ethers.isAddress(a)) || [],
					taxSharesBps: tokenInfo.tax?.wallets?.map((w: any) => Math.round(parseFloat(String(w.sharePct || '0')) * 100)) || []
				};

				const protectionParams = {
					maxWalletAmount: tokenInfo.protection?.maxWalletPct
						? (totalSupplyWei * BigInt(Math.round(parseFloat(String(tokenInfo.protection.maxWalletPct)) * 100))) / 10000n
						: 0n,
					maxTransactionAmount: tokenInfo.protection?.maxTransactionPct
						? (totalSupplyWei * BigInt(Math.round(parseFloat(String(tokenInfo.protection.maxTransactionPct)) * 100))) / 10000n
						: 0n,
					cooldownSeconds: BigInt(tokenInfo.protection?.cooldownSeconds || 0)
				};

				addFeedback({ message: 'Deploying token...', type: 'info' });
				const tx = await router.createTokenOnly(
					tokenParams, protectionParams, taxParams, feePayment, referral,
					{ value: nativeFeeWithBuffer }
				);
				deployTxHash = tx.hash;
				const receipt = await tx.wait();

				const event = receipt?.logs?.find((log: any) => {
					try { return router.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === 'TokenCreated'; } catch { return false; }
				});
				if (event) {
					const parsed = router.interface.parseLog({ topics: [...event.topics], data: event.data });
					deployedTokenAddress = parsed?.args?.token ?? null;
				}

				addFeedback({ message: 'Token created successfully!', type: 'success' });
			}

			// Save token metadata to DB
			if (deployedTokenAddress) {
				const m = tokenInfo.metadata;
				let logoUrl = m?.logoUrl || '';

				// First PUT: save token info + metadata (also establishes auth session for upload)
				await apiFetch('/api/token-metadata', {
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						address: deployedTokenAddress.toLowerCase(),
						chain_id: tokenInfo.network.chain_id,
						name: tokenInfo.name,
						symbol: tokenInfo.symbol,
						total_supply: tokenInfo.totalSupply,
						decimals: tokenInfo.decimals,
						is_taxable: tokenInfo.isTaxable,
						is_mintable: tokenInfo.isMintable,
						is_partner: tokenInfo.isPartner,
						logo_url: null,
						description: m?.description || null,
						website: m?.website || null,
						twitter: m?.twitter || null,
						telegram: m?.telegram || null,
					}),
				}).catch(() => {});

				// Upload logo to our storage (session cookie set from PUT above)
				if (logoUrl) {
					try {
						let fileToUpload: File | null = (window as any).__pendingLogoFile as File | null;

						// If logo is an external URL, fetch and convert to File
						if (!fileToUpload && logoUrl.startsWith('http')) {
							const res = await fetch(logoUrl);
							if (res.ok) {
								const blob = await res.blob();
								fileToUpload = new File([blob], 'logo.png', { type: 'image/png' });
							}
						}

						// If logo is a data URL, convert to File
						if (!fileToUpload && logoUrl.startsWith('data:')) {
							const [header, b64] = logoUrl.split(',');
							const binary = atob(b64);
							const bytes = new Uint8Array(binary.length);
							for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
							fileToUpload = new File([bytes], 'logo.png', { type: 'image/png' });
						}

						if (fileToUpload) {
							const fd = new FormData();
							fd.append('file', fileToUpload);
							fd.append('address', deployedTokenAddress.toLowerCase());
							fd.append('chain_id', String(tokenInfo.network.chain_id));
							const uploadRes = await apiFetch('/api/token-metadata/upload', { method: 'POST', body: fd });
							if (uploadRes.ok) {
								const { logo_url } = await uploadRes.json();
								if (logo_url) {
									// Update DB with our storage URL
									apiFetch('/api/token-metadata', {
										method: 'PUT',
										headers: { 'Content-Type': 'application/json' },
										body: JSON.stringify({
											address: deployedTokenAddress.toLowerCase(),
											chain_id: tokenInfo.network.chain_id,
											logo_url: logo_url,
										}),
									}).catch(() => {});
								}
							}
						}
						delete (window as any).__pendingLogoFile;
					} catch {}
				}
			}

			// Auto-add token to wallet's imported tokens list
			if (deployedTokenAddress && tokenInfo) {
				try {
					const saved = JSON.parse(localStorage.getItem('imported_tokens') || '[]');
					const exists = saved.some((t: any) => t.address?.toLowerCase() === deployedTokenAddress?.toLowerCase());
					if (!exists) {
						saved.push({
							address: deployedTokenAddress.toLowerCase(),
							name: tokenInfo.name,
							symbol: tokenInfo.symbol,
							decimals: tokenInfo.decimals,
							logoUrl: tokenInfo.metadata?.logoUrl?.startsWith('data:') ? '' : tokenInfo.metadata?.logoUrl || '',
						});
						localStorage.setItem('imported_tokens', JSON.stringify(saved));
						pushPreferences();
					}
				} catch {}
			}

			step = 'done';
				try { sessionStorage.removeItem('tk_create_form_draft'); } catch {}
		} catch (e: any) {
			const msg = friendlyError(e);
			addFeedback({ message: `Error: ${msg}`, type: 'error' });
			step = 'review';
		} finally {
			isCreating = false;
		}
	}

	// Base coin helpers moved to ./lib/deploy/helpers.ts — import at top.

	async function addListingLiquidity(tokenAddress: string) {
		if (!tokenInfo || !signer || !userAddress) return;
		const listing = tokenInfo.listing;
		const network = tokenInfo.network;
		const routerAddress = DEX_ROUTERS[network.chain_id];
		if (!routerAddress) {
			addFeedback({ message: 'DEX router not configured for this network. Add liquidity manually from Manage Tokens.', type: 'error' });
			return;
		}

		const pairs = listing.pairs?.length > 0 ? listing.pairs : [{ base: listing.baseCoin, amount: listing.baseAmount || listing.listBaseAmount }];
		const price = Number(listing.pricePerToken);

		if (!price || price <= 0) {
			addFeedback({ message: 'Invalid token price. Add liquidity manually.', type: 'error' });
			return;
		}

		const router = new ethers.Contract(routerAddress, ROUTER_ABI, signer);
		const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
		const deadline = Math.floor(Date.now() / 1000) + 1200;

		try {
			// Step 1: Check balances for all pairs
			step = 'approving-listing';
			for (const pair of pairs) {
				const baseAmt = Number(pair.amount);
				if (!baseAmt || baseAmt <= 0) continue;

				const baseSymbol = getBaseSymbol(network, pair.base);
				if (pair.base !== 'native') {
					const baseAddress = getBaseTokenAddress(network, pair.base);
					const baseDecimals = getBaseDecimals(network, pair.base);
					const parsedBaseAmount = ethers.parseUnits(String(baseAmt), baseDecimals);

					// Check and approve base token
					const baseContract = new ethers.Contract(baseAddress, ERC20_ABI, signer);
					const balance = await baseContract.balanceOf(userAddress);
					if (balance < parsedBaseAmount) {
						addFeedback({ message: `Insufficient ${baseSymbol} balance. Need ${baseAmt} ${baseSymbol}.`, type: 'error' });
						return;
					}
					const allowance = await baseContract.allowance(userAddress, routerAddress);
					if (allowance < parsedBaseAmount) {
						addFeedback({ message: `Approving ${baseSymbol} for DEX router...`, type: 'info' });
						const tx = await baseContract.approve(routerAddress, parsedBaseAmount);
						await tx.wait();
					}
				}
			}

			// Step 2: Calculate total tokens needed and approve. Use pre-computed
			// pair.tokenAmount (USD-normalized) — never re-derive from baseAmt/price,
			// which mixes units across BNB/USDT/USDC and mispriced the pools.
			let totalTokensNeeded = 0n;
			for (const pair of pairs) {
				const baseAmt = Number(pair.amount);
				if (!baseAmt || baseAmt <= 0) continue;
				const tokensForPair = Number(pair.tokenAmount ?? 0);
				if (tokensForPair <= 0) {
					addFeedback({ message: `Missing token amount for ${pair.base} pair.`, type: 'error' });
					return;
				}
				totalTokensNeeded += ethers.parseUnits(tokensForPair.toFixed(6), tokenInfo.decimals);
			}

			const tokenAllowance = await tokenContract.allowance(userAddress, routerAddress);
			if (tokenAllowance < totalTokensNeeded) {
				addFeedback({ message: `Approving ${tokenInfo.symbol} for DEX router...`, type: 'info' });
				const tx = await tokenContract.approve(routerAddress, totalTokensNeeded);
				await tx.wait();
			}

			// Step 3: Add liquidity for each pair
			step = 'adding-liquidity';
			for (const pair of pairs) {
				const baseAmt = Number(pair.amount);
				if (!baseAmt || baseAmt <= 0) continue;

				const tokensForPair = Number(pair.tokenAmount ?? 0);
				if (tokensForPair <= 0) continue;
				const parsedTokenAmount = ethers.parseUnits(tokensForPair.toFixed(6), tokenInfo.decimals);
				const baseSymbol = getBaseSymbol(network, pair.base);

				if (pair.base === 'native') {
					const ethAmount = ethers.parseEther(String(baseAmt));
					addFeedback({ message: `Adding ${tokenInfo.symbol}/${baseSymbol} liquidity...`, type: 'info' });
					const tx = await router.addLiquidityETH(
						tokenAddress, parsedTokenAmount, 0n, 0n, userAddress, deadline,
						{ value: ethAmount }
					);
					await tx.wait();
				} else {
					const baseAddress = getBaseTokenAddress(network, pair.base);
					const baseDecimals = getBaseDecimals(network, pair.base);
					const parsedBaseAmount = ethers.parseUnits(String(baseAmt), baseDecimals);

					addFeedback({ message: `Adding ${tokenInfo.symbol}/${baseSymbol} liquidity...`, type: 'info' });
					const tx = await router.addLiquidity(
						tokenAddress, baseAddress,
						parsedTokenAmount, parsedBaseAmount, 0n, 0n, userAddress, deadline
					);
					await tx.wait();
				}

				addFeedback({ message: `${tokenInfo.symbol}/${baseSymbol} pair created!`, type: 'success' });
			}

			addFeedback({ message: `All ${pairs.length} liquidity pair${pairs.length > 1 ? 's' : ''} added!`, type: 'success' });
		} catch (e: any) {
			addFeedback({ message: `Liquidity failed: ${friendlyError(e)}. You can add remaining pairs manually.`, type: 'error' });
		}
	}

	async function confirmAndDeploy() {
		if (!tokenInfo) return;
		if (!signer || !userAddress) {
			deployAfterConnect = true;
			try { sessionStorage.setItem('tk_deploy_after_connect', 'true'); } catch {}
			connectWallet();
			return;
		}

		// Ensure wallet is on the correct network
		try {
			const walletProvider = signer.provider;
			if (walletProvider) {
				const walletNetwork = await walletProvider.getNetwork();
				if (Number(walletNetwork.chainId) !== tokenInfo.network.chain_id) {
					addFeedback({ message: `Switching to ${tokenInfo.network.name}...`, type: 'info' });
					const switched = await switchNetwork(tokenInfo.network.chain_id);
					if (!switched) return;
				}
			}
		} catch {
			// Can't verify network — proceed anyway, wallet will reject if wrong
		}

		isCreating = true;
		deployedTokenAddress = null;
		deployTxHash = null;
		step = 'checking-balance';
		requiredAmount = selectedFee;

		const hasFunds = await checkBalance();
		if (!hasFunds) {
			step = 'waiting-deposit';
			startBalancePolling();
			return;
		}

		await proceedAfterBalance();
	}

	function closePreview() {
		tokenInfo = null;
		showPreview = false;
		step = 'idle';
		isCreating = false;
		deployAfterConnect = false;
		deployedTokenAddress = null;
		deployTxHash = null;
		stopBalancePolling();
	}

	function shortAddr(addr: string) {
		return addr.slice(0, 10) + '...' + addr.slice(-8);
	}

	let deploySteps = $derived(() => {
		const steps = [
			{ key: 'checking-balance', label: $t('ct.stepCheckBalance') },
			{ key: 'approving', label: $t('ct.approvingSpend') },
			{ key: 'creating', label: $t('ct.deployingContract') }
		];
		if (tokenInfo?.listing?.enabled) {
			steps.push(
				{ key: 'approving-listing', label: $t('ct.approvingDex') },
				{ key: 'adding-liquidity', label: $t('ct.addingLiquidity') }
			);
		}
		return steps;
	});

	function stepStatus(stepKey: string) {
		const order = ['checking-balance', 'waiting-deposit', 'approving', 'creating', 'approving-listing', 'adding-liquidity', 'done'];
		const currentIdx = order.indexOf(step);
		const stepIdx = order.indexOf(stepKey);
		if (step === 'done') return 'done';
		if (stepKey === step || (stepKey === 'checking-balance' && step === 'waiting-deposit')) return 'active';
		if (stepIdx < currentIdx) return 'done';
		return 'pending';
	}
</script>

<svelte:head>
	<title>{pageTitle} | TokenKrafter</title>
	<meta name="description" content={mode === 'token' ? $t('ci.metaToken') : mode === 'launch' ? $t('ci.metaLaunch') : mode === 'both' ? $t('ci.metaBoth') : 'Deploy your own ERC-20 token in minutes.'} />
</svelte:head>

<!-- Review Modal -->
{#if showPreview && tokenInfo}
	<div
		class="modal-backdrop fixed inset-0 z-[80] flex items-end sm:items-center justify-center sm:p-4"
		onclick={closePreview}
	>
		<div
			class="review-modal w-full sm:max-w-md max-h-[100dvh] sm:max-h-[90vh] overflow-y-auto"
			onclick={(e) => e.stopPropagation()}
		>
			<!-- Mobile drag indicator -->
			<div class="drag-indicator sm:hidden" onclick={closePreview}>
				<div class="drag-bar"></div>
			</div>
			{#if step === 'done'}
				<div class="text-center py-8">
					<div class="text-5xl mb-4 syne font-bold text-emerald-400">{$t('ct.done')}</div>
					<h2 class="syne text-2xl font-bold text-white mb-2">
						{tokenInfo.existingTokenAddress ? 'Launch Created!' : tokenInfo.listing?.enabled ? $t('ct.deployedListed') : tokenInfo.launch?.enabled ? 'Token Deployed & Launched!' : $t('ct.deployed')}
					</h2>
					<p class="text-gray-400 font-mono text-sm mb-4">
						{$t('ct.liveOn')} {tokenInfo.network.name}.{tokenInfo.listing?.enabled ? ' ' + $t('ct.liqAdded') : ''}
					</p>

					{#if deployedTokenAddress}
						<div class="deployed-address-box mb-4">
							<div class="text-gray-500 text-[11px] font-mono uppercase tracking-wider mb-1">{$t('ct.tokenAddress')}</div>
							<div class="text-cyan-400 text-xs font-mono break-all mb-2">{deployedTokenAddress}</div>
							<a
								href={getExplorerUrl(tokenInfo.network.chain_id, 'address', deployedTokenAddress)}
								target="_blank"
								rel="noopener noreferrer"
								class="text-cyan-500 text-xs font-mono hover:text-cyan-300 transition no-underline"
							>{$t('ct.viewExplorer')} -></a>
						</div>
					{/if}

					{#if deployTxHash}
						<div class="mb-6">
							<a
								href={getExplorerUrl(tokenInfo.network.chain_id, 'tx', deployTxHash)}
								target="_blank"
								rel="noopener noreferrer"
								class="text-gray-500 text-[11px] font-mono hover:text-gray-300 transition no-underline"
							>View transaction: {deployTxHash.slice(0, 10)}...{deployTxHash.slice(-8)} -></a>
						</div>
					{/if}

					<div class="flex gap-3 justify-center">
						<a href={deployedTokenAddress ? `/manage-tokens?just_created=${deployedTokenAddress}&chain=${tokenInfo.network.chain_id}` : '/manage-tokens'} class="btn-primary text-sm px-5 py-2.5 no-underline">
							{$t('ct.manageTokens')} ->
						</a>
						<button onclick={closePreview} class="btn-secondary text-sm px-5 py-2.5 cursor-pointer">
							{$t('ct.close')}
						</button>
					</div>
				</div>

			{:else if step === 'waiting-deposit'}
				<!-- Deposit payment screen -->
				<div class="deposit-screen">
					<div class="modal-header mb-2">
						<h2 class="syne text-lg font-bold text-white">Deposit to Continue</h2>
						<button onclick={closePreview} class="close-btn cursor-pointer">x</button>
					</div>

					<div class="deposit-amount">
						<span class="deposit-amount-label">Send at least</span>
						<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
						<div class="deposit-amount-copy" onclick={() => { navigator.clipboard.writeText(depositShortFmt); addFeedback({ message: 'Amount copied', type: 'success' }); }}>
							<span class="deposit-amount-value">{depositShortFmt} {selectedPayment?.symbol}</span>
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
						</div>
						<span class="deposit-amount-bal">Balance: {parseFloat(ethers.formatUnits(userBalance, selectedPayment?.decimals ?? 18)).toFixed(4)} {selectedPayment?.symbol}</span>
					</div>

					<div class="deposit-qr-row">
						<div class="qr-placeholder">
							<QrCode data={userAddress || ''} width={120} colorDark="#000000" colorLight="#ffffff" margin={6} />
						</div>
						<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
						<div class="deposit-addr-info" onclick={() => { navigator.clipboard.writeText(userAddress || ''); addFeedback({ message: 'Address copied', type: 'success' }); }}>
							<span class="deposit-addr-label">Deposit address</span>
							<span class="deposit-addr">{userAddress}</span>
							<div class="deposit-addr-actions">
								<span class="deposit-copy-btn">
									<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
									Copy
								</span>
								<span class="deposit-network">{tokenInfo.network.name} only</span>
							</div>
						</div>
					</div>

					<div class="deposit-status">
						<div class="spinner-sm w-3 h-3 rounded-full border-2 border-white/10 border-t-cyan-400"></div>
						<span>Waiting for deposit...</span>
					</div>

					<button onclick={closePreview} class="btn-secondary text-sm py-2 cursor-pointer w-full">
						Cancel
					</button>
				</div>

			{:else if step !== 'idle' && step !== 'review'}
				<!-- Progress view — redesigned stepper -->
				<div class="deploy-progress">
					<div class="dp-header">
						<h2 class="dp-title">Deploying your token</h2>
						<p class="dp-sub">Please wait — do not close this window</p>
					</div>

					<div class="dp-steps">
						{#each deploySteps() as ds, i}
							{@const status = stepStatus(ds.key)}
							{@const isSkipped = ds.key === 'approving' && isNativePayment}
							<div class="dp-step" class:dp-done={status === 'done' || isSkipped} class:dp-active={status === 'active' && !isSkipped} class:dp-pending={status === 'pending'}>
								<div class="dp-step-icon">
									{#if status === 'done' || isSkipped}
										<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
									{:else if status === 'active'}
										<div class="dp-spinner"></div>
									{:else}
										<span class="dp-num">{i + 1}</span>
									{/if}
								</div>
								<div class="dp-step-info">
									<span class="dp-step-label">{ds.label}</span>
									{#if isSkipped}<span class="dp-skipped">Skipped</span>{/if}
								</div>
							</div>
							{#if i < deploySteps().length - 1}
								<div class="dp-line" class:dp-line-done={status === 'done' || isSkipped}></div>
							{/if}
						{/each}
					</div>

					{#if deployTxHash && tokenInfo}
						<a href={getExplorerUrl(tokenInfo.network.chain_id, 'tx', deployTxHash)}
							target="_blank" rel="noopener" class="dp-tx-link">
							View transaction →
						</a>
					{/if}
				</div>

			{:else}
				<!-- Payment-focused review -->
				<div class="modal-header">
					<h2 class="syne text-xl font-bold text-white">Confirm Payment</h2>
					<button onclick={closePreview} class="close-btn cursor-pointer">x</button>
				</div>

				<!-- Token identifier (one line) -->
				<div class="review-id">
					<span class="review-token-name">{tokenInfo.name} ({tokenInfo.symbol})</span>
					<span class="review-token-chain">{tokenInfo.network.name}</span>
				</div>
				<div class="review-badges">
					{#if tokenInfo.isMintable}<span class="badge badge-cyan">Mintable</span>{/if}
					{#if tokenInfo.isTaxable}<span class="badge badge-amber">Taxable</span>{/if}
					{#if tokenInfo.isPartner}<span class="badge badge-purple">Partner</span>{/if}
					{#if tokenInfo.listing?.enabled}<span class="badge badge-emerald">DEX Listing</span>{/if}
					{#if tokenInfo.launch?.enabled}<span class="badge badge-emerald">Launch</span>{/if}
					{#if !tokenInfo.isMintable && !tokenInfo.isTaxable && !tokenInfo.isPartner && !tokenInfo.listing?.enabled && !tokenInfo.launch?.enabled}<span class="badge badge-emerald">Standard</span>{/if}
				</div>

				<!-- Cost Breakdown -->
				<div class="modal-section fee-section">
					<div class="receipt">
						<div class="receipt-row">
							<span class="receipt-label">Creation fee (USDT)</span>
							<span class="receipt-value">{feeLoading ? '...' : `$${feeUsdAmount}`}</span>
						</div>

						{#if tokenInfo.listing?.enabled}
							{#each (tokenInfo.listing.pairs || []).filter(p => Number(p.amount) > 0) as pair}
								{@const baseLabel = pair.base === 'native' ? tokenInfo.network.native_coin : pair.base.toUpperCase()}
								<div class="receipt-row">
									<span class="receipt-label">Liquidity ({tokenInfo.symbol}/{baseLabel})</span>
									<span class="receipt-value">{pair.amount} {baseLabel}</span>
								</div>
							{/each}
						{/if}

						{#if tokenInfo.launch?.enabled}
							<div class="receipt-row">
								<span class="receipt-label">Launch fee (on graduation)</span>
								<span class="receipt-value receipt-note">1% of raised</span>
							</div>
						{/if}

						<div class="receipt-divider"></div>
						<div class="receipt-row receipt-total">
							<span class="receipt-label">You pay now</span>
							<span class="receipt-value">
								{#if feeLoading}...
								{:else}
									{@const payAddr = selectedPayment?.address?.toLowerCase() || ''}
									{@const listPairs = tokenInfo.listing?.enabled ? (tokenInfo.listing.pairs || []).filter((p) => Number(p.amount) > 0) : []}
									{@const mergedLpAmount = listPairs
										.filter((p) => getBaseTokenAddress(tokenInfo.network, p.base).toLowerCase() === payAddr)
										.reduce((sum, p) => sum + Number(p.amount), 0)}
									{@const separatePairs = listPairs
										.filter((p) => getBaseTokenAddress(tokenInfo.network, p.base).toLowerCase() !== payAddr)}
									{@const feeNum = parseFloat(selectedFeeDisplay || '0')}
									{@const total = feeNum + mergedLpAmount}
									{parseFloat(total.toFixed(6))} {selectedPayment?.symbol}{#each separatePairs as pair}{@const sym = getBaseSymbol(tokenInfo.network, pair.base)} + {parseFloat(Number(pair.amount).toFixed(6))} {sym}{/each}
								{/if}
							</span>
						</div>
					</div>
						<p class="receipt-hint">Fee is denominated in USDT. Pay with any token — it's auto-converted.</p>

					{#if !feeLoading && paymentOptions.length > 0}
						<div class="pay-method-section mt-3">
							<span class="pay-method-label">Pay with</span>
							<button class="pay-method-card" onclick={() => { showPaymentModal = true; loadPaymentQuotes(); }}>
								{#if COIN_LOGOS[selectedPayment?.symbol?.toUpperCase()]}
								<img src={COIN_LOGOS[selectedPayment.symbol.toUpperCase()]} alt={selectedPayment.symbol} class="pay-method-logo" />
							{:else}
								<span class="pay-method-icon">{selectedPayment?.symbol?.charAt(0) || '?'}</span>
							{/if}
								<div class="pay-method-info">
									<span class="pay-method-name">{selectedPayment?.symbol}</span>
									<span class="pay-method-amount">{selectedFeeDisplay} {selectedPayment?.symbol}</span>
								</div>
								<svg class="pay-method-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
							</button>
						</div>

						<!-- Payment method modal (styled like the trade page token selector) -->
						{#if showPaymentModal}
							<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
							<div class="pm-backdrop" onclick={() => showPaymentModal = false}
								role="dialog" aria-modal="true"
							>
								<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
								<div class="pm-modal" onclick={(e) => e.stopPropagation()}>
									<div class="pm-header">
										<h3>Select payment</h3>
										<button class="pm-close" onclick={() => showPaymentModal = false}>
											<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
										</button>
									</div>

									<input
										class="input-field pm-search"
										placeholder="0x... paste token address to import"
										bind:value={payImportAddr}
										disabled={payImportBusy}
										onkeydown={(e) => { if (e.key === 'Enter') importPaymentToken(); }}
									/>
									{#if payImportError}
										<p class="pm-import-error">{payImportError}</p>
									{/if}
									{#if payImportAddr.trim() && ethers.isAddress(payImportAddr.trim())}
										<div class="pm-import-row">
											<button class="pm-import-btn" disabled={payImportBusy} onclick={importPaymentToken}>
												{payImportBusy ? 'Resolving...' : 'Import token'}
											</button>
										</div>
									{/if}

									<div class="pm-list">
										{#if quoteFeeLoading}
											<div class="pm-loading">
												<div class="pm-spinner"></div>
												<span>Loading quotes...</span>
											</div>
										{/if}
										{#each paymentOptions as opt, i}
											{@const bal = paymentBalances[i] ?? 0n}
											{@const quote = paymentQuotes[i] ?? 0n}
											{@const fmtBal = parseFloat(ethers.formatUnits(bal, opt.decimals)).toFixed(4)}
											{@const fmtQuote = quote > 0n ? parseFloat(ethers.formatUnits(quote * 101n / 100n, opt.decimals)).toFixed(4) : '—'}
											<button class="pm-item" class:pm-item-active={selectedPaymentIndex === i}
												onclick={() => { selectedPaymentIndex = i; showPaymentModal = false; }}>
												{#if COIN_LOGOS[opt.symbol.toUpperCase()]}
													<img src={COIN_LOGOS[opt.symbol.toUpperCase()]} alt={opt.symbol} class="pm-logo" />
												{:else}
													<div class="pm-logo-placeholder">{opt.symbol.charAt(0)}</div>
												{/if}
												<div class="pm-info">
													<span class="pm-sym">{opt.symbol}</span>
													<span class="pm-name">{opt.name}</span>
												</div>
												<div class="pm-right">
													<span class="pm-fee">{fmtQuote}</span>
													<span class="pm-bal">{fmtBal}</span>
												</div>
												{#if selectedPaymentIndex === i}
													<span class="pm-check">&#10003;</span>
												{/if}
											</button>
										{/each}
									</div>
								</div>
							</div>
						{/if}
					{/if}
				</div>

				{@const _minBuy = tokenInfo.launch?.enabled ? parseFloat(String(tokenInfo.launch.minBuyUsdt || '0')) : 0}
				{@const _maxBuyPerWalletUsd = tokenInfo.launch?.enabled
					? parseFloat(String(tokenInfo.launch.hardCap || '0')) * (parseFloat(String(tokenInfo.launch.maxBuyBps || '0')) / 10000)
					: 0}
				{@const _minBuyExceedsMaxBuy = tokenInfo.launch?.enabled && _minBuy > 0 && _maxBuyPerWalletUsd > 0 && _minBuy > _maxBuyPerWalletUsd}
				{#if _minBuyExceedsMaxBuy}
					<div class="wz-warn-box" style="margin: 8px 0 12px;">
						<strong>Min buy exceeds max buy per wallet.</strong>
						With hard cap ${tokenInfo.launch.hardCap} × max wallet {(parseFloat(String(tokenInfo.launch.maxBuyBps)) / 100).toFixed(2)}% = ${_maxBuyPerWalletUsd.toFixed(2)} max buy, but min buy is ${tokenInfo.launch.minBuyUsdt}. Go back and fix the launch config.
					</div>
				{/if}
				<button
					onclick={confirmAndDeploy}
					disabled={feeLoading || paymentOptions.length === 0 || _minBuyExceedsMaxBuy}
					class="create-btn w-full syne cursor-pointer"
				>
					{feeLoading ? $t('ct.calculatingFee') : tokenInfo.existingTokenAddress ? 'Create Launch' : tokenInfo.listing?.enabled ? $t('ct.deployAndList') : tokenInfo.launch?.enabled ? 'Deploy & Launch' : $t('ct.confirmDeploy')}
				</button>
			{/if}
		</div>
	</div>
{/if}

<!-- Page -->
<div class="page-container max-w-6xl mx-auto px-3 sm:px-6 py-6 sm:py-12">

	{#if mode === null}
		<!-- ═══════ INTENT SELECTION ═══════ -->
		<div class="sel-header">
			<h1 class="sel-title">What do you want to build?</h1>
			<p class="sel-sub">Choose how to deploy your token</p>
		</div>

		<div class="sel-grid">
			<!-- Featured: Create + Launch -->
			<button class="sel-card sel-featured" onclick={() => selectMode('both')}>
				<div class="sel-card-glow"></div>
				<div class="sel-card-inner">
					<div class="sel-tag">
						<svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
						Recommended
					</div>
					<div class="sel-icon sel-icon-cyan">
						<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
					</div>
					<h3 class="sel-name">Create & Launch</h3>
					<p class="sel-desc">Deploy token + bonding curve fundraise. Graduates to DEX automatically.</p>
					<div class="sel-features">
						<span>Bonding curve</span>
						<span>Auto DEX listing</span>
						<span>Anti-whale</span>
					</div>
				</div>
			</button>

			<!-- Create + List on DEX -->
			<button class="sel-card" onclick={() => selectMode('list')}>
				<div class="sel-card-inner">
					<div class="sel-icon sel-icon-amber">
						<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
					</div>
					<h3 class="sel-name">Create & List on DEX</h3>
					<p class="sel-desc">Deploy and add liquidity to PancakeSwap in one transaction.</p>
					<div class="sel-features">
						<span>Instant trading</span>
						<span>Set your price</span>
					</div>
				</div>
			</button>

			<!-- Create Token Only -->
			<button class="sel-card" onclick={() => selectMode('token')}>
				<div class="sel-card-inner">
					<div class="sel-icon sel-icon-default">
						<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v12M6 12h12"/></svg>
					</div>
					<h3 class="sel-name">Deploy Token Only</h3>
					<p class="sel-desc">Create your ERC-20 token. Add liquidity or launch later.</p>
					<div class="sel-features">
						<span>Fastest</span>
						<span>Flexible</span>
					</div>
				</div>
			</button>

			<!-- Launch Existing Token -->
			<button class="sel-card" onclick={() => selectMode('launch')}>
				<div class="sel-card-inner">
					<div class="sel-icon sel-icon-emerald">
						<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/></svg>
					</div>
					<h3 class="sel-name">Launch Existing Token</h3>
					<p class="sel-desc">Already have a token? Create a bonding curve launch for it.</p>
					<div class="sel-features">
						<span>Bring your token</span>
						<span>Fundraise</span>
					</div>
				</div>
			</button>
		</div>

	{:else}
		<!-- ═══════ TOKEN CREATION WIZARD ═══════ -->
		<div class="create-split">
			<div class="form-wrapper">
				<button class="back-link" onclick={() => selectMode(null)} title="Change create mode">
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
					Change mode
				</button>
				<div class="form-header">
					<span class="badge badge-cyan">{mode === 'token' ? $t('ci.titleToken') : mode === 'launch' ? $t('ci.titleLaunch') : mode === 'list' ? 'Create & List' : $t('ci.titleBoth')}</span>
					<h1 class="syne text-2xl sm:text-3xl font-bold text-white mt-3 mb-1">{pageTitle}</h1>
					<p class="text-gray-500 font-mono text-sm">{mode === 'token' ? $t('ci.metaToken') : mode === 'launch' ? $t('ci.metaLaunch') : mode === 'list' ? 'Create and list your token on a DEX.' : $t('ci.metaBoth')}</p>
				</div>
				<TokenForm {supportedNetworks} {addFeedback} {updateTokenInfo} onPreviewChange={handlePreviewChange} initialData={initialFormData} initialMode={mode} onModeChange={handleModeChange} {resetSignal} />
			</div>
			{#if previewState}
				<div class="create-preview-col">
					<DisplayPreview
						name={previewState.name}
						symbol={previewState.symbol}
						totalSupply={previewState.totalSupply}
						decimals={previewState.decimals}
						isMintable={previewState.isMintable}
						isTaxable={previewState.isTaxable}
						isPartner={previewState.isPartner}
						networkName={previewState.networkName}
						launchEnabled={previewState.launchEnabled}
						launchTokensPct={previewState.launchTokensPct}
						launchCurveType={previewState.launchCurveType}
						launchSoftCap={previewState.launchSoftCap}
						launchHardCap={previewState.launchHardCap}
						protectionEnabled={previewState.protectionEnabled}
						maxWalletPct={previewState.maxWalletPct}
						maxTransactionPct={previewState.maxTransactionPct}
						buyTaxPct={previewState.buyTaxPct}
						sellTaxPct={previewState.sellTaxPct}
						transferTaxPct={previewState.transferTaxPct}
						wizardStep={previewState.wizardStep}
						logoUrl={previewState.logoUrl}
						description={previewState.description}
						website={previewState.website}
						twitter={previewState.twitter}
						telegram={previewState.telegram}
					/>
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.create-split { display: flex; gap: 28px; align-items: flex-start; }
	.create-split > .form-wrapper { flex: 1; min-width: 0; max-width: none; }
	.create-preview-col {
		width: 320px; flex-shrink: 0;
		position: sticky; top: 80px;
		max-height: calc(100vh - 100px);
		overflow-y: auto; overflow-x: hidden;
		scrollbar-width: thin;
		scrollbar-color: rgba(255,255,255,0.1) transparent;
	}
	.create-preview-col::-webkit-scrollbar { width: 4px; }
	.create-preview-col::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }
	@media (max-width: 1000px) { .create-preview-col { display: none; } .create-split { display: block; } }

	.page-grid {
		display: grid;
		grid-template-columns: 1fr;
		gap: 32px;
	}
	@media (min-width: 1024px) {
		.page-grid {
			grid-template-columns: 1fr;
		}
		.info-col {
			align-self: stretch;
			position: relative;
			
		}
	}

	.modal-backdrop {
		background: rgba(0,0,0,0.7);
		backdrop-filter: blur(6px);
	}

	.review-modal {
		background: var(--bg);
		border: 1px solid var(--border-input);
		border-radius: 20px 20px 0 0;
		padding: 16px;
		padding-bottom: calc(16px + env(safe-area-inset-bottom, 0px));
		animation: modalSlideUp 0.25s ease-out;
		scrollbar-width: none;
		-ms-overflow-style: none;
		min-height: 60vh;
	}
	.review-modal::-webkit-scrollbar { display: none; }
	@media (min-width: 640px) {
		.review-modal {
			padding: 24px;
			border-radius: 20px;
			min-height: auto;
			animation: modalIn 0.2s ease-out;
		}
	}
	@keyframes modalSlideUp {
		from { opacity: 0; transform: translateY(100%); }
		to   { opacity: 1; transform: translateY(0); }
	}

	.drag-indicator {
		display: flex;
		justify-content: center;
		padding: 8px 0 4px;
		cursor: pointer;
	}
	.drag-bar {
		width: 36px;
		height: 4px;
		background: var(--border);
		border-radius: 2px;
	}
	@keyframes modalIn {
		from { opacity:0; transform: scale(0.95) translateY(8px); }
		to   { opacity:1; transform: scale(1) translateY(0); }
	}

	.modal-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 20px;
	}

	.close-btn {
		width: 32px; height: 32px;
		border-radius: 8px;
		background: var(--bg-surface-hover);
		border: none;
		color: var(--text-muted);
		display: flex; align-items: center; justify-content: center;
		transition: all 0.15s;
		font-size: 14px;
	}
	.close-btn:hover { background: var(--bg-surface-hover); color: var(--text-heading); }

	.modal-section { margin-bottom: 16px; padding-bottom: 16px; border-bottom: 1px solid var(--bg-surface-hover); }

	.fee-section { background: rgba(0,210,255,0.03); border-radius: 10px; padding: 14px; border-color: rgba(0,210,255,0.1); }

	/* Review payment modal */
	.review-id {
		display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px;
	}
	.review-token-name { font-family: 'Syne', sans-serif; font-size: 15px; font-weight: 700; color: var(--text-heading); }
	.review-token-chain { font-size: 10px; color: #00d2ff; font-family: 'Space Mono', monospace; }
	.review-badges { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 12px; }

	/* Deploy progress stepper */
	.deploy-progress { padding: 8px 0; }
	.dp-header { text-align: center; margin-bottom: 20px; }
	.dp-title { font-family: 'Syne', sans-serif; font-size: 18px; font-weight: 800; color: var(--text-heading); margin: 0; }
	.dp-sub { font-size: 11px; color: var(--text-dim); font-family: 'Space Mono', monospace; margin: 4px 0 0; }
	.dp-steps { display: flex; flex-direction: column; gap: 0; padding: 0 8px; }
	.dp-step {
		display: flex; align-items: center; gap: 12px; padding: 10px 0;
	}
	.dp-step-icon {
		width: 28px; height: 28px; border-radius: 50%; flex-shrink: 0;
		display: flex; align-items: center; justify-content: center;
		border: 2px solid var(--border); background: transparent;
		transition: all 0.3s;
	}
	.dp-done .dp-step-icon { border-color: #10b981; color: #10b981; background: rgba(16,185,129,0.1); }
	.dp-active .dp-step-icon { border-color: #00d2ff; background: rgba(0,210,255,0.1); }
	.dp-pending .dp-step-icon { border-color: var(--border); }
	.dp-num { font-family: 'Space Mono', monospace; font-size: 10px; color: var(--text-dim); }
	.dp-spinner {
		width: 14px; height: 14px; border: 2px solid rgba(0,210,255,0.2);
		border-top-color: #00d2ff; border-radius: 50%; animation: spin 0.8s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }
	.dp-step-info { flex: 1; }
	.dp-step-label { font-family: 'Space Mono', monospace; font-size: 12px; color: var(--text); }
	.dp-done .dp-step-label { color: #10b981; }
	.dp-active .dp-step-label { color: #00d2ff; }
	.dp-pending .dp-step-label { color: var(--text-dim); }
	.dp-skipped { font-size: 9px; color: var(--text-dim); font-family: 'Space Mono', monospace; margin-left: 6px; }
	.dp-line { width: 2px; height: 16px; background: var(--bg-surface-input); margin-left: 13px; transition: background 0.3s; }
	.dp-line-done { background: #10b981; }
	.dp-tx-link {
		display: block; text-align: center; margin-top: 16px; padding: 8px;
		font-size: 11px; color: #00d2ff; font-family: 'Space Mono', monospace;
		text-decoration: none; transition: opacity 0.12s;
	}
	.dp-tx-link:hover { opacity: 0.7; }

	/* Payment method card + modal */
	.pay-method-section { display: flex; flex-direction: column; gap: 6px; }
	.pay-method-label { font-size: 9px; color: var(--text-dim); font-family: 'Space Mono', monospace; text-transform: uppercase; letter-spacing: 0.04em; }
	.pay-method-card {
		display: flex; align-items: center; gap: 10px; width: 100%;
		padding: 10px 12px; border-radius: 10px;
		background: var(--bg-surface); border: 1px solid var(--border);
		cursor: pointer; transition: border-color 0.12s; font-family: inherit; color: inherit; text-align: left;
	}
	.pay-method-card:hover { border-color: rgba(0,210,255,0.2); }
	.pay-method-icon {
		width: 32px; height: 32px; border-radius: 50%;
		background: rgba(0,210,255,0.08); border: 1px solid rgba(0,210,255,0.15);
		display: flex; align-items: center; justify-content: center;
		font-family: 'Syne', sans-serif; font-size: 12px; font-weight: 800; color: #00d2ff; flex-shrink: 0;
	}
	.pay-method-logo { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; flex-shrink: 0; }
	.pay-method-info { flex: 1; }
	.pay-method-name { display: block; font-family: 'Syne', sans-serif; font-size: 13px; font-weight: 700; color: var(--text-heading); }
	.pay-method-amount { display: block; font-family: 'Rajdhani', sans-serif; font-size: 12px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
	.pay-method-chev { color: var(--text-dim); flex-shrink: 0; }

	/* ═══ PAYMENT MODAL (trade-page style) ═══ */
	.pm-backdrop {
		position: fixed; inset: 0; z-index: 100; background: rgba(0,0,0,0.7);
		backdrop-filter: blur(4px); display: flex; align-items: flex-start;
		justify-content: center; padding: 60px 16px;
	}
	.pm-modal {
		width: 100%; max-width: 420px; max-height: 80vh;
		background: var(--bg, #0a0b10); border: 1px solid var(--border, rgba(255,255,255,0.06));
		border-radius: 20px; overflow: hidden; display: flex; flex-direction: column;
	}
	.pm-header {
		display: flex; justify-content: space-between; align-items: center;
		padding: 16px 20px; border-bottom: 1px solid var(--border, rgba(255,255,255,0.06));
	}
	.pm-header h3 {
		font-family: 'Syne', sans-serif; font-size: 16px; font-weight: 700;
		color: var(--text-heading, #fff); margin: 0;
	}
	.pm-close {
		background: none; border: none; color: var(--text-muted, #64748b); cursor: pointer;
		padding: 4px; border-radius: 8px; transition: all 150ms;
	}
	.pm-close:hover { color: var(--text, #e2e8f0); background: var(--bg-surface-hover, rgba(255,255,255,0.04)); }
	.pm-search { margin: 12px 16px; width: calc(100% - 32px); }
	.pm-import-error { font-size: 11px; color: #f87171; font-family: 'Space Mono', monospace; padding: 0 16px 8px; margin: 0; }
	.pm-import-row { padding: 0 16px 10px; }
	.pm-import-btn {
		width: 100%; padding: 8px; border-radius: 10px; border: 1px solid rgba(139,92,246,0.2);
		background: rgba(139,92,246,0.1); color: #a78bfa; cursor: pointer;
		font-family: 'Space Mono', monospace; font-size: 12px; font-weight: 700;
		transition: all 150ms;
	}
	.pm-import-btn:hover { background: rgba(139,92,246,0.2); }
	.pm-import-btn:disabled { opacity: 0.5; cursor: not-allowed; }
	.pm-list {
		overflow-y: auto; padding: 0 8px 8px; flex: 1;
		scrollbar-width: thin; scrollbar-color: var(--bg-surface-hover, rgba(255,255,255,0.04)) transparent;
	}
	.pm-loading {
		display: flex; align-items: center; justify-content: center; gap: 8px;
		padding: 16px; color: var(--text-muted, #64748b);
		font-family: 'Space Mono', monospace; font-size: 11px;
	}
	.pm-spinner {
		width: 16px; height: 16px; border: 2px solid var(--border, rgba(255,255,255,0.06));
		border-top-color: #00d2ff; border-radius: 50%; animation: spin 0.8s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }
	.pm-item {
		display: flex; align-items: center; gap: 10px; width: 100%;
		padding: 10px 12px; border-radius: 12px; border: 1px solid transparent;
		background: transparent; cursor: pointer; transition: all 150ms; text-align: left;
	}
	.pm-item:hover { background: var(--bg-surface-hover, rgba(255,255,255,0.03)); }
	.pm-item-active { border-color: rgba(0,210,255,0.2); background: rgba(0,210,255,0.03); }
	.pm-logo { width: 36px; height: 36px; border-radius: 50%; object-fit: cover; flex-shrink: 0; }
	.pm-logo-placeholder {
		width: 36px; height: 36px; border-radius: 50%; flex-shrink: 0;
		display: flex; align-items: center; justify-content: center;
		background: rgba(0,210,255,0.08); color: #00d2ff; border: 1px solid rgba(0,210,255,0.15);
		font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 700;
	}
	.pm-info { flex: 1; min-width: 0; }
	.pm-sym { display: block; font-family: 'Space Mono', monospace; font-size: 13px; font-weight: 700; color: var(--text-heading, #e2e8f0); }
	.pm-name { display: block; font-family: 'Space Mono', monospace; font-size: 10px; color: var(--text-muted, #475569); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.pm-right { text-align: right; flex-shrink: 0; }
	.pm-fee { display: block; font-family: 'Rajdhani', sans-serif; font-size: 14px; font-weight: 600; color: var(--text-heading, #e2e8f0); font-variant-numeric: tabular-nums; }
	.pm-bal { display: block; font-family: 'Space Mono', monospace; font-size: 10px; color: var(--text-dim, #374151); }
	.pm-check { color: #10b981; font-size: 14px; flex-shrink: 0; margin-left: 4px; }
	@media (max-width: 640px) {
		.pm-backdrop { padding: 0; align-items: flex-end; }
		.pm-modal { max-width: 100%; border-radius: 20px 20px 0 0; max-height: 85vh; }
	}

	.receipt { display: flex; flex-direction: column; gap: 0; }
	.receipt-row {
		display: flex; justify-content: space-between; align-items: center;
		padding: 6px 0; font-family: 'Space Mono', monospace; font-size: 11px;
	}
	.receipt-label { color: var(--text-dim); }
	.receipt-value { color: var(--text); font-weight: 600; font-family: 'Rajdhani', sans-serif; font-size: 13px; font-variant-numeric: tabular-nums; text-align: right; }
	.receipt-note { color: var(--text-dim); font-weight: 400; font-size: 10px; font-family: 'Space Mono', monospace; }
	.receipt-divider { height: 1px; background: var(--bg-surface-hover); margin: 6px 0; }
	.receipt-total .receipt-label { color: var(--text-heading); font-weight: 700; }
	.receipt-total .receipt-value { color: #00d2ff; font-size: 15px; font-weight: 700; }
	.receipt-hint { font-size: 9px; color: var(--text-dim); font-family: 'Space Mono', monospace; margin-top: 6px; opacity: 0.7; }

	.payment-summary {
		padding: 10px 12px;
		background: rgba(0,210,255,0.05);
		border: 1px solid rgba(0,210,255,0.15);
		border-radius: 8px;
	}

	.create-btn {
		width: 100%;
		padding: 14px;
		background: linear-gradient(135deg, #00d2ff, #3a7bd5);
		color: var(--text-heading);
		font-weight: 700;
		font-size: 15px;
		border: none;
		border-radius: 12px;
		cursor: pointer;
		transition: all 0.2s;
		margin-top: 8px;
	}
	.create-btn:hover:not(:disabled) {
		transform: translateY(-1px);
		box-shadow: 0 8px 32px rgba(0,210,255,0.3);
	}
	.create-btn:disabled { opacity: 0.5; cursor: not-allowed; }

	.wz-warn-box { padding: 12px 14px; border-radius: 10px; background: rgba(251, 191, 36, 0.08); border: 1px solid rgba(251, 191, 36, 0.35); color: #fcd34d; font-size: 13px; line-height: 1.5; }
	.wz-warn-box strong { display: block; color: #fde68a; margin-bottom: 4px; font-family: 'Syne', sans-serif; }

	.insufficient-box {
		padding: 14px;
		background: rgba(245,158,11,0.08);
		border: 1px solid rgba(245,158,11,0.2);
		border-radius: 10px;
	}

	/* Deposit screen */
	.deposit-screen { display: flex; flex-direction: column; gap: 12px; }
	.deposit-amount { text-align: center; padding: 10px; background: rgba(0,210,255,0.04); border: 1px solid rgba(0,210,255,0.1); border-radius: 10px; }
	.deposit-amount-label { display: block; font-size: 10px; color: var(--text-dim); font-family: 'Space Mono', monospace; }
	.deposit-amount-value { display: block; font-family: 'Rajdhani', sans-serif; font-size: 26px; font-weight: 700; color: #00d2ff; font-variant-numeric: tabular-nums; }
	.deposit-amount-bal { display: block; font-size: 9px; color: #f59e0b; font-family: 'Space Mono', monospace; }
	.deposit-qr-row { display: flex; align-items: center; gap: 14px; padding: 12px; background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 10px; }
	.deposit-amount-copy {
		display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
		transition: opacity 0.12s; justify-content: center;
	}
	.deposit-amount-copy:hover { opacity: 0.8; }
	.deposit-amount-copy svg { color: var(--text-dim); }
	.deposit-addr-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; cursor: pointer; transition: opacity 0.12s; }
	.deposit-addr-info:hover { opacity: 0.8; }
	.deposit-addr-label { font-size: 9px; color: var(--text-dim); font-family: 'Space Mono', monospace; text-transform: uppercase; letter-spacing: 0.04em; }
	.deposit-addr { font-size: 10px; color: var(--text); font-family: 'Space Mono', monospace; word-break: break-all; line-height: 1.5; }
	.deposit-addr-actions { display: flex; align-items: center; gap: 8px; }
	.deposit-copy-btn { display: inline-flex; align-items: center; gap: 3px; font-size: 9px; color: #00d2ff; font-family: 'Space Mono', monospace; }
	.deposit-network { font-size: 9px; color: #f59e0b; font-family: 'Space Mono', monospace; }
	.deposit-status { display: flex; align-items: center; justify-content: center; gap: 6px; font-size: 10px; color: var(--text-dim); font-family: 'Space Mono', monospace; }

	.qr-section { display: flex; flex-direction: column; align-items: center; }
	.qr-placeholder {
		padding: 8px;
		background: #fff;
		border-radius: 10px;
		display: inline-block;
	}
	.qr-img {
		width: 120px;
		height: 120px;
		border-radius: 4px;
		display: block;
	}
	.address-box {
		padding: 8px 14px;
		background: rgba(0,210,255,0.05);
		border: 1px solid rgba(0,210,255,0.15);
		border-radius: 8px;
		max-width: 100%;
		word-break: break-all;
	}

	.deposit-notice {
		padding: 10px 14px;
		background: rgba(245,158,11,0.06);
		border: 1px solid rgba(245,158,11,0.15);
		border-radius: 8px;
		text-align: left;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.deployed-address-box {
		padding: 12px 14px;
		background: rgba(0,210,255,0.04);
		border: 1px solid rgba(0,210,255,0.15);
		border-radius: 10px;
		text-align: center;
	}

	select option { background: var(--select-bg); color: var(--text-heading); }

	/* ─── Intent Selection Grid ─── */
	/* ── Selection screen ── */
	.sel-header { text-align: center; margin-bottom: 28px; }
	.sel-title { font-family: 'Syne', sans-serif; font-size: 28px; font-weight: 800; color: var(--text-heading); margin: 0; }
	.sel-sub { font-size: 13px; color: var(--text-dim); font-family: 'Space Mono', monospace; margin: 6px 0 0; }

	.sel-grid { display: grid; grid-template-columns: 1fr; gap: 10px; max-width: 640px; margin: 0 auto; }
	@media (min-width: 640px) { .sel-grid { grid-template-columns: 1fr 1fr; } }

	.sel-card {
		position: relative; border-radius: 14px; overflow: hidden;
		background: var(--bg-surface); border: 1px solid var(--border-subtle);
		cursor: pointer; transition: all 0.2s; text-align: left;
		font-family: inherit; color: inherit;
	}
	.sel-card:hover { border-color: rgba(0,210,255,0.2); transform: translateY(-2px); box-shadow: 0 8px 30px rgba(0,0,0,0.2); }
	.sel-card-inner { padding: 20px; display: flex; flex-direction: column; gap: 8px; position: relative; z-index: 1; }

	.sel-featured { grid-column: 1 / -1; border-color: rgba(0,210,255,0.15); }
	.sel-featured .sel-card-inner { flex-direction: row; align-items: center; gap: 16px; flex-wrap: wrap; }
	.sel-featured .sel-name { font-size: 18px; }
	.sel-featured .sel-desc { flex: 1; min-width: 200px; }
	.sel-featured:hover { border-color: rgba(0,210,255,0.4); box-shadow: 0 0 40px rgba(0,210,255,0.08), 0 8px 30px rgba(0,0,0,0.2); }
	.sel-card-glow {
		position: absolute; inset: 0; z-index: 0;
		background: radial-gradient(ellipse at 30% 50%, rgba(0,210,255,0.06), transparent 60%);
		pointer-events: none;
	}

	.sel-tag {
		position: absolute; top: 10px; right: 12px; z-index: 2;
		display: inline-flex; align-items: center; gap: 4px;
		font-size: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
		padding: 3px 8px; border-radius: 4px;
		background: rgba(0,210,255,0.12); color: #00d2ff; font-family: 'Space Mono', monospace;
	}

	.sel-icon {
		width: 42px; height: 42px; border-radius: 12px; flex-shrink: 0;
		display: flex; align-items: center; justify-content: center;
	}
	.sel-icon-cyan { background: rgba(0,210,255,0.1); color: #00d2ff; border: 1px solid rgba(0,210,255,0.15); }
	.sel-icon-amber { background: rgba(245,158,11,0.1); color: #f59e0b; border: 1px solid rgba(245,158,11,0.15); }
	.sel-icon-emerald { background: rgba(16,185,129,0.1); color: #10b981; border: 1px solid rgba(16,185,129,0.15); }
	.sel-icon-default { background: var(--bg-surface-input); color: var(--text-dim); border: 1px solid var(--border); }

	.sel-name { font-family: 'Syne', sans-serif; font-size: 15px; font-weight: 700; color: var(--text-heading); margin: 0; }
	.sel-desc { font-size: 11px; color: var(--text-dim); font-family: 'Space Mono', monospace; line-height: 1.5; margin: 0; }
	.sel-features { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 2px; }
	.sel-features span {
		font-size: 9px; padding: 2px 8px; border-radius: 99px;
		background: var(--bg-surface); border: 1px solid var(--border-subtle);
		color: var(--text-dim); font-family: 'Space Mono', monospace;
	}

	/* Legacy — keep for backward compat */
	.intent-grid {
		display: grid;
		grid-template-columns: 1fr;
		gap: 16px;
		max-width: 800px;
		margin: 0 auto;
	}
	@media (min-width: 640px) {
		.intent-grid {
			grid-template-columns: 1fr 1.3fr 1fr;
			gap: 20px;
			align-items: stretch;
		}
	}
	.intent-card {
		display: flex; flex-direction: column; align-items: center; text-align: center;
		padding: 28px 20px; cursor: pointer; transition: all 0.25s;
		border: 1px solid var(--border); background: var(--bg-surface);
		border-radius: 16px; position: relative;
	}
	.intent-card:hover {
		transform: translateY(-3px); box-shadow: 0 12px 40px rgba(0,0,0,0.3);
		border-color: rgba(0,210,255,0.2); background: rgba(0,210,255,0.03);
	}
	.intent-card-featured {
		padding: 36px 24px; border: 1.5px solid rgba(0, 210, 255, 0.3);
		background: var(--bg-surface); position: relative; overflow: hidden;
	}
	.intent-card-featured::before {
		content: ''; position: absolute; inset: 0;
		background: radial-gradient(ellipse at 50% 0%, rgba(0, 210, 255, 0.08), transparent 70%);
		pointer-events: none;
	}
	.intent-card-featured:hover {
		border-color: rgba(0, 210, 255, 0.5);
		box-shadow: 0 0 40px rgba(0, 210, 255, 0.15), 0 12px 40px rgba(0, 0, 0, 0.3);
		background: rgba(0, 210, 255, 0.03);
	}
	.intent-badge-top { margin-bottom: 12px; }
	.intent-icon {
		width: 56px; height: 56px; display: flex; align-items: center;
		justify-content: center; border-radius: 14px;
	}
	.intent-icon.cyan { background: rgba(0,210,255,0.1); color: #00d2ff; border: 1px solid rgba(0,210,255,0.2); }
	.intent-icon.emerald { background: rgba(16,185,129,0.1); color: #10b981; border: 1px solid rgba(16,185,129,0.2); }

	.back-link {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		color: var(--text-muted);
		font-size: 13px;
		font-family: 'Space Mono', monospace;
		background: none;
		border: none;
		cursor: pointer;
		padding: 0;
		transition: color 0.15s;
	}
	.back-link:hover {
		color: #00d2ff;
	}

	.form-wrapper {
		max-width: 640px;
		margin: 0 auto;
	}

	.form-header {
		margin: 16px 0 20px;
	}

	.form-box {
		border-radius: 16px;
	}

	.launch-form {
		display: flex;
		flex-direction: column;
	}
</style>
