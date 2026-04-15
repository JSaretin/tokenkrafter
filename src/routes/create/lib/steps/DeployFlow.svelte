<script lang="ts">
	type DeployStep = {
		id: string;
		label: string;
		status: 'pending' | 'active' | 'done' | 'error' | 'wallet';
		detail?: string;
		error?: string;
	};

	type RequiredBalance = {
		symbol: string;
		required: string;
		breakdown: string;
		status: 'checking' | 'ok' | 'insufficient';
		available?: string;
	};

	let {
		open = false,
		steps = [] as DeployStep[],
		requiredBalances = [] as RequiredBalance[],
		onclose,
	}: {
		open: boolean;
		steps: DeployStep[];
		requiredBalances: RequiredBalance[];
		onclose?: () => void;
	} = $props();

	let allDone = $derived(steps.length > 0 && steps.every((s) => s.status === 'done'));
	let isDeploying = $derived(steps.some((s) => s.status === 'active' || s.status === 'wallet'));
	let hasInsufficient = $derived(requiredBalances.some((b) => b.status === 'insufficient'));
	let copied = $state(false);

	function copyAddress(addr: string) {
		navigator.clipboard.writeText(addr);
		copied = true;
		setTimeout(() => (copied = false), 2000);
	}
</script>

{#if open}
<div class="deploy-backdrop" onclick={() => !isDeploying && onclose?.()} role="dialog" aria-modal="true">
	<div class="deploy-modal" onclick={(e) => e.stopPropagation()}>
		<!-- Header -->
		<div class="deploy-header">
			<h3>{allDone ? 'Token Deployed!' : 'Deploying Your Token'}</h3>
			{#if !isDeploying}
				<button type="button" class="close-btn" onclick={onclose}>
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
				</button>
			{/if}
		</div>

		<div class="deploy-body">
			{#if allDone}
				<div class="success-burst">
					<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
				</div>
			{/if}

			<!-- Required Balances -->
			{#if requiredBalances.length > 0}
				<div class="section-label">Required Balances</div>
				<div class="balances-list">
					{#each requiredBalances as bal}
						<div class="bal-row" class:insufficient={bal.status === 'insufficient'}>
							<div class="bal-main">
								<span class="bal-icon">
									{#if bal.status === 'ok'}<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
									{:else if bal.status === 'insufficient'}<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
									{:else}<span class="check-spinner"></span>{/if}
								</span>
								<span class="bal-symbol">{bal.symbol}:</span>
								<span class="bal-amount">{bal.required}</span>
								<span class="bal-breakdown">({bal.breakdown})</span>
							</div>
							{#if bal.available}
								<div class="bal-avail" class:red={bal.status === 'insufficient'}>
									Available: {bal.available}{#if bal.status === 'insufficient'} — Insufficient!{/if}
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}

			<!-- Insufficient balance: deposit prompt -->
			{#if hasInsufficient}
				{#each requiredBalances.filter((b) => b.status === 'insufficient') as bal}
					<div class="deposit-card">
						<div class="deposit-label">Send <strong>{bal.symbol}</strong> to your wallet</div>
						<div class="qr-placeholder"></div>
						<div class="deposit-actions">
							<button type="button" class="copy-btn" onclick={() => copyAddress('')}>
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
								{copied ? 'Copied!' : 'Copy address'}
							</button>
						</div>
						<div class="network-badge">Only send {bal.symbol} on BSC</div>
						<div class="needed-amount">Need: {bal.required} {bal.symbol}</div>
					</div>
				{/each}
			{/if}

			<!-- Steps -->
			{#if steps.length > 0}
				<div class="section-label">Steps</div>
				<div class="steps-list">
					{#each steps as step}
						<div class="step-row" class:active={step.status === 'active'} class:error={step.status === 'error'}>
							<span class="step-icon">
								{#if step.status === 'done'}
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
								{:else if step.status === 'active'}
									<span class="step-spinner"></span>
								{:else if step.status === 'error'}
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
								{:else if step.status === 'wallet'}
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
								{:else}
									<span class="step-pending">&#9675;</span>
								{/if}
							</span>
							<span class="step-text">
								{step.label}
								{#if step.detail}<span class="step-detail"> — {step.detail}</span>{/if}
							</span>
						</div>
						{#if step.status === 'error' && step.error}
							<div class="step-error">{step.error}</div>
						{/if}
					{/each}
				</div>
			{/if}

			<!-- Footer warning / success -->
			{#if allDone}
				<div class="success-msg">Your token is live on BSC!</div>
			{:else if isDeploying}
				<div class="deploy-warning">
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
					Don't close this window
				</div>
			{/if}
		</div>
	</div>
</div>
{/if}

<style>
	.deploy-backdrop {
		position: fixed; inset: 0; z-index: 100; background: rgba(0,0,0,0.75);
		backdrop-filter: blur(6px); display: flex; align-items: center;
		justify-content: center; padding: 16px;
	}
	.deploy-modal {
		width: 100%; max-width: 440px; background: var(--bg);
		border: 1px solid var(--border); border-radius: 20px; overflow: hidden;
		max-height: 90vh; display: flex; flex-direction: column;
	}
	.deploy-header {
		display: flex; justify-content: space-between; align-items: center;
		padding: 16px 20px; border-bottom: 1px solid var(--border);
	}
	.deploy-header h3 {
		font-family: 'Syne', sans-serif; font-size: 16px; font-weight: 700;
		color: var(--text-heading); margin: 0;
	}
	.close-btn {
		background: none; border: none; color: var(--text-muted); cursor: pointer;
		padding: 4px; border-radius: 8px; transition: all 150ms;
	}
	.close-btn:hover { color: var(--text); background: var(--bg-surface-hover); }
	.deploy-body { padding: 20px; overflow-y: auto; }

	/* Success */
	.success-burst {
		text-align: center; margin-bottom: 12px;
		animation: pop 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
	}
	@keyframes pop { 0% { transform: scale(0); } 100% { transform: scale(1); } }
	.success-msg {
		text-align: center; font-family: 'Syne', sans-serif; font-size: 15px;
		font-weight: 700; color: #10b981; margin-top: 12px;
	}

	/* Section labels */
	.section-label {
		font-family: 'Space Mono', monospace; font-size: 10px; font-weight: 700;
		text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-muted);
		margin-bottom: 8px; margin-top: 16px;
	}
	.section-label:first-child { margin-top: 0; }

	/* Balances */
	.balances-list { display: flex; flex-direction: column; gap: 6px; }
	.bal-row {
		padding: 8px 10px; border-radius: 10px;
		background: var(--bg-surface); border: 1px solid var(--border-subtle);
	}
	.bal-row.insufficient { border-color: rgba(248,113,113,0.3); background: rgba(248,113,113,0.04); }
	.bal-main { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
	.bal-icon { display: flex; align-items: center; flex-shrink: 0; width: 16px; }
	.bal-symbol {
		font-family: 'Syne', sans-serif; font-weight: 700; font-size: 13px; color: var(--text);
	}
	.bal-amount { font-family: 'Space Mono', monospace; font-size: 12px; color: var(--text); }
	.bal-breakdown { font-family: 'Space Mono', monospace; font-size: 11px; color: var(--text-dim); }
	.bal-avail {
		font-family: 'Space Mono', monospace; font-size: 11px; color: var(--text-muted);
		margin-left: 22px; margin-top: 2px;
	}
	.bal-avail.red { color: #f87171; font-weight: 700; }

	/* Deposit card */
	.deposit-card {
		margin-top: 12px; padding: 16px; border-radius: 12px; text-align: center;
		background: var(--bg-surface); border: 1px solid rgba(245,158,11,0.2);
	}
	.deposit-label {
		font-family: 'Space Mono', monospace; font-size: 12px; color: var(--text-muted);
		margin-bottom: 12px;
	}
	.qr-placeholder {
		width: 140px; height: 140px; margin: 0 auto 12px; border-radius: 12px;
		background: var(--bg-surface); border: 1px solid var(--border);
	}
	.deposit-actions { margin-bottom: 8px; }
	.copy-btn {
		display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px;
		border-radius: 8px; border: 1px solid var(--border); background: var(--bg-surface);
		color: var(--text); font-family: 'Space Mono', monospace; font-size: 11px;
		cursor: pointer; transition: all 150ms;
	}
	.copy-btn:hover { background: var(--bg-surface-hover); }
	.network-badge {
		display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 10px;
		font-family: 'Space Mono', monospace; font-weight: 700; text-transform: uppercase;
		letter-spacing: 0.04em; background: rgba(245,158,11,0.1); color: #f59e0b;
		border: 1px solid rgba(245,158,11,0.2); margin-bottom: 6px;
	}
	.needed-amount {
		font-family: 'Syne', sans-serif; font-size: 18px; font-weight: 800;
		color: var(--text-heading); margin-top: 6px;
	}

	/* Steps */
	.steps-list { display: flex; flex-direction: column; gap: 4px; }
	.step-row {
		display: flex; align-items: center; gap: 8px; padding: 7px 10px;
		border-radius: 8px; transition: background 200ms;
	}
	.step-row.active { background: rgba(0,210,255,0.04); animation: pulse 2s ease-in-out infinite; }
	.step-row.error { background: rgba(248,113,113,0.04); }
	@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.7; } }
	.step-icon { display: flex; align-items: center; flex-shrink: 0; width: 16px; }
	.step-pending { color: var(--text-dim); font-size: 14px; line-height: 1; }
	.step-text { font-family: 'Space Mono', monospace; font-size: 12px; color: var(--text); }
	.step-detail { color: var(--text-muted); }
	.step-error {
		font-family: 'Space Mono', monospace; font-size: 11px; color: #f87171;
		padding: 2px 10px 4px 34px;
	}

	/* Spinners */
	.step-spinner, .check-spinner {
		display: inline-block; width: 14px; height: 14px; border: 2px solid var(--border);
		border-top-color: #00d2ff; border-radius: 50%; animation: spin 0.8s linear infinite;
	}
	.check-spinner { width: 12px; height: 12px; border-width: 1.5px; border-top-color: var(--text-muted); }
	@keyframes spin { to { transform: rotate(360deg); } }

	/* Warning */
	.deploy-warning {
		display: flex; align-items: center; justify-content: center; gap: 6px;
		margin-top: 16px; padding: 10px; border-radius: 10px;
		background: rgba(245,158,11,0.06); border: 1px solid rgba(245,158,11,0.15);
		font-family: 'Space Mono', monospace; font-size: 11px; color: #f59e0b;
	}

	@media (max-width: 640px) {
		.deploy-backdrop { padding: 0; }
		.deploy-modal { max-width: 100%; border-radius: 0; max-height: 100vh; height: 100vh; }
	}
</style>
