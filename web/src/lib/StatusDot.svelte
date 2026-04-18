<script lang="ts">
	type DotColor = 'cyan' | 'amber' | 'emerald' | 'red' | 'purple' | 'gray';
	type DotSize = 'sm' | 'md' | 'lg';

	let {
		color = 'cyan',
		size = 'md',
		glow = false,
		pulse = false,
	}: {
		color?: DotColor;
		size?: DotSize;
		glow?: boolean;
		pulse?: boolean;
	} = $props();

	const sizeClass: Record<DotSize, string> = {
		sm: 'w-1.5 h-1.5',
		md: 'w-2 h-2',
		lg: 'w-2.5 h-2.5',
	};

	const colorClass: Record<DotColor, string> = {
		cyan: 'bg-cyan',
		amber: 'bg-amber-400',
		emerald: 'bg-emerald-400',
		red: 'bg-danger-light',
		purple: 'bg-purple',
		gray: 'bg-gray-400',
	};

	const glowShadow: Record<DotColor, string> = {
		cyan: 'shadow-[0_0_8px_rgba(0,210,255,0.6)]',
		amber: 'shadow-[0_0_8px_rgba(245,158,11,0.6)]',
		emerald: 'shadow-[0_0_8px_rgba(16,185,129,0.6)]',
		red: 'shadow-[0_0_8px_rgba(248,113,113,0.6)]',
		purple: 'shadow-[0_0_8px_rgba(139,92,246,0.6)]',
		gray: '',
	};
</script>

<span
	class={"inline-block rounded-full shrink-0 " + sizeClass[size] + " " + colorClass[color] + " " + (glow ? glowShadow[color] : '') + " " + (pulse ? 'animate-pulse' : '')}
></span>
