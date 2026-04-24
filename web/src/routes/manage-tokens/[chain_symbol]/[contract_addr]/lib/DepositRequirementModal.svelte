<script lang="ts">
	import { t } from '$lib/i18n';
	import QrCode from '$lib/QrCode.svelte';

	type DepositInfo = {
		symbol: string;
		networkName: string;
		required: string;
		userBalance: string;
		deficit: string;
		decimals: number;
		isNative: boolean;
		onResume: () => void;
	};

	let {
		depositInfo,
		userAddress,
		addressCopied,
		onCopyAddress,
		onclose,
	}: {
		depositInfo: DepositInfo;
		userAddress: string | null | undefined;
		addressCopied: boolean;
		onCopyAddress: () => void;
		onclose: () => void;
	} = $props();
</script>

<div class="w-full max-w-md rounded-2xl border border-(--border-input) bg-(--bg) shadow-2xl overflow-hidden animate-modal-in">
	<!-- Header -->
	<div class="flex justify-between items-center px-6 py-5 border-b border-(--bg-surface-hover)">
		<div class="flex items-center gap-3">
			<div class="w-10 h-10 rounded-xl bg-warning/15 text-warning flex items-center justify-center shrink-0">
				<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M12 2v20M2 12h20"/>
				</svg>
			</div>
			<div>
				<h2 class="heading-2">{$t('mt.depositRequired')}</h2>
				<p class="text-gray-500 text-xs3 font-mono">{depositInfo.networkName} Network</p>
			</div>
		</div>
		<button aria-label="Close" onclick={onclose} class="w-8 h-8 rounded-lg border-none bg-(--bg-surface-hover) text-(--text-dim) flex items-center justify-center transition-all duration-150 cursor-pointer hover:bg-(--border-input) hover:text-(--text-heading)">
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<path d="M18 6L6 18M6 6l12 12"/>
			</svg>
		</button>
	</div>

	<!-- Amount Summary -->
	<div class="flex flex-col gap-2.5 px-6 py-5">
		<div class="flex justify-between items-center">
			<span class="text-gray-500 text-xs font-mono">{$t('mt.required')}</span>
			<span class="text-white text-sm font-mono font-bold">{Number(depositInfo.required).toLocaleString()} {depositInfo.symbol}</span>
		</div>
		<div class="flex justify-between items-center">
			<span class="text-gray-500 text-xs font-mono">{$t('mt.yourBalance')}</span>
			<span class="text-gray-300 text-sm font-mono">{Number(depositInfo.userBalance).toLocaleString()} {depositInfo.symbol}</span>
		</div>
		<div class="border-t border-dashed border-(--border) my-1"></div>
		<div class="flex justify-between items-center">
			<span class="text-amber-400 text-xs font-mono font-bold">{$t('mt.amountToDeposit')}</span>
			<span class="text-amber-300 text-lg font-mono font-bold">{Number(depositInfo.deficit).toLocaleString()} {depositInfo.symbol}</span>
		</div>
	</div>

	<!-- QR Code -->
	<div class="flex justify-center px-6 pb-5">
		<div class="p-3 bg-(--bg-surface) border border-(--border) rounded-2xl">
			<QrCode data={userAddress || ''} width={200} colorDark="#00d2ff" colorLight="#0d0d14" alt="Deposit address" />
		</div>
	</div>

	<!-- Address -->
	<div class="flex flex-col gap-1.5 px-6 pb-4">
		<span class="text-gray-500 text-xs2 font-mono uppercase tracking-wider">{$t('mt.depositAddress')}</span>
		<div class="flex items-center gap-2 px-3 py-2.5 bg-(--bg-surface) border border-(--border) rounded-[10px]">
			<span class="text-cyan-400 text-xs font-mono break-all flex-1">{userAddress}</span>
			<button onclick={onCopyAddress} class="px-3 py-1 rounded-md border border-cyan/30 bg-cyan/10 text-cyan text-xs3 font-mono font-semibold whitespace-nowrap shrink-0 transition-all duration-150 cursor-pointer hover:bg-cyan/15 hover:border-cyan/50">
				{addressCopied ? $t('mt.copied') : $t('mt.copy')}
			</button>
		</div>
	</div>

	<!-- Warning -->
	<div class="flex gap-2 mx-6 mb-4 px-3.5 py-2.5 bg-warning/5 border border-warning/15 rounded-[10px] text-warning">
		<svg class="shrink-0 mt-0.5" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
			<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
			<line x1="12" y1="9" x2="12" y2="13"/>
			<line x1="12" y1="17" x2="12.01" y2="17"/>
		</svg>
		<span class="text-gray-400 text-xs3 font-mono">
			{$t('mt.depositWarning1')} <strong class="text-white">{depositInfo.symbol}</strong> {$t('mt.depositWarning2')} <strong class="text-white">{depositInfo.networkName}</strong>. {$t('mt.depositWarningEnd')}
		</span>
	</div>

	<!-- Footer -->
	<div class="flex justify-between items-center px-6 py-4 border-t border-(--bg-surface-hover) bg-(--bg-surface)">
		<div class="flex items-center gap-2">
			<div class="w-3.5 h-3.5 rounded-full border-2 border-white/10 border-t-cyan-400 animate-spin"></div>
			<span class="text-gray-500 text-xs3 font-mono">{$t('mt.monitoringDeposit')}</span>
		</div>
		<button onclick={onclose} class="btn-secondary text-xs px-4 py-2 cursor-pointer">{$t('common.cancel')}</button>
	</div>
</div>
