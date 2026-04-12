<script lang="ts">
	let {
		buyTaxPct = $bindable(''),
		sellTaxPct = $bindable(''),
		transferTaxPct = $bindable(''),
		taxWallets = $bindable([{ address: '', sharePct: '100' }]),
		protectionEnabled = $bindable(false),
		maxWalletPct = $bindable('2'),
		maxTransactionPct = $bindable('1'),
		cooldownSeconds = $bindable('0'),
	}: {
		buyTaxPct: string;
		sellTaxPct: string;
		transferTaxPct: string;
		taxWallets: { address: string; sharePct: string }[];
		protectionEnabled: boolean;
		maxWalletPct: string;
		maxTransactionPct: string;
		cooldownSeconds: string;
	} = $props();

	const num = (v: string) => parseFloat(v) || 0;
	let totalTax = $derived(num(buyTaxPct) + num(sellTaxPct) + num(transferTaxPct));
	let totalShares = $derived(taxWallets.reduce((s, w) => s + num(w.sharePct), 0));
	let sharesValid = $derived(totalShares <= 100 && totalShares > 0);
	let sharesBurned = $derived(100 - totalShares);
	let hasValidWallet = $derived(taxWallets.some(w => w.address.trim() && /^0x[a-fA-F0-9]{40}$/.test(w.address.trim())));
	let taxWithoutWallet = $derived(totalTax > 0 && !hasValidWallet);

	// Per-tax limits (from contract). 4/4/2 for plain taxable. Partner-
	// taxable tokens have 3.5/3.5/2 but the wizard doesn't differentiate
	// at this step — the contract enforces the tighter cap at setTaxes time.
	const MAX_BUY = 4;
	const MAX_SELL = 4;
	const MAX_TRANSFER = 2;
	const MAX_TOTAL = 10;
	let buyOver = $derived(num(buyTaxPct) > MAX_BUY);
	let sellOver = $derived(num(sellTaxPct) > MAX_SELL);
	let transferOver = $derived(num(transferTaxPct) > MAX_TRANSFER);

	const presets = [0, 1, 2, 3, 4];

	function addWallet() {
		if (taxWallets.length < 10) taxWallets = [...taxWallets, { address: '', sharePct: '' }];
	}
	function removeWallet(i: number) {
		taxWallets = taxWallets.filter((_, idx) => idx !== i);
	}
</script>

<div class="tc">
	<!-- Tax Rate Rows -->
	<div class="tc-rates">
		<!-- Buy -->
		<div class="tc-rate" class:tc-rate-error={buyOver}>
			<div class="tc-rate-left">
				<span class="tc-dot tc-dot-buy"></span>
				<span class="tc-rate-name">Buy Tax</span>
				{#if buyOver}<span class="tc-limit-warn">max {MAX_BUY}%</span>{/if}
			</div>
			<div class="tc-rate-right">
				<div class="tc-presets">
					{#each presets as p}
						<button class="tc-preset" class:active={num(buyTaxPct) === p} onclick={() => buyTaxPct = String(p)}>{p}%</button>
					{/each}
				</div>
				<div class="tc-rate-input-wrap" class:tc-input-error={buyOver}>
					<input class="tc-rate-input" type="text" inputmode="decimal" bind:value={buyTaxPct} placeholder="0" />
					<span class="tc-pct">%</span>
				</div>
			</div>
		</div>

		<!-- Sell -->
		<div class="tc-rate" class:tc-rate-error={sellOver}>
			<div class="tc-rate-left">
				<span class="tc-dot tc-dot-sell"></span>
				<span class="tc-rate-name">Sell Tax</span>
				{#if sellOver}<span class="tc-limit-warn">max {MAX_SELL}%</span>{/if}
			</div>
			<div class="tc-rate-right">
				<div class="tc-presets">
					{#each presets as p}
						<button class="tc-preset" class:active={num(sellTaxPct) === p} onclick={() => sellTaxPct = String(p)}>{p}%</button>
					{/each}
				</div>
				<div class="tc-rate-input-wrap" class:tc-input-error={sellOver}>
					<input class="tc-rate-input" type="text" inputmode="decimal" bind:value={sellTaxPct} placeholder="0" />
					<span class="tc-pct">%</span>
				</div>
			</div>
		</div>

		<!-- Transfer -->
		<div class="tc-rate" class:tc-rate-error={transferOver}>
			<div class="tc-rate-left">
				<span class="tc-dot tc-dot-transfer"></span>
				<span class="tc-rate-name">Transfer Tax</span>
				{#if transferOver}<span class="tc-limit-warn">max {MAX_TRANSFER}%</span>{/if}
			</div>
			<div class="tc-rate-right">
				<div class="tc-presets">
					{#each presets.filter(p => p <= MAX_TRANSFER) as p}
						<button class="tc-preset" class:active={num(transferTaxPct) === p} onclick={() => transferTaxPct = String(p)}>{p}%</button>
					{/each}
				</div>
				<div class="tc-rate-input-wrap" class:tc-input-error={transferOver}>
					<input class="tc-rate-input" type="text" inputmode="decimal" bind:value={transferTaxPct} placeholder="0" />
					<span class="tc-pct">%</span>
				</div>
			</div>
		</div>
	</div>

	<!-- Total bar -->
	{#if totalTax > 0}
		<div class="tc-total-bar">
			<div class="tc-total-segments">
				{#if num(buyTaxPct) > 0}<div class="tc-seg tc-seg-buy" style="width: {(num(buyTaxPct) / MAX_TOTAL) * 100}%"></div>{/if}
				{#if num(sellTaxPct) > 0}<div class="tc-seg tc-seg-sell" style="width: {(num(sellTaxPct) / MAX_TOTAL) * 100}%"></div>{/if}
				{#if num(transferTaxPct) > 0}<div class="tc-seg tc-seg-transfer" style="width: {(num(transferTaxPct) / MAX_TOTAL) * 100}%"></div>{/if}
			</div>
			<div class="tc-total-info">
				<span class="tc-total-val" class:tc-over={totalTax > MAX_TOTAL || buyOver || sellOver || transferOver}>{totalTax}% total</span>
				{#if totalTax > MAX_TOTAL}<span class="tc-total-warn">Max {MAX_TOTAL}%</span>{/if}
			</div>
		</div>
	{/if}

	<!-- Tax Wallets -->
	{#if totalTax > 0}
		<div class="tc-section">
			<div class="tc-section-head">
				<span class="tc-section-title">Revenue Wallets</span>
				<span class="tc-section-hint">Where collected tax goes</span>
			</div>
			{#each taxWallets as wallet, i}
				<div class="tc-wallet">
					<input class="tc-wallet-addr" bind:value={wallet.address} placeholder="0x... wallet address" />
					<div class="tc-wallet-share">
						<input class="tc-wallet-pct" type="text" inputmode="numeric" bind:value={wallet.sharePct} placeholder="100" />
						<span class="tc-wallet-pct-sign">%</span>
					</div>
					{#if taxWallets.length > 1}
						<button class="tc-wallet-rm" onclick={() => removeWallet(i)}>
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
						</button>
					{/if}
				</div>
			{/each}
			<div class="tc-wallet-footer">
				{#if taxWallets.length < 10}
					<button class="tc-wallet-add" onclick={addWallet}>+ Add wallet</button>
				{/if}
				{#if totalShares > 100}
					<span class="tc-wallet-warn">Shares total {totalShares}% — max 100%</span>
				{:else if sharesBurned > 0 && totalShares > 0}
					<span class="tc-wallet-burn">{sharesBurned}% will be burned</span>
				{/if}
			</div>
			{#if taxWithoutWallet}
				<div class="tc-burn-warning">
					No valid wallet address set. All collected tax ({totalTax}%) will be permanently burned (sent to address zero) on every trade.
				</div>
			{/if}
		</div>
	{/if}

	<!-- Anti-Whale Protection -->
	<div class="tc-section">
		<button class="tc-toggle" class:tc-toggle-on={protectionEnabled} onclick={() => protectionEnabled = !protectionEnabled}>
			<div>
				<span class="tc-toggle-title">Anti-Whale Protection</span>
				<span class="tc-toggle-desc">Limit max wallet & transaction size</span>
			</div>
			<div class="tc-switch" class:tc-switch-on={protectionEnabled}><div class="tc-switch-thumb"></div></div>
		</button>

		{#if protectionEnabled}
			<div class="tc-prot-grid">
				<div class="tc-prot-field">
					<label class="tc-prot-label" for="tc-mw">Max Wallet</label>
					<select id="tc-mw" class="tc-prot-select" bind:value={maxWalletPct}>
						<option value="0">No limit</option>
						<option value="1">1% of supply</option>
						<option value="2">2% of supply</option>
						<option value="3">3% of supply</option>
						<option value="5">5% of supply</option>
						<option value="10">10% of supply</option>
					</select>
				</div>
				<div class="tc-prot-field">
					<label class="tc-prot-label" for="tc-mt">Max Transaction</label>
					<select id="tc-mt" class="tc-prot-select" bind:value={maxTransactionPct}>
						<option value="0">No limit</option>
						<option value="0.5">0.5% of supply</option>
						<option value="1">1% of supply</option>
						<option value="2">2% of supply</option>
						<option value="3">3% of supply</option>
						<option value="5">5% of supply</option>
					</select>
				</div>
				<div class="tc-prot-field">
					<label class="tc-prot-label" for="tc-cd">Cooldown</label>
					<select id="tc-cd" class="tc-prot-select" bind:value={cooldownSeconds}>
						<option value="0">Disabled</option>
						<option value="30">30 seconds</option>
						<option value="60">1 minute</option>
						<option value="300">5 minutes</option>
					</select>
				</div>
			</div>
		{/if}
	</div>
</div>

<style>
	.tc { display: flex; flex-direction: column; gap: 16px; }

	/* ── Tax Rate Rows ── */
	.tc-rates { display: flex; flex-direction: column; gap: 8px; }
	.tc-rate {
		display: flex; align-items: center; justify-content: space-between; gap: 12px;
		padding: 12px 14px; border-radius: 10px;
		background: var(--bg-surface); border: 1px solid var(--border-subtle);
	}
	.tc-rate-left { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
	.tc-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
	.tc-dot-buy { background: #00d2ff; }
	.tc-dot-sell { background: #f59e0b; }
	.tc-dot-transfer { background: #a78bfa; }
	.tc-rate-name { font-family: 'Syne', sans-serif; font-size: 13px; font-weight: 600; color: var(--text); }
	.tc-rate-right { display: flex; align-items: center; gap: 8px; }
	.tc-presets { display: flex; gap: 3px; }
	.tc-preset {
		padding: 3px 8px; border-radius: 6px; border: 1px solid var(--border-subtle);
		background: transparent; color: var(--text-dim); font-family: 'Space Mono', monospace;
		font-size: 9px; cursor: pointer; transition: all 0.1s;
	}
	.tc-preset:hover { color: var(--text-muted); border-color: var(--border-input); }
	.tc-preset.active { color: #00d2ff; border-color: rgba(0,210,255,0.3); background: rgba(0,210,255,0.06); }
	.tc-rate-input-wrap {
		display: flex; align-items: center; gap: 1px;
		width: 56px; padding: 4px 8px; border-radius: 6px;
		background: var(--bg-surface-input); border: 1px solid var(--border);
	}
	.tc-rate-input {
		width: 100%; background: transparent; border: none; outline: none;
		font-family: 'Rajdhani', sans-serif; font-size: 16px; font-weight: 700;
		color: var(--text-heading); font-variant-numeric: tabular-nums; text-align: right; padding: 0;
	}
	.tc-rate-input::placeholder { color: var(--placeholder); }
	.tc-pct { font-family: 'Space Mono', monospace; font-size: 10px; color: var(--text-dim); }

	@media (max-width: 500px) {
		.tc-presets { display: none; }
		.tc-rate { padding: 10px 12px; }
	}

	/* ── Total Bar ── */
	.tc-total-bar { padding: 0 2px; }
	.tc-total-segments {
		display: flex; height: 4px; border-radius: 2px; overflow: hidden;
		background: var(--bg-surface-input); gap: 1px;
	}
	.tc-seg { height: 100%; border-radius: 2px; transition: width 0.2s; }
	.tc-seg-buy { background: #00d2ff; }
	.tc-seg-sell { background: #f59e0b; }
	.tc-seg-transfer { background: #a78bfa; }
	.tc-total-info { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
	.tc-total-val { font-family: 'Space Mono', monospace; font-size: 10px; color: var(--text-dim); }
	.tc-total-val.tc-over { color: #f87171; }
	.tc-total-warn { font-size: 9px; color: #f87171; font-family: 'Space Mono', monospace; }

	/* ── Sections ── */
	.tc-section { display: flex; flex-direction: column; gap: 8px; }
	.tc-section-head { display: flex; align-items: baseline; gap: 8px; }
	.tc-section-title { font-family: 'Syne', sans-serif; font-size: 13px; font-weight: 700; color: var(--text-muted); }
	.tc-section-hint { font-size: 10px; color: var(--text-dim); font-family: 'Space Mono', monospace; }

	/* ── Wallets ── */
	.tc-wallet {
		display: flex; align-items: center; gap: 6px;
		padding: 8px 10px; border-radius: 8px;
		background: var(--bg-surface); border: 1px solid var(--border-subtle);
	}
	.tc-wallet-addr {
		flex: 1; min-width: 0; background: transparent; border: none; outline: none;
		font-family: 'Space Mono', monospace; font-size: 11px; color: var(--text); padding: 0;
	}
	.tc-wallet-addr::placeholder { color: var(--text-dim); }
	.tc-wallet-share {
		display: flex; align-items: center; gap: 1px; width: 52px; flex-shrink: 0;
		padding: 2px 6px; border-radius: 4px; background: var(--bg-surface-input);
	}
	.tc-wallet-pct {
		width: 100%; background: transparent; border: none; outline: none;
		font-family: 'Rajdhani', sans-serif; font-size: 14px; font-weight: 600;
		color: var(--text-heading); text-align: right; padding: 0;
	}
	.tc-wallet-pct-sign { font-size: 10px; color: var(--text-dim); font-family: 'Space Mono', monospace; }
	.tc-wallet-rm {
		width: 24px; height: 24px; border-radius: 6px; border: none;
		background: rgba(248,113,113,0.08); color: #f87171; cursor: pointer;
		display: flex; align-items: center; justify-content: center;
		flex-shrink: 0; transition: background 0.12s;
	}
	.tc-wallet-rm:hover { background: rgba(248,113,113,0.15); }
	.tc-wallet-footer { display: flex; align-items: center; gap: 10px; }
	.tc-wallet-add {
		padding: 6px 12px; border-radius: 6px; border: 1px dashed var(--border);
		background: transparent; color: var(--text-dim); font-family: 'Space Mono', monospace;
		font-size: 10px; cursor: pointer; transition: all 0.12s;
	}
	.tc-wallet-add:hover { color: #00d2ff; border-color: rgba(0,210,255,0.2); }
	.tc-wallet-warn { font-size: 10px; color: #f87171; font-family: 'Space Mono', monospace; }
	.tc-wallet-burn { font-size: 10px; color: var(--text-dim); font-family: 'Space Mono', monospace; }
	.tc-burn-warning { margin-top: 10px; padding: 8px 10px; border-radius: 8px; background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.2); color: #fbbf24; font-size: 11px; font-family: 'Space Mono', monospace; line-height: 1.5; }
	.tc-rate-error { border-color: rgba(248,113,113,0.25); }
	.tc-input-error { border-color: rgba(248,113,113,0.4); }
	.tc-input-error .tc-rate-input { color: #f87171; }
	.tc-limit-warn { font-size: 9px; color: #f87171; font-family: 'Space Mono', monospace; margin-left: auto; }

	@media (max-width: 500px) {
		.tc-wallet { flex-wrap: wrap; }
		.tc-wallet-addr { flex-basis: 100%; font-size: 10px; }
	}

	/* ── Toggle ── */
	.tc-toggle {
		display: flex; align-items: center; justify-content: space-between; gap: 12px;
		padding: 12px 14px; border-radius: 10px;
		background: var(--bg-surface); border: 1px solid var(--border-subtle);
		cursor: pointer; font-family: inherit; color: inherit; text-align: left;
		transition: border-color 0.15s;
	}
	.tc-toggle:hover { border-color: var(--border); }
	.tc-toggle-on { border-color: rgba(245,158,11,0.25); background: rgba(245,158,11,0.03); }
	.tc-toggle-title { display: block; font-family: 'Syne', sans-serif; font-size: 13px; font-weight: 600; color: var(--text); }
	.tc-toggle-desc { display: block; font-size: 10px; color: var(--text-dim); font-family: 'Space Mono', monospace; margin-top: 1px; }
	.tc-switch {
		width: 36px; height: 20px; border-radius: 10px; background: var(--bg-surface-hover);
		position: relative; flex-shrink: 0; transition: background 0.2s;
	}
	.tc-switch-on { background: #f59e0b; }
	.tc-switch-thumb {
		position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
		border-radius: 50%; background: rgba(255,255,255,0.6); transition: all 0.2s;
	}
	.tc-switch-on .tc-switch-thumb { left: 18px; background: #fff; }

	/* ── Protection Grid ── */
	.tc-prot-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
	.tc-prot-field { display: flex; flex-direction: column; gap: 3px; }
	.tc-prot-label { font-size: 9px; color: var(--text-dim); font-family: 'Space Mono', monospace; text-transform: uppercase; letter-spacing: 0.04em; }
	.tc-prot-select {
		padding: 8px 10px; border-radius: 8px;
		background: var(--bg-surface); border: 1px solid var(--border);
		color: var(--text); font-family: 'Space Mono', monospace; font-size: 11px;
		outline: none; appearance: none; cursor: pointer;
		background-image: url("data:image/svg+xml,%3Csvg width='8' height='5' viewBox='0 0 8 5' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l3 3 3-3' stroke='%23475569' fill='none' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E");
		background-repeat: no-repeat; background-position: right 10px center; padding-right: 24px;
	}
	.tc-prot-select option { background: var(--bg); }

	@media (max-width: 640px) {
		.tc-prot-grid { grid-template-columns: 1fr 1fr; }
		.tc-prot-grid .tc-prot-field:last-child { grid-column: 1 / -1; }
	}
</style>
