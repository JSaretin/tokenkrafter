<script lang="ts">
	import { ethers } from 'ethers';
	import { TOKEN_READ_ABI } from '$lib/commonABIs';

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
		isCreateOnly = false,
		supportedNetworks,
		getNetworkProviders,
		onPresetLoaded,
	}: {
		isCreateOnly?: boolean;
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
		onPresetLoaded?: (data: { isTaxable: boolean; buyTaxPct: string; sellTaxPct: string; transferTaxPct: string }) => void;
	} = $props();

	let showMetadata = $state(false);
	let logoUploading = $state(false);
	let logoFileInput: HTMLInputElement | undefined = $state();

	// Preset loader
	let showPresetLoader = $state(false);
	let presetAddress = $state('');
	let presetLoading = $state(false);
	let presetError = $state('');

	async function loadPreset() {
		const net = selectedNetwork;
		if (!presetAddress || !ethers.isAddress(presetAddress) || !net) {
			presetError = 'Enter a valid token address';
			return;
		}
		presetLoading = true;
		presetError = '';
		try {
			const provider = getNetworkProviders().get(net.chain_id);
			if (!provider) { presetError = 'No provider for network'; return; }

			// Read basic token info
			const token = new ethers.Contract(presetAddress, TOKEN_READ_ABI, provider);
			const [n, s, d, supply] = await Promise.all([
				token.name().catch(() => ''),
				token.symbol().catch(() => ''),
				token.decimals().catch(() => 18),
				token.totalSupply().catch(() => 0n),
			]);
			if (!n && !s) { presetError = 'Could not read token'; return; }

			// Reset all fields before applying preset
			name = n;
			symbol = s;
			decimals = Number(d);
			totalSupply = ethers.formatUnits(supply, Number(d));
			tokenLogoUrl = '';
			tokenDescription = '';
			tokenWebsite = '';
			tokenTwitter = '';
			tokenTelegram = '';
			delete (window as any).__pendingLogoFile;

			// Reset tax to defaults (non-tax) — will be overridden if tax is detected
			onPresetLoaded?.({ isTaxable: false, buyTaxPct: '', sellTaxPct: '', transferTaxPct: '' });

			const addr = presetAddress.toLowerCase();

			// Load metadata from DB
			fetch(`/api/token-metadata?address=${addr}&chain_id=${net.chain_id}`)
				.then(r => r.ok ? r.json() : null)
				.then(data => {
					if (data) {
						if (data.logo_url) tokenLogoUrl = data.logo_url;
						if (data.description) tokenDescription = data.description;
						if (data.website) tokenWebsite = data.website;
						if (data.twitter) tokenTwitter = data.twitter;
						if (data.telegram) tokenTelegram = data.telegram;
					}
				}).catch(() => {});

			// Logo fallback from GeckoTerminal
			fetch(`https://api.geckoterminal.com/api/v2/networks/bsc/tokens/${addr}`)
				.then(r => r.ok ? r.json() : null)
				.then(data => {
					const img = data?.data?.attributes?.image_url;
					if (img && img !== 'missing.png' && !tokenLogoUrl) tokenLogoUrl = img;
				}).catch(() => {});

			// Simulate tax via TradeLens
			if (net.dex_router) {
				try {
					const { queryTradeLens } = await import('$lib/tradeLens');
					const result = await queryTradeLens(provider, net.dex_router, [addr], addr, ethers.parseEther('0.001'), ethers.ZeroAddress, net.chain_id);
					if (result.taxInfo.success) {
						const buy = result.taxInfo.buyTaxBps / 100;
						const sell = result.taxInfo.sellTaxBps / 100;
						const transfer = result.taxInfo.transferTaxBps / 100;
						if (buy > 0 || sell > 0 || transfer > 0) {
							onPresetLoaded?.({
								isTaxable: true,
								buyTaxPct: buy > 0 ? String(buy) : '',
								sellTaxPct: sell > 0 ? String(sell) : '',
								transferTaxPct: transfer > 0 ? String(transfer) : '',
							});
						}
					}
				} catch {}
			}

			showPresetLoader = false;
			presetAddress = '';
		} catch {
			presetError = 'Could not read token';
		} finally {
			presetLoading = false;
		}
	}

	const MAX_LOGO_SIZE = 256;
	const SKIP_RESIZE_TYPES = ['image/gif', 'image/svg+xml'];

	/** Resize a raster image to max 256x256 using canvas */
	function resizeImage(file: File): Promise<File> {
		return new Promise((resolve) => {
			// GIF and SVG — skip resize
			if (SKIP_RESIZE_TYPES.includes(file.type)) { resolve(file); return; }

			const img = new Image();
			img.onload = () => {
				// Skip if already small enough
				if (img.width <= MAX_LOGO_SIZE && img.height <= MAX_LOGO_SIZE) {
					URL.revokeObjectURL(img.src);
					resolve(file);
					return;
				}

				const canvas = document.createElement('canvas');
				const scale = Math.min(MAX_LOGO_SIZE / img.width, MAX_LOGO_SIZE / img.height);
				canvas.width = Math.round(img.width * scale);
				canvas.height = Math.round(img.height * scale);

				const ctx = canvas.getContext('2d')!;
				ctx.imageSmoothingQuality = 'high';
				ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
				URL.revokeObjectURL(img.src);

				canvas.toBlob((blob) => {
					if (blob) {
						const resized = new File([blob], file.name, { type: file.type });
						resolve(resized);
					} else {
						resolve(file); // fallback to original
					}
				}, file.type, 0.9);
			};
			img.onerror = () => resolve(file);
			img.src = URL.createObjectURL(file);
		});
	}

	async function handleLogoUpload(e: Event) {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (!file) return;
		if (file.size > 2 * 1024 * 1024) { alert('Max 2 MB'); return; }
		if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'].includes(file.type)) { alert('PNG, JPEG, WebP, GIF, or SVG only'); return; }

		// Resize (skip for GIF/SVG)
		const processed = await resizeImage(file);

		// Preview
		const reader = new FileReader();
		reader.onload = () => { tokenLogoUrl = reader.result as string; };
		reader.readAsDataURL(processed);

		// Store for upload after deploy
		(window as any).__pendingLogoFile = processed;
	}

	let loading = $state(false);
	let fetchError = $state('');
	let fetchTimeout: ReturnType<typeof setTimeout> | null = null;

	let selectedNetwork = $derived(supportedNetworks.find((n) => n.chain_id == chainId));
	let availableNetworks = $derived(supportedNetworks.filter(n => n.platform_address?.length > 2));

	// Auto-select first available network if none selected
	$effect(() => {
		if (!chainId && availableNetworks.length > 0) {
			chainId = availableNetworks[0].chain_id;
		}
	});

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
				const token = new ethers.Contract(addr, TOKEN_READ_ABI, provider);
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

				// Clone metadata if in create-only mode
				if (isCreateOnly) {
					// Try our DB first
					fetch(`/api/token-metadata?address=${addr.toLowerCase()}&chain_id=${net.chain_id}`)
						.then(r => r.ok ? r.json() : null)
						.then(data => {
							if (data) {
								if (data.logo_url) tokenLogoUrl = data.logo_url;
								if (data.description) tokenDescription = data.description;
								if (data.website) tokenWebsite = data.website;
								if (data.twitter) tokenTwitter = data.twitter;
								if (data.telegram) tokenTelegram = data.telegram;
							}
						}).catch(() => {});

					// Try GeckoTerminal for logo fallback
					if (!tokenLogoUrl) {
						fetch(`https://api.geckoterminal.com/api/v2/networks/bsc/tokens/${addr}`)
							.then(r => r.ok ? r.json() : null)
							.then(data => {
								const img = data?.data?.attributes?.image_url;
								if (img && img !== 'missing.png' && !tokenLogoUrl) tokenLogoUrl = img;
							}).catch(() => {});
					}
				}
			} catch {
				fetchError = 'Could not read token';
			} finally {
				loading = false;
			}
		}, 600);
	});
</script>

<div class="basic-info">
	<!-- Network (hidden if only one) -->
	{#if availableNetworks.length > 1}
		<div class="field-group">
			<label class="label" for="bi-network">Network</label>
			<select id="bi-network" class="input-field" bind:value={chainId}>
				<option value={undefined} disabled>Select network</option>
				{#each availableNetworks as n (n.chain_id)}
					<option value={n.chain_id}>{n.name} ({n.native_coin})</option>
				{/each}
			</select>
		</div>
	{:else if availableNetworks.length === 1}
		<div class="network-badge">
			<span class="network-badge-dot"></span>
			<span class="network-badge-name">{availableNetworks[0].name}</span>
		</div>
	{/if}

	{#if !useExistingToken}
		<!-- Existing token toggle for launch mode -->
	{:else}
		<div class="field-group">
			<label class="label" for="bi-addr">Token Address</label>
			<input id="bi-addr" class="input-field" type="text" placeholder="0x..." bind:value={existingTokenAddress} />
			{#if loading}
				<span class="hint accent">Fetching token info...</span>
			{:else if fetchError}
				<span class="hint error">{fetchError}</span>
			{:else if name && existingTokenAddress}
				<span class="hint accent">{name} ({symbol}) &mdash; {Number(totalSupply).toLocaleString('en-US')} supply</span>
			{/if}
		</div>
	{/if}

	{#if !useExistingToken}
		<!-- Load preset from contract -->
		<button class="preset-trigger" type="button" onclick={() => showPresetLoader = true}>
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/></svg>
			Load from existing token
		</button>

		{#if showPresetLoader}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<div class="preset-overlay" onclick={(e) => { if (e.target === e.currentTarget) { showPresetLoader = false; presetError = ''; } }}>
				<div class="preset-modal">
					<button class="preset-close" type="button" onclick={() => { showPresetLoader = false; presetError = ''; }}>
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
					</button>
					<div class="preset-icon">
						<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/></svg>
					</div>
					<h3 class="syne preset-title">Load from Contract</h3>
					<p class="preset-desc">Paste a token address to auto-fill name, symbol, supply, and tax settings.</p>
					<div class="preset-input-wrap">
						<input class="preset-input" type="text" placeholder="0x..." bind:value={presetAddress} onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); loadPreset(); } }} />
					</div>
					{#if presetError}<span class="preset-error">{presetError}</span>{/if}
					<button class="btn-primary preset-btn" type="button" disabled={presetLoading} onclick={loadPreset}>
						{#if presetLoading}
							<span class="spinner-sm"></span> Loading...
						{:else}
							Load Settings
						{/if}
					</button>
				</div>
			</div>
		{/if}

		<!-- Logo upload -->
		<div class="field-group">
			<input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" class="hidden-file" bind:this={logoFileInput} onchange={handleLogoUpload} />
			{#if tokenLogoUrl}
				<!-- Logo uploaded — show size previews -->
				<div class="logo-preview-row">
					<div class="logo-sizes">
						<div class="logo-size">
							<img src={tokenLogoUrl} alt="Logo" class="logo-sz logo-sz-lg" />
							<span class="logo-sz-label">Profile</span>
						</div>
						<div class="logo-size">
							<img src={tokenLogoUrl} alt="Logo" class="logo-sz logo-sz-md" />
							<span class="logo-sz-label">Card</span>
						</div>
						<div class="logo-size">
							<img src={tokenLogoUrl} alt="Logo" class="logo-sz logo-sz-sm" />
							<span class="logo-sz-label">List</span>
						</div>
					</div>
					<button class="logo-change-btn" type="button" onclick={() => logoFileInput?.click()}>
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
						Change
					</button>
					<button class="logo-remove-btn" type="button" onclick={() => { tokenLogoUrl = ''; delete (window as any).__pendingLogoFile; }}>
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
					</button>
				</div>
			{:else}
				<button class="logo-upload-btn" type="button" onclick={() => logoFileInput?.click()}>
					<div class="logo-upload-placeholder">
						<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
					</div>
					<div class="logo-upload-text">
						<span>Upload token logo</span>
						<span class="logo-upload-sub">Optional — you can add it later</span>
					</div>
				</button>
			{/if}
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
			<input id="bi-supply" class="input-field" type="number" placeholder="e.g. 1000000000" bind:value={totalSupply} min="1" />
			<div class="supply-quick">
				{#each supplyPresets as p}
					<button class="supply-pill" class:active={totalSupply === p.value} tabindex="-1" onclick={() => (totalSupply = p.value)}>{p.label}</button>
				{/each}
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

	/* Preset loader */
	.preset-trigger {
		display: inline-flex; align-items: center; gap: 6px;
		font-family: 'Space Mono', monospace; font-size: 0.75rem; color: rgba(0,210,255,0.7);
		background: none; border: 1px dashed rgba(0,210,255,0.2); border-radius: 8px;
		padding: 8px 14px; cursor: pointer; transition: all 0.2s;
	}
	.preset-trigger:hover { border-color: rgba(0,210,255,0.4); color: #00d2ff; background: rgba(0,210,255,0.03); }

	.preset-overlay {
		position: fixed; inset: 0; z-index: 90;
		background: rgba(0,0,0,0.65); backdrop-filter: blur(8px);
		display: flex; align-items: center; justify-content: center;
		padding: 16px; animation: fadeIn 0.15s ease-out;
	}
	@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

	.preset-modal {
		background: var(--bg); border: 1px solid rgba(0,210,255,0.12);
		border-radius: 16px; padding: 28px 24px; width: 100%; max-width: 380px;
		box-shadow: 0 0 60px rgba(0,210,255,0.06), 0 24px 48px rgba(0,0,0,0.5);
		text-align: center; position: relative;
		animation: slideUp 0.2s ease-out;
	}
	@keyframes slideUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }

	.preset-close {
		position: absolute; top: 14px; right: 14px;
		background: none; border: none; color: var(--text-dim); cursor: pointer;
		padding: 4px; border-radius: 6px; transition: all 0.15s;
	}
	.preset-close:hover { color: white; background: var(--bg-surface-hover); }

	.preset-icon {
		width: 48px; height: 48px; border-radius: 12px;
		background: rgba(0,210,255,0.08); border: 1px solid rgba(0,210,255,0.15);
		display: flex; align-items: center; justify-content: center;
		margin: 0 auto 14px; color: #00d2ff;
	}

	.preset-title { font-size: 1.05rem; font-weight: 700; color: white; margin: 0 0 6px; }
	.preset-desc {
		font-family: 'Space Mono', monospace; font-size: 0.7rem;
		color: var(--text-dim); margin: 0 0 18px; line-height: 1.6;
	}

	.preset-input-wrap { margin-bottom: 6px; }
	.preset-input {
		width: 100%; box-sizing: border-box;
		font-family: 'Space Mono', monospace; font-size: 0.82rem; color: white;
		background: var(--bg-surface-input); border: 1px solid var(--border);
		border-radius: 10px; padding: 12px 14px; outline: none; transition: border-color 0.2s;
	}
	.preset-input::placeholder { color: var(--placeholder); }
	.preset-input:focus { border-color: rgba(0,210,255,0.4); }

	.preset-error {
		display: block; font-family: 'Space Mono', monospace;
		font-size: 0.72rem; color: #ff5e5e; margin-bottom: 4px;
	}

	.preset-btn {
		display: flex; align-items: center; justify-content: center; gap: 8px;
		width: 100%; padding: 11px; margin-top: 8px; border-radius: 10px; border: none;
		background: linear-gradient(135deg, #0891b2, #1d4ed8); color: white;
		font-family: 'Syne', sans-serif; font-size: 13px; font-weight: 700;
		cursor: pointer; transition: all 0.15s;
	}
	.preset-btn:hover { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(8,145,178,0.3); }
	.preset-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; box-shadow: none; }

	.spinner-sm {
		width: 14px; height: 14px;
		border: 2px solid var(--border-input); border-top-color: #00d2ff;
		border-radius: 50%; animation: spin 0.6s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }
	.field-group { display: flex; flex-direction: column; gap: 0.3rem; }
	.label { font-family: 'Space Mono', monospace; font-size: 0.82rem; color: var(--text); letter-spacing: 0.02em; }
	.label.small { font-size: 0.72rem; color: var(--text-muted); }
	.hint { font-family: 'Space Mono', monospace; font-size: 0.72rem; color: var(--text-muted); }
	.hint.accent { color: #00d2ff; }
	.hint.error { color: #ff5e5e; }
	.clone-hint { color: #10b981; }
	.network-badge {
		display: inline-flex; align-items: center; gap: 6px;
		padding: 6px 12px; border-radius: 8px;
		background: rgba(0,210,255,0.04); border: 1px solid rgba(0,210,255,0.1);
		font-family: 'Space Mono', monospace; font-size: 11px; color: #00d2ff;
	}
	.network-badge-dot { width: 6px; height: 6px; border-radius: 50%; background: #10b981; }
	.network-badge-name { font-weight: 600; }

	.preset-row { display: flex; gap: 0.4rem; margin-top: 0.25rem; flex-wrap: wrap; }
	/* duplicate preset-btn removed — defined above */

	.decimals-row { flex-direction: row; align-items: center; gap: 0.5rem; }
	.small-input { width: 4rem; text-align: center; }

	/* Toggle */
	.toggle-row {
		display: flex; align-items: center; gap: 0.6rem;
		background: none; border: none; cursor: pointer; padding: 0.2rem 0;
	}
	.toggle-label { font-family: 'Space Mono', monospace; font-size: 0.78rem; color: var(--text-muted); }
	.toggle-track {
		width: 2.2rem; height: 1.2rem; border-radius: 0.6rem;
		background: var(--toggle-track); position: relative; transition: background 0.2s;
		flex-shrink: 0; border: 1px solid var(--border);
	}
	.toggle-track.active { background: #00d2ff; border-color: rgba(0,210,255,0.5); }
	.toggle-thumb {
		position: absolute; top: 1px; left: 1px;
		width: 0.85rem; height: 0.85rem; border-radius: 50%;
		background: var(--toggle-thumb-off); transition: transform 0.2s;
		box-shadow: 0 1px 3px rgba(0,0,0,0.2);
	}
	.toggle-track.active .toggle-thumb { transform: translateX(1rem); background: var(--toggle-thumb); }

	/* Metadata */
	.meta-toggle {
		display: flex; align-items: center; gap: 8px; width: 100%;
		padding: 10px 14px; border-radius: 10px;
		background: var(--bg-surface); border: 1px solid var(--border-subtle);
		cursor: pointer; font-family: inherit; color: inherit; text-align: left;
		transition: border-color 0.15s;
	}
	.meta-toggle:hover { border-color: rgba(0,210,255,0.15); }
	.meta-toggle-label { font-family: 'Syne', sans-serif; font-size: 0.8rem; font-weight: 600; color: var(--text); }
	.meta-toggle-hint { font-size: 0.65rem; color: var(--text-dim); font-family: 'Space Mono', monospace; flex: 1; }
	.meta-toggle-chev { color: var(--placeholder); transition: transform 0.15s; flex-shrink: 0; }
	.meta-toggle-chev.meta-open { transform: rotate(180deg); }
	.meta-fields { display: flex; flex-direction: column; gap: 0.75rem; padding-top: 0.25rem; }
	.meta-row { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
	.name-symbol-row { display: flex; gap: 0.75rem; }
	@media (max-width: 500px) { .name-symbol-row { flex-direction: column; } }
	.supply-quick { display: flex; gap: 4px; margin-top: 4px; }
	.supply-pill {
		font-family: 'Space Mono', monospace; font-size: 0.68rem;
		padding: 3px 10px; border-radius: 99px;
		border: 1px solid var(--border); background: var(--bg-surface);
		color: var(--text-dim); cursor: pointer; transition: all 0.12s;
	}
	.supply-pill:hover { border-color: rgba(0,210,255,0.2); color: var(--text-muted); }
	.supply-pill.active { border-color: rgba(0,210,255,0.3); color: #00d2ff; background: rgba(0,210,255,0.06); }

	.hidden-file { display: none; }
	.logo-upload-btn {
		display: flex; align-items: center; gap: 12px; width: 100%;
		padding: 12px 14px; border-radius: 10px;
		background: var(--bg-surface); border: 1px dashed rgba(255,255,255,0.08);
		color: var(--text-dim); cursor: pointer; transition: all 0.15s;
		font-family: 'Space Mono', monospace; font-size: 0.75rem;
	}
	.logo-upload-btn:hover { border-color: rgba(0,210,255,0.2); background: rgba(0,210,255,0.02); }
	.logo-preview-row {
		display: flex; align-items: center; gap: 10px;
		padding: 12px 14px; border-radius: 10px;
		background: var(--bg-surface); border: 1px solid var(--border);
	}
	.logo-sizes { display: flex; align-items: flex-end; gap: 12px; flex: 1; }
	.logo-size { display: flex; flex-direction: column; align-items: center; gap: 3px; }
	.logo-sz { border-radius: 50%; object-fit: cover; border: 1px solid var(--border); }
	.logo-sz-lg { width: 48px; height: 48px; }
	.logo-sz-md { width: 32px; height: 32px; }
	.logo-sz-sm { width: 20px; height: 20px; }
	.logo-sz-label { font-size: 8px; color: var(--placeholder); font-family: 'Space Mono', monospace; }
	.logo-change-btn {
		display: flex; align-items: center; gap: 4px; padding: 5px 10px; border-radius: 6px;
		border: 1px solid var(--border); background: transparent;
		color: #00d2ff; font-family: 'Space Mono', monospace; font-size: 10px;
		cursor: pointer; transition: all 0.12s; flex-shrink: 0;
	}
	.logo-change-btn:hover { background: rgba(0,210,255,0.06); }
	.logo-remove-btn {
		width: 26px; height: 26px; border-radius: 6px; border: none;
		background: rgba(248,113,113,0.08); color: #f87171; cursor: pointer;
		display: flex; align-items: center; justify-content: center;
		flex-shrink: 0; transition: background 0.12s;
	}
	.logo-remove-btn:hover { background: rgba(248,113,113,0.15); }
	.logo-upload-placeholder {
		width: 40px; height: 40px; border-radius: 50%; flex-shrink: 0;
		background: var(--bg-surface); border: 1px solid var(--border);
		display: flex; align-items: center; justify-content: center; color: var(--text-dim);
	}
	.logo-upload-text { display: flex; flex-direction: column; gap: 2px; }
	.logo-upload-change { color: #00d2ff; font-size: 0.72rem; }
	.logo-upload-sub { font-size: 0.6rem; color: var(--text-dim); }
	@media (max-width: 500px) { .meta-row { grid-template-columns: 1fr; } }
</style>
