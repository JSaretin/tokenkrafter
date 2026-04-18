<script lang="ts">
	import { t } from '$lib/i18n';
	import { formatTokens } from '$lib/launchpad';
	import { onDestroy } from 'svelte';

	let {
		state: launchState,
		isCreator,
		creatorAllocationBps,
		vestingCliffSeconds,
		vestingDurationSeconds,
		graduationTimestamp,
		creatorTotalTokens,
		creatorClaimed,
		tokenDecimals,
		tokenSymbol,
		onClaim,
		isClaiming
	}: {
		state: number;
		isCreator: boolean;
		creatorAllocationBps: number | bigint;
		vestingCliffSeconds: bigint;
		vestingDurationSeconds: bigint;
		graduationTimestamp: bigint;
		creatorTotalTokens: bigint;
		creatorClaimed: bigint;
		tokenDecimals: number;
		tokenSymbol: string;
		onClaim: () => Promise<void>;
		isClaiming: boolean;
	} = $props();

	// Internal tick so vested amount updates live (1s cadence, matches parent).
	let now = $state(Date.now());
	const tick = setInterval(() => { now = Date.now(); }, 1000);
	onDestroy(() => clearInterval(tick));

	const allocationOk = $derived(
		typeof creatorAllocationBps === 'bigint' ? creatorAllocationBps > 0n : creatorAllocationBps > 0
	);

	const show = $derived(
		launchState === 2 &&
		isCreator &&
		allocationOk &&
		vestingDurationSeconds > 0n &&
		graduationTimestamp > 0n
	);

	const elapsed = $derived(BigInt(Math.floor(now / 1000)) - graduationTimestamp);
	const pastCliff = $derived(elapsed >= vestingCliffSeconds);
	const vestedTime = $derived(pastCliff ? elapsed - vestingCliffSeconds : 0n);
	const totalVested = $derived(
		vestedTime >= vestingDurationSeconds
			? creatorTotalTokens
			: (vestingDurationSeconds > 0n ? (creatorTotalTokens * vestedTime / vestingDurationSeconds) : 0n)
	);
	const claimable = $derived(totalVested > creatorClaimed ? totalVested - creatorClaimed : 0n);
</script>

{#if show}
	<div class="card p-5 mb-4 border-purple-dark/20">
		<div class="flex items-center justify-between mb-3">
			<h3 class="syne font-bold text-white text-sm">{$t('lpd.creatorVesting')}</h3>
			<span class="text-purple-400 text-xs font-mono">{$t('lpd.vestSummary').replace('{vd}', String(Math.round(Number(vestingDurationSeconds) / 86400))).replace('{cd}', String(Math.round(Number(vestingCliffSeconds) / 86400)))}</span>
		</div>
		<div class="detail-grid mb-3">
			<div class="detail-row">
				<span class="detail-label">{$t('lpd.totalAllocation')}</span>
				<span class="detail-value">{formatTokens(creatorTotalTokens || 0n, tokenDecimals)} {tokenSymbol}</span>
			</div>
			<div class="detail-row">
				<span class="detail-label">{$t('lpd.claimed')}</span>
				<span class="detail-value">{formatTokens(creatorClaimed || 0n, tokenDecimals)} {tokenSymbol}</span>
			</div>
			<div class="detail-row">
				<span class="detail-label">{$t('lpd.claimableNow')}</span>
				<span class="detail-value text-purple-400">{pastCliff ? formatTokens(claimable > 0n ? claimable : 0n, tokenDecimals) : $t('lpd.cliffNotReached')} {pastCliff && claimable > 0n ? tokenSymbol : ''}</span>
			</div>
		</div>
		{#if pastCliff && claimable > 0n}
			<button class={"btn-primary text-xs px-4 py-2 w-full " + (isClaiming ? "opacity-70" : "")} disabled={isClaiming} onclick={onClaim}>
				{isClaiming ? $t('lpd.claiming') : $t('lpd.claimVested')}
			</button>
		{:else if !pastCliff}
			<p class="text-gray-500 text-xs font-mono text-center">{$t('lpd.cliffEndsIn').replace('{days}', String(Math.max(0, Math.round(Number(vestingCliffSeconds - elapsed) / 86400))))}</p>
		{/if}
	</div>
{/if}
