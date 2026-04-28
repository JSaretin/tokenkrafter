<script lang="ts">
	import { ethers } from 'ethers';
	import { fly, fade } from 'svelte/transition';
	import { ERC20Contract } from './tokenCrafter';
	import { getKnownLogo, resolveTokenLogo } from './tokenLogo';
	import { addUserToken, userTokens } from './userTokens';
	import { hiddenAssets } from './hiddenAssets';
	import { unmarkDeleted } from './deletedTokens';
	import { pushPreferences } from './embeddedWallet';
	import type { SupportedNetwork } from './structure';

	let {
		open = $bindable(false),
		networks = [] as SupportedNetwork[],
		defaultChainId = 56,
		walletType = 'embedded' as 'embedded' | 'external',
		sharedProviders = null as Map<number, ethers.JsonRpcProvider> | null,
		onFeedback = (_: { message: string; type: string }) => {},
	}: {
		open: boolean;
		networks: SupportedNetwork[];
		defaultChainId: number;
		walletType?: 'embedded' | 'external';
		sharedProviders?: Map<number, ethers.JsonRpcProvider> | null;
		onFeedback?: (f: { message: string; type: string }) => void;
	} = $props();

	// Source-of-truth inputs — auto-populated from the contract on a valid
	// address paste, but the user is free to override any field afterwards.
	let chainId = $state<number>(defaultChainId);
	let address = $state('');
	let name = $state('');
	let symbol = $state('');
	let decimals = $state<string>(''); // string-bound so user can clear & re-enter

	let metaLoading = $state(false);
	let metaError = $state('');
	let importing = $state(false);
	// Tracks which fields the user has manually edited so re-fetches on
	// contract change don't clobber user-typed values.
	let manualEdited = $state<{ name: boolean; symbol: boolean; decimals: boolean }>({ name: false, symbol: false, decimals: false });

	$effect(() => {
		if (open) {
			chainId = defaultChainId;
			address = '';
			name = '';
			symbol = '';
			decimals = '';
			metaError = '';
			metaLoading = false;
			manualEdited = { name: false, symbol: false, decimals: false };
		}
	});

	function getProviderFor(cid: number): ethers.JsonRpcProvider | null {
		const shared = sharedProviders?.get?.(cid);
		if (shared) return shared;
		const net = networks.find((n) => n.chain_id === cid);
		if (!net?.rpc) return null;
		try {
			return new ethers.JsonRpcProvider(net.rpc, cid, { staticNetwork: true });
		} catch {
			return null;
		}
	}

	let metaToken = 0;
	$effect(() => {
		const addr = address.trim();
		metaError = '';
		if (!addr) {
			metaLoading = false;
			return;
		}
		if (!ethers.isAddress(addr)) {
			metaError = 'Invalid address';
			metaLoading = false;
			return;
		}
		const lower = addr.toLowerCase();
		if ($userTokens.some((t) => t.chainId === chainId && t.address === lower)) {
			metaError = $hiddenAssets.includes(lower)
				? 'Already imported (currently hidden — long-press the row to unhide)'
				: 'Already imported';
			metaLoading = false;
			return;
		}
		const provider = getProviderFor(chainId);
		if (!provider) {
			metaError = 'No RPC for selected network';
			metaLoading = false;
			return;
		}

		metaLoading = true;
		const myToken = ++metaToken;
		const erc20 = new ERC20Contract(addr, provider);
		erc20
			.getMetadata()
			.then((m) => {
				if (myToken !== metaToken) return;
				if (m.symbol == null && m.name == null && m.decimals == null) {
					metaError = 'Not an ERC-20 contract';
					return;
				}
				// Only fill fields the user hasn't manually edited.
				if (!manualEdited.name && m.name) name = m.name;
				if (!manualEdited.symbol && m.symbol) symbol = m.symbol;
				if (!manualEdited.decimals && m.decimals != null) decimals = String(m.decimals);
			})
			.catch(() => {
				if (myToken !== metaToken) return;
				metaError = 'Failed to read contract';
			})
			.finally(() => {
				if (myToken === metaToken) metaLoading = false;
			});
	});

	let canSubmit = $derived.by(() => {
		const addr = address.trim();
		if (!ethers.isAddress(addr)) return false;
		if (!symbol.trim()) return false;
		if (!name.trim()) return false;
		const d = Number(decimals);
		if (!Number.isFinite(d) || d < 0 || d > 36 || !Number.isInteger(d)) return false;
		const lower = addr.toLowerCase();
		if ($userTokens.some((t) => t.chainId === chainId && t.address === lower)) return false;
		return true;
	});

	async function handleImport() {
		if (!canSubmit) return;
		importing = true;
		try {
			const addr = address.trim();
			const lower = addr.toLowerCase();
			const finalSymbol = symbol.trim();
			const finalName = name.trim();
			const finalDecimals = Number(decimals);
			const logoUrl = getKnownLogo(finalSymbol) || (await resolveTokenLogo(addr, chainId).catch(() => ''));
			// Manual re-import overrides any prior delete tombstone.
			unmarkDeleted(lower);
			addUserToken({
				address: lower,
				symbol: finalSymbol,
				name: finalName,
				decimals: finalDecimals,
				logoUrl,
				chainId,
			});
			if (walletType === 'embedded') pushPreferences().catch(() => {});
			onFeedback({ message: `${finalSymbol} imported`, type: 'success' });
			open = false;
		} catch (e: any) {
			onFeedback({ message: e?.message || 'Import failed', type: 'error' });
		} finally {
			importing = false;
		}
	}

	function close() {
		open = false;
	}
</script>

<svelte:window onkeydown={(e) => { if (open && e.key === 'Escape') close(); }} />

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="absolute inset-0 z-40 bg-black/65 backdrop-blur-[3px] flex items-end justify-center"
		onclick={close}
		role="dialog"
		aria-modal="true"
		tabindex="-1"
		transition:fade={{ duration: 120 }}
		style="border-radius: inherit;"
	>
		<div
			class="w-full h-[80vh] max-h-[80%] bg-(--bg) border-t border-(--border) rounded-t-2xl overflow-hidden flex flex-col"
			onclick={(e) => e.stopPropagation()}
			transition:fly={{ y: 400, duration: 220 }}
		>
			<div class="flex items-center justify-between gap-2 px-4 py-3 border-b border-(--border)">
				<h3 class="font-display text-sm font-bold text-(--text-heading)">Import token</h3>
				<button
					type="button"
					aria-label="Close"
					class="p-1.5 rounded-lg text-(--text-dim) hover:text-(--text-heading) hover:bg-(--bg-surface-hover) transition-all"
					onclick={close}
				>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
				</button>
			</div>

			<div class="itm-body flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3">
				<!-- Network -->
				<label class="flex flex-col gap-1">
					<span class="font-mono text-[10px] text-(--text-dim) uppercase tracking-[0.04em]">Network</span>
					<div class="relative">
						<select
							class="itm-input itm-select"
							bind:value={chainId}
						>
							{#each networks as net}
								<option value={net.chain_id}>{net.name} · {net.symbol?.toUpperCase()}</option>
							{/each}
							{#if networks.length === 0}
								<option value={defaultChainId}>No networks loaded</option>
							{/if}
						</select>
						<svg class="itm-select-caret" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
					</div>
				</label>

				<!-- Contract address -->
				<label class="flex flex-col gap-1">
					<div class="flex items-center justify-between">
						<span class="font-mono text-[10px] text-(--text-dim) uppercase tracking-[0.04em]">Contract</span>
						{#if metaLoading}
							<span class="flex items-center gap-1.5 font-mono text-[9px] text-(--text-dim)">
								<span class="w-2.5 h-2.5 border-2 border-(--border) border-t-[#00d2ff] rounded-full animate-spin"></span>
								Reading…
							</span>
						{/if}
					</div>
					<input
						class="itm-input"
						type="text"
						placeholder="0x..."
						spellcheck="false"
						autocapitalize="off"
						autocomplete="off"
						autocorrect="off"
						bind:value={address}
					/>
				</label>

				<!-- Name -->
				<label class="flex flex-col gap-1">
					<span class="font-mono text-[10px] text-(--text-dim) uppercase tracking-[0.04em]">Name</span>
					<input
						class="itm-input"
						type="text"
						placeholder="Token name"
						bind:value={name}
						oninput={() => (manualEdited.name = true)}
					/>
				</label>

				<!-- Symbol + Decimals -->
				<div class="grid grid-cols-2 gap-2.5">
					<label class="flex flex-col gap-1">
						<span class="font-mono text-[10px] text-(--text-dim) uppercase tracking-[0.04em]">Symbol</span>
						<input
							class="itm-input"
							type="text"
							placeholder="TKN"
							bind:value={symbol}
							oninput={() => (manualEdited.symbol = true)}
						/>
					</label>
					<label class="flex flex-col gap-1">
						<span class="font-mono text-[10px] text-(--text-dim) uppercase tracking-[0.04em]">Decimals</span>
						<input
							class="itm-input"
							type="text"
							inputmode="numeric"
							placeholder="18"
							bind:value={decimals}
							oninput={() => (manualEdited.decimals = true)}
						/>
					</label>
				</div>

				{#if metaError}
					<div class="px-3 py-2 rounded-lg bg-[rgba(248,113,113,0.06)] border border-[rgba(248,113,113,0.2)]">
						<span class="font-mono text-3xs text-[#f87171]">{metaError}</span>
					</div>
				{/if}

				<p class="font-mono text-3xs text-(--text-dim) leading-[1.5]">
					Fields are auto-populated from the contract but you can edit them — the values you submit are stored as-is.
				</p>
			</div>

			<!-- Sticky footer CTA (Trust Wallet pattern: primary action docked
			     to the bottom on mobile, naturally bottom on desktop too). -->
			<div class="itm-footer">
				<button
					type="button"
					class="itm-btn-primary"
					disabled={!canSubmit || importing}
					onclick={handleImport}
				>
					{importing ? 'Importing…' : 'Import'}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.itm-input {
		width: 100%;
		padding: 10px 12px;
		border-radius: 10px;
		border: 1px solid var(--border);
		background: var(--bg-surface-input);
		color: var(--text-heading);
		font-family: 'Space Mono', monospace;
		font-size: 12px;
		transition: border-color 0.12s, box-shadow 0.12s;
	}
	.itm-input::placeholder { color: var(--text-dim); }
	.itm-input:focus {
		outline: none;
		border-color: rgba(0, 210, 255, 0.5);
		box-shadow: 0 0 0 3px rgba(0, 210, 255, 0.12);
	}
	.itm-select {
		appearance: none;
		-webkit-appearance: none;
		padding-right: 32px;
		cursor: pointer;
	}
	.itm-select-caret {
		position: absolute;
		right: 12px; top: 50%;
		transform: translateY(-50%);
		color: var(--text-dim);
		pointer-events: none;
	}
	.itm-footer {
		flex-shrink: 0;
		padding: 12px 16px calc(12px + env(safe-area-inset-bottom));
		border-top: 1px solid var(--border);
		background: var(--bg);
	}
	.itm-btn-primary {
		width: 100%;
		padding: 13px 16px;
		border-radius: 12px;
		border: none;
		background: linear-gradient(135deg, #00d2ff, #3a7bd5);
		color: white;
		font-family: 'Syne', sans-serif;
		font-size: 13px;
		font-weight: 700;
		cursor: pointer;
		transition: transform 0.12s, box-shadow 0.12s, opacity 0.12s;
	}
	.itm-btn-primary:hover:not(:disabled) {
		transform: translateY(-1px);
		box-shadow: 0 4px 16px rgba(0, 210, 255, 0.2);
	}
	.itm-btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
