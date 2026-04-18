<script lang="ts">
	let {
		checked = $bindable(false),
		disabled = false,
		color = 'cyan',
	}: {
		checked: boolean;
		disabled?: boolean;
		color?: 'cyan' | 'amber' | 'emerald';
	} = $props();

	function toggle() {
		if (!disabled) checked = !checked;
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === ' ' || e.key === 'Enter') {
			e.preventDefault();
			toggle();
		}
	}

	// Track classes by color when checked
	const trackOn = {
		cyan: 'bg-cyan/40 border-cyan/50',
		amber: 'bg-warning border-warning/50',
		emerald: 'bg-success border-success/50',
	};

	// Thumb classes by color when checked
	const thumbOn = {
		cyan: 'bg-cyan',
		amber: 'bg-[var(--toggle-thumb)]',
		emerald: 'bg-[var(--toggle-thumb)]',
	};
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<span
	role="switch"
	aria-checked={checked}
	aria-label="Toggle"
	tabindex="0"
	class={'w-9 h-5 rounded-[10px] relative shrink-0 transition-[background] duration-200 border inline-block cursor-pointer ' +
		(checked ? trackOn[color] : 'bg-(--toggle-track) border-(--border)') + ' ' +
		(disabled ? 'opacity-50 cursor-not-allowed' : '')}
	onclick={toggle}
	onkeydown={onKeydown}
>
	<span
		class={'absolute top-px w-4 h-4 rounded-full shadow-[0_1px_3px_rgba(0,0,0,0.2)] transition-all duration-200 ' +
			(checked ? 'left-4.25 ' + thumbOn[color] : 'left-px bg-(--toggle-thumb-off)')}
	></span>
</span>
