<script lang="ts">
	import { t } from '$lib/i18n';

	let {
		burnAmount = $bindable(''),
		actionLoading,
		tokenSymbol,
		userBalance,
		onBurn,
	}: {
		burnAmount: string;
		actionLoading: boolean;
		tokenSymbol: string;
		userBalance: string | number | null | undefined;
		onBurn: () => void;
	} = $props();
</script>

<div class="panel">
	<div class="panel-header">
		<div>
			<h3 class="syne text-lg font-bold text-white">{$t('mt.burnTokens')}</h3>
			<p class="text-sm text-gray-500 font-mono mt-1">{$t('mt.burnDesc')}</p>
		</div>
		<span class="badge badge-amber">{$t('mt.irreversible')}</span>
	</div>

	<div class="form-fields">
		<div class="field-group">
			<label class="label-text" for="burn-amount">{$t('mt.amountToBurn')}</label>
			<div class="input-with-badge">
				<input
					id="burn-amount"
					class="input-field"
					type="number"
					min="0"
					bind:value={burnAmount}
					placeholder="0"
				/>
				<span class="input-badge">{tokenSymbol}</span>
			</div>
			{#if userBalance}
				<span class="field-hint font-mono">{$t('mt.balance')}: {Number(userBalance).toLocaleString()} {tokenSymbol}</span>
			{/if}
		</div>

		<div class="burn-warning">
			<span class="text-red-400">!</span>
			<span class="text-red-300 text-sm font-mono">{$t('mt.burnWarning')}</span>
		</div>

		<button
			onclick={onBurn}
			disabled={actionLoading || !burnAmount}
			class="action-btn burn-btn syne cursor-pointer"
		>
			{actionLoading ? $t('mt.burning') : $t('mt.burnAction')}
		</button>
	</div>
</div>
