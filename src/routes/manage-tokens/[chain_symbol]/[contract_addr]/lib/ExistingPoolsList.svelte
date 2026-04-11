<script lang="ts">
	import { ethers } from 'ethers';
	import { t } from '$lib/i18n';
	import { fmtSupply, shortAddr } from '$lib/formatters';

	export type ExistingPool = {
		baseSymbol: string;
		baseKey: string;
		pairAddress: string;
		reserve0: string;
		reserve1: string;
		token0: string;
		tokenReserve: number;
		baseReserve: number;
		pricePerToken: number;
		baseDecimals: number;
	};

	type PoolAmountEntry = { baseAmount: string; tokenAmount: string; expanded: boolean };

	let {
		selectedRouter = $bindable(''),
		dexRouters,
		existingPools,
		poolsLoading,
		poolsLoaded = $bindable(false),
		poolAddAmounts = $bindable<Record<string, PoolAmountEntry>>({}),
		poolAddLoading,
		poolLpBalances,
		poolRemovePct = $bindable<Record<string, number>>({}),
		poolRemoveLoading,
		tokenSymbol,
		tokenTotalSupply,
		userAddress,
		onLookupPools,
		onSelectedRouterChange,
		onPoolBaseInput,
		onPoolTokenInput,
		onAddToExistingPool,
		onRemoveLiquidity,
	}: {
		selectedRouter: string;
		dexRouters: { address: string; name: string }[];
		existingPools: ExistingPool[];
		poolsLoading: boolean;
		poolsLoaded: boolean;
		poolAddAmounts: Record<string, PoolAmountEntry>;
		poolAddLoading: Record<string, boolean>;
		poolLpBalances: Record<string, bigint>;
		poolRemovePct: Record<string, number>;
		poolRemoveLoading: Record<string, boolean>;
		tokenSymbol: string;
		tokenTotalSupply: string;
		userAddress: string | null;
		onLookupPools: () => void;
		onSelectedRouterChange: () => void;
		onPoolBaseInput: (pool: ExistingPool) => void;
		onPoolTokenInput: (pool: ExistingPool) => void;
		onAddToExistingPool: (pool: ExistingPool) => void;
		onRemoveLiquidity: (pool: ExistingPool) => void;
	} = $props();

	function isEmptyPool(pool: ExistingPool): boolean {
		return pool.tokenReserve === 0 && pool.baseReserve === 0;
	}

	function poolTokenPct(tokenAmount: string): number {
		if (!tokenTotalSupply || !tokenAmount || Number(tokenAmount) <= 0) return 0;
		return (Number(tokenAmount) / Number(tokenTotalSupply)) * 100;
	}
</script>

<!-- Router Selection -->
<div class="field-group">
	<label class="label-text" for="dex-router">{$t('mt.dexRouter')}</label>
	<select id="dex-router" class="input-field" bind:value={selectedRouter} onchange={onSelectedRouterChange}>
		{#each dexRouters as r}
			<option value={r.address}>{r.name}</option>
		{/each}
	</select>
</div>

<!-- Existing Pools Section -->
<div class="sub-panel">
	<div class="flex items-center justify-between mb-3">
		<h4 class="syne text-sm font-bold text-white">{$t('mt.existingPools')}</h4>
		<button
			onclick={onLookupPools}
			disabled={poolsLoading}
			class="btn-secondary text-xs px-3 py-1.5 cursor-pointer"
		>
			{poolsLoading ? $t('mt.loadingPools') : poolsLoaded ? $t('mt.refreshPools') : $t('mt.loadPools')}
		</button>
	</div>

	{#if poolsLoading}
		<div class="flex items-center gap-3 py-4 justify-center">
			<div class="spinner w-5 h-5 rounded-full border-2 border-white/10 border-t-cyan-400"></div>
			<span class="text-gray-500 text-xs font-mono">{$t('mt.scanningPools')}</span>
		</div>
	{:else if poolsLoaded && existingPools.length === 0}
		<div class="liq-empty-state">
			<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="text-gray-600"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
			<span class="text-gray-400 text-sm font-mono">No liquidity pools found</span>
			<span class="text-gray-600 text-xs font-mono">Create a new pool below to list your token on the DEX</span>
		</div>
	{:else if !poolsLoaded}
		<p class="text-gray-600 text-xs font-mono py-2">{$t('mt.clickLoadPools')}</p>
	{/if}

	{#if existingPools.length > 0}
		<div class="flex flex-col gap-3">
			{#each existingPools as pool}
				<div class="pool-card">
					<button
						class="pool-card-header cursor-pointer"
						onclick={() => {
							if (!poolAddAmounts[pool.pairAddress]) poolAddAmounts[pool.pairAddress] = { baseAmount: '', tokenAmount: '', expanded: false };
							poolAddAmounts[pool.pairAddress].expanded = !poolAddAmounts[pool.pairAddress].expanded;
						}}
					>
						<div class="flex items-center gap-3">
							<div class="pool-pair-badge syne">{tokenSymbol}/{pool.baseSymbol}</div>
							<div class="flex flex-col">
								{#if isEmptyPool(pool)}
									<span class="text-amber-400 text-sm font-mono">No liquidity yet</span>
									<span class="text-gray-600 text-[10px] font-mono">Add tokens to set the initial price</span>
								{:else}
									<span class="text-white text-sm rajdhani" style="font-size:15px;">1 {tokenSymbol} = {pool.pricePerToken < 0.000001 ? pool.pricePerToken.toExponential(4) : pool.pricePerToken.toFixed(6)} {pool.baseSymbol}</span>
									<span class="text-gray-500 text-[10px] font-mono">{fmtSupply(String(pool.tokenReserve), 0)} {tokenSymbol} + {pool.baseReserve.toLocaleString(undefined, { maximumFractionDigits: 4 })} {pool.baseSymbol}</span>
								{/if}
							</div>
						</div>
						<div class="flex items-center gap-3">
							{#if isEmptyPool(pool)}
								<span class="badge badge-amber" style="font-size:10px;">Empty</span>
							{:else}
								<span class="badge badge-emerald" style="font-size:10px;">Active</span>
							{/if}
							<span class="pool-expand-icon {poolAddAmounts[pool.pairAddress]?.expanded ? 'expanded' : ''}">v</span>
						</div>
					</button>

					{#if poolAddAmounts[pool.pairAddress]?.expanded}
						<div class="pool-card-body">
							{#if isEmptyPool(pool)}
								<div class="empty-pool-hint">
									<span class="text-amber-400 text-xs font-mono font-bold">{$t('mt.emptyPool')}</span>
									<span class="text-gray-400 text-xs font-mono">{$t('mt.emptyPoolDesc')}</span>
								</div>
							{/if}
							<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
								<div class="field-group">
									<label class="label-text" for="pool-base-{pool.pairAddress}">{pool.baseSymbol} {$t('mt.amount')}</label>
									<div class="input-with-badge">
										<input
											id="pool-base-{pool.pairAddress}"
											class="input-field"
											type="number"
											min="0"
											step="any"
											bind:value={poolAddAmounts[pool.pairAddress].baseAmount}
											oninput={() => onPoolBaseInput(pool)}
											placeholder="0.0"
										/>
										<span class="input-badge">{pool.baseSymbol}</span>
									</div>
								</div>
								<div class="field-group">
									<label class="label-text" for="pool-token-{pool.pairAddress}">{tokenSymbol} {$t('mt.amount')}</label>
									<div class="input-with-badge">
										<input
											id="pool-token-{pool.pairAddress}"
											class="input-field"
											type="number"
											min="0"
											step="any"
											bind:value={poolAddAmounts[pool.pairAddress].tokenAmount}
											oninput={() => onPoolTokenInput(pool)}
											placeholder="0.0"
										/>
										<span class="input-badge">{tokenSymbol}</span>
									</div>
								</div>
							</div>

							{#if poolTokenPct(poolAddAmounts[pool.pairAddress]?.tokenAmount) > 0}
								<div class="liq-pct-bar">
									<div class="flex justify-between text-xs font-mono mb-1">
										<span class="text-gray-500">{$t('mt.supplyAllocated')}</span>
										<span class="text-cyan-400">{poolTokenPct(poolAddAmounts[pool.pairAddress].tokenAmount).toFixed(1)}%</span>
									</div>
									<div class="pct-track">
										<div class="pct-fill" style="width: {Math.min(poolTokenPct(poolAddAmounts[pool.pairAddress].tokenAmount), 100)}%"></div>
									</div>
								</div>
							{/if}

							<div class="liq-info-box">
								{#if !isEmptyPool(pool)}
									<div class="liq-info-row">
										<span class="text-gray-500 font-mono text-xs">{$t('mt.currentPrice')}</span>
										<span class="text-cyan-300 font-mono text-xs">1 {tokenSymbol} = {pool.pricePerToken < 0.000001 ? pool.pricePerToken.toExponential(4) : pool.pricePerToken.toFixed(6)} {pool.baseSymbol}</span>
									</div>
								{/if}
								<div class="liq-info-row">
									<span class="text-gray-500 font-mono text-xs">{$t('mt.slippageTolerance')}</span>
									<span class="text-cyan-300 font-mono text-xs">5%</span>
								</div>
								<div class="liq-info-row">
									<span class="text-gray-500 font-mono text-xs">{$t('mt.lpTokensGoTo')}</span>
									<span class="text-cyan-300 font-mono text-xs">{userAddress ? shortAddr(userAddress) : $t('mt.yourWallet')}</span>
								</div>
							</div>

							<button
								onclick={() => onAddToExistingPool(pool)}
								disabled={poolAddLoading[pool.pairAddress] || !poolAddAmounts[pool.pairAddress]?.tokenAmount || !poolAddAmounts[pool.pairAddress]?.baseAmount}
								class="action-btn liq-btn syne cursor-pointer"
							>
								{poolAddLoading[pool.pairAddress] ? $t('mt.addingLiquidity') : `${$t('mt.addToPool')} ${tokenSymbol}/${pool.baseSymbol} ${$t('mt.pool')}`}
							</button>

							<!-- Remove Liquidity -->
							{#if (poolLpBalances[pool.pairAddress] || 0n) > 0n}
								<div class="remove-liq-section">
									<div class="remove-liq-header">
										<span class="remove-liq-label">Remove Liquidity</span>
										<span class="remove-liq-bal">LP: {parseFloat(ethers.formatEther(poolLpBalances[pool.pairAddress] || 0n)).toFixed(6)}</span>
									</div>
									<div class="remove-liq-pct-row">
										{#each [25, 50, 75, 100] as pct}
											<button
												class="remove-liq-pct-btn {(poolRemovePct[pool.pairAddress] || 100) === pct ? 'active' : ''}"
												onclick={() => (poolRemovePct[pool.pairAddress] = pct)}
											>{pct}%</button>
										{/each}
									</div>
									<button
										onclick={() => onRemoveLiquidity(pool)}
										disabled={poolRemoveLoading[pool.pairAddress]}
										class="action-btn burn-btn syne cursor-pointer"
									>
										{poolRemoveLoading[pool.pairAddress] ? 'Removing...' : `Remove ${poolRemovePct[pool.pairAddress] || 100}% from ${tokenSymbol}/${pool.baseSymbol}`}
									</button>
								</div>
							{/if}
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>
