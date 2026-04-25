<script lang="ts">
	/**
	 * ShrinkingHeader — title that compresses into a compact bar as the
	 * user scrolls past it. iOS / Twitter pattern.
	 *
	 * Usage:
	 *   <ShrinkingHeader title="Explore Tokens" subtitle="1 token on TokenKrafter">
	 *     {#snippet right()}
	 *       <button>...filter</button>
	 *     {/snippet}
	 *   </ShrinkingHeader>
	 *
	 * Design choices:
	 *   - Uses CSS scroll-driven animations where supported (Chrome/Edge) +
	 *     IntersectionObserver fallback.
	 *   - The header is sticky so the compact form stays at the top.
	 *   - Reduced motion: hard-toggle between full and compact, no animation.
	 */
	import { onMount } from 'svelte';

	let {
		title,
		subtitle,
		right,
	}: {
		title: string;
		subtitle?: string;
		right?: import('svelte').Snippet;
	} = $props();

	let sentinelEl: HTMLDivElement | undefined = $state();
	let compact = $state(false);

	onMount(() => {
		if (!sentinelEl || typeof IntersectionObserver === 'undefined') return;
		const io = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					compact = !entry.isIntersecting;
				}
			},
			{ rootMargin: '0px 0px -100% 0px', threshold: 0 },
		);
		io.observe(sentinelEl);
		return () => io.disconnect();
	});
</script>

<!-- 1px sentinel right above the header — once it leaves the viewport
     the IO callback fires and we flip to compact. -->
<div bind:this={sentinelEl} class="sh-sentinel" aria-hidden="true"></div>

<header class="sh-header" class:sh-compact={compact}>
	<div class="sh-row">
		<div class="sh-titles">
			<h1 class="sh-title">{title}</h1>
			{#if subtitle}<p class="sh-subtitle">{subtitle}</p>{/if}
		</div>
		{#if right}
			<div class="sh-right">{@render right()}</div>
		{/if}
	</div>
</header>

<style>
	.sh-sentinel {
		height: 1px;
		margin-bottom: -1px;
	}
	.sh-header {
		position: sticky;
		top: 0;
		z-index: 30;
		background: var(--color-background, #07070d);
		padding: 1.5rem 0 0.75rem;
		transition: padding 220ms cubic-bezier(0.4, 0, 0.2, 1), box-shadow 220ms ease;
	}
	.sh-row {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
	}
	.sh-titles {
		min-width: 0;
		flex: 1 1 auto;
	}
	.sh-title {
		font-family: var(--font-display, 'Syne', sans-serif);
		font-size: 1.5rem;
		font-weight: 800;
		line-height: 1.15;
		letter-spacing: -0.01em;
		color: var(--color-heading, #fff);
		margin: 0;
		transition: font-size 220ms cubic-bezier(0.4, 0, 0.2, 1);
	}
	.sh-subtitle {
		font-family: var(--font-mono, monospace);
		font-size: 0.75rem;
		color: var(--color-muted, #64748b);
		margin: 0.35rem 0 0;
		max-height: 1.4rem;
		opacity: 1;
		overflow: hidden;
		transition: max-height 220ms cubic-bezier(0.4, 0, 0.2, 1), opacity 180ms ease, margin-top 220ms ease;
	}
	.sh-right {
		flex: 0 0 auto;
	}

	/* Compact state — fired by the IntersectionObserver. */
	.sh-compact {
		padding: 0.5rem 0;
		box-shadow: 0 1px 0 0 var(--color-line-subtle, rgba(255,255,255,0.05));
	}
	.sh-compact .sh-title {
		font-size: 1rem;
	}
	.sh-compact .sh-subtitle {
		max-height: 0;
		margin-top: 0;
		opacity: 0;
	}

	@media (min-width: 640px) {
		.sh-title { font-size: 1.875rem; }
		.sh-compact .sh-title { font-size: 1.125rem; }
	}

	@media (prefers-reduced-motion: reduce) {
		.sh-header,
		.sh-title,
		.sh-subtitle {
			transition: none !important;
		}
	}
</style>
