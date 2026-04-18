<script lang="ts">
	import { t } from '$lib/i18n';
	import { formatTokens } from '$lib/launchpad';
	import type { LaunchInfo } from '$lib/launchpad';

	let {
		launch,
		isCreator,
		userAddress,
		isDepositing,
		isActivating,
		preflightReady,
		preflightReason,
		tokenDecimals,
		tokenSymbol,
		onDeposit,
		onActivate,
	}: {
		launch: LaunchInfo;
		isCreator: boolean;
		userAddress: string | null;
		isDepositing: boolean;
		isActivating: boolean;
		preflightReady: boolean;
		preflightReason: string;
		tokenDecimals: number;
		tokenSymbol: string;
		onDeposit: () => Promise<void>;
		onActivate: () => Promise<void>;
	} = $props();

	// Only render when creator during state 0
	let shouldRender = $derived(launch.state === 0 && isCreator && !!userAddress);

	let remaining = $derived(launch.totalTokensRequired - launch.totalTokensDeposited);
	let depositPct = $derived(
		launch.totalTokensRequired > 0n
			? Number((launch.totalTokensDeposited * 100n) / launch.totalTokensRequired)
			: 0
	);
</script>

{#if shouldRender}
	<div class="card p-6 mb-4 border border-amber-500/20">
		<h3 class="syne font-bold text-amber-400 mb-2">{$t('lpd.depositRequired')}</h3>
		<p class="text-gray-400 text-xs font-mono mb-4">
			{$t('lpd.depositPendingMsg')}
		</p>

		<div class="detail-grid mb-4">
			<div class="detail-row">
				<span class="detail-label">{$t('lpd.totalRequired')}</span>
				<span class="detail-value">{formatTokens(launch.totalTokensRequired, tokenDecimals)} {tokenSymbol}</span>
			</div>
			<div class="detail-row">
				<span class="detail-label">{$t('lpd.deposited')}</span>
				<span class="detail-value">{formatTokens(launch.totalTokensDeposited, tokenDecimals)} {tokenSymbol}</span>
			</div>
			<div class="detail-row">
				<span class="detail-label">{$t('lpd.remaining')}</span>
				<span class="detail-value text-amber-400">{formatTokens(remaining, tokenDecimals)} {tokenSymbol}</span>
			</div>
		</div>

		<div class="mb-4">
			<div class="flex justify-between text-xs2 font-mono mb-1">
				<span class="text-gray-500">{$t('lpd.depositProgress')}</span>
				<span class="text-gray-400">{depositPct}%</span>
			</div>
			<div class="progress-track">
				<div class="progress-fill progress-amber" style="width: {depositPct}%"></div>
			</div>
		</div>

		{#if remaining > 0n}
			<button
				onclick={onDeposit}
				disabled={isDepositing}
				class="btn-primary w-full py-3 text-sm cursor-pointer"
			>
				{isDepositing ? $t('lpd.depositing') : `${$t('lpd.approveDeposit')} ${formatTokens(remaining, tokenDecimals)} ${tokenSymbol}`}
			</button>
			<p class="text-gray-600 text-xs2 font-mono mt-2 text-center">
				{$t('lpd.depositNotice')}
			</p>
		{:else}
			<p class="text-emerald-400 text-xs font-mono text-center">{$t('lpd.allDeposited')}</p>
		{/if}

		<!-- Preflight checklist — shown when deposit is complete but
		     the launch didn't auto-activate (e.g. the launch instance
		     wasn't authorized as a launcher at deposit time). -->
		{#if remaining === 0n && !preflightReady && preflightReason}
			<div class="mt-4 pt-4 border-t border-white/5">
				<p class="text-amber-300 text-xs font-mono mb-3">
					{$t('lpd.preflightWaiting')}
				</p>
				<div class="detail-grid mb-3">
					<div class="detail-row">
						<span class="detail-label">{$t('lpd.preflightTokens')}</span>
						<span class="detail-value text-emerald-400">✓</span>
					</div>
					<div class="detail-row">
						<span class="detail-label">{$t('lpd.preflightLimits')}</span>
						<span class={"detail-value " + (preflightReason === 'NOT_EXCLUDED_FROM_LIMITS' ? 'text-red-400' : 'text-emerald-400')}>
							{preflightReason === 'NOT_EXCLUDED_FROM_LIMITS' ? '✗' : '✓'}
						</span>
					</div>
					<div class="detail-row">
						<span class="detail-label">{$t('lpd.preflightTaxFree')}</span>
						<span class={"detail-value " + (preflightReason === 'NOT_TAX_EXEMPT' ? 'text-red-400' : 'text-emerald-400')}>
							{preflightReason === 'NOT_TAX_EXEMPT' ? '✗' : '✓'}
						</span>
					</div>
					<div class="detail-row">
						<span class="detail-label">{$t('lpd.preflightAuthorized')}</span>
						<span class={"detail-value " + (preflightReason === 'NOT_AUTHORIZED_LAUNCHER' ? 'text-red-400' : 'text-emerald-400')}>
							{preflightReason === 'NOT_AUTHORIZED_LAUNCHER' ? '✗' : '✓'}
						</span>
					</div>
				</div>
				<p class="text-gray-500 text-xs2 font-mono mb-3">
					{$t('lpd.fixActivateNote')}
				</p>
				<button
					onclick={onDeposit}
					disabled={isDepositing || isActivating}
					class="btn-primary w-full py-2.5 text-sm cursor-pointer"
				>
					{isDepositing || isActivating ? $t('lpd.working') : $t('lpd.fixActivateBtn')}
				</button>
			</div>
		{/if}

		<!-- Ready to activate manually — deposit was complete but
		     the auto-activation didn't fire (edge case; UI exposes
		     the `activate()` escape hatch). -->
		{#if remaining === 0n && preflightReady && launch.state === 0}
			<div class="mt-4 pt-4 border-t border-white/5">
				<p class="text-emerald-300 text-xs font-mono mb-3">
					{$t('lpd.readyToActivate')}
				</p>
				<button
					onclick={onActivate}
					disabled={isActivating}
					class="btn-primary w-full py-2.5 text-sm cursor-pointer"
				>
					{isActivating ? $t('lpd.activatingShort') : $t('lpd.activateLaunchBtn')}
				</button>
			</div>
		{/if}
	</div>
{/if}
