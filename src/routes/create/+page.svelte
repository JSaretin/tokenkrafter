<script lang="ts">
	import { ethers } from 'ethers';
	import { getContext, onDestroy } from 'svelte';
	import { page } from '$app/stores';
	import { browser } from '$app/environment';
	import type { SupportedNetwork, PaymentOption } from '$lib/structure';
	import { FACTORY_ABI, ROUTER_ABI, ERC20_ABI, ZERO_ADDRESS } from '$lib/tokenCrafter';
	import TokenForm from './lib/TokenForm.svelte';
	import type { ListingConfig, LaunchConfig, ProtectionConfig, TaxConfig, TokenFormData, PreviewState } from './lib/TokenForm.svelte';
	import DisplayPreview from './lib/DisplayPreview.svelte';

	let getProvider: () => ethers.BrowserProvider | null = getContext('provider');
	let getSigner: () => ethers.Signer | null = getContext('signer');
	let getUserAddress: () => string | null = getContext('userAddress');
	let connectWallet: () => Promise<boolean> = getContext('connectWallet');
	const addFeedback = getContext<(f: { message: string; type: string }) => void>('addFeedback');
	const supportedNetworks: SupportedNetwork[] = getContext('supportedNetworks');
	let getNetworkProviders: () => Map<number, ethers.JsonRpcProvider> = getContext('networkProviders');
	let getProvidersReady: () => boolean = getContext('providersReady');
	let getPaymentOptions: (network: SupportedNetwork) => PaymentOption[] = getContext('getPaymentOptions');
	let checkWcReachable: () => Promise<boolean> = getContext('checkWcReachable');

	// ── URL param helpers for deep link flow ──

	function parseFormFromUrl(): { data: Partial<TokenFormData>; autoCreate: boolean } | null {
		if (!browser) return null;
		const params = new URLSearchParams(window.location.search);
		if (!params.has('name')) return null;

		const network = supportedNetworks.find(n => n.chain_id === Number(params.get('chainId')));

		const data: Partial<TokenFormData> = {
			name: params.get('name') || '',
			symbol: params.get('symbol') || '',
			totalSupply: params.get('totalSupply') || '',
			decimals: Number(params.get('decimals') || '18'),
			isMintable: params.get('isMintable') === '1',
			isTaxable: params.get('isTaxable') === '1',
			isPartner: params.get('isPartner') === '1',
			network,
			tax: {
				buyTaxPct: params.get('buyTax') || '0',
				sellTaxPct: params.get('sellTax') || '0',
				transferTaxPct: params.get('transferTax') || '0',
				wallets: params.get('taxWallets')
					? params.get('taxWallets')!.split(';').map(w => {
						const [address, sharePct] = w.split(':');
						return { address, sharePct: sharePct || '100' };
					})
					: []
			},
			launch: {
				enabled: params.get('launchEnabled') === '1',
				tokensForLaunchPct: Number(params.get('launchTokensPct') || '40'),
				curveType: Number(params.get('curveType') || '0'),
				softCap: params.get('softCap') || '5',
				hardCap: params.get('hardCap') || '50',
				durationDays: params.get('durationDays') || '30',
				maxBuyBps: params.get('maxBuyBps') || '200',
				creatorAllocationBps: params.get('creatorAllocBps') || '0',
				vestingDays: params.get('vestingDays') || '0',
				launchPaymentToken: ZERO_ADDRESS
			},
			protection: {
				maxWalletPct: params.get('maxWalletPct') || '0',
				maxTransactionPct: params.get('maxTxPct') || '0',
				cooldownSeconds: params.get('cooldown') || '0'
			},
			listing: {
				enabled: params.get('listingEnabled') === '1',
				baseCoin: (params.get('listBaseCoin') as 'native' | 'usdt' | 'usdc') || 'native',
				mode: (params.get('listMode') as 'manual' | 'price') || 'manual',
				tokenAmount: params.get('listTokenAmt') || '',
				baseAmount: params.get('listBaseAmt') || '',
				pricePerToken: params.get('listPrice') || '',
				listBaseAmount: params.get('listBaseTotal') || ''
			}
		};

		return { data, autoCreate: params.get('connectAndCreate') === '1' };
	}

	function formDataToParams(info: TokenFormData): URLSearchParams {
		const p = new URLSearchParams();
		p.set('name', info.name);
		p.set('symbol', info.symbol);
		p.set('totalSupply', info.totalSupply);
		p.set('decimals', String(info.decimals));
		p.set('chainId', String(info.network.chain_id));
		if (info.isMintable) p.set('isMintable', '1');
		if (info.isTaxable) p.set('isTaxable', '1');
		if (info.isPartner) p.set('isPartner', '1');
		if (info.isTaxable) {
			if (info.tax.buyTaxPct && info.tax.buyTaxPct !== '0') p.set('buyTax', info.tax.buyTaxPct);
			if (info.tax.sellTaxPct && info.tax.sellTaxPct !== '0') p.set('sellTax', info.tax.sellTaxPct);
			if (info.tax.transferTaxPct && info.tax.transferTaxPct !== '0') p.set('transferTax', info.tax.transferTaxPct);
			if (info.tax.wallets.length) {
				p.set('taxWallets', info.tax.wallets.map(w => `${w.address}:${w.sharePct}`).join(';'));
			}
		}
		if (info.launch.enabled) {
			p.set('launchEnabled', '1');
			p.set('launchTokensPct', String(info.launch.tokensForLaunchPct));
			p.set('curveType', String(info.launch.curveType));
			p.set('softCap', info.launch.softCap);
			p.set('hardCap', info.launch.hardCap);
			p.set('durationDays', info.launch.durationDays);
			p.set('maxBuyBps', info.launch.maxBuyBps);
			p.set('creatorAllocBps', info.launch.creatorAllocationBps);
			p.set('vestingDays', info.launch.vestingDays);
		}
		if (info.protection.maxWalletPct !== '0') p.set('maxWalletPct', info.protection.maxWalletPct);
		if (info.protection.maxTransactionPct !== '0') p.set('maxTxPct', info.protection.maxTransactionPct);
		if (info.protection.cooldownSeconds !== '0') p.set('cooldown', info.protection.cooldownSeconds);
		if (info.listing.enabled) {
			p.set('listingEnabled', '1');
			p.set('listBaseCoin', info.listing.baseCoin);
			p.set('listMode', info.listing.mode);
			if (info.listing.tokenAmount) p.set('listTokenAmt', info.listing.tokenAmount);
			if (info.listing.baseAmount) p.set('listBaseAmt', info.listing.baseAmount);
			if (info.listing.pricePerToken) p.set('listPrice', info.listing.pricePerToken);
			if (info.listing.listBaseAmount) p.set('listBaseTotal', info.listing.listBaseAmount);
		}
		p.set('connectAndCreate', '1');
		return p;
	}

	function getDeepLinks(info: TokenFormData): { name: string; icon: string; href: string }[] {
		const params = formDataToParams(info);
		const createUrl = `${window.location.origin}/create?${params}`;
		const stripped = createUrl.replace(/^https?:\/\//, '');
		return [
			{ name: 'MetaMask', icon: '🦊', href: `https://metamask.app.link/dapp/${stripped}` },
			{ name: 'Trust Wallet', icon: '🛡️', href: `https://link.trustwallet.com/open_url?coin_id=56&url=${encodeURIComponent(createUrl)}` },
			{ name: 'Binance Wallet', icon: '💛', href: `https://app.binance.com/cedefi/dapp-web-view?dappUrl=${encodeURIComponent(createUrl)}` },
			{ name: 'Coinbase Wallet', icon: '🔵', href: `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(createUrl)}` }
		];
	}

	const urlFormData = parseFormFromUrl();
	let initialData = urlFormData?.data;
	let autoSubmit = urlFormData?.autoCreate ?? false;

	let provider = $derived(getProvider());
	let signer = $derived(getSigner());
	let userAddress = $derived(getUserAddress());
	let networkProviders = $derived(getNetworkProviders());
	let providersReady = $derived(getProvidersReady());

	let showPreview = $state(false);
	let showWalletPicker = $state(false);
	let walletDeepLinks: { name: string; icon: string; href: string }[] = $state([]);
	let isCreating = $state(false);
	let step = $state<'idle' | 'review' | 'checking-balance' | 'waiting-deposit' | 'approving' | 'creating' | 'approving-listing' | 'adding-liquidity' | 'done'>('idle');
	let deployAfterConnect = $state(false);
	let deployedTokenAddress: string | null = $state(null);
	let deployedLaunchAddress: string | null = $state(null);
	let deployTxHash: string | null = $state(null);

	let previewState: PreviewState | null = $state(null);
	function handlePreviewChange(state: PreviewState) {
		previewState = state;
	}

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

	// Preloaded fee cache: keyed by "chainId-isTaxable-isMintable-isPartner"
	let feeCache = new Map<string, { tokens: string[]; fees: bigint[] }>();
	let feeCacheReady = $state(false);

	function feeCacheKey(chainId: number, isTaxable: boolean, isMintable: boolean, isPartner: boolean) {
		return `${chainId}-${isTaxable}-${isMintable}-${isPartner}`;
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

			for (const taxable of [false, true]) {
				for (const mintable of [false, true]) {
					for (const partner of [false, true]) {
						const key = feeCacheKey(net.chain_id, taxable, mintable, partner);
						promises.push(
							factory.getCreationFee(taxable, mintable, partner)
								.then(([tokens, fees]: [string[], bigint[]]) => {
									feeCache.set(key, { tokens: [...tokens], fees: [...fees] });
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

	// Auto-trigger deploy when opened via deep link with connectAndCreate
	let autoCreateTriggered = false;
	$effect(() => {
		if (autoSubmit && tokenInfo && step === 'review' && !autoCreateTriggered) {
			autoCreateTriggered = true;
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

		// Try to use preloaded cache
		const key = feeCacheKey(info!.network.chain_id, info!.isTaxable, info!.isMintable, info!.isPartner);
		const cached = feeCache.get(key);

		if (cached) {
			feeTokens = cached.tokens;
			feeAmounts = cached.fees;
			const { matchedOptions, matchedFees } = matchFeesToPayments(cached.tokens, cached.fees, options);
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
			const pro = getProviderForNetwork(info!.network.chain_id)
				?? new ethers.JsonRpcProvider(info!.network.rpc);
			const factory = new ethers.Contract(info!.network.platform_address, FACTORY_ABI, pro);
			const [tokens, fees] = await factory.getCreationFee(info!.isTaxable, info!.isMintable, info!.isPartner);

			feeTokens = [...tokens];
			feeAmounts = [...fees];

			// Cache for next time
			feeCache.set(key, { tokens: [...tokens], fees: [...fees] });

			const { matchedOptions, matchedFees } = matchFeesToPayments([...tokens], [...fees], options);
			if (matchedOptions.length > 0) {
				paymentOptions = matchedOptions;
				feeAmounts = matchedFees;
			}
		} catch (e) {
			console.error('Fee fetch error:', e);
			addFeedback({ message: 'Could not fetch fee. Check network.', type: 'error' });
		} finally {
			feeLoading = false;
		}
	}

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
				const erc20 = new ethers.Contract(selectedPayment.address, ERC20_ABI, signer);
				const allowance = await erc20.allowance(userAddress, tokenInfo.network.platform_address);
				if (allowance < selectedFee) {
					addFeedback({ message: `Approving ${selectedPayment.symbol} spend...`, type: 'info' });
					const tx = await erc20.approve(tokenInfo.network.platform_address, selectedFee);
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

		// Create token (or token + launch)
		step = 'creating';
		try {
			const factory = new ethers.Contract(tokenInfo.network.platform_address, FACTORY_ABI, signer);
			const tokenParams = {
				name: tokenInfo.name,
				symbol: tokenInfo.symbol,
				totalSupply: BigInt(tokenInfo.totalSupply),
				decimals: tokenInfo.decimals,
				isTaxable: tokenInfo.isTaxable,
				isMintable: tokenInfo.isMintable,
				isPartner: tokenInfo.isPartner,
				paymentToken: selectedPayment.address
			};

			const storedRef = localStorage.getItem('referral');
			const referral = storedRef && ethers.isAddress(storedRef) ? storedRef : ZERO_ADDRESS;

			if (tokenInfo.launch?.enabled) {
				// One-click: createTokenAndLaunch
				const supply = BigInt(tokenInfo.totalSupply) * (10n ** BigInt(tokenInfo.decimals));
				const tokensForLaunch = (supply * BigInt(tokenInfo.launch.tokensForLaunchPct)) / 100n;

				const launchParams = {
					tokensForLaunch,
					curveType: BigInt(tokenInfo.launch.curveType),
					softCap: ethers.parseUnits(String(tokenInfo.launch.softCap), 18),
					hardCap: ethers.parseUnits(String(tokenInfo.launch.hardCap), 18),
					durationDays: BigInt(tokenInfo.launch.durationDays),
					maxBuyBps: BigInt(tokenInfo.launch.maxBuyBps),
					creatorAllocationBps: BigInt(tokenInfo.launch.creatorAllocationBps),
					vestingDays: BigInt(tokenInfo.launch.vestingDays),
					launchPaymentToken: ZERO_ADDRESS // native payment for launch fee
				};

				// Anti-whale protection: convert % of supply to token amounts
				const prot = tokenInfo.protection;
				const protectionParams = {
					maxWalletAmount: prot.maxWalletPct !== '0'
						? (supply * BigInt(Math.round(parseFloat(prot.maxWalletPct) * 100))) / 10000n
						: 0n,
					maxTransactionAmount: prot.maxTransactionPct !== '0'
						? (supply * BigInt(Math.round(parseFloat(prot.maxTransactionPct) * 100))) / 10000n
						: 0n,
					cooldownSeconds: BigInt(prot.cooldownSeconds)
				};

				// Tax configuration: convert % to basis points
				const tax = tokenInfo.tax;
				const taxParams = {
					buyTaxBps: BigInt(Math.round((parseFloat(tax.buyTaxPct) || 0) * 100)),
					sellTaxBps: BigInt(Math.round((parseFloat(tax.sellTaxPct) || 0) * 100)),
					transferTaxBps: BigInt(Math.round((parseFloat(tax.transferTaxPct) || 0) * 100)),
					taxWallets: tax.wallets.map((w) => w.address),
					taxSharesBps: tax.wallets.map((w) => Math.round(parseFloat(w.sharePct) * 100))
				};

				addFeedback({ message: 'Creating token & launching...', type: 'info' });
				const txOptions = isNativePayment ? { value: selectedFee } : {};
				// For launch fee via native: user sends extra ETH. The factory forwards remainder to launchpad.
				// For simplicity, we use native coin for launch fee in the one-click flow.
				const tx = await factory.createTokenAndLaunch(tokenParams, launchParams, protectionParams, taxParams, referral, txOptions);
				deployTxHash = tx.hash;
				const receipt = await tx.wait();

				// Extract from TokenCreatedAndLaunched event
				const launchEvent = receipt?.logs?.find((log: any) => {
					try {
						const parsed = factory.interface.parseLog({ topics: [...log.topics], data: log.data });
						return parsed?.name === 'TokenCreatedAndLaunched';
					} catch { return false; }
				});
				if (launchEvent) {
					const parsed = factory.interface.parseLog({ topics: [...launchEvent.topics], data: launchEvent.data });
					deployedTokenAddress = parsed?.args?.token ?? null;
					deployedLaunchAddress = parsed?.args?.launch ?? null;
				}

				addFeedback({ message: 'Token created & launch activated!', type: 'success' });
			} else {
				// Standard: createToken
				addFeedback({ message: 'Deploying token...', type: 'info' });
				const txOptions = isNativePayment ? { value: selectedFee } : {};
				const tx = await factory.createToken(tokenParams, referral, txOptions);
				deployTxHash = tx.hash;
				const receipt = await tx.wait();

				// Extract token address from TokenCreated event
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

				// If listing is enabled, add liquidity
				if (tokenInfo.listing?.enabled && deployedTokenAddress) {
					await addListingLiquidity(deployedTokenAddress);
				}
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

		const tokenAmt = listing.mode === 'price'
			? (() => {
				if (!listing.pricePerToken || !listing.listBaseAmount || Number(listing.pricePerToken) <= 0) return '0';
				return (Number(listing.listBaseAmount) / Number(listing.pricePerToken)).toFixed(6);
			})()
			: listing.tokenAmount;
		const baseAmt = listing.mode === 'price' ? listing.listBaseAmount : listing.baseAmount;

		if (!tokenAmt || !baseAmt || Number(tokenAmt) <= 0 || Number(baseAmt) <= 0) {
			addFeedback({ message: 'Invalid listing amounts. Add liquidity manually from Manage Tokens.', type: 'error' });
			return;
		}

		const parsedTokenAmount = ethers.parseUnits(String(Number(tokenAmt)), tokenInfo.decimals);
		const isNativeBase = listing.baseCoin === 'native';
		const baseDecimals = getBaseDecimals(network, listing.baseCoin);
		const baseSymbol = getBaseSymbol(network, listing.baseCoin);

		try {
			// Approve token for router
			step = 'approving-listing';
			const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
			const allowance = await tokenContract.allowance(userAddress, routerAddress);
			if (allowance < parsedTokenAmount) {
				addFeedback({ message: `Approving ${tokenInfo.symbol} for DEX router...`, type: 'info' });
				const approveTx = await tokenContract.approve(routerAddress, parsedTokenAmount);
				await approveTx.wait();
			}

			const router = new ethers.Contract(routerAddress, ROUTER_ABI, signer);
			const deadline = Math.floor(Date.now() / 1000) + 1200;

			step = 'adding-liquidity';
			if (isNativeBase) {
				const ethAmount = ethers.parseEther(String(Number(baseAmt)));
				addFeedback({ message: `Adding ${tokenInfo.symbol}/${baseSymbol} liquidity...`, type: 'info' });
				const tx = await router.addLiquidityETH(
					tokenAddress,
					parsedTokenAmount,
					parsedTokenAmount * 95n / 100n,
					ethAmount * 95n / 100n,
					userAddress,
					deadline,
					{ value: ethAmount }
				);
				await tx.wait();
			} else {
				const baseAddress = getBaseTokenAddress(network, listing.baseCoin);
				const parsedBaseAmount = ethers.parseUnits(String(Number(baseAmt)), baseDecimals);

				// Approve base token
				const baseContract = new ethers.Contract(baseAddress, ERC20_ABI, signer);
				const baseAllowance = await baseContract.allowance(userAddress, routerAddress);
				if (baseAllowance < parsedBaseAmount) {
					addFeedback({ message: `Approving ${baseSymbol}...`, type: 'info' });
					const approveTx = await baseContract.approve(routerAddress, parsedBaseAmount);
					await approveTx.wait();
				}

				addFeedback({ message: `Adding ${tokenInfo.symbol}/${baseSymbol} liquidity...`, type: 'info' });
				const tx = await router.addLiquidity(
					tokenAddress,
					baseAddress,
					parsedTokenAmount,
					parsedBaseAmount,
					parsedTokenAmount * 95n / 100n,
					parsedBaseAmount * 95n / 100n,
					userAddress,
					deadline
				);
				await tx.wait();
			}

			addFeedback({ message: 'Liquidity added successfully!', type: 'success' });
		} catch (e: any) {
			addFeedback({ message: `Liquidity failed: ${e.shortMessage || e.message || 'Unknown error'}. You can add it manually from Manage Tokens.`, type: 'error' });
		}
	}

	async function confirmAndDeploy() {
		if (!tokenInfo) return;
		if (!signer || !userAddress) {
			deployAfterConnect = true;
			const connected = await connectWallet();
			if (connected) return; // will trigger via $effect

			// connectWallet returned false without connecting:
			// either WC is blocked, or user closed the modal, or no wallet
			if (!(window as any).ethereum) {
				const reachable = await checkWcReachable();
				if (!reachable) {
					// WC blocked — show deep links with form data
					walletDeepLinks = getDeepLinks(tokenInfo);
					showWalletPicker = true;
				}
			}
			return;
		}

		// Ensure wallet is on the correct network
		try {
			const walletProvider = new ethers.BrowserProvider((window as any).ethereum);
			const walletNetwork = await walletProvider.getNetwork();
			if (Number(walletNetwork.chainId) !== tokenInfo.network.chain_id) {
				addFeedback({ message: `Switching to ${tokenInfo.network.name}...`, type: 'info' });
				const switched = await switchNetwork(tokenInfo.network.chain_id);
				if (!switched) {
					return;
				}
			}
		} catch (e) {
			addFeedback({ message: 'Could not verify wallet network.', type: 'error' });
			return;
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
		deployedLaunchAddress = null;
		deployTxHash = null;
		stopBalancePolling();
	}

	function shortAddr(addr: string) {
		return addr.slice(0, 10) + '...' + addr.slice(-8);
	}

	let deploySteps = $derived(() => {
		const steps = [
			{ key: 'checking-balance', label: 'Checking balance' },
			{ key: 'approving', label: 'Approving token spend' },
			{ key: 'creating', label: 'Deploying contract' }
		];
		if (tokenInfo?.listing?.enabled) {
			steps.push(
				{ key: 'approving-listing', label: 'Approving tokens for DEX' },
				{ key: 'adding-liquidity', label: 'Adding liquidity' }
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
	<title>Create Token | TokenKrafter</title>
	<meta name="description" content="Deploy your own ERC-20 token in minutes. Configure supply, decimals, minting, taxes, and anti-whale protection. Add DEX liquidity on launch." />
</svelte:head>

<!-- Wallet Picker Modal (deep links for mobile users without injected wallet) -->
{#if showWalletPicker}
	<div
		class="fixed inset-0 z-[90] bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-4"
		role="dialog"
		aria-label="Choose wallet"
		onclick={() => (showWalletPicker = false)}
	>
		<div class="w-full max-w-sm rounded-2xl border border-white/10 bg-[#0d0d14] shadow-2xl overflow-hidden" onclick={(e) => e.stopPropagation()}>
			<div class="flex items-center justify-between p-4 border-b border-white/5">
				<h3 class="syne font-bold text-white">Open in Wallet</h3>
				<button onclick={() => (showWalletPicker = false)} class="text-gray-400 hover:text-white cursor-pointer text-lg">x</button>
			</div>
			<div class="p-4">
				<p class="text-xs text-gray-400 font-mono mb-4">Your token config is saved in the link. Pick your wallet to continue:</p>
				<div class="flex flex-col gap-2">
					{#each walletDeepLinks as wallet}
						<a
							href={wallet.href}
							class="flex items-center gap-3 p-3 rounded-xl border border-white/5 bg-white/3 hover:border-cyan-500/30 hover:bg-cyan-500/5 transition text-white no-underline"
						>
							<span class="text-2xl">{wallet.icon}</span>
							<span class="font-mono text-sm">{wallet.name}</span>
							<span class="ml-auto text-gray-500 text-xs">Open</span>
						</a>
					{/each}
				</div>
				<p class="text-[11px] text-gray-500 font-mono mt-3 text-center">Your form data will auto-fill in the wallet browser</p>
			</div>
		</div>
	</div>
{/if}

<!-- Review Modal -->
{#if showPreview && tokenInfo}
	<div
		class="modal-backdrop fixed inset-0 z-[80] flex items-center justify-center p-4"
		onclick={closePreview}
	>
		<div
			class="review-modal w-full max-w-md max-h-[90vh] overflow-y-auto"
			onclick={(e) => e.stopPropagation()}
		>
			{#if step === 'done'}
				<div class="text-center py-8">
					<div class="text-5xl mb-4 syne font-bold text-emerald-400">Done!</div>
					<h2 class="syne text-2xl font-bold text-white mb-2">
						{tokenInfo.launch?.enabled
							? 'Token Created & Launched!'
							: tokenInfo.listing?.enabled
								? 'Token Deployed & Listed!'
								: 'Token Deployed!'}
					</h2>
					<p class="text-gray-400 font-mono text-sm mb-4">
						Your token is now live on {tokenInfo.network.name}.
						{tokenInfo.launch?.enabled
							? ' Bonding curve launch is active.'
							: tokenInfo.listing?.enabled
								? ' Liquidity has been added to the DEX.'
								: ''}
					</p>

					{#if deployedTokenAddress}
						<div class="deployed-address-box mb-4">
							<div class="text-gray-500 text-[11px] font-mono uppercase tracking-wider mb-1">Token Address</div>
							<div class="text-cyan-400 text-xs font-mono break-all mb-2">{deployedTokenAddress}</div>
							<a
								href={getExplorerUrl(tokenInfo.network.chain_id, 'address', deployedTokenAddress)}
								target="_blank"
								rel="noopener noreferrer"
								class="text-cyan-500 text-xs font-mono hover:text-cyan-300 transition no-underline"
							>View on Explorer -></a>
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

					<div class="flex gap-3 justify-center flex-wrap">
						{#if deployedLaunchAddress}
							<a href="/launchpad/{deployedLaunchAddress}" class="btn-primary text-sm px-5 py-2.5 no-underline">
								View Launch ->
							</a>
						{/if}
						<a href="/manage-tokens" class="btn-secondary text-sm px-5 py-2.5 no-underline">
							Manage Tokens ->
						</a>
						<button onclick={closePreview} class="btn-secondary text-sm px-5 py-2.5 cursor-pointer">
							Close
						</button>
					</div>
				</div>

			{:else if step === 'waiting-deposit'}
				<!-- Waiting for deposit - show QR code -->
				<div class="text-center py-4">
					<div class="modal-header mb-4">
						<h2 class="syne text-xl font-bold text-white">Insufficient Balance</h2>
						<button onclick={closePreview} class="close-btn cursor-pointer">x</button>
					</div>

					<div class="insufficient-box mb-4">
						<p class="text-amber-300 text-sm font-mono mb-2">
							You need {selectedFeeFormatted} {selectedPayment?.symbol} but your balance is {parseFloat(ethers.formatUnits(userBalance, selectedPayment?.decimals ?? 18)).toFixed(4)} {selectedPayment?.symbol}.
						</p>
						<p class="text-gray-500 text-xs font-mono">
							Please deposit the required amount to continue.
						</p>
					</div>

					<!-- QR Code for user address -->
					<div class="qr-section mb-4">
						<div class="qr-placeholder">
							<img
								src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data={userAddress}&bgcolor=0d0d14&color=00d2ff"
								alt="Deposit address QR"
								class="qr-img"
							/>
						</div>
						<div class="address-box mt-3">
							<span class="text-cyan-400 text-xs font-mono break-all">{userAddress}</span>
						</div>
					</div>

					<div class="deposit-notice">
						<span class="text-amber-400 text-xs font-mono font-bold">Important:</span>
						<span class="text-gray-400 text-xs font-mono">
							Only deposit <strong class="text-white">{selectedPayment?.symbol}</strong> on the
							<strong class="text-white">{tokenInfo.network.name}</strong> network.
							Depositing other tokens or using a different network may result in loss of funds.
						</span>
					</div>

					<div class="mt-4 flex items-center justify-center gap-2">
						<div class="spinner-sm w-4 h-4 rounded-full border-2 border-white/10 border-t-cyan-400"></div>
						<span class="text-gray-500 text-xs font-mono">Checking for deposit every 5s...</span>
					</div>

					<button onclick={closePreview} class="btn-secondary text-sm px-5 py-2.5 mt-4 cursor-pointer w-full">
						Cancel
					</button>
				</div>

			{:else if step !== 'idle' && step !== 'review'}
				<!-- Progress view -->
				<div class="text-center py-10">
					<div class="spinner w-12 h-12 rounded-full border-2 border-white/10 border-t-cyan-400 mx-auto mb-6"></div>
					<p class="text-cyan-300 font-mono text-sm mb-6">
						{step === 'checking-balance' ? 'Checking balance...' :
						 step === 'approving' ? `Approving ${selectedPayment?.symbol}...` :
						 step === 'creating' ? 'Deploying contract...' :
						 step === 'approving-listing' ? 'Approving tokens for DEX...' :
						 step === 'adding-liquidity' ? 'Adding liquidity...' : 'Processing...'}
					</p>
					<div class="flex flex-col gap-2 text-left">
						{#each deploySteps() as ds}
							{@const status = stepStatus(ds.key)}
							<div class="flex items-center gap-3 text-sm font-mono {status === 'active' ? 'text-cyan-300' : status === 'done' ? 'text-emerald-400' : 'text-gray-600'}">
								<span class="w-4">{status === 'done' ? 'v' : status === 'active' ? 'o' : '-'}</span>
								{ds.label}
								{#if ds.key === 'approving' && isNativePayment}
									<span class="text-gray-600 text-xs">(skipped)</span>
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
				<!-- Review view -->
				<div class="modal-header">
					<h2 class="syne text-xl font-bold text-white">Review Transaction</h2>
					<button onclick={closePreview} class="close-btn cursor-pointer">x</button>
				</div>

				<div class="modal-section">
					<div class="label-text mb-3">Token Details</div>
					<div class="detail-grid">
						<div class="detail-row">
							<span class="detail-label">Name</span>
							<span class="detail-value">{tokenInfo.name}</span>
						</div>
						<div class="detail-row">
							<span class="detail-label">Symbol</span>
							<span class="detail-value">{tokenInfo.symbol}</span>
						</div>
						<div class="detail-row">
							<span class="detail-label">Total Supply</span>
							<span class="detail-value">{Number(tokenInfo.totalSupply).toLocaleString()}</span>
						</div>
						<div class="detail-row">
							<span class="detail-label">Decimals</span>
							<span class="detail-value">{tokenInfo.decimals}</span>
						</div>
						<div class="detail-row">
							<span class="detail-label">Network</span>
							<span class="detail-value text-cyan-300">{tokenInfo.network.name}</span>
						</div>
					</div>
				</div>

				<div class="modal-section">
					<div class="label-text mb-3">Features</div>
					<div class="flex gap-2 flex-wrap">
						{#if tokenInfo.isMintable}
							<span class="badge badge-cyan">Mintable</span>
						{/if}
						{#if tokenInfo.isTaxable}
							<span class="badge badge-amber">Taxable</span>
						{/if}
						{#if tokenInfo.isPartner}
							<span class="badge badge-purple">Partner</span>
						{/if}
						{#if !tokenInfo.isMintable && !tokenInfo.isTaxable && !tokenInfo.isPartner}
							<span class="badge badge-emerald">Standard ERC-20</span>
						{/if}
					</div>
				</div>

				<!-- Tax Details -->
				{#if tokenInfo.isTaxable && (parseFloat(tokenInfo.tax?.buyTaxPct) > 0 || parseFloat(tokenInfo.tax?.sellTaxPct) > 0 || parseFloat(tokenInfo.tax?.transferTaxPct) > 0)}
					<div class="modal-section">
						<div class="label-text mb-3">Tax Configuration</div>
						<div class="detail-grid">
							{#if parseFloat(tokenInfo.tax.buyTaxPct) > 0}
								<div class="detail-row">
									<span class="detail-label">Buy tax</span>
									<span class="detail-value">{tokenInfo.tax.buyTaxPct}%</span>
								</div>
							{/if}
							{#if parseFloat(tokenInfo.tax.sellTaxPct) > 0}
								<div class="detail-row">
									<span class="detail-label">Sell tax</span>
									<span class="detail-value">{tokenInfo.tax.sellTaxPct}%</span>
								</div>
							{/if}
							{#if parseFloat(tokenInfo.tax.transferTaxPct) > 0}
								<div class="detail-row">
									<span class="detail-label">Transfer tax</span>
									<span class="detail-value">{tokenInfo.tax.transferTaxPct}%</span>
								</div>
							{/if}
							{#if tokenInfo.tax.wallets.length > 0}
								<div class="detail-row" style="flex-direction: column; align-items: flex-start; gap: 4px;">
									<span class="detail-label">Distribution</span>
									{#each tokenInfo.tax.wallets as w}
										<span class="detail-value text-xs" style="word-break: break-all;">
											{w.address.slice(0, 10)}...{w.address.slice(-6)} — {w.sharePct}%
										</span>
									{/each}
								</div>
							{/if}
						</div>
					</div>
				{/if}

				<!-- Launch Details -->
				{#if tokenInfo.launch?.enabled}
					<div class="modal-section">
						<div class="label-text mb-3">Launchpad Configuration</div>
						<div class="detail-grid">
							<div class="detail-row">
								<span class="detail-label">Tokens for launch</span>
								<span class="detail-value">{tokenInfo.launch.tokensForLaunchPct}% of supply</span>
							</div>
							<div class="detail-row">
								<span class="detail-label">Curve</span>
								<span class="detail-value">{['Linear', 'Square Root', 'Quadratic', 'Exponential'][tokenInfo.launch.curveType]}</span>
							</div>
							<div class="detail-row">
								<span class="detail-label">Soft Cap</span>
								<span class="detail-value">{tokenInfo.launch.softCap} USDT</span>
							</div>
							<div class="detail-row">
								<span class="detail-label">Hard Cap</span>
								<span class="detail-value">{tokenInfo.launch.hardCap} USDT</span>
							</div>
							<div class="detail-row">
								<span class="detail-label">Duration</span>
								<span class="detail-value">{tokenInfo.launch.durationDays} days</span>
							</div>
							<div class="detail-row">
								<span class="detail-label">Max buy per wallet</span>
								<span class="detail-value">{(parseInt(tokenInfo.launch.maxBuyBps) / 100).toFixed(1)}%</span>
							</div>
							{#if parseInt(tokenInfo.launch.creatorAllocationBps) > 0}
								<div class="detail-row">
									<span class="detail-label">Creator allocation</span>
									<span class="detail-value">{(parseInt(tokenInfo.launch.creatorAllocationBps) / 100).toFixed(1)}% (vested {tokenInfo.launch.vestingDays}d)</span>
								</div>
							{/if}
							{#if tokenInfo.protection.maxWalletPct !== '0'}
								<div class="detail-row">
									<span class="detail-label">Max wallet</span>
									<span class="detail-value text-amber-300">{tokenInfo.protection.maxWalletPct}% of supply</span>
								</div>
							{/if}
							{#if tokenInfo.protection.maxTransactionPct !== '0'}
								<div class="detail-row">
									<span class="detail-label">Max transaction</span>
									<span class="detail-value text-amber-300">{tokenInfo.protection.maxTransactionPct}% of supply</span>
								</div>
							{/if}
							{#if tokenInfo.protection.cooldownSeconds !== '0'}
								<div class="detail-row">
									<span class="detail-label">Cooldown</span>
									<span class="detail-value text-amber-300">{tokenInfo.protection.cooldownSeconds}s</span>
								</div>
							{/if}
						</div>
					</div>
				{/if}

				<!-- Listing Details -->
				{#if tokenInfo.listing?.enabled}
					{@const listTokenAmt = tokenInfo.listing.mode === 'price'
						? (Number(tokenInfo.listing.listBaseAmount) / Number(tokenInfo.listing.pricePerToken)).toFixed(6)
						: tokenInfo.listing.tokenAmount}
					{@const listBaseAmt = tokenInfo.listing.mode === 'price'
						? tokenInfo.listing.listBaseAmount
						: tokenInfo.listing.baseAmount}
					{@const baseSymbol = getBaseSymbol(tokenInfo.network, tokenInfo.listing.baseCoin)}
					<div class="modal-section">
						<div class="label-text mb-3">Initial Liquidity</div>
						<div class="detail-grid">
							<div class="detail-row">
								<span class="detail-label">Pair</span>
								<span class="detail-value text-emerald-400">{tokenInfo.symbol}/{baseSymbol}</span>
							</div>
							<div class="detail-row">
								<span class="detail-label">Tokens</span>
								<span class="detail-value">{Number(listTokenAmt).toLocaleString()} {tokenInfo.symbol}</span>
							</div>
							<div class="detail-row">
								<span class="detail-label">{baseSymbol}</span>
								<span class="detail-value">{listBaseAmt} {baseSymbol}</span>
							</div>
							{#if tokenInfo.listing.mode === 'price'}
								<div class="detail-row">
									<span class="detail-label">Price</span>
									<span class="detail-value">{tokenInfo.listing.pricePerToken} {baseSymbol}/token</span>
								</div>
							{/if}
						</div>
					</div>
				{/if}

				<!-- Fee & Payment Method -->
				<div class="modal-section fee-section">
					<div class="flex justify-between items-center mb-3">
						<span class="label-text mb-0">Creation Fee</span>
						{#if feeLoading}
							<div class="spinner-sm w-5 h-5 rounded-full border-2 border-white/10 border-t-cyan-400"></div>
						{:else}
							<span class="syne text-xl font-bold text-white">
								${feeUsdAmount}
							</span>
						{/if}
					</div>

					{#if !feeLoading && paymentOptions.length > 0}
						<div class="field-group mt-3">
							<label class="label-text" for="payment-method">Payment Method</label>
							<select
								id="payment-method"
								class="input-field"
								bind:value={selectedPaymentIndex}
							>
								{#each paymentOptions as opt, i}
									<option value={i}>
										{opt.name} ({parseFloat(ethers.formatUnits(feeAmounts[i] ?? 0n, opt.decimals)).toFixed(4)} {opt.symbol})
									</option>
								{/each}
							</select>
						</div>

						<div class="payment-summary mt-3">
							<div class="flex justify-between items-center">
								<span class="text-gray-500 text-xs font-mono">You pay</span>
								<span class="text-white text-sm font-mono font-bold">
									{selectedFeeFormatted} {selectedPayment?.symbol}
								</span>
							</div>
						</div>
					{/if}
				</div>

				<button
					onclick={confirmAndDeploy}
					disabled={feeLoading || paymentOptions.length === 0}
					class="create-btn w-full syne cursor-pointer"
				>
					{feeLoading ? 'Calculating fee...' : tokenInfo.listing?.enabled ? 'Deploy & Add Liquidity' : 'Confirm & Deploy Token'}
				</button>
			{/if}
		</div>
	</div>
{/if}

<!-- Page -->
<div class="page-container max-w-7xl mx-auto px-4 sm:px-6 py-12">
	<div class="page-grid">
		<!-- Left: Form -->
		<div class="form-col">
			<div class="page-label">
				<span class="badge badge-cyan">Create</span>
			</div>
			<h1 class="syne text-3xl sm:text-4xl font-bold text-white mt-4 mb-2">Create Your Token</h1>
			<p class="text-gray-400 font-mono text-sm mb-8">Deploy a new ERC-20 token in minutes.</p>

			<TokenForm {supportedNetworks} {addFeedback} {updateTokenInfo} onPreviewChange={handlePreviewChange} {initialData} {autoSubmit} />
		</div>

		<!-- Right: Live Preview -->
		<div class="info-col">
			{#if previewState}
				<DisplayPreview {...previewState} />
			{/if}

			<div class="info-card card p-6 mt-4">
				<h3 class="syne font-bold text-white mb-4">Quick Info</h3>
				<ul class="check-list">
					{#each [
						'Pay with USDT, USDC, or native coin',
						'Token deploys instantly on-chain',
						'You own the token contract',
						'Fees shown before confirmation'
					] as item}
						<li class="check-item font-mono">
							<span class="check-icon">v</span>
							{item}
						</li>
					{/each}
				</ul>
			</div>
		</div>
	</div>
</div>

<style>
	.page-grid {
		display: grid;
		grid-template-columns: 1fr;
		gap: 32px;
	}
	@media (min-width: 1024px) {
		.page-grid {
			grid-template-columns: 1fr 340px;
			align-items: start;
		}
	}

	.modal-backdrop {
		background: rgba(0,0,0,0.7);
		backdrop-filter: blur(6px);
	}

	.review-modal {
		background: #0d0d14;
		border: 1px solid rgba(255,255,255,0.1);
		border-radius: 20px;
		padding: 24px;
		animation: modalIn 0.2s ease-out;
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
		background: rgba(255,255,255,0.06);
		border: none;
		color: #94a3b8;
		display: flex; align-items: center; justify-content: center;
		transition: all 0.15s;
		font-size: 14px;
	}
	.close-btn:hover { background: rgba(255,255,255,0.12); color: white; }

	.modal-section { margin-bottom: 16px; padding-bottom: 16px; border-bottom: 1px solid rgba(255,255,255,0.05); }

	.detail-grid { display: flex; flex-direction: column; gap: 8px; }
	.detail-row { display: flex; justify-content: space-between; align-items: center; }
	.detail-label { font-size: 12px; color: #6b7280; font-family: 'Space Mono', monospace; }
	.detail-value { font-size: 13px; color: #e2e8f0; font-family: 'Space Mono', monospace; font-weight: 600; }

	.fee-section { background: rgba(0,210,255,0.03); border-radius: 10px; padding: 14px; border-color: rgba(0,210,255,0.1); }

	.payment-summary {
		padding: 10px 12px;
		background: rgba(0,210,255,0.05);
		border: 1px solid rgba(0,210,255,0.15);
		border-radius: 8px;
	}

	.field-group { display: flex; flex-direction: column; gap: 6px; }

	.create-btn {
		width: 100%;
		padding: 14px;
		background: linear-gradient(135deg, #00d2ff, #3a7bd5);
		color: white;
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

	.qr-section { display: flex; flex-direction: column; align-items: center; }
	.qr-placeholder {
		padding: 12px;
		background: rgba(255,255,255,0.03);
		border: 1px solid rgba(255,255,255,0.1);
		border-radius: 12px;
	}
	.qr-img {
		width: 180px;
		height: 180px;
		border-radius: 8px;
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

	.check-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 10px; }
	.check-item { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; color: #94a3b8; line-height: 1.4; }
	.check-icon { color: #10b981; font-size: 12px; margin-top: 1px; flex-shrink: 0; }

	.network-row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 0;
		border-bottom: 1px solid rgba(255,255,255,0.04);
	}
	.network-row:last-child { border-bottom: none; }
	.net-dot {
		width: 8px; height: 8px;
		border-radius: 50%;
		background: #10b981;
		flex-shrink: 0;
		box-shadow: 0 0 6px rgba(16,185,129,0.5);
	}

	.spinner { animation: spin 0.8s linear infinite; }
	.spinner-sm { animation: spin 0.8s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }

	.no-underline { text-decoration: none; }
	a.no-underline { text-decoration: none; }

	.deployed-address-box {
		padding: 12px 14px;
		background: rgba(0,210,255,0.04);
		border: 1px solid rgba(0,210,255,0.15);
		border-radius: 10px;
		text-align: center;
	}

	.syne { font-family: 'Syne', sans-serif; }
	.badge { display: inline-flex; align-items: center; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
	.badge-cyan { background: rgba(0,210,255,0.1); color: #00d2ff; border: 1px solid rgba(0,210,255,0.2); }
	.badge-amber { background: rgba(245,158,11,0.1); color: #f59e0b; border: 1px solid rgba(245,158,11,0.2); }
	.badge-emerald { background: rgba(16,185,129,0.1); color: #10b981; border: 1px solid rgba(16,185,129,0.2); }
	.badge-purple { background: rgba(139,92,246,0.1); color: #8b5cf6; border: 1px solid rgba(139,92,246,0.2); }
	.label-text { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #94a3b8; display: block; }

	select option { background: #0d0d14; color: white; }
</style>
