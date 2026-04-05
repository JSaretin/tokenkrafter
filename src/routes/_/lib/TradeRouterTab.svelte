<script lang="ts">
	import { getContext } from 'svelte';
	import { ethers } from 'ethers';
	import type { SupportedNetwork } from '$lib/structure';
	import { TRADE_ROUTER_ABI } from '$lib/tradeRouter';

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

	// Form state
	let newFeeBps = $state('');
	let newTimeout = $state('');
	let newMaxSlippage = $state('');
	let newPlatformWallet = $state('');
	let newAdmin = $state('');
	let withdrawToken = $state('');
	let processing = $state(false);

	async function loadData() {
		if (!selectedNetwork?.trade_router_address) return;
		loading = true;
		try {
			const provider = networkProviders.get(selectedNetwork.chain_id);
			if (!provider) return;
			const router = new ethers.Contract(selectedNetwork.trade_router_address, TRADE_ROUTER_ABI, provider);

			const [o, f, t, pw, te, pc, tw, a, p, ms] = await Promise.all([
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

			const userAddr = signer ? await (signer as any).getAddress() : '';
			isOwner = userAddr ? userAddr.toLowerCase() === owner.toLowerCase() : false;

			// Get USDT earnings
			if (selectedNetwork.usdt_address) {
				try {
					const usdtC = new ethers.Contract(selectedNetwork.usdt_address, ['function decimals() view returns (uint8)'], provider);
					usdtDecimals = Number(await usdtC.decimals());
					usdtEarnings = await router.platformEarnings(selectedNetwork.usdt_address);
				} catch {}
			}

			newFeeBps = String(feeBps);
			newTimeout = String(payoutTimeout);
			newMaxSlippage = String(maxSlippageBps);
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
	<div class="flex items-center justify-center py-20">
		<div class="spinner w-10 h-10 rounded-full border-2 border-white/10 border-t-cyan-400"></div>
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
				<div class="stat-box">
					<span class="stat-label">Status</span>
					<span class="stat-value" class:text-red-400={isPaused} class:text-emerald-400={!isPaused}>
						{isPaused ? 'PAUSED' : 'ACTIVE'}
					</span>
				</div>
				<div class="stat-box">
					<span class="stat-label">Fee</span>
					<span class="stat-value text-cyan-400">{feeBps / 100}%</span>
				</div>
				<div class="stat-box">
					<span class="stat-label">Timeout</span>
					<span class="stat-value text-amber-400">{payoutTimeout}s ({Math.round(payoutTimeout / 60)}m)</span>
				</div>
				<div class="stat-box">
					<span class="stat-label">Pending</span>
					<span class="stat-value text-purple-400">{pendingCount}</span>
				</div>
			</div>
			<div class="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-3">
				<div class="stat-box">
					<span class="stat-label">Total Escrow</span>
					<span class="stat-value text-amber-400">${parseFloat(ethers.formatUnits(totalEscrow, usdtDecimals)).toFixed(2)}</span>
				</div>
				<div class="stat-box">
					<span class="stat-label">Earnings (USDT)</span>
					<span class="stat-value text-emerald-400">${parseFloat(ethers.formatUnits(usdtEarnings, usdtDecimals)).toFixed(2)}</span>
				</div>
				<div class="stat-box">
					<span class="stat-label">Total Withdrawals</span>
					<span class="stat-value text-cyan-400">{totalWithdrawals}</span>
				</div>
			</div>
		</div>

		<!-- Pause / Unpause -->
		<div class="card p-4">
			<h3 class="text-white text-sm font-semibold mb-3">Emergency Controls</h3>
			<div class="flex gap-2">
				{#if isPaused}
					<button class="btn-action btn-emerald" disabled={processing}
						onclick={() => execTx('Unpause', (r: any) => r.unpause())}>
						Unpause Trading
					</button>
				{:else}
					<button class="btn-action btn-red" disabled={processing}
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
					<label class="text-gray-400 text-xs font-mono">Fee (bps)</label>
					<input class="input-field w-24" type="number" bind:value={newFeeBps} placeholder="10" />
					<button class="btn-action btn-cyan" disabled={processing || !newFeeBps}
						onclick={() => execTx('Set fee', (r: any) => r.setFeeBps(parseInt(newFeeBps)))}>
						Set
					</button>
				</div>
				<div class="flex items-center gap-2">
					<label class="text-gray-400 text-xs font-mono">Timeout (sec)</label>
					<input class="input-field w-24" type="number" bind:value={newTimeout} placeholder="300" />
					<button class="btn-action btn-cyan" disabled={processing || !newTimeout}
						onclick={() => execTx('Set timeout', (r: any) => r.setPayoutTimeout(parseInt(newTimeout)))}>
						Set
					</button>
				</div>
				<div class="flex items-center gap-2">
					<label class="text-gray-400 text-xs font-mono">Max slippage (bps)</label>
					<input class="input-field w-24" type="number" bind:value={newMaxSlippage} placeholder="500" />
					<button class="btn-action btn-cyan" disabled={processing || !newMaxSlippage}
						onclick={() => execTx('Set max slippage', (r: any) => r.setMaxSlippage(parseInt(newMaxSlippage)))}>
						Set
					</button>
					<span class="text-[10px] text-gray-600 font-mono">{maxSlippageBps/100}%</span>
				</div>
			</div>
		</div>

		<!-- Platform Wallet -->
		<div class="card p-4">
			<h3 class="text-white text-sm font-semibold mb-3">Platform Wallet</h3>
			<p class="text-xs text-gray-500 font-mono mb-2">Current: {platformWallet}</p>
			<div class="flex gap-2">
				<input class="input-field flex-1" bind:value={newPlatformWallet} placeholder="0x..." />
				<button class="btn-action btn-cyan" disabled={processing || !newPlatformWallet}
					onclick={() => execTx('Set wallet', (r: any) => r.setPlatformWallet(newPlatformWallet))}>
					Update
				</button>
			</div>
		</div>

		<!-- Withdraw Fees -->
		<div class="card p-4">
			<h3 class="text-white text-sm font-semibold mb-3">Withdraw Platform Fees</h3>
			<p class="text-xs text-gray-500 font-mono mb-2">
				Available: ${parseFloat(ethers.formatUnits(usdtEarnings, usdtDecimals)).toFixed(2)} USDT
			</p>
			<div class="flex gap-2">
				<input class="input-field flex-1" bind:value={withdrawToken} placeholder="Token address (USDT)" />
				<button class="btn-action btn-emerald" disabled={processing || usdtEarnings === 0n}
					onclick={() => execTx('Withdraw fees', (r: any) => r.withdrawFees(withdrawToken || selectedNetwork.usdt_address))}>
					Withdraw
				</button>
			</div>
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
				<button class="btn-action btn-cyan" disabled={processing || !newAdmin}
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

<style>
	.stat-box {
		background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05);
		border-radius: 10px; padding: 10px 12px;
	}
	.stat-label { display: block; font-size: 10px; font-family: 'Space Mono', monospace; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; }
	.stat-value { display: block; font-size: 14px; font-weight: 700; font-family: 'Space Mono', monospace; margin-top: 2px; }
	.btn-action {
		padding: 6px 14px; border-radius: 8px; border: none; cursor: pointer;
		font-family: 'Space Mono', monospace; font-size: 11px; font-weight: 700;
		transition: all 150ms;
	}
	.btn-action:disabled { opacity: 0.4; cursor: not-allowed; }
	.btn-cyan { background: rgba(0,210,255,0.15); color: #00d2ff; }
	.btn-cyan:hover:not(:disabled) { background: rgba(0,210,255,0.25); }
	.btn-emerald { background: rgba(16,185,129,0.15); color: #10b981; }
	.btn-emerald:hover:not(:disabled) { background: rgba(16,185,129,0.25); }
	.btn-red { background: rgba(239,68,68,0.15); color: #f87171; }
	.btn-red:hover:not(:disabled) { background: rgba(239,68,68,0.25); }
	.spinner { animation: spin 0.8s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }
</style>
