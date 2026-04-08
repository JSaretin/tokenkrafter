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
		tokenLogoUrl = $bindable(''),
		tokenDescription = $bindable(''),
		tokenWebsite = $bindable(''),
		tokenTwitter = $bindable(''),
		tokenTelegram = $bindable(''),
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
		tokenLogoUrl: string;
		tokenDescription: string;
		tokenWebsite: string;
		tokenTwitter: string;
		tokenTelegram: string;
		supportedNetworks: any[];
		getNetworkProviders: () => Map<number, any>;
	} = $props();

	let showMetadata = $state(false);
	let logoUploading = $state(false);
	let logoFileInput: HTMLInputElement | undefined = $state();

	async function handleLogoUpload(e: Event) {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (!file) return;
		if (file.size > 2 * 1024 * 1024) { alert('Max 2 MB'); return; }
		if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'].includes(file.type)) { alert('PNG, JPEG, WebP, GIF, or SVG only'); return; }

		// Preview immediately using data URL
		const reader = new FileReader();
		reader.onload = () => { tokenLogoUrl = reader.result as string; };
		reader.readAsDataURL(file);

		// Store the file for later upload (after token is deployed and we have the address)
		(window as any).__pendingLogoFile = file;
	}

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
		<!-- Logo upload (prominent at top) -->
		<div class="field-group">
			<input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" class="hidden-file" bind:this={logoFileInput} onchange={handleLogoUpload} />
			<button class="logo-upload-btn" type="button" onclick={() => logoFileInput?.click()}>
				{#if tokenLogoUrl}
					<img src={tokenLogoUrl} alt="Logo" class="logo-upload-preview" />
					<div class="logo-upload-text">
						<span class="logo-upload-change">Change logo</span>
						<span class="logo-upload-sub">PNG, JPEG, WebP, GIF, SVG (max 2 MB)</span>
					</div>
				{:else}
					<div class="logo-upload-placeholder">
						<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
					</div>
					<div class="logo-upload-text">
						<span>Upload token logo</span>
						<span class="logo-upload-sub">Optional — you can add it later</span>
					</div>
				{/if}
			</button>
		</div>

		<!-- Name + Symbol row -->
		<div class="name-symbol-row">
			<div class="field-group" style="flex: 2;">
				<label class="label" for="bi-name">Token Name</label>
				<input id="bi-name" class="input-field" type="text" placeholder="e.g. My Token" bind:value={name} />
			</div>
			<div class="field-group" style="flex: 1;">
				<label class="label" for="bi-symbol">Symbol</label>
				<input id="bi-symbol" class="input-field" type="text" placeholder="e.g. MTK" value={symbol} oninput={handleSymbolInput} maxlength="11" />
			</div>
		</div>

		<!-- Total Supply -->
		<div class="field-group">
			<label class="label" for="bi-supply">Total Supply</label>
			<div class="supply-row">
				<input id="bi-supply" class="input-field supply-input" type="number" placeholder="e.g. 1000000000" bind:value={totalSupply} min="1" />
				<div class="preset-row">
					{#each supplyPresets as p}
						<button class="preset-btn" tabindex="-1" onclick={() => (totalSupply = p.value)}>{p.label}</button>
					{/each}
				</div>
			</div>
			{#if formattedSupply()}
				<span class="hint">{formattedSupply()}</span>
			{/if}
		</div>

		<!-- Decimals -->
		<div class="field-group decimals-row">
			<label class="label small" for="bi-decimals">Decimals</label>
			<input id="bi-decimals" class="input-field small-input" type="number" bind:value={decimals} min="0" max="18" />
		</div>

		<!-- About (collapsible) -->
		<button class="meta-toggle" onclick={() => showMetadata = !showMetadata}>
			<span class="meta-toggle-label">About this token</span>
			<span class="meta-toggle-hint">Description, website, socials</span>
			<svg class="meta-toggle-chev" class:meta-open={showMetadata} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
		</button>

		{#if showMetadata}
			<div class="meta-fields">
				<div class="field-group">
					<label class="label small" for="bi-desc">Description</label>
					<textarea id="bi-desc" class="input-field" rows="2" placeholder="What is this token about?" bind:value={tokenDescription} style="resize: vertical;"></textarea>
				</div>
				<div class="field-group">
					<label class="label small" for="bi-web">Website</label>
					<input id="bi-web" class="input-field" type="url" placeholder="https://yourtoken.com" bind:value={tokenWebsite} />
				</div>
				<div class="meta-row">
					<div class="field-group">
						<label class="label small" for="bi-tw">Twitter / X</label>
						<input id="bi-tw" class="input-field" type="text" placeholder="@handle" bind:value={tokenTwitter} />
					</div>
					<div class="field-group">
						<label class="label small" for="bi-tg">Telegram</label>
						<input id="bi-tg" class="input-field" type="text" placeholder="@group" bind:value={tokenTelegram} />
					</div>
				</div>
			</div>
		{/if}
	{/if}
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

	/* Metadata */
	.meta-toggle {
		display: flex; align-items: center; gap: 8px; width: 100%;
		padding: 10px 14px; border-radius: 10px;
		background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05);
		cursor: pointer; font-family: inherit; color: inherit; text-align: left;
		transition: border-color 0.15s;
	}
	.meta-toggle:hover { border-color: rgba(0,210,255,0.15); }
	.meta-toggle-label { font-family: 'Syne', sans-serif; font-size: 0.8rem; font-weight: 600; color: rgba(255,255,255,0.8); }
	.meta-toggle-hint { font-size: 0.65rem; color: rgba(255,255,255,0.25); font-family: 'Space Mono', monospace; flex: 1; }
	.meta-toggle-chev { color: rgba(255,255,255,0.2); transition: transform 0.15s; flex-shrink: 0; }
	.meta-toggle-chev.meta-open { transform: rotate(180deg); }
	.meta-fields { display: flex; flex-direction: column; gap: 0.75rem; padding-top: 0.25rem; }
	.meta-row { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
	.name-symbol-row { display: flex; gap: 0.75rem; }
	.supply-row { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
	.supply-input { flex: 1; min-width: 0; }
	@media (max-width: 500px) { .name-symbol-row { flex-direction: column; } }

	.hidden-file { display: none; }
	.logo-upload-btn {
		display: flex; align-items: center; gap: 12px; width: 100%;
		padding: 12px 14px; border-radius: 10px;
		background: rgba(255,255,255,0.02); border: 1px dashed rgba(255,255,255,0.08);
		color: rgba(255,255,255,0.35); cursor: pointer; transition: all 0.15s;
		font-family: 'Space Mono', monospace; font-size: 0.75rem;
	}
	.logo-upload-btn:hover { border-color: rgba(0,210,255,0.2); background: rgba(0,210,255,0.02); }
	.logo-upload-preview { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; border: 2px solid rgba(255,255,255,0.08); flex-shrink: 0; }
	.logo-upload-placeholder {
		width: 40px; height: 40px; border-radius: 50%; flex-shrink: 0;
		background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);
		display: flex; align-items: center; justify-content: center; color: rgba(255,255,255,0.15);
	}
	.logo-upload-text { display: flex; flex-direction: column; gap: 2px; }
	.logo-upload-change { color: #00d2ff; font-size: 0.72rem; }
	.logo-upload-sub { font-size: 0.6rem; color: rgba(255,255,255,0.15); }
	@media (max-width: 500px) { .meta-row { grid-template-columns: 1fr; } }
</style>
