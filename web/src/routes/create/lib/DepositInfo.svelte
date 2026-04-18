<script lang="ts">
	import QrCode from '$lib/QrCode.svelte';
	import CopyButton from '$lib/CopyButton.svelte';

	let {
		address,
		amountDisplay,
		balance,
		required = null,
		network,
	}: {
		address: string;
		amountDisplay: string;
		balance: string | null;
		required?: string | null;
		network?: { name?: string; explorer_url?: string };
	} = $props();

	let balanceSufficient = $derived.by(() => {
		if (balance === null || required === null) return null;
		const b = parseFloat(balance);
		const r = parseFloat(required);
		if (isNaN(b) || isNaN(r)) return null;
		return b >= r;
	});
</script>

<div class="flex flex-col gap-3">
	<!-- Amount box -->
	<div class="text-center p-2.5 bg-cyan-400/5 border border-cyan-400/10 rounded-[10px]">
		<span class="block text-3xs text-(--text-dim) font-mono">Send at least</span>
		<div class="flex items-center justify-center gap-1.5">
			<span class="block font-['Rajdhani',sans-serif] text-2xl2 font-bold text-cyan-400 tabular-nums">{amountDisplay}</span>
			<CopyButton text={amountDisplay} iconOnly class="text-(--text-dim) hover:opacity-80" />
		</div>
		<span
			class={"block text-4xs font-mono mt-1 "
				+ (balance === null ? "text-(--text-dim)"
				: balanceSufficient === false ? "text-amber-500"
				: balanceSufficient === true ? "text-emerald-500"
				: "text-amber-500")}
		>
			{#if balance === null}
				Checking balance...
			{:else}
				Balance: {balance}
			{/if}
		</span>
	</div>

	<!-- QR + address -->
	<div class="flex items-center gap-3.5 p-3 bg-(--bg-surface) border border-(--border-subtle) rounded-[10px]">
		<div class="p-2 bg-white rounded-[10px] inline-block">
			<QrCode data={address} width={120} colorDark="#000000" colorLight="#ffffff" margin={6} />
		</div>
		<div class="flex-1 min-w-0 flex flex-col gap-1">
			<span class="text-4xs text-(--text-dim) font-mono uppercase tracking-[0.04em]">Deposit address</span>
			<span class="text-3xs text-(--text) font-mono break-all leading-normal">{address}</span>
			<div class="flex items-center gap-2">
				<CopyButton text={address} class="text-4xs text-cyan-400 font-mono" />
				{#if network?.name}
					<span class="text-4xs text-amber-500 font-mono">{network.name} only</span>
				{/if}
			</div>
			{#if network?.explorer_url}
				<a
					href={network.explorer_url.replace(/\/$/, '') + '/address/' + address}
					target="_blank"
					rel="noopener noreferrer"
					class="text-4xs text-cyan-400 font-mono no-underline hover:opacity-70"
				>View on explorer →</a>
			{/if}
		</div>
	</div>

	<!-- Polling status -->
	<div class="flex items-center justify-center gap-1.5 text-3xs text-(--text-dim) font-mono">
		<div class="w-3 h-3 rounded-full border-2 border-white/10 border-t-cyan-400 animate-spin"></div>
		<span>Waiting for deposit...</span>
	</div>
</div>
