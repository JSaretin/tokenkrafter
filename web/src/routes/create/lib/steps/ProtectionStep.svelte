<script lang="ts">
	let {
		protectionEnabled = $bindable(false),
		maxWalletPct = $bindable('2'),
		maxTransactionPct = $bindable('1'),
		cooldownSeconds = $bindable('0'),
		blacklistWindowSeconds = $bindable('0'),
	}: {
		protectionEnabled: boolean;
		maxWalletPct: string;
		maxTransactionPct: string;
		cooldownSeconds: string;
		blacklistWindowSeconds: string;
	} = $props();
</script>

<div class="flex flex-col gap-4">
	<div class="px-3 py-2.5 rounded-lg bg-amber-500/[0.06] border border-amber-500/20 text-amber-300 text-[11px] font-mono leading-[1.55]">
		Protection limits apply to every transfer forever. They can only be <strong>relaxed</strong> (loosened) after trading starts — never tightened. Choose carefully.
	</div>

	<div class="flex flex-col gap-2">
		<button type="button" class={'flex items-center justify-between gap-3 px-3.5 py-3 rounded-[10px] border cursor-pointer font-inherit text-inherit text-left transition-colors duration-150 ' + (protectionEnabled ? 'border-amber-500/25 bg-amber-500/[0.03]' : 'border-line-subtle bg-surface hover:border-line')} onclick={() => protectionEnabled = !protectionEnabled}>
			<div>
				<span class="block font-display text-[13px] font-semibold text-foreground">Anti-Whale Protection</span>
				<span class="block text-[10px] text-dim font-mono mt-px">Limit max wallet & transaction size</span>
			</div>
			<div class={'ps-switch relative shrink-0 w-9 h-5 rounded-[10px] border transition-colors duration-200 ' + (protectionEnabled ? 'bg-amber-500 border-amber-500/50 is-on' : 'bg-(--toggle-track) border-line')}><div class="ps-thumb absolute top-px left-px w-4 h-4 rounded-full bg-(--toggle-thumb-off) transition-all duration-200 shadow-[0_1px_3px_rgba(0,0,0,0.2)]"></div></div>
		</button>

		{#if protectionEnabled}
			<div class="grid grid-cols-3 max-sm:grid-cols-2 gap-2">
				<div class="flex flex-col gap-[3px]">
					<label class="text-[9px] text-dim font-mono uppercase tracking-[0.04em]" for="ps-mw">Max Wallet</label>
					<select id="ps-mw" class="ps-select px-2.5 py-2 rounded-lg bg-surface border border-line text-foreground font-mono text-[11px] outline-none appearance-none cursor-pointer pr-6" bind:value={maxWalletPct}>
						<option value="0">No limit</option>
						<option value="1">1% of supply</option>
						<option value="2">2% of supply</option>
						<option value="3">3% of supply</option>
						<option value="5">5% of supply</option>
						<option value="10">10% of supply</option>
					</select>
					<span class="text-[9px] text-dim font-mono leading-[1.4] opacity-70">Limits how much any single wallet can hold. Can only be relaxed (increased) after trading starts.</span>
				</div>
				<div class="flex flex-col gap-[3px]">
					<label class="text-[9px] text-dim font-mono uppercase tracking-[0.04em]" for="ps-mt">Max Transaction</label>
					<select id="ps-mt" class="ps-select px-2.5 py-2 rounded-lg bg-surface border border-line text-foreground font-mono text-[11px] outline-none appearance-none cursor-pointer pr-6" bind:value={maxTransactionPct}>
						<option value="0">No limit</option>
						<option value="0.5">0.5% of supply</option>
						<option value="1">1% of supply</option>
						<option value="2">2% of supply</option>
						<option value="3">3% of supply</option>
						<option value="5">5% of supply</option>
					</select>
					<span class="text-[9px] text-dim font-mono leading-[1.4] opacity-70">Limits single transfer size. Can only be relaxed after trading starts.</span>
				</div>
				<div class="flex flex-col gap-[3px] max-sm:col-span-2">
					<label class="text-[9px] text-dim font-mono uppercase tracking-[0.04em]" for="ps-cd">Cooldown</label>
					<select id="ps-cd" class="ps-select px-2.5 py-2 rounded-lg bg-surface border border-line text-foreground font-mono text-[11px] outline-none appearance-none cursor-pointer pr-6" bind:value={cooldownSeconds}>
						<option value="0">Disabled</option>
						<option value="30">30 seconds</option>
						<option value="60">1 minute</option>
						<option value="300">5 minutes</option>
					</select>
					<span class="text-[9px] text-dim font-mono leading-[1.4] opacity-70">Minimum time between transfers from the same address. Prevents rapid-fire trading.</span>
				</div>
			</div>

			<div class="flex flex-col gap-[3px] mt-1.5">
				<label class="text-[9px] text-dim font-mono uppercase tracking-[0.04em]" for="ps-bl">Sniper Blacklist Window</label>
				<select id="ps-bl" class="ps-select px-2.5 py-2 rounded-lg bg-surface border border-line text-foreground font-mono text-[11px] outline-none appearance-none cursor-pointer pr-6" bind:value={blacklistWindowSeconds}>
					<option value="0">Off</option>
					<option value="3600">1 hour</option>
					<option value="21600">6 hours</option>
					<option value="86400">24 hours</option>
					<option value="259200">72 hours</option>
				</select>
				<span class="text-[9px] text-dim font-mono leading-[1.4] opacity-70">Allows blocking sniper bots for a limited window after trading starts. The window auto-expires — blacklisting is permanently disabled after it closes.</span>
			</div>
		{/if}
	</div>
</div>

<style>
	.ps-switch.is-on .ps-thumb { left: 17px; background: var(--toggle-thumb); }
	.ps-select {
		background-image: url("data:image/svg+xml,%3Csvg width='8' height='5' viewBox='0 0 8 5' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l3 3 3-3' stroke='%23475569' fill='none' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E");
		background-repeat: no-repeat;
		background-position: right 10px center;
	}
	.ps-select option { background: var(--bg); }
</style>
