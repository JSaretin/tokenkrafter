<script lang="ts" module>
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
</script>
<script lang="ts">
	/**
	 * Wrapper around the shared $lib/TokenSelectorModal. Preserves the
	 * launchpad-buy / generic picker API (PickerToken in, onPick out)
	 * so callers don't change, but renders inside the same modal the
	 * trade page uses — chain CG inventory merged into the search,
	 * infinite scroll, IDB-cached logos, paste-to-import, optional
	 * balance display per row.
	 */
	import { ethers } from 'ethers';
	import TokenSelectorModal from '$lib/TokenSelectorModal.svelte';
	import { getChainTokens, preloadChainTokens } from '$lib/chainTokensStore.svelte';

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

	$effect(() => { if (open && geckoNetwork) preloadChainTokens(geckoNetwork); });
	let chainTokens = $derived(open ? getChainTokens(geckoNetwork) : []);

	let tokenSearch = $state('');
	$effect(() => { if (open) tokenSearch = ''; });

	type TokenItem = {
		address: string;
		symbol: string;
		name: string;
		decimals: number;
		isNative?: boolean;
		logo_url?: string;
	};

	// Curated `tokens` lead the list (so balances + native flag show
	// first); CG entries fill the rest. Both filtered by search.
	let filteredTokens = $derived.by(() => {
		const q = tokenSearch.toLowerCase().trim();
		const seen = new Set<string>();
		const out: TokenItem[] = [];
		for (const t of tokens) {
			if (q && !(
				t.symbol.toLowerCase().includes(q) ||
				t.name.toLowerCase().includes(q) ||
				t.address.toLowerCase().includes(q)
			)) continue;
			out.push({
				address: t.address,
				symbol: t.symbol,
				name: t.name,
				decimals: t.decimals,
				isNative: t.isNative,
				logo_url: t.logoUrl ?? '',
			});
			seen.add(t.address.toLowerCase());
		}
		for (const r of chainTokens) {
			const aLow = r.address.toLowerCase();
			if (seen.has(aLow)) continue;
			if (q && !(
				r.symbol.toLowerCase().includes(q) ||
				r.name.toLowerCase().includes(q) ||
				aLow.includes(q)
			)) continue;
			out.push({
				address: r.address,
				symbol: r.symbol,
				name: r.name,
				decimals: r.decimals,
				logo_url: r.logo,
			});
			seen.add(aLow);
		}
		return out;
	});

	// Paste-to-import: when the user types a fresh address that's not
	// already in the merged list, fetch on-chain ERC20 metadata + the
	// caller's balance so the import row renders with real symbol/name.
	let pastedTokenMeta = $state<{ address: string; symbol: string; name: string; decimals: number; logo_url?: string } | null>(null);
	let pastedTokenLoading = $state(false);
	$effect(() => {
		const q = tokenSearch.trim();
		pastedTokenMeta = null;
		if (!ethers.isAddress(q)) return;
		const aLow = q.toLowerCase();
		if (filteredTokens.some((t) => t.address.toLowerCase() === aLow)) return;
		if (!provider) return;

		pastedTokenLoading = true;
		const addr = q;
		(async () => {
			try {
				const c = new ethers.Contract(addr, [
					'function symbol() view returns (string)',
					'function name() view returns (string)',
					'function decimals() view returns (uint8)',
				], provider);
				const [sym, name, dec] = await Promise.all([
					c.symbol().catch(() => '???'),
					c.name().catch(() => 'Unknown'),
					c.decimals().catch(() => 18),
				]);
				if (tokenSearch.trim().toLowerCase() === addr.toLowerCase() && sym !== '???') {
					pastedTokenMeta = { address: addr, symbol: sym, name, decimals: Number(dec), logo_url: '' };
				}
			} catch {}
			pastedTokenLoading = false;
		})();
	});

	function pickByAddr(addr: string, fallbackDecimals = 18) {
		const known = tokens.find((t) => t.address.toLowerCase() === addr.toLowerCase());
		if (known) {
			onPick(known);
		} else {
			const meta = pastedTokenMeta && pastedTokenMeta.address.toLowerCase() === addr.toLowerCase()
				? pastedTokenMeta
				: null;
			onPick({
				address: addr,
				symbol: meta?.symbol ?? '...',
				name: meta?.name ?? 'Loading...',
				decimals: meta?.decimals ?? fallbackDecimals,
				chainId,
			});
		}
		open = false;
	}

	function handleSelect(t: TokenItem) { pickByAddr(t.address, t.decimals); }
	function handleImport() {
		const q = tokenSearch.trim();
		if (ethers.isAddress(q)) pickByAddr(q);
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
	<TokenSelectorModal
		bind:tokenSearch
		builtInTokens={[]}
		{filteredTokens}
		{pastedTokenMeta}
		{pastedTokenLoading}
		{chainId}
		{title}
		onSelect={handleSelect}
		onImport={handleImport}
		onClose={() => { open = false; }}
	>
		{#snippet rowRightSlot(t)}
			{@const known = tokens.find((p) => p.address.toLowerCase() === t.address.toLowerCase())}
			{#if known?.balance !== undefined && known.balance > 0n}
				<span class="font-mono text-3xs text-(--text-dim) tabular-nums shrink-0">{formatBalance(known.balance, known.decimals)}</span>
			{/if}
		{/snippet}
	</TokenSelectorModal>
{/if}
