<script lang="ts">
	import { ethers } from 'ethers';
	import { shortAddr } from '$lib/formatters';
	import { t } from '$lib/i18n';
	import type { SupportedNetwork } from '$lib/structure';

	type Purchase = {
		buyer: string;
		base_amount: string;
		tokens_received: string;
		fee: string;
		price: string;
		created_at: string;
	};

	let {
		tx,
		index,
		total,
		firstBuyerAddr,
		buyerCounts,
		hardCapVal,
		curPriceForCtx,
		userAddress,
		tokenSymbol,
		tokenDecimals,
		usdtDecimals,
		network,
	}: {
		tx: Purchase;
		index: number;
		total: number;
		firstBuyerAddr: string;
		buyerCounts: Record<string, number>;
		hardCapVal: number;
		curPriceForCtx: number;
		userAddress: string | null;
		tokenSymbol: string;
		tokenDecimals: number;
		usdtDecimals: number;
		network: SupportedNetwork | null;
	} = $props();

	function relativeTime(iso: string): string {
		const diff = Date.now() - new Date(iso).getTime();
		if (diff < 60000) return $t('lpd.justNow');
		if (diff < 3600000) return $t('lpd.minutesAgo').replace('{n}', String(Math.floor(diff / 60000)));
		if (diff < 86400000) return $t('lpd.hoursAgo').replace('{n}', String(Math.floor(diff / 3600000)));
		return $t('lpd.daysAgo').replace('{n}', String(Math.floor(diff / 86400000)));
	}

	let usdtVal = $derived(parseFloat(ethers.formatUnits(BigInt(tx.base_amount) + BigInt(tx.fee || '0'), usdtDecimals)));
	let tokVal = $derived(parseFloat(ethers.formatUnits(BigInt(tx.tokens_received), tokenDecimals)));
	let isWhale = $derived(hardCapVal > 0 && (usdtVal / hardCapVal) >= 0.05);
	let isSelf = $derived(tx.buyer === userAddress?.toLowerCase());
	let txTs = $derived(typeof tx.created_at === 'number' ? (tx.created_at as number) * 1000 : new Date(tx.created_at).getTime());
	let ageMs = $derived(Date.now() - txTs);
	let isLive = $derived(ageMs < 300000);
	let fmtTok = $derived(tokVal > 1000000 ? (tokVal / 1000000).toFixed(1) + 'M' : tokVal > 1000 ? (tokVal / 1000).toFixed(1) + 'K' : tokVal.toFixed(0));
	let isFirstBuyer = $derived(tx.buyer === firstBuyerAddr && index === total - 1);
	let isRepeat = $derived((buyerCounts[tx.buyer] || 0) > 1);
	let txPrice = $derived(tokVal > 0 ? usdtVal / tokVal : 0);
	let priceDiffPct = $derived(curPriceForCtx > 0 && txPrice > 0 ? ((curPriceForCtx - txPrice) / txPrice * 100) : 0);
	let showTimelineLine = $derived(index < total - 1);
</script>

<div class="flex animate-activity-slide-in" style="animation-delay: {index * 40}ms">
	<div class="flex flex-col items-center w-3 shrink-0 pt-1.5">
		{#if isLive}
			<span class="w-2 h-2 rounded-full bg-cyan shrink-0 animate-pulse-dot"></span>
		{:else}
			<span class="w-2 h-2 rounded-full bg-[var(--border)] shrink-0"></span>
		{/if}
		{#if showTimelineLine}
			<span class={"w-[1.5px] flex-1 my-[3px] " + (index === 0 ? "bg-cyan-400/20" : "bg-[var(--border-subtle)]")}></span>
		{/if}
	</div>
	<div class={"flex-1 min-w-0 pb-3 " + (isLive ? "bg-cyan/[0.04] rounded-lg py-1.5 px-2.5 -my-1.5 -mx-2.5 border border-cyan/[0.08]" : "")}>
		<div class="flex items-baseline flex-wrap gap-x-1.5 gap-y-1 mb-0.5">
			<a
				href="{network?.explorer_url || ''}/address/{tx.buyer}"
				target="_blank"
				rel="noopener noreferrer"
				class={"font-mono text-xs font-bold no-underline hover:text-cyan " + (isSelf ? "text-cyan" : index === 0 ? "text-[var(--text-heading)]" : "text-[var(--text)]")}
			>{isSelf ? $t('lpd.you') : shortAddr(tx.buyer)}</a>
			{#if isFirstBuyer}<span class="text-xxs py-px px-[5px] rounded font-mono font-semibold bg-warning/10 text-warning">🥇 {$t('lpd.firstBadge')}</span>{/if}
			{#if isWhale}<span class="text-xxs py-px px-[5px] rounded font-mono font-semibold bg-warning/[0.08] text-warning">🐋</span>{/if}
			{#if isRepeat && !isSelf}<span class="text-xxs py-px px-[5px] rounded font-mono font-semibold bg-purple/[0.08] text-purple">🔁</span>{/if}
			{#if isLive}
				<span class="animate-pulse-glow font-mono text-xxs font-bold text-cyan ml-auto py-px px-1.5 rounded bg-cyan-400/10 border border-cyan-400/15">{$t('lpd.justNowLabel')}</span>
			{:else}
				<span class="font-mono text-xs2 text-[var(--text-dim)] whitespace-nowrap ml-auto">{relativeTime(tx.created_at)}</span>
			{/if}
		</div>
		<div class="rajdhani text-sm font-semibold leading-snug tabular-nums">
			<span class="text-[var(--text-muted)]">{fmtTok}</span>
			<span class="text-[var(--text-dim)] text-xs">{tokenSymbol}</span>
			<span class="text-[var(--text-dim)] text-xs2 mx-0.5">·</span>
			<span class={"font-bold text-md " + (isWhale ? "text-warning text-base" : index === 0 ? "text-cyan" : "text-success")}>${usdtVal < 0.01 ? '<0.01' : usdtVal.toFixed(2)}</span>
		</div>
		{#if priceDiffPct > 10}
			<div class="font-mono text-xxs text-success mt-0.5 opacity-70">{$t('lpd.boughtBelowPct').replace('{pct}', priceDiffPct > 999 ? (priceDiffPct / 100).toFixed(0) + 'x' : priceDiffPct.toFixed(0) + '%')}</div>
		{/if}
	</div>
</div>
