<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import { ethers } from 'ethers';
	import { TokenFactory, FACTORY_ABI, ERC20_ABI, ZERO_ADDRESS } from '$lib/tokenCrafter';
	import { LAUNCHPAD_FACTORY_ABI } from '$lib/launchpad';
	import type { SupportedNetworks, SupportedNetwork, PaymentOption } from '$lib/structure';

	let connectWallet: () => Promise<boolean> = getContext('connectWallet');
	let getSigner: () => ethers.Signer | null = getContext('signer');
	let getUserAddress: () => string | null = getContext('userAddress');
	let addFeedback: (f: { message: string; type: string }) => void = getContext('addFeedback');
	let supportedNetworks: SupportedNetworks = getContext('supportedNetworks');
	let getNetworkProviders: () => Map<number, ethers.JsonRpcProvider> = getContext('networkProviders');
	let getProvidersReady: () => boolean = getContext('providersReady');
	let getPaymentOptions: (n: SupportedNetwork) => PaymentOption[] = getContext('getPaymentOptions');

	let userAddress = $derived(getUserAddress());
	let signer = $derived(getSigner());
	let providersReady = $derived(getProvidersReady());

	let selectedNetworkIdx = $state(0);
	let selectedNetwork = $derived(supportedNetworks[selectedNetworkIdx]);

	type TabKey = 'stats' | 'implementations' | 'fees' | 'payments' | 'referral' | 'tax' | 'protection' | 'withdraw' | 'launchpad';
	let activeTab = $state<TabKey>('stats');

	// Auth
	let isOwner = $state(false);
	let factoryOwner = $state('');
	let loading = $state(false);
	let busy = $state(false);

	// Stats
	let totalTokens = $state(0n);
	let tokensByType = $state<bigint[]>([]);

	// Implementations
	let implAddresses = $state<string[]>(Array(8).fill(''));
	let implInput = $state({ typeKey: 0, address: '' });

	// Fees
	let feeAmounts = $state<string[]>(Array(8).fill(''));
	let feeInput = $state({ typeKey: 0, amount: '' });
	let usdtDecimals = $state(18);

	// Payment tokens
	let paymentTokens = $state<string[]>([]);
	let addPaymentInput = $state('');
	let removePaymentInput = $state('');

	// Referral
	let refLevels = $state(0);
	let refPercents = $state<string[]>([]);
	let autoDistribute = $state(false);
	let newRefLevels = $state('');
	let newRefPercents = $state('');
	let newAutoDistribute = $state(false);

	// Tax conversion
	let convertTaxEnabled = $state(false);
	let processTaxInput = $state('');

	// Protection overrides
	let protTokenAddr = $state('');
	let protAction = $state<'unblacklist' | 'relaxMaxWallet' | 'relaxMaxTx' | 'relaxCooldown' | 'disableBlacklist'>('unblacklist');
	let protAccountAddr = $state('');
	let protAmount = $state('');

	// Withdraw
	let withdrawTokenAddr = $state('');

	// Launchpad
	let lpTotalLaunches = $state(0n);
	let lpTotalFeeUsdt = $state(0n);
	let lpLaunchFee = $state('0');
	let lpPlatformWallet = $state('');
	let lpDexRouter = $state('');
	let lpTokenFactory = $state('');
	let lpUsdtAddr = $state('');
	let lpPaymentTokens = $state<string[]>([]);
	let lpOwner = $state('');
	let lpNewFee = $state('');
	let lpNewPlatformWallet = $state('');
	let lpNewDexRouter = $state('');
	let lpNewTokenFactory = $state('');
	let lpAddPaymentInput = $state('');
	let lpRemovePaymentInput = $state('');
	let lpWithdrawTokenAddr = $state('');

	// DEX Router
	let dexRouterAddr = $state('');
	let newDexRouter = $state('');
	let usdtAddr = $state('');

	const TYPE_LABELS = ['Basic', 'Mintable', 'Taxable', 'Tax+Mint', 'Partner', 'Part+Mint', 'Part+Tax', 'Part+Tax+Mint'];

	const tabs: { key: TabKey; label: string }[] = [
		{ key: 'stats', label: 'Stats' },
		{ key: 'implementations', label: 'Implementations' },
		{ key: 'fees', label: 'Fees' },
		{ key: 'payments', label: 'Payment Tokens' },
		{ key: 'referral', label: 'Referral' },
		{ key: 'tax', label: 'Tax Config' },
		{ key: 'protection', label: 'Protection' },
		{ key: 'withdraw', label: 'Withdraw' },
		{ key: 'launchpad', label: 'Launchpad' }
	];

	function formatAddress(addr: string) {
		if (!addr || addr === ZERO_ADDRESS) return 'Not set';
		return addr.slice(0, 6) + '...' + addr.slice(-4);
	}

	function getContract(signerOrProvider: ethers.ContractRunner) {
		return new ethers.Contract(selectedNetwork.platform_address, FACTORY_ABI, signerOrProvider);
	}

	function getLpContract(signerOrProvider: ethers.ContractRunner) {
		return new ethers.Contract(selectedNetwork.launchpad_address, LAUNCHPAD_FACTORY_ABI, signerOrProvider);
	}

	async function loadData() {
		if (!selectedNetwork?.platform_address || selectedNetwork.platform_address === '0x') return;
		loading = true;
		try {
			const providers = getNetworkProviders();
			const provider = providers.get(selectedNetwork.chain_id);
			if (!provider) {
				addFeedback({ message: `Provider not ready for ${selectedNetwork.name}`, type: 'error' });
				return;
			}

			const contract = getContract(provider);

			// Check owner
			const [owner, stats, supported, convertTax, router, usdt_, levels, autoDist] = await Promise.all([
				contract.owner(),
				contract.getStats(),
				contract.getSupportedPaymentTokens(),
				contract.convertTaxToStable(),
				contract.dexRouter(),
				contract.usdt(),
				contract.referralLevels(),
				contract.autoDistributeReward()
			]);

			factoryOwner = owner;
			isOwner = userAddress ? userAddress.toLowerCase() === owner.toLowerCase() : false;

			totalTokens = stats[0];
			tokensByType = [...stats[1]];
			paymentTokens = [...supported];
			convertTaxEnabled = convertTax;
			dexRouterAddr = router;
			usdtAddr = usdt_;
			refLevels = Number(levels);
			autoDistribute = autoDist;
			newAutoDistribute = autoDist;
			newRefLevels = String(refLevels);

			// Load implementations and fees
			const implPromises = [];
			const feePromises = [];
			for (let i = 0; i < 8; i++) {
				implPromises.push(contract.implementations(i));
				feePromises.push(contract.creationFee(i));
			}

			const [impls, fees] = await Promise.all([
				Promise.all(implPromises),
				Promise.all(feePromises)
			]);

			implAddresses = impls.map((a: string) => a);

			// Get USDT decimals
			try {
				const usdtContract = new ethers.Contract(usdt_, ERC20_ABI, provider);
				usdtDecimals = Number(await usdtContract.decimals());
			} catch { usdtDecimals = 18; }

			feeAmounts = fees.map((f: bigint) => ethers.formatUnits(f, usdtDecimals));

			// Load referral percents
			try {
				const percents = await contract.getReferralPercents();
				refPercents = [...percents].map((p: bigint) => String(Number(p) / 100));
			} catch { refPercents = []; }

			// Load launchpad factory data
			if (selectedNetwork.launchpad_address && selectedNetwork.launchpad_address !== '0x') {
				try {
					const lpContract = getLpContract(provider);
					const [lpOwner_, lpTotal, lpFeeUsdt, lpFee, lpPW, lpRouter, lpTF, lpUsdt, lpSupported] = await Promise.all([
						lpContract.owner(),
						lpContract.totalLaunches(),
						lpContract.totalLaunchFeeEarnedUsdt(),
						lpContract.launchFee(),
						lpContract.platformWallet(),
						lpContract.dexRouter(),
						lpContract.tokenFactory(),
						lpContract.usdt(),
						lpContract.getSupportedPaymentTokens()
					]);
					lpOwner = lpOwner_;
					lpTotalLaunches = lpTotal;
					lpTotalFeeUsdt = lpFeeUsdt;
					lpLaunchFee = ethers.formatUnits(lpFee, usdtDecimals);
					lpPlatformWallet = lpPW;
					lpDexRouter = lpRouter;
					lpTokenFactory = lpTF;
					lpUsdtAddr = lpUsdt;
					lpPaymentTokens = [...lpSupported];
				} catch (e: any) {
					console.warn('Failed to load launchpad data:', e.message);
				}
			}

		} catch (e: any) {
			addFeedback({ message: `Failed to load: ${e.message?.slice(0, 80)}`, type: 'error' });
		} finally {
			loading = false;
		}
	}

	async function doSetImplementation() {
		if (!signer) return;
		if (!ethers.isAddress(implInput.address)) {
			addFeedback({ message: 'Invalid implementation address', type: 'error' });
			return;
		}
		busy = true;
		try {
			const contract = getContract(signer);
			const tx = await contract.setImplementation(BigInt(implInput.typeKey), implInput.address);
			await tx.wait();
			addFeedback({ message: `Implementation set for type ${implInput.typeKey}`, type: 'success' });
			implInput.address = '';
			loadData();
		} catch (e: any) {
			addFeedback({ message: e.reason || e.message?.slice(0, 80), type: 'error' });
		} finally { busy = false; }
	}

	async function doSetFee() {
		if (!signer) return;
		busy = true;
		try {
			const contract = getContract(signer);
			const amount = ethers.parseUnits(String(feeInput.amount), usdtDecimals);
			const tx = await contract.setCreationFee(BigInt(feeInput.typeKey), amount);
			await tx.wait();
			addFeedback({ message: `Fee set for type ${feeInput.typeKey}`, type: 'success' });
			feeInput.amount = '';
			loadData();
		} catch (e: any) {
			addFeedback({ message: e.reason || e.message?.slice(0, 80), type: 'error' });
		} finally { busy = false; }
	}

	async function doAddPayment() {
		if (!signer) return;
		busy = true;
		try {
			const contract = getContract(signer);
			const tx = await contract.addPaymentToken(addPaymentInput);
			await tx.wait();
			addFeedback({ message: 'Payment token added', type: 'success' });
			addPaymentInput = '';
			loadData();
		} catch (e: any) {
			addFeedback({ message: e.reason || e.message?.slice(0, 80), type: 'error' });
		} finally { busy = false; }
	}

	async function doRemovePayment() {
		if (!signer) return;
		busy = true;
		try {
			const contract = getContract(signer);
			const tx = await contract.removePaymentToken(removePaymentInput);
			await tx.wait();
			addFeedback({ message: 'Payment token removed', type: 'success' });
			removePaymentInput = '';
			loadData();
		} catch (e: any) {
			addFeedback({ message: e.reason || e.message?.slice(0, 80), type: 'error' });
		} finally { busy = false; }
	}

	async function doSetRefLevels() {
		if (!signer) return;
		busy = true;
		try {
			const contract = getContract(signer);
			const tx = await contract.setReferralLevels(BigInt(newRefLevels));
			await tx.wait();
			addFeedback({ message: 'Referral levels updated', type: 'success' });
			loadData();
		} catch (e: any) {
			addFeedback({ message: e.reason || e.message?.slice(0, 80), type: 'error' });
		} finally { busy = false; }
	}

	async function doSetRefPercents() {
		if (!signer) return;
		busy = true;
		try {
			const contract = getContract(signer);
			const percents = newRefPercents.split(',').map(p => BigInt(Math.round(parseFloat(p.trim()) * 100)));
			const tx = await contract.setReferralPercents(percents);
			await tx.wait();
			addFeedback({ message: 'Referral percents updated', type: 'success' });
			newRefPercents = '';
			loadData();
		} catch (e: any) {
			addFeedback({ message: e.reason || e.message?.slice(0, 80), type: 'error' });
		} finally { busy = false; }
	}

	async function doSetAutoDistribute() {
		if (!signer) return;
		busy = true;
		try {
			const contract = getContract(signer);
			const tx = await contract.setAutoDistributeReward(newAutoDistribute);
			await tx.wait();
			addFeedback({ message: `Auto distribute ${newAutoDistribute ? 'enabled' : 'disabled'}`, type: 'success' });
			loadData();
		} catch (e: any) {
			addFeedback({ message: e.reason || e.message?.slice(0, 80), type: 'error' });
		} finally { busy = false; }
	}

	async function doSetConvertTax(enabled: boolean) {
		if (!signer) return;
		busy = true;
		try {
			const contract = getContract(signer);
			const tx = await contract.setConvertTaxToStable(enabled);
			await tx.wait();
			addFeedback({ message: `Tax conversion ${enabled ? 'enabled' : 'disabled'}`, type: 'success' });
			loadData();
		} catch (e: any) {
			addFeedback({ message: e.reason || e.message?.slice(0, 80), type: 'error' });
		} finally { busy = false; }
	}

	async function doProcessTax() {
		if (!signer || !processTaxInput) return;
		busy = true;
		try {
			const contract = getContract(signer);
			const tx = await contract.processTax(processTaxInput);
			await tx.wait();
			addFeedback({ message: 'Tax processed', type: 'success' });
			processTaxInput = '';
		} catch (e: any) {
			addFeedback({ message: e.reason || e.message?.slice(0, 80), type: 'error' });
		} finally { busy = false; }
	}

	async function doSetDexRouter() {
		if (!signer || !newDexRouter) return;
		busy = true;
		try {
			const contract = getContract(signer);
			const tx = await contract.setDexRouter(newDexRouter);
			await tx.wait();
			addFeedback({ message: 'DEX router updated', type: 'success' });
			newDexRouter = '';
			loadData();
		} catch (e: any) {
			addFeedback({ message: e.reason || e.message?.slice(0, 80), type: 'error' });
		} finally { busy = false; }
	}

	async function doProtectionOverride() {
		if (!signer || !protTokenAddr) return;
		busy = true;
		try {
			const contract = getContract(signer);
			let tx;
			switch (protAction) {
				case 'unblacklist':
					tx = await contract.forceUnblacklist(protTokenAddr, protAccountAddr);
					break;
				case 'relaxMaxWallet':
					tx = await contract.forceRelaxMaxWallet(protTokenAddr, ethers.parseUnits(String(protAmount || '0'), 18));
					break;
				case 'relaxMaxTx':
					tx = await contract.forceRelaxMaxTransaction(protTokenAddr, ethers.parseUnits(String(protAmount || '0'), 18));
					break;
				case 'relaxCooldown':
					tx = await contract.forceRelaxCooldown(protTokenAddr, BigInt(protAmount || '0'));
					break;
				case 'disableBlacklist':
					tx = await contract.forceDisableBlacklist(protTokenAddr);
					break;
			}
			await tx.wait();
			addFeedback({ message: `Protection override applied`, type: 'success' });
		} catch (e: any) {
			addFeedback({ message: e.reason || e.message?.slice(0, 80), type: 'error' });
		} finally { busy = false; }
	}

	async function doWithdraw() {
		if (!signer) return;
		busy = true;
		try {
			const contract = getContract(signer);
			const addr = withdrawTokenAddr.trim() || ZERO_ADDRESS;
			const tx = await contract.withdrawToken(addr === '' ? ZERO_ADDRESS : addr);
			await tx.wait();
			addFeedback({ message: 'Withdrawal successful', type: 'success' });
			withdrawTokenAddr = '';
		} catch (e: any) {
			addFeedback({ message: e.reason || e.message?.slice(0, 80), type: 'error' });
		} finally { busy = false; }
	}

	// ── Launchpad Admin Actions ──

	async function lpSetFee() {
		if (!signer) return;
		busy = true;
		try {
			const contract = getLpContract(signer);
			const amount = ethers.parseUnits(String(lpNewFee), usdtDecimals);
			const tx = await contract.setLaunchFee(amount);
			await tx.wait();
			addFeedback({ message: 'Launch fee updated', type: 'success' });
			lpNewFee = '';
			loadData();
		} catch (e: any) {
			addFeedback({ message: e.reason || e.message?.slice(0, 80), type: 'error' });
		} finally { busy = false; }
	}

	async function lpSetPlatformWallet() {
		if (!signer || !lpNewPlatformWallet) return;
		busy = true;
		try {
			const contract = getLpContract(signer);
			const tx = await contract.setPlatformWallet(lpNewPlatformWallet);
			await tx.wait();
			addFeedback({ message: 'Platform wallet updated', type: 'success' });
			lpNewPlatformWallet = '';
			loadData();
		} catch (e: any) {
			addFeedback({ message: e.reason || e.message?.slice(0, 80), type: 'error' });
		} finally { busy = false; }
	}

	async function lpSetDexRouter() {
		if (!signer || !lpNewDexRouter) return;
		busy = true;
		try {
			const contract = getLpContract(signer);
			const tx = await contract.setDexRouter(lpNewDexRouter);
			await tx.wait();
			addFeedback({ message: 'Launchpad DEX router updated', type: 'success' });
			lpNewDexRouter = '';
			loadData();
		} catch (e: any) {
			addFeedback({ message: e.reason || e.message?.slice(0, 80), type: 'error' });
		} finally { busy = false; }
	}

	async function lpSetTokenFactory() {
		if (!signer || !lpNewTokenFactory) return;
		busy = true;
		try {
			const contract = getLpContract(signer);
			const tx = await contract.setTokenFactory(lpNewTokenFactory);
			await tx.wait();
			addFeedback({ message: 'Token factory updated', type: 'success' });
			lpNewTokenFactory = '';
			loadData();
		} catch (e: any) {
			addFeedback({ message: e.reason || e.message?.slice(0, 80), type: 'error' });
		} finally { busy = false; }
	}

	async function lpAddPayment() {
		if (!signer) return;
		busy = true;
		try {
			const contract = getLpContract(signer);
			const tx = await contract.addPaymentToken(lpAddPaymentInput);
			await tx.wait();
			addFeedback({ message: 'Launchpad payment token added', type: 'success' });
			lpAddPaymentInput = '';
			loadData();
		} catch (e: any) {
			addFeedback({ message: e.reason || e.message?.slice(0, 80), type: 'error' });
		} finally { busy = false; }
	}

	async function lpRemovePayment() {
		if (!signer) return;
		busy = true;
		try {
			const contract = getLpContract(signer);
			const tx = await contract.removePaymentToken(lpRemovePaymentInput);
			await tx.wait();
			addFeedback({ message: 'Launchpad payment token removed', type: 'success' });
			lpRemovePaymentInput = '';
			loadData();
		} catch (e: any) {
			addFeedback({ message: e.reason || e.message?.slice(0, 80), type: 'error' });
		} finally { busy = false; }
	}

	async function lpWithdrawFees() {
		if (!signer) return;
		busy = true;
		try {
			const contract = getLpContract(signer);
			const addr = lpWithdrawTokenAddr.trim() || ZERO_ADDRESS;
			const tx = await contract.withdrawFees(addr === '' ? ZERO_ADDRESS : addr);
			await tx.wait();
			addFeedback({ message: 'Launchpad withdrawal successful', type: 'success' });
			lpWithdrawTokenAddr = '';
		} catch (e: any) {
			addFeedback({ message: e.reason || e.message?.slice(0, 80), type: 'error' });
		} finally { busy = false; }
	}

	$effect(() => {
		if (providersReady && selectedNetwork) {
			loadData();
		}
	});

	$effect(() => {
		if (userAddress && factoryOwner) {
			isOwner = userAddress.toLowerCase() === factoryOwner.toLowerCase();
		}
	});
</script>

<svelte:head>
	<title>Admin Dashboard | TokenKrafter</title>
	<meta name="description" content="TokenKrafter admin panel — manage platform settings, supported networks, fee configurations, and monitor deployed tokens." />
</svelte:head>

<div class="page-wrap">
	<section class="max-w-5xl mx-auto px-4 sm:px-6 pt-10 pb-6">
		<h1 class="syne text-3xl sm:text-4xl font-bold text-white mb-2">Factory Admin</h1>
		<p class="text-gray-500 text-sm font-mono mb-6">Manage factory settings, fees, and token protection overrides.</p>

		<!-- Network selector -->
		<div class="flex flex-wrap items-center gap-3 mb-6">
			<label class="label-text mb-0">Network</label>
			<select class="input-field max-w-xs" bind:value={selectedNetworkIdx}>
				{#each supportedNetworks as net, i}
					{#if net.platform_address && net.platform_address !== '0x'}
						<option value={i}>{net.name} ({net.symbol})</option>
					{/if}
				{/each}
			</select>
			{#if !userAddress}
				<button onclick={connectWallet} class="btn-primary text-xs px-4 py-2 cursor-pointer">Connect Wallet</button>
			{/if}
		</div>

		{#if loading}
			<div class="flex items-center justify-center py-20">
				<div class="spinner w-10 h-10 rounded-full border-2 border-white/10 border-t-cyan-400"></div>
			</div>
		{:else if !selectedNetwork?.platform_address || selectedNetwork.platform_address === '0x'}
			<div class="card p-8 text-center">
				<p class="text-gray-400">Factory not deployed on {selectedNetwork?.name || 'this network'} yet.</p>
			</div>
		{:else if !isOwner && factoryOwner}
			<div class="card p-8 text-center">
				<p class="text-gray-400 mb-2">Only the factory owner can access this dashboard.</p>
				<p class="text-xs text-gray-600 font-mono">Owner: {factoryOwner}</p>
				{#if userAddress}
					<p class="text-xs text-gray-600 font-mono mt-1">You: {userAddress}</p>
				{/if}
			</div>
		{:else}
			<!-- Tabs -->
			<div class="tabs-row flex flex-wrap gap-1 mb-6">
				{#each tabs as tab}
					<button
						onclick={() => (activeTab = tab.key)}
						class="tab-btn px-3 py-2 rounded-lg text-xs font-mono transition cursor-pointer
						{activeTab === tab.key ? 'active' : ''}"
					>{tab.label}</button>
				{/each}
			</div>

			<!-- STATS TAB -->
			{#if activeTab === 'stats'}
				<div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
					<div class="card p-4 text-center">
						<div class="text-2xl font-bold text-cyan-400 syne">{totalTokens.toString()}</div>
						<div class="text-xs text-gray-500 mt-1">Total Tokens</div>
					</div>
					{#each tokensByType as count, i}
						<div class="card p-4 text-center">
							<div class="text-xl font-bold text-white syne">{count.toString()}</div>
							<div class="text-xs text-gray-500 mt-1">{TYPE_LABELS[i]}</div>
						</div>
					{/each}
				</div>

				<div class="card p-5">
					<h3 class="section-title mb-3">Factory Info</h3>
					<div class="info-grid">
						<div class="info-row">
							<span class="text-gray-500 text-xs">Owner</span>
							<span class="text-white text-xs font-mono">{factoryOwner}</span>
						</div>
						<div class="info-row">
							<span class="text-gray-500 text-xs">Contract</span>
							<span class="text-white text-xs font-mono">{selectedNetwork.platform_address}</span>
						</div>
						<div class="info-row">
							<span class="text-gray-500 text-xs">DEX Router</span>
							<span class="text-white text-xs font-mono">{formatAddress(dexRouterAddr)}</span>
						</div>
						<div class="info-row">
							<span class="text-gray-500 text-xs">USDT</span>
							<span class="text-white text-xs font-mono">{formatAddress(usdtAddr)}</span>
						</div>
						<div class="info-row">
							<span class="text-gray-500 text-xs">Tax Conversion</span>
							<span class="text-xs {convertTaxEnabled ? 'text-emerald-400' : 'text-gray-500'}">{convertTaxEnabled ? 'Enabled' : 'Disabled'}</span>
						</div>
						<div class="info-row">
							<span class="text-gray-500 text-xs">Auto Distribute Rewards</span>
							<span class="text-xs {autoDistribute ? 'text-emerald-400' : 'text-gray-500'}">{autoDistribute ? 'Enabled' : 'Disabled'}</span>
						</div>
					</div>
				</div>

			<!-- IMPLEMENTATIONS TAB -->
			{:else if activeTab === 'implementations'}
				<div class="card p-5 mb-4">
					<h3 class="section-title mb-4">Token Implementations</h3>
					<div class="overflow-x-auto">
						<table class="w-full text-sm">
							<thead>
								<tr class="border-b border-white/5">
									<th class="text-left text-gray-500 text-xs py-2 px-2">Type</th>
									<th class="text-left text-gray-500 text-xs py-2 px-2">Key</th>
									<th class="text-left text-gray-500 text-xs py-2 px-2">Address</th>
								</tr>
							</thead>
							<tbody>
								{#each implAddresses as addr, i}
									<tr class="border-b border-white/3">
										<td class="py-2 px-2 text-white">{TYPE_LABELS[i]}</td>
										<td class="py-2 px-2 text-gray-400">{i}</td>
										<td class="py-2 px-2 font-mono text-xs {addr === ZERO_ADDRESS ? 'text-red-400' : 'text-cyan-400'}">{addr === ZERO_ADDRESS ? 'Not set' : formatAddress(addr)}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				</div>

				<div class="card p-5">
					<h3 class="section-title mb-3">Set Implementation</h3>
					<div class="flex flex-col sm:flex-row gap-3">
						<select class="input-field max-w-[180px]" bind:value={implInput.typeKey}>
							{#each TYPE_LABELS as label, i}
								<option value={i}>{i} - {label}</option>
							{/each}
						</select>
						<input class="input-field flex-1" placeholder="Implementation address (0x...)" bind:value={implInput.address} />
						<button class="btn-primary text-xs px-5 py-2 cursor-pointer" disabled={busy} onclick={doSetImplementation}>
							{busy ? 'Setting...' : 'Set'}
						</button>
					</div>
				</div>

			<!-- FEES TAB -->
			{:else if activeTab === 'fees'}
				<div class="card p-5 mb-4">
					<h3 class="section-title mb-4">Creation Fees (USDT)</h3>
					<div class="overflow-x-auto">
						<table class="w-full text-sm">
							<thead>
								<tr class="border-b border-white/5">
									<th class="text-left text-gray-500 text-xs py-2 px-2">Type</th>
									<th class="text-right text-gray-500 text-xs py-2 px-2">Fee (USDT)</th>
								</tr>
							</thead>
							<tbody>
								{#each feeAmounts as fee, i}
									<tr class="border-b border-white/3">
										<td class="py-2 px-2 text-white">{TYPE_LABELS[i]}</td>
										<td class="py-2 px-2 text-right text-cyan-400 font-mono">${fee}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				</div>

				<div class="card p-5">
					<h3 class="section-title mb-3">Update Fee</h3>
					<div class="flex flex-col sm:flex-row gap-3">
						<select class="input-field max-w-[180px]" bind:value={feeInput.typeKey}>
							{#each TYPE_LABELS as label, i}
								<option value={i}>{i} - {label}</option>
							{/each}
						</select>
						<input class="input-field flex-1" type="number" placeholder="Fee in USDT (e.g. 25)" bind:value={feeInput.amount} />
						<button class="btn-primary text-xs px-5 py-2 cursor-pointer" disabled={busy} onclick={doSetFee}>
							{busy ? 'Setting...' : 'Set Fee'}
						</button>
					</div>
				</div>

			<!-- PAYMENT TOKENS TAB -->
			{:else if activeTab === 'payments'}
				<div class="card p-5 mb-4">
					<h3 class="section-title mb-4">Supported Payment Tokens</h3>
					<div class="flex flex-col gap-2">
						{#each paymentTokens as token}
							<div class="info-row">
								<span class="font-mono text-xs text-cyan-400">{token === ZERO_ADDRESS ? `Native (${selectedNetwork.native_coin})` : token}</span>
							</div>
						{/each}
						{#if paymentTokens.length === 0}
							<p class="text-gray-500 text-sm">No payment tokens configured.</p>
						{/if}
					</div>
				</div>

				<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
					<div class="card p-5">
						<h3 class="section-title mb-3">Add Payment Token</h3>
						<div class="flex flex-col gap-3">
							<input class="input-field" placeholder="Token address (0x...)" bind:value={addPaymentInput} />
							<button class="btn-primary text-xs px-5 py-2 cursor-pointer" disabled={busy} onclick={doAddPayment}>
								{busy ? 'Adding...' : 'Add Token'}
							</button>
						</div>
					</div>
					<div class="card p-5">
						<h3 class="section-title mb-3">Remove Payment Token</h3>
						<div class="flex flex-col gap-3">
							<input class="input-field" placeholder="Token address (0x...)" bind:value={removePaymentInput} />
							<button class="btn-danger text-xs px-5 py-2 cursor-pointer" disabled={busy} onclick={doRemovePayment}>
								{busy ? 'Removing...' : 'Remove Token'}
							</button>
						</div>
					</div>
				</div>

			<!-- REFERRAL TAB -->
			{:else if activeTab === 'referral'}
				<div class="card p-5 mb-4">
					<h3 class="section-title mb-3">Current Referral Settings</h3>
					<div class="info-grid">
						<div class="info-row">
							<span class="text-gray-500 text-xs">Levels</span>
							<span class="text-white text-sm">{refLevels}</span>
						</div>
						<div class="info-row">
							<span class="text-gray-500 text-xs">Percents per level</span>
							<span class="text-cyan-400 text-sm font-mono">{refPercents.map(p => p + '%').join(', ') || 'Not set'}</span>
						</div>
						<div class="info-row">
							<span class="text-gray-500 text-xs">Auto Distribute</span>
							<span class="text-sm {autoDistribute ? 'text-emerald-400' : 'text-gray-500'}">{autoDistribute ? 'Yes' : 'No'}</span>
						</div>
					</div>
				</div>

				<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
					<div class="card p-5">
						<h3 class="section-title mb-3">Set Levels</h3>
						<div class="flex flex-col gap-3">
							<input class="input-field" type="number" placeholder="Number of levels (1-10)" bind:value={newRefLevels} min="1" max="10" />
							<button class="btn-primary text-xs px-5 py-2 cursor-pointer" disabled={busy} onclick={doSetRefLevels}>
								{busy ? 'Setting...' : 'Update Levels'}
							</button>
						</div>
					</div>
					<div class="card p-5">
						<h3 class="section-title mb-3">Set Percents</h3>
						<div class="flex flex-col gap-3">
							<input class="input-field" placeholder="e.g. 5, 3, 2 (in %)" bind:value={newRefPercents} />
							<p class="text-xs text-gray-600">Comma-separated. Each value in percent (5 = 5%).</p>
							<button class="btn-primary text-xs px-5 py-2 cursor-pointer" disabled={busy} onclick={doSetRefPercents}>
								{busy ? 'Setting...' : 'Update Percents'}
							</button>
						</div>
					</div>
				</div>

				<div class="card p-5 mt-4">
					<h3 class="section-title mb-3">Auto Distribute Rewards</h3>
					<div class="flex items-center gap-4">
						<label class="flex items-center gap-2 cursor-pointer">
							<input type="checkbox" bind:checked={newAutoDistribute} class="accent-cyan-400" />
							<span class="text-sm text-gray-300">{newAutoDistribute ? 'Enabled (pay immediately)' : 'Disabled (accumulate for claiming)'}</span>
						</label>
						{#if newAutoDistribute !== autoDistribute}
							<button class="btn-primary text-xs px-4 py-1.5 cursor-pointer" disabled={busy} onclick={doSetAutoDistribute}>
								{busy ? 'Saving...' : 'Save'}
							</button>
						{/if}
					</div>
				</div>

			<!-- TAX CONFIG TAB -->
			{:else if activeTab === 'tax'}
				<div class="card p-5 mb-4">
					<h3 class="section-title mb-3">Tax Conversion</h3>
					<div class="info-row mb-4">
						<span class="text-gray-500 text-xs">Convert tax to stable</span>
						<span class="text-sm {convertTaxEnabled ? 'text-emerald-400' : 'text-gray-500'}">{convertTaxEnabled ? 'Enabled' : 'Disabled'}</span>
					</div>
					<div class="flex gap-3">
						<button class="btn-primary text-xs px-5 py-2 cursor-pointer" disabled={busy || convertTaxEnabled} onclick={() => doSetConvertTax(true)}>
							Enable
						</button>
						<button class="btn-secondary text-xs px-5 py-2 cursor-pointer" disabled={busy || !convertTaxEnabled} onclick={() => doSetConvertTax(false)}>
							Disable
						</button>
					</div>
				</div>

				<div class="card p-5 mb-4">
					<h3 class="section-title mb-3">Process Tax</h3>
					<p class="text-xs text-gray-500 mb-3">Manually trigger tax processing for a partner token.</p>
					<div class="flex flex-col sm:flex-row gap-3">
						<input class="input-field flex-1" placeholder="Token address (0x...)" bind:value={processTaxInput} />
						<button class="btn-primary text-xs px-5 py-2 cursor-pointer" disabled={busy} onclick={doProcessTax}>
							{busy ? 'Processing...' : 'Process Tax'}
						</button>
					</div>
				</div>

				<div class="card p-5">
					<h3 class="section-title mb-3">DEX Router</h3>
					<div class="info-row mb-3">
						<span class="text-gray-500 text-xs">Current</span>
						<span class="text-cyan-400 text-xs font-mono">{dexRouterAddr}</span>
					</div>
					<div class="flex flex-col sm:flex-row gap-3">
						<input class="input-field flex-1" placeholder="New router address (0x...)" bind:value={newDexRouter} />
						<button class="btn-primary text-xs px-5 py-2 cursor-pointer" disabled={busy} onclick={doSetDexRouter}>
							{busy ? 'Setting...' : 'Update Router'}
						</button>
					</div>
				</div>

			<!-- PROTECTION TAB -->
			{:else if activeTab === 'protection'}
				<div class="card p-5">
					<h3 class="section-title mb-2">Protection Overrides</h3>
					<p class="text-xs text-gray-500 mb-4">Force-relax protection settings on tokens created by this factory. These actions can only loosen restrictions, never tighten them.</p>

					<div class="flex flex-col gap-4">
						<div>
							<label class="label-text">Token Address</label>
							<input class="input-field" placeholder="Token contract address (0x...)" bind:value={protTokenAddr} />
						</div>

						<div>
							<label class="label-text">Action</label>
							<select class="input-field" bind:value={protAction}>
								<option value="unblacklist">Force Unblacklist Account</option>
								<option value="relaxMaxWallet">Force Relax Max Wallet</option>
								<option value="relaxMaxTx">Force Relax Max Transaction</option>
								<option value="relaxCooldown">Force Relax Cooldown</option>
								<option value="disableBlacklist">Force Disable Blacklist</option>
							</select>
						</div>

						{#if protAction === 'unblacklist'}
							<div>
								<label class="label-text">Account to Unblacklist</label>
								<input class="input-field" placeholder="Account address (0x...)" bind:value={protAccountAddr} />
							</div>
						{:else if protAction === 'relaxMaxWallet' || protAction === 'relaxMaxTx'}
							<div>
								<label class="label-text">New Amount (tokens, 0 = disable)</label>
								<input class="input-field" type="number" placeholder="Amount in tokens" bind:value={protAmount} />
							</div>
						{:else if protAction === 'relaxCooldown'}
							<div>
								<label class="label-text">New Cooldown (seconds, 0 = disable)</label>
								<input class="input-field" type="number" placeholder="Seconds" bind:value={protAmount} />
							</div>
						{/if}

						<button class="btn-danger text-xs px-5 py-2 cursor-pointer" disabled={busy || !protTokenAddr} onclick={doProtectionOverride}>
							{busy ? 'Applying...' : 'Apply Override'}
						</button>
					</div>
				</div>

			<!-- WITHDRAW TAB -->
			{:else if activeTab === 'withdraw'}
				<div class="card p-5">
					<h3 class="section-title mb-2">Withdraw Factory Funds</h3>
					<p class="text-xs text-gray-500 mb-4">Withdraw accumulated fees or stuck tokens from the factory contract to the owner wallet.</p>

					<div class="flex flex-col gap-4">
						<div>
							<label class="label-text">Token Address</label>
							<input class="input-field" placeholder="Token address, or leave empty for native ({selectedNetwork.native_coin})" bind:value={withdrawTokenAddr} />
							<p class="text-xs text-gray-600 mt-1">Leave empty or enter {ZERO_ADDRESS} to withdraw native {selectedNetwork.native_coin}.</p>
						</div>
						<button class="btn-primary text-xs px-5 py-2 cursor-pointer" disabled={busy} onclick={doWithdraw}>
							{busy ? 'Withdrawing...' : 'Withdraw All'}
						</button>
					</div>
				</div>

			<!-- LAUNCHPAD TAB -->
			{:else if activeTab === 'launchpad'}
				{#if !selectedNetwork.launchpad_address || selectedNetwork.launchpad_address === '0x'}
					<div class="card p-8 text-center">
						<p class="text-gray-400">Launchpad not deployed on {selectedNetwork.name} yet.</p>
					</div>
				{:else}
					<!-- Launchpad Stats -->
					<div class="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
						<div class="card p-4 text-center">
							<div class="text-2xl font-bold text-purple-400 syne">{lpTotalLaunches.toString()}</div>
							<div class="text-xs text-gray-500 mt-1">Total Launches</div>
						</div>
						<div class="card p-4 text-center">
							<div class="text-2xl font-bold text-cyan-400 syne">${lpLaunchFee}</div>
							<div class="text-xs text-gray-500 mt-1">Launch Fee (USDT)</div>
						</div>
						<div class="card p-4 text-center">
							<div class="text-2xl font-bold text-emerald-400 syne">${ethers.formatUnits(lpTotalFeeUsdt, usdtDecimals)}</div>
							<div class="text-xs text-gray-500 mt-1">Total Fee Earned</div>
						</div>
					</div>

					<!-- Launchpad Info -->
					<div class="card p-5 mb-4">
						<h3 class="section-title mb-3">Launchpad Factory Info</h3>
						<div class="info-grid">
							<div class="info-row">
								<span class="text-gray-500 text-xs">Contract</span>
								<span class="text-white text-xs font-mono">{selectedNetwork.launchpad_address}</span>
							</div>
							<div class="info-row">
								<span class="text-gray-500 text-xs">Owner</span>
								<span class="text-white text-xs font-mono">{lpOwner}</span>
							</div>
							<div class="info-row">
								<span class="text-gray-500 text-xs">Platform Wallet</span>
								<span class="text-cyan-400 text-xs font-mono">{formatAddress(lpPlatformWallet)}</span>
							</div>
							<div class="info-row">
								<span class="text-gray-500 text-xs">DEX Router</span>
								<span class="text-cyan-400 text-xs font-mono">{formatAddress(lpDexRouter)}</span>
							</div>
							<div class="info-row">
								<span class="text-gray-500 text-xs">Token Factory</span>
								<span class="text-cyan-400 text-xs font-mono">{formatAddress(lpTokenFactory)}</span>
							</div>
							<div class="info-row">
								<span class="text-gray-500 text-xs">USDT</span>
								<span class="text-cyan-400 text-xs font-mono">{formatAddress(lpUsdtAddr)}</span>
							</div>
						</div>
					</div>

					<!-- Launch Fee -->
					<div class="card p-5 mb-4">
						<h3 class="section-title mb-3">Set Launch Fee</h3>
						<div class="flex flex-col sm:flex-row gap-3">
							<input class="input-field flex-1" type="number" placeholder="Fee in USDT (e.g. 50)" bind:value={lpNewFee} />
							<button class="btn-primary text-xs px-5 py-2 cursor-pointer" disabled={busy} onclick={lpSetFee}>
								{busy ? 'Setting...' : 'Update Fee'}
							</button>
						</div>
					</div>

					<!-- Platform Wallet -->
					<div class="card p-5 mb-4">
						<h3 class="section-title mb-3">Platform Wallet</h3>
						<div class="info-row mb-3">
							<span class="text-gray-500 text-xs">Current</span>
							<span class="text-cyan-400 text-xs font-mono">{lpPlatformWallet}</span>
						</div>
						<div class="flex flex-col sm:flex-row gap-3">
							<input class="input-field flex-1" placeholder="New platform wallet (0x...)" bind:value={lpNewPlatformWallet} />
							<button class="btn-primary text-xs px-5 py-2 cursor-pointer" disabled={busy} onclick={lpSetPlatformWallet}>
								{busy ? 'Setting...' : 'Update'}
							</button>
						</div>
					</div>

					<!-- DEX Router & Token Factory -->
					<div class="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
						<div class="card p-5">
							<h3 class="section-title mb-3">DEX Router</h3>
							<div class="flex flex-col gap-3">
								<input class="input-field" placeholder="New router (0x...)" bind:value={lpNewDexRouter} />
								<button class="btn-primary text-xs px-5 py-2 cursor-pointer" disabled={busy} onclick={lpSetDexRouter}>
									{busy ? 'Setting...' : 'Update Router'}
								</button>
							</div>
						</div>
						<div class="card p-5">
							<h3 class="section-title mb-3">Token Factory</h3>
							<div class="flex flex-col gap-3">
								<input class="input-field" placeholder="New factory (0x...)" bind:value={lpNewTokenFactory} />
								<button class="btn-primary text-xs px-5 py-2 cursor-pointer" disabled={busy} onclick={lpSetTokenFactory}>
									{busy ? 'Setting...' : 'Update Factory'}
								</button>
							</div>
						</div>
					</div>

					<!-- Launchpad Payment Tokens -->
					<div class="card p-5 mb-4">
						<h3 class="section-title mb-4">Launchpad Payment Tokens</h3>
						<div class="flex flex-col gap-2 mb-4">
							{#each lpPaymentTokens as token}
								<div class="info-row">
									<span class="font-mono text-xs text-cyan-400">{token === ZERO_ADDRESS ? `Native (${selectedNetwork.native_coin})` : token}</span>
								</div>
							{/each}
							{#if lpPaymentTokens.length === 0}
								<p class="text-gray-500 text-sm">No payment tokens configured.</p>
							{/if}
						</div>
						<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
							<div>
								<div class="flex flex-col gap-3">
									<input class="input-field" placeholder="Add token (0x...)" bind:value={lpAddPaymentInput} />
									<button class="btn-primary text-xs px-5 py-2 cursor-pointer" disabled={busy} onclick={lpAddPayment}>
										{busy ? 'Adding...' : 'Add Token'}
									</button>
								</div>
							</div>
							<div>
								<div class="flex flex-col gap-3">
									<input class="input-field" placeholder="Remove token (0x...)" bind:value={lpRemovePaymentInput} />
									<button class="btn-danger text-xs px-5 py-2 cursor-pointer" disabled={busy} onclick={lpRemovePayment}>
										{busy ? 'Removing...' : 'Remove Token'}
									</button>
								</div>
							</div>
						</div>
					</div>

					<!-- Launchpad Withdraw -->
					<div class="card p-5">
						<h3 class="section-title mb-2">Withdraw Launchpad Fees</h3>
						<p class="text-xs text-gray-500 mb-4">Withdraw collected fees from the LaunchpadFactory contract.</p>
						<div class="flex flex-col gap-4">
							<div>
								<label class="label-text">Token Address</label>
								<input class="input-field" placeholder="Token address, or leave empty for native ({selectedNetwork.native_coin})" bind:value={lpWithdrawTokenAddr} />
							</div>
							<button class="btn-primary text-xs px-5 py-2 cursor-pointer" disabled={busy} onclick={lpWithdrawFees}>
								{busy ? 'Withdrawing...' : 'Withdraw All'}
							</button>
						</div>
					</div>
				{/if}
			{/if}
		{/if}
	</section>
</div>

<style>
	.page-wrap { padding-bottom: 40px; }

	.tab-btn {
		background: rgba(255,255,255,0.03);
		border: 1px solid rgba(255,255,255,0.06);
		color: #94a3b8;
	}
	.tab-btn:hover { background: rgba(255,255,255,0.06); color: #e2e8f0; }
	.tab-btn.active {
		background: rgba(0,210,255,0.1);
		border-color: rgba(0,210,255,0.3);
		color: #00d2ff;
	}

	.info-grid { display: flex; flex-direction: column; gap: 2px; }
	.info-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 8px 0;
		border-bottom: 1px solid rgba(255,255,255,0.03);
	}
	.info-row:last-child { border-bottom: none; }

	table { border-collapse: collapse; }

	.spinner {
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }

	select option { background: #0d0d14; }
</style>
