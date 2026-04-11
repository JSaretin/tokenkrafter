<script lang="ts">
	import { t } from '$lib/i18n';

	let {
		poolAddressInput = $bindable(''),
		poolCheckAddr = $bindable(''),
		poolCheckResult,
		isOwner,
		actionLoading,
		onAddPool,
		onRemovePool,
		onCheckPool,
	}: {
		poolAddressInput: string;
		poolCheckAddr: string;
		poolCheckResult: boolean | null;
		isOwner: boolean;
		actionLoading: boolean;
		onAddPool: () => void;
		onRemovePool: () => void;
		onCheckPool: () => void;
	} = $props();
</script>

<div class="panel">
	<div class="panel-header">
		<div>
			<h3 class="syne text-lg font-bold text-white">{$t('mt.poolManagement')}</h3>
			<p class="text-sm text-gray-500 font-mono mt-1">{$t('mt.poolDesc')}</p>
		</div>
		<span class="badge badge-cyan">{$t('mt.ownerOnly')}</span>
	</div>

	{#if !isOwner}
		<div class="owner-warning">
			<span class="text-amber-400">!</span>
			<span class="text-amber-300 text-sm font-mono">{$t('mt.onlyOwnerCanPools')}</span>
		</div>
	{/if}

	<div class="form-fields">
		<!-- Add / Remove Pool -->
		<div class="sub-panel">
			<h4 class="syne text-sm font-bold text-white mb-3">{$t('mt.addRemovePool')}</h4>
			<div class="field-group">
				<label class="label-text" for="pool-addr">{$t('mt.poolAddress')}</label>
				<input
					id="pool-addr"
					class="input-field"
					bind:value={poolAddressInput}
					placeholder="0x..."
					disabled={!isOwner}
				/>
			</div>
			<div class="flex gap-3 mt-3">
				<button
					onclick={onAddPool}
					disabled={!isOwner || actionLoading || !poolAddressInput}
					class="action-btn mint-btn syne cursor-pointer"
					style="flex:1;"
				>
					{actionLoading ? $t('mt.processing') : $t('mt.addPool')}
				</button>
				<button
					onclick={onRemovePool}
					disabled={!isOwner || actionLoading || !poolAddressInput}
					class="action-btn burn-btn syne cursor-pointer"
					style="flex:1;"
				>
					{actionLoading ? $t('mt.processing') : $t('mt.removePool')}
				</button>
			</div>
		</div>

		<!-- Check Pool Status -->
		<div class="sub-panel">
			<h4 class="syne text-sm font-bold text-white mb-3">{$t('mt.checkPoolStatus')}</h4>
			<div class="flex gap-2 items-end flex-wrap">
				<div class="field-group flex-1" style="min-width: 200px;">
					<label class="label-text" for="pool-check-addr">{$t('mt.addressToCheck')}</label>
					<input
						id="pool-check-addr"
						class="input-field"
						bind:value={poolCheckAddr}
						placeholder="0x..."
					/>
				</div>
				<button
					onclick={onCheckPool}
					disabled={!poolCheckAddr}
					class="btn-secondary text-xs px-4 py-3 cursor-pointer font-mono"
				>{$t('mt.check')}</button>
			</div>
			{#if poolCheckResult !== null}
				<div class="mt-3 px-3 py-2 rounded-lg {poolCheckResult ? 'bg-emerald-500/10 border border-emerald-500/20' : 'bg-red-500/10 border border-red-500/20'}">
					<span class="text-sm font-mono {poolCheckResult ? 'text-emerald-400' : 'text-red-400'}">
						{poolCheckResult ? $t('mt.isRegisteredPool') : $t('mt.isNotRegisteredPool')}
					</span>
				</div>
			{/if}
		</div>
	</div>
</div>
