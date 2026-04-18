<script lang="ts">
	import { t } from '$lib/i18n';
	import type { ExplorePool } from '$lib/structure';

	let {
		pools,
		activePools,
		tokenSymbol,
		tokenDecimals,
		explorerUrl,
		fmtSupply,
	}: {
		pools: ExplorePool[];
		activePools: ExplorePool[];
		tokenSymbol: string;
		tokenDecimals: number;
		explorerUrl: string;
		fmtSupply: (val: string | number, dec: number) => string;
	} = $props();
</script>

{#if pools.length > 0}
	<section class="mb-7">
		<div class="flex justify-between items-center mb-3">
			<h2 class="flex items-center gap-2 syne text-sm2 font-bold text-(--text-dim) uppercase tracking-wide m-0">
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
				{$t('explore.detail.liquidity')}
			</h2>
			<span class="font-mono text-xs2 text-(--text-dim)">{$t('explore.detail.poolsCount').replace('{active}', String(activePools.length)).replace('{total}', String(pools.length))}</span>
		</div>
		<div class="flex flex-col gap-1.5">
			{#each pools as pool, i}
				<a href="{explorerUrl}/address/{pool.address}" target="_blank" rel="noopener"
					class={'block rounded-[10px] border border-(--border-subtle) bg-(--bg-surface) no-underline text-inherit transition-all duration-200 animate-pool-in hover:border-cyan/15 hover:bg-cyan/2 ' + (pool.has_liquidity ? 'px-4 py-3.5' : 'px-4 py-2.5 opacity-40')}
					style="animation-delay: {i * 60}ms"
				>
					<div class={'flex justify-between items-center ' + (pool.has_liquidity ? 'mb-2.5' : 'mb-0')}>
						<span class="syne text-sm2 font-bold text-(--text)">{pool.name}</span>
						<span class={'font-mono text-xs2 font-bold px-2 py-0.75 rounded-[5px] ' + (pool.lp_burned && pool.lp_burned_pct >= 9900 ? 'text-success bg-success/12 border border-success/20 font-extrabold' : pool.has_liquidity && !pool.lp_burned ? 'text-warning bg-warning/6' : 'text-(--text-dim) bg-(--bg-surface)')}>
							{#if pool.lp_burned}
								{pool.lp_burned_pct >= 9900 ? $t('explore.detail.poolBurned') : $t('explore.detail.poolBurnedPct').replace('{pct}', (pool.lp_burned_pct / 100).toFixed(0))}
							{:else if pool.has_liquidity}
								{$t('explore.detail.poolHeld')}
							{:else}
								{$t('explore.detail.poolEmpty')}
							{/if}
						</span>
					</div>
					{#if pool.has_liquidity}
						<div class="flex items-center gap-0">
							<div class="flex-1">
								<span class="block font-mono text-xxs text-(--text-dim) uppercase tracking-wider mb-0.5">{tokenSymbol}</span>
								<span class="rajdhani text-base font-semibold text-(--text)">{fmtSupply(pool.reserve_token, tokenDecimals)}</span>
							</div>
							<div class="shrink-0 px-3">
								<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" opacity="0.3"><path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4"/></svg>
							</div>
							<div class="flex-1">
								<span class="block font-mono text-xxs text-(--text-dim) uppercase tracking-wider mb-0.5">{pool.base_symbol}</span>
								<span class="rajdhani text-base font-semibold text-(--text)">{fmtSupply(pool.reserve_base, 18)}</span>
							</div>
						</div>
					{/if}
				</a>
			{/each}
		</div>
	</section>
{/if}
