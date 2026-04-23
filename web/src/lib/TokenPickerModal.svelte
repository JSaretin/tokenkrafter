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
	<div class="fixed inset-0 z-[100] bg-black/70 backdrop-blur-[4px] flex items-start justify-center py-[60px] px-4 max-[639px]:items-end max-[639px]:p-0" onclick={close} role="dialog" aria-modal="true">
		<div class="w-full max-w-[420px] max-h-[70vh] bg-background border border-line rounded-[20px] overflow-hidden flex flex-col max-[639px]:max-w-full max-[639px]:rounded-t-[20px] max-[639px]:rounded-b-none max-[639px]:h-[85vh] max-[639px]:max-h-[85vh]" onclick={(e) => e.stopPropagation()}>
			<div class="flex justify-between items-center py-4 px-5 border-b border-line">
				<h3 class="font-display text-base font-bold text-heading m-0">{title}</h3>
				<button class="bg-none border-none text-muted cursor-pointer p-1 rounded-lg transition-all hover:text-foreground hover:bg-surface-hover" onclick={close}>
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
				</button>
			</div>

			<input
				class="input-field mx-4 my-3 w-[calc(100%-32px)]"
				placeholder="Search name, symbol, or paste address..."
				bind:value={search}
				autofocus
			/>

			<div class="tpm-list overflow-y-auto px-2 pb-2 flex-1 min-h-0">
				<!-- Import by address (pasted) -->
				{#if ethers.isAddress(search.trim()) && !filtered.find(t => t.address.toLowerCase() === search.trim().toLowerCase())}
					{#if pastedLoading}
						<div class="flex items-center gap-[10px] w-full py-[10px] px-3 rounded-xl text-left" style="cursor: default; opacity: 0.6;">
							<div class="w-9 h-9 rounded-full shrink-0 flex items-center justify-center bg-[rgba(139,92,246,0.1)] text-[#a78bfa] border border-[rgba(139,92,246,0.2)] font-display text-sm font-bold">
								<div class="w-4 h-4 border-2 border-[rgba(139,92,246,0.2)] border-t-[#a78bfa] rounded-full animate-spin"></div>
							</div>
							<div class="flex-1 min-w-0">
								<span class="block font-display text-[13px] font-bold text-heading">Loading...</span>
								<span class="block font-mono text-[10px] text-dim shrink-0">{search.trim().slice(0, 6)}...{search.trim().slice(-4)}</span>
							</div>
						</div>
					{:else if pastedMeta}
						<button class="flex items-center gap-[10px] w-full py-[10px] px-3 rounded-xl border-none bg-transparent cursor-pointer transition-all text-left hover:bg-surface-hover" onclick={importPasted}>
							{#if pastedMeta.logoUrl}
								<img src={pastedMeta.logoUrl} alt="" class="w-9 h-9 rounded-full object-cover shrink-0" />
							{:else}
								<div class="w-9 h-9 rounded-full shrink-0 flex items-center justify-center bg-[rgba(139,92,246,0.1)] text-[#a78bfa] border border-[rgba(139,92,246,0.2)] font-display text-sm font-bold">{pastedMeta.symbol.charAt(0)}</div>
							{/if}
							<div class="flex-1 min-w-0">
								<span class="block font-display text-[13px] font-bold text-heading">{pastedMeta.symbol}</span>
								<span class="block font-display text-[10px] text-muted whitespace-nowrap overflow-hidden text-ellipsis">{pastedMeta.name}</span>
							</div>
							<span class="font-display text-[10px] font-bold text-[#a78bfa] bg-[rgba(139,92,246,0.1)] border border-[rgba(139,92,246,0.2)] py-[3px] px-2 rounded-md shrink-0">Import</span>
						</button>
					{:else}
						<button class="flex items-center gap-[10px] w-full py-[10px] px-3 rounded-xl border-none bg-transparent cursor-pointer transition-all text-left hover:bg-surface-hover" onclick={importPasted}>
							<div class="w-9 h-9 rounded-full shrink-0 flex items-center justify-center bg-[rgba(139,92,246,0.1)] text-[#a78bfa] border border-[rgba(139,92,246,0.2)] font-display text-sm font-bold">?</div>
							<div class="flex-1 min-w-0">
								<span class="block font-display text-[13px] font-bold text-heading">Import Token</span>
								<span class="block font-mono text-[10px] text-dim shrink-0">{search.trim().slice(0, 6)}...{search.trim().slice(-4)}</span>
							</div>
						</button>
					{/if}
				{/if}

				{#each filtered as token}
					<button class="flex items-center gap-[10px] w-full py-[10px] px-3 rounded-xl border-none bg-transparent cursor-pointer transition-all text-left hover:bg-surface-hover" onclick={() => pick(token)}>
						{#if token.logoUrl || getKnownLogo(token.symbol)}
							<img src={token.logoUrl || getKnownLogo(token.symbol)} alt="" class="w-9 h-9 rounded-full object-cover shrink-0" />
						{:else}
							<div class="w-9 h-9 rounded-full shrink-0 flex items-center justify-center bg-[rgba(0,210,255,0.08)] text-brand-cyan border border-[rgba(0,210,255,0.15)] font-display text-sm font-bold">
								{token.symbol.charAt(0)}
							</div>
						{/if}
						<div class="flex-1 min-w-0">
							<span class="block font-display text-[13px] font-bold text-heading">{token.symbol}</span>
							<span class="block font-display text-[10px] text-muted whitespace-nowrap overflow-hidden text-ellipsis">{token.name}</span>
						</div>
						{#if token.balance !== undefined && token.balance > 0n}
							<span class="font-['Rajdhani',sans-serif] text-[11px] font-bold text-foreground shrink-0 tabular-nums">{formatBalance(token.balance, token.decimals)}</span>
						{/if}
						{#if token.address !== ethers.ZeroAddress}
							<span class="font-mono text-[10px] text-dim shrink-0">{token.address.slice(0, 6)}...{token.address.slice(-4)}</span>
						{/if}
					</button>
				{/each}

				{#if filtered.length === 0 && !ethers.isAddress(search.trim())}
					<p class="text-center p-5 text-muted font-display text-xs">No tokens found</p>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.tpm-list {
		scrollbar-width: thin;
		scrollbar-color: var(--color-surface-hover) transparent;
	}
</style>
