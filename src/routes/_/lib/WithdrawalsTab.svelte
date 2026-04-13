<script lang="ts">
	import { getContext, onDestroy } from 'svelte';
	import { supabase } from '$lib/supabaseClient';
	import { ethers } from 'ethers';
	import type { SupportedNetwork } from '$lib/structure';
	import { TRADE_ROUTER_ABI } from '$lib/tradeRouter';
	import { ERC20_DECIMALS_ABI } from '$lib/commonABIs';

	const addFeedback = getContext<(f: { message: string; type: string }) => void>('addFeedback');
	let getSigner: () => ethers.Signer | null = getContext('signer');
	let _getNetworks: () => SupportedNetwork[] = getContext('supportedNetworks');
	let supportedNetworks = $derived(_getNetworks());
	let signer = $derived(getSigner());

	let getNetworkProviders: () => Map<number, ethers.JsonRpcProvider> = getContext('networkProviders');
	let networkProviders = $derived(getNetworkProviders());

	let withdrawFilter = $state<'pending' | 'timeout' | 'all'>('pending');

	// Cache USDT decimals per chain (BSC=18, ETH=6, etc.)
	let usdtDecimalsMap: Record<number, number> = $state({});
	async function getUsdtDecimals(chainId: number): Promise<number> {
		if (usdtDecimalsMap[chainId]) return usdtDecimalsMap[chainId];
		const net = supportedNetworks.find((n: any) => n.chain_id === chainId);
		if (!net?.usdt_address) return 18;
		try {
			const provider = networkProviders.get(chainId);
			if (!provider) return 18;
			const token = new ethers.Contract(net.usdt_address, ERC20_DECIMALS_ABI, provider);
			const d = Number(await token.decimals());
			usdtDecimalsMap = { ...usdtDecimalsMap, [chainId]: d };
			return d;
		} catch { return 18; }
	}

	/** Format a raw USDT amount string for display */
	function fmtUsdt(raw: string, chainDecimals: number = 18): string {
		try {
			return parseFloat(ethers.formatUnits(raw || '0', chainDecimals)).toFixed(2);
		} catch { return '0.00'; }
	}
	let tickNow = $state(Date.now());
	const tickInterval = setInterval(() => { tickNow = Date.now(); }, 1000);
	let pendingWithdrawals: any[] = $state([]);
	let timeoutWithdrawals: any[] = $state([]);
	let allWithdrawals: any[] = $state([]);
	let withdrawalsLoading = $state(false);
	let processingId = $state<number | null>(null);
	let nairaRate = $state('1600');

	// Confirm modal state
	let showConfirmModal = $state(false);
	let confirmTarget = $state<any>(null); // the withdrawal to confirm
	let confirmMode = $state<'default' | 'custom-wallet' | 'custom-amount'>('default');
	let confirmTo = $state('');
	let confirmAmount = $state('');

	// Fetch live rate on mount (run once)
	let rateLoaded = false;
	$effect(() => {
		if (rateLoaded) return;
		rateLoaded = true;
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

	/** Enrich DB records with on-chain expiresAt for pending withdrawals. */
	async function enrichWithOnChain(records: any[]): Promise<any[]> {
		const withOnChain = records.filter((w: any) => w.withdraw_id != null && w.chain_id);
		if (withOnChain.length === 0) return records;

		// Group by chain to minimize provider lookups
		const byChain = new Map<number, any[]>();
		for (const w of withOnChain) {
			const arr = byChain.get(w.chain_id) || [];
			arr.push(w);
			byChain.set(w.chain_id, arr);
		}

		for (const [chainId, ws] of byChain) {
			const network = supportedNetworks.find((n: any) => n.chain_id === chainId && n.trade_router_address);
			if (!network) continue;
			const provider = networkProviders.get(chainId);
			if (!provider) continue;

			const router = new ethers.Contract(network.trade_router_address, TRADE_ROUTER_ABI, provider);
			await Promise.all(ws.map(async (w: any) => {
				try {
					const onChain = await router.getWithdrawal(w.withdraw_id);
					w._expiresAt = Number(onChain.expiresAt);
					w._createdAt = Number(onChain.createdAt);
					w._onChainStatus = Number(onChain.status);
				} catch {}
			}));
		}

		return records;
	}

	/** Read on-chain pending IDs and build a set for fast lookup. */
	async function getOnChainPendingIds(): Promise<Map<number, Set<number>>> {
		const result = new Map<number, Set<number>>();
		for (const network of supportedNetworks) {
			if (!network.trade_router_address) continue;
			const provider = networkProviders.get(network.chain_id);
			if (!provider) continue;
			try {
				const router = new ethers.Contract(network.trade_router_address, TRADE_ROUTER_ABI, provider);
				const count = Number(await router.pendingCount());
				const ids = new Set<number>();
				for (let i = 0; i < count; i++) {
					ids.add(Number(await router.pendingIds(i)));
				}
				result.set(network.chain_id, ids);
			} catch {}
		}
		return result;
	}

	async function loadWithdrawals() {
		withdrawalsLoading = true;
		try {
			if (withdrawFilter === 'pending' || withdrawFilter === 'timeout') {
				// Read on-chain pending IDs first — source of truth
				const onChainPending = await getOnChainPendingIds();

				const res = await fetch('/api/withdrawals?status=pending');
				if (res.ok) {
					let data = await res.json();

					// Only keep DB records that actually exist on-chain as pending
					data = data.filter((w: any) => {
						if (w.withdraw_id == null) return false;
						const chainIds = onChainPending.get(w.chain_id);
						return chainIds?.has(w.withdraw_id) ?? false;
					});

					data = await enrichWithOnChain(data);

					const now = Math.floor(Date.now() / 1000);
					pendingWithdrawals = data.filter((w: any) => {
						if (!w._expiresAt) return true;
						return now < w._expiresAt;
					});
					timeoutWithdrawals = data.filter((w: any) => {
						if (!w._expiresAt) return false;
						return now >= w._expiresAt;
					});
				}
			} else {
				const res = await fetch('/api/withdrawals');
				if (res.ok) {
					let data = await res.json();
					data = await enrichWithOnChain(data);
					allWithdrawals = data;
				}
			}
			// Preload USDT decimals for all chains in results
			const allData = [...pendingWithdrawals, ...timeoutWithdrawals, ...allWithdrawals];
			const chainIds = [...new Set(allData.map((w: any) => w.chain_id).filter(Boolean))];
			await Promise.all(chainIds.map(id => getUsdtDecimals(id)));
		} catch {}
		finally { withdrawalsLoading = false; }
	}

	function openConfirmModal(w: any) {
		confirmTarget = w;
		confirmMode = 'default';
		confirmTo = '';
		confirmAmount = '';
		showConfirmModal = true;
	}

	async function executeConfirm() {
		const w = confirmTarget;
		if (!w || !signer) {
			addFeedback({ message: 'Connect wallet first', type: 'error' });
			return;
		}
		processingId = w.id;
		showConfirmModal = false;
		try {
			const network = supportedNetworks.find((n: any) => n.chain_id === w.chain_id && n.trade_router_address);
			if (!network) {
				addFeedback({ message: 'No trade router on this chain', type: 'error' });
				return;
			}

			addFeedback({ message: 'Confirming on-chain...', type: 'info' });
			const router = new ethers.Contract(network.trade_router_address, TRADE_ROUTER_ABI, signer);

			let tx;
			let note = '';
			if (confirmMode === 'custom-amount' && confirmTo && confirmAmount) {
				const chainDec = usdtDecimalsMap[w.chain_id] || 18;
				const parsedAmount = ethers.parseUnits(confirmAmount, chainDec);
				tx = await router['confirm(uint256,address,uint256)'](w.withdraw_id, confirmTo, parsedAmount);
				note = `Confirmed: ${confirmAmount} to ${confirmTo.slice(0, 8)}..., rest to platform`;
			} else if (confirmMode === 'custom-wallet' && confirmTo) {
				tx = await router['confirm(uint256,address)'](w.withdraw_id, confirmTo);
				note = `Confirmed: sent to ${confirmTo.slice(0, 8)}...`;
			} else {
				tx = await router['confirm(uint256)'](w.withdraw_id);
				note = 'Confirmed on-chain by admin';
			}
			await tx.wait();

			await fetch('/api/withdrawals', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id: w.id, status: 'confirmed', admin_note: note })
			});
			addFeedback({ message: 'Withdrawal confirmed', type: 'success' });
			loadWithdrawals();
		} catch (e: any) {
			addFeedback({ message: e.shortMessage || e.message || 'Confirm failed', type: 'error' });
		} finally { processingId = null; }
	}

	async function processWithFlutterwave(w: any) {
		processingId = w.id;
		try {
			const res = await fetch('/api/withdrawals/process', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ withdraw_id: w.withdraw_id, chain_id: w.chain_id, naira_rate: parseFloat(nairaRate) })
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

	/** Refund a timed-out withdrawal on-chain — returns escrowed USDT to the user. */
	async function refundWithdrawal(w: any) {
		if (!signer) { addFeedback({ message: 'Connect admin wallet first', type: 'error' }); return; }
		if (w.withdraw_id == null) { addFeedback({ message: 'No on-chain withdraw ID', type: 'error' }); return; }

		processingId = w.id;
		try {
			const network = supportedNetworks.find((n: any) => n.chain_id === w.chain_id && n.trade_router_address);
			if (!network) { addFeedback({ message: 'No trade router on this chain', type: 'error' }); return; }

			addFeedback({ message: 'Refunding on-chain...', type: 'info' });
			const router = new ethers.Contract(network.trade_router_address, TRADE_ROUTER_ABI, signer);
			const tx = await router.refund(w.withdraw_id);
			await tx.wait();

			// Update DB status
			await fetch('/api/withdrawals', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id: w.id, status: 'cancelled', admin_note: `Refunded on-chain by admin. USDT returned to user.` })
			});

			addFeedback({ message: 'Withdrawal refunded — USDT returned to user', type: 'success' });
			loadWithdrawals();
		} catch (e: any) {
			addFeedback({ message: e.shortMessage || e.message || 'Refund failed', type: 'error' });
		} finally { processingId = null; }
	}

	let channels: any[] = [];

	// Auto-load on mount (once)
	let _mounted = false;
	$effect(() => {
		if (_mounted) return;
		_mounted = true;

		loadWithdrawals();

		const withdrawalsChannel = supabase
			.channel('admin-withdrawals')
			.on('postgres_changes', { event: '*', schema: 'public', table: 'withdrawal_requests' }, () => {
				loadWithdrawals();
			})
			.subscribe();
		channels.push(withdrawalsChannel);
	});

	onDestroy(() => {
		channels.forEach(c => supabase.removeChannel(c));
	});
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
				{@const chainDec = usdtDecimalsMap[w.chain_id] || 18}
							{@const usdtAmount = parseFloat(ethers.formatUnits(w.net_amount || w.gross_amount || '0', chainDec))}
				{@const ngnAmount = usdtAmount * parseFloat(nairaRate)}
				{@const createdTs = Math.floor(new Date(w.created_at).getTime() / 1000)}
				{@const expiresTs = w._expiresAt || (w.expires_at ? Math.floor(new Date(w.expires_at).getTime() / 1000) : 0)}
				{@const nowSec = Math.floor(tickNow / 1000)}
				{@const remaining = Math.max(0, expiresTs - nowSec)}
				{@const totalDuration = expiresTs - createdTs}
				{@const elapsed = nowSec - createdTs}
				{@const timedOut = isPending && remaining <= 0}
				<div class="card p-4" style={isPending ? 'border-color: rgba(245,158,11,0.2);' : ''}>
					<div class="flex items-start justify-between gap-4 mb-3">
						<div>
							<div class="flex items-center gap-2 mb-1">
								<span class="font-mono text-sm font-bold text-white">
									${usdtAmount.toFixed(2)}
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
						<span>Gross: ${fmtUsdt(w.gross_amount, usdtDecimalsMap[w.chain_id] || 18)}</span>
						<span>Fee: ${fmtUsdt(w.fee, usdtDecimalsMap[w.chain_id] || 18)}</span>
						<span>Net: ${usdtAmount.toFixed(2)}</span>
						{#if w.admin_note}
							<span class="text-gray-600 truncate max-w-[200px]">{w.admin_note}</span>
						{/if}
					</div>

					<!-- Actions -->
					{#if isPending}
						<div class="countdown-strip mb-3">
							<div class="countdown-bar">
								<div class="countdown-fill" style="width: {totalDuration > 0 ? Math.min(100, (elapsed / totalDuration) * 100) : 100}%; background: {timedOut ? 'linear-gradient(90deg, #f87171, #dc2626)' : 'linear-gradient(90deg, #f59e0b, #d97706)'}"></div>
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
							<!-- Timed out: offer refund to return USDT to user -->
							<div class="flex gap-2">
								<button
									class="text-xs px-4 py-2 cursor-pointer rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 transition flex-1"
									disabled={processingId === w.id}
									onclick={() => refundWithdrawal(w)}
								>
									{processingId === w.id ? 'Refunding...' : 'Refund to user'}
								</button>
								<button
									class="btn-danger text-xs px-3 py-2 cursor-pointer"
									disabled={processingId === w.id}
									onclick={() => cancelWithdrawal(w.id)}
								>
									Cancel (DB only)
								</button>
							</div>
							<p class="text-[10px] font-mono text-gray-600 mt-1">Refund returns escrowed USDT to the user's wallet on-chain.</p>
						{:else}
						<div class="flex gap-2">
							<button
								class="btn-primary text-xs px-4 py-2 cursor-pointer flex-1"
								disabled={processingId === w.id}
								onclick={() => openConfirmModal(w)}
							>
								{processingId === w.id ? 'Processing...' : 'Confirm'}
							</button>
							<button
								class="text-xs px-4 py-2 cursor-pointer rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition flex-1"
								disabled={processingId === w.id}
								onclick={() => processWithFlutterwave(w)}
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

<!-- Confirm Modal -->
{#if showConfirmModal && confirmTarget}
	{@const w = confirmTarget}
	{@const chainDec = usdtDecimalsMap[w.chain_id] || 18}
	{@const netUsdt = parseFloat(ethers.formatUnits(w.net_amount || w.gross_amount || '0', chainDec))}
	<div class="modal-backdrop" onclick={() => { showConfirmModal = false; }} role="dialog" aria-modal="true">
		<div class="confirm-modal" onclick={(e) => e.stopPropagation()}>
			<div class="modal-header">
				<h3>Confirm Withdrawal #{w.withdraw_id}</h3>
				<button class="modal-close" onclick={() => { showConfirmModal = false; }}>
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
				</button>
			</div>

			<div class="modal-body">
				<!-- Summary -->
				<div class="confirm-summary">
					<div class="flex justify-between text-xs font-mono mb-1">
						<span class="text-gray-500">Net Amount</span>
						<span class="text-white font-bold">${netUsdt.toFixed(2)}</span>
					</div>
					<div class="flex justify-between text-xs font-mono mb-1">
						<span class="text-gray-500">User</span>
						<span class="text-gray-300">{w.wallet_address?.slice(0, 10)}...{w.wallet_address?.slice(-6)}</span>
					</div>
					{#if w.payment_details?.holder}
						<div class="flex justify-between text-xs font-mono">
							<span class="text-gray-500">Pay to</span>
							<span class="text-emerald-400">{w.payment_details.holder}</span>
						</div>
					{/if}
				</div>

				<!-- Mode selector -->
				<div class="confirm-modes">
					<button class="confirm-mode-btn" class:confirm-mode-active={confirmMode === 'default'}
						onclick={() => { confirmMode = 'default'; }}>
						<span class="confirm-mode-icon">→</span>
						<div>
							<span class="confirm-mode-title">Default</span>
							<span class="confirm-mode-desc">Send to platform wallet</span>
						</div>
					</button>
					<button class="confirm-mode-btn" class:confirm-mode-active={confirmMode === 'custom-wallet'}
						onclick={() => { confirmMode = 'custom-wallet'; }}>
						<span class="confirm-mode-icon">⇄</span>
						<div>
							<span class="confirm-mode-title">Custom Wallet</span>
							<span class="confirm-mode-desc">Send full amount to another address</span>
						</div>
					</button>
					<button class="confirm-mode-btn" class:confirm-mode-active={confirmMode === 'custom-amount'}
						onclick={() => { confirmMode = 'custom-amount'; }}>
						<span class="confirm-mode-icon">÷</span>
						<div>
							<span class="confirm-mode-title">Split</span>
							<span class="confirm-mode-desc">Custom amount to address, rest to platform</span>
						</div>
					</button>
				</div>

				<!-- Custom fields -->
				{#if confirmMode === 'custom-wallet' || confirmMode === 'custom-amount'}
					<div class="confirm-fields">
						<label class="text-[10px] text-gray-500 font-mono uppercase">Recipient Address</label>
						<input class="input-field text-xs" bind:value={confirmTo} placeholder="0x..." />
					</div>
				{/if}
				{#if confirmMode === 'custom-amount'}
					<div class="confirm-fields">
						<label class="text-[10px] text-gray-500 font-mono uppercase">Amount (USDT)</label>
						<div class="flex gap-2 items-center">
							<input class="input-field text-xs flex-1" type="number" bind:value={confirmAmount} placeholder="0.00" />
							<button class="text-[10px] text-cyan-400 font-mono cursor-pointer" onclick={() => { confirmAmount = String(netUsdt); }}>MAX</button>
						</div>
					</div>
				{/if}

				<!-- Execute button -->
				<button class="confirm-execute-btn" onclick={executeConfirm}
					disabled={
						(confirmMode === 'custom-wallet' && !confirmTo) ||
						(confirmMode === 'custom-amount' && (!confirmTo || !confirmAmount))
					}
				>
					{confirmMode === 'default' ? 'Confirm & Send to Platform Wallet' :
					 confirmMode === 'custom-wallet' ? `Confirm & Send to ${confirmTo ? confirmTo.slice(0, 8) + '...' : '...'}` :
					 `Confirm & Split (${confirmAmount || '0'} to ${confirmTo ? confirmTo.slice(0, 8) + '...' : '...'})`}
				</button>
			</div>
		</div>
	</div>
{/if}

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

	/* Confirm Modal */
	.modal-backdrop {
		position: fixed; inset: 0; z-index: 100; background: rgba(0,0,0,0.7);
		backdrop-filter: blur(4px); display: flex; align-items: center;
		justify-content: center; padding: 16px;
	}
	.confirm-modal {
		width: 100%; max-width: 440px; background: var(--bg);
		border: 1px solid var(--border); border-radius: 20px; overflow: hidden;
	}
	.modal-header {
		display: flex; justify-content: space-between; align-items: center;
		padding: 16px 20px; border-bottom: 1px solid var(--border);
	}
	.modal-header h3 {
		font-family: 'Syne', sans-serif; font-size: 15px; font-weight: 700;
		color: var(--text-heading); margin: 0;
	}
	.modal-close {
		background: none; border: none; color: var(--text-muted); cursor: pointer;
		padding: 4px; border-radius: 8px; transition: all 150ms;
	}
	.modal-close:hover { color: var(--text); background: var(--bg-surface-hover); }
	.modal-body { padding: 16px 20px 20px; }

	.confirm-summary {
		background: var(--bg-surface-input); border-radius: 12px; padding: 12px; margin-bottom: 16px;
	}
	.confirm-modes { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; }
	.confirm-mode-btn {
		display: flex; align-items: center; gap: 12px; width: 100%;
		padding: 10px 14px; border-radius: 10px; border: 1px solid var(--border);
		background: transparent; cursor: pointer; text-align: left; transition: all 150ms;
	}
	.confirm-mode-btn:hover { border-color: rgba(0,210,255,0.2); background: rgba(0,210,255,0.03); }
	.confirm-mode-active {
		border-color: rgba(0,210,255,0.4) !important; background: rgba(0,210,255,0.06) !important;
	}
	.confirm-mode-icon {
		width: 32px; height: 32px; border-radius: 8px; flex-shrink: 0;
		display: flex; align-items: center; justify-content: center;
		background: var(--bg-surface); font-size: 14px;
		border: 1px solid var(--border);
	}
	.confirm-mode-active .confirm-mode-icon { background: rgba(0,210,255,0.1); border-color: rgba(0,210,255,0.3); color: #00d2ff; }
	.confirm-mode-title {
		display: block; font-family: 'Space Mono', monospace; font-size: 12px;
		font-weight: 700; color: var(--text-heading);
	}
	.confirm-mode-desc {
		display: block; font-family: 'Space Mono', monospace; font-size: 10px; color: var(--text-muted); margin-top: 1px;
	}
	.confirm-fields { margin-bottom: 12px; }
	.confirm-fields label { display: block; margin-bottom: 4px; }
	.confirm-execute-btn {
		width: 100%; padding: 12px; border-radius: 12px; border: none; cursor: pointer;
		background: linear-gradient(135deg, #10b981, #059669); color: white;
		font-family: 'Syne', sans-serif; font-size: 13px; font-weight: 700; transition: all 200ms;
	}
	.confirm-execute-btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 6px 20px rgba(16,185,129,0.3); }
	.confirm-execute-btn:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
