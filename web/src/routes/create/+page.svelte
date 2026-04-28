<script lang="ts">
	import { ethers } from 'ethers';
	import { t } from '$lib/i18n';
	import { shortAddr } from '$lib/formatters';
	import { pushPreferences } from '$lib/embeddedWallet';
	import { getContext, onDestroy } from 'svelte';
	import { page } from '$app/state';
	import type { SupportedNetwork, PaymentOption } from '$lib/structure';
	import type { WsProviderManager, EventSubscription } from '$lib/wsProvider';
	import { transferFilter } from '$lib/wsProvider';
	import { ERC20_ABI, ZERO_ADDRESS } from '$lib/tokenCrafter';
	import { LAUNCH_INSTANCE_ABI, CURVE_TYPES, type CurveType } from '$lib/launchpad';
	import { TokenFactoryClient } from '$lib/contracts/tokenFactory';
	import { LaunchpadFactoryClient } from '$lib/contracts/launchpadFactory';
	import { PlatformRouterClient } from '$lib/contracts/platformRouter';
	import { apiFetch } from '$lib/apiFetch';
	import { friendlyError } from '$lib/errorDecoder';
	import QrCode from '$lib/QrCode.svelte';
	import FixedOverlay from '$lib/FixedOverlay.svelte';
	import { TOKEN_READ_ABI, ERC20_DECIMALS_ABI, ROUTER_ABI_LITE } from '$lib/commonABIs';
	import * as deployHelpers from './lib/deploy/helpers';
	import { getBaseTokenAddress, getBaseDecimals, getBaseSymbol, feeCacheKey } from './lib/deploy/helpers';
	import { SwapRouter } from '$lib/swapRouter.svelte';
	import { findBestRoute, isCacheLoaded, getWeth } from '$lib/tradeLens';
	import TokenForm from './lib/TokenForm.svelte';
	import type { ListingConfig, TokenFormData, PreviewState } from './lib/TokenForm.svelte';
	import { userTokens, addUserToken } from '$lib/userTokens';
	import { get as getStore } from 'svelte/store';
	import {
		toUrlIntentView,
		toInitialFormData,
		toFeeDisplayView,
		toDepositView,
		toDeployStepsView,
		type IntentMode,
	} from '$lib/structure/views/createView';

	let resetSignal = $state(0);
	import DisplayPreview from './lib/DisplayPreview.svelte';
	import IntentSelectionGrid from './lib/IntentSelectionGrid.svelte';
	import SuccessScreen from './lib/SuccessScreen.svelte';
	import DeployProgressStepper from './lib/DeployProgressStepper.svelte';
	import DepositInfo from './lib/DepositInfo.svelte';
	import PaymentMethodSelector from './lib/PaymentMethodSelector.svelte';
	import { goto } from '$app/navigation';
	import Tooltip from '$lib/Tooltip.svelte';

	import { createMode, type CreateMode } from '$lib/createModeStore';

	// ─── Intent mode state (synced with global store) ───
	let mode: IntentMode | null = $state(null);

	// URL intent — mode/launch/token/chain querystring, grouped into one view.
	let urlIntent = $derived(toUrlIntentView(page.url.searchParams));

	// Resolve mode from URL params on mount
	// Also auto-restore last-used mode from localStorage (tk_last_create_mode)
	// so repeat users skip the chooser. A "Change mode" link is rendered in the
	// wizard header to switch back.
	$effect(() => {
		if (mode !== null) return;
		const { modeFromUrl, launchFromUrl, tokenFromUrl } = urlIntent;
		let resolved: IntentMode | null = null;
		if (tokenFromUrl) {
			resolved = 'launch';
			launchTokenAddress = tokenFromUrl;
		} else if (modeFromUrl) {
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
		// Remember last chosen mode so repeat users skip the chooser.
		// When clearing (m=null via "Change mode"), also remove the saved
		// preference so the $effect doesn't auto-restore it.
		if (m) {
			try { localStorage.setItem('tk_last_create_mode', m); } catch {}
		} else {
			try { localStorage.removeItem('tk_last_create_mode'); } catch {}
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

	// Derived page title
	let pageTitle = $derived(
		mode === 'token' ? $t('ci.titleToken') :
		mode === 'launch' ? $t('ci.titleLaunch') :
		mode === 'both' ? $t('ci.titleBoth') :
		mode === 'list' ? 'Create & List on DEX' :
		$t('ci.pageTitle')
	);

	// ─── Launch Existing Token form state ───
	let launchTokenAddress = $state(urlIntent.tokenFromUrl || '');
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

	// Depends on both urlIntent and supportedNetworks — hoisted below both.
	let initialFormData = $derived(toInitialFormData(urlIntent, supportedNetworks));

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
			const router = new PlatformRouterClient(routerAddr, signer);

			// Launch fee in USDT
			const lpFactoryRead = new LaunchpadFactoryClient(launchNetwork.launchpad_address, signer);
			const launchFee = await lpFactoryRead.launchFee();

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
				curveType: launchCurveType,
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
			const { launchAddress: launchAddr } = await router.launchCreatedToken(
				launchTokenAddress,
				launchParams,
				protectionParams,
				taxParams,
				false, // isTaxable — quick-launch UI does not collect tax params
				feePayment,
			);

			if (launchAddr && launchAddr !== ethers.ZeroAddress) {
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
	let getWsManager: () => WsProviderManager | null = getContext('wsManager');
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
	// Lowercased addresses of built-in defaults — options outside this set are
	// user-imported and only surface in the picker if they actually hold value.
	let defaultPaymentAddrs = $state(new Set<string>());
	// Per-option balances + quoteFee results (populated when modal opens)
	let paymentBalances: bigint[] = $state([]);
	let paymentQuotes: bigint[] = $state([]); // amountIn per option
	let quoteFeeLoading = $state(false);
	// Custom token import in payment modal
	let payImportAddr = $state('');
	let payImportBusy = $state(false);
	let payImportError = $state<string | null>(null);

	// View: format payment options for PaymentMethodSelector.
	// Defaults always render; user-imported tokens only render when they
	// actually hold a balance (matches the "with value" requirement).
	let paymentMethodTokens = $derived(paymentOptions
		.map((opt, i) => {
			const bal = paymentBalances[i] ?? 0n;
			const quote = paymentQuotes[i] ?? 0n;
			const isDefault = defaultPaymentAddrs.has(opt.address.toLowerCase());
			return {
				address: opt.address,
				symbol: opt.symbol,
				name: opt.name,
				balanceDisplay: parseFloat(ethers.formatUnits(bal, opt.decimals)).toFixed(4),
				quoteDisplay: quote > 0n ? parseFloat(ethers.formatUnits(quote * 101n / 100n, opt.decimals)).toFixed(4) : '—',
				logoUrl: COIN_LOGOS[opt.symbol.toUpperCase()] ?? null,
				_isDefault: isDefault,
				_balance: bal,
			};
		})
		.filter(t => t._isDefault || t._balance > 0n)
		.map(({ _isDefault, _balance, ...rest }) => rest));

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
			const factory = new TokenFactoryClient(net.platform_address, pro);
			const lpAddr = net.launchpad_address && net.launchpad_address !== '0x'
				? net.launchpad_address
				: ZERO_ADDRESS;

			for (const taxable of [false, true]) {
				for (const mintable of [false, true]) {
					for (const partner of [false, true]) {
						const key = feeCacheKey(net.chain_id, taxable, mintable, partner);
						promises.push(
							factory.getCreationFees(taxable, mintable, partner, lpAddr)
								.then(({ creationFeeUsdt, launchFeeUsdt }) => {
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


	let tokenInfo = $state<(TokenFormData & { listing: ListingConfig }) | null>(null);

	// Single-source picks — used in both display + tx-building paths, so kept flat.
	let selectedPayment = $derived(paymentOptions[selectedPaymentIndex]);
	let selectedFee = $derived(feeAmounts[selectedPaymentIndex] ?? 0n);
	let isNativePayment = $derived(selectedPayment?.address === ZERO_ADDRESS);

	// All compound display-only derivations (USD amount, slippage-padded fee,
	// formatted strings, isDirectUsdt) live together in one view object.
	let feeDisplay = $derived(toFeeDisplayView({
		selectedPayment,
		selectedFee,
		selectedPaymentIndex,
		feeAmounts,
		paymentOptions,
		paymentQuotes,
		usdtAddress: tokenInfo?.network?.usdt_address ?? null,
	}));

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
			const router = new PlatformRouterClient(routerAddr, prov);

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
							const { amountIn } = await router.quoteFeeRaw(typeKey, withLaunch, path);
							return amountIn;
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
			// Treat a just-imported token as a session default so it stays
			// visible even if the user hasn't funded it yet.
			defaultPaymentAddrs = new Set([...defaultPaymentAddrs, addr.toLowerCase()]);
			payImportAddr = '';
			// Persist to the shared store so every other selector (wallet, trade,
			// launchpad) surfaces this token automatically.
			addUserToken({
				address: addr.toLowerCase(),
				symbol: sym,
				name: name || sym,
				decimals,
				chainId: net.chain_id,
			});
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

		// Set payment options for selected network, then merge user-imported
		// tokens from the shared store (only those on the same chain).
		// Use `get()` instead of $ prefix — this function runs asynchronously
		// from a user action, and auto-subscription inside async bodies is
		// fragile across Svelte 5 contexts.
		const defaults = getPaymentOptions(info!.network);
		const defaultAddrs = new Set<string>(defaults.map(o => o.address.toLowerCase()));
		const extras: PaymentOption[] = getStore(userTokens)
			.filter(t => t.chainId === info!.network.chain_id && !defaultAddrs.has(t.address))
			.map(t => ({ symbol: t.symbol, name: t.name, address: t.address, decimals: t.decimals }));
		const options = [...defaults, ...extras];
		paymentOptions = options;
		defaultPaymentAddrs = defaultAddrs;

		const isExistingToken = !!(info as any).existingTokenAddress;

		// Fetch the single USDT fee for this type (cached by preloadFees).
		const key = feeCacheKey(info!.network.chain_id, info!.isTaxable, info!.isMintable, info!.isPartner);
		let cached = feeCache.get(key);

		if (!cached) {
			feeLoading = true;
			try {
				const pro = getProviderForNetwork(info!.network.chain_id)
					?? new ethers.JsonRpcProvider(info!.network.rpc);
				const factory = new TokenFactoryClient(info!.network.platform_address, pro);
				const lpAddr = info!.network.launchpad_address && info!.network.launchpad_address !== '0x'
					? info!.network.launchpad_address
					: ZERO_ADDRESS;
				const { creationFeeUsdt, launchFeeUsdt } = await factory.getCreationFees(
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

	// Deposit-modal view: total native needed (fee + native LP legs), required wei,
	// shortfall vs. the user's balance, and a ready-to-render formatted string.
	let depositListingPairs = $derived.by(() => {
		const ti = tokenInfo;
		return ti && ti.listing?.enabled ? ti.listing.pairs : undefined;
	});
	let deposit = $derived(toDepositView({
		selectedPayment,
		selectedFee,
		selectedFeeFormatted: feeDisplay.selectedFeeFormatted,
		isNativePayment,
		userBalance,
		listingPairs: depositListingPairs,
	}));

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
		if (isNativePayment) return userBalance >= deposit.totalNativeNeeded;
		return userBalance >= selectedFee;
	}

	let _createDepositSub: EventSubscription | null = null;
	let _createDepositDebounce: ReturnType<typeof setTimeout> | null = null;

	function startBalancePolling() {
		stopBalancePolling();
		const ws = getWsManager();
		const chainId = tokenInfo?.network?.chain_id;

		const checkAndResolve = async () => {
			const sufficient = await checkBalance();
			if (sufficient && step === 'waiting-deposit') {
				stopBalancePolling();
				addFeedback({ message: 'Deposit detected! Proceeding...', type: 'success' });
				proceedAfterBalance();
			}
		};

		if (ws && userAddress && chainId) {
			_createDepositSub = ws.subscribeLogs(chainId, transferFilter(userAddress), () => {
				if (_createDepositDebounce) clearTimeout(_createDepositDebounce);
				_createDepositDebounce = setTimeout(() => { _createDepositDebounce = null; checkAndResolve(); }, 500);
			});
			balanceCheckInterval = setInterval(checkAndResolve, 30_000);
		} else {
			balanceCheckInterval = setInterval(checkAndResolve, 5000);
		}
	}

	function stopBalancePolling() {
		if (balanceCheckInterval) {
			clearInterval(balanceCheckInterval);
			balanceCheckInterval = null;
		}
		if (_createDepositSub) {
			_createDepositSub.unsubscribe();
			_createDepositSub = null;
		}
		if (_createDepositDebounce) {
			clearTimeout(_createDepositDebounce);
			_createDepositDebounce = null;
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
				const router = new PlatformRouterClient(routerAddr, signer);
				const { tx, launchAddress: existingLaunchAddr } = await router.launchCreatedToken(
					tokenInfo.existingTokenAddress,
					launchParams,
					protectionParams,
					taxParams,
					tokenInfo.isTaxable || tokenInfo.isPartner,
					feePayment,
					{ value: nativeFeeWithBuffer }
				);
				deployTxHash = tx.hash;

				// launchCreatedToken parses TokenLaunched internally; the event emits
				// (creator, token, launch) — for this flow we already know the token,
				// but we retain the existing fallback for clarity.
				void existingLaunchAddr;
				deployedTokenAddress = tokenInfo.existingTokenAddress ?? null;

				addFeedback({ message: 'Launch is live!', type: 'success' });

			} else if (tokenInfo.launch?.enabled && tokenInfo.network.router_address && tokenInfo.network.router_address !== '0x') {
				// Use PlatformRouter for atomic Create + Launch
				addFeedback({ message: 'Creating token & launch...', type: 'info' });
				const router = new PlatformRouterClient(tokenInfo.network.router_address, signer);

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

				const { tx, tokenAddress: createdTokenAddr, launchAddress: createdLaunchAddr } =
					await router.createTokenAndLaunch(
						tokenParams, launchParams, protectionParams, taxParams, feePayment, referral,
						{ value: nativeFeeWithBuffer }
					);
				deployTxHash = tx.hash;
				deployedTokenAddress = createdTokenAddr !== ethers.ZeroAddress ? createdTokenAddr : null;
				void createdLaunchAddr;

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

				const router = new PlatformRouterClient(tokenInfo.network.router_address, signer);
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

				const { tx, tokenAddress: listedTokenAddr } = await router.createAndList(
					tokenParams, listParams,
					protectionParams, taxParams, feePayment, referral,
					{ value: nativeValue }
				);
				deployTxHash = tx.hash;
				deployedTokenAddress = listedTokenAddr !== ethers.ZeroAddress ? listedTokenAddr : null;

				addFeedback({ message: 'Token created & listed on DEX!', type: 'success' });
			} else {
				// Token-only creation via PlatformRouter.createTokenOnly
				const router = new PlatformRouterClient(tokenInfo.network.router_address, signer);

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
				const { tx, tokenAddress: onlyTokenAddr } = await router.createTokenOnly(
					tokenParams, protectionParams, taxParams, feePayment, referral,
					{ value: nativeFeeWithBuffer }
				);
				deployTxHash = tx.hash;
				deployedTokenAddress = onlyTokenAddr !== ethers.ZeroAddress ? onlyTokenAddr : null;

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
	// Note: liquidity seeding is handled atomically by PlatformRouter.createAndList.
	// Users who want to add additional pools post-creation do so from /manage-tokens,
	// which has its own NewPoolForm + router.addLiquidity flow (see PoolsTab).

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
		const wasDone = step === 'done';
		tokenInfo = null;
		showPreview = false;
		step = 'idle';
		isCreating = false;
		deployAfterConnect = false;
		deployedTokenAddress = null;
		deployTxHash = null;
		stopBalancePolling();
		// Reset the wizard form after a successful deploy so the user
		// starts fresh. Don't reset on cancel (mid-flow close).
		if (wasDone) {
			resetSignal++;
			previewState = null;
			try { sessionStorage.removeItem('tk_create_form_draft'); } catch {}
		}
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

<FixedOverlay bind:show={showPreview} onclose={closePreview}>
	{#if tokenInfo}
		<div
			class="review-modal w-full sm:max-w-md max-h-[100dvh] sm:max-h-[90vh] overflow-y-auto bg-background border border-line-input rounded-t-[20px] sm:rounded-[20px] p-4 sm:p-6 pb-[calc(16px+env(safe-area-inset-bottom,0px))] sm:pb-6 min-h-[60vh] sm:min-h-0 [scrollbar-width:none] [-ms-overflow-style:none]"
		>
			<!-- Mobile drag indicator -->
			<div
				class="sm:hidden flex justify-center pt-2 pb-1 cursor-pointer"
				onclick={closePreview}
				onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); closePreview(); } }}
				role="button"
				tabindex="0"
				aria-label="Close preview"
			>
				<div class="w-9 h-1 bg-[var(--border)] rounded-sm"></div>
			</div>
			{#if step === 'done'}
				<SuccessScreen
					tokenName={tokenInfo.name}
					tokenSymbol={tokenInfo.symbol}
					tokenAddress={deployedTokenAddress ?? ''}
					txHash={deployTxHash ?? ''}
					network={tokenInfo.network}
					title={tokenInfo.existingTokenAddress ? 'Launch Created!' : tokenInfo.listing?.enabled ? $t('ct.deployedListed') : tokenInfo.launch?.enabled ? 'Token Deployed & Launched!' : $t('ct.deployed')}
					subtitle={$t('ct.liveOn') + ' ' + tokenInfo.network.name + '.' + (tokenInfo.listing?.enabled ? ' ' + $t('ct.liqAdded') : '')}
					onManageTokens={() => goto(deployedTokenAddress ? `/manage-tokens?just_created=${deployedTokenAddress}&chain=${tokenInfo!.network.chain_id}` : '/manage-tokens')}
					onClose={closePreview}
				/>

			{:else if step === 'waiting-deposit'}
				<div class="flex flex-col gap-3">
					<div class="flex justify-between items-center mb-2">
						<h2 class="heading-2">Deposit to Continue</h2>
						<button onclick={closePreview} class="w-8 h-8 rounded-lg bg-surface-hover border-none text-muted flex items-center justify-center transition-all duration-150 text-sm hover:bg-surface-hover hover:text-heading cursor-pointer">x</button>
					</div>
					<DepositInfo
						address={userAddress ?? ''}
						amountDisplay={deposit.depositShortFmt + ' ' + (selectedPayment?.symbol ?? '')}
						balance={parseFloat(ethers.formatUnits(userBalance, selectedPayment?.decimals ?? 18)).toFixed(4) + ' ' + (selectedPayment?.symbol ?? '')}
						network={tokenInfo?.network}
					/>
					<button onclick={closePreview} class="btn-secondary text-sm py-2 cursor-pointer w-full">
						Cancel
					</button>
				</div>

			{:else if step !== 'idle' && step !== 'review'}
				<DeployProgressStepper
					steps={deploySteps().map(ds => ({
						label: ds.label,
						status: ds.key === 'approving' && isNativePayment ? 'skipped' : stepStatus(ds.key),
					}))}
					txHash={deployTxHash}
					txHref={deployTxHash && tokenInfo ? getExplorerUrl(tokenInfo.network.chain_id, 'tx', deployTxHash) : null}
				/>

			{:else}
				<!-- Payment-focused review -->
				<div class="flex justify-between items-center mb-5">
					<h2 class="font-display text-xl font-bold text-white">Confirm Payment</h2>
					<button onclick={closePreview} class="w-8 h-8 rounded-lg bg-surface-hover border-none text-muted flex items-center justify-center transition-all duration-150 text-sm hover:bg-surface-hover hover:text-heading cursor-pointer">x</button>
				</div>

				<!-- Token identifier (one line) -->
				<div class="flex items-baseline gap-2 mb-1">
					<span class="font-display text-15 font-bold text-heading">{tokenInfo.name} ({tokenInfo.symbol})</span>
					<span class="text-3xs text-[#00d2ff] font-mono">{tokenInfo.network.name}</span>
				</div>
				<div class="flex gap-1 flex-wrap mb-3">
					{#if tokenInfo.isMintable}<span class="badge badge-cyan">Mintable</span>{/if}
					{#if tokenInfo.isTaxable}<span class="badge badge-amber">Taxable</span>{/if}
					{#if tokenInfo.isPartner}<span class="badge badge-purple">Partner</span>{/if}
					{#if tokenInfo.listing?.enabled}<span class="badge badge-emerald">DEX Listing</span>{/if}
					{#if tokenInfo.launch?.enabled}<span class="badge badge-emerald">Launch</span>{/if}
					{#if !tokenInfo.isMintable && !tokenInfo.isTaxable && !tokenInfo.isPartner && !tokenInfo.listing?.enabled && !tokenInfo.launch?.enabled}<span class="badge badge-emerald">Standard</span>{/if}
				</div>

				<!-- Cost Breakdown -->
				<div class="mb-4 pb-4 border-b border-surface-hover bg-[rgba(0,210,255,0.03)] rounded-[10px] p-[14px] border border-[rgba(0,210,255,0.1)]">
					<div class="flex flex-col gap-0">
						<div class="flex justify-between items-center py-1.5 font-mono text-xs2">
							<span class="text-dim">Creation fee (USDT)</span>
							<span class="text-foreground font-semibold font-numeric text-13 text-right">{feeLoading ? '...' : `$${feeDisplay.feeUsdAmount}`}</span>
						</div>

						{#if tokenInfo.listing?.enabled}
							{#each (tokenInfo.listing.pairs || []).filter(p => Number(p.amount) > 0) as pair}
								{@const baseLabel = pair.base === 'native' ? tokenInfo.network.native_coin : pair.base.toUpperCase()}
								<div class="flex justify-between items-center py-1.5 font-mono text-xs2">
									<span class="text-dim">Liquidity ({tokenInfo.symbol}/{baseLabel})</span>
									<span class="text-foreground font-semibold font-numeric text-13 text-right">{pair.amount} {baseLabel}</span>
								</div>
							{/each}
						{/if}

						{#if tokenInfo.launch?.enabled}
							<div class="flex justify-between items-center py-1.5 font-mono text-xs2">
								<span class="text-dim">Launch fee (on graduation)</span>
								<span class="text-dim font-normal text-3xs font-mono text-right">1% of raised</span>
							</div>
						{/if}

						<div class="h-px bg-surface-hover my-1.5"></div>
						<div class="flex justify-between items-center py-1.5 font-mono text-xs2">
							<span class="text-heading font-bold">You pay now</span>
							<span class="text-[#00d2ff] text-15 font-bold font-numeric text-right">
								{#if feeLoading}...
								{:else}
									{@const net = tokenInfo.network}
									{@const payAddr = selectedPayment?.address?.toLowerCase() || ''}
									{@const listPairs = tokenInfo.listing?.enabled ? (tokenInfo.listing.pairs || []).filter((p) => Number(p.amount) > 0) : []}
									{@const mergedLpAmount = listPairs
										.filter((p) => getBaseTokenAddress(net, p.base).toLowerCase() === payAddr)
										.reduce((sum, p) => sum + Number(p.amount), 0)}
									{@const separatePairs = listPairs
										.filter((p) => getBaseTokenAddress(net, p.base).toLowerCase() !== payAddr)}
									{@const feeNum = parseFloat(feeDisplay.selectedFeeFormatted || '0')}
									{@const total = feeNum + mergedLpAmount}
									{parseFloat(total.toFixed(6))} {selectedPayment?.symbol}{#each separatePairs as pair}{@const sym = getBaseSymbol(net, pair.base)} + {parseFloat(Number(pair.amount).toFixed(6))} {sym}{/each}
								{/if}
							</span>
						</div>
					</div>
						<p class="text-xs4 text-dim font-mono mt-1.5 opacity-70">Fee is denominated in USDT. Pay with any token — it's auto-converted.</p>

					{#if !feeLoading && paymentOptions.length > 0}
						<div class="flex flex-col gap-1.5 mt-3">
							<span class="text-xs4 text-dim font-mono uppercase tracking-[0.04em]">Pay with</span>
							<button class="flex items-center gap-2.5 w-full px-3 py-2.5 rounded-[10px] bg-surface border border-line cursor-pointer transition-colors duration-[120ms] font-[inherit] text-[inherit] text-left hover:border-[rgba(0,210,255,0.2)]" onclick={() => { showPaymentModal = true; loadPaymentQuotes(); }}>
								{#if COIN_LOGOS[selectedPayment?.symbol?.toUpperCase()]}
								<img src={COIN_LOGOS[selectedPayment.symbol.toUpperCase()]} alt={selectedPayment.symbol} class="w-8 h-8 rounded-full object-cover shrink-0" />
							{:else}
								<span class="w-8 h-8 rounded-full bg-[rgba(0,210,255,0.08)] border border-[rgba(0,210,255,0.15)] flex items-center justify-center font-display text-xs font-extrabold text-[#00d2ff] shrink-0">{selectedPayment?.symbol?.charAt(0) || '?'}</span>
							{/if}
								<div class="flex-1">
									<span class="block font-display text-13 font-bold text-heading">{selectedPayment?.symbol}</span>
									<span class="block font-numeric text-xs text-dim">{feeDisplay.selectedFeeFormatted} {selectedPayment?.symbol}</span>
								</div>
								<svg class="text-dim shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
							</button>
						</div>

						<!-- Payment method modal (styled like the trade page token selector) -->
						<PaymentMethodSelector
							bind:show={showPaymentModal}
							tokens={paymentMethodTokens}
							selectedAddress={paymentOptions[selectedPaymentIndex]?.address ?? ''}
							loading={quoteFeeLoading}
							importBusy={payImportBusy}
							importError={payImportError}
							onSelect={(_tok, i) => { selectedPaymentIndex = i; showPaymentModal = false; }}
							onImport={(addr) => { payImportAddr = addr; importPaymentToken(); }}
						/>
					{/if}
				</div>

				{@const _minBuy = tokenInfo.launch?.enabled ? parseFloat(String(tokenInfo.launch.minBuyUsdt || '0')) : 0}
				{@const _maxBuyPerWalletUsd = tokenInfo.launch?.enabled
					? parseFloat(String(tokenInfo.launch.hardCap || '0')) * (parseFloat(String(tokenInfo.launch.maxBuyBps || '0')) / 10000)
					: 0}
				{@const _minBuyExceedsMaxBuy = tokenInfo.launch?.enabled && _minBuy > 0 && _maxBuyPerWalletUsd > 0 && _minBuy > _maxBuyPerWalletUsd}
				{#if _minBuyExceedsMaxBuy}
					<div class="my-2 mb-3 px-[14px] py-3 rounded-[10px] bg-[rgba(251,191,36,0.08)] border border-[rgba(251,191,36,0.35)] text-[#fcd34d] text-13 leading-[1.5]">
						<strong class="block text-[#fde68a] mb-1 font-display">Min buy exceeds max buy per wallet.</strong>
						With hard cap ${tokenInfo.launch.hardCap} × max wallet {(parseFloat(String(tokenInfo.launch.maxBuyBps)) / 100).toFixed(2)}% = ${_maxBuyPerWalletUsd.toFixed(2)} max buy, but min buy is ${tokenInfo.launch.minBuyUsdt}. Go back and fix the launch config.
					</div>
				{/if}
				<button
					onclick={confirmAndDeploy}
					disabled={feeLoading || paymentOptions.length === 0 || _minBuyExceedsMaxBuy}
					class="w-full font-display cursor-pointer p-[14px] bg-[linear-gradient(135deg,#00d2ff,#3a7bd5)] text-heading font-bold text-15 border-none rounded-xl transition-all duration-200 mt-2 disabled:opacity-50 disabled:cursor-not-allowed enabled:hover:-translate-y-px enabled:hover:shadow-[0_8px_32px_rgba(0,210,255,0.3)]"
				>
					{feeLoading ? $t('ct.calculatingFee') : tokenInfo.existingTokenAddress ? 'Create Launch' : tokenInfo.listing?.enabled ? $t('ct.deployAndList') : tokenInfo.launch?.enabled ? 'Deploy & Launch' : $t('ct.confirmDeploy')}
				</button>
			{/if}
		</div>
	{/if}
</FixedOverlay>

<!-- Page -->
<div class="page-container max-w-6xl mx-auto px-3 sm:px-6 py-6 sm:py-12">

	{#if mode === null}
		<!-- ═══════ INTENT SELECTION ═══════ -->
		<IntentSelectionGrid onSelect={selectMode} />

	{:else}
		<!-- ═══════ TOKEN CREATION WIZARD ═══════ -->
		<div class="flex flex-col lg:flex-row gap-7 items-stretch lg:items-start">
			<div class="flex-1 w-full min-w-0 max-w-[640px] mx-auto lg:max-w-none lg:mx-0">
				<button class="inline-flex items-center gap-1.5 text-muted text-13 font-mono bg-transparent border-none cursor-pointer p-0 transition-colors duration-150 hover:text-[#00d2ff]" onclick={() => selectMode(null)} title="Change create mode">
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
					Change mode
				</button>
				<div class="mt-4 mb-5">
					<span class="badge badge-cyan">{mode === 'token' ? $t('ci.titleToken') : mode === 'launch' ? $t('ci.titleLaunch') : mode === 'list' ? 'Create & List' : $t('ci.titleBoth')}</span>
					<h1 class="heading-1 mt-3 mb-1">{pageTitle}</h1>
					<p class="text-gray-500 font-mono text-sm">{mode === 'token' ? $t('ci.metaToken') : mode === 'launch' ? $t('ci.metaLaunch') : mode === 'list' ? 'Create and list your token on a DEX.' : $t('ci.metaBoth')}</p>
				</div>
				<TokenForm {supportedNetworks} {addFeedback} {updateTokenInfo} onPreviewChange={handlePreviewChange} initialData={initialFormData} initialMode={mode} onModeChange={handleModeChange} {resetSignal} />
			</div>
			{#if previewState}
				<div class="create-preview-col hidden lg:block w-[320px] shrink-0 sticky top-20 max-h-[calc(100vh-100px)] overflow-y-auto overflow-x-hidden [scrollbar-width:thin]">
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
	.create-preview-col::-webkit-scrollbar { width: 4px; }
	.create-preview-col::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }

	.review-modal { animation: modalSlideUp 0.25s ease-out; }
	.review-modal::-webkit-scrollbar { display: none; }
	@media (min-width: 640px) {
		.review-modal { animation: modalIn 0.2s ease-out; }
	}
	@keyframes modalSlideUp {
		from { opacity: 0; transform: translateY(100%); }
		to   { opacity: 1; transform: translateY(0); }
	}
	@keyframes modalIn {
		from { opacity:0; transform: scale(0.95) translateY(8px); }
		to   { opacity:1; transform: scale(1) translateY(0); }
	}
</style>
