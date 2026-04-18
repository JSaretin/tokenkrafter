<script lang="ts">
	import { t } from '$lib/i18n';
</script>

<div class="flex items-center justify-center gap-1.5 p-2.5 mx-3 font-mono text-[11px] text-[#f59e0b] bg-[rgba(245,158,11,0.06)] rounded-[10px]">
	<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
		<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
		<line x1="12" y1="9" x2="12" y2="13" />
		<line x1="12" y1="17" x2="12.01" y2="17" />
	</svg>
	{$t('trade.noLiquidity')}
</div>
