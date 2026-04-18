<script lang="ts">
	import { t } from '$lib/i18n';

	let {
		state,
		dismissed = $bindable(),
		onDismiss
	}: {
		state: number;
		dismissed: boolean;
		onDismiss?: () => void;
	} = $props();

	function handleDismiss() {
		dismissed = true;
		onDismiss?.();
	}
</script>

{#if state === 2 && !dismissed}
	<div class="relative overflow-hidden rounded-[14px] bg-gradient-to-br from-emerald-500/[0.12] to-emerald-400/[0.08] border border-emerald-500/30 py-4 px-5 mb-6">
		<!-- Sparkle particles (Tailwind animate-ping) -->
		<div class="pointer-events-none absolute inset-0 overflow-hidden">
			<span class="absolute top-[20%] left-[10%] w-1.5 h-1.5 rounded-full bg-emerald-300 opacity-70 animate-ping"></span>
			<span class="absolute top-[60%] right-[15%] w-1.5 h-1.5 rounded-full bg-emerald-500 opacity-60 animate-ping [animation-delay:0.5s]"></span>
			<span class="absolute top-[40%] left-[60%] w-1 h-1 rounded-full bg-emerald-400 opacity-60 animate-ping [animation-delay:1s]"></span>
		</div>
		<div class="relative z-[1] flex items-center justify-between gap-3">
			<span class="text-sm font-mono text-emerald-400 font-semibold">🎉 {$t('lpd.graduatedBanner')}</span>
			<button
				class="shrink-0 w-7 h-7 flex items-center justify-center rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs cursor-pointer transition-all duration-150 hover:bg-emerald-500/20 hover:border-emerald-500/40"
				onclick={handleDismiss}
				title={$t('lpd.dismissBanner')}
			>✕</button>
		</div>
	</div>
{/if}
