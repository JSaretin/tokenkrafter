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

<div class="flex flex-col gap-[1.1rem]">
	<!-- Network (hidden if only one) -->
	{#if availableNetworks.length > 1}
		<div class="flex flex-col gap-[0.3rem]">
			<label class="font-mono text-[0.82rem] text-foreground tracking-[0.02em]" for="bi-network">Network</label>
			<select id="bi-network" class="input-field" bind:value={chainId} required>
				<option value={undefined} disabled>Select network</option>
				{#each availableNetworks as n (n.chain_id)}
					<option value={n.chain_id}>{n.name} ({n.native_coin})</option>
				{/each}
			</select>
		</div>
	{:else if availableNetworks.length === 1}
		<div class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-cyan/4 border border-brand-cyan/10 font-mono text-xs2 text-brand-cyan">
			<span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
			<span class="font-semibold">{availableNetworks[0].name}</span>
		</div>
	{/if}

	{#if !useExistingToken}
		<!-- Existing token toggle for launch mode -->
	{:else}
		<div class="flex flex-col gap-[0.3rem]">
			<label class="font-mono text-[0.82rem] text-foreground tracking-[0.02em]" for="bi-addr">Token Address</label>
			<input id="bi-addr" class="input-field" type="text" placeholder="0x..." bind:value={existingTokenAddress} required pattern="^0x[a-fA-F0-9]{'{40}'}$" />
			{#if loading}
				<span class="font-mono text-[0.72rem] text-brand-cyan">Fetching token info...</span>
			{:else if fetchError}
				<span class="font-mono text-[0.72rem] text-[#ff5e5e]">{fetchError}</span>
			{:else if name && existingTokenAddress}
				<span class="font-mono text-[0.72rem] text-brand-cyan">{name} ({symbol}) &mdash; {Number(totalSupply).toLocaleString('en-US')} supply</span>
			{/if}
		</div>
	{/if}

	{#if !useExistingToken}
		<!-- Load preset from contract -->
		<button class="inline-flex items-center gap-1.5 font-mono text-[0.75rem] text-brand-cyan/70 bg-transparent border border-dashed border-brand-cyan/20 rounded-lg px-3.5 py-2 cursor-pointer transition-all duration-200 hover:border-brand-cyan/40 hover:text-brand-cyan hover:bg-brand-cyan/3" type="button" onclick={() => showPresetLoader = true}>
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/></svg>
			Load from existing token
		</button>

		{#if showPresetLoader}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<div class="preset-overlay fixed inset-0 z-[90] bg-black/65 backdrop-blur-[8px] flex items-center justify-center p-4" onclick={(e) => { if (e.target === e.currentTarget) { showPresetLoader = false; presetError = ''; } }}>
				<div class="preset-modal bg-background border border-brand-cyan/[0.12] rounded-2xl px-6 py-7 w-full max-w-[380px] shadow-[0_0_60px_rgba(0,210,255,0.06),0_24px_48px_rgba(0,0,0,0.5)] text-center relative">
					<button class="absolute top-3.5 right-3.5 bg-transparent border-0 text-dim cursor-pointer p-1 rounded-md transition-all duration-[150ms] hover:text-white hover:bg-surface-hover" type="button" onclick={() => { showPresetLoader = false; presetError = ''; }} aria-label="Close">
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
					</button>
					<div class="w-12 h-12 rounded-xl bg-brand-cyan/8 border border-brand-cyan/15 flex items-center justify-center mx-auto mb-3.5 text-brand-cyan">
						<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/></svg>
					</div>
					<h3 class="font-display text-[1.05rem] font-bold text-white m-0 mb-1.5">Load from Contract</h3>
					<p class="font-mono text-[0.7rem] text-dim m-0 mb-4 leading-[1.6]">Paste a token address to auto-fill name, symbol, supply, and tax settings.</p>
					<div class="mb-1.5">
						<input class="w-full box-border font-mono text-[0.82rem] text-white bg-surface-input border border-line rounded-[10px] px-3.5 py-3 outline-none transition-[border-color] duration-200 focus:border-brand-cyan/40 placeholder:text-placeholder" type="text" placeholder="0x..." bind:value={presetAddress} onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); loadPreset(); } }} />
					</div>
					{#if presetError}<span class="block font-mono text-[0.72rem] text-[#ff5e5e] mb-1">{presetError}</span>{/if}
					<button class="flex items-center justify-center gap-2 w-full py-[11px] mt-2 rounded-[10px] border-0 bg-[linear-gradient(135deg,#0891b2,#1d4ed8)] text-white font-display text-13 font-bold cursor-pointer transition-all duration-[150ms] hover:-translate-y-px hover:shadow-[0_4px_16px_rgba(8,145,178,0.3)] disabled:opacity-50 disabled:cursor-not-allowed disabled:translate-y-0 disabled:shadow-none" type="button" disabled={presetLoading} onclick={loadPreset}>
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
		<div class="flex flex-col gap-[0.3rem]">
			<input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" class="hidden" bind:this={logoFileInput} onchange={handleLogoUpload} />
			{#if tokenLogoUrl}
				<!-- Logo uploaded — show size previews -->
				<div class="flex items-center gap-2.5 px-3.5 py-3 rounded-[10px] bg-surface border border-line">
					<div class="flex items-end gap-3 flex-1">
						<div class="flex flex-col items-center gap-[3px]">
							<img src={tokenLogoUrl} alt="Logo" class="rounded-full object-cover border border-line w-12 h-12" />
							<span class="text-4xs text-placeholder font-mono">Profile</span>
						</div>
						<div class="flex flex-col items-center gap-[3px]">
							<img src={tokenLogoUrl} alt="Logo" class="rounded-full object-cover border border-line w-8 h-8" />
							<span class="text-4xs text-placeholder font-mono">Card</span>
						</div>
						<div class="flex flex-col items-center gap-[3px]">
							<img src={tokenLogoUrl} alt="Logo" class="rounded-full object-cover border border-line w-5 h-5" />
							<span class="text-4xs text-placeholder font-mono">List</span>
						</div>
					</div>
					<button class="flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-line bg-transparent text-brand-cyan font-mono text-3xs cursor-pointer transition-all duration-[120ms] flex-shrink-0 hover:bg-brand-cyan/6" type="button" onclick={() => logoFileInput?.click()}>
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
						Change
					</button>
					<button class="w-[26px] h-[26px] rounded-md border-0 bg-red-400/8 text-red-400 cursor-pointer flex items-center justify-center flex-shrink-0 transition-[background] duration-[120ms] hover:bg-red-400/15" type="button" onclick={() => { tokenLogoUrl = ''; delete (window as any).__pendingLogoFile; }} aria-label="Remove logo">
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
					</button>
				</div>
			{:else}
				<button class="flex items-center gap-3 w-full px-3.5 py-3 rounded-[10px] bg-surface border border-dashed border-white/8 text-dim cursor-pointer transition-all duration-[150ms] font-mono text-[0.75rem] hover:border-brand-cyan/20 hover:bg-brand-cyan/2" type="button" onclick={() => logoFileInput?.click()}>
					<div class="w-10 h-10 rounded-full flex-shrink-0 bg-surface border border-line flex items-center justify-center text-dim">
						<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
					</div>
					<div class="flex flex-col gap-0.5">
						<span>Upload token logo</span>
						<span class="text-[0.6rem] text-dim">Optional — you can add it later</span>
					</div>
				</button>
			{/if}
		</div>

		<!-- Name + Symbol row -->
		<div class="flex gap-3 max-[500px]:flex-col">
			<div class="flex flex-col gap-[0.3rem] flex-[2]">
				<label class="font-mono text-[0.82rem] text-foreground tracking-[0.02em]" for="bi-name">Token Name</label>
				<input id="bi-name" class="input-field" type="text" placeholder="e.g. My Token" bind:value={name} required minlength="1" maxlength="50" />
			</div>
			<div class="flex flex-col gap-[0.3rem] flex-1">
				<label class="font-mono text-[0.82rem] text-foreground tracking-[0.02em]" for="bi-symbol">Symbol</label>
				<input id="bi-symbol" class="input-field" type="text" placeholder="e.g. MTK" value={symbol} oninput={handleSymbolInput} required minlength="1" maxlength="11" />
			</div>
		</div>

		<!-- Total Supply -->
		<div class="flex flex-col gap-[0.3rem]">
			<label class="font-mono text-[0.82rem] text-foreground tracking-[0.02em]" for="bi-supply">Total Supply</label>
			<input id="bi-supply" class="input-field" type="number" placeholder="e.g. 1000000000" bind:value={totalSupply} min="1" required />
			<div class="flex gap-1 mt-1">
				{#each supplyPresets as p}
					<button type="button" class={'font-mono text-[0.68rem] px-2.5 py-[3px] rounded-full border bg-surface cursor-pointer transition-all duration-[120ms] ' + (totalSupply === p.value ? 'border-brand-cyan/30 text-brand-cyan bg-brand-cyan/6' : 'border-line text-dim hover:border-brand-cyan/20 hover:text-muted')} tabindex="-1" onclick={() => (totalSupply = p.value)}>{p.label}</button>
				{/each}
			</div>
			{#if formattedSupply()}
				<span class="font-mono text-[0.72rem] text-muted">{formattedSupply()}</span>
			{/if}
		</div>

		<!-- Decimals -->
		<div class="flex flex-row items-center gap-2">
			<label class="font-mono text-[0.72rem] text-muted tracking-[0.02em]" for="bi-decimals">Decimals</label>
			<input id="bi-decimals" class="input-field w-16 text-center" type="number" bind:value={decimals} min="0" max="18" />
		</div>

		<!-- About (collapsible) — dashed card so users read it as "optional but valuable" -->
		<p class="font-mono text-[0.72rem] leading-[1.4] text-white/45 my-1">Adding a description and links makes your token show up well on Explore.</p>
		<div class={'rounded-xl p-3 transition-[border-color,background] duration-[150ms] ' + (showMetadata ? 'bg-brand-cyan/4 border border-solid border-brand-cyan/20' : 'bg-brand-cyan/[0.025] border border-dashed border-brand-cyan/[0.22] hover:border-brand-cyan/35')}>
			<button class="flex items-center gap-2 w-full py-1 px-0.5 bg-transparent border-0 cursor-pointer font-inherit text-inherit text-left" onclick={() => showMetadata = !showMetadata} type="button" aria-expanded={showMetadata}>
				<span class="font-display text-[0.82rem] font-semibold text-foreground flex-1 inline-flex items-center gap-2">About this token <span class="font-mono text-[0.6rem] font-normal text-brand-cyan/70 bg-brand-cyan/8 px-[7px] py-0.5 rounded-full uppercase tracking-[0.05em]">optional</span></span>
				<svg class={'text-placeholder transition-transform duration-[150ms] flex-shrink-0 ' + (showMetadata ? 'rotate-180' : '')} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
			</button>

			{#if !showMetadata}
				<div class="flex flex-wrap gap-1.5 mt-2">
					<span class="font-mono text-[0.65rem] px-2.5 py-[3px] rounded-full bg-white/3 border border-white/6 text-white/55">📝 Description</span>
					<span class="font-mono text-[0.65rem] px-2.5 py-[3px] rounded-full bg-white/3 border border-white/6 text-white/55">🔗 Links</span>
				</div>
			{/if}

		{#if showMetadata}
			<div class="flex flex-col gap-3 pt-3 mt-2 border-t border-dashed border-white/6">
				<div class="flex flex-col gap-[0.3rem]">
					<label class="font-mono text-[0.72rem] text-muted tracking-[0.02em]" for="bi-desc">Description</label>
					<textarea id="bi-desc" class="input-field resize-y" rows="2" placeholder="What is this token about?" bind:value={tokenDescription}></textarea>
				</div>
				<div class="flex flex-col gap-[0.3rem]">
					<label class="font-mono text-[0.72rem] text-muted tracking-[0.02em]" for="bi-web">Website</label>
					<input id="bi-web" class="input-field" type="url" placeholder="https://yourtoken.com" bind:value={tokenWebsite} />
				</div>
				<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
					<div class="flex flex-col gap-[0.3rem]">
						<label class="font-mono text-[0.72rem] text-muted tracking-[0.02em]" for="bi-tw">Twitter / X</label>
						<input id="bi-tw" class="input-field" type="text" placeholder="@handle" bind:value={tokenTwitter} />
					</div>
					<div class="flex flex-col gap-[0.3rem]">
						<label class="font-mono text-[0.72rem] text-muted tracking-[0.02em]" for="bi-tg">Telegram</label>
						<input id="bi-tg" class="input-field" type="text" placeholder="@group" bind:value={tokenTelegram} />
					</div>
				</div>
			</div>
		{/if}
		</div>
	{/if}
</div>

<style>
	/* Modal entrance animations — keyframes cannot be utilities */
	.preset-overlay { animation: fadeIn 0.15s ease-out; }
	.preset-modal { animation: slideUp 0.2s ease-out; }
	@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
	@keyframes slideUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
</style>
