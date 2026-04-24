<script lang="ts">
	import { t } from '$lib/i18n';

	let {
		tokenName,
		tokenSymbol,
		tokenAddress,
		txHash,
		network,
		title = null,
		subtitle = null,
		onManageTokens,
		onClose,
	}: {
		tokenName: string;
		tokenSymbol: string;
		tokenAddress: string;
		txHash: string;
		network?: { name?: string; chain_id?: number; explorer_url?: string };
		title?: string | null;
		subtitle?: string | null;
		onManageTokens: () => void;
		onClose: () => void;
	} = $props();

	function explorerUrl(type: 'tx' | 'address', hash: string): string {
		const base = (network?.explorer_url || '').replace(/\/$/, '');
		if (!base) return '#';
		return base + '/' + type + '/' + hash;
	}
</script>

<div class="text-center py-8">
	<div class="text-5xl mb-4 syne font-bold text-emerald-400">{$t('ct.done')}</div>
	<h2 class="syne text-2xl font-bold text-white mb-2">
		{title || (tokenName + ' (' + tokenSymbol + ') deployed')}
	</h2>
	{#if subtitle}
		<p class="text-gray-400 font-mono text-sm mb-4">{subtitle}</p>
	{:else if network?.name}
		<p class="text-gray-400 font-mono text-sm mb-4">
			{$t('ct.liveOn')} {network.name}.
		</p>
	{/if}

	{#if tokenAddress}
		<div class="p-3 px-3.5 bg-cyan-400/[0.04] border border-cyan-400/15 rounded-[10px] text-center mb-4">
			<div class="text-gray-500 text-xs2 font-mono uppercase tracking-wider mb-1">{$t('ct.tokenAddress')}</div>
			<div class="text-cyan-400 text-xs font-mono break-all mb-2">{tokenAddress}</div>
			<a
				href={explorerUrl('address', tokenAddress)}
				target="_blank"
				rel="noopener noreferrer"
				class="text-cyan-500 text-xs font-mono hover:text-cyan-300 transition no-underline"
			>{$t('ct.viewExplorer')} -></a>
		</div>
	{/if}

	{#if txHash}
		<div class="mb-6">
			<a
				href={explorerUrl('tx', txHash)}
				target="_blank"
				rel="noopener noreferrer"
				class="text-gray-500 text-xs2 font-mono hover:text-gray-300 transition no-underline"
			>View transaction: {txHash.slice(0, 10)}...{txHash.slice(-8)} -></a>
		</div>
	{/if}

	<div class="flex gap-3 justify-center">
		<button onclick={onManageTokens} class="btn-primary text-sm px-5 py-2.5 cursor-pointer">
			{$t('ct.manageTokens')} ->
		</button>
		<button onclick={onClose} class="btn-secondary text-sm px-5 py-2.5 cursor-pointer">
			{$t('ct.close')}
		</button>
	</div>
</div>
