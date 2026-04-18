<script lang="ts">
	import { t } from '$lib/i18n';

	type TokenTrust = {
		is_taxable?: boolean;
		is_mintable?: boolean;
		owner_renounced?: boolean;
	} | null;

	let { tokenTrust }: { tokenTrust: TokenTrust } = $props();

	let faqs = $derived.by(() => {
		const isPlatformToken = !!tokenTrust;
		const isTaxable = tokenTrust?.is_taxable;
		const isMintable = tokenTrust?.is_mintable && !tokenTrust?.owner_renounced;
		const isExternal = !tokenTrust;
		return [
			{ q: $t('lpd.faqCurveQ'), a: $t('lpd.faqCurveA') },
			{ q: $t('lpd.faqHardCapQ'), a: $t('lpd.faqHardCapA') },
			{ q: $t('lpd.faqSoftCapQ'), a: $t('lpd.faqSoftCapA') },
			{ q: $t('lpd.faqSafeQ'), a: $t('lpd.faqSafeA') },
			{ q: $t('lpd.faqFeeQ'), a: $t('lpd.faqFeeA') },
			{ q: $t('lpd.faqCreatorQ'), a: $t('lpd.faqCreatorA') },
			...(isTaxable ? [{ q: $t('lpd.faqTaxQ'), a: $t('lpd.faqTaxA') }] : []),
			...(isMintable ? [{ q: $t('lpd.faqMintQ'), a: $t('lpd.faqMintA') }] : []),
			...(isExternal ? [{ q: $t('lpd.faqExternalQ'), a: $t('lpd.faqExternalA') }] : []),
			...(isPlatformToken ? [{ q: $t('lpd.faqAuditedQ'), a: $t('lpd.faqAuditedA') }] : []),
		];
	});
</script>

<div class="card p-6 mb-4">
	<h3 class="syne font-bold mb-4 text-(--text-heading)">{$t('lpd.faqTitle')}</h3>
	{#each faqs as faq, i}
		<details class={"group " + (i === 0 ? "" : "border-t border-(--divider)")}>
			<summary class="py-3 syne text-sm2 font-semibold text-(--text-heading) cursor-pointer list-none flex justify-between items-center [&::-webkit-details-marker]:hidden">
				<span>{faq.q}</span>
				<span class="text-base text-(--text-dim) shrink-0 transition-transform duration-200 group-open:rotate-45">+</span>
			</summary>
			<p class="font-mono text-xs3 text-(--text-muted) leading-relaxed pb-3.5 mt-0">{faq.a}</p>
		</details>
	{/each}
</div>
