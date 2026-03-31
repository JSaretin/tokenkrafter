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

		<!-- 1 -->
		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">{$t('tos.s1.title')}</h2>
			<p>{$t('tos.s1.body')}</p>
		</section>

		<!-- 2 -->
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

		<!-- 3 -->
		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">{$t('tos.s3.title')}</h2>
			<p>{$t('tos.s3.body')}</p>
		</section>

		<!-- 4 -->
		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">{$t('tos.s4.title')}</h2>
			<p class="mb-3">{$t('tos.s4.intro')}</p>
			<ul class="list-disc pl-5 space-y-2" style="color: var(--text-muted);">
				<li>{$t('tos.s4.l1')}</li>
				<li>{$t('tos.s4.l2')}</li>
				<li>{$t('tos.s4.l3')}</li>
				<li>{$t('tos.s4.l4')}</li>
			</ul>
		</section>

		<!-- 5 -->
		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">{$t('tos.s5.title')}</h2>
			<p>{$t('tos.s5.body')}</p>
		</section>

		<!-- 6 -->
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
			<p class="mt-3">{$t('tos.s6.outro')}</p>
		</section>

		<!-- 7 -->
		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">{$t('tos.s7.title')}</h2>
			<p>{$t('tos.s7.body')}</p>
		</section>

		<!-- 8 -->
		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">{$t('tos.s8.title')}</h2>
			<p>{$t('tos.s8.body')}</p>
		</section>

		<!-- 9 -->
		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">{$t('tos.s9.title')}</h2>
			<p class="mb-3">{$t('tos.s9.intro')}</p>
			<ul class="list-disc pl-5 space-y-2" style="color: var(--text-muted);">
				<li>{$t('tos.s9.l1')}</li>
				<li>{$t('tos.s9.l2')}</li>
				<li>{$t('tos.s9.l3')}</li>
				<li>{$t('tos.s9.l4')}</li>
				<li>{$t('tos.s9.l5')}</li>
			</ul>
		</section>

		<!-- 10 -->
		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">{$t('tos.s10.title')}</h2>
			<p>{$t('tos.s10.body')}</p>
		</section>

		<!-- 11 -->
		<section>
			<h2 class="syne text-lg font-semibold mb-3" style="color: var(--text-heading);">{$t('tos.s11.title')}</h2>
			<p>{$t('tos.s11.body')}</p>
		</section>

		<!-- Divider -->
		<div class="pt-6" style="border-top: 1px solid var(--divider);">
			<p style="color: var(--text-dim);">{$t('tos.acknowledgment')}</p>
		</div>
	</div>
</div>
