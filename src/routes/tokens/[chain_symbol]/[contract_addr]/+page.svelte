<script lang="ts">
	import { page } from '$app/state';
	import type { SupportedNetworks, TokenInfo } from '$lib/structure';
	import { ethers } from 'ethers';
	import { getContext, onMount } from 'svelte';

	const IERC20_EXT = [
		'function name() view returns (string)',
		'function symbol() view returns (string)',
		'function decimals() view returns (uint8)',
		'function totalSupply() view returns (uint256)',
		'function balanceOf(address) view returns (uint256)',
		'function owner() view returns (address)',
		'function mint(address to, uint256 amount) external',
		'function burn(uint256 amount) external',
		'function setBuyTax(uint256 tax) external',
		'function setSellTax(uint256 tax) external',
		'function setTaxWallet(address wallet) external',
		'function buyTax() view returns (uint256)',
		'function sellTax() view returns (uint256)',
		'function taxWallet() view returns (address)',
		'function isMintable() view returns (bool)',
		'function isTaxable() view returns (bool)',
		'function approve(address spender, uint256 amount) returns (bool)',
		'function allowance(address owner, address spender) view returns (uint256)'
	];

	const ROUTER_ABI = [
		'function addLiquidityETH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) payable returns (uint256, uint256, uint256)',
		'function WETH() view returns (address)'
	];

	const supportedNetworks: SupportedNetworks = getContext('supportedNetworks');
	const addFeedback = getContext<(f: { message: string; type: string }) => void>('addFeedback');
	let getSigner: () => ethers.Signer | null = getContext('signer');
	let getUserAddress: () => string | null = getContext('userAddress');
	let connectWallet: () => Promise<boolean> = getContext('connectWallet');

	let signer = $derived(getSigner());
	let userAddress = $derived(getUserAddress());

	// DEX router addresses
	const DEX_ROUTERS: Record<number, { name: string; address: string }[]> = {
		1: [{ name: 'Uniswap V2', address: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D' }],
		56: [{ name: 'PancakeSwap V2', address: '0x10ED43C718714eb63d5aA57B78B54704E256024E' }]
	};

	type ExtendedTokenInfo = TokenInfo & {
		owner?: string;
		isMintable?: boolean;
		isTaxable?: boolean;
		buyTax?: number;
		sellTax?: number;
		taxWallet?: string;
		userBalance?: string;
	};

	let tokenInfo: ExtendedTokenInfo | null = $state(null);
	let error: 'unsupported_network' | 'contract_error' | 'contract_not_found' | null = $state(null);
	let isLoading = $state(true);
	let network: (typeof supportedNetworks)[0] | null = $state(null);
	let contractAddress = $state('');
	let activeTab = $state<'overview' | 'mint' | 'burn' | 'tax' | 'liquidity'>('overview');
	let isOwner = $state(false);

	// Form states
	let mintAmount = $state('');
	let mintTo = $state('');
	let burnAmount = $state('');
	let buyTaxInput = $state('');
	let sellTaxInput = $state('');
	let taxWalletInput = $state('');
	let liqTokenAmount = $state('');
	let liqEthAmount = $state('');
	let selectedRouter = $state('');
	let actionLoading = $state(false);

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

		const provider = new ethers.JsonRpcProvider(net.rpc);
		try {
			const contract = new ethers.Contract(contract_addr, IERC20_EXT, provider);
			const [name, symbol, decimals, totalSupply] = await Promise.all([
				contract.name(),
				contract.symbol(),
				contract.decimals(),
				contract.totalSupply()
			]);

			let owner: string | undefined;
			let isMintable: boolean | undefined;
			let isTaxable: boolean | undefined;
			let buyTax: number | undefined;
			let sellTax: number | undefined;
			let taxWallet: string | undefined;
			let userBalance: string | undefined;

			try { owner = await contract.owner(); } catch {}
			try { isMintable = await contract.isMintable(); } catch {}
			try { isTaxable = await contract.isTaxable(); } catch {}
			try { buyTax = Number(await contract.buyTax()); } catch {}
			try { sellTax = Number(await contract.sellTax()); } catch {}
			try { taxWallet = await contract.taxWallet(); } catch {}
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
				owner, isMintable, isTaxable, buyTax, sellTax, taxWallet, userBalance
			};

			isOwner = !!(owner && userAddress && owner.toLowerCase() === userAddress.toLowerCase());
			if (isMintable !== undefined) buyTaxInput = String(buyTax ?? 0);
			if (isTaxable !== undefined) sellTaxInput = String(sellTax ?? 0);
			if (taxWallet) taxWalletInput = taxWallet;
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
			const contract = new ethers.Contract(contractAddress, IERC20_EXT, s);
			const amount = ethers.parseUnits(mintAmount, tokenInfo?.decimals ?? 18);
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
			const contract = new ethers.Contract(contractAddress, IERC20_EXT, s);
			const amount = ethers.parseUnits(burnAmount, tokenInfo?.decimals ?? 18);
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

	async function doSetTax() {
		const s = await ensureSigner();
		if (!s) return;
		actionLoading = true;
		try {
			const contract = new ethers.Contract(contractAddress, IERC20_EXT, s);
			if (buyTaxInput) {
				const tx = await contract.setBuyTax(Number(buyTaxInput));
				await tx.wait();
			}
			if (sellTaxInput) {
				const tx = await contract.setSellTax(Number(sellTaxInput));
				await tx.wait();
			}
			if (taxWalletInput) {
				const tx = await contract.setTaxWallet(taxWalletInput);
				await tx.wait();
			}
			addFeedback({ message: 'Tax settings updated!', type: 'success' });
			await loadToken();
		} catch (e: any) {
			addFeedback({ message: e.shortMessage || e.message || 'Tax update failed', type: 'error' });
		} finally { actionLoading = false; }
	}

	async function doAddLiquidity() {
		const s = await ensureSigner();
		if (!s || !network || !selectedRouter) return;
		actionLoading = true;
		try {
			const tokenContract = new ethers.Contract(contractAddress, IERC20_EXT, s);
			const tokenAmount = ethers.parseUnits(liqTokenAmount, tokenInfo?.decimals ?? 18);
			const ethAmount = ethers.parseEther(liqEthAmount);

			// Approve router
			const allowance = await tokenContract.allowance(userAddress, selectedRouter);
			if (allowance < tokenAmount) {
				addFeedback({ message: 'Approving tokens for router...', type: 'info' });
				const approveTx = await tokenContract.approve(selectedRouter, tokenAmount);
				await approveTx.wait();
			}

			// Add liquidity
			const router = new ethers.Contract(selectedRouter, ROUTER_ABI, s);
			const deadline = Math.floor(Date.now() / 1000) + 1200; // 20 min
			addFeedback({ message: 'Adding liquidity...', type: 'info' });
			const tx = await router.addLiquidityETH(
				contractAddress,
				tokenAmount,
				tokenAmount * 95n / 100n, // 5% slippage
				ethAmount * 95n / 100n,
				userAddress,
				deadline,
				{ value: ethAmount }
			);
			await tx.wait();
			addFeedback({ message: 'Liquidity added successfully! 🎉', type: 'success' });
			liqTokenAmount = '';
			liqEthAmount = '';
		} catch (e: any) {
			addFeedback({ message: e.shortMessage || e.message || 'Liquidity failed', type: 'error' });
		} finally { actionLoading = false; }
	}

	function shortAddr(addr: string) {
		return addr.slice(0, 8) + '...' + addr.slice(-6);
	}

	const tabs = [
		{ id: 'overview', label: 'Overview', icon: '◎' },
		{ id: 'mint', label: 'Mint', icon: '🔨', requires: 'mintable' },
		{ id: 'burn', label: 'Burn', icon: '🔥' },
		{ id: 'tax', label: 'Tax', icon: '💸', requires: 'taxable' },
		{ id: 'liquidity', label: 'Liquidity', icon: '💧' }
	];

	function isTabVisible(tab: (typeof tabs)[0]) {
		if (tab.requires === 'mintable' && tokenInfo?.isMintable === false) return false;
		if (tab.requires === 'taxable' && tokenInfo?.isTaxable === false) return false;
		return true;
	}
</script>

<svelte:head>
	<title>{tokenInfo?.name ?? 'Token Details'} | TokenKrafter</title>
	<meta name="description" content="View details for {tokenInfo?.name ?? 'this token'} ({tokenInfo?.symbol ?? ''}) — supply, holder info, and contract details on TokenKrafter." />
</svelte:head>

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
			<div class="text-5xl mb-4">⚠️</div>
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
			<a href="/manage-tokens" class="btn-secondary text-sm px-5 py-2.5 no-underline">← Back</a>
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
							<span class="text-gray-600">•</span>
							<span class="text-gray-400 font-mono text-xs">{network?.name}</span>
							{#if tokenInfo.isMintable}
								<span class="badge badge-cyan">Mintable</span>
							{/if}
							{#if tokenInfo.isTaxable}
								<span class="badge badge-amber">Taxable</span>
							{/if}
							{#if isOwner}
								<span class="badge badge-emerald">Owner</span>
							{/if}
						</div>
					</div>
				</div>
				<a href="/manage-tokens" class="btn-secondary text-xs px-3 py-2 no-underline">← Back</a>
			</div>

			<!-- Contract Address -->
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
			{#if tokenInfo.isTaxable && tokenInfo.buyTax !== undefined}
				<div class="stat-card card p-4">
					<div class="stat-label">Buy/Sell Tax</div>
					<div class="stat-value syne">{tokenInfo.buyTax}% / {tokenInfo.sellTax}%</div>
					<div class="stat-unit">current rates</div>
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
							...(tokenInfo.owner ? [['Owner', shortAddr(tokenInfo.owner)]] : []),
							...(tokenInfo.isTaxable && tokenInfo.taxWallet ? [['Tax Wallet', shortAddr(tokenInfo.taxWallet)]] : [])
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
							<span class="text-amber-400">⚠️</span>
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
							{actionLoading ? 'Minting...' : '🔨 Mint Tokens'}
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
							<span class="text-red-400">🔥</span>
							<span class="text-red-300 text-sm font-mono">Burned tokens are permanently removed from supply. This cannot be undone.</span>
						</div>

						<button
							onclick={doBurn}
							disabled={actionLoading || !burnAmount}
							class="action-btn burn-btn syne cursor-pointer"
						>
							{actionLoading ? 'Burning...' : '🔥 Burn Tokens'}
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
							<p class="text-sm text-gray-500 font-mono mt-1">Configure buy/sell tax rates and recipient wallet.</p>
						</div>
						<span class="badge badge-cyan">Owner Only</span>
					</div>

					{#if !isOwner}
						<div class="owner-warning">
							<span class="text-amber-400">⚠️</span>
							<span class="text-amber-300 text-sm font-mono">Only the token owner can modify tax settings.</span>
						</div>
					{/if}

					<div class="form-fields">
						<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
							<div class="field-group">
								<label class="label-text" for="buy-tax">Buy Tax (%)</label>
								<div class="input-with-badge">
									<input
										id="buy-tax"
										class="input-field"
										type="number"
										min="0"
										max="100"
										bind:value={buyTaxInput}
										placeholder="0"
										disabled={!isOwner}
									/>
									<span class="input-badge">%</span>
								</div>
								{#if tokenInfo.buyTax !== undefined}
									<span class="field-hint font-mono">Current: {tokenInfo.buyTax}%</span>
								{/if}
							</div>
							<div class="field-group">
								<label class="label-text" for="sell-tax">Sell Tax (%)</label>
								<div class="input-with-badge">
									<input
										id="sell-tax"
										class="input-field"
										type="number"
										min="0"
										max="100"
										bind:value={sellTaxInput}
										placeholder="0"
										disabled={!isOwner}
									/>
									<span class="input-badge">%</span>
								</div>
								{#if tokenInfo.sellTax !== undefined}
									<span class="field-hint font-mono">Current: {tokenInfo.sellTax}%</span>
								{/if}
							</div>
						</div>

						<div class="field-group">
							<label class="label-text" for="tax-wallet">Tax Wallet Address</label>
							<input
								id="tax-wallet"
								class="input-field"
								bind:value={taxWalletInput}
								placeholder="0x... (receives tax fees)"
								disabled={!isOwner}
							/>
							{#if tokenInfo.taxWallet}
								<span class="field-hint font-mono">Current: {shortAddr(tokenInfo.taxWallet)}</span>
							{/if}
							{#if userAddress}
								<button
									onclick={() => (taxWalletInput = userAddress!)}
									class="field-hint-btn font-mono cursor-pointer"
								>Use my wallet</button>
							{/if}
						</div>

						<div class="tax-info-box">
							<div class="text-xs text-gray-400 font-mono leading-relaxed">
								<strong class="text-white">How tax works:</strong> A percentage of each buy/sell transaction
								is sent to the tax wallet. Set to 0 to disable. Maximum recommended: 10%.
							</div>
						</div>

						<button
							onclick={doSetTax}
							disabled={!isOwner || actionLoading}
							class="action-btn tax-btn syne cursor-pointer"
						>
							{actionLoading ? 'Saving...' : '💸 Update Tax Settings'}
						</button>
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
								Add your token + {network?.symbol ?? 'ETH'} to a DEX liquidity pool.
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
								<label class="label-text" for="liq-eth">{network?.symbol ?? 'ETH'} Amount</label>
								<div class="input-with-badge">
									<input
										id="liq-eth"
										class="input-field"
										type="number"
										min="0"
										bind:value={liqEthAmount}
										placeholder="0.5"
									/>
									<span class="input-badge">{network?.symbol ?? 'ETH'}</span>
								</div>
							</div>
						</div>

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
							disabled={actionLoading || !liqTokenAmount || !liqEthAmount}
							class="action-btn liq-btn syne cursor-pointer"
						>
							{actionLoading ? 'Adding Liquidity...' : '💧 Add Liquidity to DEX'}
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
	.stat-value { font-size: 20px; font-weight: 800; color: white; margin: 4px 0 2px; }
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

	.tax-info-box {
		padding: 12px 14px;
		background: rgba(255,255,255,0.02);
		border: 1px solid rgba(255,255,255,0.06);
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
