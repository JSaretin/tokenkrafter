<script lang="ts">
	import { t } from '$lib/i18n';

	let {
		onclick,
	}: {
		onclick: () => void;
	} = $props();
</script>

<button
	type="button"
	class="py-1 px-2.5 rounded-md border border-[rgba(0,210,255,0.25)] bg-[rgba(0,210,255,0.08)] text-[#00d2ff] cursor-pointer font-mono text-xs2 font-bold transition-all duration-150 shrink-0 hover:bg-[rgba(0,210,255,0.15)] hover:border-[rgba(0,210,255,0.4)]"
	{onclick}
>
	{$t('trade.max')}
</button>
