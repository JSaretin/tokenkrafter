<script lang="ts">
	import { ethers } from 'ethers';
	import { t } from '$lib/i18n';
	import { getContext, onDestroy } from 'svelte';
	import { page } from '$app/state';
	import type { SupportedNetwork, PaymentOption } from '$lib/structure';
	import { FACTORY_ABI, PLATFORM_ROUTER_ABI, ROUTER_ABI, ERC20_ABI, ZERO_ADDRESS } from '$lib/tokenCrafter';
	import { LAUNCHPAD_FACTORY_ABI, LAUNCH_INSTANCE_ABI, CURVE_TYPES, type CurveType } from '$lib/launchpad';
	import TokenForm from './lib/TokenFormV2.svelte';
	import type { ListingConfig, ListingPairConfig, TokenFormData, PreviewState } from './lib/TokenFormV2.svelte';
	import DisplayPreview from './lib/DisplayPreview.svelte';
	import Tooltip from '$lib/Tooltip.svelte';

	// ─── Intent mode state ───
	type IntentMode = 'token' | 'launch' | 'both' | 'list';
	let mode: IntentMode | null = $state(null);

	// Read URL params for pre-filling
	let modeFromUrl = $derived(page.url.searchParams.get('mode') as IntentMode | null);
	let launchFromUrl = $derived(page.url.searchParams.get('launch') === 'true');
	let tokenFromUrl = $derived(page.url.searchParams.get('token') || '');
	let chainFromUrl = $derived(page.url.searchParams.get('chain') || '');

	// Resolve initial mode from URL params
	$effect(() => {
		if (mode !== null) return; // already set by user click
		if (tokenFromUrl) {
			mode = 'launch';
			launchTokenAddress = tokenFromUrl;
		} else if (modeFromUrl === 'token' || modeFromUrl === 'launch' || modeFromUrl === 'both' || modeFromUrl === 'list') {
			mode = modeFromUrl;
		} else if (launchFromUrl) {
			mode = 'both';
		}
	});

	function selectMode(m: IntentMode) {
		mode = m;
	}

	function backToSelection() {
		mode = null;
		// Reset launch form state
		launchTokenAddress = '';
		launchTokenName = '';
		launchTokenSymbol = '';
		launchTokenDecimals = 18;
		launchTokenBalance = 0n;
		launchTokenSupply = 0n;
		launchTokenLoading = false;
		launchAmount = '';
		launchChainId = undefined;
		launchCurveType = 0;
		launchSoftCap = '5';
		launchHardCap = '50';
		launchDurationDays = '30';
		launchMaxBuyPct = '2';
		launchCreatorAllocPct = '0';
		launchVestingDays = '0';
		launchSubmitting = false;
		launchStep = 'idle';
		launchDeployedAddress = null;
	}

	let initialFormData = $derived.by(() => {
		const data: any = {};
		if (mode === 'both' || mode === 'launch' || launchFromUrl) {
			data.launch = { enabled: true, tokensForLaunchPct: 80, curveType: 0, softCap: '', hardCap: '', durationDays: '30', maxBuyBps: '200', creatorAllocationBps: '0', vestingDays: '0', launchPaymentToken: '' };
		}
		if (mode === 'list') {
			data.listing = { enabled: true, baseCoin: 'native', mode: 'manual', tokenAmount: '', baseAmount: '', pricePerToken: '', listBaseAmount: '' };
		}
		if (mode === 'launch' && tokenFromUrl) {
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
				const token = new ethers.Contract(addr, [
					'function name() view returns (string)',
					'function symbol() view returns (string)',
					'function decimals() view returns (uint8)',
					'function balanceOf(address) view returns (uint256)',
					'function totalSupply() view returns (uint256)'
				], pro);
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
			const factory = new ethers.Contract(launchNetwork.launchpad_address, LAUNCHPAD_FACTORY_ABI, signer);
			const launchPaymentTokens: string[] = await factory.getSupportedPaymentTokens();
			const paymentToken = launchPaymentTokens.length > 0 ? launchPaymentTokens[0] : ZERO_ADDRESS;
			const isNativeFee = paymentToken === ZERO_ADDRESS;

			// Get fee
			const launchFee: bigint = await factory.getLaunchFee(paymentToken);

			// Approve fee if ERC20
			if (!isNativeFee && launchFee > 0n) {
				launchStep = 'approving-fee';
				addFeedback({ message: $t('ci.approvingFee'), type: 'info' });
				const erc20 = new ethers.Contract(paymentToken, ERC20_ABI, signer);
				const allowance = await erc20.allowance(userAddress, launchNetwork.launchpad_address);
				if (allowance < launchFee) {
					const approveTx = await erc20.approve(launchNetwork.launchpad_address, launchFee);
					await approveTx.wait();
				}
			}

			// Get USDT decimals
			let usdtDec = 18;
			try {
				const usdtC = new ethers.Contract(launchNetwork.usdt_address, ['function decimals() view returns (uint8)'], signer);
				usdtDec = Number(await usdtC.decimals());
			} catch {}

			const tokensForLaunch = ethers.parseUnits(launchAmount, launchTokenDecimals);
			const txOptions = isNativeFee && launchFee > 0n ? { value: launchFee } : {};

			launchStep = 'creating';
			addFeedback({ message: 'Creating launch...', type: 'info' });
			const tx = await factory.createLaunch(
				launchTokenAddress,
				tokensForLaunch,
				BigInt(launchCurveType),
				ethers.parseUnits(launchSoftCap, usdtDec),
				ethers.parseUnits(launchHardCap, usdtDec),
				BigInt(launchDurationDays),
				BigInt(Math.round(parseFloat(launchMaxBuyPct || '0') * 100)),
				BigInt(Math.round(parseFloat(launchCreatorAllocPct || '0') * 100)),
				BigInt(launchVestingDays),
				paymentToken,
				0n, // startTimestamp = immediate
				txOptions
			);
			const receipt = await tx.wait();

			// Extract launch address from event
			let launchAddr: string | null = null;
			const createdEvent = receipt?.logs?.find((log: any) => {
				try {
					const parsed = factory.interface.parseLog({ topics: [...log.topics], data: log.data });
					return parsed?.name === 'LaunchCreated';
				} catch { return false; }
			});
			if (createdEvent) {
				const parsed = factory.interface.parseLog({ topics: [...createdEvent.topics], data: createdEvent.data });
				launchAddr = parsed?.args?.launch ?? null;
			}

			if (launchAddr) {
				// Approve + deposit tokens
				launchStep = 'approving-tokens';
				addFeedback({ message: $t('ci.approvingTokens'), type: 'info' });
				const tokenContract = new ethers.Contract(launchTokenAddress, ERC20_ABI, signer);
				const allowance = await tokenContract.allowance(userAddress, launchAddr);
				if (allowance < tokensForLaunch) {
					const approveTx = await tokenContract.approve(launchAddr, tokensForLaunch);
					await approveTx.wait();
				}

				launchStep = 'depositing';
				addFeedback({ message: $t('ci.depositingTokens'), type: 'info' });
				const instance = new ethers.Contract(launchAddr, LAUNCH_INSTANCE_ABI, signer);
				const depositTx = await instance.depositTokens(tokensForLaunch);
				await depositTx.wait();

				// Launch data indexed by daemon from on-chain events
				launchStep = 'saving';
				launchDeployedAddress = launchAddr;
				launchStep = 'done';
				addFeedback({ message: $t('ci.launchSuccess'), type: 'success' });
			}
		} catch (e: any) {
			const msg = e.shortMessage || e.message || 'Transaction failed';
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
	let _getNetworks: () => SupportedNetwork[] = getContext('supportedNetworks');
	let supportedNetworks = $derived(_getNetworks());
	let getNetworkProviders: () => Map<number, ethers.JsonRpcProvider> = getContext('networkProviders');
	let getProvidersReady: () => boolean = getContext('providersReady');
	let getPaymentOptions: (network: SupportedNetwork) => PaymentOption[] = getContext('getPaymentOptions');

	let provider = $derived(getProvider());
	let signer = $derived(getSigner());
	let userAddress = $derived(getUserAddress());
	let networkProviders = $derived(getNetworkProviders());
	let providersReady = $derived(getProvidersReady());

	let previewState: PreviewState | null = $state(null);
	function handlePreviewChange(state: PreviewState) {
		previewState = state;
	}

	let showPreview = $state(false);
	let showReviewDetails = $state(false);
	let isCreating = $state(false);
	let step = $state<'idle' | 'review' | 'checking-balance' | 'waiting-deposit' | 'approving' | 'creating' | 'approving-listing' | 'adding-liquidity' | 'done'>('idle');
	let deployAfterConnect = $state(false);
	let deployedTokenAddress: string | null = $state(null);
	let deployTxHash: string | null = $state(null);

	const EXPLORER_URLS: Record<number, string> = {
		1: 'https://etherscan.io',
		56: 'https://bscscan.com',
		97: 'https://testnet.bscscan.com',
		11155111: 'https://sepolia.etherscan.io'
	};

	function getExplorerUrl(chainId: number, type: 'tx' | 'address', hash: string) {
		const base = EXPLORER_URLS[chainId] || 'https://bscscan.com';
		return `${base}/${type}/${hash}`;
	}

	async function switchNetwork(chainId: number): Promise<boolean> {
		const ethereum = (window as any).ethereum;
		if (!ethereum) return false;
		try {
			await ethereum.request({
				method: 'wallet_switchEthereumChain',
				params: [{ chainId: '0x' + chainId.toString(16) }]
			});
			return true;
		} catch (e: any) {
			if (e.code === 4902) {
				addFeedback({ message: 'Please add this network to your wallet first.', type: 'error' });
			} else {
				addFeedback({ message: 'Failed to switch network. Please switch manually.', type: 'error' });
			}
			return false;
		}
	}

	// Fee data
	let feeTokens: string[] = $state([]);
	let feeAmounts: bigint[] = $state([]);
	let feeLoading = $state(false);
	let selectedPaymentIndex = $state(0);
	let paymentOptions: PaymentOption[] = $state([]);

	// Preloaded fee cache: keyed by "chainId-typeKey"
	let feeCache = new Map<string, { tokens: string[]; fees: bigint[]; launchFees: bigint[] }>();
	let feeCacheReady = $state(false);

	function feeCacheKey(chainId: number, isTaxable: boolean, isMintable: boolean, isPartner: boolean) {
		const typeKey = (isPartner ? 4 : 0) | (isTaxable ? 2 : 0) | (isMintable ? 1 : 0);
		return `${chainId}-${typeKey}`;
	}

	function matchFeesToPayments(tokens: string[], fees: bigint[], options: PaymentOption[]) {
		const matchedOptions: PaymentOption[] = [];
		const matchedFees: bigint[] = [];
		for (let i = 0; i < tokens.length; i++) {
			const addr = tokens[i].toLowerCase();
			const opt = options.find((p) => p.address.toLowerCase() === addr);
			if (opt && fees[i] > 0n) {
				matchedOptions.push(opt);
				matchedFees.push(fees[i]);
			}
		}
		return { matchedOptions, matchedFees };
	}

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
								.then(([tokens, fees, launchFees]: [string[], bigint[], bigint[]]) => {
									feeCache.set(key, { tokens: [...tokens], fees: [...fees], launchFees: [...launchFees] });
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

		// For existing tokens: show launch fee only
		// For new tokens: show creation fee (+ launch fee is included in the router tx)
		const key = feeCacheKey(info!.network.chain_id, info!.isTaxable, info!.isMintable, info!.isPartner);
		const cached = feeCache.get(key);

		if (cached) {
			feeTokens = cached.tokens;
			feeAmounts = isExistingToken ? cached.launchFees : cached.fees;
			const feesToMatch = isExistingToken ? cached.launchFees : cached.fees;
			const { matchedOptions, matchedFees } = matchFeesToPayments(cached.tokens, feesToMatch, options);
			if (matchedOptions.length > 0) {
				paymentOptions = matchedOptions;
				feeAmounts = matchedFees;
			}
			feeLoading = false;
			return;
		}

		// Fallback: fetch live if not cached
		feeLoading = true;
		feeTokens = [];
		feeAmounts = [];

		try {
			if (isExistingToken) {
				// Fetch launch fee directly from LaunchpadFactory
				const pro = getProviderForNetwork(info!.network.chain_id)
					?? new ethers.JsonRpcProvider(info!.network.rpc);
				const { LAUNCHPAD_FACTORY_ABI } = await import('$lib/launchpad');
				const lpFactory = new ethers.Contract(info!.network.launchpad_address, LAUNCHPAD_FACTORY_ABI, pro);
				const supported = options.map(o => o.address);
				const tokens: string[] = [];
				const fees: bigint[] = [];
				for (const pt of supported) {
					try {
						const fee = await lpFactory.getLaunchFee(pt);
						tokens.push(pt);
						fees.push(fee);
					} catch {}
				}
				feeTokens = tokens;
				feeAmounts = fees;
				const { matchedOptions, matchedFees } = matchFeesToPayments(tokens, fees, options);
				if (matchedOptions.length > 0) {
					paymentOptions = matchedOptions;
					feeAmounts = matchedFees;
				}
			} else {
				const pro = getProviderForNetwork(info!.network.chain_id)
					?? new ethers.JsonRpcProvider(info!.network.rpc);
				const factory = new ethers.Contract(info!.network.platform_address, FACTORY_ABI, pro);
				const lpAddr = info!.network.launchpad_address && info!.network.launchpad_address !== '0x'
					? info!.network.launchpad_address
					: ZERO_ADDRESS;
				const [tokens, fees, launchFees] = await factory.getCreationFees(
					info!.isTaxable, info!.isMintable, info!.isPartner, lpAddr
				);

				feeTokens = [...tokens];
				feeAmounts = [...fees];
				feeCache.set(key, { tokens: [...tokens], fees: [...fees], launchFees: [...launchFees] });

				const { matchedOptions, matchedFees } = matchFeesToPayments([...tokens], [...fees], options);
				if (matchedOptions.length > 0) {
					paymentOptions = matchedOptions;
					feeAmounts = matchedFees;
				}
			}
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
				addFeedback({ message: e.shortMessage || e.message || 'Approval failed', type: 'error' });
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
			// Add 8% buffer for native payments to account for price movement between fee quote and tx execution
			const nativeFeeWithBuffer = isNativePayment ? selectedFee * 108n / 100n : 0n;
			const txOptions = isNativePayment ? { value: nativeFeeWithBuffer } : {};

			// For existing tokens, totalSupply is formatted (e.g. "1000000.0"), parse it back to wei
			// For new tokens, totalSupply is a raw integer (e.g. "1000000"), contract scales internally
			const isExisting = !!tokenInfo.existingTokenAddress;
			const totalSupplyRaw = isExisting
				? 0n // not used for existing token contract calls
				: BigInt(Math.floor(Number(tokenInfo.totalSupply)));
			const totalSupplyWei = isExisting
				? ethers.parseUnits(tokenInfo.totalSupply, tokenInfo.decimals)
				: totalSupplyRaw * (10n ** BigInt(tokenInfo.decimals));

			const tokenParams = {
				name: tokenInfo.name,
				symbol: tokenInfo.symbol,
				totalSupply: totalSupplyRaw,
				decimals: tokenInfo.decimals,
				isTaxable: tokenInfo.isTaxable,
				isMintable: tokenInfo.isMintable,
				isPartner: tokenInfo.isPartner,
				paymentToken: selectedPayment.address
			};

			if (tokenInfo.existingTokenAddress && tokenInfo.launch?.enabled) {
				// Existing token — use LaunchpadFactory.createLaunch directly
				addFeedback({ message: 'Creating launch for existing token...', type: 'info' });
				const { LAUNCHPAD_FACTORY_ABI, LAUNCH_INSTANCE_ABI } = await import('$lib/launchpad');

				let usdtDec = 18;
				try {
					const usdtC = new ethers.Contract(tokenInfo.network.usdt_address, ['function decimals() view returns (uint8)'], signer);
					usdtDec = Number(await usdtC.decimals());
				} catch {}

				const tokensForLaunch = (totalSupplyWei * BigInt(tokenInfo.launch.tokensForLaunchPct)) / 100n;
				const factory = new ethers.Contract(tokenInfo.network.launchpad_address, LAUNCHPAD_FACTORY_ABI, signer);

				// Check and pay launch fee
				const launchFee: bigint = await factory.getLaunchFee(selectedPayment.address);
				const isNativeLaunchFee = selectedPayment.address === ZERO_ADDRESS;
				if (!isNativeLaunchFee && launchFee > 0n) {
					const erc20 = new ethers.Contract(selectedPayment.address, ERC20_ABI, signer);
					const allowance = await erc20.allowance(userAddress, tokenInfo.network.launchpad_address);
					if (allowance < launchFee) {
						addFeedback({ message: `Approving ${selectedPayment.symbol} for launch fee...`, type: 'info' });
						const approveTx = await erc20.approve(tokenInfo.network.launchpad_address, launchFee);
						await approveTx.wait();
					}
				}

				const txOptions = isNativeLaunchFee && launchFee > 0n ? { value: launchFee } : {};
				const tx = await factory.createLaunch(
					tokenInfo.existingTokenAddress,
					tokensForLaunch,
					BigInt(tokenInfo.launch.curveType),
					ethers.parseUnits(String(tokenInfo.launch.softCap), usdtDec),
					ethers.parseUnits(String(tokenInfo.launch.hardCap), usdtDec),
					BigInt(tokenInfo.launch.durationDays),
					BigInt(tokenInfo.launch.maxBuyBps),
					BigInt(tokenInfo.launch.creatorAllocationBps),
					BigInt(tokenInfo.launch.vestingDays),
					selectedPayment.address,
					0n, // startTimestamp
					txOptions
				);
				deployTxHash = tx.hash;
				const receipt = await tx.wait();

				// Extract launch address
				let launchAddr: string | null = null;
				const createdEvent = receipt?.logs?.find((log: any) => {
					try {
						const parsed = factory.interface.parseLog({ topics: [...log.topics], data: log.data });
						return parsed?.name === 'LaunchCreated';
					} catch { return false; }
				});
				if (createdEvent) {
					const parsed = factory.interface.parseLog({ topics: [...createdEvent.topics], data: createdEvent.data });
					launchAddr = parsed?.args?.launch ?? null;
				}

				deployedTokenAddress = tokenInfo.existingTokenAddress ?? null;

				if (launchAddr) {
					// Approve + deposit tokens
					addFeedback({ message: 'Depositing tokens into launch...', type: 'info' });
					const tokenContract = new ethers.Contract(tokenInfo.existingTokenAddress!, ERC20_ABI, signer);
					const allowance = await tokenContract.allowance(userAddress, launchAddr);
					if (allowance < tokensForLaunch) {
						addFeedback({ message: `Approving ${tokenInfo.symbol}...`, type: 'info' });
						const approveTx = await tokenContract.approve(launchAddr, tokensForLaunch);
						await approveTx.wait();
					}
					const instance = new ethers.Contract(launchAddr, LAUNCH_INSTANCE_ABI, signer);
					const depositTx = await instance.depositTokens(tokensForLaunch);
					await depositTx.wait();

					addFeedback({ message: 'Launch is live!', type: 'success' });
					// Launch data indexed by daemon from on-chain events
				}

			} else if (tokenInfo.launch?.enabled && tokenInfo.network.router_address && tokenInfo.network.router_address !== '0x') {
				// Use PlatformRouter for atomic Create + Launch
				addFeedback({ message: 'Creating token & launch...', type: 'info' });
				const router = new ethers.Contract(tokenInfo.network.router_address, PLATFORM_ROUTER_ABI, signer);

				const tokensForLaunch = (totalSupplyWei * BigInt(tokenInfo.launch.tokensForLaunchPct)) / 100n;

				// Fetch USDT decimals for cap parsing
				let usdtDec = 18;
				try {
					const usdtC = new ethers.Contract(tokenInfo.network.usdt_address, ['function decimals() view returns (uint8)'], signer);
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
					launchPaymentToken: selectedPayment.address,
					startTimestamp: 0n
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

				const tx = await router.createTokenAndLaunch(tokenParams, launchParams, protectionParams, taxParams, referral, txOptions);
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

				// Native pair first (if any)
				if (nativePair && Number(nativePair.amount) > 0) {
					const ethAmt = Number(nativePair.amount);
					bases.push(ethers.ZeroAddress);
					baseAmounts.push(ethers.parseEther(String(ethAmt)));
					tokenAmounts.push(ethers.parseUnits((ethAmt / price).toFixed(6), tokenInfo.decimals));
					ethValue = ethers.parseEther(String(ethAmt));
				}

				// ERC20 pairs
				for (const pair of erc20Pairs) {
					const baseAddress = getBaseTokenAddress(network, pair.base);
					const baseDecimals = getBaseDecimals(network, pair.base);
					const baseAmt = Number(pair.amount);
					bases.push(baseAddress);
					baseAmounts.push(ethers.parseUnits(String(baseAmt), baseDecimals));
					tokenAmounts.push(ethers.parseUnits((baseAmt / price).toFixed(6), tokenInfo.decimals));
				}

				const listParams = { bases, baseAmounts, tokenAmounts };
				const nativeValue = (isNativePayment ? selectedFee * 108n / 100n : 0n) + ethValue;

				const tx = await router.createAndList(
					tokenParams, listParams,
					protectionParams, taxParams, referral,
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
				// Simple token creation (no launch, no listing)
				const factory = new ethers.Contract(tokenInfo.network.platform_address, FACTORY_ABI, signer);

				addFeedback({ message: 'Deploying token...', type: 'info' });
				const tx = await factory.createToken(tokenParams, referral, txOptions);
				deployTxHash = tx.hash;
				const receipt = await tx.wait();

				const createdEvent = receipt?.logs?.find((log: any) => {
					try {
						const parsed = factory.interface.parseLog({ topics: [...log.topics], data: log.data });
						return parsed?.name === 'TokenCreated';
					} catch { return false; }
				});
				if (createdEvent) {
					const parsed = factory.interface.parseLog({ topics: [...createdEvent.topics], data: createdEvent.data });
					deployedTokenAddress = parsed?.args?.tokenAddress ?? null;
				}

				addFeedback({ message: 'Token created successfully!', type: 'success' });
			}

			// Save token metadata to DB if provided
			if (deployedTokenAddress && tokenInfo.metadata) {
				const m = tokenInfo.metadata;
				if (m.logoUrl || m.description || m.website || m.twitter || m.telegram) {
					// Upload logo file if pending
					let finalLogoUrl = m.logoUrl;
					const pendingFile = (window as any).__pendingLogoFile as File | undefined;
					if (pendingFile && deployedTokenAddress) {
						try {
							const fd = new FormData();
							fd.append('file', pendingFile);
							fd.append('address', deployedTokenAddress.toLowerCase());
							fd.append('chain_id', String(tokenInfo.network.chain_id));
							const uploadRes = await fetch('/api/token-metadata/upload', { method: 'POST', body: fd });
							if (uploadRes.ok) {
								const { logo_url } = await uploadRes.json();
								finalLogoUrl = logo_url;
							}
							delete (window as any).__pendingLogoFile;
						} catch {}
					}

					fetch('/api/token-metadata', {
						method: 'PUT',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							address: deployedTokenAddress.toLowerCase(),
							chain_id: tokenInfo.network.chain_id,
							name: tokenInfo.name,
							symbol: tokenInfo.symbol,
							logo_url: finalLogoUrl?.startsWith('data:') ? null : finalLogoUrl || null,
							description: m.description || null,
							website: m.website || null,
							twitter: m.twitter || null,
							telegram: m.telegram || null,
						}),
					}).catch(() => {});
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
					}
				} catch {}
			}

			step = 'done';
		} catch (e: any) {
			const msg = e.shortMessage || e.message || 'Transaction failed';
			addFeedback({ message: `Error: ${msg}`, type: 'error' });
			step = 'review';
		} finally {
			isCreating = false;
		}
	}

	function getBaseTokenAddress(network: SupportedNetwork, baseCoin: string): string {
		if (baseCoin === 'native') return ZERO_ADDRESS;
		if (baseCoin === 'usdt') return network.usdt_address;
		return network.usdc_address;
	}

	function getBaseDecimals(network: SupportedNetwork, baseCoin: string): number {
		if (baseCoin === 'native') return 18;
		return network.chain_id === 56 ? 18 : 6;
	}

	function getBaseSymbol(network: SupportedNetwork, baseCoin: string): string {
		if (baseCoin === 'native') return network.native_coin;
		return baseCoin.toUpperCase();
	}

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

			// Step 2: Calculate total tokens needed and approve
			let totalTokensNeeded = 0n;
			for (const pair of pairs) {
				const baseAmt = Number(pair.amount);
				if (!baseAmt || baseAmt <= 0) continue;
				const tokensForPair = baseAmt / price;
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

				const tokensForPair = baseAmt / price;
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
			addFeedback({ message: `Liquidity failed: ${e.shortMessage || e.message || 'Unknown error'}. You can add remaining pairs manually.`, type: 'error' });
		}
	}

	async function confirmAndDeploy() {
		if (!tokenInfo) return;
		if (!signer || !userAddress) {
			deployAfterConnect = true;
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
						<a href="/manage-tokens" class="btn-primary text-sm px-5 py-2.5 no-underline">
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
						<div class="deposit-amount-copy" onclick={() => { navigator.clipboard.writeText(isNativePayment ? parseFloat(ethers.formatUnits(totalNativeNeeded, 18)).toFixed(4) : selectedFeeFormatted || '0'); addFeedback({ message: 'Amount copied', type: 'success' }); }}>
							<span class="deposit-amount-value">{isNativePayment ? parseFloat(ethers.formatUnits(totalNativeNeeded, 18)).toFixed(4) : selectedFeeFormatted} {selectedPayment?.symbol}</span>
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
						</div>
						<span class="deposit-amount-bal">Balance: {parseFloat(ethers.formatUnits(userBalance, selectedPayment?.decimals ?? 18)).toFixed(4)} {selectedPayment?.symbol}</span>
					</div>

					<div class="deposit-qr-row">
						<div class="qr-placeholder">
							<img
								src="https://api.qrserver.com/v1/create-qr-code/?size=120x120&data={userAddress}&bgcolor=ffffff&color=000000&margin=6"
								alt="QR" class="qr-img" width="120" height="120"
							/>
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
				<!-- Progress view -->
				<div class="text-center py-10">
					<div class="spinner w-12 h-12 rounded-full border-2 border-white/10 border-t-cyan-400 mx-auto mb-6"></div>
					<p class="text-cyan-300 font-mono text-sm mb-6">
						{step === 'checking-balance' ? $t('ct.checkingBalance') :
						 step === 'approving' ? `${$t('ct.approvingSpend')} (${selectedPayment?.symbol})...` :
						 step === 'creating' ? $t('ct.deployingContract') + '...' :
						 step === 'approving-listing' ? $t('ct.approvingDex') + '...' :
						 step === 'adding-liquidity' ? $t('ct.addingLiquidity') + '...' : $t('ct.processing')}
					</p>
					<div class="flex flex-col gap-2 text-left">
						{#each deploySteps() as ds}
							{@const status = stepStatus(ds.key)}
							<div class="flex items-center gap-3 text-sm font-mono {status === 'active' ? 'text-cyan-300' : status === 'done' ? 'text-emerald-400' : 'text-gray-600'}">
								<span class="w-4">{status === 'done' ? 'v' : status === 'active' ? 'o' : '-'}</span>
								{ds.label}
								{#if ds.key === 'approving' && isNativePayment}
									<span class="text-gray-600 text-xs">{$t('ct.skipped')}</span>
								{/if}
							</div>
						{/each}
					</div>
					{#if deployTxHash && tokenInfo}
						<div class="mt-4">
							<a
								href={getExplorerUrl(tokenInfo.network.chain_id, 'tx', deployTxHash)}
								target="_blank"
								rel="noopener noreferrer"
								class="text-gray-500 text-[11px] font-mono hover:text-gray-300 transition no-underline"
							>Tx: {deployTxHash.slice(0, 10)}...{deployTxHash.slice(-8)} -></a>
						</div>
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
							<span class="receipt-label">Creation fee</span>
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
									{selectedFeeFormatted} {selectedPayment?.symbol}{#if tokenInfo.listing?.enabled}{#each (tokenInfo.listing.pairs || []).filter(p => Number(p.amount) > 0 && p.base === 'native') as pair} + {pair.amount} {tokenInfo.network.native_coin}{/each}{/if}
								{/if}
							</span>
						</div>
					</div>

					{#if !feeLoading && paymentOptions.length > 0}
						<div class="field-group mt-3">
							<label class="label-text" for="payment-method">{$t('ct.paymentMethod')}</label>
							<select id="payment-method" class="input-field" bind:value={selectedPaymentIndex}>
								{#each paymentOptions as opt, i}
									<option value={i}>{opt.name} ({parseFloat(ethers.formatUnits(feeAmounts[i] ?? 0n, opt.decimals)).toFixed(4)} {opt.symbol})</option>
								{/each}
							</select>
						</div>
					{/if}
				</div>

				<button
					onclick={confirmAndDeploy}
					disabled={feeLoading || paymentOptions.length === 0}
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
		<!-- ═══════ INTENT SELECTION SCREEN ═══════ -->
		<div class="text-center mb-10">
			<h1 class="syne text-3xl sm:text-4xl font-bold text-white mt-4 mb-2">{$t('ci.pageTitle')}</h1>
			<p class="text-gray-400 font-mono text-sm">{$t('ci.pageSub')}</p>
		</div>

		<div class="intent-grid">
			<!-- Create Token -->
			<button class="intent-card card card-hover" onclick={() => selectMode('token')}>
				<div class="intent-icon cyan">
					<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v12M6 12h12"/></svg>
				</div>
				<h3 class="syne text-lg font-bold text-white mt-4 mb-1">{$t('ci.createToken')}</h3>
				<p class="text-gray-400 font-mono text-xs">{$t('ci.createTokenSub')}</p>
			</button>

			<!-- Create & Launch (FEATURED) -->
			<button class="intent-card intent-card-featured" onclick={() => selectMode('both')}>
				<span class="badge badge-cyan intent-badge-top">{$t('ci.recommended')}</span>
				<div class="intent-icon cyan">
					<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
				</div>
				<h3 class="syne text-xl font-bold text-white mt-4 mb-1">{$t('ci.createAndLaunch')}</h3>
				<p class="text-gray-500 font-mono text-xs leading-relaxed">{$t('ci.createAndLaunchSub')}</p>
			</button>

			<!-- Create & List on DEX -->
			<button class="intent-card card card-hover" onclick={() => selectMode('list')}>
				<div class="intent-icon" style="color: #f59e0b;">
					<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
				</div>
				<h3 class="syne text-lg font-bold text-white mt-4 mb-1">Create & List on DEX</h3>
				<p class="text-gray-400 font-mono text-xs">Create token and add liquidity to DEX instantly. One click.</p>
			</button>

			<!-- Launch Existing Token -->
			<button class="intent-card card card-hover" onclick={() => selectMode('launch')}>
				<div class="intent-icon emerald">
					<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>
				</div>
				<h3 class="syne text-lg font-bold text-white mt-4 mb-1">{$t('ci.launchExisting')}</h3>
				<p class="text-gray-400 font-mono text-xs">{$t('ci.launchExistingSub')}</p>
			</button>
		</div>

	{:else if mode === 'token' || mode === 'both' || mode === 'launch' || mode === 'list'}
		<!-- ═══════ TOKEN / BOTH / LAUNCH WIZARD ═══════ -->
		<div class="create-split">
			<div class="form-wrapper">
				<button class="back-link" onclick={backToSelection}>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
					{$t('ci.backToSelection')}
				</button>
				<div class="form-header">
					<span class="badge badge-cyan">{mode === 'token' ? $t('ci.titleToken') : mode === 'launch' ? $t('ci.titleLaunch') : $t('ci.titleBoth')}</span>
					<h1 class="syne text-2xl sm:text-3xl font-bold text-white mt-3 mb-1">{pageTitle}</h1>
					<p class="text-gray-500 font-mono text-sm">{mode === 'token' ? $t('ci.metaToken') : mode === 'launch' ? $t('ci.metaLaunch') : $t('ci.metaBoth')}</p>
				</div>
				<TokenForm {supportedNetworks} {addFeedback} {updateTokenInfo} onPreviewChange={handlePreviewChange} initialData={initialFormData} forceMode={mode === 'token' ? 'token' : mode === 'launch' ? 'launch' : mode === 'list' ? 'list' : 'both'} />
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

	{:else if mode === 'launch'}
		<!-- ═══════ LAUNCH EXISTING TOKEN FORM ═══════ -->
		<div class="form-wrapper">
			<button class="back-link" onclick={backToSelection}>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
				{$t('ci.backToSelection')}
			</button>
			<div class="form-header">
				<span class="badge badge-cyan">{$t('ci.titleLaunch')}</span>
				<h1 class="syne text-2xl sm:text-3xl font-bold text-white mt-3 mb-1">{$t('ci.titleLaunch')}</h1>
				<p class="text-gray-500 font-mono text-sm">{$t('ci.metaLaunch')}</p>
			</div>
			<div class="form-box card p-5 sm:p-8">

				{#if launchStep === 'done' && launchDeployedAddress}
					<!-- Success state -->
					<div class="card p-6 text-center">
						<div class="text-4xl mb-4 syne font-bold text-emerald-400">Done</div>
						<h2 class="syne text-xl font-bold text-white mb-2">{$t('ci.launchSuccess')}</h2>
						<p class="text-gray-400 font-mono text-sm mb-4">{launchTokenName} ({launchTokenSymbol}) is now live on {launchNetwork?.name}.</p>
						<div class="flex gap-3 justify-center flex-wrap">
							<a href="/launchpad/{launchDeployedAddress}" class="btn-primary text-sm px-5 py-2.5 no-underline">
								{$t('ci.viewLaunch')} ->
							</a>
							<button onclick={backToSelection} class="btn-secondary text-sm px-5 py-2.5 cursor-pointer">
								{$t('common.back')}
							</button>
						</div>
					</div>
				{:else}
					<form class="launch-form" autocomplete="off" onsubmit={(e) => { e.preventDefault(); submitLaunch(); }}>
						<!-- 1. Network select -->
						<div class="field-group mb-4">
							<label class="label-text" for="launch-network">{$t('ci.selectNetwork')} <Tooltip text="The network where your token is deployed." /></label>
							<select id="launch-network" class="input-field" bind:value={launchChainId}>
								<option value={undefined}>Select a network</option>
								{#each launchNetworks as n (n.chain_id)}
									<option value={n.chain_id}>{n.name} ({n.native_coin})</option>
								{/each}
							</select>
						</div>

						<!-- 2. Token address -->
						<div class="field-group mb-4">
							<label class="label-text" for="launch-token-addr">{$t('ci.tokenAddress')} <Tooltip text="Paste the contract address of your ERC-20 token." /></label>
							<input
								id="launch-token-addr"
								type="text"
								class="input-field"
								placeholder="0x..."
								bind:value={launchTokenAddress}
							/>
							{#if launchTokenLoading}
								<span class="text-gray-500 text-xs font-mono mt-1">{$t('ci.loadingTokenInfo')}</span>
							{:else if launchTokenName && launchTokenAddress}
								<div class="card p-3 mt-2">
									<div class="flex justify-between items-center">
										<span class="text-emerald-400 text-sm font-mono font-semibold">{launchTokenName} ({launchTokenSymbol})</span>
										<span class="text-gray-500 text-xs font-mono">{launchTokenDecimals} decimals</span>
									</div>
									<div class="flex justify-between items-center mt-1">
										<span class="text-gray-400 text-xs font-mono">{$t('ci.supply')}: {parseFloat(ethers.formatUnits(launchTokenSupply, launchTokenDecimals)).toLocaleString()}</span>
										<span class="text-gray-400 text-xs font-mono">{$t('ci.balance')}: {launchTokenBalance > 0n ? parseFloat(ethers.formatUnits(launchTokenBalance, launchTokenDecimals)).toLocaleString() : '0'}</span>
									</div>
								</div>
							{:else if launchTokenAddress && ethers.isAddress(launchTokenAddress) && !launchTokenLoading && launchChainId}
								<span class="text-red-400 text-xs font-mono mt-1">{$t('ci.tokenNotFound')}</span>
							{/if}
						</div>

						<!-- 3. Tokens for launch -->
						{#if launchTokenName}
							<div class="field-group mb-4">
								<label class="label-text" for="launch-amount">{$t('ci.tokensForLaunch')} <Tooltip text="How many tokens to deposit into the bonding curve for sale." /></label>
								<input
									id="launch-amount"
									type="text"
									class="input-field"
									placeholder="0"
									bind:value={launchAmount}
								/>
								<div class="flex gap-2 mt-2">
									{#each [25, 50, 75, 100] as pct}
										<button
											type="button"
											class="btn-secondary text-xs px-3 py-1.5 cursor-pointer"
											onclick={() => setLaunchAmountPct(pct)}
										>{pct}%</button>
									{/each}
								</div>
							</div>

							<!-- 4. Launch config -->
							<div class="card p-4 mb-4">
								<h3 class="syne text-base font-bold text-white mb-4">{$t('ci.launchConfig')}</h3>

								<div class="field-group mb-3">
									<label class="label-text" for="launch-curve">{$t('ci.curveType')} <Tooltip text="Controls how price increases as tokens are bought." /></label>
									<select id="launch-curve" class="input-field" bind:value={launchCurveType}>
										{#each CURVE_TYPES as ct, i}
											<option value={i}>{ct}</option>
										{/each}
									</select>
								</div>

								<div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
									<div class="field-group">
										<label class="label-text" for="launch-soft-cap">{$t('ci.softCap')} <Tooltip text="Minimum to raise. If not reached, buyers get a full refund." /></label>
										<input id="launch-soft-cap" type="number" class="input-field" bind:value={launchSoftCap} min="0" step="any" />
									</div>
									<div class="field-group">
										<label class="label-text" for="launch-hard-cap">{$t('ci.hardCap')} <Tooltip text="Maximum raise. When hit, token auto-graduates to DEX." /></label>
										<input id="launch-hard-cap" type="number" class="input-field" bind:value={launchHardCap} min="0" step="any" />
									</div>
								</div>

								<div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
									<div class="field-group">
										<label class="label-text" for="launch-duration">{$t('ci.durationDays')} <Tooltip text="How long the curve stays open. If soft cap isn't met, refunds are enabled." /></label>
										<select id="launch-duration" class="input-field" bind:value={launchDurationDays}>
											<option value="7">7 days</option>
											<option value="14">14 days</option>
											<option value="30">30 days</option>
											<option value="60">60 days</option>
											<option value="90">90 days</option>
										</select>
									</div>
									<div class="field-group">
										<label class="label-text" for="launch-max-buy">Max buy per wallet <Tooltip text="Max % of hard cap one wallet can buy." /></label>
										<select id="launch-max-buy" class="input-field" bind:value={launchMaxBuyPct}>
											<option value="0.5">0.5%</option>
											<option value="1">1%</option>
											<option value="2">2%</option>
											<option value="3">3%</option>
											<option value="5">5%</option>
										</select>
									</div>
								</div>

								<div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
									<div class="field-group">
										<label class="label-text" for="launch-creator-alloc">Creator allocation <Tooltip text="% of launch tokens reserved for you, released over vesting period." /></label>
										<select id="launch-creator-alloc" class="input-field" bind:value={launchCreatorAllocPct}>
											<option value="0">None</option>
											<option value="1">1%</option>
											<option value="2">2%</option>
											<option value="3">3%</option>
											<option value="5">5%</option>
											<option value="10">10%</option>
										</select>
									</div>
									{#if parseFloat(launchCreatorAllocPct) > 0}
										<div class="field-group">
											<label class="label-text" for="launch-vesting">{$t('ci.vestingDays')} <Tooltip text="Tokens unlock gradually over this period. Longer = stronger commitment signal." /></label>
											<select id="launch-vesting" class="input-field" bind:value={launchVestingDays}>
												<option value="0">No vesting</option>
												<option value="7">7 days</option>
												<option value="14">14 days</option>
												<option value="30">30 days</option>
												<option value="60">60 days</option>
												<option value="90">90 days</option>
											</select>
										</div>
									{/if}
								</div>
							</div>

							<!-- 5. Review -->
							<div class="card p-4 mb-4">
								<h3 class="syne text-base font-bold text-white mb-3">{$t('ci.reviewLaunch')}</h3>
								<div class="detail-grid">
									<div class="detail-row">
										<span class="detail-label">Token</span>
										<span class="detail-value text-cyan-300">{launchTokenName} ({launchTokenSymbol})</span>
									</div>
									<div class="detail-row">
										<span class="detail-label">Network</span>
										<span class="detail-value">{launchNetwork?.name ?? '-'}</span>
									</div>
									<div class="detail-row">
										<span class="detail-label">Tokens for launch</span>
										<span class="detail-value">{launchAmount ? parseFloat(launchAmount).toLocaleString() : '0'}</span>
									</div>
									<div class="detail-row">
										<span class="detail-label">Curve</span>
										<span class="detail-value">{CURVE_TYPES[launchCurveType as 0|1|2|3] ?? 'Linear'}</span>
									</div>
									<div class="detail-row">
										<span class="detail-label">Soft / Hard Cap</span>
										<span class="detail-value">${launchSoftCap} / ${launchHardCap}</span>
									</div>
									<div class="detail-row">
										<span class="detail-label">Duration</span>
										<span class="detail-value">{launchDurationDays} days</span>
									</div>
									<div class="detail-row">
										<span class="detail-label">Max buy</span>
										<span class="detail-value">{launchMaxBuyPct}%</span>
									</div>
									{#if parseFloat(launchCreatorAllocPct) > 0}
										<div class="detail-row">
											<span class="detail-label">Creator alloc</span>
											<span class="detail-value">{launchCreatorAllocPct}% ({launchVestingDays}d vesting)</span>
										</div>
									{/if}
								</div>
							</div>

							<!-- 6. Submit -->
							<button
								type="submit"
								class="btn-primary w-full py-3.5 text-base justify-center cursor-pointer"
								disabled={launchSubmitting || !launchTokenName || !launchAmount || parseFloat(launchAmount) <= 0}
							>
								{#if launchSubmitting}
									<span class="spinner-inline"></span>
									{launchStep === 'fee' ? 'Fetching fee...' :
									 launchStep === 'approving-fee' ? $t('ci.approvingFee') :
									 launchStep === 'creating' ? $t('ci.creatingLaunch') :
									 launchStep === 'approving-tokens' ? $t('ci.approvingTokens') :
									 launchStep === 'depositing' ? $t('ci.depositingTokens') :
									 launchStep === 'saving' ? 'Saving...' : $t('ci.creatingLaunch')}
								{:else}
									{$t('ci.createLaunch')}
								{/if}
							</button>
						{/if}
					</form>
				{/if}
			</div>
		</div>
	{/if}
</div>

<style>
	.create-split { display: flex; gap: 28px; align-items: flex-start; }
	.create-split > .form-wrapper { flex: 1; min-width: 0; max-width: none; }
	.create-preview-col { width: 320px; flex-shrink: 0; position: sticky; top: 80px; }
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
	.review-token-name { font-family: 'Syne', sans-serif; font-size: 15px; font-weight: 700; color: #fff; }
	.review-token-chain { font-size: 10px; color: #00d2ff; font-family: 'Space Mono', monospace; }
	.review-badges { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 12px; }

	.receipt { display: flex; flex-direction: column; gap: 0; }
	.receipt-row {
		display: flex; justify-content: space-between; align-items: center;
		padding: 6px 0; font-family: 'Space Mono', monospace; font-size: 11px;
	}
	.receipt-label { color: #64748b; }
	.receipt-value { color: #e2e8f0; font-weight: 600; font-family: 'Rajdhani', sans-serif; font-size: 13px; font-variant-numeric: tabular-nums; text-align: right; }
	.receipt-note { color: #64748b; font-weight: 400; font-size: 10px; font-family: 'Space Mono', monospace; }
	.receipt-divider { height: 1px; background: rgba(255,255,255,0.06); margin: 6px 0; }
	.receipt-total .receipt-label { color: #fff; font-weight: 700; }
	.receipt-total .receipt-value { color: #00d2ff; font-size: 15px; font-weight: 700; }

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

	.insufficient-box {
		padding: 14px;
		background: rgba(245,158,11,0.08);
		border: 1px solid rgba(245,158,11,0.2);
		border-radius: 10px;
	}

	/* Deposit screen */
	.deposit-screen { display: flex; flex-direction: column; gap: 12px; }
	.deposit-amount { text-align: center; padding: 10px; background: rgba(0,210,255,0.04); border: 1px solid rgba(0,210,255,0.1); border-radius: 10px; }
	.deposit-amount-label { display: block; font-size: 10px; color: #64748b; font-family: 'Space Mono', monospace; }
	.deposit-amount-value { display: block; font-family: 'Rajdhani', sans-serif; font-size: 26px; font-weight: 700; color: #00d2ff; font-variant-numeric: tabular-nums; }
	.deposit-amount-bal { display: block; font-size: 9px; color: #f59e0b; font-family: 'Space Mono', monospace; }
	.deposit-qr-row { display: flex; align-items: center; gap: 14px; padding: 12px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); border-radius: 10px; }
	.deposit-amount-copy {
		display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
		transition: opacity 0.12s; justify-content: center;
	}
	.deposit-amount-copy:hover { opacity: 0.8; }
	.deposit-amount-copy svg { color: #475569; }
	.deposit-addr-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; cursor: pointer; transition: opacity 0.12s; }
	.deposit-addr-info:hover { opacity: 0.8; }
	.deposit-addr-label { font-size: 9px; color: #475569; font-family: 'Space Mono', monospace; text-transform: uppercase; letter-spacing: 0.04em; }
	.deposit-addr { font-size: 10px; color: #e2e8f0; font-family: 'Space Mono', monospace; word-break: break-all; line-height: 1.5; }
	.deposit-addr-actions { display: flex; align-items: center; gap: 8px; }
	.deposit-copy-btn { display: inline-flex; align-items: center; gap: 3px; font-size: 9px; color: #00d2ff; font-family: 'Space Mono', monospace; }
	.deposit-network { font-size: 9px; color: #f59e0b; font-family: 'Space Mono', monospace; }
	.deposit-status { display: flex; align-items: center; justify-content: center; gap: 6px; font-size: 10px; color: #475569; font-family: 'Space Mono', monospace; }

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
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		padding: 28px 20px;
		cursor: pointer;
		transition: all 0.25s;
		border: 1px solid var(--border);
		background: var(--bg-surface);
		border-radius: 16px;
		position: relative;
	}
	.intent-card:hover {
		transform: translateY(-3px);
		box-shadow: 0 12px 40px rgba(0,0,0,0.3);
		border-color: rgba(0,210,255,0.2);
		background: rgba(0,210,255,0.03);
	}

	.intent-card-featured {
		padding: 36px 24px;
		border: 1.5px solid rgba(0, 210, 255, 0.3);
		background: var(--bg-surface);
		position: relative;
		overflow: hidden;
	}
	.intent-card-featured::before {
		content: '';
		position: absolute;
		inset: 0;
		background: radial-gradient(ellipse at 50% 0%, rgba(0, 210, 255, 0.08), transparent 70%);
		pointer-events: none;
	}
	.intent-card-featured:hover {
		border-color: rgba(0, 210, 255, 0.5);
		box-shadow: 0 0 40px rgba(0, 210, 255, 0.15), 0 12px 40px rgba(0, 0, 0, 0.3);
		background: rgba(0, 210, 255, 0.03);
	}

	.intent-badge-top {
		margin-bottom: 12px;
	}

	.intent-icon {
		width: 56px;
		height: 56px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 14px;
	}
	.intent-icon.cyan {
		background: rgba(0,210,255,0.1);
		color: #00d2ff;
		border: 1px solid rgba(0,210,255,0.2);
	}
	.intent-icon.emerald {
		background: rgba(16,185,129,0.1);
		color: #10b981;
		border: 1px solid rgba(16,185,129,0.2);
	}
	.intent-icon.purple {
		background: rgba(139,92,246,0.1);
		color: #a78bfa;
		border: 1px solid rgba(139,92,246,0.2);
	}

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
