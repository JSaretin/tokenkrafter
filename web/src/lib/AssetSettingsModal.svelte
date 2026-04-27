<script lang="ts">
	import { ethers } from 'ethers';
	import { fly, fade } from 'svelte/transition';
	import { ERC20Contract } from './tokenCrafter';
	import { getKnownLogo, resolveTokenLogo } from './tokenLogo';
	import { addUserToken, userTokens } from './userTokens';
	import { hiddenAssets, toggleHidden } from './hiddenAssets';
	import { hideDust } from './hideDust';
	import { pushPreferences } from './embeddedWallet';
	import type { SupportedNetwork } from './structure';

	type Meta = { name: string; symbol: string; decimals: number };

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

	let selectedChainId = $state<number>(defaultChainId);
	let address = $state('');
	let meta = $state<Meta | null>(null);
	let metaLoading = $state(false);
	let metaError = $state('');
	let importing = $state(false);

	// Reset selectedChain when modal re-opens with a new defaultChainId
	$effect(() => {
		if (open) {
			selectedChainId = defaultChainId;
		}
	});

	// Reset transient form state when modal closes
	$effect(() => {
		if (!open) {
			address = '';
			meta = null;
			metaError = '';
			metaLoading = false;
		}
	});

	function getProviderFor(chainId: number): ethers.JsonRpcProvider | null {
		const shared = sharedProviders?.get?.(chainId);
		if (shared) return shared;
		const net = networks.find((n) => n.chain_id === chainId);
		if (!net?.rpc) return null;
		try {
			return new ethers.JsonRpcProvider(net.rpc, chainId, { staticNetwork: true });
		} catch {
			return null;
		}
	}

	let metaToken = 0;
	$effect(() => {
		// Trust pad: re-validate when address or chain changes
		const addr = address.trim();
		meta = null;
		metaError = '';
		metaLoading = false;
		if (!addr) return;
		if (!ethers.isAddress(addr)) {
			metaError = 'Invalid address';
			return;
		}
		const lower = addr.toLowerCase();
		if ($userTokens.some((t) => t.chainId === selectedChainId && t.address === lower)) {
			metaError = $hiddenAssets.includes(lower)
				? 'Already imported (currently hidden — long-press the row to unhide)'
				: 'Already imported';
			return;
		}
		const provider = getProviderFor(selectedChainId);
		if (!provider) {
			metaError = 'No RPC for selected network';
			return;
		}

		metaLoading = true;
		const myToken = ++metaToken;
		const erc20 = new ERC20Contract(addr, provider);
		erc20
			.getMetadata()
			.then((m) => {
				if (myToken !== metaToken) return; // raced — newer fetch in flight
				if (m.symbol == null && m.name == null && m.decimals == null) {
					metaError = 'Not an ERC-20 contract';
					meta = null;
				} else {
					meta = {
						name: m.name ?? 'Unknown',
						symbol: m.symbol ?? '???',
						decimals: m.decimals ?? 18,
					};
				}
			})
			.catch(() => {
				if (myToken !== metaToken) return;
				metaError = 'Failed to read contract';
			})
			.finally(() => {
				if (myToken === metaToken) metaLoading = false;
			});
	});

	async function handleImport() {
		if (!meta || !ethers.isAddress(address.trim())) return;
		importing = true;
		try {
			const addr = address.trim();
			const chainId = selectedChainId;
			const lower = addr.toLowerCase();
			const logoUrl = getKnownLogo(meta.symbol) || (await resolveTokenLogo(addr, chainId).catch(() => ''));
			addUserToken({
				address: lower,
				symbol: meta.symbol,
				name: meta.name,
				decimals: meta.decimals,
				logoUrl,
				chainId,
			});
			if (walletType === 'embedded') pushPreferences().catch(() => {});
			onFeedback({ message: `${meta.symbol} imported`, type: 'success' });
			address = '';
			meta = null;
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

	function shortChain(n: SupportedNetwork): string {
		return n.symbol?.toUpperCase() || n.name;
	}
</script>

<svelte:window
	onkeydown={(e) => {
		if (open && e.key === 'Escape') close();
	}}
/>

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-[10000] bg-black/65 backdrop-blur-[3px] flex items-center justify-center p-4 max-[639px]:items-end max-[639px]:p-0"
		onclick={close}
		role="dialog"
		aria-modal="true"
		tabindex="-1"
		transition:fade={{ duration: 120 }}
	>
		<div
			class="w-full max-w-[440px] max-h-[85vh] bg-(--bg) border border-(--border) rounded-2xl overflow-hidden flex flex-col max-[639px]:max-w-full max-[639px]:rounded-t-2xl max-[639px]:rounded-b-none max-[639px]:max-h-[88vh]"
			onclick={(e) => e.stopPropagation()}
			transition:fly={{ y: 16, duration: 180 }}
		>
			<!-- Header -->
			<div class="flex items-center justify-between gap-2 px-4 py-3 border-b border-(--border)">
				<h3 class="font-display text-sm font-bold text-(--text-heading)">Asset settings</h3>
				<button
					type="button"
					aria-label="Close"
					class="p-1.5 rounded-lg text-(--text-dim) hover:text-(--text-heading) hover:bg-(--bg-surface-hover) transition-all"
					onclick={close}
				>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
				</button>
			</div>

			<div class="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-4">
				<!-- Hide-dust toggle -->
				<label class="flex items-center justify-between gap-3 py-2 px-3 rounded-lg bg-(--bg-surface) border border-(--border-subtle) cursor-pointer hover:border-(--border)">
					<div class="flex flex-col gap-0.5 min-w-0">
						<span class="font-display text-13 font-bold text-(--text-heading)">Hide small balances</span>
						<span class="font-mono text-3xs text-(--text-dim)">Skip assets worth less than $0.10</span>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={$hideDust}
						aria-label="Hide small balances"
						class="relative shrink-0 w-10 h-[22px] rounded-full transition-colors {$hideDust ? 'bg-[#00d2ff]' : 'bg-(--bg-surface-input)'} border border-(--border)"
						onclick={(e) => { e.preventDefault(); hideDust.update((v) => !v); }}
					>
						<span class="absolute top-[1px] left-[1px] w-[18px] h-[18px] rounded-full bg-white shadow transition-transform" style="transform: translateX({$hideDust ? '18px' : '0'});"></span>
					</button>
				</label>

				<!-- Import -->
				<div class="flex flex-col gap-2">
					<span class="font-display text-xs font-bold text-(--text-dim) uppercase tracking-[0.04em]">Import token</span>

					<!-- Network select -->
					<div class="flex flex-wrap gap-1.5">
						{#each networks as net}
							{@const active = selectedChainId === net.chain_id}
							<button
								type="button"
								class="px-2.5 py-1.5 rounded-lg border font-mono text-3xs transition-all {active ? 'border-[#00d2ff] bg-[rgba(0,210,255,0.08)] text-[#00d2ff]' : 'border-(--border-subtle) text-(--text-muted) hover:border-(--border) hover:text-(--text-heading)'}"
								onclick={() => (selectedChainId = net.chain_id)}
							>
								{shortChain(net)}
							</button>
						{/each}
						{#if networks.length === 0}
							<span class="text-3xs text-(--text-dim) font-mono">No supported networks loaded</span>
						{/if}
					</div>

					<!-- Address input -->
					<input
						class="asm-input"
						type="text"
						placeholder="Paste contract address (0x...)"
						spellcheck="false"
						autocapitalize="off"
						autocomplete="off"
						autocorrect="off"
						bind:value={address}
					/>

					<!-- Status / metadata -->
					{#if metaLoading}
						<div class="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-(--bg-surface) border border-(--border-subtle)">
							<div class="w-3.5 h-3.5 border-2 border-(--border) border-t-[#00d2ff] rounded-full animate-spin"></div>
							<span class="font-mono text-3xs text-(--text-dim)">Reading contract…</span>
						</div>
					{:else if metaError}
						<div class="px-3 py-2.5 rounded-lg bg-[rgba(248,113,113,0.06)] border border-[rgba(248,113,113,0.2)]">
							<span class="font-mono text-3xs text-[#f87171]">{metaError}</span>
						</div>
					{:else if meta}
						<div class="grid grid-cols-3 gap-1.5">
							{#each [['Name', meta.name], ['Symbol', meta.symbol], ['Decimals', String(meta.decimals)]] as [label, value]}
								<div class="flex flex-col gap-0.5 px-2.5 py-2 rounded-lg bg-(--bg-surface) border border-(--border-subtle) min-w-0">
									<span class="font-mono text-[9px] text-(--text-dim) uppercase tracking-[0.04em]">{label}</span>
									<span class="font-display text-xs font-bold text-(--text-heading) truncate" title={value}>{value}</span>
								</div>
							{/each}
						</div>
					{/if}

					<button
						type="button"
						class="asm-btn-primary"
						disabled={!meta || importing || metaLoading}
						onclick={handleImport}
					>
						{importing ? 'Importing…' : 'Import'}
					</button>
				</div>

				<!-- Hidden assets count hint (optional, light-touch) -->
				{#if $hiddenAssets.length > 0}
					<p class="font-mono text-3xs text-(--text-dim) text-center">{$hiddenAssets.length} asset{$hiddenAssets.length === 1 ? '' : 's'} hidden — use the row in your wallet to unhide.</p>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.asm-input {
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
	.asm-input:focus {
		outline: none;
		border-color: rgba(0, 210, 255, 0.5);
		box-shadow: 0 0 0 3px rgba(0, 210, 255, 0.12);
	}
	.asm-input::placeholder { color: var(--text-dim); }
	.asm-btn-primary {
		width: 100%;
		padding: 10px 16px;
		border-radius: 10px;
		border: none;
		background: linear-gradient(135deg, #00d2ff, #3a7bd5);
		color: white;
		font-family: 'Syne', sans-serif;
		font-size: 12px;
		font-weight: 700;
		cursor: pointer;
		transition: transform 0.12s, box-shadow 0.12s, opacity 0.12s;
	}
	.asm-btn-primary:hover:not(:disabled) {
		transform: translateY(-1px);
		box-shadow: 0 4px 16px rgba(0, 210, 255, 0.2);
	}
	.asm-btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
