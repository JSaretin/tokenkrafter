<script lang="ts">
	import { getContext } from 'svelte';
	import { ethers } from 'ethers';
	import type { SupportedNetwork } from '$lib/structure';
	import { TRADE_ROUTER_ABI } from '$lib/tradeRouter';
	import { ERC20_DECIMALS_ABI } from '$lib/commonABIs';
	import Skeleton from '$lib/Skeleton.svelte';

	let { selectedNetwork }: { selectedNetwork: SupportedNetwork } = $props();

	const addFeedback = getContext<(f: { message: string; type: string }) => void>('addFeedback');
	let getSigner: () => ethers.Signer | null = getContext('signer');
	let getNetworkProviders: () => Map<number, ethers.JsonRpcProvider> = getContext('networkProviders');
	let signer = $derived(getSigner());
	let networkProviders = $derived(getNetworkProviders());

	// State
	let loading = $state(false);
	let owner = $state('');
	let isOwner = $state(false);
	let feeBps = $state(0);
	let payoutTimeout = $state(0);
	let platformWallet = $state('');
	let totalEscrow = $state(0n);
	let pendingCount = $state(0);
	let totalWithdrawals = $state(0);
	let admins = $state<string[]>([]);
	let isPaused = $state(false);
	let usdtEarnings = $state(0n);
	let usdtDecimals = $state(18);
	let maxSlippageBps = $state(0);
	let minWithdrawUsdt = $state(0n);
	let affiliateEnabled = $state(false);
	let affiliateShareBps = $state(0);

	// Form state
	let newFeeBps = $state('');
	let newTimeout = $state('');
	let newMaxSlippage = $state('');
	let newPlatformWallet = $state('');
	let newAdmin = $state('');
	let withdrawToken = $state('');
	let withdrawMode = $state('all');
	let withdrawTo = $state('');
	let withdrawAmount = $state('');
	let newMinWithdraw = $state('');
	let newAffiliateShareBps = $state('');
	let processing = $state(false);

	async function loadData() {
		if (!selectedNetwork?.trade_router_address) return;
		loading = true;
		try {
			const provider = networkProviders.get(selectedNetwork.chain_id);
			if (!provider) return;
			const router = new ethers.Contract(selectedNetwork.trade_router_address, TRADE_ROUTER_ABI, provider);

			const [o, f, t, pw, te, pc, tw, a, p, ms, mw, ae, asb] = await Promise.all([
				router.owner(),
				router.feeBps(),
				router.payoutTimeout(),
				router.platformWallet(),
				router.totalEscrow(),
				router.pendingCount(),
				router.totalWithdrawals(),
				router.getAdmins(),
				router.paused(),
				router.maxSlippageBps(),
				router.minWithdrawUsdt().catch(() => 0n),
				router.affiliateEnabled().catch(() => false),
				router.affiliateShareBps().catch(() => 0),
			]);

			owner = o;
			feeBps = Number(f);
			payoutTimeout = Number(t);
			maxSlippageBps = Number(ms);
			platformWallet = pw;
			totalEscrow = te;
			pendingCount = Number(pc);
			totalWithdrawals = Number(tw);
			admins = [...a];
			isPaused = p;
			minWithdrawUsdt = mw;
			affiliateEnabled = ae;
			affiliateShareBps = Number(asb);

			const userAddr = signer ? await (signer as any).getAddress() : '';
			isOwner = userAddr ? userAddr.toLowerCase() === owner.toLowerCase() : false;

			// Get USDT earnings
			if (selectedNetwork.usdt_address) {
				try {
					const usdtC = new ethers.Contract(selectedNetwork.usdt_address, ERC20_DECIMALS_ABI, provider);
					usdtDecimals = Number(await usdtC.decimals());
					usdtEarnings = await router.platformEarnings(selectedNetwork.usdt_address);
				} catch {}
			}

			newFeeBps = String(feeBps);
			newTimeout = String(payoutTimeout);
			newMaxSlippage = String(maxSlippageBps);
			newMinWithdraw = ethers.formatUnits(minWithdrawUsdt, usdtDecimals);
			newAffiliateShareBps = String(affiliateShareBps);
			withdrawToken = selectedNetwork.usdt_address || '';
		} catch (e: any) {
			addFeedback({ message: e.message?.slice(0, 80) || 'Failed to load', type: 'error' });
		} finally { loading = false; }
	}

	async function execTx(label: string, fn: (router: any) => Promise<any>) {
		if (!signer) { addFeedback({ message: 'Connect wallet', type: 'error' }); return; }
		processing = true;
		try {
			addFeedback({ message: `${label}...`, type: 'info' });
			const router = new ethers.Contract(selectedNetwork.trade_router_address, TRADE_ROUTER_ABI, signer);
			const tx = await fn(router);
			await tx.wait();
			addFeedback({ message: `${label} done`, type: 'success' });
			await loadData();
		} catch (e: any) {
			addFeedback({ message: e.shortMessage || e.message?.slice(0, 80) || 'Failed', type: 'error' });
		} finally { processing = false; }
	}

	$effect(() => { if (selectedNetwork?.trade_router_address) loadData(); });
</script>

{#if loading}
	<!-- Skeleton mirrors TradeRouter status grid + setting card stack. -->
	<div class="space-y-4">
		<div class="card p-4 flex flex-col gap-3">
			<Skeleton width={160} height="0.95rem" />
			<div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
				{#each Array(4) as _}
					<div class="bg-surface border border-line-subtle rounded-[10px] px-3 py-2.5 flex flex-col gap-2">
						<Skeleton width="60%" height="0.7rem" />
						<Skeleton width="80%" height="1rem" />
					</div>
				{/each}
			</div>
			<div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
				{#each Array(3) as _}
					<div class="bg-surface border border-line-subtle rounded-[10px] px-3 py-2.5 flex flex-col gap-2">
						<Skeleton width="60%" height="0.7rem" />
						<Skeleton width="80%" height="1rem" />
					</div>
				{/each}
			</div>
		</div>
		{#each Array(3) as _}
			<div class="card p-4 flex flex-col gap-2">
				<Skeleton width={140} height="0.95rem" />
				<Skeleton width="100%" height="2.25rem" radius="10px" />
			</div>
		{/each}
	</div>
{:else if !selectedNetwork?.trade_router_address}
	<div class="card p-8 text-center">
		<p class="text-gray-400">No TradeRouter deployed on this network</p>
	</div>
{:else if !isOwner}
	<div class="card p-8 text-center">
		<p class="text-gray-400 mb-2">Only the TradeRouter owner can manage settings</p>
		<p class="text-xs text-gray-600 font-mono">Owner: {owner}</p>
	</div>
{:else}
	<div class="space-y-4">
		<!-- Status Overview -->
		<div class="card p-4">
			<h3 class="text-white text-sm font-semibold mb-3">TradeRouter Status</h3>
			<div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
				<div class="bg-surface border border-line-subtle rounded-[10px] px-3 py-2.5">
					<span class="block text-3xs font-mono text-dim uppercase tracking-[0.05em]">Status</span>
					<span class={'block text-sm font-bold font-mono mt-0.5 ' + (isPaused ? 'text-red-400' : 'text-emerald-400')}>
						{isPaused ? 'PAUSED' : 'ACTIVE'}
					</span>
				</div>
				<div class="bg-surface border border-line-subtle rounded-[10px] px-3 py-2.5">
					<span class="block text-3xs font-mono text-dim uppercase tracking-[0.05em]">Fee</span>
					<span class="block text-sm font-bold font-mono mt-0.5 text-cyan-400">{feeBps / 100}%</span>
				</div>
				<div class="bg-surface border border-line-subtle rounded-[10px] px-3 py-2.5">
					<span class="block text-3xs font-mono text-dim uppercase tracking-[0.05em]">Timeout</span>
					<span class="block text-sm font-bold font-mono mt-0.5 text-amber-400">{payoutTimeout}s ({Math.round(payoutTimeout / 60)}m)</span>
				</div>
				<div class="bg-surface border border-line-subtle rounded-[10px] px-3 py-2.5">
					<span class="block text-3xs font-mono text-dim uppercase tracking-[0.05em]">Pending</span>
					<span class="block text-sm font-bold font-mono mt-0.5 text-purple-400">{pendingCount}</span>
				</div>
			</div>
			<div class="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-3">
				<div class="bg-surface border border-line-subtle rounded-[10px] px-3 py-2.5">
					<span class="block text-3xs font-mono text-dim uppercase tracking-[0.05em]">Total Escrow</span>
					<span class="block text-sm font-bold font-mono mt-0.5 text-amber-400">${parseFloat(ethers.formatUnits(totalEscrow, usdtDecimals)).toFixed(2)}</span>
				</div>
				<div class="bg-surface border border-line-subtle rounded-[10px] px-3 py-2.5">
					<span class="block text-3xs font-mono text-dim uppercase tracking-[0.05em]">Earnings (USDT)</span>
					<span class="block text-sm font-bold font-mono mt-0.5 text-emerald-400">${parseFloat(ethers.formatUnits(usdtEarnings, usdtDecimals)).toFixed(2)}</span>
				</div>
				<div class="bg-surface border border-line-subtle rounded-[10px] px-3 py-2.5">
					<span class="block text-3xs font-mono text-dim uppercase tracking-[0.05em]">Total Withdrawals</span>
					<span class="block text-sm font-bold font-mono mt-0.5 text-cyan-400">{totalWithdrawals}</span>
				</div>
			</div>
		</div>

		<!-- Pause / Unpause -->
		<div class="card p-4">
			<h3 class="text-white text-sm font-semibold mb-3">Emergency Controls</h3>
			<div class="flex gap-2">
				{#if isPaused}
					<button class="px-3.5 py-1.5 rounded-lg border-none cursor-pointer font-mono text-xs2 font-bold transition bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 disabled:opacity-40 disabled:cursor-not-allowed" disabled={processing}
						onclick={() => execTx('Unpause', (r: any) => r.unpause())}>
						Unpause Trading
					</button>
				{:else}
					<button class="px-3.5 py-1.5 rounded-lg border-none cursor-pointer font-mono text-xs2 font-bold transition bg-red-500/15 text-red-400 hover:bg-red-500/25 disabled:opacity-40 disabled:cursor-not-allowed" disabled={processing}
						onclick={() => execTx('Pause', (r: any) => r.pause())}>
						Pause Trading
					</button>
				{/if}
			</div>
		</div>

		<!-- Fee Settings -->
		<div class="card p-4">
			<h3 class="text-white text-sm font-semibold mb-3">Fee Settings</h3>
			<div class="flex flex-wrap gap-3">
				<div class="flex items-center gap-2">
					<label for="trt-fee-bps" class="text-gray-400 text-xs font-mono">Fee (bps)</label>
					<input id="trt-fee-bps" class="input-field w-24" type="number" bind:value={newFeeBps} placeholder="10" />
					<button class="px-3.5 py-1.5 rounded-lg border-none cursor-pointer font-mono text-xs2 font-bold transition bg-cyan-500/15 text-cyan-400 hover:bg-cyan-500/25 disabled:opacity-40 disabled:cursor-not-allowed" disabled={processing || !newFeeBps}
						onclick={() => execTx('Set fee', (r: any) => r.setFeeBps(parseInt(newFeeBps)))}>
						Set
					</button>
				</div>
				<div class="flex items-center gap-2">
					<label for="trt-timeout" class="text-gray-400 text-xs font-mono">Timeout (sec)</label>
					<input id="trt-timeout" class="input-field w-24" type="number" bind:value={newTimeout} placeholder="300" />
					<button class="px-3.5 py-1.5 rounded-lg border-none cursor-pointer font-mono text-xs2 font-bold transition bg-cyan-500/15 text-cyan-400 hover:bg-cyan-500/25 disabled:opacity-40 disabled:cursor-not-allowed" disabled={processing || !newTimeout}
						onclick={() => execTx('Set timeout', (r: any) => r.setPayoutTimeout(parseInt(newTimeout)))}>
						Set
					</button>
				</div>
				<div class="flex items-center gap-2">
					<label for="trt-max-slip" class="text-gray-400 text-xs font-mono">Max slippage (bps)</label>
					<input id="trt-max-slip" class="input-field w-24" type="number" bind:value={newMaxSlippage} placeholder="500" />
					<button class="px-3.5 py-1.5 rounded-lg border-none cursor-pointer font-mono text-xs2 font-bold transition bg-cyan-500/15 text-cyan-400 hover:bg-cyan-500/25 disabled:opacity-40 disabled:cursor-not-allowed" disabled={processing || !newMaxSlippage}
						onclick={() => execTx('Set max slippage', (r: any) => r.setMaxSlippage(parseInt(newMaxSlippage)))}>
						Set
					</button>
					<span class="text-3xs text-gray-600 font-mono">{maxSlippageBps/100}%</span>
				</div>
			</div>
		</div>

		<!-- Platform Wallet -->
		<div class="card p-4">
			<h3 class="text-white text-sm font-semibold mb-3">Platform Wallet</h3>
			<p class="text-xs text-gray-500 font-mono mb-2">Current: {platformWallet}</p>
			<div class="flex gap-2">
				<input class="input-field flex-1" bind:value={newPlatformWallet} placeholder="0x..." />
				<button class="px-3.5 py-1.5 rounded-lg border-none cursor-pointer font-mono text-xs2 font-bold transition bg-cyan-500/15 text-cyan-400 hover:bg-cyan-500/25 disabled:opacity-40 disabled:cursor-not-allowed" disabled={processing || !newPlatformWallet}
					onclick={() => execTx('Set wallet', (r: any) => r.setPlatformWallet(newPlatformWallet))}>
					Update
				</button>
			</div>
		</div>

		<!-- Min Withdraw -->
		<div class="card p-4">
			<h3 class="text-white text-sm font-semibold mb-3">Min Withdraw (USDT)</h3>
			<p class="text-xs text-gray-500 font-mono mb-2">
				Anti-dust floor. Users cannot request withdrawals below this amount.
				Current: <span class="text-cyan-400">{parseFloat(ethers.formatUnits(minWithdrawUsdt, usdtDecimals)).toLocaleString()} USDT</span>
			</p>
			<div class="flex gap-2">
				<input class="input-field flex-1" type="number" step="any" min="0" bind:value={newMinWithdraw} placeholder="10" />
				<button class="px-3.5 py-1.5 rounded-lg border-none cursor-pointer font-mono text-xs2 font-bold transition bg-cyan-500/15 text-cyan-400 hover:bg-cyan-500/25 disabled:opacity-40 disabled:cursor-not-allowed" disabled={processing || newMinWithdraw === ''}
					onclick={() => execTx('Set min withdraw', (r: any) => r.setMinWithdrawUsdt(ethers.parseUnits(String(newMinWithdraw || '0'), usdtDecimals)))}>
					Update
				</button>
			</div>
		</div>

		<!-- Affiliate Program -->
		<div class="card p-4">
			<h3 class="text-white text-sm font-semibold mb-3">Affiliate Program</h3>
			<p class="text-xs text-gray-500 font-mono mb-3">
				Referrers earn a share of the withdrawal fee. Share is in basis points (100 = 1%).
			</p>
			<div class="flex flex-wrap gap-3 items-center">
				<div class="flex items-center gap-2">
					<span class="text-gray-400 text-xs font-mono">Status</span>
					<span class="text-xs font-mono {affiliateEnabled ? 'text-emerald-400' : 'text-gray-500'}">
						{affiliateEnabled ? 'ENABLED' : 'DISABLED'}
					</span>
					<button class="px-3.5 py-1.5 rounded-lg border-none cursor-pointer font-mono text-xs2 font-bold transition bg-cyan-500/15 text-cyan-400 hover:bg-cyan-500/25 disabled:opacity-40 disabled:cursor-not-allowed" disabled={processing}
						onclick={() => execTx(affiliateEnabled ? 'Disable affiliate' : 'Enable affiliate', (r: any) => r.setAffiliateEnabled(!affiliateEnabled))}>
						{affiliateEnabled ? 'Disable' : 'Enable'}
					</button>
				</div>
				<div class="flex items-center gap-2">
					<label for="trt-aff-share" class="text-gray-400 text-xs font-mono">Share (bps)</label>
					<input id="trt-aff-share" class="input-field w-24" type="number" min="0" max="10000" bind:value={newAffiliateShareBps} placeholder="1000" />
					<button class="px-3.5 py-1.5 rounded-lg border-none cursor-pointer font-mono text-xs2 font-bold transition bg-cyan-500/15 text-cyan-400 hover:bg-cyan-500/25 disabled:opacity-40 disabled:cursor-not-allowed" disabled={processing || newAffiliateShareBps === ''}
						onclick={() => execTx('Set affiliate share', (r: any) => r.setAffiliateShare(parseInt(newAffiliateShareBps)))}>
						Set
					</button>
					<span class="text-3xs text-gray-600 font-mono">{(affiliateShareBps / 100).toFixed(2)}%</span>
				</div>
			</div>
		</div>

		<!-- Withdraw Funds -->
		<div class="card p-4">
			<h3 class="text-white text-sm font-semibold mb-3">Withdraw Funds</h3>
			<p class="text-xs text-gray-500 font-mono mb-2">
				Platform earnings: <span class="text-emerald-400 font-bold">${parseFloat(ethers.formatUnits(usdtEarnings, usdtDecimals)).toFixed(2)} USDT</span>
			</p>

			<!-- Withdraw mode selector -->
			<div class="flex gap-2 mb-3 flex-wrap">
				{#each [
					{ key: 'all', label: 'All USDT → Platform Wallet' },
					{ key: 'to', label: 'All USDT → Custom Address' },
					{ key: 'amount', label: 'Custom Amount → Custom Address' },
					{ key: 'eth', label: 'Withdraw BNB' },
					{ key: 'rescue', label: 'Rescue Token' },
				] as mode}
					<button class="text-3xs font-mono px-2 py-1 rounded-md cursor-pointer transition border
						{withdrawMode === mode.key ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' : 'text-gray-500 bg-transparent border-white/5'}"
						onclick={() => withdrawMode = mode.key}
					>{mode.label}</button>
				{/each}
			</div>

			{#if withdrawMode === 'all'}
				<button class="w-full px-3.5 py-1.5 rounded-lg border-none cursor-pointer font-mono text-xs2 font-bold transition bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 disabled:opacity-40 disabled:cursor-not-allowed" disabled={processing}
					onclick={() => execTx('Withdraw all USDT', (r) => r['withdraw()']())}>
					Withdraw All → Platform Wallet
				</button>

			{:else if withdrawMode === 'to'}
				<div class="flex gap-2">
					<input class="input-field flex-1" bind:value={withdrawTo} placeholder="Recipient 0x..." />
					<button class="px-3.5 py-1.5 rounded-lg border-none cursor-pointer font-mono text-xs2 font-bold transition bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 disabled:opacity-40 disabled:cursor-not-allowed" disabled={processing || !withdrawTo}
						onclick={() => execTx('Withdraw USDT', (r) => r['withdraw(address)'](withdrawTo))}>
						Withdraw
					</button>
				</div>

			{:else if withdrawMode === 'amount'}
				<div class="flex gap-2 mb-2">
					<input class="input-field flex-1" bind:value={withdrawTo} placeholder="Recipient 0x..." />
				</div>
				<div class="flex gap-2">
					<input class="input-field flex-1" type="text" bind:value={withdrawAmount} placeholder="Amount (e.g. 100)" />
					<button class="px-3.5 py-1.5 rounded-lg border-none cursor-pointer font-mono text-xs2 font-bold transition bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 disabled:opacity-40 disabled:cursor-not-allowed" disabled={processing || !withdrawTo || !withdrawAmount}
						onclick={() => execTx('Withdraw amount', (r) => r['withdraw(address,uint256)'](withdrawTo, ethers.parseUnits(withdrawAmount, usdtDecimals)))}>
						Withdraw
					</button>
				</div>

			{:else if withdrawMode === 'eth'}
				<button class="w-full px-3.5 py-1.5 rounded-lg border-none cursor-pointer font-mono text-xs2 font-bold transition bg-cyan-500/15 text-cyan-400 hover:bg-cyan-500/25 disabled:opacity-40 disabled:cursor-not-allowed" disabled={processing}
					onclick={() => execTx('Withdraw BNB', (r) => r.withdrawETH())}>
					Withdraw All BNB → Platform Wallet
				</button>

			{:else if withdrawMode === 'rescue'}
				<div class="flex gap-2">
					<input class="input-field flex-1" bind:value={withdrawToken} placeholder="Token address to rescue" />
					<button class="px-3.5 py-1.5 rounded-lg border-none cursor-pointer font-mono text-xs2 font-bold transition bg-cyan-500/15 text-cyan-400 hover:bg-cyan-500/25 disabled:opacity-40 disabled:cursor-not-allowed" disabled={processing || !withdrawToken}
						onclick={() => execTx('Rescue token', (r) => r.rescueToken(withdrawToken))}>
						Rescue
					</button>
				</div>
				<p class="text-3xs text-gray-600 font-mono mt-1">Rescues stuck tokens. For USDT, only withdraws above escrow.</p>
			{/if}
		</div>

		<!-- Admins -->
		<div class="card p-4">
			<h3 class="text-white text-sm font-semibold mb-3">On-Chain Admins (can confirm withdrawals)</h3>
			<div class="space-y-1 mb-3">
				{#each admins as admin}
					<div class="flex items-center justify-between bg-white/[0.02] rounded-lg px-3 py-2">
						<span class="text-xs font-mono text-gray-300">{admin}</span>
						<button class="text-red-400 text-xs font-mono hover:text-red-300 cursor-pointer" disabled={processing}
							onclick={() => execTx('Remove admin', (r: any) => r.removeAdmin(admin))}>
							Remove
						</button>
					</div>
				{/each}
				{#if admins.length === 0}
					<p class="text-gray-500 text-xs">No admins configured</p>
				{/if}
			</div>
			<div class="flex gap-2">
				<input class="input-field flex-1" bind:value={newAdmin} placeholder="0x..." />
				<button class="px-3.5 py-1.5 rounded-lg border-none cursor-pointer font-mono text-xs2 font-bold transition bg-cyan-500/15 text-cyan-400 hover:bg-cyan-500/25 disabled:opacity-40 disabled:cursor-not-allowed" disabled={processing || !newAdmin}
					onclick={() => execTx('Add admin', (r: any) => r.addAdmin(newAdmin))}>
					Add Admin
				</button>
			</div>
		</div>

		<!-- Contract Info -->
		<div class="card p-4">
			<h3 class="text-white text-sm font-semibold mb-3">Contract Info</h3>
			<div class="space-y-1 text-xs font-mono text-gray-500">
				<div class="flex justify-between"><span>Address</span><span class="text-gray-300">{selectedNetwork.trade_router_address}</span></div>
				<div class="flex justify-between"><span>Owner</span><span class="text-gray-300">{owner}</span></div>
				<div class="flex justify-between"><span>DEX Router</span><span class="text-gray-300">{selectedNetwork.dex_router}</span></div>
			</div>
		</div>
	</div>
{/if}
