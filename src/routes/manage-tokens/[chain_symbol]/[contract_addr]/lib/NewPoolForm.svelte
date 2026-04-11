<script lang="ts">
	import { t } from '$lib/i18n';
	import { shortAddr } from '$lib/formatters';

	type BaseCoinOption = { key: string; symbol: string; address: string; decimals: number };

	let {
		showNewPool = $bindable(false),
		newPoolBaseCoin = $bindable<'native' | 'usdt' | 'usdc'>('native'),
		newPoolMode = $bindable<'manual' | 'price'>('manual'),
		newPoolTokenAmount = $bindable(''),
		newPoolBaseAmount = $bindable(''),
		newPoolPricePerToken = $bindable(''),
		newPoolListBaseAmount = $bindable(''),
		baseCoinOptions,
		selectedBase,
		calculatedTokenAmount,
		tokenPct,
		tokenSymbol,
		userAddress,
		actionLoading,
		onCreateNewPool,
	}: {
		showNewPool: boolean;
		newPoolBaseCoin: 'native' | 'usdt' | 'usdc';
		newPoolMode: 'manual' | 'price';
		newPoolTokenAmount: string;
		newPoolBaseAmount: string;
		newPoolPricePerToken: string;
		newPoolListBaseAmount: string;
		baseCoinOptions: BaseCoinOption[];
		selectedBase: BaseCoinOption | undefined;
		calculatedTokenAmount: string;
		tokenPct: number;
		tokenSymbol: string;
		userAddress: string | null;
		actionLoading: boolean;
		onCreateNewPool: () => void;
	} = $props();
</script>

<div class="sub-panel">
	<button
		class="flex items-center justify-between w-full cursor-pointer"
		style="background: none; border: none; padding: 0;"
		onclick={() => (showNewPool = !showNewPool)}
	>
		<h4 class="syne text-sm font-bold text-white">{$t('mt.createNewPool')}</h4>
		<span class="pool-expand-icon {showNewPool ? 'expanded' : ''}">v</span>
	</button>

	{#if showNewPool}
		<div class="flex flex-col gap-4 mt-4">
			<!-- Base Coin Selection -->
			<div class="field-group">
				<label class="label-text" for="new-pool-base">{$t('mt.baseCoin')}</label>
				<select id="new-pool-base" class="input-field" bind:value={newPoolBaseCoin}>
					{#each baseCoinOptions as opt}
						<option value={opt.key}>{opt.symbol}</option>
					{/each}
				</select>
			</div>

			<!-- Mode Toggle -->
			<div class="mode-toggle">
				<button
					onclick={() => (newPoolMode = 'manual')}
					class="mode-btn {newPoolMode === 'manual' ? 'active' : ''} cursor-pointer"
				>{$t('mt.manualAmounts')}</button>
				<button
					onclick={() => (newPoolMode = 'price')}
					class="mode-btn {newPoolMode === 'price' ? 'active' : ''} cursor-pointer"
				>{$t('mt.priceBased')}</button>
			</div>

			{#if newPoolMode === 'manual'}
				<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
					<div class="field-group">
						<label class="label-text" for="new-liq-token">{$t('mt.tokenAmount')}</label>
						<div class="input-with-badge">
							<input
								id="new-liq-token"
								class="input-field"
								type="number"
								min="0"
								bind:value={newPoolTokenAmount}
								placeholder="100000"
							/>
							<span class="input-badge">{tokenSymbol}</span>
						</div>
					</div>
					<div class="field-group">
						<label class="label-text" for="new-liq-base">{selectedBase?.symbol ?? 'Base'} {$t('mt.amount')}</label>
						<div class="input-with-badge">
							<input
								id="new-liq-base"
								class="input-field"
								type="number"
								min="0"
								bind:value={newPoolBaseAmount}
								placeholder="0.5"
							/>
							<span class="input-badge">{selectedBase?.symbol ?? ''}</span>
						</div>
					</div>
				</div>
			{:else}
				<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
					<div class="field-group">
						<label class="label-text" for="new-price-per-token">{$t('mt.pricePerToken')} ({selectedBase?.symbol})</label>
						<div class="input-with-badge">
							<input
								id="new-price-per-token"
								class="input-field"
								type="number"
								min="0"
								step="any"
								bind:value={newPoolPricePerToken}
								placeholder="1.00"
							/>
							<span class="input-badge">{selectedBase?.symbol ?? ''}</span>
						</div>
						<span class="field-hint font-mono">{$t('mt.howMuchCosts')} {tokenSymbol} {$t('mt.costs')}</span>
					</div>
					<div class="field-group">
						<label class="label-text" for="new-list-base-amt">{$t('mt.amountToList')} {selectedBase?.symbol} {$t('mt.toList')}</label>
						<div class="input-with-badge">
							<input
								id="new-list-base-amt"
								class="input-field"
								type="number"
								min="0"
								step="any"
								bind:value={newPoolListBaseAmount}
								placeholder="100"
							/>
							<span class="input-badge">{selectedBase?.symbol ?? ''}</span>
						</div>
					</div>
				</div>

				{#if calculatedTokenAmount}
					<div class="calc-result">
						<span class="text-gray-500 text-xs font-mono">{$t('mt.calculatedTokenAmount')}</span>
						<span class="text-white text-sm font-mono font-bold">
							{Number(calculatedTokenAmount).toLocaleString()} {tokenSymbol}
						</span>
					</div>
				{/if}
			{/if}

			{#if tokenPct > 0}
				<div class="liq-pct-bar">
					<div class="flex justify-between text-xs font-mono mb-1">
						<span class="text-gray-500">{$t('mt.supplyAllocated')}</span>
						<span class="text-cyan-400">{tokenPct.toFixed(1)}%</span>
					</div>
					<div class="pct-track">
						<div class="pct-fill" style="width: {Math.min(tokenPct, 100)}%"></div>
					</div>
				</div>
			{/if}

			<div class="liq-info-box">
				<div class="liq-info-row">
					<span class="text-gray-500 font-mono text-xs">{$t('mt.slippageTolerance')}</span>
					<span class="text-cyan-300 font-mono text-xs">5%</span>
				</div>
				<div class="liq-info-row">
					<span class="text-gray-500 font-mono text-xs">{$t('mt.txDeadline')}</span>
					<span class="text-cyan-300 font-mono text-xs">{$t('mt.twentyMinutes')}</span>
				</div>
				<div class="liq-info-row">
					<span class="text-gray-500 font-mono text-xs">{$t('mt.lpTokensGoTo')}</span>
					<span class="text-cyan-300 font-mono text-xs">{userAddress ? shortAddr(userAddress) : $t('mt.yourWallet')}</span>
				</div>
			</div>

			<button
				onclick={onCreateNewPool}
				disabled={actionLoading || (newPoolMode === 'manual' ? (!newPoolTokenAmount || !newPoolBaseAmount) : (!newPoolPricePerToken || !newPoolListBaseAmount))}
				class="action-btn liq-btn syne cursor-pointer"
			>
				{actionLoading ? $t('mt.creatingPool') : $t('mt.createPoolAddLiquidity')}
			</button>
		</div>
	{/if}
</div>
