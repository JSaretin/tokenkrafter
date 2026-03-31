<script lang="ts">
	import { getContext } from 'svelte';
	import { ethers } from 'ethers';
	import type { SupportedNetwork } from '$lib/structure';
	import { TRADE_ROUTER_ABI } from '$lib/tradeRouter';

	const addFeedback = getContext<(f: { message: string; type: string }) => void>('addFeedback');
	let getSigner: () => ethers.Signer | null = getContext('signer');
	const supportedNetworks: SupportedNetwork[] = getContext('supportedNetworks');
	let signer = $derived(getSigner());

	let withdrawFilter = $state<'pending' | 'timeout' | 'all'>('pending');
	let tickNow = $state(Date.now());
	const tickInterval = setInterval(() => { tickNow = Date.now(); }, 1000);
	let pendingWithdrawals: any[] = $state([]);
	let timeoutWithdrawals: any[] = $state([]);
	let allWithdrawals: any[] = $state([]);
	let withdrawalsLoading = $state(false);
	let processingId = $state<number | null>(null);
	let nairaRate = $state('1600');

	// Fetch live rate on mount
	$effect(() => {
		(async () => {
			try {
				const res = await fetch('/api/rates?currencies=NGN');
				if (res.ok) {
					const data = await res.json();
					if (data.rates?.NGN) nairaRate = String(Math.round(data.rates.NGN * 0.997)); // 0.3% spread
				}
			} catch {}
		})();
	});

	async function loadWithdrawals() {
		withdrawalsLoading = true;
		try {
			if (withdrawFilter === 'pending' || withdrawFilter === 'timeout') {
				const res = await fetch('/api/withdrawals?status=pending');
				if (res.ok) {
					const data = await res.json();
					const now = Math.floor(Date.now() / 1000);
					// Split: active pending (within timeout) vs timed out
					pendingWithdrawals = data.filter((w: any) => {
						const created = Math.floor(new Date(w.created_at).getTime() / 1000);
						return (now - created) < 300;
					});
					timeoutWithdrawals = data.filter((w: any) => {
						const created = Math.floor(new Date(w.created_at).getTime() / 1000);
						return (now - created) >= 300;
					});
				}
			} else {
				const res = await fetch('/api/withdrawals');
				if (res.ok) allWithdrawals = await res.json();
			}
		} catch {}
		finally { withdrawalsLoading = false; }
	}

	async function confirmWithdrawal(dbId: number, withdrawId: number, chainId: number) {
		if (!signer) {
			addFeedback({ message: 'Connect wallet first', type: 'error' });
			return;
		}
		processingId = dbId;
		try {
			// Find network with trade router
			const network = supportedNetworks.find(n => n.chain_id === chainId && n.trade_router_address);
			if (!network) {
				addFeedback({ message: 'No trade router on this chain', type: 'error' });
				return;
			}

			// Call on-chain confirm first
			addFeedback({ message: 'Confirming on-chain...', type: 'info' });
			const router = new ethers.Contract(network.trade_router_address, TRADE_ROUTER_ABI, signer);
			const tx = await router.confirm(withdrawId);
			await tx.wait();

			// Then update DB
			const res = await fetch('/api/withdrawals', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id: dbId, status: 'confirmed', admin_note: 'Confirmed on-chain by admin' })
			});
			if (res.ok) {
				addFeedback({ message: 'Withdrawal confirmed on-chain + DB', type: 'success' });
				loadWithdrawals();
			}
		} catch (e: any) {
			addFeedback({ message: e.shortMessage || e.message || 'Confirm failed', type: 'error' });
		} finally { processingId = null; }
	}

	async function processWithFlutterwave(id: number) {
		processingId = id;
		try {
			const res = await fetch('/api/withdrawals/process', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ withdrawal_id: id, naira_rate: parseFloat(nairaRate) })
			});
			const data = await res.json();
			if (data.success) {
				addFeedback({ message: `Transfer initiated: NGN ${data.ngn_amount?.toLocaleString()} @ rate ${data.rate}`, type: 'success' });
				loadWithdrawals();
			} else {
				addFeedback({ message: data.error || 'Transfer failed', type: 'error' });
			}
		} catch (e: any) {
			addFeedback({ message: e.message, type: 'error' });
		} finally { processingId = null; }
	}

	async function cancelWithdrawal(id: number) {
		processingId = id;
		try {
			const res = await fetch('/api/withdrawals', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id, status: 'cancelled', admin_note: 'Cancelled by admin' })
			});
			if (res.ok) {
				addFeedback({ message: 'Withdrawal cancelled', type: 'success' });
				loadWithdrawals();
			}
		} catch (e: any) {
			addFeedback({ message: e.message, type: 'error' });
		} finally { processingId = null; }
	}

	// Auto-load on mount
	$effect(() => { loadWithdrawals(); });
</script>

<div class="space-y-4">
	<!-- Controls -->
	<div class="card p-4">
		<div class="flex flex-wrap items-center gap-3">
			<div class="flex gap-1">
				{#each [
					{ key: 'pending', label: 'Pending', count: pendingWithdrawals.length },
					{ key: 'timeout', label: 'Timed Out', count: timeoutWithdrawals.length },
					{ key: 'all', label: 'All', count: 0 }
				] as tab}
					<button class="text-xs font-mono px-3 py-1.5 rounded-lg cursor-pointer transition
						{withdrawFilter === tab.key ? 'bg-cyan-500/15 text-cyan-400 border border-cyan-500/30' : 'text-gray-500 bg-[var(--bg-surface-hover)] border border-transparent'}"
						onclick={() => { withdrawFilter = tab.key as any; loadWithdrawals(); }}
					>
						{tab.label}
						{#if tab.count > 0}
							<span class="ml-1 text-[9px] {tab.key === 'timeout' ? 'text-red-400' : ''}">{tab.count}</span>
						{/if}
					</button>
				{/each}
			</div>
			<div class="flex items-center gap-2 ml-auto">
				<label class="text-xs text-gray-500 font-mono">NGN Rate:</label>
				<input class="input-field text-xs" style="width: 100px;" type="number" bind:value={nairaRate} />
			</div>
			<button class="btn-secondary text-xs px-3 py-1.5 cursor-pointer" onclick={loadWithdrawals}>
				Refresh
			</button>
		</div>
	</div>

	<!-- Withdrawal list -->
	{#if withdrawalsLoading}
		<div class="card p-8 text-center">
			<div class="spinner mx-auto mb-3"></div>
			<span class="text-gray-500 font-mono text-xs">Loading...</span>
		</div>
	{:else}
		{@const list = withdrawFilter === 'pending' ? pendingWithdrawals : withdrawFilter === 'timeout' ? timeoutWithdrawals : allWithdrawals}
		{#if list.length === 0}
			<div class="card p-8 text-center">
				<p class="text-gray-500 font-mono text-sm">No {withdrawFilter} withdrawals</p>
			</div>
		{:else}
			{#each list as w}
				{@const details = w.payment_details || {}}
				{@const isPending = w.status === 'pending'}
				{@const usdtAmount = parseFloat(w.gross_amount || '0') / 1e6}
				{@const ngnAmount = usdtAmount * parseFloat(nairaRate)}
				{@const createdTs = Math.floor(new Date(w.created_at).getTime() / 1000)}
				{@const elapsed = Math.floor(tickNow / 1000) - createdTs}
				{@const remaining = Math.max(0, 300 - elapsed)}
				{@const timedOut = isPending && remaining <= 0}
				<div class="card p-4" style={isPending ? 'border-color: rgba(245,158,11,0.2);' : ''}>
					<div class="flex items-start justify-between gap-4 mb-3">
						<div>
							<div class="flex items-center gap-2 mb-1">
								<span class="font-mono text-sm font-bold text-white">
									${usdtAmount.toFixed(2)} USDT
								</span>
								<span class="text-[10px] font-mono px-2 py-0.5 rounded-full
									{w.status === 'pending' ? 'bg-amber-500/15 text-amber-400' :
									 w.status === 'confirmed' ? 'bg-emerald-500/15 text-emerald-400' :
									 w.status === 'processing' ? 'bg-cyan-500/15 text-cyan-400' :
									 'bg-red-500/15 text-red-400'}"
								>{w.status}</span>
							</div>
							<span class="text-[10px] text-gray-600 font-mono">{w.wallet_address?.slice(0, 8)}...{w.wallet_address?.slice(-6)}</span>
						</div>
						<div class="text-right">
							<span class="text-sm font-mono font-bold text-emerald-400">
								NGN {ngnAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })}
							</span>
							<div class="text-[10px] text-gray-600 font-mono">
								{new Date(w.created_at).toLocaleString()}
							</div>
						</div>
					</div>

					<!-- Payment details -->
					<div class="bg-[var(--bg-surface-input)] rounded-lg p-3 mb-3">
						<div class="flex justify-between text-xs font-mono mb-1">
							<span class="text-gray-500">Method</span>
							<span class="text-white">{w.payment_method || 'bank'}</span>
						</div>
						{#if details.bank_code}
							<div class="flex justify-between text-xs font-mono mb-1">
								<span class="text-gray-500">Bank</span>
								<span class="text-white">{details.bank_name || details.bank_code}</span>
							</div>
							<div class="flex justify-between text-xs font-mono mb-1">
								<span class="text-gray-500">Account</span>
								<span class="text-white">{details.account}</span>
							</div>
							{#if details.holder}
								<div class="flex justify-between text-xs font-mono">
									<span class="text-gray-500">Name</span>
									<span class="text-emerald-400 font-semibold">{details.holder}</span>
								</div>
							{/if}
						{:else if details.email}
							<div class="flex justify-between text-xs font-mono">
								<span class="text-gray-500">Email</span>
								<span class="text-white">{details.email}</span>
							</div>
						{/if}
					</div>

					<!-- Fee breakdown -->
					<div class="flex gap-4 text-[10px] font-mono text-gray-500 mb-3">
						<span>Gross: ${(parseFloat(w.gross_amount || '0') / 1e6).toFixed(2)}</span>
						<span>Fee: ${(parseFloat(w.fee || '0') / 1e6).toFixed(4)}</span>
						<span>Net: ${usdtAmount.toFixed(2)}</span>
						{#if w.admin_note}
							<span class="text-gray-600 truncate max-w-[200px]">{w.admin_note}</span>
						{/if}
					</div>

					<!-- Actions -->
					{#if isPending}
						<div class="countdown-strip mb-3">
							<div class="countdown-bar">
								<div class="countdown-fill" style="width: {Math.min(100, (elapsed / 300) * 100)}%; background: {timedOut ? 'linear-gradient(90deg, #f87171, #dc2626)' : 'linear-gradient(90deg, #f59e0b, #d97706)'}"></div>
							</div>
							<div class="flex justify-between items-center mt-1">
								{#if timedOut}
									<span class="text-[10px] font-mono text-red-400 font-bold">TIMED OUT — user can cancel</span>
								{:else}
									<span class="text-[10px] font-mono text-amber-400">{Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')} remaining</span>
								{/if}
								<span class="text-[10px] font-mono text-gray-600">{elapsed}s elapsed</span>
							</div>
						</div>
						{#if timedOut}
							<!-- Timed out: can't confirm on-chain anymore -->
							<div class="text-center py-2">
								<span class="text-xs font-mono text-red-400">Cannot confirm — contract timeout reached. User may cancel anytime.</span>
							</div>
						{:else}
						<div class="flex gap-2">
							<button
								class="btn-primary text-xs px-4 py-2 cursor-pointer flex-1"
								disabled={processingId === w.id}
								onclick={() => confirmWithdrawal(w.id, w.withdraw_id, w.chain_id)}
							>
								{processingId === w.id ? 'Processing...' : 'Confirm (Manual)'}
							</button>
							<button
								class="text-xs px-4 py-2 cursor-pointer rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition flex-1"
								disabled={processingId === w.id}
								onclick={() => processWithFlutterwave(w.id)}
							>
								{processingId === w.id ? 'Sending...' : `Send NGN ${ngnAmount.toLocaleString(undefined, {maximumFractionDigits: 0})}`}
							</button>
							<button
								class="btn-danger text-xs px-3 py-2 cursor-pointer"
								disabled={processingId === w.id}
								onclick={() => cancelWithdrawal(w.id)}
							>
								Cancel
							</button>
						</div>
					{/if}
					{/if}
				</div>
			{/each}
		{/if}
	{/if}
</div>

<style>
	.spinner {
		width: 24px; height: 24px;
		border: 2px solid var(--border);
		border-top-color: #00d2ff;
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }
	.countdown-strip { padding: 0 2px; }
	.countdown-bar {
		width: 100%; height: 4px; background: var(--bg-surface-hover);
		border-radius: 2px; overflow: hidden;
	}
	.countdown-fill { height: 100%; border-radius: 2px; transition: width 1s linear; }
</style>
