<script lang="ts">
	import { t } from '$lib/i18n';

	let {
		mintAmount = $bindable(''),
		mintTo = $bindable(''),
		isOwner,
		actionLoading,
		tokenSymbol,
		userAddress,
		onMint,
	}: {
		mintAmount: string;
		mintTo: string;
		isOwner: boolean;
		actionLoading: boolean;
		tokenSymbol: string;
		userAddress: string | null;
		onMint: () => void;
	} = $props();
</script>

<div class="panel">
	<div class="panel-header">
		<div>
			<h3 class="syne text-lg font-bold text-white">{$t('mt.mintTokens')}</h3>
			<p class="text-sm text-gray-500 font-mono mt-1">{$t('mt.mintDesc')}</p>
		</div>
		<span class="badge badge-cyan">{$t('mt.ownerOnly')}</span>
	</div>

	{#if !isOwner}
		<div class="owner-warning">
			<span class="text-amber-400">!</span>
			<span class="text-amber-300 text-sm font-mono">{$t('mt.onlyOwnerCanMint')}</span>
		</div>
	{/if}

	<div class="form-fields">
		<div class="field-group">
			<label class="label-text" for="mint-amount">{$t('mt.amountToMint')}</label>
			<div class="input-with-badge">
				<input
					id="mint-amount"
					class="input-field"
					type="number"
					min="0"
					bind:value={mintAmount}
					placeholder="1000000"
					disabled={!isOwner}
				/>
				<span class="input-badge">{tokenSymbol}</span>
			</div>
		</div>
		<div class="field-group">
			<label class="label-text" for="mint-to">{$t('mt.recipientAddress')}</label>
			<input
				id="mint-to"
				class="input-field"
				bind:value={mintTo}
				placeholder="0x..."
				disabled={!isOwner}
			/>
			{#if userAddress}
				<button
					onclick={() => (mintTo = userAddress!)}
					class="field-hint-btn font-mono cursor-pointer"
				>{$t('mt.useMyWallet')}</button>
			{/if}
		</div>
		<button
			onclick={onMint}
			disabled={!isOwner || actionLoading || !mintAmount}
			class="action-btn mint-btn syne cursor-pointer"
		>
			{actionLoading ? $t('mt.minting') : $t('mt.mintAction')}
		</button>
	</div>
</div>
