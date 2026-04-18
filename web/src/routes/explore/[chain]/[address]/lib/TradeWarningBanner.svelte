<script lang="ts">
	import { t } from '$lib/i18n';
	import type { TaxInfo } from '$lib/tradeLens';

	let {
		isHoneypot,
		notTradingYet,
		taxInfo,
		chainSlug,
		tokenAddress,
	}: {
		isHoneypot: boolean;
		notTradingYet: boolean;
		taxInfo: TaxInfo | null;
		chainSlug: string;
		tokenAddress: string;
	} = $props();
</script>

{#if isHoneypot}
	<div class="flex items-center gap-3 px-4 py-3 mb-4 rounded-xl bg-danger/8 border border-danger/25 text-danger-light relative z-[1]">
		<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
		<div class="flex flex-col gap-0.5">
			<strong class="syne text-xs2">{$t('explore.detail.honeypotWarning')}</strong>
			<span class="font-mono text-xs3 text-danger-lighter">
				{#if !taxInfo?.canBuy && !taxInfo?.canSell}{$t('explore.detail.cannotBuySell')}{:else if !taxInfo?.canBuy}{$t('explore.detail.cannotBuy').replace('{error}', taxInfo?.buyError || $t('explore.detail.revertsErr'))}{:else}{$t('explore.detail.cannotSell').replace('{error}', taxInfo?.sellError || $t('explore.detail.honeypotErr'))}{/if}
			</span>
		</div>
	</div>
{:else if notTradingYet}
	<div class="flex items-center gap-3 px-4 py-3 mb-4 rounded-xl bg-cyan/4 border border-cyan/15 text-(--text-muted) relative z-[1]">
		<svg class="text-cyan shrink-0" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
		<div class="flex flex-col gap-0.5">
			<strong class="syne text-xs2 text-(--text-heading)">{$t('explore.detail.notTradingYet')}</strong>
			<span class="font-mono text-xs3 leading-relaxed">{$t('explore.detail.notTradingDesc')} <a class="text-cyan underline" href="/manage-tokens/{chainSlug}/{tokenAddress}">{$t('explore.detail.tokenManagementPage')}</a>.</span>
		</div>
	</div>
{/if}
