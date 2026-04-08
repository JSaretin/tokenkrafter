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
	let sharesValid = $derived(Math.abs(totalShares - 100) < 0.01);

	let taxParts = $derived(
		[num(buyTaxPct) > 0 && `buy ${num(buyTaxPct)}%`, num(sellTaxPct) > 0 && `sell ${num(sellTaxPct)}%`, num(transferTaxPct) > 0 && `transfer ${num(transferTaxPct)}%`].filter(Boolean).join(' + ')
	);

	function addWallet() {
		if (taxWallets.length < 10) taxWallets = [...taxWallets, { address: '', sharePct: '' }];
	}
	function removeWallet(i: number) {
		taxWallets = taxWallets.filter((_, idx) => idx !== i);
	}
</script>

<div class="tax-config">
	<!-- Tax Rates -->
	<div class="section">
		<h3 class="heading">Tax Rates</h3>
		<div class="tax-cards">
			<div class="tax-card" class:tax-active={num(buyTaxPct) > 0}>
				<div class="tax-card-head">
					<span class="tax-card-icon">B</span>
					<span class="tax-card-label">Buy Tax</span>
				</div>
				<div class="tax-card-input">
					<input id="tc-buy" type="number" class="tax-input" bind:value={buyTaxPct} min="0" max="10" step="0.5" placeholder="0" />
					<span class="tax-unit">%</span>
				</div>
				<div class="tax-card-bar"><div class="tax-card-fill tax-fill-cyan" style="width: {Math.min(100, num(buyTaxPct) * 10)}%"></div></div>
			</div>

			<div class="tax-card" class:tax-active={num(sellTaxPct) > 0}>
				<div class="tax-card-head">
					<span class="tax-card-icon tax-icon-amber">S</span>
					<span class="tax-card-label">Sell Tax</span>
				</div>
				<div class="tax-card-input">
					<input id="tc-sell" type="number" class="tax-input" bind:value={sellTaxPct} min="0" max="10" step="0.5" placeholder="0" />
					<span class="tax-unit">%</span>
				</div>
				<div class="tax-card-bar"><div class="tax-card-fill tax-fill-amber" style="width: {Math.min(100, num(sellTaxPct) * 10)}%"></div></div>
			</div>

			<div class="tax-card" class:tax-active={num(transferTaxPct) > 0}>
				<div class="tax-card-head">
					<span class="tax-card-icon tax-icon-purple">T</span>
					<span class="tax-card-label">Transfer</span>
				</div>
				<div class="tax-card-input">
					<input id="tc-transfer" type="number" class="tax-input" bind:value={transferTaxPct} min="0" max="10" step="0.5" placeholder="0" />
					<span class="tax-unit">%</span>
				</div>
				<div class="tax-card-bar"><div class="tax-card-fill tax-fill-purple" style="width: {Math.min(100, num(transferTaxPct) * 10)}%"></div></div>
			</div>
		</div>

		{#if totalTax > 0}
			<div class="tax-total">
				<span class="total-label">Total:</span>
				<span class="total-value" class:over={totalTax > 25}>{totalTax}%</span>
				<span class="total-detail">({taxParts})</span>
				{#if totalTax > 25}<span class="total-warn">Max 25%</span>{/if}
			</div>
		{/if}
	</div>

	<!-- Tax Wallets -->
	{#if totalTax > 0}
		<div class="section">
			<h3 class="heading">Tax Wallets</h3>
			<div class="wallets">
				{#each taxWallets as wallet, i}
					<div class="wallet-row">
						<input
							class="input-field wallet-addr"
							bind:value={wallet.address}
							placeholder="0x... wallet address"
						/>
						<div class="share-wrap">
							<input
								class="input-field share-input"
								type="number"
								bind:value={wallet.sharePct}
								placeholder="50"
								min="1" max="100" step="1"
							/>
							<span class="share-pct">%</span>
						</div>
						{#if taxWallets.length > 1}
							<button type="button" class="rm-btn" tabindex="-1" onclick={() => removeWallet(i)}>x</button>
						{/if}
					</div>
				{/each}
			</div>
			{#if taxWallets.length < 10}
				<button type="button" class="add-btn" tabindex="-1" onclick={addWallet}>+ Add wallet</button>
			{/if}
			{#if !sharesValid}
				<span class="warn">Shares total {totalShares}% -- must equal 100%</span>
			{/if}
		</div>
	{/if}

	<!-- Anti-Whale Protection -->
	<div class="section">
		<button class="toggle-card" class:on={protectionEnabled} onclick={() => protectionEnabled = !protectionEnabled}>
			<div class="toggle-info">
				<span class="toggle-label">Anti-Whale Protection</span>
				<span class="toggle-desc">Limit max wallet & transaction size</span>
			</div>
			<span class="toggle" class:on={protectionEnabled}><span class="knob"></span></span>
		</button>

		{#if protectionEnabled}
			<div class="prot-fields">
				<div class="field-group">
					<label class="label-text" for="tc-maxwallet">Max Wallet %</label>
					<select id="tc-maxwallet" class="input-field" bind:value={maxWalletPct}>
						<option value="0">No limit</option>
						<option value="1">1%</option>
						<option value="2">2%</option>
						<option value="3">3%</option>
						<option value="5">5%</option>
						<option value="10">10%</option>
					</select>
				</div>
				<div class="field-group">
					<label class="label-text" for="tc-maxtx">Max Transaction %</label>
					<select id="tc-maxtx" class="input-field" bind:value={maxTransactionPct}>
						<option value="0">No limit</option>
						<option value="0.5">0.5%</option>
						<option value="1">1%</option>
						<option value="2">2%</option>
						<option value="3">3%</option>
						<option value="5">5%</option>
					</select>
				</div>
				<div class="field-group">
					<label class="label-text" for="tc-cool">Cooldown</label>
					<select id="tc-cool" class="input-field" bind:value={cooldownSeconds}>
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
	.tax-config { display: flex; flex-direction: column; gap: 1.25rem; }
	.section { display: flex; flex-direction: column; gap: 0.75rem; }
	.heading { font-family: 'Syne', sans-serif; font-size: 0.85rem; color: rgba(255,255,255,0.5); text-transform: uppercase; letter-spacing: 0.08em; margin: 0; }
	.field-group { display: flex; flex-direction: column; gap: 4px; }
	.tax-cards { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0.6rem; }
	.tax-card {
		padding: 12px; border-radius: 10px;
		background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05);
		transition: border-color 0.15s;
	}
	.tax-card.tax-active { border-color: rgba(0,210,255,0.2); }
	.tax-card-head { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
	.tax-card-icon {
		width: 20px; height: 20px; border-radius: 5px; display: flex; align-items: center; justify-content: center;
		font-family: 'Syne', sans-serif; font-size: 9px; font-weight: 800;
		background: rgba(0,210,255,0.1); color: #00d2ff; flex-shrink: 0;
	}
	.tax-icon-amber { background: rgba(245,158,11,0.1); color: #f59e0b; }
	.tax-icon-purple { background: rgba(139,92,246,0.1); color: #a78bfa; }
	.tax-card-label { font-size: 10px; color: rgba(255,255,255,0.4); font-family: 'Space Mono', monospace; }
	.tax-card-input { display: flex; align-items: center; gap: 2px; margin-bottom: 6px; }
	.tax-input {
		width: 100%; background: transparent; border: none; outline: none;
		font-family: 'Rajdhani', sans-serif; font-size: 24px; font-weight: 700;
		color: #fff; font-variant-numeric: tabular-nums; padding: 0;
	}
	.tax-input::placeholder { color: rgba(255,255,255,0.1); }
	.tax-unit { font-family: 'Space Mono', monospace; font-size: 12px; color: rgba(255,255,255,0.2); }
	.tax-card-bar { height: 3px; border-radius: 2px; background: rgba(255,255,255,0.04); overflow: hidden; }
	.tax-card-fill { height: 100%; border-radius: 2px; transition: width 0.2s; }
	.tax-fill-cyan { background: #00d2ff; }
	.tax-fill-amber { background: #f59e0b; }
	.tax-fill-purple { background: #a78bfa; }
	@media (max-width: 500px) { .tax-cards { grid-template-columns: 1fr; } }
	.prot-fields { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0.75rem; }
	.tax-total { display: flex; align-items: center; gap: 6px; padding: 8px 12px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 8px; flex-wrap: wrap; }
	.total-label, .total-detail { font-family: 'Space Mono', monospace; color: rgba(255,255,255,0.35); }
	.total-label { font-size: 0.7rem; color: rgba(255,255,255,0.4); }
	.total-detail { font-size: 0.65rem; }
	.total-value { font-size: 0.85rem; color: #fff; font-family: 'Space Mono', monospace; font-weight: 700; }
	.total-value.over { color: #f87171; }
	.total-warn { font-size: 0.65rem; color: #f87171; font-family: 'Space Mono', monospace; margin-left: auto; }
	.wallets { display: flex; flex-direction: column; gap: 0.5rem; }
	.wallet-row { display: flex; gap: 6px; align-items: center; }
	.wallet-addr { flex: 1; font-size: 12px !important; }
	.share-wrap { position: relative; width: 80px; flex-shrink: 0; }
	.share-input { width: 100%; padding-right: 24px !important; text-align: right; }
	.share-pct { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); font-size: 11px; color: rgba(255,255,255,0.3); pointer-events: none; font-family: 'Space Mono', monospace; }
	.rm-btn { width: 28px; height: 28px; border-radius: 6px; background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.2); color: #ef4444; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 12px; flex-shrink: 0; transition: all 0.15s; }
	.rm-btn:hover { background: rgba(239,68,68,0.2); }
	.add-btn { padding: 8px 14px; border-radius: 8px; background: rgba(255,255,255,0.03); border: 1px dashed rgba(255,255,255,0.1); color: rgba(255,255,255,0.35); font-family: 'Space Mono', monospace; font-size: 12px; cursor: pointer; transition: all 0.15s; }
	.add-btn:hover { border-color: rgba(0,210,255,0.3); color: #00d2ff; }
	.warn { font-size: 0.7rem; color: #fbbf24; font-family: 'Space Mono', monospace; }
	.toggle-card { display: flex; align-items: center; justify-content: space-between; padding: 0.75rem 1rem; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; cursor: pointer; transition: border-color 0.2s; font-family: inherit; color: inherit; text-align: left; }
	.toggle-card:hover { border-color: rgba(0,210,255,0.2); }
	.toggle-card.on { border-color: rgba(245,158,11,0.35); background: rgba(245,158,11,0.04); }
	.toggle-info { display: flex; flex-direction: column; gap: 2px; }
	.toggle-label { font-family: 'Syne', sans-serif; font-size: 0.82rem; font-weight: 600; color: rgba(255,255,255,0.9); }
	.toggle-desc { font-size: 0.65rem; color: rgba(255,255,255,0.3); }
	.toggle { width: 36px; height: 20px; border-radius: 10px; background: rgba(255,255,255,0.1); position: relative; flex-shrink: 0; transition: background 0.2s; }
	.toggle.on { background: rgba(245,158,11,0.5); }
	.knob { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: rgba(255,255,255,0.5); transition: all 0.2s; }
	.toggle.on .knob { left: 18px; background: #fbbf24; }
	@media (max-width: 640px) {
		.prot-fields { grid-template-columns: 1fr 1fr; gap: 0.5rem; }
		.prot-fields .field-group:last-child { grid-column: 1 / -1; }
		.wallet-row { flex-wrap: wrap; }
		.wallet-addr { min-width: 0; flex-basis: 100%; }
		.share-wrap { width: 70px; }
	}
</style>
