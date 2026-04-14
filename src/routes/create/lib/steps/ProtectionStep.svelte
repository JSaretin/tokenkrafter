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

<div class="ps">
	<div class="ps-info-box">
		Protect holders from whales and snipers. These limits apply to every transfer forever — they can only be relaxed (loosened) after trading starts, never tightened.
	</div>

	<div class="ps-section">
		<button class="ps-toggle" class:ps-toggle-on={protectionEnabled} onclick={() => protectionEnabled = !protectionEnabled}>
			<div>
				<span class="ps-toggle-title">Anti-Whale Protection</span>
				<span class="ps-toggle-desc">Limit max wallet & transaction size</span>
			</div>
			<div class="ps-switch" class:ps-switch-on={protectionEnabled}><div class="ps-switch-thumb"></div></div>
		</button>

		{#if protectionEnabled}
			<div class="ps-info-box ps-info-box-warn">These limits can only be relaxed after trading starts — never tightened. Choose carefully.</div>
			<div class="ps-prot-grid">
				<div class="ps-prot-field">
					<label class="ps-prot-label" for="ps-mw">Max Wallet</label>
					<select id="ps-mw" class="ps-prot-select" bind:value={maxWalletPct}>
						<option value="0">No limit</option>
						<option value="1">1% of supply</option>
						<option value="2">2% of supply</option>
						<option value="3">3% of supply</option>
						<option value="5">5% of supply</option>
						<option value="10">10% of supply</option>
					</select>
					<span class="ps-prot-hint">Limits how much any single wallet can hold. Can only be relaxed (increased) after trading starts.</span>
				</div>
				<div class="ps-prot-field">
					<label class="ps-prot-label" for="ps-mt">Max Transaction</label>
					<select id="ps-mt" class="ps-prot-select" bind:value={maxTransactionPct}>
						<option value="0">No limit</option>
						<option value="0.5">0.5% of supply</option>
						<option value="1">1% of supply</option>
						<option value="2">2% of supply</option>
						<option value="3">3% of supply</option>
						<option value="5">5% of supply</option>
					</select>
					<span class="ps-prot-hint">Limits single transfer size. Can only be relaxed after trading starts.</span>
				</div>
				<div class="ps-prot-field">
					<label class="ps-prot-label" for="ps-cd">Cooldown</label>
					<select id="ps-cd" class="ps-prot-select" bind:value={cooldownSeconds}>
						<option value="0">Disabled</option>
						<option value="30">30 seconds</option>
						<option value="60">1 minute</option>
						<option value="300">5 minutes</option>
					</select>
					<span class="ps-prot-hint">Minimum time between transfers from the same address. Prevents rapid-fire trading.</span>
				</div>
			</div>

			<div class="ps-prot-field" style="margin-top: 6px;">
				<label class="ps-prot-label" for="ps-bl">Sniper Blacklist Window</label>
				<select id="ps-bl" class="ps-prot-select" bind:value={blacklistWindowSeconds}>
					<option value="0">Off</option>
					<option value="3600">1 hour</option>
					<option value="21600">6 hours</option>
					<option value="86400">24 hours</option>
					<option value="259200">72 hours</option>
				</select>
				<span class="ps-prot-hint">Allows blocking sniper bots for a limited window after trading starts. The window auto-expires — blacklisting is permanently disabled after it closes.</span>
			</div>
		{/if}
	</div>
</div>

<style>
	.ps { display: flex; flex-direction: column; gap: 16px; }
	.ps-info-box { padding: 10px 12px; border-radius: 8px; background: rgba(0,210,255,0.05); border: 1px solid rgba(0,210,255,0.18); color: rgba(0,210,255,0.85); font-size: 11px; font-family: 'Space Mono', monospace; line-height: 1.55; }
	.ps-info-box-warn { background: rgba(245,158,11,0.06); border-color: rgba(245,158,11,0.2); color: #fbbf24; }

	.ps-section { display: flex; flex-direction: column; gap: 8px; }

	.ps-toggle {
		display: flex; align-items: center; justify-content: space-between; gap: 12px;
		padding: 12px 14px; border-radius: 10px;
		background: var(--bg-surface); border: 1px solid var(--border-subtle);
		cursor: pointer; font-family: inherit; color: inherit; text-align: left;
		transition: border-color 0.15s;
	}
	.ps-toggle:hover { border-color: var(--border); }
	.ps-toggle-on { border-color: rgba(245,158,11,0.25); background: rgba(245,158,11,0.03); }
	.ps-toggle-title { display: block; font-family: 'Syne', sans-serif; font-size: 13px; font-weight: 600; color: var(--text); }
	.ps-toggle-desc { display: block; font-size: 10px; color: var(--text-dim); font-family: 'Space Mono', monospace; margin-top: 1px; }
	.ps-switch {
		width: 36px; height: 20px; border-radius: 10px; background: var(--toggle-track);
		position: relative; flex-shrink: 0; transition: background 0.2s;
		border: 1px solid var(--border);
	}
	.ps-switch-on { background: #f59e0b; border-color: rgba(245,158,11,0.5); }
	.ps-switch-thumb {
		position: absolute; top: 1px; left: 1px; width: 16px; height: 16px;
		border-radius: 50%; background: var(--toggle-thumb-off); transition: all 0.2s;
		box-shadow: 0 1px 3px rgba(0,0,0,0.2);
	}
	.ps-switch-on .ps-switch-thumb { left: 17px; background: var(--toggle-thumb); }

	.ps-prot-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
	.ps-prot-field { display: flex; flex-direction: column; gap: 3px; }
	.ps-prot-label { font-size: 9px; color: var(--text-dim); font-family: 'Space Mono', monospace; text-transform: uppercase; letter-spacing: 0.04em; }
	.ps-prot-select {
		padding: 8px 10px; border-radius: 8px;
		background: var(--bg-surface); border: 1px solid var(--border);
		color: var(--text); font-family: 'Space Mono', monospace; font-size: 11px;
		outline: none; appearance: none; cursor: pointer;
		background-image: url("data:image/svg+xml,%3Csvg width='8' height='5' viewBox='0 0 8 5' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l3 3 3-3' stroke='%23475569' fill='none' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E");
		background-repeat: no-repeat; background-position: right 10px center; padding-right: 24px;
	}
	.ps-prot-select option { background: var(--bg); }
	.ps-prot-hint { font-size: 9px; color: var(--text-dim); font-family: 'Space Mono', monospace; line-height: 1.4; opacity: 0.7; }

	@media (max-width: 640px) {
		.ps-prot-grid { grid-template-columns: 1fr 1fr; }
		.ps-prot-grid .ps-prot-field:last-child { grid-column: 1 / -1; }
	}
</style>
