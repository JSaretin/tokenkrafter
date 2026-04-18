<script lang="ts">
	let {
		isMintable = $bindable(false),
		isTaxable = $bindable(false),
		isPartner = $bindable(false),
	}: {
		isMintable: boolean;
		isTaxable: boolean;
		isPartner: boolean;
	} = $props();

	const features: { key: string; icon: string; title: string; desc: string; badge?: string }[] = [
		{ key: 'mintable', icon: '\u{1FA99}', title: 'Mintable', desc: 'Mint additional tokens after deployment' },
		{ key: 'taxable', icon: '\u{1F4B8}', title: 'Taxable', desc: 'Collect a fee on every trade' },
		{ key: 'partner', icon: '\u{1F91D}', title: 'Partnership', desc: 'Platform promotion & visibility boost', badge: 'Recommended' }
	];

	function toggleFeature(key: string) {
		if (key === 'mintable') isMintable = !isMintable;
		else if (key === 'taxable') isTaxable = !isTaxable;
		else if (key === 'partner') isPartner = !isPartner;
	}

	function featureOn(key: string) {
		if (key === 'mintable') return isMintable;
		if (key === 'taxable') return isTaxable;
		if (key === 'partner') return isPartner;
		return false;
	}
</script>

<div class="flex flex-col gap-4">
	<h3 class="font-display text-[0.85rem] text-muted uppercase tracking-[0.08em] m-0">Features</h3>
	<div class="flex flex-col gap-2">
		{#each features as f}
			<button type="button" class={'flex items-center gap-3 px-4 py-3 bg-surface border rounded-[10px] cursor-pointer transition-colors duration-200 text-left font-[inherit] text-[inherit] hover:border-[rgba(0,210,255,0.2)] ' + (featureOn(f.key) ? 'border-[rgba(0,210,255,0.35)]' : 'border-line')} onclick={() => toggleFeature(f.key)}>
				<span class="text-xl shrink-0 w-8 text-center">{f.icon}</span>
				<div class="flex-1 flex flex-col gap-[0.15rem]">
					<span class="font-mono text-[0.82rem] text-heading flex items-center gap-2">{f.title}{#if f.badge}<span class="text-[0.6rem] bg-[rgba(0,210,255,0.15)] text-[#00d2ff] px-1.5 py-0.5 rounded font-mono">{f.badge}</span>{/if}</span>
					<span class="text-[0.72rem] text-dim">{f.desc}</span>
					{#if f.key === 'partner' && isPartner}<span class="text-[0.65rem] text-[rgba(0,210,255,0.6)] mt-[0.1rem]">0.5% platform fee on trades</span>{/if}
				</div>
				<span class={'ft-toggle relative shrink-0 w-9 h-5 rounded-[10px] border transition-colors duration-200 ' + (featureOn(f.key) ? 'bg-[rgba(0,210,255,0.4)] border-[rgba(0,210,255,0.5)] is-on' : 'bg-(--toggle-track) border-line')}><span class="ft-knob absolute top-px left-px w-4 h-4 rounded-full bg-(--toggle-thumb-off) transition-all duration-200 shadow-[0_1px_3px_rgba(0,0,0,0.2)]"></span></span>
			</button>
		{/each}
	</div>
</div>

<style>
	.ft-toggle.is-on .ft-knob { left: 17px; background: #00d2ff; }
</style>
