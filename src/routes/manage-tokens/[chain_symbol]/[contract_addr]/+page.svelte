<script lang="ts">
	import { page } from '$app/state';
	import type { SupportedNetworks, SupportedNetwork, PaymentOption } from '$lib/structure';
	import { ethers } from 'ethers';
	import { getContext, onMount, onDestroy } from 'svelte';
	import { TOKEN_ABI, ROUTER_ABI, FACTORY_V2_ABI, PAIR_ABI, ERC20_ABI, FACTORY_ABI, ZERO_ADDRESS } from '$lib/tokenCrafter';
	import { LAUNCHPAD_FACTORY_ABI } from '$lib/launchpad';
	import { t } from '$lib/i18n';

	let _getNetworks: () => SupportedNetworks = getContext('supportedNetworks');
	let supportedNetworks = $derived(_getNetworks());
	const addFeedback = getContext<(f: { message: string; type: string }) => void>('addFeedback');
	let getSigner: () => ethers.Signer | null = getContext('signer');
	let getUserAddress: () => string | null = getContext('userAddress');
	let connectWallet: () => Promise<boolean> = getContext('connectWallet');
	let getNetworkProviders: () => Map<number, ethers.JsonRpcProvider> = getContext('networkProviders');
	let getPaymentOptions: (network: SupportedNetwork) => PaymentOption[] = getContext('getPaymentOptions');

	let signer = $derived(getSigner());
	let userAddress = $derived(getUserAddress());
	let networkProviders = $derived(getNetworkProviders());

	type ExtendedTokenInfo = {
		name: string;
		symbol: string;
		totalSupply: string;
		decimals: number;
		owner?: string;
		isMintable?: boolean;
		isTaxable?: boolean;
		isPartner?: boolean;
		buyTaxBps?: number;
		sellTaxBps?: number;
		transferTaxBps?: number;
		userBalance?: string;
		// Protection features
		tradingEnabled?: boolean;
		maxWalletAmount?: string;
		maxTransactionAmount?: string;
		cooldownTime?: number;
		blacklistWindow?: number;
		tradingEnabledAt?: number;
	};

	let tokenInfo: ExtendedTokenInfo | null = $state(null);
	let error: 'unsupported_network' | 'contract_error' | 'contract_not_found' | null = $state(null);
	let isLoading = $state(true);
	let network: SupportedNetwork | null = $state(null);
	let contractAddress = $state('');
	let activeTab = $state<'overview' | 'mint' | 'burn' | 'tax' | 'pools' | 'liquidity' | 'protection'>('overview');
	let isOwner = $state(false);

	// Form states
	let mintAmount = $state('');
	let mintTo = $state('');
	let burnAmount = $state('');
	let buyTaxPctInput = $state('');
	let sellTaxPctInput = $state('');
	let transferTaxPctInput = $state('');
	let actionLoading = $state(false);

	// Tax distribution
	let taxWallets: { address: string; shareBps: string }[] = $state([]);
	let taxExemptAddr = $state('');
	let taxExemptValue = $state(true);

	// Pool management
	let poolAddressInput = $state('');
	let poolCheckAddr = $state('');
	let poolCheckResult: boolean | null = $state(null);

	// Protection features
	let maxWalletInput = $state('');
	let maxTxInput = $state('');
	let cooldownInput = $state('');
	let blacklistWindowInput = $state('');
	let blacklistAddrInput = $state('');
	let blacklistAction = $state(true);
	let excludeLimitsAddrInput = $state('');
	let excludeLimitsAction = $state(true);
	let blacklistCheckAddr = $state('');
	let blacklistCheckResult: boolean | null = $state(null);
	let excludedCheckAddr = $state('');
	let excludedCheckResult: boolean | null = $state(null);

	// Launchpad state
	let launchAddress: string | null = $state(null);
	let launchpadChecked = $state(false);

	// Liquidity states
	let selectedRouter = $state('');

	// New pool creation states
	let newPoolBaseCoin = $state<'native' | 'usdt' | 'usdc'>('native');
	let newPoolMode = $state<'manual' | 'price'>('manual');
	let newPoolTokenAmount = $state('');
	let newPoolBaseAmount = $state('');
	let newPoolPricePerToken = $state('');
	let newPoolListBaseAmount = $state('');
	let showNewPool = $state(false);

	let newPoolCalculatedTokenAmount = $derived(() => {
		if (!newPoolPricePerToken || !newPoolListBaseAmount || Number(newPoolPricePerToken) <= 0) return '';
		return (Number(newPoolListBaseAmount) / Number(newPoolPricePerToken)).toFixed(6);
	});

	// Supply % allocated to liquidity (for new pool)
	let newPoolTokenPct = $derived(() => {
		if (!tokenInfo?.totalSupply) return 0;
		const amount = newPoolMode === 'price' ? Number(newPoolCalculatedTokenAmount()) : Number(newPoolTokenAmount);
		if (!amount || amount <= 0) return 0;
		return (amount / Number(tokenInfo.totalSupply)) * 100;
	});

	let newPoolSelectedBase = $derived(getBaseCoinOptions().find((b) => b.key === newPoolBaseCoin) ?? getBaseCoinOptions()[0]);

	// Existing pool lookup
	type ExistingPool = {
		baseSymbol: string;
		baseKey: string;
		pairAddress: string;
		reserve0: string;
		reserve1: string;
		token0: string;
		tokenReserve: number;
		baseReserve: number;
		pricePerToken: number;
		baseDecimals: number;
	};
	let existingPools: ExistingPool[] = $state([]);
	let poolsLoading = $state(false);
	let poolsLoaded = $state(false);

	// Per-pool add liquidity states
	let poolAddAmounts: Record<string, { baseAmount: string; tokenAmount: string; expanded: boolean }> = $state({});
	let poolAddLoading: Record<string, boolean> = $state({});

	// Deposit modal state
	let showDepositModal = $state(false);
	let depositInfo: {
		symbol: string;
		networkName: string;
		required: string;
		userBalance: string;
		deficit: string;
		decimals: number;
		isNative: boolean;
		// Callback to resume after deposit
		onResume: () => void;
	} | null = $state(null);
	let depositPollTimer: ReturnType<typeof setInterval> | null = null;
	let addressCopied = $state(false);

	// DEX router addresses
	const DEX_ROUTERS: Record<number, { name: string; address: string }[]> = {
		1: [{ name: 'Uniswap V2', address: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D' }],
		56: [{ name: 'PancakeSwap V2', address: '0x10ED43C718714eb63d5aA57B78B54704E256024E' }]
	};

	function getProvider(): ethers.JsonRpcProvider | null {
		if (!network) return null;
		return networkProviders.get(network.chain_id) ?? null;
	}

	function getBaseCoinOptions(): { key: string; symbol: string; address: string; decimals: number }[] {
		if (!network) return [];
		return [
			{ key: 'native', symbol: network.native_coin, address: ZERO_ADDRESS, decimals: 18 },
			{ key: 'usdt', symbol: 'USDT', address: network.usdt_address, decimals: network.chain_id === 56 ? 18 : 6 },
			{ key: 'usdc', symbol: 'USDC', address: network.usdc_address, decimals: network.chain_id === 56 ? 18 : 6 }
		];
	}


	async function checkLaunchpad() {
		if (!network || !contractAddress) return;
		try {
			if (!network.launchpad_address || network.launchpad_address === '0x') return;
			const provider = getProvider() ?? new ethers.JsonRpcProvider(network.rpc);
			const factory = new ethers.Contract(network.launchpad_address, LAUNCHPAD_FACTORY_ABI, provider);
			const addr: string = await factory.tokenToLaunch(contractAddress);
			if (addr && addr !== ZERO_ADDRESS) {
				launchAddress = addr;
			}
		} catch {}
		launchpadChecked = true;
	}

	async function loadToken() {
		const { chain_symbol, contract_addr } = page.params;
		contractAddress = contract_addr || '';

		if (!chain_symbol) { error = 'unsupported_network'; return; }
		if (!contract_addr) { error = 'contract_not_found'; return; }

		const net = supportedNetworks.find(
			(n) => n.symbol.toLowerCase() === chain_symbol.toLowerCase() || n.chain_id.toString() === chain_symbol
		);
		if (!net) { error = 'unsupported_network'; return; }
		network = net;

		const provider = getProvider() ?? new ethers.JsonRpcProvider(net.rpc);
		try {
			const contract = new ethers.Contract(contract_addr, TOKEN_ABI, provider);
			const [name, symbol, decimals, totalSupply] = await Promise.all([
				contract.name(),
				contract.symbol(),
				contract.decimals(),
				contract.totalSupply()
			]);

			let owner: string | undefined;
			let buyTaxBps: number | undefined;
			let sellTaxBps: number | undefined;
			let transferTaxBps: number | undefined;
			let userBalance: string | undefined;

			try { owner = await contract.owner(); } catch {}
			try { buyTaxBps = Number(await contract.buyTaxBps()); } catch {}
			try { sellTaxBps = Number(await contract.sellTaxBps()); } catch {}
			try { transferTaxBps = Number(await contract.transferTaxBps()); } catch {}

			// Determine features from factory registry
			let isMintable: boolean | undefined;
			let isTaxable: boolean | undefined;
			let isPartner: boolean | undefined;
			try {
				const factory = new ethers.Contract(net.platform_address, FACTORY_ABI, provider);
				const info = await factory.tokenInfo(contract_addr);
				isMintable = info[1];
				isTaxable = info[2];
				isPartner = info[3];
			} catch {
				// Fallback: probe contract capabilities
				try { await contract.buyTaxBps.staticCall(); isTaxable = true; } catch { isTaxable = false; }
				isMintable = false;
				isPartner = false;
			}

			if (userAddress) {
				try {
					const bal = await contract.balanceOf(userAddress);
					userBalance = ethers.formatUnits(bal, ethers.toNumber(decimals));
				} catch {}
			}

			// Load protection features
			let tradingEnabled_: boolean | undefined;
			let maxWalletAmount_: string | undefined;
			let maxTransactionAmount_: string | undefined;
			let cooldownTime_: number | undefined;
			let blacklistWindow_: number | undefined;
			let tradingEnabledAt_: number | undefined;
			const dec = ethers.toNumber(decimals);

			try { tradingEnabled_ = await contract.tradingEnabled(); } catch {}
			try { maxWalletAmount_ = ethers.formatUnits(await contract.maxWalletAmount(), dec); } catch {}
			try { maxTransactionAmount_ = ethers.formatUnits(await contract.maxTransactionAmount(), dec); } catch {}
			try { cooldownTime_ = Number(await contract.cooldownTime()); } catch {}
			try { blacklistWindow_ = Number(await contract.blacklistWindow()); } catch {}
			try { tradingEnabledAt_ = Number(await contract.tradingEnabledAt()); } catch {}

			tokenInfo = {
				name, symbol,
				decimals: dec,
				totalSupply: ethers.formatUnits(totalSupply, dec),
				owner, isMintable, isTaxable, isPartner, buyTaxBps, sellTaxBps, transferTaxBps, userBalance,
				tradingEnabled: tradingEnabled_,
				maxWalletAmount: maxWalletAmount_,
				maxTransactionAmount: maxTransactionAmount_,
				cooldownTime: cooldownTime_,
				blacklistWindow: blacklistWindow_,
				tradingEnabledAt: tradingEnabledAt_
			};

			isOwner = !!(owner && userAddress && owner.toLowerCase() === userAddress.toLowerCase());
			buyTaxPctInput = String((buyTaxBps ?? 0) / 100);
			sellTaxPctInput = String((sellTaxBps ?? 0) / 100);
			transferTaxPctInput = String((transferTaxBps ?? 0) / 100);
			if (userAddress) mintTo = userAddress;

			// Default router
			const routers = DEX_ROUTERS[net.chain_id];
			if (routers?.length) selectedRouter = routers[0].address;

		} catch (e) {
			error = 'contract_error';
			console.error('contract error', e);
		}
	}

	onMount(async () => {
		await loadToken();
		isLoading = false;
		checkLaunchpad();
		// Auto-load pools in background if router is set
		if (selectedRouter && !poolsLoaded) {
			lookupExistingPools();
		}
	});

	async function ensureSigner() {
		if (!signer || !userAddress) {
			const ok = await connectWallet();
			if (!ok) return null;
		}
		return signer;
	}

	async function doMint() {
		const s = await ensureSigner();
		if (!s || !network) return;
		actionLoading = true;
		try {
			const contract = new ethers.Contract(contractAddress, TOKEN_ABI, s);
			const amount = ethers.parseUnits(String(Number(mintAmount)), tokenInfo?.decimals ?? 18);
			const tx = await contract.mint(mintTo || userAddress, amount);
			addFeedback({ message: 'Minting...', type: 'info' });
			await tx.wait();
			addFeedback({ message: `Minted ${mintAmount} ${tokenInfo?.symbol}!`, type: 'success' });
			mintAmount = '';
			await loadToken();
		} catch (e: any) {
			addFeedback({ message: e.shortMessage || e.message || 'Mint failed', type: 'error' });
		} finally { actionLoading = false; }
	}

	async function doBurn() {
		const s = await ensureSigner();
		if (!s || !network) return;
		actionLoading = true;
		try {
			const contract = new ethers.Contract(contractAddress, TOKEN_ABI, s);
			const amount = ethers.parseUnits(String(Number(burnAmount)), tokenInfo?.decimals ?? 18);
			const tx = await contract.burn(amount);
			addFeedback({ message: 'Burning tokens...', type: 'info' });
			await tx.wait();
			addFeedback({ message: `Burned ${burnAmount} ${tokenInfo?.symbol}!`, type: 'success' });
			burnAmount = '';
			await loadToken();
		} catch (e: any) {
			addFeedback({ message: e.shortMessage || e.message || 'Burn failed', type: 'error' });
		} finally { actionLoading = false; }
	}

	async function doSetTaxes() {
		const s = await ensureSigner();
		if (!s) return;
		actionLoading = true;
		try {
			const contract = new ethers.Contract(contractAddress, TOKEN_ABI, s);
			const tx = await contract.setTaxes(
				Math.round(Number(buyTaxPctInput) * 100),
				Math.round(Number(sellTaxPctInput) * 100),
				Math.round(Number(transferTaxPctInput) * 100)
			);
			addFeedback({ message: 'Updating taxes...', type: 'info' });
			await tx.wait();
			addFeedback({ message: 'Tax rates updated!', type: 'success' });
			await loadToken();
		} catch (e: any) {
			addFeedback({ message: e.shortMessage || e.message || 'Tax update failed', type: 'error' });
		} finally { actionLoading = false; }
	}

	async function doSetTaxDistribution() {
		const s = await ensureSigner();
		if (!s) return;
		actionLoading = true;
		try {
			const contract = new ethers.Contract(contractAddress, TOKEN_ABI, s);
			const wallets = taxWallets.map((w) => w.address);
			const shares = taxWallets.map((w) => Number(w.shareBps));
			const tx = await contract.setTaxDistribution(wallets, shares);
			addFeedback({ message: 'Updating tax distribution...', type: 'info' });
			await tx.wait();
			addFeedback({ message: 'Tax distribution updated!', type: 'success' });
		} catch (e: any) {
			addFeedback({ message: e.shortMessage || e.message || 'Distribution update failed', type: 'error' });
		} finally { actionLoading = false; }
	}

	async function doExcludeFromTax() {
		const s = await ensureSigner();
		if (!s || !taxExemptAddr) return;
		actionLoading = true;
		try {
			const contract = new ethers.Contract(contractAddress, TOKEN_ABI, s);
			const tx = await contract.excludeFromTax(taxExemptAddr, taxExemptValue);
			addFeedback({ message: 'Updating tax exemption...', type: 'info' });
			await tx.wait();
			addFeedback({ message: `Address ${taxExemptValue ? 'exempted from' : 'included in'} tax!`, type: 'success' });
			taxExemptAddr = '';
		} catch (e: any) {
			addFeedback({ message: e.shortMessage || e.message || 'Exemption update failed', type: 'error' });
		} finally { actionLoading = false; }
	}

	async function doAddPool() {
		const s = await ensureSigner();
		if (!s || !poolAddressInput) return;
		actionLoading = true;
		try {
			const contract = new ethers.Contract(contractAddress, TOKEN_ABI, s);
			const tx = await contract.addPool(poolAddressInput);
			addFeedback({ message: 'Adding pool...', type: 'info' });
			await tx.wait();
			addFeedback({ message: 'Pool added!', type: 'success' });
			poolAddressInput = '';
		} catch (e: any) {
			addFeedback({ message: e.shortMessage || e.message || 'Add pool failed', type: 'error' });
		} finally { actionLoading = false; }
	}

	async function doRemovePool() {
		const s = await ensureSigner();
		if (!s || !poolAddressInput) return;
		actionLoading = true;
		try {
			const contract = new ethers.Contract(contractAddress, TOKEN_ABI, s);
			const tx = await contract.removePool(poolAddressInput);
			addFeedback({ message: 'Removing pool...', type: 'info' });
			await tx.wait();
			addFeedback({ message: 'Pool removed!', type: 'success' });
			poolAddressInput = '';
		} catch (e: any) {
			addFeedback({ message: e.shortMessage || e.message || 'Remove pool failed', type: 'error' });
		} finally { actionLoading = false; }
	}

	async function doCheckPool() {
		if (!poolCheckAddr || !network) return;
		try {
			const provider = getProvider() ?? new ethers.JsonRpcProvider(network.rpc);
			const contract = new ethers.Contract(contractAddress, TOKEN_ABI, provider);
			poolCheckResult = await contract.isPool(poolCheckAddr);
		} catch (e: any) {
			addFeedback({ message: e.shortMessage || e.message || 'Pool check failed', type: 'error' });
		}
	}

	function addTaxWallet() {
		taxWallets = [...taxWallets, { address: '', shareBps: '' }];
	}

	function removeTaxWallet(index: number) {
		taxWallets = taxWallets.filter((_, i) => i !== index);
	}

	async function lookupExistingPools() {
		if (!network || !selectedRouter) return;
		poolsLoading = true;
		existingPools = [];
		try {
			const provider = getProvider() ?? new ethers.JsonRpcProvider(network.rpc);
			const router = new ethers.Contract(selectedRouter, ROUTER_ABI, provider);
			const dexFactoryAddr = await router.factory();
			const wethAddr = await router.WETH();
			const dexFactory = new ethers.Contract(dexFactoryAddr, FACTORY_V2_ABI, provider);

			const baseCoins = getBaseCoinOptions();
			const results: ExistingPool[] = [];

			for (const base of baseCoins) {
				const baseAddr = base.address === ZERO_ADDRESS ? wethAddr : base.address;
				try {
					const pair = await dexFactory.getPair(contractAddress, baseAddr);
					if (pair && pair !== ZERO_ADDRESS) {
						const pairContract = new ethers.Contract(pair, PAIR_ABI, provider);
						const [reserves, token0] = await Promise.all([
							pairContract.getReserves(),
							pairContract.token0()
						]);
						const tokenDec = tokenInfo?.decimals ?? 18;
						const isToken0 = token0.toLowerCase() === contractAddress.toLowerCase();
						const tokenReserve = Number(ethers.formatUnits(reserves[isToken0 ? 0 : 1], tokenDec));
						const baseReserve = Number(ethers.formatUnits(reserves[isToken0 ? 1 : 0], base.decimals));
						const pricePerToken = tokenReserve > 0 ? baseReserve / tokenReserve : 0;

						results.push({
							baseSymbol: base.symbol,
							baseKey: base.key,
							pairAddress: pair,
							reserve0: ethers.formatUnits(reserves[0], isToken0 ? tokenDec : base.decimals),
							reserve1: ethers.formatUnits(reserves[1], isToken0 ? base.decimals : tokenDec),
							token0,
							tokenReserve,
							baseReserve,
							pricePerToken,
							baseDecimals: base.decimals
						});

						// Init per-pool add state
						if (!poolAddAmounts[pair]) {
							poolAddAmounts[pair] = { baseAmount: '', tokenAmount: '', expanded: false };
						}
					}
				} catch {}
			}
			existingPools = results;
			poolsLoaded = true;
		} catch (e: any) {
			addFeedback({ message: 'Failed to lookup pools: ' + (e.shortMessage || e.message), type: 'error' });
		} finally { poolsLoading = false; }
	}

	function isEmptyPool(pool: ExistingPool): boolean {
		return pool.tokenReserve === 0 && pool.baseReserve === 0;
	}

	function poolCalcTokenFromBase(pool: ExistingPool, baseAmount: string): string {
		if (!baseAmount || Number(baseAmount) <= 0 || pool.pricePerToken <= 0) return '';
		return (Number(baseAmount) / pool.pricePerToken).toFixed(6);
	}

	function poolCalcBaseFromToken(pool: ExistingPool, tokenAmount: string): string {
		if (!tokenAmount || Number(tokenAmount) <= 0) return '';
		return (Number(tokenAmount) * pool.pricePerToken).toFixed(6);
	}

	function poolTokenPct(pool: ExistingPool, tokenAmount: string): number {
		if (!tokenInfo?.totalSupply || !tokenAmount || Number(tokenAmount) <= 0) return 0;
		return (Number(tokenAmount) / Number(tokenInfo.totalSupply)) * 100;
	}

	function onPoolBaseInput(pool: ExistingPool) {
		const state = poolAddAmounts[pool.pairAddress];
		if (!state || isEmptyPool(pool)) return; // Don't auto-calc for empty pools
		state.tokenAmount = poolCalcTokenFromBase(pool, state.baseAmount);
	}

	function onPoolTokenInput(pool: ExistingPool) {
		const state = poolAddAmounts[pool.pairAddress];
		if (!state || isEmptyPool(pool)) return; // Don't auto-calc for empty pools
		state.baseAmount = poolCalcBaseFromToken(pool, state.tokenAmount);
	}

	async function checkBalances(
		tokenAmount: string,
		baseAmount: string,
		baseSymbol: string,
		baseKey: string,
		baseDecimals: number,
		baseAddress: string,
		onResume: () => void
	): Promise<boolean> {
		if (!userAddress || !network) return false;
		const provider = getProvider() ?? new ethers.JsonRpcProvider(network.rpc);

		// Check token balance
		const tokenContract = new ethers.Contract(contractAddress, TOKEN_ABI, provider);
		const tokenBal = await tokenContract.balanceOf(userAddress);
		const parsedTokenAmount = ethers.parseUnits(String(Number(tokenAmount)), tokenInfo?.decimals ?? 18);
		if (tokenBal < parsedTokenAmount) {
			const balFormatted = ethers.formatUnits(tokenBal, tokenInfo?.decimals ?? 18);
			const deficit = Number(tokenAmount) - Number(balFormatted);
			depositInfo = {
				symbol: tokenInfo?.symbol ?? 'TOKEN',
				networkName: network.name,
				required: tokenAmount,
				userBalance: Number(balFormatted).toFixed(4),
				deficit: deficit.toFixed(4),
				decimals: tokenInfo?.decimals ?? 18,
				isNative: false,
				onResume
			};
			showDepositModal = true;
			startDepositPoll(parsedTokenAmount, contractAddress, tokenInfo?.decimals ?? 18, false, onResume);
			return false;
		}

		// Check base balance
		const isNative = baseKey === 'native';
		let baseBal: bigint;
		const parsedBaseAmount = isNative
			? ethers.parseEther(String(Number(baseAmount)))
			: ethers.parseUnits(String(Number(baseAmount)), baseDecimals);

		if (isNative) {
			baseBal = await provider.getBalance(userAddress);
		} else {
			const baseContract = new ethers.Contract(baseAddress, ERC20_ABI, provider);
			baseBal = await baseContract.balanceOf(userAddress);
		}

		if (baseBal < parsedBaseAmount) {
			const balFormatted = isNative
				? ethers.formatEther(baseBal)
				: ethers.formatUnits(baseBal, baseDecimals);
			const deficit = Number(baseAmount) - Number(balFormatted);
			depositInfo = {
				symbol: baseSymbol,
				networkName: network.name,
				required: baseAmount,
				userBalance: Number(balFormatted).toFixed(4),
				deficit: deficit.toFixed(4),
				decimals: baseDecimals,
				isNative,
				onResume
			};
			showDepositModal = true;
			const checkAddr = isNative ? '' : baseAddress;
			startDepositPoll(parsedBaseAmount, checkAddr, baseDecimals, isNative, onResume);
			return false;
		}

		return true;
	}

	function startDepositPoll(requiredAmount: bigint, tokenAddr: string, decimals: number, isNative: boolean, onResume: () => void) {
		stopDepositPoll();
		depositPollTimer = setInterval(async () => {
			if (!userAddress || !network) return;
			try {
				const provider = getProvider() ?? new ethers.JsonRpcProvider(network.rpc);
				let bal: bigint;
				if (isNative) {
					bal = await provider.getBalance(userAddress);
				} else {
					const contract = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
					bal = await contract.balanceOf(userAddress);
				}
				if (bal >= requiredAmount) {
					stopDepositPoll();
					showDepositModal = false;
					depositInfo = null;
					addFeedback({ message: 'Deposit detected! Proceeding...', type: 'success' });
					onResume();
				} else if (depositInfo) {
					// Update displayed balance
					const balFormatted = isNative ? ethers.formatEther(bal) : ethers.formatUnits(bal, decimals);
					const deficit = Number(depositInfo.required) - Number(balFormatted);
					depositInfo.userBalance = Number(balFormatted).toFixed(4);
					depositInfo.deficit = deficit > 0 ? deficit.toFixed(4) : '0';
				}
			} catch {}
		}, 5000);
	}

	function stopDepositPoll() {
		if (depositPollTimer) {
			clearInterval(depositPollTimer);
			depositPollTimer = null;
		}
	}

	function closeDepositModal() {
		stopDepositPoll();
		showDepositModal = false;
		depositInfo = null;
	}

	async function copyAddress() {
		if (!userAddress) return;
		await navigator.clipboard.writeText(userAddress);
		addressCopied = true;
		setTimeout(() => { addressCopied = false; }, 2000);
	}

	onDestroy(() => {
		stopDepositPoll();
	});

	async function doAddToExistingPool(pool: ExistingPool) {
		const s = await ensureSigner();
		if (!s || !network || !selectedRouter) return;
		const state = poolAddAmounts[pool.pairAddress];
		if (!state?.tokenAmount || !state?.baseAmount) {
			addFeedback({ message: 'Please fill in amounts.', type: 'error' });
			return;
		}

		// Check balances before proceeding
		const baseOption = getBaseCoinOptions().find(b => b.symbol === pool.baseSymbol);
		const hasFunds = await checkBalances(
			state.tokenAmount,
			state.baseAmount,
			pool.baseSymbol,
			pool.baseKey,
			pool.baseDecimals,
			baseOption?.address ?? ZERO_ADDRESS,
			() => doAddToExistingPool(pool) // Retry after deposit
		);
		if (!hasFunds) return;

		poolAddLoading[pool.pairAddress] = true;

		try {
			const tokenContract = new ethers.Contract(contractAddress, TOKEN_ABI, s);
			const parsedTokenAmount = ethers.parseUnits(String(Number(state.tokenAmount)), tokenInfo?.decimals ?? 18);

			const allowance = await tokenContract.allowance(userAddress, selectedRouter);
			if (allowance < parsedTokenAmount) {
				addFeedback({ message: 'Approving tokens for router...', type: 'info' });
				const approveTx = await tokenContract.approve(selectedRouter, parsedTokenAmount);
				await approveTx.wait();
			}

			const router = new ethers.Contract(selectedRouter, ROUTER_ABI, s);
			const deadline = Math.floor(Date.now() / 1000) + 1200;

			if (pool.baseKey === 'native') {
				const ethAmount = ethers.parseEther(String(Number(state.baseAmount)));
				addFeedback({ message: 'Adding liquidity...', type: 'info' });
				const tx = await router.addLiquidityETH(
					contractAddress,
					parsedTokenAmount,
					parsedTokenAmount * 95n / 100n,
					ethAmount * 95n / 100n,
					userAddress,
					deadline,
					{ value: ethAmount }
				);
				await tx.wait();
			} else {
				const baseOption = getBaseCoinOptions().find(b => b.symbol === pool.baseSymbol);
				const parsedBaseAmount = ethers.parseUnits(String(Number(state.baseAmount)), pool.baseDecimals);
				const baseContract = new ethers.Contract(baseOption!.address, ERC20_ABI, s);
				const baseAllowance = await baseContract.allowance(userAddress, selectedRouter);
				if (baseAllowance < parsedBaseAmount) {
					addFeedback({ message: `Approving ${pool.baseSymbol}...`, type: 'info' });
					const approveTx = await baseContract.approve(selectedRouter, parsedBaseAmount);
					await approveTx.wait();
				}

				addFeedback({ message: 'Adding liquidity...', type: 'info' });
				const tx = await router.addLiquidity(
					contractAddress,
					baseOption!.address,
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
			state.tokenAmount = '';
			state.baseAmount = '';
			await lookupExistingPools(); // Refresh reserves
		} catch (e: any) {
			addFeedback({ message: e.shortMessage || e.message || 'Liquidity failed', type: 'error' });
		} finally { poolAddLoading[pool.pairAddress] = false; }
	}

	async function doCreateNewPool() {
		const s = await ensureSigner();
		if (!s || !network || !selectedRouter) return;

		const tokenAmount = newPoolMode === 'price' ? newPoolCalculatedTokenAmount() : newPoolTokenAmount;
		const baseAmount = newPoolMode === 'price' ? newPoolListBaseAmount : newPoolBaseAmount;

		if (!tokenAmount || !baseAmount) {
			addFeedback({ message: 'Please fill in all amounts.', type: 'error' });
			return;
		}

		// Check balances before proceeding
		const hasFunds = await checkBalances(
			tokenAmount,
			baseAmount,
			newPoolSelectedBase.symbol,
			newPoolBaseCoin,
			newPoolSelectedBase.decimals,
			newPoolSelectedBase.address,
			() => doCreateNewPool() // Retry after deposit
		);
		if (!hasFunds) return;

		actionLoading = true;

		try {
			const tokenContract = new ethers.Contract(contractAddress, TOKEN_ABI, s);
			const parsedTokenAmount = ethers.parseUnits(String(Number(tokenAmount)), tokenInfo?.decimals ?? 18);

			const allowance = await tokenContract.allowance(userAddress, selectedRouter);
			if (allowance < parsedTokenAmount) {
				addFeedback({ message: 'Approving tokens for router...', type: 'info' });
				const approveTx = await tokenContract.approve(selectedRouter, parsedTokenAmount);
				await approveTx.wait();
			}

			const router = new ethers.Contract(selectedRouter, ROUTER_ABI, s);
			const deadline = Math.floor(Date.now() / 1000) + 1200;

			if (newPoolBaseCoin === 'native') {
				const ethAmount = ethers.parseEther(String(Number(baseAmount)));
				addFeedback({ message: 'Creating pool & adding liquidity...', type: 'info' });
				const tx = await router.addLiquidityETH(
					contractAddress,
					parsedTokenAmount,
					parsedTokenAmount * 95n / 100n,
					ethAmount * 95n / 100n,
					userAddress,
					deadline,
					{ value: ethAmount }
				);
				await tx.wait();
			} else {
				const baseInfo = newPoolSelectedBase;
				const parsedBaseAmount = ethers.parseUnits(String(Number(baseAmount)), baseInfo.decimals);

				const baseContract = new ethers.Contract(baseInfo.address, ERC20_ABI, s);
				const baseAllowance = await baseContract.allowance(userAddress, selectedRouter);
				if (baseAllowance < parsedBaseAmount) {
					addFeedback({ message: `Approving ${baseInfo.symbol}...`, type: 'info' });
					const approveTx = await baseContract.approve(selectedRouter, parsedBaseAmount);
					await approveTx.wait();
				}

				addFeedback({ message: 'Creating pool & adding liquidity...', type: 'info' });
				const tx = await router.addLiquidity(
					contractAddress,
					baseInfo.address,
					parsedTokenAmount,
					parsedBaseAmount,
					parsedTokenAmount * 95n / 100n,
					parsedBaseAmount * 95n / 100n,
					userAddress,
					deadline
				);
				await tx.wait();
			}

			addFeedback({ message: 'Pool created & liquidity added!', type: 'success' });
			newPoolTokenAmount = '';
			newPoolBaseAmount = '';
			newPoolPricePerToken = '';
			newPoolListBaseAmount = '';
			showNewPool = false;
			await lookupExistingPools(); // Refresh
		} catch (e: any) {
			addFeedback({ message: e.shortMessage || e.message || 'Liquidity failed', type: 'error' });
		} finally { actionLoading = false; }
	}

	// Protection action functions
	async function doEnableTrading() {
		const s = await ensureSigner();
		if (!s) return;
		actionLoading = true;
		try {
			const contract = new ethers.Contract(contractAddress, TOKEN_ABI, s);
			const tx = await contract.enableTrading();
			addFeedback({ message: 'Enabling trading...', type: 'info' });
			await tx.wait();
			addFeedback({ message: 'Trading enabled! Protections are now locked.', type: 'success' });
			await loadToken();
		} catch (e: any) {
			addFeedback({ message: e.shortMessage || e.message || 'Enable trading failed', type: 'error' });
		} finally { actionLoading = false; }
	}

	async function doSetMaxWallet() {
		const s = await ensureSigner();
		if (!s) return;
		actionLoading = true;
		try {
			const contract = new ethers.Contract(contractAddress, TOKEN_ABI, s);
			const amount = maxWalletInput ? ethers.parseUnits(String(Number(maxWalletInput)), tokenInfo?.decimals ?? 18) : 0n;
			const tx = await contract.setMaxWalletAmount(amount);
			addFeedback({ message: 'Setting max wallet...', type: 'info' });
			await tx.wait();
			addFeedback({ message: amount === 0n ? 'Max wallet disabled!' : 'Max wallet updated!', type: 'success' });
			await loadToken();
		} catch (e: any) {
			addFeedback({ message: e.shortMessage || e.message || 'Max wallet update failed', type: 'error' });
		} finally { actionLoading = false; }
	}

	async function doSetMaxTx() {
		const s = await ensureSigner();
		if (!s) return;
		actionLoading = true;
		try {
			const contract = new ethers.Contract(contractAddress, TOKEN_ABI, s);
			const amount = maxTxInput ? ethers.parseUnits(String(Number(maxTxInput)), tokenInfo?.decimals ?? 18) : 0n;
			const tx = await contract.setMaxTransactionAmount(amount);
			addFeedback({ message: 'Setting max transaction...', type: 'info' });
			await tx.wait();
			addFeedback({ message: amount === 0n ? 'Max transaction disabled!' : 'Max transaction updated!', type: 'success' });
			await loadToken();
		} catch (e: any) {
			addFeedback({ message: e.shortMessage || e.message || 'Max tx update failed', type: 'error' });
		} finally { actionLoading = false; }
	}

	async function doSetCooldown() {
		const s = await ensureSigner();
		if (!s) return;
		actionLoading = true;
		try {
			const contract = new ethers.Contract(contractAddress, TOKEN_ABI, s);
			const seconds = cooldownInput ? Number(cooldownInput) : 0;
			const tx = await contract.setCooldownTime(seconds);
			addFeedback({ message: 'Setting cooldown...', type: 'info' });
			await tx.wait();
			addFeedback({ message: seconds === 0 ? 'Cooldown disabled!' : 'Cooldown updated!', type: 'success' });
			await loadToken();
		} catch (e: any) {
			addFeedback({ message: e.shortMessage || e.message || 'Cooldown update failed', type: 'error' });
		} finally { actionLoading = false; }
	}

	async function doSetBlacklistWindow() {
		const s = await ensureSigner();
		if (!s) return;
		actionLoading = true;
		try {
			const contract = new ethers.Contract(contractAddress, TOKEN_ABI, s);
			const seconds = blacklistWindowInput ? Number(blacklistWindowInput) : 0;
			const tx = await contract.setBlacklistWindow(seconds);
			addFeedback({ message: 'Setting blacklist window...', type: 'info' });
			await tx.wait();
			addFeedback({ message: seconds === 0 ? 'Blacklist disabled!' : 'Blacklist window set!', type: 'success' });
			await loadToken();
		} catch (e: any) {
			addFeedback({ message: e.shortMessage || e.message || 'Blacklist window update failed', type: 'error' });
		} finally { actionLoading = false; }
	}

	async function doSetBlacklisted() {
		const s = await ensureSigner();
		if (!s || !blacklistAddrInput) return;
		actionLoading = true;
		try {
			const contract = new ethers.Contract(contractAddress, TOKEN_ABI, s);
			const tx = await contract.setBlacklisted(blacklistAddrInput, blacklistAction);
			addFeedback({ message: `${blacklistAction ? 'Blacklisting' : 'Unblacklisting'} address...`, type: 'info' });
			await tx.wait();
			addFeedback({ message: `Address ${blacklistAction ? 'blacklisted' : 'removed from blacklist'}!`, type: 'success' });
			blacklistAddrInput = '';
		} catch (e: any) {
			addFeedback({ message: e.shortMessage || e.message || 'Blacklist update failed', type: 'error' });
		} finally { actionLoading = false; }
	}

	async function doSetExcludedFromLimits() {
		const s = await ensureSigner();
		if (!s || !excludeLimitsAddrInput) return;
		actionLoading = true;
		try {
			const contract = new ethers.Contract(contractAddress, TOKEN_ABI, s);
			const tx = await contract.setExcludedFromLimits(excludeLimitsAddrInput, excludeLimitsAction);
			addFeedback({ message: 'Updating limit exclusion...', type: 'info' });
			await tx.wait();
			addFeedback({ message: `Address ${excludeLimitsAction ? 'excluded from' : 'included in'} limits!`, type: 'success' });
			excludeLimitsAddrInput = '';
		} catch (e: any) {
			addFeedback({ message: e.shortMessage || e.message || 'Exclusion update failed', type: 'error' });
		} finally { actionLoading = false; }
	}

	async function doCheckBlacklist() {
		if (!blacklistCheckAddr || !network) return;
		try {
			const provider = getProvider() ?? new ethers.JsonRpcProvider(network.rpc);
			const contract = new ethers.Contract(contractAddress, TOKEN_ABI, provider);
			blacklistCheckResult = await contract.blacklisted(blacklistCheckAddr);
		} catch (e: any) {
			addFeedback({ message: e.shortMessage || e.message || 'Check failed', type: 'error' });
		}
	}

	async function doCheckExcluded() {
		if (!excludedCheckAddr || !network) return;
		try {
			const provider = getProvider() ?? new ethers.JsonRpcProvider(network.rpc);
			const contract = new ethers.Contract(contractAddress, TOKEN_ABI, provider);
			excludedCheckResult = await contract.isExcludedFromLimits(excludedCheckAddr);
		} catch (e: any) {
			addFeedback({ message: e.shortMessage || e.message || 'Check failed', type: 'error' });
		}
	}

	function shortAddr(addr: string) {
		return addr.slice(0, 8) + '...' + addr.slice(-6);
	}

	const tabs = [
		{ id: 'overview', labelKey: 'mt.tabOverview', icon: 'O' },
		{ id: 'protection', labelKey: 'mt.tabProtection', icon: '#' },
		{ id: 'mint', labelKey: 'mt.tabMint', icon: '+', requires: 'mintable' as const },
		{ id: 'burn', labelKey: 'mt.tabBurn', icon: 'x', requires: 'mintable' as const },
		{ id: 'tax', labelKey: 'mt.tabTax', icon: '%', requires: 'taxable' as const },
		{ id: 'pools', labelKey: 'mt.tabPools', icon: '@', requires: 'pools' as const },
		{ id: 'liquidity', labelKey: 'mt.tabLiquidity', icon: '~' }
	];

	function isTabVisible(tab: (typeof tabs)[0]) {
		if (tab.requires === 'mintable' && tokenInfo?.isMintable === false) return false;
		if (tab.requires === 'taxable' && tokenInfo?.isTaxable === false) return false;
		if (tab.requires === 'pools' && !tokenInfo?.isTaxable && !tokenInfo?.isPartner) return false;
		return true;
	}
</script>

<svelte:head>
	<title>Manage {tokenInfo?.name ?? 'Token'} | TokenKrafter</title>
	<meta name="description" content="Manage {tokenInfo?.name ?? 'your token'} ({tokenInfo?.symbol ?? ''}) — mint, burn, configure taxes, add DEX liquidity, and more on TokenKrafter." />
</svelte:head>

<div class="page-container max-w-6xl mx-auto px-4 sm:px-6 py-10">
	{#if isLoading}
		<div class="flex items-center justify-center min-h-[50vh]">
			<div class="flex flex-col items-center gap-4">
				<div class="spinner w-12 h-12 rounded-full border-2 border-white/10 border-t-cyan-400"></div>
				<p class="text-gray-500 text-sm font-mono">{$t('mt.loadingToken')}</p>
			</div>
		</div>
	{:else if error}
		<div class="error-state text-center py-20">
			<div class="text-5xl mb-4">!</div>
			<h2 class="syne text-2xl font-bold text-white mb-2">
				{error === 'unsupported_network'
					? $t('mt.unsupportedNetwork')
					: error === 'contract_not_found'
						? $t('mt.contractNotFound')
						: $t('mt.contractError')}
			</h2>
			<p class="text-gray-400 font-mono text-sm mb-6">
				{error === 'unsupported_network'
					? $t('mt.unsupportedNetworkDesc')
					: error === 'contract_not_found'
						? $t('mt.contractNotFoundDesc')
						: $t('mt.contractErrorDesc')}
			</p>
			<a href="/manage-tokens" class="btn-secondary text-sm px-5 py-2.5 no-underline">&lt;- {$t('mt.back')}</a>
		</div>
	{:else if tokenInfo}
		<!-- Token Header -->
		<div class="token-header mb-8">
			<div class="flex items-start justify-between flex-wrap gap-4">
				<div class="flex items-center gap-4">
					<div class="token-avatar syne">
						{tokenInfo.symbol.slice(0, 2).toUpperCase()}
					</div>
					<div>
						<h1 class="syne text-2xl sm:text-3xl font-bold text-white">{tokenInfo.name}</h1>
						<div class="flex items-center gap-2 mt-1 flex-wrap">
							<span class="text-gray-400 font-mono text-sm">{tokenInfo.symbol}</span>
							<span class="text-gray-600">|</span>
							<span class="text-gray-400 font-mono text-xs">{network?.name}</span>
							{#if tokenInfo.isMintable}
								<span class="badge badge-cyan">{$t('mt.mintable')}</span>
							{/if}
							{#if tokenInfo.isTaxable}
								<span class="badge badge-amber">{$t('mt.taxable')}</span>
							{/if}
							{#if tokenInfo.isPartner}
								<span class="badge badge-purple">{$t('mt.partner')}</span>
							{/if}
							{#if isOwner}
								<span class="badge badge-emerald">{$t('mt.owner')}</span>
							{/if}
						</div>
					</div>
				</div>
				<a href="/manage-tokens" class="btn-secondary text-xs px-3 py-2 no-underline">&lt;- {$t('mt.back')}</a>
			</div>

			<div class="contract-addr-bar mt-4 font-mono">
				<span class="text-gray-500 text-xs">{$t('mt.contract')}:</span>
				<span class="text-cyan-400 text-xs ml-2">{contractAddress}</span>
			</div>
		</div>

		<!-- Stats Row -->
		<div class="stats-row mb-8 grid grid-cols-2 sm:grid-cols-4 gap-3">
			<div class="stat-card card p-4">
				<div class="stat-label">{$t('mt.totalSupply')}</div>
				<div class="stat-value syne">{Number(tokenInfo.totalSupply).toLocaleString()}</div>
				<div class="stat-unit">{tokenInfo.symbol}</div>
			</div>
			<div class="stat-card card p-4">
				<div class="stat-label">{$t('mt.decimals')}</div>
				<div class="stat-value syne">{tokenInfo.decimals}</div>
				<div class="stat-unit">{$t('mt.precision')}</div>
			</div>
			{#if tokenInfo.userBalance !== undefined}
				<div class="stat-card card p-4">
					<div class="stat-label">{$t('mt.yourBalance')}</div>
					<div class="stat-value syne">{Number(tokenInfo.userBalance).toLocaleString()}</div>
					<div class="stat-unit">{tokenInfo.symbol}</div>
				</div>
			{/if}
			{#if tokenInfo.isTaxable && tokenInfo.buyTaxBps !== undefined}
				<div class="stat-card card p-4">
					<div class="stat-label">{$t('mt.buySellTransferTax')}</div>
					<div class="stat-value syne">{(tokenInfo.buyTaxBps / 100).toFixed(1)}% / {((tokenInfo.sellTaxBps ?? 0) / 100).toFixed(1)}% / {((tokenInfo.transferTaxBps ?? 0) / 100).toFixed(1)}%</div>
					<div class="stat-unit">{$t('mt.basisPoints')}</div>
				</div>
			{/if}
		</div>

		<!-- Tabs -->
		<div class="tabs-bar mb-6 flex gap-1 overflow-x-auto pb-1">
			{#each tabs.filter(isTabVisible) as tab}
				<button
					onclick={() => (activeTab = tab.id as typeof activeTab)}
					class="tab-btn font-mono {activeTab === tab.id ? 'active' : ''} cursor-pointer"
				>
					<span>{tab.icon}</span>
					<span>{$t(tab.labelKey)}</span>
				</button>
			{/each}
		</div>

		<!-- Tab Content -->
		<div class="tab-content">

			<!-- OVERVIEW TAB -->
			{#if activeTab === 'overview'}
				<div class="panel">
					<h3 class="syne text-lg font-bold text-white mb-4">{$t('mt.tokenInfo')}</h3>
					<div class="info-table">
						{#each [
							[$t('mt.name'), tokenInfo.name],
							[$t('mt.symbol'), tokenInfo.symbol],
							[$t('mt.totalSupply'), Number(tokenInfo.totalSupply).toLocaleString() + ' ' + tokenInfo.symbol],
							[$t('mt.decimals'), String(tokenInfo.decimals)],
							[$t('mt.network'), network?.name ?? 'Unknown'],
							[$t('mt.mintable'), tokenInfo.isMintable !== undefined ? (tokenInfo.isMintable ? $t('mt.yes') : $t('mt.no')) : $t('mt.na')],
							[$t('mt.taxable'), tokenInfo.isTaxable !== undefined ? (tokenInfo.isTaxable ? $t('mt.yes') : $t('mt.no')) : $t('mt.na')],
							[$t('mt.partner'), tokenInfo.isPartner !== undefined ? (tokenInfo.isPartner ? $t('mt.yes') : $t('mt.no')) : $t('mt.na')],
							...(tokenInfo.owner ? [[$t('mt.owner'), shortAddr(tokenInfo.owner)]] : [])
						] as [label, value]}
							<div class="info-row">
								<span class="info-key">{label}</span>
								<span class="info-val font-mono">{value}</span>
							</div>
						{/each}
					</div>
				</div>

				<!-- Launchpad Section -->
				{#if launchpadChecked}
					<div class="panel mt-4">
						<h3 class="syne text-lg font-bold text-white mb-3">{$t('mt.launchpad')}</h3>
						{#if launchAddress}
							<div class="launchpad-status launchpad-exists">
								<div class="flex items-center gap-3">
									<span class="w-2.5 h-2.5 rounded-full bg-emerald-400 shrink-0"></span>
									<div>
										<p class="text-sm text-white font-mono">{$t('mt.launchpadExists')}</p>
										<p class="text-xs text-gray-500 font-mono mt-0.5">{launchAddress.slice(0, 10)}...{launchAddress.slice(-8)}</p>
									</div>
								</div>
								<a href="/launchpad/{launchAddress}" class="btn-primary text-xs px-4 py-2 no-underline shrink-0">
									{$t('mt.viewLaunchpad')} →
								</a>
							</div>
						{:else if isOwner}
							<div class="launchpad-status launchpad-create">
								<div class="flex items-center gap-3">
									<span class="w-2.5 h-2.5 rounded-full bg-gray-600 shrink-0"></span>
									<div>
										<p class="text-sm text-white font-mono">{$t('mt.noLaunchpad')}</p>
										<p class="text-xs text-gray-500 font-mono mt-0.5">{$t('mt.noLaunchpadDesc')}</p>
									</div>
								</div>
								<a href="/create?launch=true&token={contractAddress}&chain={network?.symbol}" class="nav-cta no-underline shrink-0 text-xs">
									<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
									{$t('mt.createLaunchpad')}
								</a>
							</div>
						{:else}
							<div class="launchpad-status">
								<div class="flex items-center gap-3">
									<span class="w-2.5 h-2.5 rounded-full bg-gray-600 shrink-0"></span>
									<p class="text-sm text-gray-500 font-mono">{$t('mt.noLaunchpad')}</p>
								</div>
							</div>
						{/if}
					</div>
				{/if}
			{/if}

			<!-- MINT TAB -->
			{#if activeTab === 'mint'}
				<div class="panel">
					<div class="panel-header">
						<div>
							<h3 class="syne text-lg font-bold text-white">{$t('mt.mintTokens')}</h3>
							<p class="text-sm text-gray-500 font-mono mt-1">{$t('mt.mintDesc')}</p>
						</div>
						<span class="badge badge-cyan">{$t('mt.ownerOnly')}</span>
					</div>

					{#if !isOwner}
						<div class="owner-warning">
							<span class="text-amber-400">!</span>
							<span class="text-amber-300 text-sm font-mono">{$t('mt.onlyOwnerCanMint')}</span>
						</div>
					{/if}

					<div class="form-fields">
						<div class="field-group">
							<label class="label-text" for="mint-amount">{$t('mt.amountToMint')}</label>
							<div class="input-with-badge">
								<input
									id="mint-amount"
									class="input-field"
									type="number"
									min="0"
									bind:value={mintAmount}
									placeholder="1000000"
									disabled={!isOwner}
								/>
								<span class="input-badge">{tokenInfo.symbol}</span>
							</div>
						</div>
						<div class="field-group">
							<label class="label-text" for="mint-to">{$t('mt.recipientAddress')}</label>
							<input
								id="mint-to"
								class="input-field"
								bind:value={mintTo}
								placeholder="0x..."
								disabled={!isOwner}
							/>
							{#if userAddress}
								<button
									onclick={() => (mintTo = userAddress!)}
									class="field-hint-btn font-mono cursor-pointer"
								>{$t('mt.useMyWallet')}</button>
							{/if}
						</div>
						<button
							onclick={doMint}
							disabled={!isOwner || actionLoading || !mintAmount}
							class="action-btn mint-btn syne cursor-pointer"
						>
							{actionLoading ? $t('mt.minting') : $t('mt.mintAction')}
						</button>
					</div>
				</div>
			{/if}

			<!-- BURN TAB -->
			{#if activeTab === 'burn'}
				<div class="panel">
					<div class="panel-header">
						<div>
							<h3 class="syne text-lg font-bold text-white">{$t('mt.burnTokens')}</h3>
							<p class="text-sm text-gray-500 font-mono mt-1">{$t('mt.burnDesc')}</p>
						</div>
						<span class="badge badge-amber">{$t('mt.irreversible')}</span>
					</div>

					<div class="form-fields">
						<div class="field-group">
							<label class="label-text" for="burn-amount">{$t('mt.amountToBurn')}</label>
							<div class="input-with-badge">
								<input
									id="burn-amount"
									class="input-field"
									type="number"
									min="0"
									bind:value={burnAmount}
									placeholder="0"
								/>
								<span class="input-badge">{tokenInfo.symbol}</span>
							</div>
							{#if tokenInfo.userBalance}
								<span class="field-hint font-mono">{$t('mt.balance')}: {Number(tokenInfo.userBalance).toLocaleString()} {tokenInfo.symbol}</span>
							{/if}
						</div>

						<div class="burn-warning">
							<span class="text-red-400">!</span>
							<span class="text-red-300 text-sm font-mono">{$t('mt.burnWarning')}</span>
						</div>

						<button
							onclick={doBurn}
							disabled={actionLoading || !burnAmount}
							class="action-btn burn-btn syne cursor-pointer"
						>
							{actionLoading ? $t('mt.burning') : $t('mt.burnAction')}
						</button>
					</div>
				</div>
			{/if}

			<!-- TAX TAB -->
			{#if activeTab === 'tax'}
				<div class="panel">
					<div class="panel-header">
						<div>
							<h3 class="syne text-lg font-bold text-white">{$t('mt.taxSettings')}</h3>
							<p class="text-sm text-gray-500 font-mono mt-1">{$t('mt.taxDesc')}</p>
						</div>
						<span class="badge badge-cyan">{$t('mt.ownerOnly')}</span>
					</div>

					{#if !isOwner}
						<div class="owner-warning">
							<span class="text-amber-400">!</span>
							<span class="text-amber-300 text-sm font-mono">{$t('mt.onlyOwnerCanTax')}</span>
						</div>
					{/if}

					<div class="form-fields">
						<!-- Tax Rates -->
						<div class="sub-panel">
							<h4 class="syne text-sm font-bold text-white mb-3">{$t('mt.taxRates')}</h4>
							<div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
								<div class="field-group">
									<label class="label-text" for="buy-tax">{$t('mt.buyTax')}</label>
									<div class="input-with-badge">
										<input
											id="buy-tax"
											class="input-field"
											type="number"
											min="0"
											max="10"
											step="0.01"
											bind:value={buyTaxPctInput}
											placeholder="0"
											disabled={!isOwner}
										/>
										<span class="input-badge">%</span>
									</div>
									{#if tokenInfo.buyTaxBps !== undefined}
										<span class="field-hint font-mono">{$t('mt.current')}: {(tokenInfo.buyTaxBps / 100).toFixed(2)}%</span>
									{/if}
								</div>
								<div class="field-group">
									<label class="label-text" for="sell-tax">{$t('mt.sellTax')}</label>
									<div class="input-with-badge">
										<input
											id="sell-tax"
											class="input-field"
											type="number"
											min="0"
											max="10"
											step="0.01"
											bind:value={sellTaxPctInput}
											placeholder="0"
											disabled={!isOwner}
										/>
										<span class="input-badge">%</span>
									</div>
									{#if tokenInfo.sellTaxBps !== undefined}
										<span class="field-hint font-mono">{$t('mt.current')}: {(tokenInfo.sellTaxBps / 100).toFixed(2)}%</span>
									{/if}
								</div>
								<div class="field-group">
									<label class="label-text" for="transfer-tax">{$t('mt.transferTax')}</label>
									<div class="input-with-badge">
										<input
											id="transfer-tax"
											class="input-field"
											type="number"
											min="0"
											max="5"
											step="0.01"
											bind:value={transferTaxPctInput}
											placeholder="0"
											disabled={!isOwner}
										/>
										<span class="input-badge">%</span>
									</div>
									{#if tokenInfo.transferTaxBps !== undefined}
										<span class="field-hint font-mono">{$t('mt.current')}: {(tokenInfo.transferTaxBps / 100).toFixed(2)}%</span>
									{/if}
								</div>
							</div>
							<div class="text-xs text-gray-500 font-mono mt-2">{$t('mt.taxMaxHint')}</div>
							<button
								onclick={doSetTaxes}
								disabled={!isOwner || actionLoading}
								class="action-btn tax-btn syne cursor-pointer mt-3"
							>
								{actionLoading ? $t('mt.saving') : $t('mt.updateTaxRates')}
							</button>
						</div>

						<!-- Tax Distribution -->
						<div class="sub-panel">
							<h4 class="syne text-sm font-bold text-white mb-3">{$t('mt.taxDistribution')}</h4>
							<div class="flex flex-col gap-3">
								{#each taxWallets as wallet, i}
									<div class="flex gap-2 items-end">
										<div class="field-group flex-1">
											<label class="label-text" for="tw-addr-{i}">{$t('mt.walletAddress')}</label>
											<input
												id="tw-addr-{i}"
												class="input-field"
												bind:value={wallet.address}
												placeholder="0x..."
												disabled={!isOwner}
											/>
										</div>
										<div class="field-group" style="width: 120px;">
											<label class="label-text" for="tw-share-{i}">{$t('mt.shareBps')}</label>
											<input
												id="tw-share-{i}"
												class="input-field"
												type="number"
												min="1"
												max="10000"
												bind:value={wallet.shareBps}
												placeholder="5000"
												disabled={!isOwner}
											/>
										</div>
										<button
											onclick={() => removeTaxWallet(i)}
											class="btn-danger text-xs px-3 py-2.5 cursor-pointer"
											disabled={!isOwner}
										>x</button>
									</div>
								{/each}
								{#if taxWallets.length < 10}
									<button
										onclick={addTaxWallet}
										class="btn-secondary text-xs px-3 py-2 cursor-pointer self-start"
										disabled={!isOwner}
									>{$t('mt.addWallet')}</button>
								{/if}
							</div>
							{#if taxWallets.length > 0}
								<button
									onclick={doSetTaxDistribution}
									disabled={!isOwner || actionLoading || taxWallets.length === 0}
									class="action-btn tax-btn syne cursor-pointer mt-3"
								>
									{actionLoading ? $t('mt.saving') : $t('mt.saveTaxDistribution')}
								</button>
							{/if}
						</div>

						<!-- Tax Exemption -->
						<div class="sub-panel">
							<h4 class="syne text-sm font-bold text-white mb-3">{$t('mt.taxExemption')}</h4>
							<div class="flex gap-2 items-end flex-wrap">
								<div class="field-group flex-1" style="min-width: 200px;">
									<label class="label-text" for="exempt-addr">{$t('mt.address')}</label>
									<input
										id="exempt-addr"
										class="input-field"
										bind:value={taxExemptAddr}
										placeholder="0x..."
										disabled={!isOwner}
									/>
								</div>
								<div class="field-group" style="width: 120px;">
									<label class="label-text" for="exempt-val">{$t('mt.exempt')}</label>
									<select id="exempt-val" class="input-field" bind:value={taxExemptValue} disabled={!isOwner}>
										<option value={true}>{$t('mt.yes')}</option>
										<option value={false}>{$t('mt.no')}</option>
									</select>
								</div>
								<button
									onclick={doExcludeFromTax}
									disabled={!isOwner || actionLoading || !taxExemptAddr}
									class="action-btn tax-btn syne cursor-pointer"
									style="max-width: 180px;"
								>
									{actionLoading ? $t('mt.saving') : $t('mt.update')}
								</button>
							</div>
						</div>
					</div>
				</div>
			{/if}

			<!-- POOLS TAB -->
			{#if activeTab === 'pools'}
				<div class="panel">
					<div class="panel-header">
						<div>
							<h3 class="syne text-lg font-bold text-white">{$t('mt.poolManagement')}</h3>
							<p class="text-sm text-gray-500 font-mono mt-1">{$t('mt.poolDesc')}</p>
						</div>
						<span class="badge badge-cyan">{$t('mt.ownerOnly')}</span>
					</div>

					{#if !isOwner}
						<div class="owner-warning">
							<span class="text-amber-400">!</span>
							<span class="text-amber-300 text-sm font-mono">{$t('mt.onlyOwnerCanPools')}</span>
						</div>
					{/if}

					<div class="form-fields">
						<!-- Add / Remove Pool -->
						<div class="sub-panel">
							<h4 class="syne text-sm font-bold text-white mb-3">{$t('mt.addRemovePool')}</h4>
							<div class="field-group">
								<label class="label-text" for="pool-addr">{$t('mt.poolAddress')}</label>
								<input
									id="pool-addr"
									class="input-field"
									bind:value={poolAddressInput}
									placeholder="0x..."
									disabled={!isOwner}
								/>
							</div>
							<div class="flex gap-3 mt-3">
								<button
									onclick={doAddPool}
									disabled={!isOwner || actionLoading || !poolAddressInput}
									class="action-btn mint-btn syne cursor-pointer"
									style="flex:1;"
								>
									{actionLoading ? $t('mt.processing') : $t('mt.addPool')}
								</button>
								<button
									onclick={doRemovePool}
									disabled={!isOwner || actionLoading || !poolAddressInput}
									class="action-btn burn-btn syne cursor-pointer"
									style="flex:1;"
								>
									{actionLoading ? $t('mt.processing') : $t('mt.removePool')}
								</button>
							</div>
						</div>

						<!-- Check Pool Status -->
						<div class="sub-panel">
							<h4 class="syne text-sm font-bold text-white mb-3">{$t('mt.checkPoolStatus')}</h4>
							<div class="flex gap-2 items-end flex-wrap">
								<div class="field-group flex-1" style="min-width: 200px;">
									<label class="label-text" for="pool-check-addr">{$t('mt.addressToCheck')}</label>
									<input
										id="pool-check-addr"
										class="input-field"
										bind:value={poolCheckAddr}
										placeholder="0x..."
									/>
								</div>
								<button
									onclick={doCheckPool}
									disabled={!poolCheckAddr}
									class="btn-secondary text-xs px-4 py-3 cursor-pointer font-mono"
								>{$t('mt.check')}</button>
							</div>
							{#if poolCheckResult !== null}
								<div class="mt-3 px-3 py-2 rounded-lg {poolCheckResult ? 'bg-emerald-500/10 border border-emerald-500/20' : 'bg-red-500/10 border border-red-500/20'}">
									<span class="text-sm font-mono {poolCheckResult ? 'text-emerald-400' : 'text-red-400'}">
										{poolCheckResult ? $t('mt.isRegisteredPool') : $t('mt.isNotRegisteredPool')}
									</span>
								</div>
							{/if}
						</div>
					</div>
				</div>
			{/if}

			<!-- LIQUIDITY TAB -->
			{#if activeTab === 'protection'}
				<div class="panel">
					<div class="panel-header">
						<div>
							<h3 class="syne text-lg font-bold text-white">{$t('mt.tokenProtection')}</h3>
							<p class="text-sm text-gray-500 font-mono mt-1">
								{$t('mt.protectionDesc')}
							</p>
						</div>
						{#if tokenInfo.tradingEnabled}
							<span class="badge badge-emerald">{$t('mt.tradingLive')}</span>
						{:else}
							<span class="badge badge-amber">{$t('mt.preTrading')}</span>
						{/if}
					</div>

					{#if !tokenInfo.tradingEnabled}
						<div class="protection-notice mb-4">
							<span class="text-cyan-400 text-xs font-mono font-bold">{$t('mt.preTradingMode')}</span>
							<span class="text-gray-400 text-xs font-mono">
								{$t('mt.preTradingDesc')}
							</span>
						</div>
					{:else}
						<div class="protection-notice relax-only mb-4">
							<span class="text-emerald-400 text-xs font-mono font-bold">{$t('mt.tradingIsLive')}</span>
							<span class="text-gray-400 text-xs font-mono">
								{$t('mt.tradingIsLiveDesc')}
							</span>
						</div>
					{/if}

					<!-- Current Status -->
					<div class="sub-panel mb-4">
						<h4 class="syne text-sm font-bold text-white mb-3">{$t('mt.currentSettings')}</h4>
						<div class="flex flex-col gap-2">
							<div class="protection-stat-row">
								<span class="text-gray-500 text-xs font-mono">{$t('mt.trading')}</span>
								<span class="text-xs font-mono {tokenInfo.tradingEnabled ? 'text-emerald-400' : 'text-amber-400'}">
									{tokenInfo.tradingEnabled ? $t('mt.enabled') : $t('mt.notEnabled')}
								</span>
							</div>
							<div class="protection-stat-row">
								<span class="text-gray-500 text-xs font-mono">{$t('mt.maxWallet')}</span>
								<span class="text-xs font-mono {Number(tokenInfo.maxWalletAmount ?? 0) > 0 ? 'text-cyan-300' : 'text-gray-600'}">
									{Number(tokenInfo.maxWalletAmount ?? 0) > 0 ? `${Number(tokenInfo.maxWalletAmount).toLocaleString()} ${tokenInfo.symbol}` : $t('mt.noLimit')}
								</span>
							</div>
							<div class="protection-stat-row">
								<span class="text-gray-500 text-xs font-mono">{$t('mt.maxTransaction')}</span>
								<span class="text-xs font-mono {Number(tokenInfo.maxTransactionAmount ?? 0) > 0 ? 'text-cyan-300' : 'text-gray-600'}">
									{Number(tokenInfo.maxTransactionAmount ?? 0) > 0 ? `${Number(tokenInfo.maxTransactionAmount).toLocaleString()} ${tokenInfo.symbol}` : $t('mt.noLimit')}
								</span>
							</div>
							<div class="protection-stat-row">
								<span class="text-gray-500 text-xs font-mono">{$t('mt.cooldown')}</span>
								<span class="text-xs font-mono {(tokenInfo.cooldownTime ?? 0) > 0 ? 'text-cyan-300' : 'text-gray-600'}">
									{(tokenInfo.cooldownTime ?? 0) > 0 ? `${tokenInfo.cooldownTime}s` : $t('mt.disabled')}
								</span>
							</div>
							<div class="protection-stat-row">
								<span class="text-gray-500 text-xs font-mono">{$t('mt.blacklist')}</span>
								<span class="text-xs font-mono {(tokenInfo.blacklistWindow ?? 0) > 0 ? 'text-cyan-300' : 'text-gray-600'}">
									{#if (tokenInfo.blacklistWindow ?? 0) === 0}
										{$t('mt.disabled')}
									{:else if tokenInfo.tradingEnabled && tokenInfo.tradingEnabledAt}
										{@const expiresAt = tokenInfo.tradingEnabledAt + (tokenInfo.blacklistWindow ?? 0)}
										{@const now = Math.floor(Date.now() / 1000)}
										{now > expiresAt ? $t('mt.expired') : `${$t('mt.active')} (${$t('mt.expiresIn')} ${Math.round((expiresAt - now) / 3600)}h)`}
									{:else}
										Window: {Math.round((tokenInfo.blacklistWindow ?? 0) / 3600)}h {$t('mt.windowAfterTrading')}
									{/if}
								</span>
							</div>
						</div>
					</div>

					{#if isOwner}
						<div class="form-fields">
							<!-- Enable Trading -->
							{#if !tokenInfo.tradingEnabled}
								<div class="sub-panel trading-enable-box">
									<h4 class="syne text-sm font-bold text-white mb-2">{$t('mt.enableTrading')}</h4>
									<p class="text-gray-500 text-xs font-mono mb-3">
										{$t('mt.enableTradingDesc')}
									</p>
									<button
										onclick={doEnableTrading}
										disabled={actionLoading}
										class="action-btn syne cursor-pointer w-full"
									>
										{actionLoading ? $t('mt.enabling') : $t('mt.enableTrading')}
									</button>
								</div>
							{/if}

							<!-- Max Wallet -->
							<div class="field-group">
								<label class="label-text" for="max-wallet">{$t('mt.maxWalletAmount')}</label>
								<div class="input-with-badge">
									<input
										id="max-wallet"
										class="input-field"
										type="number"
										min="0"
										bind:value={maxWalletInput}
										placeholder={tokenInfo.tradingEnabled && Number(tokenInfo.maxWalletAmount ?? 0) > 0 ? `Current: ${Number(tokenInfo.maxWalletAmount).toLocaleString()} (can only increase)` : 'e.g. 10000'}
									/>
									<span class="input-badge">{tokenInfo.symbol}</span>
								</div>
								<span class="field-hint font-mono">{$t('mt.setTo0Disable')} {tokenInfo.tradingEnabled ? $t('mt.canOnlyIncrease') : ''}</span>
								<button onclick={doSetMaxWallet} disabled={actionLoading} class="action-btn mt-2 syne cursor-pointer">
									{actionLoading ? $t('mt.setting') : $t('mt.setMaxWallet')}
								</button>
							</div>

							<!-- Max Transaction -->
							<div class="field-group">
								<label class="label-text" for="max-tx">{$t('mt.maxTxAmount')}</label>
								<div class="input-with-badge">
									<input
										id="max-tx"
										class="input-field"
										type="number"
										min="0"
										bind:value={maxTxInput}
										placeholder={tokenInfo.tradingEnabled && Number(tokenInfo.maxTransactionAmount ?? 0) > 0 ? `Current: ${Number(tokenInfo.maxTransactionAmount).toLocaleString()} (can only increase)` : 'e.g. 5000'}
									/>
									<span class="input-badge">{tokenInfo.symbol}</span>
								</div>
								<span class="field-hint font-mono">{$t('mt.setTo0Disable')} {tokenInfo.tradingEnabled ? $t('mt.canOnlyIncrease') : ''}</span>
								<button onclick={doSetMaxTx} disabled={actionLoading} class="action-btn mt-2 syne cursor-pointer">
									{actionLoading ? $t('mt.setting') : $t('mt.setMaxTx')}
								</button>
							</div>

							<!-- Cooldown -->
							<div class="field-group">
								<label class="label-text" for="cooldown">{$t('mt.cooldownTime')}</label>
								<div class="input-with-badge">
									<input
										id="cooldown"
										class="input-field"
										type="number"
										min="0"
										bind:value={cooldownInput}
										placeholder={tokenInfo.tradingEnabled && (tokenInfo.cooldownTime ?? 0) > 0 ? `Current: ${tokenInfo.cooldownTime}s (can only decrease)` : 'e.g. 30'}
									/>
									<span class="input-badge">sec</span>
								</div>
								<span class="field-hint font-mono">{$t('mt.setTo0Disable')} {tokenInfo.tradingEnabled ? $t('mt.canOnlyDecrease') : ''} {$t('mt.cooldownHint')}</span>
								<button onclick={doSetCooldown} disabled={actionLoading} class="action-btn mt-2 syne cursor-pointer">
									{actionLoading ? $t('mt.setting') : $t('mt.setCooldown')}
								</button>
							</div>

							<!-- Blacklist Window (only before trading) -->
							{#if !tokenInfo.tradingEnabled}
								<div class="field-group">
									<label class="label-text" for="bl-window">{$t('mt.blacklistWindow')}</label>
									<div class="input-with-badge">
										<input
											id="bl-window"
											class="input-field"
											type="number"
											min="0"
											max="259200"
											bind:value={blacklistWindowInput}
											placeholder="e.g. 86400 (24 hours)"
										/>
										<span class="input-badge">sec</span>
									</div>
									<span class="field-hint font-mono">{$t('mt.blacklistWindowHint')}</span>
									<button onclick={doSetBlacklistWindow} disabled={actionLoading} class="action-btn mt-2 syne cursor-pointer">
										{actionLoading ? $t('mt.setting') : $t('mt.setBlacklistWindow')}
									</button>
								</div>
							{/if}

							<!-- Blacklist Management -->
							{#if (tokenInfo.blacklistWindow ?? 0) > 0}
								<div class="sub-panel">
									<h4 class="syne text-sm font-bold text-white mb-3">{$t('mt.blacklistManagement')}</h4>
									<div class="field-group">
										<label class="label-text" for="bl-addr">{$t('mt.address')}</label>
										<input id="bl-addr" class="input-field" bind:value={blacklistAddrInput} placeholder="0x..." />
									</div>
									<div class="flex gap-2 mt-2">
										<select class="input-field" style="max-width: 150px;" bind:value={blacklistAction}>
											<option value={true}>{$t('mt.blacklist')}</option>
											<option value={false}>{$t('mt.unblacklist')}</option>
										</select>
										<button onclick={doSetBlacklisted} disabled={actionLoading || !blacklistAddrInput} class="action-btn syne cursor-pointer flex-1">
											{actionLoading ? $t('mt.updating') : blacklistAction ? $t('mt.blockAddress') : $t('mt.unblockAddress')}
										</button>
									</div>

									<!-- Check if address is blacklisted -->
									<div class="mt-3">
										<div class="flex gap-2">
											<input class="input-field flex-1" bind:value={blacklistCheckAddr} placeholder={$t('mt.checkAddress')} />
											<button onclick={doCheckBlacklist} class="btn-secondary text-xs px-3 py-1.5 cursor-pointer">{$t('mt.check')}</button>
										</div>
										{#if blacklistCheckResult !== null}
											<div class="text-xs font-mono mt-1 {blacklistCheckResult ? 'text-red-400' : 'text-emerald-400'}">
												{blacklistCheckResult ? $t('mt.blacklisted') : $t('mt.notBlacklisted')}
											</div>
										{/if}
									</div>
								</div>
							{/if}

							<!-- Exclude from Limits -->
							<div class="sub-panel">
								<h4 class="syne text-sm font-bold text-white mb-3">{$t('mt.limitExclusions')}</h4>
								<p class="text-gray-500 text-xs font-mono mb-3">{$t('mt.limitExclusionsDesc')}</p>
								<div class="field-group">
									<label class="label-text" for="exclude-addr">{$t('mt.address')}</label>
									<input id="exclude-addr" class="input-field" bind:value={excludeLimitsAddrInput} placeholder="0x..." />
								</div>
								<div class="flex gap-2 mt-2">
									<select class="input-field" style="max-width: 150px;" bind:value={excludeLimitsAction}>
										<option value={true}>{$t('mt.exclude')}</option>
										<option value={false}>{$t('mt.include')}</option>
									</select>
									<button onclick={doSetExcludedFromLimits} disabled={actionLoading || !excludeLimitsAddrInput} class="action-btn syne cursor-pointer flex-1">
										{actionLoading ? $t('mt.updating') : excludeLimitsAction ? $t('mt.excludeFromLimits') : $t('mt.includeInLimits')}
									</button>
								</div>

								<!-- Check if excluded -->
								<div class="mt-3">
									<div class="flex gap-2">
										<input class="input-field flex-1" bind:value={excludedCheckAddr} placeholder={$t('mt.checkAddress')} />
										<button onclick={doCheckExcluded} class="btn-secondary text-xs px-3 py-1.5 cursor-pointer">{$t('mt.check')}</button>
									</div>
									{#if excludedCheckResult !== null}
										<div class="text-xs font-mono mt-1 {excludedCheckResult ? 'text-cyan-300' : 'text-gray-400'}">
											{excludedCheckResult ? $t('mt.excludedFromLimits') : $t('mt.subjectToLimits')}
										</div>
									{/if}
								</div>
							</div>
						</div>
					{:else}
						<div class="text-center py-6">
							<p class="text-gray-500 font-mono text-sm">{$t('mt.onlyOwnerProtection')}</p>
						</div>
					{/if}
				</div>
			{/if}

			{#if activeTab === 'liquidity'}
				<div class="panel">
					<div class="panel-header">
						<div>
							<h3 class="syne text-lg font-bold text-white">{$t('mt.liquidity')}</h3>
							<p class="text-sm text-gray-500 font-mono mt-1">
								{$t('mt.liquidityDesc')}
							</p>
						</div>
						<span class="badge badge-purple">{$t('mt.dex')}</span>
					</div>

					<div class="form-fields">
						<!-- Router Selection -->
						<div class="field-group">
							<label class="label-text" for="dex-router">{$t('mt.dexRouter')}</label>
							<select id="dex-router" class="input-field" bind:value={selectedRouter} onchange={() => { poolsLoaded = false; existingPools = []; }}>
								{#each DEX_ROUTERS[network?.chain_id ?? 1] ?? [] as r}
									<option value={r.address}>{r.name}</option>
								{/each}
							</select>
						</div>

						<!-- Existing Pools Section -->
						<div class="sub-panel">
							<div class="flex items-center justify-between mb-3">
								<h4 class="syne text-sm font-bold text-white">{$t('mt.existingPools')}</h4>
								<button
									onclick={lookupExistingPools}
									disabled={poolsLoading}
									class="btn-secondary text-xs px-3 py-1.5 cursor-pointer"
								>
									{poolsLoading ? $t('mt.loadingPools') : poolsLoaded ? $t('mt.refreshPools') : $t('mt.loadPools')}
								</button>
							</div>

							{#if poolsLoading}
								<div class="flex items-center gap-3 py-4 justify-center">
									<div class="spinner w-5 h-5 rounded-full border-2 border-white/10 border-t-cyan-400"></div>
									<span class="text-gray-500 text-xs font-mono">{$t('mt.scanningPools')}</span>
								</div>
							{:else if poolsLoaded && existingPools.length === 0}
								<p class="text-gray-500 text-xs font-mono py-2">{$t('mt.noPoolsFound')}</p>
							{:else if !poolsLoaded}
								<p class="text-gray-600 text-xs font-mono py-2">{$t('mt.clickLoadPools')}</p>
							{/if}

							{#if existingPools.length > 0}
								<div class="flex flex-col gap-3">
									{#each existingPools as pool}
										<div class="pool-card">
											<button
												class="pool-card-header cursor-pointer"
												onclick={() => {
													if (!poolAddAmounts[pool.pairAddress]) poolAddAmounts[pool.pairAddress] = { baseAmount: '', tokenAmount: '', expanded: false };
													poolAddAmounts[pool.pairAddress].expanded = !poolAddAmounts[pool.pairAddress].expanded;
												}}
											>
												<div class="flex items-center gap-3">
													<div class="pool-pair-badge syne">{tokenInfo.symbol}/{pool.baseSymbol}</div>
													<div class="flex flex-col">
														{#if isEmptyPool(pool)}
															<span class="text-amber-400 text-sm font-mono">{$t('mt.emptyPoolSetPrice')}</span>
														{:else}
															<span class="text-white text-sm font-mono">1 {tokenInfo.symbol} = {pool.pricePerToken < 0.000001 ? pool.pricePerToken.toExponential(4) : pool.pricePerToken.toFixed(6)} {pool.baseSymbol}</span>
														{/if}
														<span class="text-gray-500 text-[10px] font-mono">{shortAddr(pool.pairAddress)}</span>
													</div>
												</div>
												<div class="flex items-center gap-3">
													<div class="flex flex-col items-end">
														{#if isEmptyPool(pool)}
															<span class="badge badge-amber" style="font-size:10px;">{$t('mt.empty')}</span>
														{:else}
															<span class="text-gray-400 text-[10px] font-mono uppercase">{$t('mt.poolLiquidity')}</span>
															<span class="text-gray-300 text-xs font-mono">{pool.tokenReserve.toLocaleString(undefined, {maximumFractionDigits: 2})} / {pool.baseReserve.toLocaleString(undefined, {maximumFractionDigits: 4})}</span>
														{/if}
													</div>
													<span class="pool-expand-icon {poolAddAmounts[pool.pairAddress]?.expanded ? 'expanded' : ''}">v</span>
												</div>
											</button>

											{#if poolAddAmounts[pool.pairAddress]?.expanded}
												<div class="pool-card-body">
													{#if isEmptyPool(pool)}
														<div class="empty-pool-hint">
															<span class="text-amber-400 text-xs font-mono font-bold">{$t('mt.emptyPool')}</span>
															<span class="text-gray-400 text-xs font-mono">{$t('mt.emptyPoolDesc')}</span>
														</div>
													{/if}
													<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
														<div class="field-group">
															<label class="label-text" for="pool-base-{pool.pairAddress}">{pool.baseSymbol} {$t('mt.amount')}</label>
															<div class="input-with-badge">
																<input
																	id="pool-base-{pool.pairAddress}"
																	class="input-field"
																	type="number"
																	min="0"
																	step="any"
																	bind:value={poolAddAmounts[pool.pairAddress].baseAmount}
																	oninput={() => onPoolBaseInput(pool)}
																	placeholder="0.0"
																/>
																<span class="input-badge">{pool.baseSymbol}</span>
															</div>
														</div>
														<div class="field-group">
															<label class="label-text" for="pool-token-{pool.pairAddress}">{tokenInfo.symbol} {$t('mt.amount')}</label>
															<div class="input-with-badge">
																<input
																	id="pool-token-{pool.pairAddress}"
																	class="input-field"
																	type="number"
																	min="0"
																	step="any"
																	bind:value={poolAddAmounts[pool.pairAddress].tokenAmount}
																	oninput={() => onPoolTokenInput(pool)}
																	placeholder="0.0"
																/>
																<span class="input-badge">{tokenInfo.symbol}</span>
															</div>
														</div>
													</div>

													{#if poolTokenPct(pool, poolAddAmounts[pool.pairAddress]?.tokenAmount) > 0}
														<div class="liq-pct-bar">
															<div class="flex justify-between text-xs font-mono mb-1">
																<span class="text-gray-500">{$t('mt.supplyAllocated')}</span>
																<span class="text-cyan-400">{poolTokenPct(pool, poolAddAmounts[pool.pairAddress].tokenAmount).toFixed(1)}%</span>
															</div>
															<div class="pct-track">
																<div class="pct-fill" style="width: {Math.min(poolTokenPct(pool, poolAddAmounts[pool.pairAddress].tokenAmount), 100)}%"></div>
															</div>
														</div>
													{/if}

													<div class="liq-info-box">
														{#if !isEmptyPool(pool)}
															<div class="liq-info-row">
																<span class="text-gray-500 font-mono text-xs">{$t('mt.currentPrice')}</span>
																<span class="text-cyan-300 font-mono text-xs">1 {tokenInfo.symbol} = {pool.pricePerToken < 0.000001 ? pool.pricePerToken.toExponential(4) : pool.pricePerToken.toFixed(6)} {pool.baseSymbol}</span>
															</div>
														{/if}
														<div class="liq-info-row">
															<span class="text-gray-500 font-mono text-xs">{$t('mt.slippageTolerance')}</span>
															<span class="text-cyan-300 font-mono text-xs">5%</span>
														</div>
														<div class="liq-info-row">
															<span class="text-gray-500 font-mono text-xs">{$t('mt.lpTokensGoTo')}</span>
															<span class="text-cyan-300 font-mono text-xs">{userAddress ? shortAddr(userAddress) : $t('mt.yourWallet')}</span>
														</div>
													</div>

													<button
														onclick={() => doAddToExistingPool(pool)}
														disabled={poolAddLoading[pool.pairAddress] || !poolAddAmounts[pool.pairAddress]?.tokenAmount || !poolAddAmounts[pool.pairAddress]?.baseAmount}
														class="action-btn liq-btn syne cursor-pointer"
													>
														{poolAddLoading[pool.pairAddress] ? $t('mt.addingLiquidity') : `${$t('mt.addToPool')} ${tokenInfo.symbol}/${pool.baseSymbol} ${$t('mt.pool')}`}
													</button>
												</div>
											{/if}
										</div>
									{/each}
								</div>
							{/if}
						</div>

						<!-- Create New Pool -->
						<div class="sub-panel">
							<button
								class="flex items-center justify-between w-full cursor-pointer"
								style="background: none; border: none; padding: 0;"
								onclick={() => (showNewPool = !showNewPool)}
							>
								<h4 class="syne text-sm font-bold text-white">{$t('mt.createNewPool')}</h4>
								<span class="pool-expand-icon {showNewPool ? 'expanded' : ''}">v</span>
							</button>

							{#if showNewPool}
								<div class="flex flex-col gap-4 mt-4">
									<!-- Base Coin Selection -->
									<div class="field-group">
										<label class="label-text" for="new-pool-base">{$t('mt.baseCoin')}</label>
										<select id="new-pool-base" class="input-field" bind:value={newPoolBaseCoin}>
											{#each getBaseCoinOptions() as opt}
												<option value={opt.key}>{opt.symbol}</option>
											{/each}
										</select>
									</div>

									<!-- Mode Toggle -->
									<div class="mode-toggle">
										<button
											onclick={() => (newPoolMode = 'manual')}
											class="mode-btn {newPoolMode === 'manual' ? 'active' : ''} cursor-pointer"
										>{$t('mt.manualAmounts')}</button>
										<button
											onclick={() => (newPoolMode = 'price')}
											class="mode-btn {newPoolMode === 'price' ? 'active' : ''} cursor-pointer"
										>{$t('mt.priceBased')}</button>
									</div>

									{#if newPoolMode === 'manual'}
										<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
											<div class="field-group">
												<label class="label-text" for="new-liq-token">{$t('mt.tokenAmount')}</label>
												<div class="input-with-badge">
													<input
														id="new-liq-token"
														class="input-field"
														type="number"
														min="0"
														bind:value={newPoolTokenAmount}
														placeholder="100000"
													/>
													<span class="input-badge">{tokenInfo.symbol}</span>
												</div>
											</div>
											<div class="field-group">
												<label class="label-text" for="new-liq-base">{newPoolSelectedBase?.symbol ?? 'Base'} {$t('mt.amount')}</label>
												<div class="input-with-badge">
													<input
														id="new-liq-base"
														class="input-field"
														type="number"
														min="0"
														bind:value={newPoolBaseAmount}
														placeholder="0.5"
													/>
													<span class="input-badge">{newPoolSelectedBase?.symbol ?? ''}</span>
												</div>
											</div>
										</div>
									{:else}
										<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
											<div class="field-group">
												<label class="label-text" for="new-price-per-token">{$t('mt.pricePerToken')} ({newPoolSelectedBase?.symbol})</label>
												<div class="input-with-badge">
													<input
														id="new-price-per-token"
														class="input-field"
														type="number"
														min="0"
														step="any"
														bind:value={newPoolPricePerToken}
														placeholder="1.00"
													/>
													<span class="input-badge">{newPoolSelectedBase?.symbol ?? ''}</span>
												</div>
												<span class="field-hint font-mono">{$t('mt.howMuchCosts')} {tokenInfo.symbol} {$t('mt.costs')}</span>
											</div>
											<div class="field-group">
												<label class="label-text" for="new-list-base-amt">{$t('mt.amountToList')} {newPoolSelectedBase?.symbol} {$t('mt.toList')}</label>
												<div class="input-with-badge">
													<input
														id="new-list-base-amt"
														class="input-field"
														type="number"
														min="0"
														step="any"
														bind:value={newPoolListBaseAmount}
														placeholder="100"
													/>
													<span class="input-badge">{newPoolSelectedBase?.symbol ?? ''}</span>
												</div>
											</div>
										</div>

										{#if newPoolCalculatedTokenAmount()}
											<div class="calc-result">
												<span class="text-gray-500 text-xs font-mono">{$t('mt.calculatedTokenAmount')}</span>
												<span class="text-white text-sm font-mono font-bold">
													{Number(newPoolCalculatedTokenAmount()).toLocaleString()} {tokenInfo.symbol}
												</span>
											</div>
										{/if}
									{/if}

									{#if newPoolTokenPct() > 0}
										<div class="liq-pct-bar">
											<div class="flex justify-between text-xs font-mono mb-1">
												<span class="text-gray-500">{$t('mt.supplyAllocated')}</span>
												<span class="text-cyan-400">{newPoolTokenPct().toFixed(1)}%</span>
											</div>
											<div class="pct-track">
												<div class="pct-fill" style="width: {Math.min(newPoolTokenPct(), 100)}%"></div>
											</div>
										</div>
									{/if}

									<div class="liq-info-box">
										<div class="liq-info-row">
											<span class="text-gray-500 font-mono text-xs">{$t('mt.slippageTolerance')}</span>
											<span class="text-cyan-300 font-mono text-xs">5%</span>
										</div>
										<div class="liq-info-row">
											<span class="text-gray-500 font-mono text-xs">{$t('mt.txDeadline')}</span>
											<span class="text-cyan-300 font-mono text-xs">{$t('mt.twentyMinutes')}</span>
										</div>
										<div class="liq-info-row">
											<span class="text-gray-500 font-mono text-xs">{$t('mt.lpTokensGoTo')}</span>
											<span class="text-cyan-300 font-mono text-xs">{userAddress ? shortAddr(userAddress) : $t('mt.yourWallet')}</span>
										</div>
									</div>

									<button
										onclick={doCreateNewPool}
										disabled={actionLoading || (newPoolMode === 'manual' ? (!newPoolTokenAmount || !newPoolBaseAmount) : (!newPoolPricePerToken || !newPoolListBaseAmount))}
										class="action-btn liq-btn syne cursor-pointer"
									>
										{actionLoading ? $t('mt.creatingPool') : $t('mt.createPoolAddLiquidity')}
									</button>
								</div>
							{/if}
						</div>
					</div>
				</div>
			{/if}
		</div>
	{/if}
</div>

<!-- Deposit Modal -->
{#if showDepositModal && depositInfo}
	<div
		class="fixed inset-0 z-[80] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
		onclick={closeDepositModal}
	>
		<div
			class="deposit-modal w-full max-w-md rounded-2xl border shadow-2xl overflow-hidden" style="border-color: var(--border-input); background: var(--bg)"
			onclick={(e) => e.stopPropagation()}
		>
			<!-- Header -->
			<div class="deposit-modal-header">
				<div class="flex items-center gap-3">
					<div class="deposit-icon-circle">
						<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M12 2v20M2 12h20"/>
						</svg>
					</div>
					<div>
						<h2 class="syne text-lg font-bold text-white">{$t('mt.depositRequired')}</h2>
						<p class="text-gray-500 text-[11px] font-mono">{depositInfo.networkName} Network</p>
					</div>
				</div>
				<button onclick={closeDepositModal} class="deposit-close-btn cursor-pointer">
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<path d="M18 6L6 18M6 6l12 12"/>
					</svg>
				</button>
			</div>

			<!-- Amount Summary -->
			<div class="deposit-amount-section">
				<div class="deposit-amount-row">
					<span class="text-gray-500 text-xs font-mono">{$t('mt.required')}</span>
					<span class="text-white text-sm font-mono font-bold">{Number(depositInfo.required).toLocaleString()} {depositInfo.symbol}</span>
				</div>
				<div class="deposit-amount-row">
					<span class="text-gray-500 text-xs font-mono">{$t('mt.yourBalance')}</span>
					<span class="text-gray-300 text-sm font-mono">{Number(depositInfo.userBalance).toLocaleString()} {depositInfo.symbol}</span>
				</div>
				<div class="deposit-divider"></div>
				<div class="deposit-amount-row">
					<span class="text-amber-400 text-xs font-mono font-bold">{$t('mt.amountToDeposit')}</span>
					<span class="text-amber-300 text-lg font-mono font-bold">{Number(depositInfo.deficit).toLocaleString()} {depositInfo.symbol}</span>
				</div>
			</div>

			<!-- QR Code -->
			<div class="deposit-qr-section">
				<div class="deposit-qr-frame">
					<img
						src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data={userAddress}&bgcolor=0d0d14&color=00d2ff"
						alt="Deposit address"
						class="deposit-qr-img"
					/>
				</div>
			</div>

			<!-- Address -->
			<div class="deposit-address-section">
				<label class="text-gray-500 text-[10px] font-mono uppercase tracking-wider">{$t('mt.depositAddress')}</label>
				<div class="deposit-address-row">
					<span class="text-cyan-400 text-xs font-mono break-all flex-1">{userAddress}</span>
					<button onclick={copyAddress} class="deposit-copy-btn cursor-pointer">
						{addressCopied ? $t('mt.copied') : $t('mt.copy')}
					</button>
				</div>
			</div>

			<!-- Warning -->
			<div class="deposit-warning">
				<svg class="flex-shrink-0 mt-0.5" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
					<line x1="12" y1="9" x2="12" y2="13"/>
					<line x1="12" y1="17" x2="12.01" y2="17"/>
				</svg>
				<span class="text-gray-400 text-[11px] font-mono">
					{$t('mt.depositWarning1')} <strong class="text-white">{depositInfo.symbol}</strong> {$t('mt.depositWarning2')} <strong class="text-white">{depositInfo.networkName}</strong>. {$t('mt.depositWarningEnd')}
				</span>
			</div>

			<!-- Footer -->
			<div class="deposit-footer">
				<div class="flex items-center gap-2">
					<div class="spinner-sm w-3.5 h-3.5 rounded-full border-2 border-white/10 border-t-cyan-400"></div>
					<span class="text-gray-500 text-[11px] font-mono">{$t('mt.monitoringDeposit')}</span>
				</div>
				<button onclick={closeDepositModal} class="btn-secondary text-xs px-4 py-2 cursor-pointer">{$t('common.cancel')}</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.spinner { animation: spin 0.8s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }

	.syne { font-family: 'Syne', sans-serif; }

	.token-avatar {
		width: 60px; height: 60px;
		border-radius: 16px;
		background: linear-gradient(135deg, rgba(0,210,255,0.2), rgba(99,102,241,0.2));
		border: 1px solid var(--border-input);
		display: flex; align-items: center; justify-content: center;
		font-size: 20px; font-weight: 800; color: var(--text-heading);
		flex-shrink: 0;
	}

	.contract-addr-bar {
		padding: 10px 14px;
		background: var(--bg-surface);
		border: 1px solid var(--bg-surface-hover);
		border-radius: 8px;
		overflow-x: auto;
		white-space: nowrap;
	}

	.stat-card {
		background: var(--bg-surface);
		border: 1px solid var(--border);
		border-radius: 12px;
	}
	.stat-label { font-size: 11px; color: #6b7280; font-family: 'Space Mono', monospace; text-transform: uppercase; letter-spacing: 0.05em; }
	.stat-value { font-size: 18px; font-weight: 800; color: var(--text-heading); margin: 4px 0 2px; }
	.stat-unit { font-size: 11px; color: var(--text-dim); font-family: 'Space Mono', monospace; }

	.tabs-bar {
		border-bottom: 1px solid var(--bg-surface-hover);
		padding-bottom: 0;
	}

	.tab-btn {
		display: flex; align-items: center; gap: 6px;
		padding: 8px 16px;
		border-radius: 8px 8px 0 0;
		font-size: 13px;
		color: #6b7280;
		background: transparent;
		border: none;
		border-bottom: 2px solid transparent;
		transition: all 0.15s;
		white-space: nowrap;
		margin-bottom: -1px;
	}
	.tab-btn:hover { color: var(--text); }
	.tab-btn.active {
		color: #00d2ff;
		border-bottom-color: #00d2ff;
		background: rgba(0,210,255,0.05);
	}

	.panel {
		background: var(--bg-surface);
		border: 1px solid var(--border);
		border-radius: 16px;
		padding: 24px;
	}

	.sub-panel {
		background: var(--bg-surface);
		border: 1px solid var(--bg-surface-hover);
		border-radius: 12px;
		padding: 16px;
	}

	.panel-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		margin-bottom: 20px;
		gap: 12px;
		flex-wrap: wrap;
	}

	.form-fields { display: flex; flex-direction: column; gap: 16px; }

	.field-group { display: flex; flex-direction: column; gap: 6px; }

	.input-with-badge { position: relative; }
	.input-with-badge .input-field { padding-right: 72px; }
	.input-badge {
		position: absolute;
		right: 12px;
		top: 50%;
		transform: translateY(-50%);
		font-size: 11px;
		font-family: 'Space Mono', monospace;
		color: #6b7280;
		background: var(--bg-surface-hover);
		padding: 2px 8px;
		border-radius: 4px;
	}

	.field-hint { font-size: 11px; color: var(--text-dim); font-family: 'Space Mono', monospace; }
	.field-hint-btn {
		font-size: 11px;
		color: #00d2ff;
		background: none;
		border: none;
		padding: 0;
		text-decoration: underline;
		opacity: 0.7;
		transition: opacity 0.15s;
		align-self: flex-start;
	}
	.field-hint-btn:hover { opacity: 1; }

	.info-table { display: flex; flex-direction: column; gap: 0; }
	.info-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 10px 0;
		border-bottom: 1px solid var(--bg-surface-hover);
		gap: 12px;
	}
	.info-row:last-child { border-bottom: none; }
	.info-key { font-size: 12px; color: #6b7280; font-family: 'Space Mono', monospace; flex-shrink: 0; }
	.info-val { font-size: 13px; color: var(--text); text-align: right; word-break: break-all; }

	.owner-warning {
		display: flex; align-items: center;
		gap: 8px;
		padding: 10px 14px;
		background: rgba(245,158,11,0.06);
		border: 1px solid rgba(245,158,11,0.15);
		border-radius: 8px;
		margin-bottom: 4px;
	}

	.burn-warning {
		display: flex; align-items: flex-start; gap: 8px;
		padding: 10px 14px;
		background: rgba(239,68,68,0.05);
		border: 1px solid rgba(239,68,68,0.15);
		border-radius: 8px;
	}

	.mode-toggle {
		display: flex;
		gap: 0;
		border: 1px solid var(--border-input);
		border-radius: 10px;
		overflow: hidden;
	}
	.mode-btn {
		flex: 1;
		padding: 10px 16px;
		font-size: 13px;
		font-family: 'Space Mono', monospace;
		color: #6b7280;
		background: transparent;
		border: none;
		transition: all 0.15s;
	}
	.mode-btn.active {
		color: #00d2ff;
		background: rgba(0,210,255,0.08);
	}
	.mode-btn:hover:not(.active) { color: var(--text); background: var(--bg-surface); }

	.calc-result {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 12px 14px;
		background: rgba(0,210,255,0.05);
		border: 1px solid rgba(0,210,255,0.15);
		border-radius: 8px;
	}

	.pool-row {
		padding: 10px 12px;
		background: var(--bg-surface);
		border: 1px solid var(--bg-surface-hover);
		border-radius: 8px;
	}

	.pool-card {
		border: 1px solid var(--border);
		border-radius: 12px;
		overflow: hidden;
		transition: border-color 0.2s;
	}
	.pool-card:hover {
		border-color: rgba(139,92,246,0.25);
	}

	.pool-card-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		width: 100%;
		padding: 14px 16px;
		background: var(--bg-surface);
		border: none;
		color: inherit;
		gap: 12px;
	}
	.pool-card-header:hover {
		background: var(--bg-surface-hover);
	}

	.pool-pair-badge {
		font-size: 11px;
		font-weight: 700;
		padding: 4px 10px;
		border-radius: 6px;
		background: rgba(139,92,246,0.15);
		color: #a78bfa;
		white-space: nowrap;
	}

	.pool-expand-icon {
		color: #6b7280;
		font-size: 14px;
		transition: transform 0.2s;
	}
	.pool-expand-icon.expanded {
		transform: rotate(180deg);
	}

	.pool-card-body {
		display: flex;
		flex-direction: column;
		gap: 14px;
		padding: 16px;
		border-top: 1px solid var(--bg-surface-hover);
		background: var(--bg-surface);
	}

	.empty-pool-hint {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 10px 14px;
		background: rgba(245,158,11,0.06);
		border: 1px solid rgba(245,158,11,0.15);
		border-radius: 8px;
	}

	.liq-pct-bar {
		padding: 10px 0;
	}
	.pct-track {
		height: 4px;
		background: var(--bg-surface-hover);
		border-radius: 999px;
		overflow: hidden;
	}
	.pct-fill {
		height: 100%;
		background: linear-gradient(90deg, #10b981, #00d2ff);
		border-radius: 999px;
		transition: width 0.3s;
	}

	.liq-info-box {
		padding: 14px;
		background: rgba(139,92,246,0.05);
		border: 1px solid rgba(139,92,246,0.15);
		border-radius: 10px;
		display: flex; flex-direction: column; gap: 8px;
	}
	.liq-info-row { display: flex; justify-content: space-between; align-items: center; }

	.action-btn {
		padding: 14px;
		width: 100%;
		font-weight: 700;
		font-size: 14px;
		border: none;
		border-radius: 12px;
		transition: all 0.2s;
		margin-top: 4px;
	}
	.action-btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none !important; }

	.mint-btn {
		background: linear-gradient(135deg, #00d2ff, #3a7bd5);
		color: white;
	}
	.mint-btn:hover:not(:disabled) {
		transform: translateY(-1px);
		box-shadow: 0 8px 28px rgba(0,210,255,0.3);
	}

	.burn-btn {
		background: linear-gradient(135deg, #ef4444, #b91c1c);
		color: white;
	}
	.burn-btn:hover:not(:disabled) {
		transform: translateY(-1px);
		box-shadow: 0 8px 28px rgba(239,68,68,0.3);
	}

	.tax-btn {
		background: linear-gradient(135deg, #f59e0b, #d97706);
		color: white;
	}
	.tax-btn:hover:not(:disabled) {
		transform: translateY(-1px);
		box-shadow: 0 8px 28px rgba(245,158,11,0.3);
	}

	.liq-btn {
		background: linear-gradient(135deg, #8b5cf6, #6d28d9);
		color: white;
	}
	.liq-btn:hover:not(:disabled) {
		transform: translateY(-1px);
		box-shadow: 0 8px 28px rgba(139,92,246,0.3);
	}

	.badge { display: inline-flex; align-items: center; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
	.badge-cyan { background: rgba(0,210,255,0.1); color: #00d2ff; border: 1px solid rgba(0,210,255,0.2); }
	.badge-amber { background: rgba(245,158,11,0.1); color: #f59e0b; border: 1px solid rgba(245,158,11,0.2); }
	.badge-emerald { background: rgba(16,185,129,0.1); color: #10b981; border: 1px solid rgba(16,185,129,0.2); }
	.badge-purple { background: rgba(139,92,246,0.1); color: #8b5cf6; border: 1px solid rgba(139,92,246,0.2); }

	.label-text { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #94a3b8; display: block; margin-bottom: 6px; }

	.no-underline { text-decoration: none; }
	a.no-underline { text-decoration: none; }

	select option { background: var(--select-bg); }

	.input-field {
		width: 100%;
		background: var(--bg-surface-hover);
		border: 1px solid var(--border-input);
		border-radius: 10px;
		padding: 12px 16px;
		color: var(--text);
		font-family: 'Space Mono', monospace;
		font-size: 14px;
		transition: all 0.2s;
		outline: none;
	}
	.input-field:focus {
		border-color: rgba(0,210,255,0.5);
		box-shadow: 0 0 0 3px rgba(0,210,255,0.08);
	}
	.input-field:disabled { opacity: 0.4; cursor: not-allowed; }
	.input-field::placeholder { color: var(--placeholder); }

	.protection-notice {
		padding: 12px 14px;
		background: rgba(0,210,255,0.05);
		border: 1px solid rgba(0,210,255,0.15);
		border-radius: 10px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.protection-notice.relax-only {
		background: rgba(16,185,129,0.05);
		border-color: rgba(16,185,129,0.15);
	}

	.protection-stat-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 6px 0;
		border-bottom: 1px solid var(--bg-surface);
	}
	.protection-stat-row:last-child { border-bottom: none; }

	.trading-enable-box {
		background: rgba(245,158,11,0.05);
		border-color: rgba(245,158,11,0.2);
	}

	/* Deposit Modal */
	.deposit-modal {
		animation: modalSlideIn 0.25s ease-out;
	}
	@keyframes modalSlideIn {
		from { opacity: 0; transform: scale(0.95) translateY(10px); }
		to { opacity: 1; transform: scale(1) translateY(0); }
	}

	.deposit-modal-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 20px 24px;
		border-bottom: 1px solid var(--bg-surface-hover);
	}

	.deposit-icon-circle {
		width: 40px;
		height: 40px;
		border-radius: 12px;
		background: rgba(245,158,11,0.15);
		color: #f59e0b;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}

	.deposit-close-btn {
		width: 32px;
		height: 32px;
		border-radius: 8px;
		border: none;
		background: var(--bg-surface-hover);
		color: #6b7280;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.15s;
	}
	.deposit-close-btn:hover {
		background: var(--border-input);
		color: var(--text-heading);
	}

	.deposit-amount-section {
		padding: 20px 24px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.deposit-amount-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.deposit-divider {
		border: none;
		border-top: 1px dashed var(--border);
		margin: 4px 0;
	}

	.deposit-qr-section {
		display: flex;
		justify-content: center;
		padding: 0 24px 20px;
	}

	.deposit-qr-frame {
		padding: 12px;
		background: var(--bg-surface);
		border: 1px solid var(--border);
		border-radius: 16px;
	}

	.deposit-qr-img {
		width: 180px;
		height: 180px;
		border-radius: 8px;
	}

	.deposit-address-section {
		padding: 0 24px 16px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.deposit-address-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 12px;
		background: var(--bg-surface);
		border: 1px solid var(--border);
		border-radius: 10px;
	}

	.deposit-copy-btn {
		padding: 4px 12px;
		border-radius: 6px;
		border: 1px solid rgba(0,210,255,0.3);
		background: rgba(0,210,255,0.08);
		color: #00d2ff;
		font-size: 11px;
		font-family: 'Space Mono', monospace;
		font-weight: 600;
		transition: all 0.15s;
		white-space: nowrap;
		flex-shrink: 0;
	}
	.deposit-copy-btn:hover {
		background: rgba(0,210,255,0.15);
		border-color: rgba(0,210,255,0.5);
	}

	.deposit-warning {
		display: flex;
		gap: 8px;
		margin: 0 24px 16px;
		padding: 10px 14px;
		background: rgba(245,158,11,0.06);
		border: 1px solid rgba(245,158,11,0.15);
		border-radius: 10px;
		color: #f59e0b;
	}

	.deposit-footer {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 16px 24px;
		border-top: 1px solid var(--bg-surface-hover);
		background: var(--bg-surface);
	}

	.spinner-sm { animation: spin 0.8s linear infinite; }

	/* Launchpad section */
	.launchpad-status {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 14px 16px;
		border-radius: 10px;
		background: var(--bg-surface-input);
		border: 1px solid var(--border);
	}
	.launchpad-exists {
		border-color: rgba(16, 185, 129, 0.2);
		background: rgba(16, 185, 129, 0.04);
	}
	.launchpad-create {
		border-style: dashed;
		border-color: rgba(0, 210, 255, 0.2);
	}
	.nav-cta {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		background: linear-gradient(135deg, #00d2ff, #3a7bd5);
		color: white;
		font-weight: 600;
		padding: 6px 14px;
		border-radius: 8px;
		border: none;
		cursor: pointer;
		transition: all 0.2s;
		font-family: 'Syne', sans-serif;
		font-size: 13px;
	}
	.nav-cta:hover {
		transform: translateY(-1px);
		box-shadow: 0 4px 16px rgba(0, 210, 255, 0.3);
	}
</style>
