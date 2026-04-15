<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import { ethers } from 'ethers';
	import { TokenFactory, ZERO_ADDRESS } from '$lib/tokenCrafter';
	import type { SupportedNetworks, SupportedNetwork } from '$lib/structure';
	import { t } from '$lib/i18n';

	let connectWallet: () => Promise<boolean> = getContext('connectWallet');
	let getSigner: () => ethers.Signer | null = getContext('signer');
	let getUserAddress: () => string | null = getContext('userAddress');
	let addFeedback: (f: { message: string; type: string }) => void = getContext('addFeedback');
	let _getNetworks: () => SupportedNetworks = getContext('supportedNetworks');
	let supportedNetworks = $derived(_getNetworks());
	let getNetworkProviders: () => Map<number, ethers.JsonRpcProvider> = getContext('networkProviders');
	let getProvidersReady: () => boolean = getContext('providersReady');
	let userAddress = $derived(getUserAddress());
	let signer = $derived(getSigner());
	let providersReady = $derived(getProvidersReady());

	// Selected network for stats
	let selectedNetworkIdx = $state(0);
	let selectedNetwork = $derived(supportedNetworks[selectedNetworkIdx]);

	// Referral stats
	let loading = $state(false);
	let claiming = $state(false);
	let copied = $state(false);
	let usdtSymbol = $state('USDT');
	let usdtDecimals = $state(18);

	// Alias
	let myAlias = $state('');
	let aliasInput = $state('');
	let aliasLoading = $state(false);
	let aliasError = $state('');
	let aliasSaved = $state(false);

	let referralLink = $derived.by(() => {
		if (!userAddress) return '';
		const origin = typeof window !== 'undefined' ? window.location.origin : '';
		return myAlias ? `${origin}/?ref=${myAlias}` : `${origin}/?ref=${userAddress}`;
	});

	// Stats data — USDT-only after refactor
	let totalReferred = $state<bigint>(0n);
	let totalEarnedUsdt = $state<bigint>(0n);
	let pendingUsdt = $state<bigint>(0n);
	let referralChain: string[] = $state([]);
	let referralLevels = $state(3);
	let autoDistribute = $state(true);
	let myReferrer = $state<string | null>(null);

	function formatAddress(addr: string) {
		return addr.slice(0, 6) + '...' + addr.slice(-4);
	}

	function formatAmount(amount: bigint, decimals: number): string {
		const formatted = ethers.formatUnits(amount, decimals);
		const num = parseFloat(formatted);
		if (num === 0) return '0';
		if (num < 0.01) return '<0.01';
		return num.toFixed(2);
	}

	async function copyLink() {
		if (!referralLink) return;
		// Try modern clipboard API first, fall back to legacy execCommand
		// for insecure contexts / older browsers where it throws silently.
		let ok = false;
		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(referralLink);
				ok = true;
			}
		} catch {}
		if (!ok) {
			try {
				const ta = document.createElement('textarea');
				ta.value = referralLink;
				ta.style.position = 'fixed';
				ta.style.opacity = '0';
				document.body.appendChild(ta);
				ta.select();
				ok = document.execCommand('copy');
				document.body.removeChild(ta);
			} catch {}
		}
		if (ok) {
			copied = true;
			addFeedback?.({ message: 'Copied!', type: 'success' });
			setTimeout(() => (copied = false), 1500);
		} else {
			addFeedback?.({ message: 'Failed to copy link.', type: 'error' });
		}
	}

	async function loadStats() {
		if (!selectedNetwork || !userAddress) return;
		loading = true;
		try {
			const providers = getNetworkProviders();
			const provider = providers.get(selectedNetwork.chain_id);
			if (!provider) {
				addFeedback({ message: `Provider not ready for ${selectedNetwork.name}`, type: 'error' });
				return;
			}

			const factory = new TokenFactory(selectedNetwork.platform_address, provider);
			// USDT metadata for display
			const usdtAbi = [
				'function decimals() view returns (uint8)',
				'function symbol() view returns (string)'
			];
			const usdt = new ethers.Contract(selectedNetwork.usdt_address, usdtAbi, provider);

			const [stats, chain, levels, autoDist, referrer, dec, sym] = await Promise.all([
				factory.getReferralStats(userAddress),
				factory.getReferralChain(userAddress),
				factory.getReferralLevels(),
				factory.getAutoDistributeReward(),
				factory.getReferrer(userAddress),
				usdt.decimals().catch(() => 18),
				usdt.symbol().catch(() => 'USDT')
			]);

			totalReferred = stats.referred;
			totalEarnedUsdt = stats.earned;
			pendingUsdt = stats.pending;
			referralChain = [...chain];
			referralLevels = levels;
			autoDistribute = autoDist;
			myReferrer = referrer !== ZERO_ADDRESS ? referrer : null;
			usdtDecimals = Number(dec);
			usdtSymbol = sym;
		} catch (e: any) {
			console.error('Failed to load referral stats:', e);
			addFeedback({ message: 'Failed to load referral stats.', type: 'error' });
		} finally {
			loading = false;
		}
	}

	async function claimReward() {
		if (!signer || !selectedNetwork) return;
		claiming = true;
		try {
			const factory = new TokenFactory(selectedNetwork.platform_address, signer);
			await factory.claimReward();
			addFeedback({ message: `${usdtSymbol} reward claimed!`, type: 'success' });
			await loadStats();
		} catch (e: any) {
			console.error('Claim failed:', e);
			addFeedback({ message: e?.reason || 'Claim failed.', type: 'error' });
		} finally {
			claiming = false;
		}
	}

	$effect(() => {
		if (userAddress && providersReady) {
			loadStats();
		}
	});

	// Fetch existing alias on wallet connect
	$effect(() => {
		if (userAddress) {
			fetch(`/api/referral?wallet=${userAddress}`)
				.then(r => r.json())
				.then(data => {
					if (data.alias) {
						myAlias = data.alias;
						aliasInput = data.alias;
					}
				})
				.catch(() => {});
		}
	});

	async function saveAlias() {
		if (!signer || !userAddress || !aliasInput.trim()) return;
		aliasLoading = true;
		aliasError = '';
		aliasSaved = false;
		try {
			const timestamp = Date.now();
			const msg = `TokenKrafter Referral Alias\nAlias: ${aliasInput.trim().toLowerCase()}\nOrigin: ${window.location.origin}\nTimestamp: ${timestamp}`;
			const signature = await signer.signMessage(msg);

			const res = await fetch('/api/referral', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					alias: aliasInput.trim(),
					wallet_address: userAddress,
					signature,
					signed_message: msg
				})
			});

			if (res.ok) {
				const data = await res.json();
				myAlias = data.alias;
				aliasSaved = true;
				addFeedback({ message: 'Alias saved!', type: 'success' });
			} else {
				const err = await res.json().catch(() => ({ message: 'Failed' }));
				aliasError = err.message || 'Failed to save alias';
				addFeedback({ message: aliasError, type: 'error' });
			}
		} catch (e: any) {
			aliasError = e.message || 'Failed';
			addFeedback({ message: aliasError, type: 'error' });
		} finally {
			aliasLoading = false;
		}
	}
</script>

<svelte:head>
	<title>Affiliate Program | TokenKrafter</title>
	<meta name="description" content="Join the TokenKrafter affiliate program — earn commissions by referring users to create and deploy tokens on our platform." />
</svelte:head>

<div class="page-wrap max-w-6xl mx-auto px-4 sm:px-6">
	<!-- Hero -->
	<section class="hero-section">
		<div class="max-w-4xl mx-auto text-center">
			<div class="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-emerald-500/25 bg-emerald-500/8 mb-8">
				<div class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></div>
				<span class="text-emerald-400 text-xs font-mono uppercase tracking-widest">{$t('aff.badge')}</span>
			</div>

			<h1 class="hero-title syne">
				{$t('aff.heroTitle')} <span class="gradient-text">{$t('aff.heroTitleHighlight')}</span>
			</h1>

			<p class="hero-sub font-mono">
				{$t('aff.heroSub')}
			</p>
		</div>
	</section>

	<!-- How It Works -->
	<section class="section">
		<div class="text-center mb-12">
			<h2 class="syne text-3xl sm:text-4xl font-bold text-white">{$t('aff.howTitle')}</h2>
			<p class="text-gray-400 mt-3 font-mono text-sm">{$t('aff.howSub')}</p>
		</div>

		<div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
			{#each [
				{ n: '01', labelKey: 'aff.step1', descKey: 'aff.step1Desc' },
				{ n: '02', labelKey: 'aff.step2', descKey: 'aff.step2Desc' },
				{ n: '03', labelKey: 'aff.step3', descKey: 'aff.step3Desc' }
			] as step}
				<div class="step-card card p-6 relative">
					<div class="step-num syne text-5xl font-black text-white/5 absolute top-4 right-4">{step.n}</div>
					<div class="text-emerald-400 text-xs font-mono uppercase tracking-widest mb-2">{step.n}</div>
					<h3 class="syne font-bold text-white mb-2">{$t(step.labelKey)}</h3>
					<p class="text-sm text-gray-400 font-mono leading-relaxed">{$t(step.descKey)}</p>
				</div>
			{/each}
		</div>
	</section>

	<!-- Reward Tiers -->
	<section class="section">
		<div class="text-center mb-12">
			<h2 class="syne text-3xl sm:text-4xl font-bold text-white">{$t('aff.tiersTitle')}</h2>
			<p class="text-gray-400 mt-3 font-mono text-sm">{$t('aff.tiersSub')}</p>
		</div>

		<div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
			{#each [
				{ levelKey: 'aff.level1', pct: '5%', descKey: 'aff.level1Desc', color: 'emerald', detailKey: 'aff.level1Detail' },
				{ levelKey: 'aff.level2', pct: '3%', descKey: 'aff.level2Desc', color: 'cyan', detailKey: 'aff.level2Detail' },
				{ levelKey: 'aff.level3', pct: '2%', descKey: 'aff.level3Desc', color: 'purple', detailKey: 'aff.level3Detail' }
			] as tier}
				<div class="tier-card card p-6 text-center">
					<div class="tier-badge badge badge-{tier.color} mx-auto mb-4">{$t(tier.levelKey)}</div>
					<div class="syne text-4xl font-black text-white mb-2">{tier.pct}</div>
					<div class="text-sm text-gray-300 font-mono mb-2">{$t(tier.descKey)}</div>
					<p class="text-xs text-gray-500 font-mono">{$t(tier.detailKey)}</p>
				</div>
			{/each}
		</div>

		<div class="mt-6 card p-5">
			<div class="flex items-start gap-3">
				<span class="text-cyan-400 text-lg mt-0.5">i</span>
				<div>
					<p class="text-sm text-gray-300 font-mono leading-relaxed">
						<strong class="text-white">{$t('aff.example')}</strong> {$t('aff.exampleText')}
					</p>
				</div>
			</div>
		</div>
	</section>

	<!-- Two Revenue Streams — the biggest gap in current messaging -->
	<section class="section">
		<div class="text-center mb-10">
			<h2 class="syne text-3xl sm:text-4xl font-bold text-white">{$t('aff.twoStreamsTitle')}</h2>
			<p class="text-gray-400 mt-3 font-mono text-sm">{$t('aff.twoStreamsSub')}</p>
		</div>

		<div class="grid grid-cols-1 sm:grid-cols-2 gap-5">
			<!-- Stream 1: Creation referrals -->
			<div class="card p-6" style="border-color: rgba(0,210,255,0.15);">
				<div class="feature-icon-box cyan mb-4">
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
				</div>
				<h3 class="syne font-bold text-white text-lg mb-2">{$t('aff.stream1Title')}</h3>
				<p class="text-sm text-gray-400 leading-relaxed font-mono mb-4">{$t('aff.stream1Desc')}</p>
				<div class="flex gap-2 flex-wrap">
					<span class="badge-cyan" style="font-size:11px;padding:4px 10px;border-radius:6px;">L1: 5%</span>
					<span class="badge-cyan" style="font-size:11px;padding:4px 10px;border-radius:6px;">L2: 3%</span>
					<span class="badge-cyan" style="font-size:11px;padding:4px 10px;border-radius:6px;">L3: 2%</span>
				</div>
			</div>

			<!-- Stream 2: Trade affiliate (the missing one) -->
			<div class="card p-6" style="border-color: rgba(16,185,129,0.15);">
				<div class="feature-icon-box emerald mb-4">
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
				</div>
				<h3 class="syne font-bold text-white text-lg mb-2">{$t('aff.stream2Title')}</h3>
				<p class="text-sm text-gray-400 leading-relaxed font-mono mb-4">{$t('aff.stream2Desc')}</p>
				<div class="flex gap-2 flex-wrap">
					<span class="badge-emerald" style="font-size:11px;padding:4px 10px;border-radius:6px;">10% of fee</span>
					<span class="badge-emerald" style="font-size:11px;padding:4px 10px;border-radius:6px;">Every trade</span>
					<span class="badge-emerald" style="font-size:11px;padding:4px 10px;border-radius:6px;">Passive</span>
				</div>
			</div>
		</div>

		<div class="mt-5 card p-5" style="border-color: rgba(16,185,129,0.15);">
			<div class="flex items-start gap-3">
				<span class="text-emerald-400 text-lg mt-0.5">$</span>
				<div>
					<p class="text-sm text-gray-300 font-mono leading-relaxed">
						<strong class="text-white">Sell to Bank (Off-Ramp)</strong> — You also earn when your referrals use the Sell to Bank feature — 10% of the platform fee on every off-ramp trade. This is passive income on top of creation and swap referrals.
					</p>
				</div>
			</div>
		</div>
	</section>

	<!-- Key Details -->
	<section class="section">
		<div class="text-center mb-10">
			<h2 class="syne text-3xl sm:text-4xl font-bold text-white">{$t('aff.detailsTitle')}</h2>
		</div>

		<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
			{#each [
				{ icon: '$', titleKey: 'aff.detail1Title', descKey: 'aff.detail1Desc' },
				{ icon: '~', titleKey: 'aff.detail2Title', descKey: 'aff.detail2Desc' },
				{ icon: '#', titleKey: 'aff.detail3Title', descKey: 'aff.detail3Desc' },
				{ icon: '!', titleKey: 'aff.detail4Title', descKey: 'aff.detail4Desc' }
			] as detail}
				<div class="card card-hover p-6 group">
					<div class="feature-icon-box emerald mb-4">{detail.icon}</div>
					<h3 class="syne font-bold text-white mb-2">{$t(detail.titleKey)}</h3>
					<p class="text-sm text-gray-400 leading-relaxed font-mono">{$t(detail.descKey)}</p>
				</div>
			{/each}
		</div>
	</section>

	<!-- Your Referral Dashboard -->
	<section class="section">
		<div class="text-center mb-10">
			<h2 class="syne text-3xl sm:text-4xl font-bold text-white">{$t('aff.dashTitle')}</h2>
			<p class="text-gray-400 mt-3 font-mono text-sm">{$t('aff.dashSub')}</p>
		</div>

		{#if !userAddress}
			<div class="card p-10 text-center">
				<div class="text-5xl mb-4 opacity-20">W</div>
				<h3 class="syne text-xl font-bold text-white mb-3">{$t('aff.connectTitle')}</h3>
				<p class="text-sm text-gray-400 font-mono mb-6 max-w-sm mx-auto">
					{$t('aff.connectDesc')}
				</p>
				<button onclick={connectWallet} class="btn-primary text-sm px-6 py-3 cursor-pointer">
					{$t('common.connectWallet')}
				</button>
			</div>
		{:else}
			<!-- Referral Link -->
			<div class="card p-6 mb-4">
				<div class="label-text mb-3">{$t('aff.yourLink')}</div>
				<div class="flex gap-2 items-stretch">
					<div class="ref-link-box flex-1 flex items-center px-4 py-3 rounded-lg overflow-hidden" style="background: var(--bg-surface-input); border: 1px solid var(--border-input)">
						<span class="text-sm font-mono truncate" style="color: var(--text)">{referralLink}</span>
					</div>
					<button onclick={copyLink} class="btn-primary text-sm px-5 flex-shrink-0 cursor-pointer">
						{copied ? $t('aff.copied') : $t('aff.copy')}
					</button>
				</div>
				<p class="text-xs text-gray-500 font-mono mt-2">
					{$t('aff.linkHint')}
				</p>

				<!-- Alias -->
				<div class="alias-section mt-4 pt-4" style="border-top: 1px solid var(--border)">
					<div class="flex items-center gap-2 mb-2">
						<span class="label-text mb-0">Custom Alias</span>
						{#if myAlias}
							<span class="text-[10px] font-mono text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded-full">{myAlias}</span>
						{/if}
					</div>
					<div class="flex gap-2">
						<input
							type="text"
							class="input-field flex-1"
							placeholder="e.g. john, crypto-king"
							bind:value={aliasInput}
							maxlength="20"
						/>
						<button
							class="btn-secondary text-xs px-4 cursor-pointer flex-shrink-0"
							disabled={aliasLoading || !aliasInput.trim()}
							onclick={saveAlias}
						>
							{aliasLoading ? '...' : myAlias ? 'Update' : 'Save'}
						</button>
					</div>
					<p class="text-[10px] text-gray-600 font-mono mt-1.5">
						3-20 chars, lowercase. Your link becomes: tokenkrafter.com/?ref={aliasInput.trim().toLowerCase() || 'your-alias'}
					</p>
				</div>
			</div>

			<!-- Network Selector -->
			<div class="mb-4">
				<div class="label-text mb-2">{$t('aff.network')}</div>
				<div class="flex gap-2 flex-wrap">
					{#each supportedNetworks as net, i}
						<button
							onclick={() => { selectedNetworkIdx = i; loadStats(); }}
							class="px-4 py-2 rounded-lg text-sm font-mono transition cursor-pointer border
								{selectedNetworkIdx === i
									? 'text-cyan-400 bg-cyan-400/10 border-cyan-500/30'
									: 'text-gray-400 bg-white/4 border-white/10 hover:border-white/20 hover:text-white'}"
						>{net.name}</button>
					{/each}
				</div>
			</div>

			{#if loading}
				<div class="card p-10 flex items-center justify-center">
					<div class="flex flex-col items-center gap-3">
						<div class="spinner w-10 h-10 rounded-full border-2 border-white/10 border-t-cyan-400"></div>
						<span class="text-gray-500 text-sm font-mono">{$t('aff.loadingStats')}</span>
					</div>
				</div>
			{:else}
				<!-- Stats Grid -->
				<div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
					<div class="card p-4 text-center">
						<div class="syne text-2xl font-bold text-white">{totalReferred.toString()}</div>
						<div class="text-xs text-gray-500 mt-1 font-mono">{$t('aff.totalReferred')}</div>
					</div>
					<div class="card p-4 text-center">
						<div class="syne text-2xl font-bold text-white">{referralLevels}</div>
						<div class="text-xs text-gray-500 mt-1 font-mono">{$t('aff.rewardLevels')}</div>
					</div>
					<div class="card p-4 text-center">
						<div class="syne text-2xl font-bold text-white">{referralChain.length}</div>
						<div class="text-xs text-gray-500 mt-1 font-mono">{$t('aff.chainDepth')}</div>
					</div>
					<div class="card p-4 text-center">
						<div class="syne text-2xl font-bold text-emerald-400">{autoDistribute ? $t('aff.auto') : $t('aff.manual')}</div>
						<div class="text-xs text-gray-500 mt-1 font-mono">{$t('aff.distribution')}</div>
					</div>
				</div>

				<!-- Your Referrer -->
				{#if myReferrer}
					<div class="card p-4 mb-4 flex items-center gap-3">
						<span class="text-xs text-gray-500 font-mono uppercase">{$t('aff.yourReferrer')}</span>
						<span class="text-sm text-cyan-400 font-mono">{formatAddress(myReferrer)}</span>
					</div>
				{/if}

				<!-- Earnings (USDT only) -->
				<div class="card overflow-hidden mb-4">
					<div class="p-4 border-b border-white/5">
						<h3 class="section-title">{$t('aff.earningsTitle')}</h3>
					</div>
					<div class="p-5 grid grid-cols-1 sm:grid-cols-2 gap-4 items-center">
						<div>
							<div class="text-xs text-gray-500 font-mono uppercase mb-1">{$t('aff.totalEarned')} ({usdtSymbol})</div>
							<div class="syne text-2xl font-bold text-emerald-400">{formatAmount(totalEarnedUsdt, usdtDecimals)}</div>
							<div class="text-xs text-gray-500 font-mono uppercase mt-3 mb-1">{$t('aff.pending')} ({usdtSymbol})</div>
							<div class="syne text-2xl font-bold text-amber-400">{formatAmount(pendingUsdt, usdtDecimals)}</div>
						</div>
						<div class="text-right">
							{#if pendingUsdt > 0n}
								<button
									onclick={() => claimReward()}
									disabled={claiming}
									class="btn-primary text-sm px-5 py-2 cursor-pointer"
								>
									{#if claiming}
										<span class="spinner-inline"></span> {$t('aff.claiming')}
									{:else}
										{$t('aff.claim')}
									{/if}
								</button>
							{:else}
								<span class="text-gray-600 text-xs font-mono">{$t('aff.noRewards')}</span>
							{/if}
							<p class="text-[10px] text-gray-600 font-mono mt-2">Rewards paid in USDT only.</p>
						</div>
					</div>
				</div>

				<!-- Referral Chain -->
				{#if referralChain.length > 0}
					<div class="card p-4">
						<h3 class="section-title mb-3">{$t('aff.chainTitle')}</h3>
						<div class="flex flex-wrap gap-2 items-center">
							{#each referralChain as addr, i}
								<div class="flex items-center gap-2">
									<span class="badge badge-{i === 0 ? 'emerald' : i === 1 ? 'cyan' : 'purple'}">
										L{i + 1}: {formatAddress(addr)}
									</span>
									{#if i < referralChain.length - 1}
										<span class="text-gray-600">-></span>
									{/if}
								</div>
							{/each}
						</div>
					</div>
				{/if}
			{/if}
		{/if}
	</section>

	<!-- FAQ -->
	<section class="section">
		<div class="text-center mb-10">
			<h2 class="syne text-3xl sm:text-4xl font-bold text-white">{$t('aff.faqTitle')}</h2>
		</div>

		<div class="flex flex-col gap-3">
			{#each [
				{ qKey: 'aff.faq1Q', aKey: 'aff.faq1A' },
				{ qKey: 'aff.faq2Q', aKey: 'aff.faq2A' },
				{ qKey: 'aff.faq3Q', aKey: 'aff.faq3A' },
				{ qKey: 'aff.faq4Q', aKey: 'aff.faq4A' },
				{ qKey: 'aff.faq5Q', aKey: 'aff.faq5A' },
				{ qKey: 'aff.faq6Q', aKey: 'aff.faq6A' }
			] as faq}
				<div class="card p-5">
					<h4 class="syne font-bold text-white mb-2">{$t(faq.qKey)}</h4>
					<p class="text-sm text-gray-400 font-mono leading-relaxed">{$t(faq.aKey)}</p>
				</div>
			{/each}
		</div>
	</section>

	<!-- CTA -->
	<section class="section text-center pb-24">
		<div class="cta-card card p-10 sm:p-14 relative overflow-hidden">
			<div class="cta-glow absolute inset-0 pointer-events-none"></div>
			<h2 class="syne text-3xl sm:text-4xl font-bold text-white mb-4 relative">{$t('aff.ctaTitle')}</h2>
			<p class="text-gray-400 font-mono text-sm mb-8 relative">{$t('aff.ctaDesc')}</p>
			{#if userAddress}
				<button onclick={copyLink} class="btn-primary text-sm px-8 py-3 cursor-pointer relative">
					{copied ? $t('aff.ctaCopied') : $t('aff.ctaCopy')}
				</button>
			{:else}
				<button onclick={connectWallet} class="btn-primary text-sm px-8 py-3 cursor-pointer relative">
					{$t('aff.ctaConnect')}
				</button>
			{/if}
		</div>
	</section>
</div>

<style>
	/* Page-specific gradient */
	.gradient-text {
		background: linear-gradient(135deg, #10b981, #00d2ff);
		-webkit-background-clip: text;
		-webkit-text-fill-color: transparent;
		background-clip: text;
	}

	.tier-card {
		transition: all 0.25s;
	}
	.tier-card:hover {
		transform: translateY(-3px);
		box-shadow: 0 12px 40px rgba(0,0,0,0.3);
	}

	.ref-link-box {
		min-width: 0;
	}

	/* Page-specific CTA colors */
	.cta-card {
		background: rgba(16,185,129,0.04);
		border-color: rgba(16,185,129,0.15);
	}
	.cta-glow {
		background: radial-gradient(ellipse at 50% 0%, rgba(16,185,129,0.08), transparent 70%);
	}

</style>
