<script lang="ts">
	import { ethers } from 'ethers';
	import { getContext } from 'svelte';
	import { t } from '$lib/i18n';
	import QrCode from '$lib/QrCode.svelte';
	import type { SupportedNetwork } from '$lib/structure';

	let {
		network,
		userAddress,
		paymentLabel,
		requiredAmount,
		userPaymentBalance,
		paymentDecimals,
		onclose,
	}: {
		network: SupportedNetwork | null | undefined;
		userAddress: string | null | undefined;
		paymentLabel: string;
		requiredAmount: string;
		userPaymentBalance: bigint;
		paymentDecimals: number;
		onclose: () => void;
	} = $props();

	const addFeedback = getContext<(f: { message: string; type: string }) => void>('addFeedback');
</script>

<div class="bg-[var(--select-bg)] border border-[var(--border)] rounded-2xl p-6 max-w-[420px] w-full">
	<div class="flex justify-between items-center mb-4">
		<h2 class="syne text-xl font-bold text-white">{$t('lpd.insufficientBalance').replace('{token}', paymentLabel)}</h2>
		<button class="text-gray-500 hover:text-white text-lg cursor-pointer" onclick={onclose}>x</button>
	</div>

	<div class="text-center">
		<p class="text-gray-400 text-sm font-mono mb-1">
			{$t('lpd.youNeed')} <span class="text-cyan-400 font-semibold">{requiredAmount} {paymentLabel}</span> {$t('lpd.toComplete')}
		</p>
		<p class="text-gray-500 text-xs font-mono mb-4">
			{$t('lpd.currentBalance')}: {parseFloat(ethers.formatUnits(userPaymentBalance, paymentDecimals)).toFixed(4)} {paymentLabel}
		</p>

		<div class="flex flex-col items-center mb-4">
			<div class="p-3 bg-[var(--bg-surface)] border border-[var(--border-input)] rounded-xl">
				<QrCode data={userAddress || ''} width={180} colorDark="#00d2ff" colorLight="#0d0d14" alt="Deposit address QR" />
			</div>
			<div class="mt-3 py-2 px-3.5 bg-cyan-400/[0.04] border border-cyan-400/[0.12] rounded-lg max-w-full break-all">
				<span class="text-cyan-400 text-xs font-mono break-all">{userAddress}</span>
			</div>
			<button
				class="text-gray-500 hover:text-cyan-400 text-xs2 font-mono mt-2 cursor-pointer transition"
				onclick={() => { navigator.clipboard.writeText(userAddress ?? ''); addFeedback({ message: $t('lpd.copied'), type: 'success' }); }}
			>
				{$t('lpd.copyAddress')}
			</button>
		</div>

		<p class="text-gray-600 text-xs2 font-mono">
			{$t('lpd.sendTo').replace('{token}', paymentLabel)} <span class="text-gray-400">{network?.name || 'BSC'}</span>. {$t('lpd.autoDetect')}
		</p>

		<div class="flex items-center justify-center gap-2 mt-4">
			<div class="spinner-sm"></div>
			<span class="text-gray-500 text-xs font-mono">{$t('lpd.watchingDeposit')}</span>
		</div>
	</div>
</div>
