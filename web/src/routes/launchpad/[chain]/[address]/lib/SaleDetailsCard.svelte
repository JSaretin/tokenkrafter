<script lang="ts">
	import { t } from '$lib/i18n';
	import { formatUsdt, type LaunchInfo } from '$lib/launchpad';
	import { chainSlug, type SupportedNetwork } from '$lib/structure';

	type TokenTrust = unknown | null;

	let {
		launch,
		usdtDecimals,
		tokenTrust,
		maxBuyPerWallet,
		minBuyUsdt,
		network,
		onCopyAddress
	}: {
		launch: LaunchInfo;
		usdtDecimals: number;
		tokenTrust: TokenTrust;
		maxBuyPerWallet: bigint;
		minBuyUsdt: bigint;
		network: SupportedNetwork | null;
		onCopyAddress: (address: string) => void;
	} = $props();

	let ud = $derived(usdtDecimals);

	let maxBuyPct = $derived.by(() => {
		if (launch.hardCap === 0n || maxBuyPerWallet === 0n) return 0;
		return Number((maxBuyPerWallet * 10000n) / launch.hardCap) / 100;
	});

	let contracts = $derived([
		[$t('lpd.tokenLabel'), launch.token, tokenTrust ? `/explore/${chainSlug(network?.chain_id ?? 56)}/${launch.token}` : `${network?.explorer_url || ''}/address/${launch.token}`] as const,
		[$t('lpd.launchLabel'), launch.address, `${network?.explorer_url || ''}/address/${launch.address}`] as const,
		[$t('lpd.creatorLabelDetail'), launch.creator, `${network?.explorer_url || ''}/address/${launch.creator}`] as const,
	]);
</script>

<div class="card py-4.5 px-5 mb-4">
	<h3 class="syne text-sm2 font-extrabold text-(--text-heading) mb-3">{$t('lpd.saleDetailsTitle')}</h3>

	<!-- Trust highlights — the things buyers care about most -->
	<div class="flex flex-col gap-1.5 mb-3.5">
		<div class="flex items-center gap-2 py-2 px-3 rounded-lg bg-success/[0.06] border border-success/[0.12] font-mono text-xs3 text-success font-semibold">
			<svg class="text-success shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z"/><path d="M8 12l3 3 5-5"/></svg>
			<span>{$t('lpd.lpBurnedTrust')}</span>
		</div>
		<div class="flex items-center gap-2 py-2 px-3 rounded-lg bg-cyan-400/[0.04] border border-cyan-400/[0.08] font-mono text-xs3 text-(--text-muted)">
			<svg class="text-cyan shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/></svg>
			<span>{$t('lpd.refundTrust')}</span>
		</div>
	</div>

	<div class="mb-3.5">
		<div class="flex justify-between items-center py-2 border-b border-(--border-subtle)">
			<span class="font-mono text-xs3 text-(--text-dim)">{$t('lpd.buyFeeRow')}</span>
			<span class="syne text-sm2 font-bold text-(--text-heading)">1% <span class="text-xs2 text-(--text-dim) font-normal">{$t('lpd.buyFeeValue')}</span></span>
		</div>
		<div class="flex justify-between items-center py-2 border-b border-(--border-subtle)">
			<span class="font-mono text-xs3 text-(--text-dim)">{$t('lpd.graduationFeeRow')}</span>
			<span class="syne text-sm2 font-bold text-(--text-heading)">1% <span class="text-xs2 text-(--text-dim) font-normal">{$t('lpd.graduationFeeValue')}</span></span>
		</div>
		{#if maxBuyPerWallet > 0n}
			<div class="flex justify-between items-center py-2 border-b border-(--border-subtle)">
				<span class="font-mono text-xs3 text-(--text-dim)">{$t('lpd.maxPerWalletRow')}</span>
				<span class="syne text-sm2 font-bold text-(--text-heading)">{formatUsdt(maxBuyPerWallet, ud)} <span class="text-xs2 text-(--text-dim) font-normal">({maxBuyPct}%)</span></span>
			</div>
		{/if}
		{#if minBuyUsdt > 0n}
			<div class="flex justify-between items-center py-2 border-b border-(--border-subtle)">
				<span class="font-mono text-xs3 text-(--text-dim)">{$t('lpd.minBuyRow')}</span>
				<span class="syne text-sm2 font-bold text-(--text-heading)">{formatUsdt(minBuyUsdt, ud)}</span>
			</div>
		{/if}
		<div class="flex justify-between items-center py-2">
			<span class="font-mono text-xs3 text-(--text-dim)">{$t('lpd.dexAtGraduation')}</span>
			<span class="syne text-sm2 font-bold text-(--text-heading)">{network?.symbol === 'BSC' ? 'PancakeSwap' : 'Uniswap'} V2</span>
		</div>
	</div>

	<div class="border-t border-(--border-subtle) pt-3">
		<span class="block rajdhani text-xs2 text-(--text-dim) uppercase tracking-wide mb-2">{$t('lpd.contractsLabel')}</span>
		{#each contracts as [label, addr, href]}
			<div class="flex justify-between items-center py-1 rajdhani text-xs3">
				<span class="text-(--text-dim)">{label}</span>
				<div class="flex items-center gap-1.5">
					<a href={href} target={label === $t('lpd.tokenLabel') && tokenTrust ? undefined : '_blank'} rel="noopener noreferrer" class="text-(--text-muted) no-underline font-mono text-xs2 hover:text-cyan">{addr.slice(0, 6)}…{addr.slice(-4)}</a>
					<button class="bg-transparent border-none cursor-pointer p-0.5 text-(--text-dim) opacity-50 transition-opacity duration-150 hover:opacity-100 hover:text-cyan" title={$t('lpd.copyAddressTitle')} onclick={() => onCopyAddress(addr)}>
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
					</button>
				</div>
			</div>
		{/each}
	</div>
</div>
