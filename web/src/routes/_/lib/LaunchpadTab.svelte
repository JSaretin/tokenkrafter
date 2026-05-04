<script lang="ts">
	import { getContext } from 'svelte';
	import { ethers } from 'ethers';
	import { FACTORY_ABI, ERC20_ABI, ZERO_ADDRESS } from '$lib/tokenCrafter';
	import { LAUNCHPAD_FACTORY_ABI } from '$lib/launchpad';
	import type { SupportedNetworks, SupportedNetwork } from '$lib/structure';
	import { t } from '$lib/i18n';
	import { friendlyError } from '$lib/errorDecoder';
	import Skeleton from '$lib/Skeleton.svelte';
	import AddressBadge from './AddressBadge.svelte';

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
	let lpOwner = $state('');
	let lpAuthorizedRouter = $state('');
	let lpLaunchImpl = $state('');
	let usdtDecimals = $state(18);

	// Input state
	let lpNewFee = $state('');
	let lpNewPlatformWallet = $state('');
	let lpNewDexRouter = $state('');
	let lpWithdrawTokenAddr = $state('');
	let lpNewAuthorizedRouter = $state('');
	let lpNewLaunchImpl = $state('');
	let lpNewUsdt = $state('');

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
			const [lpOwner_, lpTotal, lpFeeUsdt, lpFee, lpPW, lpRouter, lpUsdt, lpAuthRouter, lpImpl] = await Promise.all([
				lpContract.owner(),
				lpContract.totalLaunches(),
				lpContract.totalLaunchFeeEarnedUsdt(),
				lpContract.launchFee(),
				lpContract.platformWallet(),
				lpContract.dexRouter(),
				lpContract.usdt(),
				lpContract.authorizedRouter().catch(() => ZERO_ADDRESS),
				lpContract.launchImplementation().catch(() => ZERO_ADDRESS),
			]);
			lpOwner = lpOwner_;
			lpTotalLaunches = lpTotal;
			lpTotalFeeUsdt = lpFeeUsdt;
			lpLaunchFee = ethers.formatUnits(lpFee, usdtDecimals);
			lpPlatformWallet = lpPW;
			lpDexRouter = lpRouter;
			lpUsdtAddr = lpUsdt;
			lpAuthorizedRouter = lpAuthRouter;
			lpLaunchImpl = lpImpl;
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

	// lpAddPayment / lpRemovePayment removed: LaunchpadFactory is USDT-only
	// after the fee refactor. Payment token management moved into
	// PlatformRouter's FeePayment flow on the frontend, not on-chain.

	// ── Critical governance setters ────────────────────────────────────
	//
	// Same story as TokenFactory: these exist on the contract but had no
	// admin UI path until now. setAuthorizedRouter is the important one —
	// it's how PlatformRouter gets authorized to call routerCreateLaunch.

	async function lpSetAuthorizedRouter() {
		if (!signer || !lpNewAuthorizedRouter) return;
		if (!ethers.isAddress(lpNewAuthorizedRouter)) {
			addFeedback({ message: 'Invalid address', type: 'error' });
			return;
		}
		busy = true;
		try {
			const contract = getLpContract(signer);
			const tx = await contract.setAuthorizedRouter(lpNewAuthorizedRouter);
			await tx.wait();
			addFeedback({ message: 'Authorized router updated', type: 'success' });
			lpNewAuthorizedRouter = '';
			loadData();
		} catch (e) {
			addFeedback({ message: friendlyError(e), type: 'error' });
		} finally { busy = false; }
	}

	async function lpSetLaunchImplementation() {
		if (!signer || !lpNewLaunchImpl) return;
		if (!ethers.isAddress(lpNewLaunchImpl)) {
			addFeedback({ message: 'Invalid address', type: 'error' });
			return;
		}
		if (!confirm(`Set ${lpNewLaunchImpl} as the LaunchInstance implementation? Existing launches keep their old impl; only NEW launches use this one.`)) return;
		busy = true;
		try {
			const contract = getLpContract(signer);
			const tx = await contract.setLaunchImplementation(lpNewLaunchImpl);
			await tx.wait();
			addFeedback({ message: 'Launch implementation updated', type: 'success' });
			lpNewLaunchImpl = '';
			loadData();
		} catch (e) {
			addFeedback({ message: friendlyError(e), type: 'error' });
		} finally { busy = false; }
	}

	async function lpSetUsdt() {
		if (!signer || !lpNewUsdt) return;
		if (!ethers.isAddress(lpNewUsdt)) {
			addFeedback({ message: 'Invalid address', type: 'error' });
			return;
		}
		if (!confirm(`Change the launchpad's USDT address to ${lpNewUsdt}? This affects every new launch's fee accounting.`)) return;
		busy = true;
		try {
			const contract = getLpContract(signer);
			const tx = await contract.setUsdt(lpNewUsdt);
			await tx.wait();
			addFeedback({ message: 'USDT address updated', type: 'success' });
			lpNewUsdt = '';
			loadData();
		} catch (e) {
			addFeedback({ message: friendlyError(e), type: 'error' });
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
	<!-- Skeleton mirrors launchpad stats trio + factory info card. -->
	<div class="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
		{#each Array(3) as _}
			<div class="card p-4 text-center flex flex-col items-center gap-2">
				<Skeleton width="50%" height="1.5rem" />
				<Skeleton width="70%" height="0.7rem" />
			</div>
		{/each}
	</div>
	<div class="card p-5 mb-4 flex flex-col gap-2">
		<Skeleton width={180} height="0.95rem" />
		{#each Array(5) as _}
			<div class="flex justify-between items-center py-2 border-b border-surface last:border-b-0">
				<Skeleton width={100} height="0.8rem" />
				<Skeleton width={180} height="0.8rem" />
			</div>
		{/each}
	</div>
{:else if !selectedNetwork.launchpad_address || selectedNetwork.launchpad_address === '0x'}
	<div class="card p-8 text-center">
		<p class="text-gray-400">{$t('admin.launchpadNotDeployed').replace('{network}', selectedNetwork.name)}</p>
	</div>
{:else}
	<!-- Launchpad Stats -->
	<div class="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
		<div class="card p-4 text-center">
			<div class="text-2xl font-bold text-purple-400 font-display">{lpTotalLaunches.toString()}</div>
			<div class="text-xs text-gray-500 mt-1">{$t('admin.totalLaunches')}</div>
		</div>
		<div class="card p-4 text-center">
			<div class="text-2xl font-bold text-cyan-400 font-display">${lpLaunchFee}</div>
			<div class="text-xs text-gray-500 mt-1">{$t('admin.launchFeeUsdt')}</div>
		</div>
		<div class="card p-4 text-center">
			<div class="text-2xl font-bold text-emerald-400 font-display">${ethers.formatUnits(lpTotalFeeUsdt, usdtDecimals)}</div>
			<div class="text-xs text-gray-500 mt-1">{$t('admin.totalFeeEarned')}</div>
		</div>
	</div>

	<!-- Launchpad Info -->
	<div class="card p-5 mb-4">
		<h3 class="section-title mb-3">{$t('admin.launchpadFactoryInfo')}</h3>
		<div class="flex flex-col gap-0.5">
			<div class="flex justify-between items-center py-2 border-b border-surface last:border-b-0">
				<span class="text-gray-500 text-xs">{$t('admin.contract')}</span>
				<AddressBadge address={selectedNetwork.launchpad_address} explorerUrl={selectedNetwork.explorer_url} class="text-white" />
			</div>
			<div class="flex justify-between items-center py-2 border-b border-surface last:border-b-0">
				<span class="text-gray-500 text-xs">{$t('admin.ownerLabel')}</span>
				<AddressBadge address={lpOwner} explorerUrl={selectedNetwork.explorer_url} class="text-white" />
			</div>
			<div class="flex justify-between items-center py-2 border-b border-surface last:border-b-0">
				<span class="text-gray-500 text-xs">{$t('admin.platformWallet')}</span>
				<AddressBadge address={lpPlatformWallet} explorerUrl={selectedNetwork.explorer_url} class="text-cyan-400" />
			</div>
			<div class="flex justify-between items-center py-2 border-b border-surface last:border-b-0">
				<span class="text-gray-500 text-xs">{$t('admin.dexRouter')}</span>
				<AddressBadge address={lpDexRouter} explorerUrl={selectedNetwork.explorer_url} class="text-cyan-400" />
			</div>
			<div class="flex justify-between items-center py-2 border-b border-surface last:border-b-0">
				<span class="text-gray-500 text-xs">USDT</span>
				<AddressBadge address={lpUsdtAddr} explorerUrl={selectedNetwork.explorer_url} class="text-cyan-400" />
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
		<div class="flex justify-between items-center py-2 mb-3">
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

	<!-- Authorized Router -->
	<div class="card p-5 mb-4">
		<h3 class="section-title mb-1">Authorized Router</h3>
		<p class="text-xs text-gray-500 mb-3">Only this address can call routerCreateLaunch(). Update when PlatformRouter is redeployed.</p>
		<div class="text-xs text-gray-400 font-mono mb-3">Current: {formatAddress(lpAuthorizedRouter)}</div>
		<div class="flex flex-col sm:flex-row gap-3">
			<input class="input-field flex-1" placeholder="0x... new PlatformRouter" bind:value={lpNewAuthorizedRouter} />
			<button class="btn-primary text-xs px-5 py-2 cursor-pointer" disabled={busy || !lpNewAuthorizedRouter} onclick={lpSetAuthorizedRouter}>
				{busy ? '...' : 'Authorize'}
			</button>
		</div>
	</div>

	<!-- Launch Implementation -->
	<div class="card p-5 mb-4">
		<h3 class="section-title mb-1">Launch Implementation</h3>
		<p class="text-xs text-gray-500 mb-3">Clone template for new LaunchInstance deploys. Existing launches are unaffected — they keep their original impl.</p>
		<div class="text-xs text-gray-400 font-mono mb-3">Current: {formatAddress(lpLaunchImpl)}</div>
		<div class="flex flex-col sm:flex-row gap-3">
			<input class="input-field flex-1" placeholder="0x... new LaunchInstance implementation" bind:value={lpNewLaunchImpl} />
			<button class="btn-primary text-xs px-5 py-2 cursor-pointer" disabled={busy || !lpNewLaunchImpl} onclick={lpSetLaunchImplementation}>
				{busy ? '...' : 'Set'}
			</button>
		</div>
	</div>

	<!-- USDT Address -->
	<div class="card p-5 mb-4">
		<h3 class="section-title mb-1">USDT Address</h3>
		<p class="text-xs text-gray-500 mb-3">Fee token for launch creation. Critical — affects every new launch.</p>
		<div class="text-xs text-gray-400 font-mono mb-3">Current: {formatAddress(lpUsdtAddr)}</div>
		<div class="flex flex-col sm:flex-row gap-3">
			<input class="input-field flex-1" placeholder="0x... new USDT" bind:value={lpNewUsdt} />
			<button class="btn-primary text-xs px-5 py-2 cursor-pointer" disabled={busy || !lpNewUsdt} onclick={lpSetUsdt}>
				{busy ? '...' : 'Update'}
			</button>
		</div>
	</div>

	<!-- Launchpad Withdraw -->
	<div class="card p-5">
		<h3 class="section-title mb-2">{$t('admin.withdrawLaunchpadFees')}</h3>
		<p class="text-xs text-gray-500 mb-4">{$t('admin.withdrawLaunchpadDesc')}</p>
		<div class="flex flex-col gap-4">
			<label class="block">
				<span class="label-text">{$t('admin.tokenAddress')}</span>
				<input class="input-field" placeholder={$t('admin.withdrawTokenPlaceholder').replace('{coin}', selectedNetwork.native_coin)} bind:value={lpWithdrawTokenAddr} />
			</label>
			<button class="btn-primary text-xs px-5 py-2 cursor-pointer" disabled={busy} onclick={lpWithdrawFees}>
				{busy ? $t('admin.withdrawing') : $t('admin.withdrawAll')}
			</button>
		</div>
	</div>
{/if}
