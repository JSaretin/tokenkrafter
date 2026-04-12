<script lang="ts">
	import { t } from '$lib/i18n';

	let {
		poolAddressInput = $bindable(''),
		poolCheckAddr = $bindable(''),
		poolCheckResult,
		isOwner,
		actionLoading,
		onAddPool,
		onCheckPool,
	}: {
		poolAddressInput: string;
		poolCheckAddr: string;
		poolCheckResult: boolean | null;
		isOwner: boolean;
		actionLoading: boolean;
		onAddPool: () => void;
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
		<!-- Register Pool by Base Token -->
		<div class="sub-panel">
			<h4 class="syne text-sm font-bold text-white mb-3">{$t('mt.addPool')}</h4>
			<p class="text-xs text-gray-500 font-mono mb-3">
				Enter a base token address (e.g. WBNB, USDT). The contract resolves the
				V2 pair via its DEX factory and registers it in the pool-lock gate.
				Pools are one-way — once registered, they cannot be removed.
			</p>
			<div class="field-group">
				<label class="label-text" for="pool-addr">Base token address</label>
				<input
					id="pool-addr"
					class="input-field"
					bind:value={poolAddressInput}
					placeholder="0x... (WBNB, USDT, etc.)"
					disabled={!isOwner}
				/>
			</div>
			<button
				onclick={onAddPool}
				disabled={!isOwner || actionLoading || !poolAddressInput}
				class="action-btn mint-btn syne cursor-pointer mt-3 w-full"
			>
				{actionLoading ? $t('mt.processing') : $t('mt.addPool')}
			</button>
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
