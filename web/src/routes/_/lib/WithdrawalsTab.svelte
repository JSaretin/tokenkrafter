<script lang="ts">
	import { getContext, onDestroy } from 'svelte';
	import { supabase } from '$lib/supabaseClient';
	import { ethers } from 'ethers';
	import type { SupportedNetwork } from '$lib/structure';
	import { TRADE_ROUTER_ABI } from '$lib/tradeRouter';
	import { ERC20_DECIMALS_ABI } from '$lib/commonABIs';
	import Skeleton from '$lib/Skeleton.svelte';
	import AddressBadge from './AddressBadge.svelte';

	const addFeedback = getContext<(f: { message: string; type: string }) => void>('addFeedback');
	let getSigner: () => ethers.Signer | null = getContext('signer');
	let _getNetworks: () => SupportedNetwork[] = getContext('supportedNetworks');
	let supportedNetworks = $derived(_getNetworks());
	let signer = $derived(getSigner());

	let getNetworkProviders: () => Map<number, ethers.JsonRpcProvider> = getContext('networkProviders');
	let networkProviders = $derived(getNetworkProviders());

	function explorerForChain(chainId: number | undefined): string {
		if (!chainId) return '';
		return supportedNetworks.find((n: any) => n.chain_id === chainId)?.explorer_url || '';
	}

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
	let confirmMode = $state<'default' | 'custom-wallet' | 'keep-in-contract'>('default');
	let confirmTo = $state('');

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

	/** Read on-chain pending withdrawals in one batch call per chain.
	 *  Returns both a pending ID set (for DB matching) and the on-chain
	 *  structs keyed by withdraw ID (for enrichment without extra RPCs). */
	async function getOnChainPending(): Promise<Map<number, { ids: Set<number>; byId: Map<number, any> }>> {
		const result = new Map<number, { ids: Set<number>; byId: Map<number, any> }>();
		for (const network of supportedNetworks) {
			if (!network.trade_router_address) continue;
			const provider = networkProviders.get(network.chain_id);
			if (!provider) continue;
			try {
				const router = new ethers.Contract(network.trade_router_address, TRADE_ROUTER_ABI, provider);
				const { result: pending, total } = await router.getPendingWithdrawals(0, 200);
				const count = Number(total);
				const idList = await Promise.all(
					Array.from({ length: count }, (_, i) => router.pendingIds(i).then(Number))
				);
				const ids = new Set(idList);
				const byId = new Map<number, any>();
				for (let i = 0; i < count; i++) {
					byId.set(idList[i], pending[i]);
				}
				result.set(network.chain_id, { ids, byId });
			} catch {}
		}
		return result;
	}

	async function loadWithdrawals() {
		withdrawalsLoading = true;
		try {
			if (withdrawFilter === 'pending' || withdrawFilter === 'timeout') {
				const onChainPending = await getOnChainPending();

				const res = await fetch('/api/withdrawals?status=pending');
				if (res.ok) {
					let data = await res.json();

					// Only keep DB records that actually exist on-chain as pending,
					// and merge on-chain data (expiresAt, status) from the batch result
					data = data.filter((w: any) => {
						if (w.withdraw_id == null) return false;
						const chain = onChainPending.get(w.chain_id);
						if (!chain?.ids.has(w.withdraw_id)) return false;
						const onChain = chain.byId.get(w.withdraw_id);
						if (onChain) {
							w._expiresAt = Number(onChain.expiresAt);
							w._createdAt = Number(onChain.createdAt);
							w._onChainStatus = Number(onChain.status);
						}
						return true;
					});

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
			if (confirmMode === 'custom-wallet' && confirmTo) {
				tx = await router['confirm(uint256,address)'](w.withdraw_id, confirmTo);
				note = `Confirmed: sent to ${confirmTo.slice(0, 8)}...`;
			} else if (confirmMode === 'keep-in-contract') {
				// Pass the TradeRouter address as recipient — safeTransfer
				// to address(this) is a no-op net transfer, but the contract
				// still flips status to Confirmed and decrements totalEscrow.
				// The released USDT stays in the contract reserve, available
				// for the next /onramp delivery without admin top-up.
				tx = await router['confirm(uint256,address)'](w.withdraw_id, network.trade_router_address);
				note = 'Confirmed: kept in contract for on-ramp reserve';
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
					<button class={'text-xs font-mono px-3 py-1.5 rounded-lg cursor-pointer transition ' + (withdrawFilter === tab.key ? 'bg-cyan-500/15 text-cyan-400 border border-cyan-500/30' : 'text-gray-500 bg-surface-hover border border-transparent')}
						onclick={() => { withdrawFilter = tab.key as any; loadWithdrawals(); }}
					>
						{tab.label}
						{#if tab.count > 0}
							<span class="ml-1 text-xs4 {tab.key === 'timeout' ? 'text-red-400' : ''}">{tab.count}</span>
						{/if}
					</button>
				{/each}
			</div>
			<div class="flex items-center gap-2 ml-auto">
				<label for="wt-ngn-rate" class="text-xs text-gray-500 font-mono">NGN Rate:</label>
				<input id="wt-ngn-rate" class="input-field text-xs w-[100px]" type="number" bind:value={nairaRate} />
			</div>
			<button class="btn-secondary text-xs px-3 py-1.5 cursor-pointer" onclick={loadWithdrawals}>
				Refresh
			</button>
		</div>
	</div>

	<!-- Withdrawal list -->
	{#if withdrawalsLoading}
		<!-- Skeleton rows mirror withdrawal card shape so list height is stable. -->
		<div class="flex flex-col gap-3">
			{#each Array(4) as _}
				<div class="card p-4 flex flex-col gap-3">
					<div class="flex items-start justify-between gap-4">
						<div class="flex flex-col gap-2">
							<div class="flex items-center gap-2">
								<Skeleton width={70} height="1rem" />
								<Skeleton width={60} height="0.7rem" radius="999px" />
							</div>
							<Skeleton width={140} height="0.7rem" />
						</div>
						<div class="flex flex-col items-end gap-2">
							<Skeleton width={80} height="0.85rem" />
							<Skeleton width={60} height="0.7rem" />
						</div>
					</div>
					<Skeleton width="100%" height="0.6rem" radius="3px" />
				</div>
			{/each}
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
				<div class={'card p-4' + (isPending ? ' border-amber-500/20' : '')}>
					<div class="flex items-start justify-between gap-4 mb-3">
						<div>
							<div class="flex items-center gap-2 mb-1">
								<span class="font-mono text-sm font-bold text-white">
									${usdtAmount.toFixed(2)}
								</span>
								<span class={'text-3xs font-mono px-2 py-0.5 rounded-full ' +
									(w.status === 'pending' ? 'bg-amber-500/15 text-amber-400' :
									 w.status === 'confirmed' ? 'bg-emerald-500/15 text-emerald-400' :
									 w.status === 'processing' ? 'bg-cyan-500/15 text-cyan-400' :
									 'bg-red-500/15 text-red-400')}
								>{w.status}</span>
							</div>
							<AddressBadge
								address={w.wallet_address || ''}
								explorerUrl={explorerForChain(w.chain_id)}
								class="text-gray-600"
							/>
						</div>
						<div class="text-right">
							<span class="text-sm font-mono font-bold text-emerald-400">
								NGN {ngnAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })}
							</span>
							<div class="text-3xs text-gray-600 font-mono">
								{new Date(w.created_at).toLocaleString()}
							</div>
						</div>
					</div>

					<!-- Payment details -->
					<div class="bg-surface-input rounded-lg p-3 mb-3">
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
					<div class="flex gap-4 text-3xs font-mono text-gray-500 mb-3">
						<span>Gross: ${fmtUsdt(w.gross_amount, usdtDecimalsMap[w.chain_id] || 18)}</span>
						<span>Fee: ${fmtUsdt(w.fee, usdtDecimalsMap[w.chain_id] || 18)}</span>
						<span>Net: ${usdtAmount.toFixed(2)}</span>
						{#if w.admin_note}
							<span class="text-gray-600 truncate max-w-[200px]">{w.admin_note}</span>
						{/if}
					</div>

					<!-- Actions -->
					{#if isPending}
						<div class="px-0.5 mb-3">
							<div class="w-full h-1 bg-surface-hover rounded-sm overflow-hidden">
								<div class="h-full rounded-sm transition-[width] duration-1000 ease-linear" style="width: {totalDuration > 0 ? Math.min(100, (elapsed / totalDuration) * 100) : 100}%; background: {timedOut ? 'linear-gradient(90deg, #f87171, #dc2626)' : 'linear-gradient(90deg, #f59e0b, #d97706)'}"></div>
							</div>
							<div class="flex justify-between items-center mt-1">
								{#if timedOut}
									<span class="text-3xs font-mono text-red-400 font-bold">TIMED OUT — user can cancel</span>
								{:else}
									<span class="text-3xs font-mono text-amber-400">{Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')} remaining</span>
								{/if}
								<span class="text-3xs font-mono text-gray-600">{elapsed}s elapsed</span>
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
							<p class="text-3xs font-mono text-gray-600 mt-1">Refund returns escrowed USDT to the user's wallet on-chain.</p>
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
	<div
		class="fixed inset-0 z-[100] bg-black/70 backdrop-blur-[4px] flex items-center justify-center p-4"
		onclick={() => { showConfirmModal = false; }}
		onkeydown={(e) => { if (e.key === 'Escape') showConfirmModal = false; }}
		role="dialog"
		aria-modal="true"
		tabindex="-1"
	>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div class="w-full max-w-[440px] bg-background border border-line rounded-[20px] overflow-hidden" onclick={(e) => e.stopPropagation()}>
			<div class="flex justify-between items-center px-5 py-4 border-b border-line">
				<h3 class="font-display text-15 font-bold text-heading m-0">Confirm Withdrawal #{w.withdraw_id}</h3>
				<button aria-label="Close" class="bg-none border-none text-muted cursor-pointer p-1 rounded-lg transition hover:text-foreground hover:bg-surface-hover" onclick={() => { showConfirmModal = false; }}>
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
				</button>
			</div>

			<div class="px-5 pt-4 pb-5">
				<!-- Summary -->
				<div class="bg-surface-input rounded-xl p-3 mb-4">
					<div class="flex justify-between text-xs font-mono mb-1">
						<span class="text-gray-500">Net Amount</span>
						<span class="text-white font-bold">${netUsdt.toFixed(2)}</span>
					</div>
					<div class="flex justify-between text-xs font-mono mb-1">
						<span class="text-gray-500">User</span>
						<AddressBadge
							address={w.wallet_address || ''}
							explorerUrl={explorerForChain(w.chain_id)}
							head={10}
							tail={6}
							class="text-gray-300"
						/>
					</div>
					{#if w.payment_details?.holder}
						<div class="flex justify-between text-xs font-mono">
							<span class="text-gray-500">Pay to</span>
							<span class="text-emerald-400">{w.payment_details.holder}</span>
						</div>
					{/if}
				</div>

				<!-- Mode selector -->
				<div class="flex flex-col gap-1.5 mb-4">
					<button class={'flex items-center gap-3 w-full px-3.5 py-2.5 rounded-[10px] border bg-transparent cursor-pointer text-left transition hover:border-cyan-500/20 hover:bg-cyan-500/5 ' + (confirmMode === 'default' ? 'border-cyan-500/40 bg-cyan-500/[0.06]' : 'border-line')}
						onclick={() => { confirmMode = 'default'; }}>
						<span class={'w-8 h-8 rounded-lg shrink-0 flex items-center justify-center text-sm border ' + (confirmMode === 'default' ? 'bg-cyan-500/10 border-cyan-500/30 text-brand-cyan' : 'bg-surface border-line')}>→</span>
						<div>
							<span class="block font-mono text-xs font-bold text-heading">Default</span>
							<span class="block font-mono text-3xs text-muted mt-px">Send to platform wallet</span>
						</div>
					</button>
					<button class={'flex items-center gap-3 w-full px-3.5 py-2.5 rounded-[10px] border bg-transparent cursor-pointer text-left transition hover:border-cyan-500/20 hover:bg-cyan-500/5 ' + (confirmMode === 'custom-wallet' ? 'border-cyan-500/40 bg-cyan-500/[0.06]' : 'border-line')}
						onclick={() => { confirmMode = 'custom-wallet'; }}>
						<span class={'w-8 h-8 rounded-lg shrink-0 flex items-center justify-center text-sm border ' + (confirmMode === 'custom-wallet' ? 'bg-cyan-500/10 border-cyan-500/30 text-brand-cyan' : 'bg-surface border-line')}>⇄</span>
						<div>
							<span class="block font-mono text-xs font-bold text-heading">Custom Wallet</span>
							<span class="block font-mono text-3xs text-muted mt-px">Send full amount to another address</span>
						</div>
					</button>
					<button class={'flex items-center gap-3 w-full px-3.5 py-2.5 rounded-[10px] border bg-transparent cursor-pointer text-left transition hover:border-cyan-500/20 hover:bg-cyan-500/5 ' + (confirmMode === 'keep-in-contract' ? 'border-cyan-500/40 bg-cyan-500/[0.06]' : 'border-line')}
						onclick={() => { confirmMode = 'keep-in-contract'; }}>
						<span class={'w-8 h-8 rounded-lg shrink-0 flex items-center justify-center text-sm border ' + (confirmMode === 'keep-in-contract' ? 'bg-cyan-500/10 border-cyan-500/30 text-brand-cyan' : 'bg-surface border-line')}>⟲</span>
						<div>
							<span class="block font-mono text-xs font-bold text-heading">Keep in contract</span>
							<span class="block font-mono text-3xs text-muted mt-px">Confirm only — USDT stays as on-ramp reserve</span>
						</div>
					</button>
				</div>

				<!-- Custom fields -->
				{#if confirmMode === 'custom-wallet'}
					<label class="block mb-3">
						<span class="block mb-1 text-3xs text-gray-500 font-mono uppercase">Recipient Address</span>
						<input class="input-field text-xs" bind:value={confirmTo} placeholder="0x..." />
					</label>
				{/if}

				<!-- Execute button -->
				<button class="w-full p-3 rounded-xl border-none cursor-pointer text-white font-display text-13 font-bold transition duration-200 bg-gradient-to-br from-[#10b981] to-[#059669] hover:-translate-y-px hover:shadow-[0_6px_20px_rgba(16,185,129,0.3)] disabled:opacity-40 disabled:cursor-not-allowed disabled:translate-y-0 disabled:shadow-none" onclick={executeConfirm}
					disabled={confirmMode === 'custom-wallet' && !confirmTo}
				>
					{confirmMode === 'default' ? 'Confirm & Send to Platform Wallet' :
					 confirmMode === 'keep-in-contract' ? 'Confirm — Keep in Contract Reserve' :
					 `Confirm & Send to ${confirmTo ? confirmTo.slice(0, 8) + '...' : '...'}`}
				</button>
			</div>
		</div>
	</div>
{/if}
