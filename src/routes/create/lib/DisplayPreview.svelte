<script lang="ts">
	let {
		name,
		symbol,
		totalSupply,
		decimals,
		isMintable,
		isTaxable,
		isPartner,
		networkName,
		launchEnabled,
		launchTokensPct,
		launchCurveType,
		launchSoftCap,
		launchHardCap,
		protectionEnabled,
		maxWalletPct,
		maxTransactionPct,
		buyTaxPct,
		sellTaxPct,
		transferTaxPct,
		wizardStep,
		logoUrl = '',
		description = '',
		website = '',
		twitter = '',
		telegram = '',
	}: {
		name: string;
		symbol: string;
		totalSupply: string;
		decimals: number;
		isMintable: boolean;
		isTaxable: boolean;
		isPartner: boolean;
		networkName: string;
		launchEnabled: boolean;
		launchTokensPct: number;
		launchCurveType: number;
		launchSoftCap: string;
		launchHardCap: string;
		protectionEnabled: boolean;
		maxWalletPct: string;
		maxTransactionPct: string;
		buyTaxPct: string;
		sellTaxPct: string;
		transferTaxPct: string;
		wizardStep: string;
		logoUrl?: string;
		description?: string;
		website?: string;
		twitter?: string;
		telegram?: string;
	} = $props();

	let hasMetadata = $derived(description || website || twitter || telegram);

	const CURVE_LABELS = ['Linear', 'Sqrt', 'Quadratic', 'Exponential'];

	let hasBasics = $derived(name.trim() || symbol.trim());
	let hasFeatures = $derived(isMintable || isTaxable || isPartner || launchEnabled);
	let hasTax = $derived(isTaxable && (parseFloat(buyTaxPct) > 0 || parseFloat(sellTaxPct) > 0 || parseFloat(transferTaxPct) > 0));
	let hasProtection = $derived(launchEnabled && protectionEnabled && (maxWalletPct !== '0' || maxTransactionPct !== '0'));

	let supplyFormatted = $derived(() => {
		const n = Number(totalSupply);
		if (!n || isNaN(n)) return '—';
		if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
		if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
		if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
		return n.toLocaleString();
	});
</script>

<div class="preview-card">
	<!-- Token Identity -->
	<div class="token-header">
		{#if logoUrl}
			<img src={logoUrl} alt={symbol} class="token-logo" />
		{:else}
			<div class="token-icon" class:has-name={name.trim()}>
				{symbol ? symbol.slice(0, 3).toUpperCase() : '?'}
			</div>
		{/if}
		<div class="token-identity">
			<div class="token-name syne">{name || 'Token Name'}</div>
			<div class="token-symbol">{symbol ? `$${symbol.toUpperCase()}` : '$SYMBOL'}</div>
		</div>
	</div>

	<!-- Quick Stats -->
	<div class="stats-grid">
		<div class="stat">
			<span class="stat-label">Supply</span>
			<span class="stat-value">{supplyFormatted()}</span>
		</div>
		<div class="stat">
			<span class="stat-label">Decimals</span>
			<span class="stat-value">{decimals}</span>
		</div>
		<div class="stat">
			<span class="stat-label">Network</span>
			<span class="stat-value net">{networkName || '—'}</span>
		</div>
		<div class="stat">
			<span class="stat-label">Type</span>
			<span class="stat-value">
				{#if isPartner && isTaxable}Partner+Tax
				{:else if isPartner}Partner
				{:else if isTaxable && isMintable}Tax+Mint
				{:else if isTaxable}Taxable
				{:else if isMintable}Mintable
				{:else}Standard{/if}
			</span>
		</div>
	</div>

	<!-- Feature Badges -->
	{#if hasFeatures}
		<div class="feature-badges">
			{#if isMintable}<span class="fbadge cyan">Mintable</span>{/if}
			{#if isTaxable}<span class="fbadge amber">Taxable</span>{/if}
			{#if isPartner}<span class="fbadge purple">Partner</span>{/if}
			{#if launchEnabled}<span class="fbadge emerald">Launch</span>{/if}
		</div>
	{/if}

	<!-- Tax Summary -->
	{#if hasTax}
		<div class="detail-section">
			<div class="detail-title">Tax Rates</div>
			<div class="detail-rows">
				{#if parseFloat(buyTaxPct) > 0}
					<div class="detail-row"><span>Buy</span><span class="val">{buyTaxPct}%</span></div>
				{/if}
				{#if parseFloat(sellTaxPct) > 0}
					<div class="detail-row"><span>Sell</span><span class="val">{sellTaxPct}%</span></div>
				{/if}
				{#if parseFloat(transferTaxPct) > 0}
					<div class="detail-row"><span>Transfer</span><span class="val">{transferTaxPct}%</span></div>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Launch Summary -->
	{#if launchEnabled}
		<div class="detail-section">
			<div class="detail-title">Launchpad</div>
			<div class="detail-rows">
				<div class="detail-row"><span>Tokens</span><span class="val">{launchTokensPct}%</span></div>
				<div class="detail-row"><span>Curve</span><span class="val">{CURVE_LABELS[launchCurveType]}</span></div>
				<div class="detail-row"><span>Cap</span><span class="val">{launchSoftCap}–{launchHardCap} USDT</span></div>
			</div>
		</div>
	{/if}

	<!-- Protection Summary -->
	{#if hasProtection}
		<div class="detail-section">
			<div class="detail-title amber">Protection</div>
			<div class="detail-rows">
				{#if maxWalletPct !== '0'}
					<div class="detail-row"><span>Max wallet</span><span class="val amber">{maxWalletPct}%</span></div>
				{/if}
				{#if maxTransactionPct !== '0'}
					<div class="detail-row"><span>Max tx</span><span class="val amber">{maxTransactionPct}%</span></div>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Partner note -->
	{#if isPartner && !isTaxable}
		<div class="partner-note">
			1% platform fee on buys/sells (fixed)
		</div>
	{/if}

	<!-- Metadata -->
	{#if hasMetadata}
		<div class="detail-section">
			{#if description}
				<p class="meta-desc">{description.length > 80 ? description.slice(0, 80) + '...' : description}</p>
			{/if}
			{#if website || twitter || telegram}
				<div class="meta-links">
					{#if website}<span class="meta-link">🌐 Website</span>{/if}
					{#if twitter}<span class="meta-link">𝕏 Twitter</span>{/if}
					{#if telegram}<span class="meta-link">✈ Telegram</span>{/if}
				</div>
			{/if}
		</div>
	{/if}

	<!-- Current step indicator -->
	<div class="step-hint">
		{#if wizardStep === 'basics'}Configure your token's identity
		{:else if wizardStep === 'features'}Choose token capabilities
		{:else if wizardStep === 'tax'}Set tax rates and wallets
		{:else if wizardStep === 'launch'}Configure bonding curve launch
		{/if}
	</div>
</div>

<style>
	.preview-card {
		background: var(--bg-surface);
		border: 1px solid var(--border);
		border-radius: 16px;
		padding: 20px;
		position: sticky;
		top: 80px;
	}

	.token-header {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-bottom: 16px;
		padding-bottom: 16px;
		border-bottom: 1px solid var(--border-subtle);
	}

	.token-icon {
		width: 44px;
		height: 44px;
		border-radius: 12px;
		background: linear-gradient(135deg, rgba(0,210,255,0.15), rgba(58,123,213,0.15));
		border: 1px solid rgba(0,210,255,0.2);
		display: flex;
		align-items: center;
		justify-content: center;
		font-family: 'Syne', sans-serif;
		font-weight: 700;
		font-size: 14px;
		color: #00d2ff;
		flex-shrink: 0;
		transition: all 0.2s;
	}
	.token-icon.has-name {
		background: linear-gradient(135deg, rgba(0,210,255,0.2), rgba(58,123,213,0.2));
	}
	.token-logo {
		width: 44px; height: 44px; border-radius: 12px; object-fit: cover;
		border: 1px solid rgba(0,210,255,0.2); flex-shrink: 0;
	}

	.token-identity { min-width: 0; }
	.token-name {
		font-size: 16px;
		font-weight: 700;
		color: var(--text);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.token-symbol {
		font-size: 12px;
		color: var(--text-muted);
		font-family: 'Space Mono', monospace;
	}

	.stats-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px;
		margin-bottom: 14px;
	}
	.stat {
		padding: 8px 10px;
		background: var(--bg-surface);
		border-radius: 8px;
		border: 1px solid var(--border-subtle);
	}
	.stat-label {
		display: block;
		font-size: 10px;
		color: var(--text-dim);
		font-family: 'Space Mono', monospace;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		margin-bottom: 2px;
	}
	.stat-value {
		display: block;
		font-size: 13px;
		color: var(--text);
		font-family: 'Space Mono', monospace;
		font-weight: 600;
	}
	.stat-value.net { color: #00d2ff; }

	.feature-badges {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		margin-bottom: 14px;
	}
	.fbadge {
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 2px 8px;
		border-radius: 999px;
		font-family: 'Space Mono', monospace;
	}
	.fbadge.cyan { background: rgba(0,210,255,0.1); color: #00d2ff; border: 1px solid rgba(0,210,255,0.2); }
	.fbadge.amber { background: rgba(245,158,11,0.1); color: #f59e0b; border: 1px solid rgba(245,158,11,0.2); }
	.fbadge.purple { background: rgba(139,92,246,0.1); color: #a78bfa; border: 1px solid rgba(139,92,246,0.2); }
	.fbadge.emerald { background: rgba(16,185,129,0.1); color: #10b981; border: 1px solid rgba(16,185,129,0.2); }

	.detail-section {
		margin-bottom: 12px;
		padding: 10px;
		background: var(--bg-surface);
		border-radius: 8px;
		border: 1px solid var(--border-subtle);
	}
	.detail-title {
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-muted);
		font-family: 'Space Mono', monospace;
		margin-bottom: 6px;
	}
	.detail-title.amber { color: #f59e0b; }

	.detail-rows { display: flex; flex-direction: column; gap: 4px; }
	.detail-row {
		display: flex;
		justify-content: space-between;
		font-size: 12px;
		font-family: 'Space Mono', monospace;
		color: var(--text-muted);
	}
	.detail-row .val { color: var(--text); font-weight: 600; }
	.detail-row .val.amber { color: #f59e0b; }

	.partner-note {
		font-size: 11px;
		color: #a78bfa;
		font-family: 'Space Mono', monospace;
		padding: 8px 10px;
		background: rgba(139,92,246,0.06);
		border: 1px solid rgba(139,92,246,0.12);
		border-radius: 8px;
		margin-bottom: 12px;
	}

	.step-hint {
		font-size: 11px;
		color: var(--text-dim);
		font-family: 'Space Mono', monospace;
		text-align: center;
		padding-top: 12px;
		border-top: 1px solid var(--border-subtle);
		margin-top: 4px;
	}

	.meta-desc {
		font-size: 11px; color: var(--text-muted); font-family: 'Space Mono', monospace;
		line-height: 1.5; margin: 0 0 6px;
	}
	.meta-links { display: flex; gap: 6px; flex-wrap: wrap; }
	.meta-link {
		font-size: 9px; padding: 2px 6px; border-radius: 4px;
		background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);
		color: var(--text-dim); font-family: 'Space Mono', monospace;
	}

	.syne { font-family: 'Syne', sans-serif; }
</style>
