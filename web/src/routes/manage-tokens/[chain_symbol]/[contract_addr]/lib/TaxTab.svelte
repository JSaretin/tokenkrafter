<script lang="ts">
	import { t } from '$lib/i18n';

	type TaxWallet = { address: string; shareBps: string };

	let {
		buyTaxPctInput = $bindable(''),
		sellTaxPctInput = $bindable(''),
		transferTaxPctInput = $bindable(''),
		taxExemptAddr = $bindable(''),
		taxExemptValue = $bindable(true),
		taxWallets = $bindable<TaxWallet[]>([]),
		isOwner,
		actionLoading,
		tokenInfo,
		onSetTaxes,
		onSetTaxDistribution,
		onExcludeFromTax,
		onAddTaxWallet,
		onRemoveTaxWallet,
	}: {
		buyTaxPctInput: string;
		sellTaxPctInput: string;
		transferTaxPctInput: string;
		taxExemptAddr: string;
		taxExemptValue: boolean;
		taxWallets: TaxWallet[];
		isOwner: boolean;
		actionLoading: boolean;
		tokenInfo: { buyTaxBps?: number; sellTaxBps?: number; transferTaxBps?: number };
		onSetTaxes: () => void;
		onSetTaxDistribution: () => void;
		onExcludeFromTax: () => void;
		onAddTaxWallet: () => void;
		onRemoveTaxWallet: (index: number) => void;
	} = $props();
</script>

<div class="panel">
	<div class="panel-header">
		<div>
			<h3 class="syne text-lg font-bold text-white">{$t('mt.taxSettings')}</h3>
			<p class="text-sm text-gray-500 font-mono mt-1">{$t('mt.taxDesc')}</p>
		</div>
		<span class="badge badge-cyan">{$t('mt.ownerOnly')}</span>
	</div>

	{#if !isOwner}
		<div class="owner-warning">
			<span class="text-amber-400">!</span>
			<span class="text-amber-300 text-sm font-mono">{$t('mt.onlyOwnerCanTax')}</span>
		</div>
	{/if}

	<div class="form-fields">
		<!-- Tax Rates -->
		<div class="sub-panel">
			<h4 class="syne text-sm font-bold text-white mb-3">{$t('mt.taxRates')}</h4>
			<div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
				<div class="field-group">
					<label class="label-text" for="buy-tax">{$t('mt.buyTax')}</label>
					<div class="input-with-badge">
						<input
							id="buy-tax"
							class="input-field"
							type="number"
							min="0"
							max="4"
							step="0.01"
							bind:value={buyTaxPctInput}
							placeholder="0"
							disabled={!isOwner}
						/>
						<span class="input-badge">%</span>
					</div>
					{#if tokenInfo.buyTaxBps !== undefined}
						<span class="field-hint font-mono">{$t('mt.current')}: {(tokenInfo.buyTaxBps / 100).toFixed(2)}%</span>
					{/if}
				</div>
				<div class="field-group">
					<label class="label-text" for="sell-tax">{$t('mt.sellTax')}</label>
					<div class="input-with-badge">
						<input
							id="sell-tax"
							class="input-field"
							type="number"
							min="0"
							max="4"
							step="0.01"
							bind:value={sellTaxPctInput}
							placeholder="0"
							disabled={!isOwner}
						/>
						<span class="input-badge">%</span>
					</div>
					{#if tokenInfo.sellTaxBps !== undefined}
						<span class="field-hint font-mono">{$t('mt.current')}: {(tokenInfo.sellTaxBps / 100).toFixed(2)}%</span>
					{/if}
				</div>
				<div class="field-group">
					<label class="label-text" for="transfer-tax">{$t('mt.transferTax')}</label>
					<div class="input-with-badge">
						<input
							id="transfer-tax"
							class="input-field"
							type="number"
							min="0"
							max="2"
							step="0.01"
							bind:value={transferTaxPctInput}
							placeholder="0"
							disabled={!isOwner}
						/>
						<span class="input-badge">%</span>
					</div>
					{#if tokenInfo.transferTaxBps !== undefined}
						<span class="field-hint font-mono">{$t('mt.current')}: {(tokenInfo.transferTaxBps / 100).toFixed(2)}%</span>
					{/if}
				</div>
			</div>
			<div class="text-xs text-gray-500 font-mono mt-2">Max: 4% buy, 4% sell, 2% transfer. Tax can only be lowered once locked (launch/listing).</div>
			<button
				onclick={onSetTaxes}
				disabled={!isOwner || actionLoading}
				class="action-btn tax-btn syne cursor-pointer mt-3"
			>
				{actionLoading ? $t('mt.saving') : $t('mt.updateTaxRates')}
			</button>
		</div>

		<!-- Tax Distribution -->
		<div class="sub-panel">
			<h4 class="syne text-sm font-bold text-white mb-3">{$t('mt.taxDistribution')}</h4>
			<div class="flex flex-col gap-3">
				{#each taxWallets as wallet, i}
					<div class="flex gap-2 items-end">
						<div class="field-group flex-1">
							<label class="label-text" for="tw-addr-{i}">{$t('mt.walletAddress')}</label>
							<input
								id="tw-addr-{i}"
								class="input-field"
								bind:value={wallet.address}
								placeholder="0x..."
								disabled={!isOwner}
							/>
						</div>
						<div class="field-group" style="width: 120px;">
							<label class="label-text" for="tw-share-{i}">{$t('mt.shareBps')}</label>
							<input
								id="tw-share-{i}"
								class="input-field"
								type="number"
								min="1"
								max="10000"
								bind:value={wallet.shareBps}
								placeholder="5000"
								disabled={!isOwner}
							/>
						</div>
						<button
							onclick={() => onRemoveTaxWallet(i)}
							class="btn-danger text-xs px-3 py-2.5 cursor-pointer"
							disabled={!isOwner}
						>x</button>
					</div>
				{/each}
				{#if taxWallets.length < 10}
					<button
						onclick={onAddTaxWallet}
						class="btn-secondary text-xs px-3 py-2 cursor-pointer self-start"
						disabled={!isOwner}
					>{$t('mt.addWallet')}</button>
				{/if}
			</div>
			{#if taxWallets.length > 0}
				<button
					onclick={onSetTaxDistribution}
					disabled={!isOwner || actionLoading || taxWallets.length === 0}
					class="action-btn tax-btn syne cursor-pointer mt-3"
				>
					{actionLoading ? $t('mt.saving') : $t('mt.saveTaxDistribution')}
				</button>
			{/if}
		</div>

		<!-- Tax Exemption -->
		<div class="sub-panel">
			<h4 class="syne text-sm font-bold text-white mb-3">{$t('mt.taxExemption')}</h4>
			<div class="flex gap-2 items-end flex-wrap">
				<div class="field-group flex-1" style="min-width: 200px;">
					<label class="label-text" for="exempt-addr">{$t('mt.address')}</label>
					<input
						id="exempt-addr"
						class="input-field"
						bind:value={taxExemptAddr}
						placeholder="0x..."
						disabled={!isOwner}
					/>
				</div>
				<div class="field-group" style="width: 120px;">
					<label class="label-text" for="exempt-val">{$t('mt.exempt')}</label>
					<select id="exempt-val" class="input-field" bind:value={taxExemptValue} disabled={!isOwner}>
						<option value={true}>{$t('mt.yes')}</option>
						<option value={false}>{$t('mt.no')}</option>
					</select>
				</div>
				<button
					onclick={onExcludeFromTax}
					disabled={!isOwner || actionLoading || !taxExemptAddr}
					class="action-btn tax-btn syne cursor-pointer"
					style="max-width: 180px;"
				>
					{actionLoading ? $t('mt.saving') : $t('mt.update')}
				</button>
			</div>
		</div>
	</div>
</div>
