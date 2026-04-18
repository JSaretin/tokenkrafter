<script lang="ts">
	import { t } from '$lib/i18n';

	let {
		state: launchState,
		isCreator,
		totalBaseRaised,
		softCap,
		isGraduating,
		onGraduate
	}: {
		state: number;
		isCreator: boolean;
		totalBaseRaised: bigint;
		softCap: bigint;
		isGraduating: boolean;
		onGraduate: () => Promise<void>;
	} = $props();

	const softCapReached = $derived(totalBaseRaised >= softCap);
	const show = $derived(launchState === 1 && isCreator && softCapReached);
</script>

{#if show}
	<div class="card p-4 mb-4">
		<p class="text-gray-400 text-xs font-mono mb-3">{$t('lpd.softCapReachedGrad')}</p>
		<button
			onclick={onGraduate}
			disabled={isGraduating}
			class="btn-primary w-full py-2.5 text-sm cursor-pointer"
		>
			{isGraduating ? $t('lpd.graduating') : $t('lpd.graduateToDex')}
		</button>
	</div>
{/if}
