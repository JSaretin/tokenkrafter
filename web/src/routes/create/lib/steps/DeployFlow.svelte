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
<div
	class="fixed inset-0 z-[100] bg-black/75 backdrop-blur-md flex items-center justify-center p-4 max-sm:p-0"
	onclick={() => !isDeploying && onclose?.()}
	onkeydown={(e) => { if (e.key === 'Escape' && !isDeploying) onclose?.(); }}
	role="dialog"
	aria-modal="true"
	tabindex="-1"
>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="w-full max-w-[440px] bg-background border border-line rounded-[20px] overflow-hidden max-h-[90vh] flex flex-col max-sm:max-w-full max-sm:rounded-none max-sm:max-h-screen max-sm:h-screen" onclick={(e) => e.stopPropagation()}>
		<!-- Header -->
		<div class="flex justify-between items-center px-5 py-4 border-b border-line">
			<h3 class="heading-3">{allDone ? 'Token Deployed!' : 'Deploying Your Token'}</h3>
			{#if !isDeploying}
				<button type="button" aria-label="Close" class="bg-none border-none text-muted cursor-pointer p-1 rounded-lg transition-all duration-150 hover:text-foreground hover:bg-surface-hover" onclick={onclose}>
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
				</button>
			{/if}
		</div>

		<div class="p-5 overflow-y-auto">
			{#if allDone}
				<div class="text-center mb-3 success-burst">
					<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
				</div>
			{/if}

			<!-- Required Balances -->
			{#if requiredBalances.length > 0}
				<div class="font-mono text-3xs font-bold uppercase tracking-[0.1em] text-muted mb-2 mt-4 first:mt-0">Required Balances</div>
				<div class="flex flex-col gap-1.5">
					{#each requiredBalances as bal}
						<div class={'py-2 px-2.5 rounded-[10px] ' + (bal.status === 'insufficient' ? 'border border-[rgba(248,113,113,0.3)] bg-[rgba(248,113,113,0.04)]' : 'bg-surface border border-line-subtle')}>
							<div class="flex items-center gap-1.5 flex-wrap">
								<span class="flex items-center shrink-0 w-4">
									{#if bal.status === 'ok'}<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
									{:else if bal.status === 'insufficient'}<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
									{:else}<span class="inline-block w-3 h-3 border-[1.5px] border-line border-t-muted rounded-full animate-spin"></span>{/if}
								</span>
								<span class="font-display font-bold text-13 text-foreground">{bal.symbol}:</span>
								<span class="font-mono text-xs text-foreground">{bal.required}</span>
								<span class="font-mono text-xs2 text-dim">({bal.breakdown})</span>
							</div>
							{#if bal.available}
								<div class={'font-mono text-xs2 ml-[22px] mt-0.5 ' + (bal.status === 'insufficient' ? 'text-[#f87171] font-bold' : 'text-muted')}>
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
					<div class="mt-3 p-4 rounded-xl text-center bg-surface border border-[rgba(245,158,11,0.2)]">
						<div class="font-mono text-xs text-muted mb-3">Send <strong>{bal.symbol}</strong> to your wallet</div>
						<div class="w-[140px] h-[140px] mx-auto mb-3 rounded-xl bg-surface border border-line"></div>
						<div class="mb-2">
							<button type="button" class="inline-flex items-center gap-1.5 py-1.5 px-3.5 rounded-lg border border-line bg-surface text-foreground font-mono text-xs2 cursor-pointer transition-all duration-150 hover:bg-surface-hover" onclick={() => copyAddress('')}>
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
								{copied ? 'Copied!' : 'Copy address'}
							</button>
						</div>
						<div class="inline-block py-[3px] px-2.5 rounded-full text-3xs font-mono font-bold uppercase tracking-[0.04em] bg-[rgba(245,158,11,0.1)] text-[#f59e0b] border border-[rgba(245,158,11,0.2)] mb-1.5">Only send {bal.symbol} on BSC</div>
						<div class="font-display text-lg font-extrabold text-heading mt-1.5">Need: {bal.required} {bal.symbol}</div>
					</div>
				{/each}
			{/if}

			<!-- Steps -->
			{#if steps.length > 0}
				<div class="font-mono text-3xs font-bold uppercase tracking-[0.1em] text-muted mb-2 mt-4 first:mt-0">Steps</div>
				<div class="flex flex-col gap-1">
					{#each steps as step}
						<div class={'flex items-center gap-2 py-[7px] px-2.5 rounded-lg transition-colors duration-200 ' + (step.status === 'active' ? 'bg-[rgba(0,210,255,0.04)] step-pulse ' : '') + (step.status === 'error' ? 'bg-[rgba(248,113,113,0.04)]' : '')}>
							<span class="flex items-center shrink-0 w-4">
								{#if step.status === 'done'}
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
								{:else if step.status === 'active'}
									<span class="inline-block w-[14px] h-[14px] border-2 border-line border-t-[#00d2ff] rounded-full animate-spin"></span>
								{:else if step.status === 'error'}
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
								{:else if step.status === 'wallet'}
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
								{:else}
									<span class="text-dim text-sm leading-none">&#9675;</span>
								{/if}
							</span>
							<span class="font-mono text-xs text-foreground">
								{step.label}
								{#if step.detail}<span class="text-muted"> — {step.detail}</span>{/if}
							</span>
						</div>
						{#if step.status === 'error' && step.error}
							<div class="font-mono text-xs2 text-[#f87171] pt-0.5 pr-2.5 pb-1 pl-[34px]">{step.error}</div>
						{/if}
					{/each}
				</div>
			{/if}

			<!-- Footer warning / success -->
			{#if allDone}
				<div class="text-center font-display text-15 font-bold text-[#10b981] mt-3">Your token is live on BSC!</div>
			{:else if isDeploying}
				<div class="flex items-center justify-center gap-1.5 mt-4 p-2.5 rounded-[10px] bg-[rgba(245,158,11,0.06)] border border-[rgba(245,158,11,0.15)] font-mono text-xs2 text-[#f59e0b]">
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
					Don't close this window
				</div>
			{/if}
		</div>
	</div>
</div>
{/if}

<style>
	.success-burst {
		animation: pop 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
	}
	@keyframes pop { 0% { transform: scale(0); } 100% { transform: scale(1); } }
	.step-pulse { animation: pulse 2s ease-in-out infinite; }
	@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.7; } }
</style>
