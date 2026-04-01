<script lang="ts">
	import { getContext } from 'svelte';
	import { ethers } from 'ethers';
	import { FACTORY_ABI, ERC20_ABI, ZERO_ADDRESS } from '$lib/tokenCrafter';
	import { LAUNCHPAD_FACTORY_ABI } from '$lib/launchpad';
	import type { SupportedNetworks, SupportedNetwork } from '$lib/structure';
	import { t } from '$lib/i18n';

	let getSigner: () => ethers.Signer | null = getContext('signer');
	let addFeedback: (f: { message: string; type: string }) => void = getContext('addFeedback');
	let getNetworkProviders: () => Map<number, ethers.JsonRpcProvider> = getContext('networkProviders');

	let signer = $derived(getSigner());

	interface Props {
		selectedNetwork: SupportedNetwork;
	}

	let { selectedNetwork }: Props = $props();

	let busy = $state(false);
	let loading = $state(false);

	// Launchpad state
	let lpTotalLaunches = $state(0n);
	let lpTotalFeeUsdt = $state(0n);
	let lpLaunchFee = $state('0');
	let lpPlatformWallet = $state('');
	let lpDexRouter = $state('');
	let lpUsdtAddr = $state('');
	let lpPaymentTokens = $state<string[]>([]);
	let lpOwner = $state('');
	let usdtDecimals = $state(18);

	// Input state
	let lpNewFee = $state('');
	let lpNewPlatformWallet = $state('');
	let lpNewDexRouter = $state('');
	let lpAddPaymentInput = $state('');
	let lpRemovePaymentInput = $state('');
	let lpWithdrawTokenAddr = $state('');

	function formatAddress(addr: string) {
		if (!addr || addr === ZERO_ADDRESS) return 'Not set';
		return addr.slice(0, 6) + '...' + addr.slice(-4);
	}

	function getLpContract(signerOrProvider: ethers.ContractRunner) {
		return new ethers.Contract(selectedNetwork.launchpad_address, LAUNCHPAD_FACTORY_ABI, signerOrProvider);
	}

	async function loadData() {
		if (!selectedNetwork?.launchpad_address || selectedNetwork.launchpad_address === '0x') return;
		loading = true;
		try {
			const providers = getNetworkProviders();
			const provider = providers.get(selectedNetwork.chain_id);
			if (!provider) return;

			// Get USDT decimals from factory
			if (selectedNetwork.platform_address && selectedNetwork.platform_address !== '0x') {
				try {
					const factory = new ethers.Contract(selectedNetwork.platform_address, FACTORY_ABI, provider);
					const usdt_ = await factory.usdt();
					const usdtContract = new ethers.Contract(usdt_, ERC20_ABI, provider);
					usdtDecimals = Number(await usdtContract.decimals());
				} catch { usdtDecimals = 18; }
			}

			const lpContract = getLpContract(provider);
			const [lpOwner_, lpTotal, lpFeeUsdt, lpFee, lpPW, lpRouter, lpUsdt, lpSupported] = await Promise.all([
				lpContract.owner(),
				lpContract.totalLaunches(),
				lpContract.totalLaunchFeeEarnedUsdt(),
				lpContract.launchFee(),
				lpContract.platformWallet(),
				lpContract.dexRouter(),
				lpContract.usdt(),
				lpContract.getSupportedPaymentTokens()
			]);
			lpOwner = lpOwner_;
			lpTotalLaunches = lpTotal;
			lpTotalFeeUsdt = lpFeeUsdt;
			lpLaunchFee = ethers.formatUnits(lpFee, usdtDecimals);
			lpPlatformWallet = lpPW;
			lpDexRouter = lpRouter;
			lpUsdtAddr = lpUsdt;
			lpPaymentTokens = [...lpSupported];
		} catch (e: any) {
			console.warn('Failed to load launchpad data:', e.message);
		} finally {
			loading = false;
		}
	}

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
		if (selectedNetwork) {
			loadData();
		}
	});
</script>

{#if loading}
	<div class="flex items-center justify-center py-20">
		<div class="spinner w-10 h-10 rounded-full border-2 border-white/10 border-t-cyan-400"></div>
	</div>
{:else if !selectedNetwork.launchpad_address || selectedNetwork.launchpad_address === '0x'}
	<div class="card p-8 text-center">
		<p class="text-gray-400">{$t('admin.launchpadNotDeployed').replace('{network}', selectedNetwork.name)}</p>
	</div>
{:else}
	<!-- Launchpad Stats -->
	<div class="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
		<div class="card p-4 text-center">
			<div class="text-2xl font-bold text-purple-400 syne">{lpTotalLaunches.toString()}</div>
			<div class="text-xs text-gray-500 mt-1">{$t('admin.totalLaunches')}</div>
		</div>
		<div class="card p-4 text-center">
			<div class="text-2xl font-bold text-cyan-400 syne">${lpLaunchFee}</div>
			<div class="text-xs text-gray-500 mt-1">{$t('admin.launchFeeUsdt')}</div>
		</div>
		<div class="card p-4 text-center">
			<div class="text-2xl font-bold text-emerald-400 syne">${ethers.formatUnits(lpTotalFeeUsdt, usdtDecimals)}</div>
			<div class="text-xs text-gray-500 mt-1">{$t('admin.totalFeeEarned')}</div>
		</div>
	</div>

	<!-- Launchpad Info -->
	<div class="card p-5 mb-4">
		<h3 class="section-title mb-3">{$t('admin.launchpadFactoryInfo')}</h3>
		<div class="info-grid">
			<div class="info-row">
				<span class="text-gray-500 text-xs">{$t('admin.contract')}</span>
				<span class="text-white text-xs font-mono">{selectedNetwork.launchpad_address}</span>
			</div>
			<div class="info-row">
				<span class="text-gray-500 text-xs">{$t('admin.ownerLabel')}</span>
				<span class="text-white text-xs font-mono">{lpOwner}</span>
			</div>
			<div class="info-row">
				<span class="text-gray-500 text-xs">{$t('admin.platformWallet')}</span>
				<span class="text-cyan-400 text-xs font-mono">{formatAddress(lpPlatformWallet)}</span>
			</div>
			<div class="info-row">
				<span class="text-gray-500 text-xs">{$t('admin.dexRouter')}</span>
				<span class="text-cyan-400 text-xs font-mono">{formatAddress(lpDexRouter)}</span>
			</div>
			<div class="info-row">
				<span class="text-gray-500 text-xs">USDT</span>
				<span class="text-cyan-400 text-xs font-mono">{formatAddress(lpUsdtAddr)}</span>
			</div>
		</div>
	</div>

	<!-- Launch Fee -->
	<div class="card p-5 mb-4">
		<h3 class="section-title mb-3">{$t('admin.setLaunchFee')}</h3>
		<div class="flex flex-col sm:flex-row gap-3">
			<input class="input-field flex-1" type="number" placeholder={$t('admin.launchFeePlaceholder')} bind:value={lpNewFee} />
			<button class="btn-primary text-xs px-5 py-2 cursor-pointer" disabled={busy} onclick={lpSetFee}>
				{busy ? $t('admin.setting') : $t('admin.updateFee')}
			</button>
		</div>
	</div>

	<!-- Platform Wallet -->
	<div class="card p-5 mb-4">
		<h3 class="section-title mb-3">{$t('admin.platformWalletTitle')}</h3>
		<div class="info-row mb-3">
			<span class="text-gray-500 text-xs">{$t('admin.current')}</span>
			<span class="text-cyan-400 text-xs font-mono">{lpPlatformWallet}</span>
		</div>
		<div class="flex flex-col sm:flex-row gap-3">
			<input class="input-field flex-1" placeholder={$t('admin.newPlatformWalletPlaceholder')} bind:value={lpNewPlatformWallet} />
			<button class="btn-primary text-xs px-5 py-2 cursor-pointer" disabled={busy} onclick={lpSetPlatformWallet}>
				{busy ? $t('admin.setting') : $t('admin.update')}
			</button>
		</div>
	</div>

	<!-- DEX Router -->
	<div class="card p-5 mb-4">
		<h3 class="section-title mb-3">{$t('admin.dexRouterTitle')}</h3>
		<div class="flex flex-col sm:flex-row gap-3">
			<input class="input-field flex-1" placeholder={$t('admin.newRouterPlaceholder')} bind:value={lpNewDexRouter} />
			<button class="btn-primary text-xs px-5 py-2 cursor-pointer" disabled={busy} onclick={lpSetDexRouter}>
				{busy ? $t('admin.setting') : $t('admin.updateRouter')}
			</button>
		</div>
	</div>

	<!-- Launchpad Payment Tokens -->
	<div class="card p-5 mb-4">
		<h3 class="section-title mb-4">{$t('admin.launchpadPaymentTokens')}</h3>
		<div class="flex flex-col gap-2 mb-4">
			{#each lpPaymentTokens as token}
				<div class="info-row">
					<span class="font-mono text-xs text-cyan-400">{token === ZERO_ADDRESS ? `Native (${selectedNetwork.native_coin})` : token}</span>
				</div>
			{/each}
			{#if lpPaymentTokens.length === 0}
				<p class="text-gray-500 text-sm">{$t('admin.noPaymentTokens')}</p>
			{/if}
		</div>
		<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
			<div>
				<div class="flex flex-col gap-3">
					<input class="input-field" placeholder={$t('admin.addTokenPlaceholder')} bind:value={lpAddPaymentInput} />
					<button class="btn-primary text-xs px-5 py-2 cursor-pointer" disabled={busy} onclick={lpAddPayment}>
						{busy ? $t('admin.adding') : $t('admin.addToken')}
					</button>
				</div>
			</div>
			<div>
				<div class="flex flex-col gap-3">
					<input class="input-field" placeholder={$t('admin.removeTokenPlaceholder')} bind:value={lpRemovePaymentInput} />
					<button class="btn-danger text-xs px-5 py-2 cursor-pointer" disabled={busy} onclick={lpRemovePayment}>
						{busy ? $t('admin.removing') : $t('admin.removeToken')}
					</button>
				</div>
			</div>
		</div>
	</div>

	<!-- Launchpad Withdraw -->
	<div class="card p-5">
		<h3 class="section-title mb-2">{$t('admin.withdrawLaunchpadFees')}</h3>
		<p class="text-xs text-gray-500 mb-4">{$t('admin.withdrawLaunchpadDesc')}</p>
		<div class="flex flex-col gap-4">
			<div>
				<label class="label-text">{$t('admin.tokenAddress')}</label>
				<input class="input-field" placeholder={$t('admin.withdrawTokenPlaceholder').replace('{coin}', selectedNetwork.native_coin)} bind:value={lpWithdrawTokenAddr} />
			</div>
			<button class="btn-primary text-xs px-5 py-2 cursor-pointer" disabled={busy} onclick={lpWithdrawFees}>
				{busy ? $t('admin.withdrawing') : $t('admin.withdrawAll')}
			</button>
		</div>
	</div>
{/if}

<style>
	.info-grid { display: flex; flex-direction: column; gap: 2px; }
	.info-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 8px 0;
		border-bottom: 1px solid var(--bg-surface);
	}
	.info-row:last-child { border-bottom: none; }

	select option { background: var(--select-bg); }

	.spinner {
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }
</style>
