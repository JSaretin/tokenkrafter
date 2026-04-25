<script lang="ts">
	// Reusable skeleton primitive used to fill space with a layout-matching
	// shimmer block while real content loads. Replace any "centered spinner
	// before any content has rendered" pattern with one or more <Skeleton/>
	// rectangles arranged like the markup that's about to appear.
	//
	// Keep transient action indicators (button-press waiting, modal busy state,
	// per-row refreshes on already-rendered data) as spinners — skeletons are
	// only for the initial blocking fetch.

	type Variant = 'rect' | 'circle' | 'text';

	let {
		width = '100%',
		height = '1em',
		radius = '6px',
		variant = 'rect',
		class: className = '',
	}: {
		width?: string | number;
		height?: string | number;
		radius?: string;
		variant?: Variant;
		class?: string;
	} = $props();

	const w = $derived(typeof width === 'number' ? `${width}px` : width);
	const h = $derived(typeof height === 'number' ? `${height}px` : height);
	const r = $derived(variant === 'circle' ? '50%' : radius);
</script>

<span
	class={'sk ' + className}
	style="width: {w}; height: {h}; border-radius: {r}"
	aria-hidden="true"
></span>

<style>
	.sk {
		display: inline-block;
		background: linear-gradient(
			90deg,
			rgba(255, 255, 255, 0.04) 25%,
			rgba(255, 255, 255, 0.08) 50%,
			rgba(255, 255, 255, 0.04) 75%
		);
		background-size: 200% 100%;
		animation: sk-shimmer 1.4s ease-in-out infinite;
		vertical-align: middle;
	}
	@keyframes sk-shimmer {
		0% {
			background-position: 200% 0;
		}
		100% {
			background-position: -200% 0;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.sk {
			animation: none;
			opacity: 0.7;
		}
	}
</style>
