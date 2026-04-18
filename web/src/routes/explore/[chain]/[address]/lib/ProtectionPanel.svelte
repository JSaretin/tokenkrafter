<script lang="ts">
	import { t } from '$lib/i18n';
	import type { ProtectionSettings } from '$lib/PlatformTokenClient';

	let {
		protection,
		decimals,
		fmtSupply,
	}: {
		protection: ProtectionSettings;
		decimals: number;
		fmtSupply: (val: string | number, dec: number) => string;
	} = $props();

	let hasAny = $derived(
		protection.maxWallet > 0n ||
		protection.maxTransaction > 0n ||
		protection.cooldownTime > 0n ||
		protection.blacklistWindow > 0n
	);
</script>

{#if hasAny}
	<div class="bg-(--bg-surface) border border-(--border-subtle) rounded-xl p-4 mb-4">
		<div class="flex items-center gap-2 syne text-xs2 font-bold text-(--text-heading) mb-3">
			<svg class="text-success shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
			<span>{$t('explore.detail.protectionSettings')}</span>
			<span class="ml-auto font-mono text-xxs text-(--text-dim) font-normal">{$t('explore.detail.protectionHint')}</span>
		</div>
		<div class="grid grid-cols-2 gap-2">
			{#if protection.maxWallet > 0n}
				<div class="px-3 py-2.5 rounded-lg bg-(--bg-surface-input) border border-(--border-subtle)">
					<span class="block font-mono text-xxs text-(--text-dim) uppercase tracking-wide">{$t('explore.detail.maxWallet')}</span>
					<span class="block rajdhani text-md font-semibold text-(--text) mt-0.5">{fmtSupply(protection.maxWallet.toString(), decimals)}</span>
				</div>
			{/if}
			{#if protection.maxTransaction > 0n}
				<div class="px-3 py-2.5 rounded-lg bg-(--bg-surface-input) border border-(--border-subtle)">
					<span class="block font-mono text-xxs text-(--text-dim) uppercase tracking-wide">{$t('explore.detail.maxTransaction')}</span>
					<span class="block rajdhani text-md font-semibold text-(--text) mt-0.5">{fmtSupply(protection.maxTransaction.toString(), decimals)}</span>
				</div>
			{/if}
			{#if protection.cooldownTime > 0n}
				<div class="px-3 py-2.5 rounded-lg bg-(--bg-surface-input) border border-(--border-subtle)">
					<span class="block font-mono text-xxs text-(--text-dim) uppercase tracking-wide">{$t('explore.detail.cooldown')}</span>
					<span class="block rajdhani text-md font-semibold text-(--text) mt-0.5">{Number(protection.cooldownTime)}s</span>
				</div>
			{/if}
			{#if protection.blacklistWindow > 0n}
				<div class="px-3 py-2.5 rounded-lg bg-(--bg-surface-input) border border-(--border-subtle)">
					<span class="block font-mono text-xxs text-(--text-dim) uppercase tracking-wide">{$t('explore.detail.blacklistWindow')}</span>
					<span class="block rajdhani text-md font-semibold text-(--text) mt-0.5">{Math.round(Number(protection.blacklistWindow) / 3600)}h</span>
				</div>
			{/if}
		</div>
	</div>
{/if}
