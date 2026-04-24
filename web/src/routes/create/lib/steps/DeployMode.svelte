<script lang="ts">
	import { t } from '$lib/i18n';

	let {
		deployMode = $bindable(null as 'token' | 'launch' | 'both' | 'list' | null),
	}: {
		deployMode: 'token' | 'launch' | 'both' | 'list' | null;
	} = $props();
</script>

<div class="py-2">
	<div class="text-center mb-6">
		<h3 class="font-display text-xl font-bold text-white mb-1">{$t('ci.pageTitle')}</h3>
		<p class="text-gray-500 font-mono text-xs">{$t('ci.pageSub')}</p>
	</div>

	<div class="grid grid-cols-2 gap-3">
		<button type="button" class={'flex flex-col items-center text-center px-3.5 py-5 cursor-pointer transition-all duration-[250ms] border bg-surface rounded-[14px] relative hover:-translate-y-0.5 hover:shadow-[0_8px_30px_rgba(0,0,0,0.25)] hover:border-[rgba(0,210,255,0.2)] hover:bg-[rgba(0,210,255,0.03)] ' + (deployMode === 'token' ? 'border-[rgba(0,210,255,0.5)] bg-[rgba(0,210,255,0.06)] shadow-[0_0_20px_rgba(0,210,255,0.1)]' : 'border-line')} onclick={() => deployMode = 'token'}>
			<div class="w-12 h-12 flex items-center justify-center rounded-xl bg-[rgba(0,210,255,0.1)] text-[#00d2ff] border border-[rgba(0,210,255,0.2)]">
				<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v12M6 12h12"/></svg>
			</div>
			<h3 class="font-display text-sm font-bold text-white mt-3 mb-0.5">{$t('ci.createToken')}</h3>
			<p class="text-gray-400 font-mono text-xs2 leading-snug">{$t('ci.createTokenSub')}</p>
		</button>

		<button type="button" class={'intent-featured col-span-full order-[-1] flex flex-col items-center text-center px-5 py-6 cursor-pointer transition-all duration-[250ms] border bg-surface rounded-[14px] relative overflow-hidden hover:-translate-y-0.5 hover:shadow-[0_8px_30px_rgba(0,0,0,0.25)] hover:bg-[rgba(0,210,255,0.03)] ' + (deployMode === 'both' ? 'border-[rgba(0,210,255,0.5)] bg-[rgba(0,210,255,0.06)] shadow-[0_0_20px_rgba(0,210,255,0.1)]' : 'border-[rgba(0,210,255,0.15)]')} onclick={() => deployMode = 'both'}>
			<span class="badge badge-cyan mb-2 text-[0.6rem] px-2 py-[0.15rem]">{$t('ci.recommended')}</span>
			<div class="w-12 h-12 flex items-center justify-center rounded-xl bg-[rgba(0,210,255,0.1)] text-[#00d2ff] border border-[rgba(0,210,255,0.2)]">
				<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
			</div>
			<h3 class="font-display text-base font-bold text-white mt-3 mb-0.5">{$t('ci.createAndLaunch')}</h3>
			<p class="text-gray-500 font-mono text-xs2 leading-snug">{$t('ci.createAndLaunchSub')}</p>
		</button>

		<button type="button" class={'flex flex-col items-center text-center px-3.5 py-5 cursor-pointer transition-all duration-[250ms] border bg-surface rounded-[14px] relative hover:-translate-y-0.5 hover:shadow-[0_8px_30px_rgba(0,0,0,0.25)] hover:border-[rgba(0,210,255,0.2)] hover:bg-[rgba(0,210,255,0.03)] ' + (deployMode === 'list' ? 'border-[rgba(0,210,255,0.5)] bg-[rgba(0,210,255,0.06)] shadow-[0_0_20px_rgba(0,210,255,0.1)]' : 'border-line')} onclick={() => deployMode = 'list'}>
			<div class="w-12 h-12 flex items-center justify-center rounded-xl bg-[rgba(245,158,11,0.1)] text-amber-500 border border-[rgba(245,158,11,0.2)]">
				<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
			</div>
			<h3 class="font-display text-sm font-bold text-white mt-3 mb-0.5">Create & List on DEX</h3>
			<p class="text-gray-400 font-mono text-xs2 leading-snug">Create token and add liquidity to DEX instantly.</p>
		</button>

		<button type="button" class={'flex flex-col items-center text-center px-3.5 py-5 cursor-pointer transition-all duration-[250ms] border bg-surface rounded-[14px] relative hover:-translate-y-0.5 hover:shadow-[0_8px_30px_rgba(0,0,0,0.25)] hover:border-[rgba(0,210,255,0.2)] hover:bg-[rgba(0,210,255,0.03)] ' + (deployMode === 'launch' ? 'border-[rgba(0,210,255,0.5)] bg-[rgba(0,210,255,0.06)] shadow-[0_0_20px_rgba(0,210,255,0.1)]' : 'border-line')} onclick={() => deployMode = 'launch'}>
			<div class="w-12 h-12 flex items-center justify-center rounded-xl bg-[rgba(16,185,129,0.1)] text-emerald-500 border border-[rgba(16,185,129,0.2)]">
				<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>
			</div>
			<h3 class="font-display text-sm font-bold text-white mt-3 mb-0.5">{$t('ci.launchExisting')}</h3>
			<p class="text-gray-400 font-mono text-xs2 leading-snug">{$t('ci.launchExistingSub')}</p>
		</button>
	</div>
</div>

<style>
	.intent-featured::before {
		content: '';
		position: absolute;
		inset: 0;
		background: radial-gradient(ellipse at 50% 0%, rgba(0,210,255,0.06), transparent 70%);
		pointer-events: none;
	}
</style>
