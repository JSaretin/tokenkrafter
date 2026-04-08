<script lang="ts">
	import { t } from '$lib/i18n';

	let {
		deployMode = $bindable(null as 'token' | 'launch' | 'both' | 'list' | null),
	}: {
		deployMode: 'token' | 'launch' | 'both' | 'list' | null;
	} = $props();
</script>

<div class="mode-select">
	<div class="text-center mb-6">
		<h3 class="syne text-xl font-bold text-white mb-1">{$t('ci.pageTitle')}</h3>
		<p class="text-gray-500 font-mono text-xs">{$t('ci.pageSub')}</p>
	</div>

	<div class="intent-grid">
		<button class="intent-card" class:active={deployMode === 'token'} onclick={() => deployMode = 'token'}>
			<div class="intent-icon cyan">
				<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v12M6 12h12"/></svg>
			</div>
			<h3 class="syne text-sm font-bold text-white mt-3 mb-0.5">{$t('ci.createToken')}</h3>
			<p class="text-gray-400 font-mono text-[11px] leading-snug">{$t('ci.createTokenSub')}</p>
		</button>

		<button class="intent-card featured" class:active={deployMode === 'both'} onclick={() => deployMode = 'both'}>
			<span class="badge badge-cyan badge-top">{$t('ci.recommended')}</span>
			<div class="intent-icon cyan">
				<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
			</div>
			<h3 class="syne text-base font-bold text-white mt-3 mb-0.5">{$t('ci.createAndLaunch')}</h3>
			<p class="text-gray-500 font-mono text-[11px] leading-snug">{$t('ci.createAndLaunchSub')}</p>
		</button>

		<button class="intent-card" class:active={deployMode === 'list'} onclick={() => deployMode = 'list'}>
			<div class="intent-icon amber">
				<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
			</div>
			<h3 class="syne text-sm font-bold text-white mt-3 mb-0.5">Create & List on DEX</h3>
			<p class="text-gray-400 font-mono text-[11px] leading-snug">Create token and add liquidity to DEX instantly.</p>
		</button>

		<button class="intent-card" class:active={deployMode === 'launch'} onclick={() => deployMode = 'launch'}>
			<div class="intent-icon emerald">
				<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>
			</div>
			<h3 class="syne text-sm font-bold text-white mt-3 mb-0.5">{$t('ci.launchExisting')}</h3>
			<p class="text-gray-400 font-mono text-[11px] leading-snug">{$t('ci.launchExistingSub')}</p>
		</button>
	</div>
</div>

<style>
	.mode-select { padding: 0.5rem 0; }

	.intent-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
	}

	.intent-card {
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		padding: 20px 14px;
		cursor: pointer;
		transition: all 0.25s;
		border: 1px solid rgba(255,255,255,0.06);
		background: rgba(255,255,255,0.02);
		border-radius: 14px;
		position: relative;
	}
	.intent-card:hover {
		transform: translateY(-2px);
		box-shadow: 0 8px 30px rgba(0,0,0,0.25);
		border-color: rgba(0,210,255,0.2);
		background: rgba(0,210,255,0.03);
	}
	.intent-card.active {
		border-color: rgba(0,210,255,0.5);
		background: rgba(0,210,255,0.06);
		box-shadow: 0 0 20px rgba(0,210,255,0.1);
	}

	.intent-card.featured {
		grid-column: 1 / -1;
		order: -1;
		padding: 24px 20px;
		border-color: rgba(0,210,255,0.15);
		overflow: hidden;
	}
	.intent-card.featured::before {
		content: '';
		position: absolute;
		inset: 0;
		background: radial-gradient(ellipse at 50% 0%, rgba(0,210,255,0.06), transparent 70%);
		pointer-events: none;
	}
	.intent-card.featured.active {
		border-color: rgba(0,210,255,0.5);
	}

	.badge-top {
		margin-bottom: 8px;
		font-size: 0.6rem;
		padding: 0.15rem 0.5rem;
	}

	.intent-icon {
		width: 48px;
		height: 48px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 12px;
	}
	.intent-icon.cyan {
		background: rgba(0,210,255,0.1);
		color: #00d2ff;
		border: 1px solid rgba(0,210,255,0.2);
	}
	.intent-icon.emerald {
		background: rgba(16,185,129,0.1);
		color: #10b981;
		border: 1px solid rgba(16,185,129,0.2);
	}
	.intent-icon.amber {
		background: rgba(245,158,11,0.1);
		color: #f59e0b;
		border: 1px solid rgba(245,158,11,0.2);
	}

	.syne { font-family: 'Syne', sans-serif; }
</style>
