<script lang="ts">
	import { page } from '$app/state';
	import type { SupportedNetworks, SupportedNetwork, PaymentOption } from '$lib/structure';
	import { ethers } from 'ethers';
	import { getContext, onMount, onDestroy } from 'svelte';
	import { TOKEN_ABI, ROUTER_ABI, FACTORY_V2_ABI, PAIR_ABI, ERC20_ABI, FACTORY_ABI, ZERO_ADDRESS } from '$lib/tokenCrafter';

	const supportedNetworks: SupportedNetworks = getContext('supportedNetworks');
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
	};

	let tokenInfo: ExtendedTokenInfo | null = $state(null);
	let error: 'unsupported_network' | 'contract_error' | 'contract_not_found' | null = $state(null);
	let isLoading = $state(true);
	let network: SupportedNetwork | null = $state(null);
	let contractAddress = $state('');
	let activeTab = $state<'overview' | 'mint' | 'burn' | 'tax' | 'pools' | 'liquidity'>('overview');
	let isOwner = $state(false);

	// Form states
	let mintAmount = $state('');
	let mintTo = $state('');
	let burnAmount = $state('');
	let buyTaxBpsInput = $state('');
	let sellTaxBpsInput = $state('');
	let transferTaxBpsInput = $state('');
	let actionLoading = $state(false);

	// Tax distribution
	let taxWallets: { address: string; shareBps: string }[] = $state([]);
	let taxExemptAddr = $state('');
	let taxExemptValue = $state(true);

	// Pool management
	let poolAddressInput = $state('');
	let poolCheckAddr = $state('');
	let poolCheckResult: boolean | null = $state(null);

	// Liquidity states
	let liqBaseCoin = $state<'native' | 'usdt' | 'usdc'>('native');
	let liqTokenAmount = $state('');
	let liqBaseAmount = $state('');
	let selectedRouter = $state('');
	let liqMode = $state<'manual' | 'price'>('manual');

	// Price-based liquidity
	let pricePerToken = $state('');
	let listBaseAmount = $state('');
	let calculatedTokenAmount = $derived(() => {
		if (!pricePerToken || !listBaseAmount || Number(pricePerToken) <= 0) return '';
		return (Number(listBaseAmount) / Number(pricePerToken)).toFixed(6);
	});

	// Existing pool lookup
	let existingPools: { baseSymbol: string; pairAddress: string; reserve0: string; reserve1: string; token0: string }[] = $state([]);
	let poolsLoading = $state(false);

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

	let selectedBase = $derived(getBaseCoinOptions().find((b) => b.key === liqBaseCoin) ?? getBaseCoinOptions()[0]);

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
				const info = await factory.getTokenInfo(contract_addr);
				isMintable = info.isMintable;
				isTaxable = info.isTaxable;
				isPartner = info.isPartnership;
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

			tokenInfo = {
				name, symbol,
				decimals: ethers.toNumber(decimals),
				totalSupply: ethers.formatUnits(totalSupply, ethers.toNumber(decimals)),
				owner, isMintable, isTaxable, isPartner, buyTaxBps, sellTaxBps, transferTaxBps, userBalance
			};

			isOwner = !!(owner && userAddress && owner.toLowerCase() === userAddress.toLowerCase());
			buyTaxBpsInput = String(buyTaxBps ?? 0);
			sellTaxBpsInput = String(sellTaxBps ?? 0);
			transferTaxBpsInput = String(transferTaxBps ?? 0);
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
				Number(buyTaxBpsInput),
				Number(sellTaxBpsInput),
				Number(transferTaxBpsInput)
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
			const results: typeof existingPools = [];

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
						results.push({
							baseSymbol: base.symbol,
							pairAddress: pair,
							reserve0: ethers.formatUnits(reserves[0], token0.toLowerCase() === contractAddress.toLowerCase() ? tokenInfo?.decimals ?? 18 : base.decimals),
							reserve1: ethers.formatUnits(reserves[1], token0.toLowerCase() === contractAddress.toLowerCase() ? base.decimals : tokenInfo?.decimals ?? 18),
							token0: token0
						});
					}
				} catch {}
			}
			existingPools = results;
			if (results.length === 0) {
				addFeedback({ message: 'No existing liquidity pools found.', type: 'info' });
			}
		} catch (e: any) {
			addFeedback({ message: 'Failed to lookup pools: ' + (e.shortMessage || e.message), type: 'error' });
		} finally { poolsLoading = false; }
	}

	async function doAddLiquidity() {
		const s = await ensureSigner();
		if (!s || !network || !selectedRouter) return;
		actionLoading = true;

		const tokenAmount = liqMode === 'price' ? calculatedTokenAmount() : liqTokenAmount;
		const baseAmount = liqMode === 'price' ? listBaseAmount : liqBaseAmount;

		if (!tokenAmount || !baseAmount) {
			addFeedback({ message: 'Please fill in all amounts.', type: 'error' });
			actionLoading = false;
			return;
		}

		try {
			const tokenContract = new ethers.Contract(contractAddress, TOKEN_ABI, s);
			const parsedTokenAmount = ethers.parseUnits(String(Number(tokenAmount)), tokenInfo?.decimals ?? 18);

			// Approve router for token
			const allowance = await tokenContract.allowance(userAddress, selectedRouter);
			if (allowance < parsedTokenAmount) {
				addFeedback({ message: 'Approving tokens for router...', type: 'info' });
				const approveTx = await tokenContract.approve(selectedRouter, parsedTokenAmount);
				await approveTx.wait();
			}

			const router = new ethers.Contract(selectedRouter, ROUTER_ABI, s);
			const deadline = Math.floor(Date.now() / 1000) + 1200;

			if (liqBaseCoin === 'native') {
				// addLiquidityETH
				const ethAmount = ethers.parseEther(String(Number(baseAmount)));
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
				// addLiquidity with ERC20 base
				const baseInfo = selectedBase;
				const parsedBaseAmount = ethers.parseUnits(String(Number(baseAmount)), baseInfo.decimals);

				// Approve base token
				const baseContract = new ethers.Contract(baseInfo.address, ERC20_ABI, s);
				const baseAllowance = await baseContract.allowance(userAddress, selectedRouter);
				if (baseAllowance < parsedBaseAmount) {
					addFeedback({ message: `Approving ${baseInfo.symbol}...`, type: 'info' });
					const approveTx = await baseContract.approve(selectedRouter, parsedBaseAmount);
					await approveTx.wait();
				}

				addFeedback({ message: 'Adding liquidity...', type: 'info' });
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

			addFeedback({ message: 'Liquidity added successfully!', type: 'success' });
			liqTokenAmount = '';
			liqBaseAmount = '';
			pricePerToken = '';
			listBaseAmount = '';
		} catch (e: any) {
			addFeedback({ message: e.shortMessage || e.message || 'Liquidity failed', type: 'error' });
		} finally { actionLoading = false; }
	}

	function shortAddr(addr: string) {
		return addr.slice(0, 8) + '...' + addr.slice(-6);
	}

	const tabs = [
		{ id: 'overview', label: 'Overview', icon: 'O' },
		{ id: 'mint', label: 'Mint', icon: '+', requires: 'mintable' as const },
		{ id: 'burn', label: 'Burn', icon: 'x', requires: 'mintable' as const },
		{ id: 'tax', label: 'Tax', icon: '%', requires: 'taxable' as const },
		{ id: 'pools', label: 'Pools', icon: '@', requires: 'pools' as const },
		{ id: 'liquidity', label: 'Liquidity', icon: '~' }
	];

	function isTabVisible(tab: (typeof tabs)[0]) {
		if (tab.requires === 'mintable' && tokenInfo?.isMintable === false) return false;
		if (tab.requires === 'taxable' && tokenInfo?.isTaxable === false) return false;
		if (tab.requires === 'pools' && !tokenInfo?.isTaxable && !tokenInfo?.isPartner) return false;
		return true;
	}
</script>

<div class="page-container max-w-6xl mx-auto px-4 sm:px-6 py-10">
	{#if isLoading}
		<div class="flex items-center justify-center min-h-[50vh]">
			<div class="flex flex-col items-center gap-4">
				<div class="spinner w-12 h-12 rounded-full border-2 border-white/10 border-t-cyan-400"></div>
				<p class="text-gray-500 text-sm font-mono">Loading token...</p>
			</div>
		</div>
	{:else if error}
		<div class="error-state text-center py-20">
			<div class="text-5xl mb-4">!</div>
			<h2 class="syne text-2xl font-bold text-white mb-2">
				{error === 'unsupported_network'
					? 'Unsupported Network'
					: error === 'contract_not_found'
						? 'Contract Not Found'
						: 'Contract Error'}
			</h2>
			<p class="text-gray-400 font-mono text-sm mb-6">
				{error === 'unsupported_network'
					? 'This network is not supported. Check the URL.'
					: error === 'contract_not_found'
						? 'No contract address provided.'
						: 'Could not load contract. Verify address and network.'}
			</p>
			<a href="/manage-tokens" class="btn-secondary text-sm px-5 py-2.5 no-underline">&lt;- Back</a>
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
								<span class="badge badge-cyan">Mintable</span>
							{/if}
							{#if tokenInfo.isTaxable}
								<span class="badge badge-amber">Taxable</span>
							{/if}
							{#if tokenInfo.isPartner}
								<span class="badge badge-purple">Partner</span>
							{/if}
							{#if isOwner}
								<span class="badge badge-emerald">Owner</span>
							{/if}
						</div>
					</div>
				</div>
				<a href="/manage-tokens" class="btn-secondary text-xs px-3 py-2 no-underline">&lt;- Back</a>
			</div>

			<div class="contract-addr-bar mt-4 font-mono">
				<span class="text-gray-500 text-xs">Contract:</span>
				<span class="text-cyan-400 text-xs ml-2">{contractAddress}</span>
			</div>
		</div>

		<!-- Stats Row -->
		<div class="stats-row mb-8 grid grid-cols-2 sm:grid-cols-4 gap-3">
			<div class="stat-card card p-4">
				<div class="stat-label">Total Supply</div>
				<div class="stat-value syne">{Number(tokenInfo.totalSupply).toLocaleString()}</div>
				<div class="stat-unit">{tokenInfo.symbol}</div>
			</div>
			<div class="stat-card card p-4">
				<div class="stat-label">Decimals</div>
				<div class="stat-value syne">{tokenInfo.decimals}</div>
				<div class="stat-unit">precision</div>
			</div>
			{#if tokenInfo.userBalance !== undefined}
				<div class="stat-card card p-4">
					<div class="stat-label">Your Balance</div>
					<div class="stat-value syne">{Number(tokenInfo.userBalance).toLocaleString()}</div>
					<div class="stat-unit">{tokenInfo.symbol}</div>
				</div>
			{/if}
			{#if tokenInfo.isTaxable && tokenInfo.buyTaxBps !== undefined}
				<div class="stat-card card p-4">
					<div class="stat-label">Buy/Sell/Transfer Tax</div>
					<div class="stat-value syne">{(tokenInfo.buyTaxBps / 100).toFixed(1)}% / {((tokenInfo.sellTaxBps ?? 0) / 100).toFixed(1)}% / {((tokenInfo.transferTaxBps ?? 0) / 100).toFixed(1)}%</div>
					<div class="stat-unit">basis points</div>
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
					<span>{tab.label}</span>
				</button>
			{/each}
		</div>

		<!-- Tab Content -->
		<div class="tab-content">

			<!-- OVERVIEW TAB -->
			{#if activeTab === 'overview'}
				<div class="panel">
					<h3 class="syne text-lg font-bold text-white mb-4">Token Information</h3>
					<div class="info-table">
						{#each [
							['Name', tokenInfo.name],
							['Symbol', tokenInfo.symbol],
							['Total Supply', Number(tokenInfo.totalSupply).toLocaleString() + ' ' + tokenInfo.symbol],
							['Decimals', String(tokenInfo.decimals)],
							['Network', network?.name ?? 'Unknown'],
							['Mintable', tokenInfo.isMintable !== undefined ? (tokenInfo.isMintable ? 'Yes' : 'No') : 'N/A'],
							['Taxable', tokenInfo.isTaxable !== undefined ? (tokenInfo.isTaxable ? 'Yes' : 'No') : 'N/A'],
							['Partner', tokenInfo.isPartner !== undefined ? (tokenInfo.isPartner ? 'Yes' : 'No') : 'N/A'],
							...(tokenInfo.owner ? [['Owner', shortAddr(tokenInfo.owner)]] : [])
						] as [label, value]}
							<div class="info-row">
								<span class="info-key">{label}</span>
								<span class="info-val font-mono">{value}</span>
							</div>
						{/each}
					</div>
				</div>
			{/if}

			<!-- MINT TAB -->
			{#if activeTab === 'mint'}
				<div class="panel">
					<div class="panel-header">
						<div>
							<h3 class="syne text-lg font-bold text-white">Mint Tokens</h3>
							<p class="text-sm text-gray-500 font-mono mt-1">Create new tokens and send to an address.</p>
						</div>
						<span class="badge badge-cyan">Owner Only</span>
					</div>

					{#if !isOwner}
						<div class="owner-warning">
							<span class="text-amber-400">!</span>
							<span class="text-amber-300 text-sm font-mono">Only the token owner can mint tokens.</span>
						</div>
					{/if}

					<div class="form-fields">
						<div class="field-group">
							<label class="label-text" for="mint-amount">Amount to Mint</label>
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
							<label class="label-text" for="mint-to">Recipient Address</label>
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
								>Use my wallet</button>
							{/if}
						</div>
						<button
							onclick={doMint}
							disabled={!isOwner || actionLoading || !mintAmount}
							class="action-btn mint-btn syne cursor-pointer"
						>
							{actionLoading ? 'Minting...' : 'Mint Tokens'}
						</button>
					</div>
				</div>
			{/if}

			<!-- BURN TAB -->
			{#if activeTab === 'burn'}
				<div class="panel">
					<div class="panel-header">
						<div>
							<h3 class="syne text-lg font-bold text-white">Burn Tokens</h3>
							<p class="text-sm text-gray-500 font-mono mt-1">Permanently destroy tokens from your wallet.</p>
						</div>
						<span class="badge badge-amber">Irreversible</span>
					</div>

					<div class="form-fields">
						<div class="field-group">
							<label class="label-text" for="burn-amount">Amount to Burn</label>
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
								<span class="field-hint font-mono">Balance: {Number(tokenInfo.userBalance).toLocaleString()} {tokenInfo.symbol}</span>
							{/if}
						</div>

						<div class="burn-warning">
							<span class="text-red-400">!</span>
							<span class="text-red-300 text-sm font-mono">Burned tokens are permanently removed from supply. This cannot be undone.</span>
						</div>

						<button
							onclick={doBurn}
							disabled={actionLoading || !burnAmount}
							class="action-btn burn-btn syne cursor-pointer"
						>
							{actionLoading ? 'Burning...' : 'Burn Tokens'}
						</button>
					</div>
				</div>
			{/if}

			<!-- TAX TAB -->
			{#if activeTab === 'tax'}
				<div class="panel">
					<div class="panel-header">
						<div>
							<h3 class="syne text-lg font-bold text-white">Tax Settings</h3>
							<p class="text-sm text-gray-500 font-mono mt-1">Configure buy/sell/transfer tax rates and distribution.</p>
						</div>
						<span class="badge badge-cyan">Owner Only</span>
					</div>

					{#if !isOwner}
						<div class="owner-warning">
							<span class="text-amber-400">!</span>
							<span class="text-amber-300 text-sm font-mono">Only the token owner can modify tax settings.</span>
						</div>
					{/if}

					<div class="form-fields">
						<!-- Tax Rates -->
						<div class="sub-panel">
							<h4 class="syne text-sm font-bold text-white mb-3">Tax Rates (basis points, 100 = 1%)</h4>
							<div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
								<div class="field-group">
									<label class="label-text" for="buy-tax">Buy Tax (bps)</label>
									<div class="input-with-badge">
										<input
											id="buy-tax"
											class="input-field"
											type="number"
											min="0"
											max="2500"
											bind:value={buyTaxBpsInput}
											placeholder="0"
											disabled={!isOwner}
										/>
										<span class="input-badge">bps</span>
									</div>
									{#if tokenInfo.buyTaxBps !== undefined}
										<span class="field-hint font-mono">Current: {tokenInfo.buyTaxBps} bps ({(tokenInfo.buyTaxBps / 100).toFixed(1)}%)</span>
									{/if}
								</div>
								<div class="field-group">
									<label class="label-text" for="sell-tax">Sell Tax (bps)</label>
									<div class="input-with-badge">
										<input
											id="sell-tax"
											class="input-field"
											type="number"
											min="0"
											max="2500"
											bind:value={sellTaxBpsInput}
											placeholder="0"
											disabled={!isOwner}
										/>
										<span class="input-badge">bps</span>
									</div>
									{#if tokenInfo.sellTaxBps !== undefined}
										<span class="field-hint font-mono">Current: {tokenInfo.sellTaxBps} bps ({(tokenInfo.sellTaxBps / 100).toFixed(1)}%)</span>
									{/if}
								</div>
								<div class="field-group">
									<label class="label-text" for="transfer-tax">Transfer Tax (bps)</label>
									<div class="input-with-badge">
										<input
											id="transfer-tax"
											class="input-field"
											type="number"
											min="0"
											max="2500"
											bind:value={transferTaxBpsInput}
											placeholder="0"
											disabled={!isOwner}
										/>
										<span class="input-badge">bps</span>
									</div>
									{#if tokenInfo.transferTaxBps !== undefined}
										<span class="field-hint font-mono">Current: {tokenInfo.transferTaxBps} bps</span>
									{/if}
								</div>
							</div>
							<div class="text-xs text-gray-500 font-mono mt-2">Combined buy + sell + transfer tax must be &lt;= 2500 bps (25%)</div>
							<button
								onclick={doSetTaxes}
								disabled={!isOwner || actionLoading}
								class="action-btn tax-btn syne cursor-pointer mt-3"
							>
								{actionLoading ? 'Saving...' : 'Update Tax Rates'}
							</button>
						</div>

						<!-- Tax Distribution -->
						<div class="sub-panel">
							<h4 class="syne text-sm font-bold text-white mb-3">Tax Distribution (up to 10 wallets)</h4>
							<div class="flex flex-col gap-3">
								{#each taxWallets as wallet, i}
									<div class="flex gap-2 items-end">
										<div class="field-group flex-1">
											<label class="label-text" for="tw-addr-{i}">Wallet Address</label>
											<input
												id="tw-addr-{i}"
												class="input-field"
												bind:value={wallet.address}
												placeholder="0x..."
												disabled={!isOwner}
											/>
										</div>
										<div class="field-group" style="width: 120px;">
											<label class="label-text" for="tw-share-{i}">Share (bps)</label>
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
									>+ Add Wallet</button>
								{/if}
							</div>
							{#if taxWallets.length > 0}
								<button
									onclick={doSetTaxDistribution}
									disabled={!isOwner || actionLoading || taxWallets.length === 0}
									class="action-btn tax-btn syne cursor-pointer mt-3"
								>
									{actionLoading ? 'Saving...' : 'Save Tax Distribution'}
								</button>
							{/if}
						</div>

						<!-- Tax Exemption -->
						<div class="sub-panel">
							<h4 class="syne text-sm font-bold text-white mb-3">Tax Exemption</h4>
							<div class="flex gap-2 items-end flex-wrap">
								<div class="field-group flex-1" style="min-width: 200px;">
									<label class="label-text" for="exempt-addr">Address</label>
									<input
										id="exempt-addr"
										class="input-field"
										bind:value={taxExemptAddr}
										placeholder="0x..."
										disabled={!isOwner}
									/>
								</div>
								<div class="field-group" style="width: 120px;">
									<label class="label-text" for="exempt-val">Exempt?</label>
									<select id="exempt-val" class="input-field" bind:value={taxExemptValue} disabled={!isOwner}>
										<option value={true}>Yes</option>
										<option value={false}>No</option>
									</select>
								</div>
								<button
									onclick={doExcludeFromTax}
									disabled={!isOwner || actionLoading || !taxExemptAddr}
									class="action-btn tax-btn syne cursor-pointer"
									style="max-width: 180px;"
								>
									{actionLoading ? 'Saving...' : 'Update'}
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
							<h3 class="syne text-lg font-bold text-white">Pool Management</h3>
							<p class="text-sm text-gray-500 font-mono mt-1">Add or remove DEX pool addresses. Pools are used to identify buy/sell transactions for tax and partner fee logic.</p>
						</div>
						<span class="badge badge-cyan">Owner Only</span>
					</div>

					{#if !isOwner}
						<div class="owner-warning">
							<span class="text-amber-400">!</span>
							<span class="text-amber-300 text-sm font-mono">Only the token owner can manage pools.</span>
						</div>
					{/if}

					<div class="form-fields">
						<!-- Add / Remove Pool -->
						<div class="sub-panel">
							<h4 class="syne text-sm font-bold text-white mb-3">Add / Remove Pool</h4>
							<div class="field-group">
								<label class="label-text" for="pool-addr">Pool Address</label>
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
									{actionLoading ? 'Processing...' : 'Add Pool'}
								</button>
								<button
									onclick={doRemovePool}
									disabled={!isOwner || actionLoading || !poolAddressInput}
									class="action-btn burn-btn syne cursor-pointer"
									style="flex:1;"
								>
									{actionLoading ? 'Processing...' : 'Remove Pool'}
								</button>
							</div>
						</div>

						<!-- Check Pool Status -->
						<div class="sub-panel">
							<h4 class="syne text-sm font-bold text-white mb-3">Check Pool Status</h4>
							<div class="flex gap-2 items-end flex-wrap">
								<div class="field-group flex-1" style="min-width: 200px;">
									<label class="label-text" for="pool-check-addr">Address to Check</label>
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
								>Check</button>
							</div>
							{#if poolCheckResult !== null}
								<div class="mt-3 px-3 py-2 rounded-lg {poolCheckResult ? 'bg-emerald-500/10 border border-emerald-500/20' : 'bg-red-500/10 border border-red-500/20'}">
									<span class="text-sm font-mono {poolCheckResult ? 'text-emerald-400' : 'text-red-400'}">
										{poolCheckResult ? 'This address is a registered pool' : 'This address is not a registered pool'}
									</span>
								</div>
							{/if}
						</div>
					</div>
				</div>
			{/if}

			<!-- LIQUIDITY TAB -->
			{#if activeTab === 'liquidity'}
				<div class="panel">
					<div class="panel-header">
						<div>
							<h3 class="syne text-lg font-bold text-white">Add Liquidity</h3>
							<p class="text-sm text-gray-500 font-mono mt-1">
								Add your token to a DEX liquidity pool.
							</p>
						</div>
						<span class="badge badge-purple">DEX</span>
					</div>

					<div class="form-fields">
						<!-- Router Selection -->
						<div class="field-group">
							<label class="label-text" for="dex-router">DEX Router</label>
							<select id="dex-router" class="input-field" bind:value={selectedRouter}>
								{#each DEX_ROUTERS[network?.chain_id ?? 1] ?? [] as r}
									<option value={r.address}>{r.name}</option>
								{/each}
							</select>
						</div>

						<!-- Base Coin Selection -->
						<div class="field-group">
							<label class="label-text" for="base-coin">Base Coin</label>
							<select id="base-coin" class="input-field" bind:value={liqBaseCoin}>
								{#each getBaseCoinOptions() as opt}
									<option value={opt.key}>{opt.symbol}</option>
								{/each}
							</select>
						</div>

						<!-- Existing Pool Lookup -->
						<div class="sub-panel">
							<div class="flex items-center justify-between mb-3">
								<h4 class="syne text-sm font-bold text-white">Existing Pools</h4>
								<button
									onclick={lookupExistingPools}
									disabled={poolsLoading}
									class="btn-secondary text-xs px-3 py-1.5 cursor-pointer"
								>
									{poolsLoading ? 'Loading...' : 'Lookup Pools'}
								</button>
							</div>
							{#if existingPools.length > 0}
								<div class="flex flex-col gap-2">
									{#each existingPools as pool}
										<div class="pool-row">
											<div class="flex justify-between items-center">
												<span class="text-white text-sm font-mono">{tokenInfo.symbol}/{pool.baseSymbol}</span>
												<span class="text-gray-500 text-xs font-mono">{shortAddr(pool.pairAddress)}</span>
											</div>
											<div class="flex justify-between text-xs font-mono mt-1">
												<span class="text-gray-400">Reserve 0: {Number(pool.reserve0).toLocaleString()}</span>
												<span class="text-gray-400">Reserve 1: {Number(pool.reserve1).toLocaleString()}</span>
											</div>
										</div>
									{/each}
								</div>
							{:else if !poolsLoading}
								<p class="text-gray-600 text-xs font-mono">Click "Lookup Pools" to check for existing pools.</p>
							{/if}
						</div>

						<!-- Mode Toggle -->
						<div class="mode-toggle">
							<button
								onclick={() => (liqMode = 'manual')}
								class="mode-btn {liqMode === 'manual' ? 'active' : ''} cursor-pointer"
							>Manual Amounts</button>
							<button
								onclick={() => (liqMode = 'price')}
								class="mode-btn {liqMode === 'price' ? 'active' : ''} cursor-pointer"
							>Price-Based</button>
						</div>

						{#if liqMode === 'manual'}
							<!-- Manual: enter token and base amounts directly -->
							<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
								<div class="field-group">
									<label class="label-text" for="liq-token">Token Amount</label>
									<div class="input-with-badge">
										<input
											id="liq-token"
											class="input-field"
											type="number"
											min="0"
											bind:value={liqTokenAmount}
											placeholder="100000"
										/>
										<span class="input-badge">{tokenInfo.symbol}</span>
									</div>
								</div>
								<div class="field-group">
									<label class="label-text" for="liq-base">{selectedBase?.symbol ?? 'Base'} Amount</label>
									<div class="input-with-badge">
										<input
											id="liq-base"
											class="input-field"
											type="number"
											min="0"
											bind:value={liqBaseAmount}
											placeholder="0.5"
										/>
										<span class="input-badge">{selectedBase?.symbol ?? ''}</span>
									</div>
								</div>
							</div>
						{:else}
							<!-- Price-based: user enters price per token + base amount to list -->
							<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
								<div class="field-group">
									<label class="label-text" for="price-per-token">Price per Token ({selectedBase?.symbol})</label>
									<div class="input-with-badge">
										<input
											id="price-per-token"
											class="input-field"
											type="number"
											min="0"
											step="any"
											bind:value={pricePerToken}
											placeholder="1.00"
										/>
										<span class="input-badge">{selectedBase?.symbol ?? ''}</span>
									</div>
									<span class="field-hint font-mono">How much 1 {tokenInfo.symbol} costs</span>
								</div>
								<div class="field-group">
									<label class="label-text" for="list-base-amt">Amount of {selectedBase?.symbol} to List</label>
									<div class="input-with-badge">
										<input
											id="list-base-amt"
											class="input-field"
											type="number"
											min="0"
											step="any"
											bind:value={listBaseAmount}
											placeholder="100"
										/>
										<span class="input-badge">{selectedBase?.symbol ?? ''}</span>
									</div>
								</div>
							</div>

							{#if calculatedTokenAmount()}
								<div class="calc-result">
									<span class="text-gray-500 text-xs font-mono">Calculated token amount:</span>
									<span class="text-white text-sm font-mono font-bold">
										{Number(calculatedTokenAmount()).toLocaleString()} {tokenInfo.symbol}
									</span>
								</div>
							{/if}
						{/if}

						<div class="liq-info-box">
							<div class="liq-info-row">
								<span class="text-gray-500 font-mono text-xs">Slippage Tolerance</span>
								<span class="text-cyan-300 font-mono text-xs">5%</span>
							</div>
							<div class="liq-info-row">
								<span class="text-gray-500 font-mono text-xs">Transaction Deadline</span>
								<span class="text-cyan-300 font-mono text-xs">20 minutes</span>
							</div>
							<div class="liq-info-row">
								<span class="text-gray-500 font-mono text-xs">LP Tokens go to</span>
								<span class="text-cyan-300 font-mono text-xs">{userAddress ? shortAddr(userAddress) : 'Your wallet'}</span>
							</div>
						</div>

						<button
							onclick={doAddLiquidity}
							disabled={actionLoading || (liqMode === 'manual' ? (!liqTokenAmount || !liqBaseAmount) : (!pricePerToken || !listBaseAmount))}
							class="action-btn liq-btn syne cursor-pointer"
						>
							{actionLoading ? 'Adding Liquidity...' : 'Add Liquidity to DEX'}
						</button>
					</div>
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.spinner { animation: spin 0.8s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }

	.syne { font-family: 'Syne', sans-serif; }

	.token-avatar {
		width: 60px; height: 60px;
		border-radius: 16px;
		background: linear-gradient(135deg, rgba(0,210,255,0.2), rgba(99,102,241,0.2));
		border: 1px solid rgba(255,255,255,0.1);
		display: flex; align-items: center; justify-content: center;
		font-size: 20px; font-weight: 800; color: white;
		flex-shrink: 0;
	}

	.contract-addr-bar {
		padding: 10px 14px;
		background: rgba(255,255,255,0.02);
		border: 1px solid rgba(255,255,255,0.05);
		border-radius: 8px;
		overflow-x: auto;
		white-space: nowrap;
	}

	.stat-card {
		background: rgba(255,255,255,0.02);
		border: 1px solid rgba(255,255,255,0.07);
		border-radius: 12px;
	}
	.stat-label { font-size: 11px; color: #6b7280; font-family: 'Space Mono', monospace; text-transform: uppercase; letter-spacing: 0.05em; }
	.stat-value { font-size: 18px; font-weight: 800; color: white; margin: 4px 0 2px; }
	.stat-unit { font-size: 11px; color: #4b5563; font-family: 'Space Mono', monospace; }

	.tabs-bar {
		border-bottom: 1px solid rgba(255,255,255,0.06);
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
	.tab-btn:hover { color: #e2e8f0; }
	.tab-btn.active {
		color: #00d2ff;
		border-bottom-color: #00d2ff;
		background: rgba(0,210,255,0.05);
	}

	.panel {
		background: rgba(255,255,255,0.02);
		border: 1px solid rgba(255,255,255,0.07);
		border-radius: 16px;
		padding: 24px;
	}

	.sub-panel {
		background: rgba(255,255,255,0.02);
		border: 1px solid rgba(255,255,255,0.05);
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
		background: rgba(255,255,255,0.05);
		padding: 2px 8px;
		border-radius: 4px;
	}

	.field-hint { font-size: 11px; color: #4b5563; font-family: 'Space Mono', monospace; }
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
		border-bottom: 1px solid rgba(255,255,255,0.04);
		gap: 12px;
	}
	.info-row:last-child { border-bottom: none; }
	.info-key { font-size: 12px; color: #6b7280; font-family: 'Space Mono', monospace; flex-shrink: 0; }
	.info-val { font-size: 13px; color: #e2e8f0; text-align: right; word-break: break-all; }

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
		border: 1px solid rgba(255,255,255,0.1);
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
	.mode-btn:hover:not(.active) { color: #e2e8f0; background: rgba(255,255,255,0.03); }

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
		background: rgba(255,255,255,0.02);
		border: 1px solid rgba(255,255,255,0.05);
		border-radius: 8px;
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

	select option { background: #0d0d14; }

	.input-field {
		width: 100%;
		background: rgba(255,255,255,0.04);
		border: 1px solid rgba(255,255,255,0.1);
		border-radius: 10px;
		padding: 12px 16px;
		color: #e2e8f0;
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
	.input-field::placeholder { color: rgba(255,255,255,0.2); }
</style>
