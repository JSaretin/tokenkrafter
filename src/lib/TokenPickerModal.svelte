<script lang="ts">
	import { ethers } from 'ethers';
	import { getKnownLogo, resolveTokenLogo } from '$lib/tokenLogo';
	import { t } from '$lib/i18n';

	export type PickerToken = {
		address: string;
		symbol: string;
		name: string;
		decimals: number;
		logoUrl?: string;
		balance?: bigint;
		chainId?: number;
		isNative?: boolean;
	};

	let {
		open = $bindable(false),
		tokens = [],
		onPick,
		title = 'Select Token',
		chainId = 56,
		geckoNetwork = 'bsc',
		provider = null,
		userAddress = '',
	}: {
		open: boolean;
		tokens: PickerToken[];
		onPick: (token: PickerToken) => void;
		title?: string;
		chainId?: number;
		geckoNetwork?: string;
		provider?: ethers.Provider | null;
		userAddress?: string;
	} = $props();

	let search = $state('');
	let pastedMeta = $state<PickerToken | null>(null);
	let pastedLoading = $state(false);

	// Filter tokens by search query
	let filtered = $derived.by(() => {
		const q = search.toLowerCase().trim();
		if (!q) return tokens;
		return tokens.filter(t =>
			t.symbol.toLowerCase().includes(q) ||
			t.name.toLowerCase().includes(q) ||
			t.address.toLowerCase().includes(q)
		);
	});

	// Detect pasted address
	$effect(() => {
		const q = search.trim();
		pastedMeta = null;
		if (!ethers.isAddress(q)) return;
		if (tokens.find(t => t.address.toLowerCase() === q.toLowerCase())) return;
		if (!provider) return;

		pastedLoading = true;
		const addr = q;
		(async () => {
			try {
				const token = new ethers.Contract(addr, [
					'function symbol() view returns (string)',
					'function name() view returns (string)',
					'function decimals() view returns (uint8)',
					'function balanceOf(address) view returns (uint256)'
				], provider);
				const [sym, name, dec, bal] = await Promise.all([
					token.symbol().catch(() => '???'),
					token.name().catch(() => 'Unknown'),
					token.decimals().catch(() => 18),
					userAddress ? token.balanceOf(userAddress).catch(() => 0n) : Promise.resolve(0n)
				]);
				if (search.trim().toLowerCase() === addr.toLowerCase() && sym !== '???') {
					const logo = getKnownLogo(sym) || await resolveTokenLogo(addr, chainId, geckoNetwork);
					pastedMeta = { address: addr, symbol: sym, name, decimals: Number(dec), logoUrl: logo, balance: bal, chainId };
				}
			} catch {}
			pastedLoading = false;
		})();
	});

	function pick(token: PickerToken) {
		onPick(token);
		search = '';
		open = false;
	}

	function importPasted() {
		if (pastedMeta) {
			pick(pastedMeta);
		} else if (ethers.isAddress(search.trim())) {
			// Unknown token — pick with minimal info, caller can resolve
			pick({ address: search.trim(), symbol: '...', name: 'Loading...', decimals: 18, chainId });
		}
	}

	function close() {
		open = false;
		search = '';
		pastedMeta = null;
	}

	function formatBalance(bal: bigint, decimals: number): string {
		const raw = ethers.formatUnits(bal, decimals);
		const num = parseFloat(raw);
		if (num === 0) return '0';
		if (num < 0.0001) return '<0.0001';
		return num.toLocaleString(undefined, { maximumFractionDigits: 4 });
	}
</script>

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="tpm-backdrop" onclick={close} role="dialog" aria-modal="true">
		<div class="tpm-modal" onclick={(e) => e.stopPropagation()}>
			<div class="tpm-header">
				<h3>{title}</h3>
				<button class="tpm-close" onclick={close}>
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
				</button>
			</div>

			<input
				class="input-field tpm-search"
				placeholder="Search name, symbol, or paste address..."
				bind:value={search}
				autofocus
			/>

			<div class="tpm-list">
				<!-- Import by address (pasted) -->
				{#if ethers.isAddress(search.trim()) && !filtered.find(t => t.address.toLowerCase() === search.trim().toLowerCase())}
					{#if pastedLoading}
						<div class="tpm-item" style="cursor: default; opacity: 0.6;">
							<div class="tpm-icon tpm-icon-custom">
								<div class="tpm-spinner"></div>
							</div>
							<div class="tpm-info">
								<span class="tpm-symbol">Loading...</span>
								<span class="tpm-addr">{search.trim().slice(0, 6)}...{search.trim().slice(-4)}</span>
							</div>
						</div>
					{:else if pastedMeta}
						<button class="tpm-item" onclick={importPasted}>
							{#if pastedMeta.logoUrl}
								<img src={pastedMeta.logoUrl} alt="" class="tpm-icon" />
							{:else}
								<div class="tpm-icon tpm-icon-custom">{pastedMeta.symbol.charAt(0)}</div>
							{/if}
							<div class="tpm-info">
								<span class="tpm-symbol">{pastedMeta.symbol}</span>
								<span class="tpm-name">{pastedMeta.name}</span>
							</div>
							<span class="tpm-import-badge">Import</span>
						</button>
					{:else}
						<button class="tpm-item" onclick={importPasted}>
							<div class="tpm-icon tpm-icon-custom">?</div>
							<div class="tpm-info">
								<span class="tpm-symbol">Import Token</span>
								<span class="tpm-addr">{search.trim().slice(0, 6)}...{search.trim().slice(-4)}</span>
							</div>
						</button>
					{/if}
				{/if}

				{#each filtered as token}
					<button class="tpm-item" onclick={() => pick(token)}>
						{#if token.logoUrl || getKnownLogo(token.symbol)}
							<img src={token.logoUrl || getKnownLogo(token.symbol)} alt="" class="tpm-icon" />
						{:else}
							<div class="tpm-icon tpm-icon-placeholder">
								{token.symbol.charAt(0)}
							</div>
						{/if}
						<div class="tpm-info">
							<span class="tpm-symbol">{token.symbol}</span>
							<span class="tpm-name">{token.name}</span>
						</div>
						{#if token.balance !== undefined && token.balance > 0n}
							<span class="tpm-balance">{formatBalance(token.balance, token.decimals)}</span>
						{/if}
						{#if token.address !== ethers.ZeroAddress}
							<span class="tpm-addr">{token.address.slice(0, 6)}...{token.address.slice(-4)}</span>
						{/if}
					</button>
				{/each}

				{#if filtered.length === 0 && !ethers.isAddress(search.trim())}
					<p class="tpm-empty">No tokens found</p>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.tpm-backdrop {
		position: fixed; inset: 0; z-index: 100; background: rgba(0,0,0,0.7);
		backdrop-filter: blur(4px); display: flex; align-items: flex-start;
		justify-content: center; padding: 60px 16px;
	}
	.tpm-modal {
		width: 100%; max-width: 420px; max-height: 70vh;
		background: var(--bg); border: 1px solid var(--border);
		border-radius: 20px; overflow: hidden; display: flex; flex-direction: column;
	}
	.tpm-header {
		display: flex; justify-content: space-between; align-items: center;
		padding: 16px 20px; border-bottom: 1px solid var(--border);
	}
	.tpm-header h3 {
		font-family: 'Syne', sans-serif; font-size: 16px; font-weight: 700;
		color: var(--text-heading); margin: 0;
	}
	.tpm-close {
		background: none; border: none; color: var(--text-muted); cursor: pointer;
		padding: 4px; border-radius: 8px; transition: all 150ms;
	}
	.tpm-close:hover { color: var(--text); background: var(--bg-surface-hover); }
	.tpm-search { margin: 12px 16px; width: calc(100% - 32px); }

	.tpm-list {
		overflow-y: auto; padding: 0 8px 8px;
		scrollbar-width: thin; scrollbar-color: var(--bg-surface-hover) transparent;
		height: 60vh;
	}
	@media (min-width: 640px) {
		.tpm-list { height: 80vh; }
	}
	.tpm-item {
		display: flex; align-items: center; gap: 10px; width: 100%;
		padding: 10px 12px; border-radius: 12px; border: none;
		background: transparent; cursor: pointer; transition: all 150ms; text-align: left;
	}
	.tpm-item:hover { background: var(--bg-surface-hover); }
	.tpm-icon {
		width: 36px; height: 36px; border-radius: 50%; object-fit: cover; flex-shrink: 0;
	}
	.tpm-icon-placeholder {
		display: flex; align-items: center; justify-content: center;
		background: rgba(0,210,255,0.08); color: #00d2ff; border: 1px solid rgba(0,210,255,0.15);
		font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 700;
	}
	.tpm-icon-custom {
		display: flex; align-items: center; justify-content: center;
		background: rgba(139,92,246,0.1); color: #a78bfa; border: 1px solid rgba(139,92,246,0.2);
		font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 700;
	}
	.tpm-spinner {
		width: 16px; height: 16px; border: 2px solid rgba(139,92,246,0.2);
		border-top-color: #a78bfa; border-radius: 50%; animation: tpm-spin 0.8s linear infinite;
	}
	@keyframes tpm-spin { to { transform: rotate(360deg); } }
	.tpm-import-badge {
		font-family: 'Space Mono', monospace; font-size: 10px; font-weight: 700;
		color: #a78bfa; background: rgba(139,92,246,0.1); border: 1px solid rgba(139,92,246,0.2);
		padding: 3px 8px; border-radius: 6px; flex-shrink: 0;
	}
	.tpm-info { flex: 1; min-width: 0; }
	.tpm-symbol {
		display: block; font-family: 'Space Mono', monospace; font-size: 13px;
		font-weight: 700; color: var(--text-heading);
	}
	.tpm-name {
		display: block; font-family: 'Space Mono', monospace; font-size: 10px;
		color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	}
	.tpm-balance {
		font-family: 'Space Mono', monospace; font-size: 11px; font-weight: 700;
		color: var(--text); flex-shrink: 0;
	}
	.tpm-addr {
		font-family: 'Space Mono', monospace; font-size: 10px; color: var(--text-dim); flex-shrink: 0;
	}
	.tpm-empty {
		text-align: center; padding: 20px; color: var(--text-muted);
		font-family: 'Space Mono', monospace; font-size: 12px;
	}

	/* Mobile bottom-sheet */
	@media (max-width: 639px) {
		.tpm-backdrop { align-items: flex-end; padding: 0; }
		.tpm-modal { max-width: 100%; border-radius: 20px 20px 0 0; max-height: 85vh; }
	}
</style>
