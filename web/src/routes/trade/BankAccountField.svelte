<script lang="ts">
	import { t } from '$lib/i18n';

	let {
		value = $bindable(''),
		label = '',
	}: {
		value?: string;
		label?: string;
	} = $props();
</script>

<label class="flex flex-col">
	<span class="font-mono text-xs2 font-semibold uppercase tracking-[0.05em] text-(--text-muted) mb-1">
		{label || $t('trade.accountNumber')}
	</span>
	<input
		type="text"
		class="input-field"
		placeholder={$t('trade.accountNumberPlaceholder')}
		maxlength="10"
		inputmode="numeric"
		pattern="[0-9]*"
		{value}
		oninput={(e) => { value = e.currentTarget.value.replace(/\D/g, ''); }}
	/>
</label>
