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

<div class="features">
	<h3 class="heading">Features</h3>
	<div class="cards">
		{#each features as f}
			<button class="card" class:on={featureOn(f.key)} onclick={() => toggleFeature(f.key)}>
				<span class="icon">{f.icon}</span>
				<div class="info">
					<span class="title">{f.title}{#if f.badge}<span class="badge">{f.badge}</span>{/if}</span>
					<span class="desc">{f.desc}</span>
					{#if f.key === 'partner' && isPartner}<span class="note">1% platform fee on trades</span>{/if}
				</div>
				<span class="toggle" class:on={featureOn(f.key)}><span class="knob"></span></span>
			</button>
		{/each}
	</div>
</div>

<style>
	.features { display: flex; flex-direction: column; gap: 1rem; }
	.heading { font-family: 'Syne', sans-serif; font-size: 0.85rem; color: rgba(255,255,255,0.5); text-transform: uppercase; letter-spacing: 0.08em; margin: 0; }
	.cards { display: flex; flex-direction: column; gap: 0.5rem; }
	.card {
		display: flex; align-items: center; gap: 0.75rem; padding: 0.75rem 1rem;
		background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);
		border-radius: 10px; cursor: pointer; transition: border-color 0.2s; text-align: left;
		font-family: inherit; color: inherit;
	}
	.card:hover { border-color: rgba(0,210,255,0.2); }
	.card.on { border-color: rgba(0,210,255,0.35); }
	.icon { font-size: 1.25rem; flex-shrink: 0; width: 2rem; text-align: center; }
	.info { flex: 1; display: flex; flex-direction: column; gap: 0.15rem; }
	.title { font-family: 'Space Mono', monospace; font-size: 0.82rem; color: rgba(255,255,255,0.9); display: flex; align-items: center; gap: 0.5rem; }
	.desc { font-size: 0.72rem; color: rgba(255,255,255,0.35); }
	.badge { font-size: 0.6rem; background: rgba(0,210,255,0.15); color: #00d2ff; padding: 0.1rem 0.4rem; border-radius: 4px; font-family: 'Space Mono', monospace; }
	.note { font-size: 0.65rem; color: rgba(0,210,255,0.6); margin-top: 0.1rem; }
	.toggle {
		width: 36px; height: 20px; border-radius: 10px; background: rgba(255,255,255,0.1);
		position: relative; flex-shrink: 0; transition: background 0.2s;
	}
	.toggle.on { background: rgba(0,210,255,0.4); }
	.knob {
		position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
		border-radius: 50%; background: rgba(255,255,255,0.5); transition: all 0.2s;
	}
	.toggle.on .knob { left: 18px; background: #00d2ff; }
</style>
