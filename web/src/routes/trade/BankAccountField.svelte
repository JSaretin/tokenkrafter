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

<div class="flex flex-col">
	<label class="font-mono text-xs2 font-semibold uppercase tracking-[0.05em] text-(--text-muted) mb-1">
		{label || $t('trade.accountNumber')}
	</label>
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
</div>
