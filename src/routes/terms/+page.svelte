<script lang="ts">
	import { t } from '$lib/i18n';
</script>

<svelte:head>
	<title>{$t('tos.title')} | TokenKrafter</title>
	<meta name="description" content="TokenKrafter Terms of Service" />
</svelte:head>

<div class="max-w-3xl mx-auto px-4 py-16">
	<h1 class="syne text-3xl md:text-4xl font-bold mb-2" style="color: var(--text-heading);">{$t('tos.title')}</h1>
	<p class="text-sm mb-10" style="color: var(--text-muted);">{$t('tos.lastUpdated')}</p>

	<div class="space-y-10 text-sm leading-relaxed" style="color: var(--text);">

		<!-- 1. Acceptance -->
		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">{$t('tos.s1.title')}</h2>
			<p>{$t('tos.s1.body')}</p>
		</section>

		<!-- 2. Platform Overview -->
		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">{$t('tos.s2.title')}</h2>
			<p class="mb-3">{$t('tos.s2.intro')}</p>
			<ul class="list-disc pl-5 space-y-2" style="color: var(--text-muted);">
				<li>{$t('tos.s2.l1')}</li>
				<li>{$t('tos.s2.l2')}</li>
				<li>{$t('tos.s2.l3')}</li>
				<li>{$t('tos.s2.l4')}</li>
				<li>{$t('tos.s2.l5')}</li>
			</ul>
		</section>

		<!-- 3. Risk Disclaimer -->
		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">{$t('tos.s3.title')}</h2>
			<p class="mb-3">{$t('tos.s3.intro')}</p>
			<ul class="list-disc pl-5 space-y-2" style="color: var(--text-muted);">
				<li>{$t('tos.s3.l1')}</li>
				<li>{$t('tos.s3.l2')}</li>
				<li>{$t('tos.s3.l3')}</li>
				<li>{$t('tos.s3.l4')}</li>
				<li>{$t('tos.s3.l5')}</li>
				<li>{$t('tos.s3.l6')}</li>
				<li>{$t('tos.s3.l7')}</li>
			</ul>
		</section>

		<!-- 4. No Financial Advice -->
		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">{$t('tos.s4.title')}</h2>
			<p>{$t('tos.s4.body')}</p>
		</section>

		<!-- 5. Embedded Wallet -->
		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">{$t('tos.s5.title')}</h2>
			<p class="mb-3">{$t('tos.s5.intro')}</p>
			<ul class="list-disc pl-5 space-y-2" style="color: var(--text-muted);">
				<li>{$t('tos.s5.l1')}</li>
				<li>{$t('tos.s5.l2')}</li>
				<li>{$t('tos.s5.l3')}</li>
				<li>{$t('tos.s5.l4')}</li>
				<li>{$t('tos.s5.l5')}</li>
				<li>{$t('tos.s5.l6')}</li>
			</ul>
		</section>

		<!-- 6. User Responsibility -->
		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">{$t('tos.s6.title')}</h2>
			<p class="mb-3">{$t('tos.s6.intro')}</p>
			<ul class="list-disc pl-5 space-y-2" style="color: var(--text-muted);">
				<li>{$t('tos.s6.l1')}</li>
				<li>{$t('tos.s6.l2')}</li>
				<li>{$t('tos.s6.l3')}</li>
				<li>{$t('tos.s6.l4')}</li>
				<li>{$t('tos.s6.l5')}</li>
				<li>{$t('tos.s6.l6')}</li>
			</ul>
		</section>

		<!-- 7. Fees & Transparency -->
		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">{$t('tos.s7.title')}</h2>
			<p class="mb-3">{$t('tos.s7.intro')}</p>
			<ul class="list-disc pl-5 space-y-2" style="color: var(--text-muted);">
				<li>{$t('tos.s7.l1')}</li>
				<li>{$t('tos.s7.l2')}</li>
				<li>{$t('tos.s7.l3')}</li>
				<li>{$t('tos.s7.l4')}</li>
				<li>{$t('tos.s7.l5')}</li>
				<li>{$t('tos.s7.l6')}</li>
				<li>{$t('tos.s7.l7')}</li>
			</ul>
		</section>

		<!-- 8. Fiat Off-Ramp -->
		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">{$t('tos.s8.title')}</h2>
			<p class="mb-3">{$t('tos.s8.intro')}</p>
			<ul class="list-disc pl-5 space-y-2" style="color: var(--text-muted);">
				<li>{$t('tos.s8.l1')}</li>
				<li>{$t('tos.s8.l2')}</li>
				<li>{$t('tos.s8.l3')}</li>
				<li>{$t('tos.s8.l4')}</li>
				<li>{$t('tos.s8.l5')}</li>
			</ul>
		</section>

		<!-- 9. Platform Liability -->
		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">{$t('tos.s9.title')}</h2>
			<p>{$t('tos.s9.body')}</p>
		</section>

		<!-- 10. Prohibited Use -->
		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">{$t('tos.s10.title')}</h2>
			<p class="mb-3">{$t('tos.s10.intro')}</p>
			<ul class="list-disc pl-5 space-y-2" style="color: var(--text-muted);">
				<li>{$t('tos.s10.l1')}</li>
				<li>{$t('tos.s10.l2')}</li>
				<li>{$t('tos.s10.l3')}</li>
				<li>{$t('tos.s10.l4')}</li>
				<li>{$t('tos.s10.l5')}</li>
				<li>{$t('tos.s10.l6')}</li>
			</ul>
			<p class="mt-3">{$t('tos.s10.outro')}</p>
		</section>

		<!-- 11. Token Creator Responsibility -->
		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">{$t('tos.s11.title')}</h2>
			<p>{$t('tos.s11.body')}</p>
		</section>

		<!-- 12. Smart Contract Risk -->
		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">{$t('tos.s12.title')}</h2>
			<p>{$t('tos.s12.body')}</p>
		</section>

		<!-- 13. Partnership Tokens -->
		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">{$t('tos.s13.title')}</h2>
			<p class="mb-3">{$t('tos.s13.intro')}</p>
			<ul class="list-disc pl-5 space-y-2" style="color: var(--text-muted);">
				<li>{$t('tos.s13.l1')}</li>
				<li>{$t('tos.s13.l2')}</li>
				<li>{$t('tos.s13.l3')}</li>
				<li>{$t('tos.s13.l4')}</li>
				<li>{$t('tos.s13.l5')}</li>
			</ul>
		</section>

		<!-- 14. Smart Contract Design Philosophy -->
		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">{$t('tos.s14.title')}</h2>
			<p class="mb-3">{$t('tos.s14.intro')}</p>
			<ul class="list-disc pl-5 space-y-2" style="color: var(--text-muted);">
				<li>{$t('tos.s14.l1')}</li>
				<li>{$t('tos.s14.l2')}</li>
				<li>{$t('tos.s14.l3')}</li>
				<li>{$t('tos.s14.l4')}</li>
				<li>{$t('tos.s14.l5')}</li>
				<li>{$t('tos.s14.l6')}</li>
				<li>{$t('tos.s14.l7')}</li>
				<li>{$t('tos.s14.l8')}</li>
				<li>{$t('tos.s14.l9')}</li>
			</ul>
		</section>

		<!-- 15. Jurisdictional Compliance -->
		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">{$t('tos.s15.title')}</h2>
			<p>{$t('tos.s15.body')}</p>
		</section>

		<!-- 16. Modification of Terms -->
		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">{$t('tos.s16.title')}</h2>
			<p>{$t('tos.s16.body')}</p>
		</section>

		<!-- Divider -->
		<div class="pt-6" style="border-top: 1px solid var(--divider);">
			<p style="color: var(--text-dim);">{$t('tos.acknowledgment')}</p>
		</div>
	</div>
</div>
