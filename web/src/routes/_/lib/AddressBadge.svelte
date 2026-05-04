<script lang="ts">
	/**
	 * AddressBadge — middle-truncated EVM address with copy + explorer
	 * affordances. Used across the admin (`/_`) tabs anywhere a contract
	 * or wallet address is displayed, so the user can quickly verify
	 * what they're looking at and either copy it or open it on the
	 * configured chain explorer.
	 *
	 * Default `head=6, tail=4` matches the BscScan-ish "0x10ED…024E"
	 * convention and stays readable on dense rows; tabs that have more
	 * room (withdrawal lists) can pass larger slices via props.
	 */
	let {
		address = '',
		explorerUrl = '',
		head = 6,
		tail = 4,
		copyable = true,
		showLink = true,
		class: cls = '',
	}: {
		address?: string;
		explorerUrl?: string;
		head?: number;
		tail?: number;
		copyable?: boolean;
		showLink?: boolean;
		class?: string;
	} = $props();

	let short = $derived(
		address && address.length > head + tail + 1
			? `${address.slice(0, head)}…${address.slice(-tail)}`
			: address
	);

	let justCopied = $state(false);
	async function copy() {
		try {
			await navigator.clipboard.writeText(address);
			justCopied = true;
			setTimeout(() => { justCopied = false; }, 1200);
		} catch {}
	}

	const btnCls = 'flex items-center justify-center w-[18px] h-[18px] rounded-[4px] border-0 bg-transparent text-(--text-dim) cursor-pointer transition-colors duration-150 no-underline hover:text-cyan-400';
</script>

{#if address}
	<span class={"inline-flex items-center gap-1 font-mono text-3xs " + cls}>
		<span class="tabular-nums">{short}</span>
		{#if copyable}
			<button type="button" class={btnCls} title={justCopied ? 'Copied!' : 'Copy address'} aria-label="Copy address" onclick={(e) => { e.stopPropagation(); copy(); }}>
				{#if justCopied}
					<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
				{:else}
					<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
				{/if}
			</button>
		{/if}
		{#if showLink && explorerUrl}
			<a class={btnCls} title="View on explorer" target="_blank" rel="noopener" href="{explorerUrl.replace(/\/$/, '')}/address/{address}" onclick={(e) => e.stopPropagation()}>
				<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
			</a>
		{/if}
	</span>
{/if}
