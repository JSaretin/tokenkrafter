<script lang="ts">
	import { getContext } from 'svelte';
	import { ethers } from 'ethers';
	import { FACTORY_ABI, ERC20_ABI, ZERO_ADDRESS } from '$lib/tokenCrafter';
	import type { SupportedNetworks, SupportedNetwork } from '$lib/structure';
	import { t } from '$lib/i18n';

	let getSigner: () => ethers.Signer | null = getContext('signer');
	let addFeedback: (f: { message: string; type: string }) => void = getContext('addFeedback');
	let _getNetworks: () => SupportedNetworks = getContext('supportedNetworks');
	let supportedNetworks = $derived(_getNetworks());
	let getNetworkProviders: () => Map<number, ethers.JsonRpcProvider> = getContext('networkProviders');

	let signer = $derived(getSigner());

	interface Props {
		selectedNetwork: SupportedNetwork;
	}

	let { selectedNetwork }: Props = $props();

	let busy = $state(false);
	let loading = $state(false);

	// Stats
	let totalTokens = $state(0n);
	let factoryOwner = $state('');

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

	// DEX Router
	let dexRouterAddr = $state('');
	let newDexRouter = $state('');
	let usdtAddr = $state('');

	const TYPE_LABELS = ['Basic', 'Mintable', 'Taxable', 'Tax+Mint', 'Partner', 'Part+Mint', 'Part+Tax', 'Part+Tax+Mint'];

	let openSections = $state<Record<string, boolean>>({ fees: true, payments: true });
	function toggleSection(key: string) { openSections = { ...openSections, [key]: !openSections[key] }; }

	function formatAddress(addr: string) {
		if (!addr || addr === ZERO_ADDRESS) return 'Not set';
		return addr.slice(0, 6) + '...' + addr.slice(-4);
	}

	function getContract(signerOrProvider: ethers.ContractRunner) {
		return new ethers.Contract(selectedNetwork.platform_address, FACTORY_ABI, signerOrProvider);
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

			const [owner, total, supported, convertTax, router, usdt_, levels, autoDist] = await Promise.all([
				contract.owner(),
				contract.totalTokensCreated(),
				contract.getSupportedPaymentTokens(),
				contract.convertTaxToStable(),
				contract.dexRouter(),
				contract.usdt(),
				contract.referralLevels(),
				contract.autoDistributeReward()
			]);

			factoryOwner = owner;
			totalTokens = total;
			paymentTokens = [...supported];
			convertTaxEnabled = convertTax;
			dexRouterAddr = router;
			usdtAddr = usdt_;
			refLevels = Number(levels);
			autoDistribute = autoDist;
			newAutoDistribute = autoDist;
			newRefLevels = String(refLevels);

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

			try {
				const usdtContract = new ethers.Contract(usdt_, ERC20_ABI, provider);
				usdtDecimals = Number(await usdtContract.decimals());
			} catch { usdtDecimals = 18; }

			feeAmounts = fees.map((f: bigint) => ethers.formatUnits(f, usdtDecimals));

			try {
				const percents = await contract.getReferralPercents();
				refPercents = [...percents].map((p: bigint) => String(Number(p) / 100));
			} catch { refPercents = []; }

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
			const tx = await contract.withdrawFees(addr === '' ? ZERO_ADDRESS : addr);
			await tx.wait();
			addFeedback({ message: 'Withdrawal successful', type: 'success' });
			withdrawTokenAddr = '';
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
{:else}
	<!-- Factory Info -->
	<div class="card p-5 mb-4">
		<div class="info-grid">
			<div class="info-row"><span class="text-gray-500 text-xs">Owner</span><span class="text-white text-xs font-mono">{factoryOwner}</span></div>
			<div class="info-row"><span class="text-gray-500 text-xs">Contract</span><span class="text-white text-xs font-mono">{selectedNetwork.platform_address}</span></div>
			<div class="info-row"><span class="text-gray-500 text-xs">DEX Router</span><span class="text-white text-xs font-mono">{formatAddress(dexRouterAddr)}</span></div>
			<div class="info-row"><span class="text-gray-500 text-xs">USDT</span><span class="text-white text-xs font-mono">{formatAddress(usdtAddr)}</span></div>
			<div class="info-row"><span class="text-gray-500 text-xs">Tokens Created</span><span class="text-cyan-400 text-sm font-bold">{totalTokens.toString()}</span></div>
		</div>
	</div>

	<!-- Fees & Implementations -->
	<button class="collapse-header" onclick={() => toggleSection('fees')}>
		<span>Fees & Implementations</span>
		<span class="collapse-arrow" class:open={openSections['fees']}>▸</span>
	</button>
	{#if openSections['fees']}
		<div class="collapse-body">
			<div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
				<div class="card p-5">
					<h3 class="section-title mb-3">Creation Fees</h3>
					<table class="w-full text-sm"><tbody>
						{#each feeAmounts as fee, i}
							<tr class="border-b border-white/3"><td class="py-1.5 px-2 text-white text-xs">{TYPE_LABELS[i]}</td><td class="py-1.5 px-2 text-right text-cyan-400 font-mono text-xs">${fee}</td></tr>
						{/each}
					</tbody></table>
					<div class="flex flex-col sm:flex-row gap-2 mt-3">
						<select class="input-field text-xs" bind:value={feeInput.typeKey}>{#each TYPE_LABELS as label, i}<option value={i}>{i} - {label}</option>{/each}</select>
						<input class="input-field flex-1 text-xs" type="number" placeholder="New fee (USDT)" bind:value={feeInput.amount} />
						<button class="btn-primary text-xs px-4 py-1.5 cursor-pointer" disabled={busy} onclick={doSetFee}>{busy ? '...' : 'Set'}</button>
					</div>
				</div>
				<div class="card p-5">
					<h3 class="section-title mb-3">Implementations</h3>
					<table class="w-full text-sm"><tbody>
						{#each implAddresses as addr, i}
							<tr class="border-b border-white/3"><td class="py-1.5 px-2 text-white text-xs">{TYPE_LABELS[i]}</td><td class="py-1.5 px-2 font-mono text-[10px] {addr === ZERO_ADDRESS ? 'text-red-400' : 'text-cyan-400'}">{addr === ZERO_ADDRESS ? 'Not set' : formatAddress(addr)}</td></tr>
						{/each}
					</tbody></table>
					<div class="flex flex-col sm:flex-row gap-2 mt-3">
						<select class="input-field text-xs" bind:value={implInput.typeKey}>{#each TYPE_LABELS as label, i}<option value={i}>{i} - {label}</option>{/each}</select>
						<input class="input-field flex-1 text-xs" placeholder="0x... implementation" bind:value={implInput.address} />
						<button class="btn-primary text-xs px-4 py-1.5 cursor-pointer" disabled={busy} onclick={doSetImplementation}>{busy ? '...' : 'Set'}</button>
					</div>
				</div>
			</div>
		</div>
	{/if}

	<!-- Payment Tokens -->
	<button class="collapse-header" onclick={() => toggleSection('payments')}>
		<span>Payment Tokens</span>
		<span class="collapse-arrow" class:open={openSections['payments']}>▸</span>
	</button>
	{#if openSections['payments']}
		<div class="collapse-body">
			<div class="card p-5 mb-3">
				<div class="flex flex-col gap-1.5">
					{#each paymentTokens as token}
						<div class="info-row"><span class="font-mono text-xs text-cyan-400">{token === ZERO_ADDRESS ? `Native (${selectedNetwork.native_coin})` : token}</span></div>
					{/each}
					{#if paymentTokens.length === 0}<p class="text-gray-500 text-sm">No payment tokens</p>{/if}
				</div>
			</div>
			<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
				<div class="card p-4">
					<div class="flex flex-col gap-2">
						<input class="input-field text-xs" placeholder="0x... token address" bind:value={addPaymentInput} />
						<button class="btn-primary text-xs px-4 py-1.5 cursor-pointer" disabled={busy} onclick={doAddPayment}>{busy ? '...' : 'Add Token'}</button>
					</div>
				</div>
				<div class="card p-4">
					<div class="flex flex-col gap-2">
						<input class="input-field text-xs" placeholder="0x... token address" bind:value={removePaymentInput} />
						<button class="btn-danger text-xs px-4 py-1.5 cursor-pointer" disabled={busy} onclick={doRemovePayment}>{busy ? '...' : 'Remove'}</button>
					</div>
				</div>
			</div>
		</div>
	{/if}

	<!-- Referral -->
	<button class="collapse-header" onclick={() => toggleSection('referral')}>
		<span>Referral Program</span>
		<span class="collapse-arrow" class:open={openSections['referral']}>▸</span>
	</button>
	{#if openSections['referral']}
		<div class="collapse-body">
			<div class="card p-5 mb-3">
				<div class="info-grid">
					<div class="info-row"><span class="text-gray-500 text-xs">Levels</span><span class="text-white text-sm">{refLevels}</span></div>
					<div class="info-row"><span class="text-gray-500 text-xs">Percents</span><span class="text-cyan-400 text-sm font-mono">{refPercents.map(p => p + '%').join(', ') || 'Not set'}</span></div>
					<div class="info-row"><span class="text-gray-500 text-xs">Auto-distribute</span><span class="text-sm {autoDistribute ? 'text-emerald-400' : 'text-gray-500'}">{autoDistribute ? 'Yes' : 'No'}</span></div>
				</div>
			</div>
			<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
				<div class="card p-4">
					<div class="flex flex-col gap-2">
						<input class="input-field text-xs" type="number" placeholder="Number of levels" bind:value={newRefLevels} min="1" max="10" />
						<button class="btn-primary text-xs px-4 py-1.5 cursor-pointer" disabled={busy} onclick={doSetRefLevels}>{busy ? '...' : 'Update Levels'}</button>
					</div>
				</div>
				<div class="card p-4">
					<div class="flex flex-col gap-2">
						<input class="input-field text-xs" placeholder="e.g. 5,3,2" bind:value={newRefPercents} />
						<button class="btn-primary text-xs px-4 py-1.5 cursor-pointer" disabled={busy} onclick={doSetRefPercents}>{busy ? '...' : 'Update Percents'}</button>
					</div>
				</div>
			</div>
			<div class="card p-4 mt-3">
				<label class="flex items-center gap-2 cursor-pointer">
					<input type="checkbox" bind:checked={newAutoDistribute} class="accent-cyan-400" />
					<span class="text-xs text-gray-300">{newAutoDistribute ? 'Enabled — pay immediately' : 'Disabled — accumulate'}</span>
				</label>
				{#if newAutoDistribute !== autoDistribute}
					<button class="btn-primary text-xs px-4 py-1.5 mt-2 cursor-pointer" disabled={busy} onclick={doSetAutoDistribute}>{busy ? '...' : 'Save'}</button>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Tax & DEX -->
	<button class="collapse-header" onclick={() => toggleSection('tax')}>
		<span>Tax & DEX Config</span>
		<span class="collapse-arrow" class:open={openSections['tax']}>▸</span>
	</button>
	{#if openSections['tax']}
		<div class="collapse-body">
			<div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
				<div class="card p-4">
					<h3 class="section-title mb-2 text-xs">Tax Conversion</h3>
					<div class="info-row mb-3"><span class="text-gray-500 text-xs">Status</span><span class="text-xs {convertTaxEnabled ? 'text-emerald-400' : 'text-gray-500'}">{convertTaxEnabled ? 'Enabled' : 'Disabled'}</span></div>
					<div class="flex gap-2">
						<button class="btn-primary text-xs px-4 py-1.5 cursor-pointer" disabled={busy || convertTaxEnabled} onclick={() => doSetConvertTax(true)}>Enable</button>
						<button class="btn-secondary text-xs px-4 py-1.5 cursor-pointer" disabled={busy || !convertTaxEnabled} onclick={() => doSetConvertTax(false)}>Disable</button>
					</div>
				</div>
				<div class="card p-4">
					<h3 class="section-title mb-2 text-xs">Process Tax</h3>
					<div class="flex flex-col gap-2">
						<input class="input-field text-xs" placeholder="0x... token" bind:value={processTaxInput} />
						<button class="btn-primary text-xs px-4 py-1.5 cursor-pointer" disabled={busy} onclick={doProcessTax}>{busy ? '...' : 'Process'}</button>
					</div>
				</div>
			</div>
			<div class="card p-4">
				<h3 class="section-title mb-2 text-xs">DEX Router</h3>
				<div class="info-row mb-2"><span class="text-gray-500 text-xs">Current</span><span class="text-cyan-400 text-[10px] font-mono">{dexRouterAddr}</span></div>
				<div class="flex flex-col sm:flex-row gap-2">
					<input class="input-field flex-1 text-xs" placeholder="0x... new router" bind:value={newDexRouter} />
					<button class="btn-primary text-xs px-4 py-1.5 cursor-pointer" disabled={busy} onclick={doSetDexRouter}>{busy ? '...' : 'Update'}</button>
				</div>
			</div>
		</div>
	{/if}

	<!-- Protection & Withdraw -->
	<button class="collapse-header" onclick={() => toggleSection('protect')}>
		<span>Protection & Withdraw</span>
		<span class="collapse-arrow" class:open={openSections['protect']}>▸</span>
	</button>
	{#if openSections['protect']}
		<div class="collapse-body">
			<div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
				<div class="card p-5">
					<h3 class="section-title mb-3">Protection Overrides</h3>
					<div class="flex flex-col gap-3">
						<input class="input-field text-xs" placeholder="0x... token contract" bind:value={protTokenAddr} />
						<select class="input-field text-xs" bind:value={protAction}>
							<option value="unblacklist">Force Unblacklist</option>
							<option value="relaxMaxWallet">Relax Max Wallet</option>
							<option value="relaxMaxTx">Relax Max Tx</option>
							<option value="relaxCooldown">Relax Cooldown</option>
							<option value="disableBlacklist">Disable Blacklist</option>
						</select>
						{#if protAction === 'unblacklist'}
							<input class="input-field text-xs" placeholder="0x... account" bind:value={protAccountAddr} />
						{:else if protAction === 'relaxMaxWallet' || protAction === 'relaxMaxTx' || protAction === 'relaxCooldown'}
							<input class="input-field text-xs" type="number" placeholder="New value" bind:value={protAmount} />
						{/if}
						<button class="btn-danger text-xs px-4 py-1.5 cursor-pointer" disabled={busy || !protTokenAddr} onclick={doProtectionOverride}>{busy ? '...' : 'Apply Override'}</button>
					</div>
				</div>
				<div class="card p-5">
					<h3 class="section-title mb-3">Withdraw Funds</h3>
					<p class="text-xs text-gray-500 mb-3">Withdraw accumulated fees from the factory contract.</p>
					<div class="flex flex-col gap-3">
						<input class="input-field text-xs" placeholder="{ZERO_ADDRESS} for {selectedNetwork.native_coin}" bind:value={withdrawTokenAddr} />
						<button class="btn-primary text-xs px-4 py-1.5 cursor-pointer" disabled={busy} onclick={doWithdraw}>{busy ? '...' : 'Withdraw All'}</button>
					</div>
				</div>
			</div>
		</div>
	{/if}
{/if}

<style>
	.collapse-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		width: 100%;
		padding: 12px 16px;
		background: var(--bg-surface);
		border: 1px solid var(--border);
		border-radius: 10px;
		margin-bottom: 2px;
		cursor: pointer;
		font-family: 'Rajdhani', sans-serif;
		font-size: 14px;
		font-weight: 600;
		color: var(--text-heading);
		letter-spacing: 0.03em;
		transition: all 0.15s;
	}
	.collapse-header:hover { border-color: rgba(255,255,255,0.12); background: var(--bg-surface-hover); }
	.collapse-arrow { color: #64748b; transition: transform 0.2s; font-size: 12px; }
	.collapse-arrow.open { transform: rotate(90deg); }
	.collapse-body { padding: 12px 0 16px; }

	.info-grid { display: flex; flex-direction: column; gap: 2px; }
	.info-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 8px 0;
		border-bottom: 1px solid var(--bg-surface);
	}
	.info-row:last-child { border-bottom: none; }

	table { border-collapse: collapse; }
	select option { background: var(--select-bg); }

	.spinner {
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }
</style>
