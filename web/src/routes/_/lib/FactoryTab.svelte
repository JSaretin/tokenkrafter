<script lang="ts">
	import { getContext } from 'svelte';
	import { ethers } from 'ethers';
	import { FACTORY_ABI, ERC20_ABI, ZERO_ADDRESS } from '$lib/tokenCrafter';
	import type { SupportedNetworks, SupportedNetwork } from '$lib/structure';
	import { t } from '$lib/i18n';
	import { friendlyError } from '$lib/errorDecoder';

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

	// Partner default bases (force-merged into bases[] for partner variants)
	let partnerBases = $state<string[]>([]);
	let maxPartnerBases = $state(8);
	let addBaseInput = $state('');
	let removeBaseInput = $state('');
	let setBasesInput = $state('');

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

	// Additional admin state — loaded via individual getters since getState()
	// doesn't expose all the fields we care about.
	let authorizedRouterAddr = $state('');
	let platformWalletAddr = $state('');
	let taxSlippageBps = $state(0);

	// Form state for the new setters. Partner-base management already
	// exists via addBaseInput/removeBaseInput/setBasesInput above — these
	// are only for the four governance setters that were missing.
	let newUsdt = $state('');
	let newAuthorizedRouter = $state('');
	let newTaxSlippageBps = $state('');
	let newPlatformWallet = $state('');

	const TYPE_LABELS = ['Basic', 'Mintable', 'Taxable', 'Tax+Mint', 'Partner', 'Part+Mint', 'Part+Tax', 'Part+Tax+Mint'];

	let openSections = $state<Record<string, boolean>>({ fees: true, bases: true });
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

			// getState() packs most reads into one call: (owner, totalTokens,
			// totalFeeUsdt, feesPerType[8], countPerType[8], taxToStable,
			// taxSlippage, refLevels, autoDistribute)
			const [state, router, usdt_, bases, maxBases, authRouter, platWallet] = await Promise.all([
				contract.getState(),
				contract.dexRouter(),
				contract.usdt(),
				contract.getDefaultPartnerBases(),
				contract.MAX_DEFAULT_PARTNER_BASES(),
				contract.authorizedRouter().catch(() => ZERO_ADDRESS),
				contract.platformWallet().catch(() => ZERO_ADDRESS),
			]);

			factoryOwner = state[0];
			totalTokens = state[1];
			convertTaxEnabled = state[5];
			taxSlippageBps = Number(state[6]);
			refLevels = Number(state[7]);
			autoDistribute = state[8];
			dexRouterAddr = router;
			usdtAddr = usdt_;
			authorizedRouterAddr = authRouter;
			platformWalletAddr = platWallet;
			newAutoDistribute = autoDistribute;
			newRefLevels = String(refLevels);
			newTaxSlippageBps = String(taxSlippageBps);
			partnerBases = [...bases];
			maxPartnerBases = Number(maxBases);

			const fees: bigint[] = [...state[3]];

			const implPromises = [];
			for (let i = 0; i < 8; i++) {
				implPromises.push(contract.implementations(i));
			}
			const impls = await Promise.all(implPromises);
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

	// Partner default bases admin. Creation fees are USDT-only now —
	// the old doAddPayment/doRemovePayment functions were removed along
	// with TokenFactory.addPaymentToken/removePaymentToken. What replaces
	// them is this partner-default-bases surface: these addresses are
	// force-merged into `CreateTokenParams.bases` for every partner-variant
	// token so the platform always has pools on the bases that drive its
	// 0.5% partner fee revenue.
	async function doAddBase() {
		if (!signer) return;
		if (!ethers.isAddress(addBaseInput)) {
			addFeedback({ message: 'Invalid address', type: 'error' });
			return;
		}
		busy = true;
		try {
			const contract = getContract(signer);
			const tx = await contract.addDefaultPartnerBase(addBaseInput);
			await tx.wait();
			addFeedback({ message: 'Default partner base added', type: 'success' });
			addBaseInput = '';
			loadData();
		} catch (e: any) {
			addFeedback({ message: e.reason || e.message?.slice(0, 80), type: 'error' });
		} finally { busy = false; }
	}

	async function doRemoveBase() {
		if (!signer) return;
		if (!ethers.isAddress(removeBaseInput)) {
			addFeedback({ message: 'Invalid address', type: 'error' });
			return;
		}
		busy = true;
		try {
			const contract = getContract(signer);
			const tx = await contract.removeDefaultPartnerBase(removeBaseInput);
			await tx.wait();
			addFeedback({ message: 'Default partner base removed', type: 'success' });
			removeBaseInput = '';
			loadData();
		} catch (e: any) {
			addFeedback({ message: e.reason || e.message?.slice(0, 80), type: 'error' });
		} finally { busy = false; }
	}

	async function doSetBases() {
		if (!signer) return;
		const addrs = setBasesInput.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
		if (addrs.some(a => !ethers.isAddress(a))) {
			addFeedback({ message: 'Invalid address in list', type: 'error' });
			return;
		}
		if (addrs.length > maxPartnerBases) {
			addFeedback({ message: `Max ${maxPartnerBases} bases`, type: 'error' });
			return;
		}
		busy = true;
		try {
			const contract = getContract(signer);
			const tx = await contract.setDefaultPartnerBases(addrs);
			await tx.wait();
			addFeedback({ message: 'Default partner bases replaced', type: 'success' });
			setBasesInput = '';
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
		} catch (e) {
			addFeedback({ message: friendlyError(e), type: 'error' });
		} finally { busy = false; }
	}

	// ── Critical governance setters ────────────────────────────────────
	//
	// setAuthorizedRouter is the biggest one: it controls which address
	// can invoke routerCreateToken() on the factory. If PlatformRouter is
	// ever redeployed the new address must be authorized here — there is
	// no other path to do it without a direct contract call.

	async function doSetAuthorizedRouter() {
		if (!signer || !newAuthorizedRouter) return;
		if (!ethers.isAddress(newAuthorizedRouter)) {
			addFeedback({ message: 'Invalid address', type: 'error' });
			return;
		}
		busy = true;
		try {
			const contract = getContract(signer);
			const tx = await contract.setAuthorizedRouter(newAuthorizedRouter);
			await tx.wait();
			addFeedback({ message: 'Authorized router updated', type: 'success' });
			newAuthorizedRouter = '';
			loadData();
		} catch (e) {
			addFeedback({ message: friendlyError(e), type: 'error' });
		} finally { busy = false; }
	}

	async function doSetUsdt() {
		if (!signer || !newUsdt) return;
		if (!ethers.isAddress(newUsdt)) {
			addFeedback({ message: 'Invalid address', type: 'error' });
			return;
		}
		if (!confirm(`Change the factory's USDT address to ${newUsdt}? This affects every new token's fee accounting.`)) return;
		busy = true;
		try {
			const contract = getContract(signer);
			const tx = await contract.setUsdt(newUsdt);
			await tx.wait();
			addFeedback({ message: 'USDT address updated', type: 'success' });
			newUsdt = '';
			loadData();
		} catch (e) {
			addFeedback({ message: friendlyError(e), type: 'error' });
		} finally { busy = false; }
	}

	async function doSetPlatformWallet() {
		if (!signer || !newPlatformWallet) return;
		if (!ethers.isAddress(newPlatformWallet)) {
			addFeedback({ message: 'Invalid address', type: 'error' });
			return;
		}
		busy = true;
		try {
			const contract = getContract(signer);
			const tx = await contract.setPlatformWallet(newPlatformWallet);
			await tx.wait();
			addFeedback({ message: 'Platform wallet updated', type: 'success' });
			newPlatformWallet = '';
			loadData();
		} catch (e) {
			addFeedback({ message: friendlyError(e), type: 'error' });
		} finally { busy = false; }
	}

	async function doSetTaxSlippage() {
		if (!signer || newTaxSlippageBps === '') return;
		const bps = Number(newTaxSlippageBps);
		if (!Number.isFinite(bps) || bps < 0 || bps > 10000) {
			addFeedback({ message: 'Slippage must be 0–10000 bps', type: 'error' });
			return;
		}
		busy = true;
		try {
			const contract = getContract(signer);
			const tx = await contract.setTaxSlippage(BigInt(bps));
			await tx.wait();
			addFeedback({ message: 'Tax slippage updated', type: 'success' });
			loadData();
		} catch (e) {
			addFeedback({ message: friendlyError(e), type: 'error' });
		} finally { busy = false; }
	}

	// Partner-base add/remove/set already exist above as doAddBase,
	// doRemoveBase, doSetBases — wired to the template at the partner
	// bases section. No new handlers needed here.

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
		<div class="flex flex-col gap-0.5">
			<div class="flex justify-between items-center py-2 border-b border-surface last:border-b-0"><span class="text-gray-500 text-xs">Owner</span><span class="text-white text-xs font-mono">{factoryOwner}</span></div>
			<div class="flex justify-between items-center py-2 border-b border-surface last:border-b-0"><span class="text-gray-500 text-xs">Contract</span><span class="text-white text-xs font-mono">{selectedNetwork.platform_address}</span></div>
			<div class="flex justify-between items-center py-2 border-b border-surface last:border-b-0"><span class="text-gray-500 text-xs">DEX Router</span><span class="text-white text-xs font-mono">{formatAddress(dexRouterAddr)}</span></div>
			<div class="flex justify-between items-center py-2 border-b border-surface last:border-b-0"><span class="text-gray-500 text-xs">USDT</span><span class="text-white text-xs font-mono">{formatAddress(usdtAddr)}</span></div>
			<div class="flex justify-between items-center py-2 border-b border-surface last:border-b-0"><span class="text-gray-500 text-xs">Authorized Router</span><span class="text-white text-xs font-mono">{formatAddress(authorizedRouterAddr)}</span></div>
			<div class="flex justify-between items-center py-2 border-b border-surface last:border-b-0"><span class="text-gray-500 text-xs">Platform Wallet</span><span class="text-white text-xs font-mono">{formatAddress(platformWalletAddr)}</span></div>
			<div class="flex justify-between items-center py-2 border-b border-surface last:border-b-0"><span class="text-gray-500 text-xs">Tax Slippage</span><span class="text-white text-xs font-mono">{(taxSlippageBps / 100).toFixed(2)}%</span></div>
			<div class="flex justify-between items-center py-2 border-b border-surface last:border-b-0"><span class="text-gray-500 text-xs">Tokens Created</span><span class="text-cyan-400 text-sm font-bold">{totalTokens.toString()}</span></div>
		</div>
	</div>

	<!-- Governance — setAuthorizedRouter / setUsdt / setPlatformWallet / setTaxSlippage -->
	<button class="flex justify-between items-center w-full px-4 py-3 bg-surface border border-line rounded-[10px] mb-0.5 cursor-pointer font-numeric text-sm font-semibold text-heading tracking-[0.03em] transition-all duration-[150ms] hover:border-placeholder hover:bg-surface-hover" onclick={() => toggleSection('governance')}>
		<span>Governance</span>
		<span class={'text-dim transition-transform duration-200 text-xs ' + (openSections['governance'] ? 'rotate-90' : '')}>▸</span>
	</button>
	{#if openSections['governance']}
		<div class="pt-3 pb-4">
			<div class="card p-4 mb-3">
				<h3 class="section-title mb-2 text-xs">Authorized Router</h3>
				<p class="text-gray-500 text-xs mb-2">Only this address can call routerCreateToken(). Update when PlatformRouter is redeployed — there is no other admin path for this.</p>
				<div class="flex gap-2">
					<input class="input-field flex-1 text-xs" placeholder="0x... new PlatformRouter" bind:value={newAuthorizedRouter} />
					<button class="btn-primary text-xs px-4 py-1.5 cursor-pointer" disabled={busy || !newAuthorizedRouter} onclick={doSetAuthorizedRouter}>{busy ? '...' : 'Authorize'}</button>
				</div>
			</div>

			<div class="card p-4 mb-3">
				<h3 class="section-title mb-2 text-xs">USDT Address</h3>
				<p class="text-gray-500 text-xs mb-2">Changes the fee token. Critical — affects all new token creations.</p>
				<div class="flex gap-2">
					<input class="input-field flex-1 text-xs" placeholder="0x... new USDT" bind:value={newUsdt} />
					<button class="btn-primary text-xs px-4 py-1.5 cursor-pointer" disabled={busy || !newUsdt} onclick={doSetUsdt}>{busy ? '...' : 'Update'}</button>
				</div>
			</div>

			<div class="card p-4 mb-3">
				<h3 class="section-title mb-2 text-xs">Platform Wallet</h3>
				<p class="text-gray-500 text-xs mb-2">Destination for withdrawn fees.</p>
				<div class="flex gap-2">
					<input class="input-field flex-1 text-xs" placeholder="0x... new platform wallet" bind:value={newPlatformWallet} />
					<button class="btn-primary text-xs px-4 py-1.5 cursor-pointer" disabled={busy || !newPlatformWallet} onclick={doSetPlatformWallet}>{busy ? '...' : 'Update'}</button>
				</div>
			</div>

			<div class="card p-4">
				<h3 class="section-title mb-2 text-xs">Tax Slippage (bps)</h3>
				<p class="text-gray-500 text-xs mb-2">Slippage tolerance when converting partner tax to USDT via DEX. 100 bps = 1%.</p>
				<div class="flex gap-2">
					<input class="input-field flex-1 text-xs" type="number" min="0" max="10000" bind:value={newTaxSlippageBps} />
					<button class="btn-primary text-xs px-4 py-1.5 cursor-pointer" disabled={busy || newTaxSlippageBps === ''} onclick={doSetTaxSlippage}>{busy ? '...' : 'Update'}</button>
				</div>
			</div>
		</div>
	{/if}

	<!-- Fees & Implementations -->
	<button class="flex justify-between items-center w-full px-4 py-3 bg-surface border border-line rounded-[10px] mb-0.5 cursor-pointer font-numeric text-sm font-semibold text-heading tracking-[0.03em] transition-all duration-[150ms] hover:border-placeholder hover:bg-surface-hover" onclick={() => toggleSection('fees')}>
		<span>Fees & Implementations</span>
		<span class={'text-dim transition-transform duration-200 text-xs ' + (openSections['fees'] ? 'rotate-90' : '')}>▸</span>
	</button>
	{#if openSections['fees']}
		<div class="pt-3 pb-4">
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

	<!-- Partner default bases. Fees are USDT-only; this replaces the old
	     "Payment Tokens" admin section. These bases are force-merged into
	     every partner-variant token's bases[] at creation time. -->
	<button class="flex justify-between items-center w-full px-4 py-3 bg-surface border border-line rounded-[10px] mb-0.5 cursor-pointer font-numeric text-sm font-semibold text-heading tracking-[0.03em] transition-all duration-[150ms] hover:border-placeholder hover:bg-surface-hover" onclick={() => toggleSection('bases')}>
		<span>Partner Default Bases ({partnerBases.length}/{maxPartnerBases})</span>
		<span class={'text-dim transition-transform duration-200 text-xs ' + (openSections['bases'] ? 'rotate-90' : '')}>▸</span>
	</button>
	{#if openSections['bases']}
		<div class="pt-3 pb-4">
			<div class="card p-5 mb-3">
				<p class="text-gray-500 text-xs mb-2">Force-merged into bases[] for partner-variant tokens so the platform always has pools on these bases (drives the 0.5% partner fee).</p>
				<div class="flex flex-col gap-1.5">
					{#each partnerBases as base}
						<div class="flex justify-between items-center py-2 border-b border-surface last:border-b-0"><span class="font-mono text-xs text-cyan-400">{base}</span></div>
					{/each}
					{#if partnerBases.length === 0}<p class="text-gray-500 text-sm">No default bases set</p>{/if}
				</div>
			</div>
			<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
				<div class="card p-4">
					<div class="flex flex-col gap-2">
						<input class="input-field text-xs" placeholder="0x... base address" bind:value={addBaseInput} />
						<button class="btn-primary text-xs px-4 py-1.5 cursor-pointer" disabled={busy || partnerBases.length >= maxPartnerBases} onclick={doAddBase}>{busy ? '...' : 'Add Base'}</button>
					</div>
				</div>
				<div class="card p-4">
					<div class="flex flex-col gap-2">
						<input class="input-field text-xs" placeholder="0x... base address" bind:value={removeBaseInput} />
						<button class="btn-danger text-xs px-4 py-1.5 cursor-pointer" disabled={busy} onclick={doRemoveBase}>{busy ? '...' : 'Remove'}</button>
					</div>
				</div>
			</div>
			<div class="card p-4 mt-3">
				<div class="flex flex-col gap-2">
					<label for="ft-set-bases" class="text-xs text-gray-500">Replace entire list (comma or whitespace separated)</label>
					<input id="ft-set-bases" class="input-field text-xs" placeholder="0x..., 0x..., 0x..." bind:value={setBasesInput} />
					<button class="btn-primary text-xs px-4 py-1.5 cursor-pointer" disabled={busy} onclick={doSetBases}>{busy ? '...' : 'Replace All'}</button>
				</div>
			</div>
		</div>
	{/if}

	<!-- Referral -->
	<button class="flex justify-between items-center w-full px-4 py-3 bg-surface border border-line rounded-[10px] mb-0.5 cursor-pointer font-numeric text-sm font-semibold text-heading tracking-[0.03em] transition-all duration-[150ms] hover:border-placeholder hover:bg-surface-hover" onclick={() => toggleSection('referral')}>
		<span>Referral Program</span>
		<span class={'text-dim transition-transform duration-200 text-xs ' + (openSections['referral'] ? 'rotate-90' : '')}>▸</span>
	</button>
	{#if openSections['referral']}
		<div class="pt-3 pb-4">
			<div class="card p-5 mb-3">
				<div class="flex flex-col gap-0.5">
					<div class="flex justify-between items-center py-2 border-b border-surface last:border-b-0"><span class="text-gray-500 text-xs">Levels</span><span class="text-white text-sm">{refLevels}</span></div>
					<div class="flex justify-between items-center py-2 border-b border-surface last:border-b-0"><span class="text-gray-500 text-xs">Percents</span><span class="text-cyan-400 text-sm font-mono">{refPercents.map(p => p + '%').join(', ') || 'Not set'}</span></div>
					<div class="flex justify-between items-center py-2 border-b border-surface last:border-b-0"><span class="text-gray-500 text-xs">Auto-distribute</span><span class="text-sm {autoDistribute ? 'text-emerald-400' : 'text-gray-500'}">{autoDistribute ? 'Yes' : 'No'}</span></div>
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
	<button class="flex justify-between items-center w-full px-4 py-3 bg-surface border border-line rounded-[10px] mb-0.5 cursor-pointer font-numeric text-sm font-semibold text-heading tracking-[0.03em] transition-all duration-[150ms] hover:border-placeholder hover:bg-surface-hover" onclick={() => toggleSection('tax')}>
		<span>Tax & DEX Config</span>
		<span class={'text-dim transition-transform duration-200 text-xs ' + (openSections['tax'] ? 'rotate-90' : '')}>▸</span>
	</button>
	{#if openSections['tax']}
		<div class="pt-3 pb-4">
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
	<button class="flex justify-between items-center w-full px-4 py-3 bg-surface border border-line rounded-[10px] mb-0.5 cursor-pointer font-numeric text-sm font-semibold text-heading tracking-[0.03em] transition-all duration-[150ms] hover:border-placeholder hover:bg-surface-hover" onclick={() => toggleSection('protect')}>
		<span>Protection & Withdraw</span>
		<span class={'text-dim transition-transform duration-200 text-xs ' + (openSections['protect'] ? 'rotate-90' : '')}>▸</span>
	</button>
	{#if openSections['protect']}
		<div class="pt-3 pb-4">
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
	/* select option background is locally scoped so it needs explicit styling (not expressible as a utility). */
	table { border-collapse: collapse; }
	select option { background: var(--select-bg); }
</style>
