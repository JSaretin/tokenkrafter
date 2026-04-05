<script lang="ts">
	import { ethers } from 'ethers';

	let {
		name = $bindable(''),
		symbol = $bindable(''),
		totalSupply = $bindable(''),
		decimals = $bindable(18),
		chainId = $bindable(undefined as number | undefined),
		useExistingToken = $bindable(false),
		existingTokenAddress = $bindable(''),
		supportedNetworks,
		getNetworkProviders,
	}: {
		name: string;
		symbol: string;
		totalSupply: string;
		decimals: number;
		chainId: number | undefined;
		useExistingToken: boolean;
		existingTokenAddress: string;
		supportedNetworks: any[];
		getNetworkProviders: () => Map<number, any>;
	} = $props();

	let loading = $state(false);
	let fetchError = $state('');
	let fetchTimeout: ReturnType<typeof setTimeout> | null = null;

	let selectedNetwork = $derived(supportedNetworks.find((n) => n.chain_id == chainId));

	let formattedSupply = $derived(() => {
		const n = Number(totalSupply);
		if (!n || isNaN(n)) return '';
		return n.toLocaleString('en-US') + ' tokens';
	});

	const supplyPresets = [
		{ label: '1M', value: '1000000' },
		{ label: '10M', value: '10000000' },
		{ label: '100M', value: '100000000' },
		{ label: '1B', value: '1000000000' },
		{ label: '10B', value: '10000000000' },
	];

	function handleSymbolInput(e: Event) {
		const input = e.target as HTMLInputElement;
		symbol = input.value.toUpperCase();
	}

	// Auto-fetch existing token metadata
	$effect(() => {
		if (fetchTimeout) clearTimeout(fetchTimeout);
		const addr = existingTokenAddress;
		const net = selectedNetwork;
		if (!useExistingToken || !addr || !ethers.isAddress(addr) || !net) return;
		fetchTimeout = setTimeout(async () => {
			loading = true;
			fetchError = '';
			try {
				const provider = getNetworkProviders().get(net.chain_id);
				if (!provider) { fetchError = 'No provider for network'; return; }
				const token = new ethers.Contract(addr, [
					'function name() view returns (string)',
					'function symbol() view returns (string)',
					'function decimals() view returns (uint8)',
					'function totalSupply() view returns (uint256)',
				], provider);
				const [n, s, d, supply] = await Promise.all([
					token.name().catch(() => ''),
					token.symbol().catch(() => ''),
					token.decimals().catch(() => 18),
					token.totalSupply().catch(() => 0n),
				]);
				name = n;
				symbol = s;
				decimals = Number(d);
				totalSupply = ethers.formatUnits(supply, Number(d));
			} catch {
				fetchError = 'Could not read token';
			} finally {
				loading = false;
			}
		}, 600);
	});
</script>

<div class="basic-info">
	<!-- Network -->
	<div class="field-group">
		<label class="label" for="bi-network">Network</label>
		<select id="bi-network" class="input-field" bind:value={chainId}>
			<option value={undefined} disabled>Select network</option>
			{#each supportedNetworks.filter((n) => n.platform_address.length > 2) as n (n.chain_id)}
				<option value={n.chain_id}>{n.name} ({n.native_coin})</option>
			{/each}
		</select>
	</div>

	<!-- Existing token toggle -->
	<button class="toggle-row" tabindex="-1" onclick={() => (useExistingToken = !useExistingToken)}>
		<span class="toggle-track" class:active={useExistingToken}>
			<span class="toggle-thumb"></span>
		</span>
		<span class="toggle-label">I already have a token</span>
	</button>

	{#if useExistingToken}
		<!-- Existing token address -->
		<div class="field-group">
			<label class="label" for="bi-addr">Token Address</label>
			<input id="bi-addr" class="input-field" type="text" placeholder="0x..." bind:value={existingTokenAddress} />
			{#if loading}
				<span class="hint accent">Fetching token info...</span>
			{:else if fetchError}
				<span class="hint error">{fetchError}</span>
			{:else if name && useExistingToken && existingTokenAddress}
				<span class="hint accent">{name} ({symbol}) &mdash; {Number(totalSupply).toLocaleString('en-US')} supply</span>
			{/if}
		</div>
	{:else}
		<!-- Token Name -->
		<div class="field-group">
			<label class="label" for="bi-name">Token Name</label>
			<input id="bi-name" class="input-field" type="text" placeholder="e.g. My Token" bind:value={name} />
		</div>

		<!-- Symbol -->
		<div class="field-group">
			<label class="label" for="bi-symbol">Symbol</label>
			<input id="bi-symbol" class="input-field" type="text" placeholder="e.g. MTK" value={symbol} oninput={handleSymbolInput} maxlength="11" />
		</div>

		<!-- Total Supply -->
		<div class="field-group">
			<label class="label" for="bi-supply">Total Supply</label>
			<input id="bi-supply" class="input-field" type="number" placeholder="e.g. 1000000000" bind:value={totalSupply} min="1" />
			<div class="preset-row">
				{#each supplyPresets as p}
					<button class="preset-btn" tabindex="-1" onclick={() => (totalSupply = p.value)}>{p.label}</button>
				{/each}
			</div>
			{#if formattedSupply()}
				<span class="hint">{formattedSupply()}</span>
			{/if}
		</div>
	{/if}

	<!-- Decimals (always visible, subtle) -->
	<div class="field-group decimals-row">
		<label class="label small" for="bi-decimals">Decimals</label>
		<input id="bi-decimals" class="input-field small-input" type="number" bind:value={decimals} min="0" max="18" />
	</div>
</div>

<style>
	.basic-info { display: flex; flex-direction: column; gap: 1.1rem; }
	.field-group { display: flex; flex-direction: column; gap: 0.3rem; }
	.label { font-family: 'Space Mono', monospace; font-size: 0.82rem; color: #e2e8f0; letter-spacing: 0.02em; }
	.label.small { font-size: 0.72rem; color: rgba(226,232,240,0.5); }
	.hint { font-family: 'Space Mono', monospace; font-size: 0.72rem; color: rgba(226,232,240,0.45); }
	.hint.accent { color: #00d2ff; }
	.hint.error { color: #ff5e5e; }

	.preset-row { display: flex; gap: 0.4rem; margin-top: 0.25rem; flex-wrap: wrap; }
	.preset-btn {
		font-family: 'Space Mono', monospace; font-size: 0.72rem;
		padding: 0.25rem 0.65rem; border-radius: 4px;
		border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.03);
		color: #e2e8f0; cursor: pointer; transition: border-color 0.15s, background 0.15s;
	}
	.preset-btn:hover { border-color: #00d2ff; background: rgba(0,210,255,0.06); }

	.decimals-row { flex-direction: row; align-items: center; gap: 0.5rem; }
	.small-input { width: 4rem; text-align: center; }

	/* Toggle */
	.toggle-row {
		display: flex; align-items: center; gap: 0.6rem;
		background: none; border: none; cursor: pointer; padding: 0.2rem 0;
	}
	.toggle-label { font-family: 'Space Mono', monospace; font-size: 0.78rem; color: rgba(226,232,240,0.6); }
	.toggle-track {
		width: 2.2rem; height: 1.2rem; border-radius: 0.6rem;
		background: rgba(255,255,255,0.08); position: relative; transition: background 0.2s;
		flex-shrink: 0;
	}
	.toggle-track.active { background: #00d2ff; }
	.toggle-thumb {
		position: absolute; top: 2px; left: 2px;
		width: 0.85rem; height: 0.85rem; border-radius: 50%;
		background: #e2e8f0; transition: transform 0.2s;
	}
	.toggle-track.active .toggle-thumb { transform: translateX(1rem); }
</style>
