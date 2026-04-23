<script lang="ts">
	import { t } from '$lib/i18n';
	import FixedOverlay from '$lib/FixedOverlay.svelte';

	type BankItem = {
		code: string;
		name: string;
		slug: string;
		logo?: string;
		ussd?: string;
	};

	let {
		banks = [],
		searchQuery = $bindable(''),
		onSelect,
		onClose,
	}: {
		banks?: BankItem[];
		searchQuery?: string;
		onSelect: (bank: BankItem) => void;
		onClose: () => void;
	} = $props();

	let filtered = $derived.by(() => {
		const q = searchQuery.toLowerCase().trim();
		if (!q) return banks;
		return banks.filter(b => b.name.toLowerCase().includes(q));
	});
</script>

<FixedOverlay show={true} onclose={onClose}>
	<div class="w-full max-w-[420px] bg-(--bg) border border-(--border) rounded-[20px] overflow-hidden max-h-[70vh] max-sm:h-[85vh] max-sm:max-h-[85vh] max-sm:max-w-full max-sm:rounded-b-none flex flex-col">
		<div class="flex justify-between items-center px-5 py-4 border-b border-(--border)">
			<h3 class="font-[Syne,sans-serif] text-[16px] font-bold text-(--text-heading) m-0">{$t('trade.selectBank')}</h3>
			<button aria-label="Close" class="bg-none border-0 text-(--text-muted) cursor-pointer p-1 rounded-lg transition-all duration-150 hover:text-(--text) hover:bg-(--bg-surface-hover)" onclick={onClose}>
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
			</button>
		</div>

		<input
			class="input-field mx-4 my-3 w-[calc(100%-32px)]"
			placeholder={$t('trade.searchBank')}
			bind:value={searchQuery}
		/>

		<div class="px-2 pb-2 overflow-y-auto flex-1 [scrollbar-width:thin] [scrollbar-color:var(--bg-surface-hover)_transparent]">
			{#each filtered as bank}
				<button class="flex items-center gap-2.5 w-full px-3 py-2.5 rounded-xl border-0 bg-transparent cursor-pointer transition-all duration-150 text-left hover:bg-(--bg-surface-hover)" onclick={() => onSelect(bank)}>
					<div class="w-8 h-8 rounded-full shrink-0 flex items-center justify-center bg-[rgba(16,185,129,0.08)] text-[#10b981] border border-[rgba(16,185,129,0.15)] font-[Syne,sans-serif] text-[13px] font-bold">{bank.name.charAt(0)}</div>
					<span class="font-mono text-[13px] text-(--text)">{bank.name}</span>
				</button>
			{/each}

			{#if filtered.length === 0}
				<p class="text-center p-5 text-(--text-muted) font-mono text-[12px]">{$t('trade.noBanksFound')}</p>
			{/if}
		</div>
	</div>
</FixedOverlay>
