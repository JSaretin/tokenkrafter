<script lang="ts">
	let {
		isMintable = $bindable(false),
		isTaxable = $bindable(false),
		isPartner = $bindable(false),
		launchEnabled = $bindable(false),
		listingEnabled = $bindable(false)
	}: {
		isMintable: boolean;
		isTaxable: boolean;
		isPartner: boolean;
		launchEnabled: boolean;
		listingEnabled: boolean;
	} = $props();

	const features: { key: string; icon: string; title: string; desc: string; badge?: string }[] = [
		{ key: 'mintable', icon: '🪙', title: 'Mintable', desc: 'Mint additional tokens after deployment' },
		{ key: 'taxable', icon: '💸', title: 'Taxable', desc: 'Collect a fee on every trade' },
		{ key: 'partner', icon: '🤝', title: 'Partnership', desc: 'Platform promotion & visibility boost', badge: 'Recommended' }
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

	type DeployMode = 'launch' | 'list' | 'none';
	let mode: DeployMode = $derived(launchEnabled ? 'launch' : listingEnabled ? 'list' : 'none');

	function setMode(m: DeployMode) {
		launchEnabled = m === 'launch';
		listingEnabled = m === 'list';
	}

	const modes = [
		{ key: 'launch' as DeployMode, icon: '\u{1F680}', title: 'Launch with bonding curve', desc: 'Fundraise before DEX listing' },
		{ key: 'list' as DeployMode, icon: '\u{1F4CA}', title: 'List directly on DEX', desc: 'Provide your own liquidity' },
		{ key: 'none' as DeployMode, icon: '\u{1F4E6}', title: 'Deploy token only', desc: 'Manual setup later' }
	];
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

	<h3 class="heading">Deployment Mode</h3>
	<div class="cards">
		{#each modes as m}
			<button class="card radio" class:on={mode === m.key} onclick={() => setMode(m.key)}>
				<span class="icon">{m.icon}</span>
				<div class="info">
					<span class="title">{m.title}</span>
					<span class="desc">{m.desc}</span>
				</div>
				<span class="radio-dot" class:on={mode === m.key}></span>
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
	.radio-dot {
		width: 18px; height: 18px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.15);
		flex-shrink: 0; position: relative; transition: border-color 0.2s;
	}
	.radio-dot.on { border-color: #00d2ff; }
	.radio-dot.on::after {
		content: ''; position: absolute; top: 3px; left: 3px; width: 8px; height: 8px;
		border-radius: 50%; background: #00d2ff;
	}
</style>
