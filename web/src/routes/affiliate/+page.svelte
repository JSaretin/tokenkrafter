<script lang="ts">
	import { getContext } from 'svelte';
	import { ethers } from 'ethers';
	import { ZERO_ADDRESS } from '$lib/tokenCrafter';
	import type { SupportedNetworks } from '$lib/structure';
	import { t } from '$lib/i18n';
	import Skeleton from '$lib/Skeleton.svelte';
	import { LaunchpadFactoryClient } from '$lib/contracts/launchpadFactory';
	import { AffiliateClient } from '$lib/contracts/affiliate';

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

	// Selected network for stats — Affiliate.sol is per-chain, so balances
	// don't aggregate across BSC + Base + Polygon. Switching the network
	// pill swaps the readout.
	let selectedNetworkIdx = $state(0);
	let selectedNetwork = $derived(supportedNetworks[selectedNetworkIdx]);

	let loading = $state(false);
	let claiming = $state(false);
	let copied = $state(false);
	let usdtSymbol = $state('USDT');
	let usdtDecimals = $state(18);

	// Alias (orthogonal to on-chain affiliate state — purely a UX
	// convenience for shorter ?ref= links).
	let myAlias = $state('');
	let aliasInput = $state('');
	let aliasLoading = $state(false);
	let aliasError = $state('');

	let referralLink = $derived.by(() => {
		if (!userAddress) return '';
		const origin = typeof window !== 'undefined' ? window.location.origin : '';
		return myAlias ? `${origin}/?ref=${myAlias}` : `${origin}/?ref=${userAddress}`;
	});

	// On-chain Affiliate.sol state (single source of truth for V3).
	let affiliateAddr = $state<string | null>(null);
	let pending = $state<bigint>(0n);
	let totalEarned = $state<bigint>(0n);
	let totalClaimed = $state<bigint>(0n);
	let referredCount = $state(0);
	let actionCount = $state(0);
	let lastActionAt = $state(0);
	let minClaim = $state<bigint>(0n);
	let shareBps = $state<number>(2500); // contract default 25%
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

	function formatLastSeen(unixSec: number): string {
		if (!unixSec) return '—';
		const ms = unixSec * 1000;
		const diff = Date.now() - ms;
		if (diff < 60_000) return 'just now';
		if (diff < 3600_000) return Math.floor(diff / 60_000) + 'm ago';
		if (diff < 86400_000) return Math.floor(diff / 3600_000) + 'h ago';
		const days = Math.floor(diff / 86400_000);
		if (days < 30) return days + 'd ago';
		return new Date(ms).toLocaleDateString();
	}

	async function copyLink() {
		if (!referralLink) return;
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
		// Reset stats so a slow chain switch doesn't show stale values.
		affiliateAddr = null;
		pending = 0n;
		totalEarned = 0n;
		totalClaimed = 0n;
		referredCount = 0;
		actionCount = 0;
		lastActionAt = 0;
		myReferrer = null;
		try {
			const providers = getNetworkProviders();
			const provider = providers.get(selectedNetwork.chain_id);
			if (!provider) {
				addFeedback({ message: `Provider not ready for ${selectedNetwork.name}`, type: 'error' });
				return;
			}

			// USDT metadata for display.
			const usdtAbi = [
				'function decimals() view returns (uint8)',
				'function symbol() view returns (string)',
			];
			const usdt = new ethers.Contract(selectedNetwork.usdt_address, usdtAbi, provider);
			const [dec, sym] = await Promise.all([
				usdt.decimals().catch(() => 18),
				usdt.symbol().catch(() => 'USDT'),
			]);
			usdtDecimals = Number(dec);
			usdtSymbol = sym;

			// Resolve Affiliate.sol address via the LaunchpadFactory's
			// affiliate() pointer. All three V3 reporters (TokenFactory,
			// LaunchpadFactory, TradeRouter) wire to the same Affiliate
			// address so any of them works as a discovery anchor.
			if (!selectedNetwork.launchpad_address || selectedNetwork.launchpad_address === '0x') {
				return;
			}
			const lpFactory = new LaunchpadFactoryClient(selectedNetwork.launchpad_address, provider);
			const addr = await lpFactory.affiliate();
			if (!addr || addr === ZERO_ADDRESS) return;

			affiliateAddr = addr;
			const aff = new AffiliateClient(addr, provider);
			const [stats, mc, share, ref] = await Promise.all([
				aff.getStats(userAddress),
				aff.minClaim().catch(() => 0n),
				aff.shareBps().catch(() => 2500),
				aff.referrerOf(userAddress).catch(() => ZERO_ADDRESS),
			]);
			pending = stats.pending;
			totalEarned = stats.totalEarned;
			totalClaimed = stats.totalClaimed;
			referredCount = stats.referredCount;
			actionCount = stats.actionCount;
			lastActionAt = stats.lastActionAt;
			minClaim = mc;
			shareBps = share;
			myReferrer = ref && ref !== ZERO_ADDRESS ? ref : null;
		} catch (e: any) {
			console.error('Failed to load affiliate stats:', e);
			addFeedback({ message: 'Failed to load affiliate stats.', type: 'error' });
		} finally {
			loading = false;
		}
	}

	async function claim() {
		if (!signer || !affiliateAddr) return;
		if (pending === 0n) return;
		if (minClaim > 0n && pending < minClaim) {
			addFeedback({
				message: `Below minimum claim (${formatAmount(minClaim, usdtDecimals)} ${usdtSymbol}).`,
				type: 'error',
			});
			return;
		}
		claiming = true;
		try {
			const aff = new AffiliateClient(affiliateAddr, signer);
			await aff.claim();
			addFeedback({ message: `${usdtSymbol} claimed!`, type: 'success' });
			await loadStats();
		} catch (e: any) {
			console.error('Claim failed:', e);
			addFeedback({ message: e?.reason || e?.shortMessage || 'Claim failed.', type: 'error' });
		} finally {
			claiming = false;
		}
	}

	$effect(() => {
		if (userAddress && providersReady && selectedNetwork) {
			loadStats();
		}
	});

	// Fetch existing alias on wallet connect.
	$effect(() => {
		if (userAddress) {
			fetch(`/api/referral?wallet=${userAddress}`)
				.then((r) => r.json())
				.then((data) => {
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
					signed_message: msg,
				}),
			});

			if (res.ok) {
				const data = await res.json();
				myAlias = data.alias;
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

	let sharePct = $derived((shareBps / 100).toFixed(shareBps % 100 === 0 ? 0 : 2));
	let canClaim = $derived(pending > 0n && (minClaim === 0n || pending >= minClaim));
</script>

<svelte:head>
	<title>Affiliate Program | TokenKrafter</title>
	<meta
		name="description"
		content="Earn {sharePct}% of platform fees on every paid action your referrals take — token creation, launchpad buys, off-ramp swaps. Paid in USDT."
	/>
</svelte:head>

<div class="page-wrap max-w-6xl mx-auto px-4 sm:px-6">
	{#if userAddress}
		<!-- Connected dashboard summary (sits above the marketing copy). -->
		<section class="pt-5 pb-2">
			<div class="card p-6">
				<div class="flex items-start justify-between gap-3 flex-wrap mb-4">
					<div>
						<div class="text-3xs font-mono uppercase tracking-widest text-emerald-400">Your affiliate dashboard</div>
						<h2 class="font-display text-xl font-bold text-heading mt-1">Welcome back</h2>
					</div>
					<a href="#affiliate-full-dashboard" class="text-xs font-mono text-brand-cyan hover:underline">View full stats →</a>
				</div>

				<div class="label-text mb-2">Your referral link</div>
				<div class="flex gap-2 items-stretch mb-4">
					<div class="min-w-0 flex-1 flex items-center px-4 py-3 rounded-lg overflow-hidden bg-surface-input border border-line-input">
						<span class="text-sm font-mono truncate text-foreground">{referralLink}</span>
					</div>
					<button onclick={copyLink} class="btn-primary text-sm px-5 flex-shrink-0 cursor-pointer">
						{copied ? $t('aff.copied') : $t('aff.copy')}
					</button>
				</div>

				<div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
					<div class="px-3 py-2.5 rounded-[10px] bg-white/2 border border-white/5">
						<div class="font-mono text-xs4 text-white/35 uppercase tracking-[0.06em]">Users referred</div>
						<div class="font-display text-[1.05rem] font-bold text-white mt-0.5">{loading ? '—' : referredCount}</div>
					</div>
					<div class="px-3 py-2.5 rounded-[10px] bg-white/2 border border-white/5">
						<div class="font-mono text-xs4 text-white/35 uppercase tracking-[0.06em]">Total earned</div>
						<div class="font-display text-[1.05rem] font-bold text-emerald-400 mt-0.5">{loading ? '—' : `${formatAmount(totalEarned, usdtDecimals)} ${usdtSymbol}`}</div>
					</div>
					<div class="px-3 py-2.5 rounded-[10px] bg-white/2 border border-white/5">
						<div class="font-mono text-xs4 text-white/35 uppercase tracking-[0.06em]">Pending</div>
						<div class="font-display text-[1.05rem] font-bold text-amber-400 mt-0.5">{loading ? '—' : `${formatAmount(pending, usdtDecimals)} ${usdtSymbol}`}</div>
					</div>
					<div class="px-3 py-2.5 rounded-[10px] bg-white/2 border border-white/5">
						<div class="font-mono text-xs4 text-white/35 uppercase tracking-[0.06em]">Claimed</div>
						<div class="font-display text-[1.05rem] font-bold text-white mt-0.5">{loading ? '—' : `${formatAmount(totalClaimed, usdtDecimals)} ${usdtSymbol}`}</div>
					</div>
				</div>
			</div>
		</section>
	{/if}

	<!-- Hero -->
	<section class="hero-section">
		<div class="max-w-4xl mx-auto text-center">
			<div class="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-emerald-500/25 bg-emerald-500/8 mb-8">
				<div class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></div>
				<span class="text-emerald-400 text-xs font-mono uppercase tracking-widest">{$t('aff.badge')}</span>
			</div>

			<h1 class="hero-title syne">
				Earn <span class="gradient-text">{sharePct}%</span> of every fee
			</h1>

			<p class="hero-sub font-mono">
				Refer users to TokenKrafter and earn a share of every platform fee they generate — token creation, launchpad buys, off-ramp swaps. Paid in USDT, claim anytime.
			</p>
		</div>
	</section>

	<!-- How It Works -->
	<section class="section">
		<div class="text-center mb-12">
			<h2 class="syne text-3xl sm:text-4xl font-bold text-white">How It Works</h2>
			<p class="text-gray-400 mt-3 font-mono text-sm">Three steps. Permanent referrer binding. One claim button.</p>
		</div>

		<div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
			<div class="step-card card p-6 relative">
				<div class="step-num syne text-5xl font-black text-white/5 absolute top-4 right-4">01</div>
				<div class="text-emerald-400 text-xs font-mono uppercase tracking-widest mb-2">01</div>
				<h3 class="syne font-bold text-white mb-2">Share your link</h3>
				<p class="text-sm text-gray-400 font-mono leading-relaxed">Connect your wallet to get a unique referral link. Anyone who lands via your link gets bound to you the first time they take a paid action — or earlier if they pre-register.</p>
			</div>
			<div class="step-card card p-6 relative">
				<div class="step-num syne text-5xl font-black text-white/5 absolute top-4 right-4">02</div>
				<div class="text-emerald-400 text-xs font-mono uppercase tracking-widest mb-2">02</div>
				<h3 class="syne font-bold text-white mb-2">They take a paid action</h3>
				<p class="text-sm text-gray-400 font-mono leading-relaxed">Whether they create a token, buy from a launchpad, or sell to bank — every paying action triggers a fee. The platform keeps {(100 - shareBps / 100).toFixed(0)}%; you get {sharePct}%.</p>
			</div>
			<div class="step-card card p-6 relative">
				<div class="step-num syne text-5xl font-black text-white/5 absolute top-4 right-4">03</div>
				<div class="text-emerald-400 text-xs font-mono uppercase tracking-widest mb-2">03</div>
				<h3 class="syne font-bold text-white mb-2">Claim in USDT</h3>
				<p class="text-sm text-gray-400 font-mono leading-relaxed">Earnings accumulate in your pending balance. Pull-claim anytime once you clear the minimum (currently {formatAmount(minClaim || 10n ** BigInt(usdtDecimals), usdtDecimals)} {usdtSymbol}). No auto-send — you control your own gas.</p>
			</div>
		</div>
	</section>

	<!-- Single rate card (replaces multi-tier grid) -->
	<section class="section">
		<div class="text-center mb-10">
			<h2 class="syne text-3xl sm:text-4xl font-bold text-white">One Flat Rate</h2>
			<p class="text-gray-400 mt-3 font-mono text-sm">Same {sharePct}% share, every paid action. Live from on-chain config — no fine print.</p>
		</div>

		<div class="card p-10 text-center max-w-2xl mx-auto" style="border-color: rgba(16,185,129,0.18);">
			<div class="text-3xs font-mono uppercase tracking-widest text-emerald-400 mb-4">Your share of the platform fee</div>
			<div class="syne text-7xl sm:text-8xl font-black gradient-text mb-4">{sharePct}%</div>
			<p class="text-sm text-gray-400 font-mono leading-relaxed max-w-md mx-auto">
				Applies to every fee-bearing action your referrals take — token creation, launchpad buys, and off-ramp swaps — for the lifetime of the wallet.
			</p>
		</div>

		<!-- Action coverage -->
		<div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-6">
			<div class="card p-5">
				<div class="feature-icon-box cyan mb-3">
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
				</div>
				<h3 class="syne font-bold text-white mb-2">Token creation</h3>
				<p class="text-sm text-gray-400 font-mono">{sharePct}% of the creation fee on every token your referrals deploy.</p>
			</div>
			<div class="card p-5">
				<div class="feature-icon-box emerald mb-3">
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/></svg>
				</div>
				<h3 class="syne font-bold text-white mb-2">Launchpad buys</h3>
				<p class="text-sm text-gray-400 font-mono">{sharePct}% of the buy fee on every launchpad purchase made through your referrals.</p>
			</div>
			<div class="card p-5">
				<div class="feature-icon-box purple mb-3">
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
				</div>
				<h3 class="syne font-bold text-white mb-2">Off-ramp swaps</h3>
				<p class="text-sm text-gray-400 font-mono">{sharePct}% of the platform fee on every Sell-to-Bank withdrawal — passive income on every trade.</p>
			</div>
		</div>
	</section>

	<!-- Key Details -->
	<section class="section">
		<div class="text-center mb-10">
			<h2 class="syne text-3xl sm:text-4xl font-bold text-white">{$t('aff.detailsTitle')}</h2>
		</div>

		<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
			<div class="card card-hover p-6 group">
				<div class="feature-icon-box emerald mb-4">$</div>
				<h3 class="syne font-bold text-white mb-2">Paid in USDT</h3>
				<p class="text-sm text-gray-400 leading-relaxed font-mono">Every fee on TokenKrafter is collected in USDT. Your earnings settle in USDT regardless of which token your referral spent.</p>
			</div>
			<div class="card card-hover p-6 group">
				<div class="feature-icon-box emerald mb-4">~</div>
				<h3 class="syne font-bold text-white mb-2">Pull-claim, not auto-send</h3>
				<p class="text-sm text-gray-400 leading-relaxed font-mono">Earnings accumulate in your pending balance and you claim when you want. Lower gas, no surprise dust transfers, fewer mis-routed funds.</p>
			</div>
			<div class="card card-hover p-6 group">
				<div class="feature-icon-box emerald mb-4">#</div>
				<h3 class="syne font-bold text-white mb-2">Sticky referrer</h3>
				<p class="text-sm text-gray-400 leading-relaxed font-mono">Once a wallet binds to your address, the relationship is permanent — every future paid action they take credits you. No expiry, no renewal.</p>
			</div>
			<div class="card card-hover p-6 group">
				<div class="feature-icon-box emerald mb-4">!</div>
				<h3 class="syne font-bold text-white mb-2">No caps</h3>
				<p class="text-sm text-gray-400 leading-relaxed font-mono">No referral count limit, no earnings ceiling, no monthly resets. Refer one user or a thousand — the rate is the same.</p>
			</div>
		</div>
	</section>

	<!-- Your Referral Dashboard -->
	<section id="affiliate-full-dashboard" class="section">
		<div class="text-center mb-10">
			<h2 class="syne text-3xl sm:text-4xl font-bold text-white">{$t('aff.dashTitle')}</h2>
			<p class="text-gray-400 mt-3 font-mono text-sm">{$t('aff.dashSub')}</p>
		</div>

		{#if !userAddress}
			<div class="card p-10 text-center">
				<div class="text-5xl mb-4 opacity-20">W</div>
				<h3 class="syne text-xl font-bold text-white mb-3">{$t('aff.connectTitle')}</h3>
				<p class="text-sm text-gray-400 font-mono mb-6 max-w-sm mx-auto">{$t('aff.connectDesc')}</p>
				<button onclick={connectWallet} class="btn-primary text-sm px-6 py-3 cursor-pointer">
					{$t('common.connectWallet')}
				</button>
			</div>
		{:else}
			<!-- Referral Link + Alias -->
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
				<p class="text-xs text-gray-500 font-mono mt-2">{$t('aff.linkHint')}</p>

				<div class="alias-section mt-4 pt-4" style="border-top: 1px solid var(--border)">
					<div class="flex items-center gap-2 mb-2">
						<span class="label-text mb-0">Custom Alias</span>
						{#if myAlias}
							<span class="text-3xs font-mono text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded-full">{myAlias}</span>
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
					<p class="text-3xs text-gray-600 font-mono mt-1.5">
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
				<!-- Skeleton mirrors the stats-grid + earnings card. -->
				<div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
					{#each Array(4) as _}
						<div class="card p-4 text-center flex flex-col items-center gap-2">
							<Skeleton width="60%" height="1.6rem" />
							<Skeleton width="80%" height="0.7rem" />
						</div>
					{/each}
				</div>
				<div class="card overflow-hidden mb-4">
					<div class="p-4 border-b border-white/5">
						<Skeleton width={140} height="0.95rem" />
					</div>
					<div class="p-5 grid grid-cols-1 sm:grid-cols-2 gap-4 items-center">
						<div class="flex flex-col gap-2">
							<Skeleton width={120} height="0.7rem" />
							<Skeleton width={140} height="1.6rem" />
							<Skeleton width={120} height="0.7rem" />
							<Skeleton width={140} height="1.6rem" />
						</div>
						<div class="flex justify-end">
							<Skeleton width={120} height="2.25rem" radius="10px" />
						</div>
					</div>
				</div>
			{:else if !affiliateAddr}
				<div class="card p-8 text-center">
					<p class="text-sm text-gray-400 font-mono">Affiliate program is not deployed on {selectedNetwork?.name ?? 'this network'} yet.</p>
				</div>
			{:else}
				<!-- Stats Grid (Affiliate.sol native fields) -->
				<div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
					<div class="card p-4 text-center">
						<div class="syne text-2xl font-bold text-white">{referredCount}</div>
						<div class="text-xs text-gray-500 mt-1 font-mono">Users referred</div>
					</div>
					<div class="card p-4 text-center">
						<div class="syne text-2xl font-bold text-white">{actionCount}</div>
						<div class="text-xs text-gray-500 mt-1 font-mono">Actions credited</div>
					</div>
					<div class="card p-4 text-center">
						<div class="syne text-2xl font-bold text-white">{sharePct}%</div>
						<div class="text-xs text-gray-500 mt-1 font-mono">Share rate</div>
					</div>
					<div class="card p-4 text-center">
						<div class="syne text-2xl font-bold text-white">{formatLastSeen(lastActionAt)}</div>
						<div class="text-xs text-gray-500 mt-1 font-mono">Last activity</div>
					</div>
				</div>

				<!-- Your Referrer (if any) -->
				{#if myReferrer}
					<div class="card p-4 mb-4 flex items-center gap-3">
						<span class="text-xs text-gray-500 font-mono uppercase">{$t('aff.yourReferrer')}</span>
						<span class="text-sm text-cyan-400 font-mono">{formatAddress(myReferrer)}</span>
					</div>
				{/if}

				<!-- Earnings + Claim -->
				<div class="card overflow-hidden mb-4">
					<div class="p-4 border-b border-white/5">
						<h3 class="section-title">{$t('aff.earningsTitle')}</h3>
					</div>
					<div class="p-5 grid grid-cols-1 sm:grid-cols-2 gap-4 items-center">
						<div>
							<div class="text-xs text-gray-500 font-mono uppercase mb-1">{$t('aff.totalEarned')} ({usdtSymbol})</div>
							<div class="syne text-2xl font-bold text-emerald-400">{formatAmount(totalEarned, usdtDecimals)}</div>
							<div class="text-xs text-gray-500 font-mono uppercase mt-3 mb-1">{$t('aff.pending')} ({usdtSymbol})</div>
							<div class="syne text-2xl font-bold text-amber-400">{formatAmount(pending, usdtDecimals)}</div>
							<div class="text-xs text-gray-500 font-mono uppercase mt-3 mb-1">Already claimed ({usdtSymbol})</div>
							<div class="syne text-lg font-bold text-white">{formatAmount(totalClaimed, usdtDecimals)}</div>
						</div>
						<div class="text-right">
							<button
								onclick={claim}
								disabled={claiming || !canClaim}
								class="btn-primary text-sm px-5 py-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
							>
								{#if claiming}
									<span class="spinner-inline"></span> {$t('aff.claiming')}
								{:else if pending === 0n}
									{$t('aff.noRewards')}
								{:else if minClaim > 0n && pending < minClaim}
									Min {formatAmount(minClaim, usdtDecimals)} {usdtSymbol}
								{:else}
									{$t('aff.claim')} {formatAmount(pending, usdtDecimals)} {usdtSymbol}
								{/if}
							</button>
							<p class="text-3xs text-gray-600 font-mono mt-2">Rewards paid in USDT only.</p>
						</div>
					</div>
				</div>
			{/if}
		{/if}
	</section>

	<!-- FAQ -->
	<section class="section">
		<div class="text-center mb-10">
			<h2 class="syne text-3xl sm:text-4xl font-bold text-white">{$t('aff.faqTitle')}</h2>
		</div>

		<div class="flex flex-col gap-3">
			<div class="card p-5">
				<h4 class="syne font-bold text-white mb-2">How do I start earning?</h4>
				<p class="text-sm text-gray-400 font-mono leading-relaxed">Connect your wallet above to get your unique referral link. Share it with anyone who'll create a token, buy on the launchpad, or sell to bank. The first paying action they take binds them to you.</p>
			</div>
			<div class="card p-5">
				<h4 class="syne font-bold text-white mb-2">When do I receive rewards?</h4>
				<p class="text-sm text-gray-400 font-mono leading-relaxed">Earnings accumulate as a pending USDT balance. Pull-claim anytime via the dashboard once you clear the minimum ({formatAmount(minClaim || 10n ** BigInt(usdtDecimals), usdtDecimals)} {usdtSymbol}). No auto-send.</p>
			</div>
			<div class="card p-5">
				<h4 class="syne font-bold text-white mb-2">What actions count?</h4>
				<p class="text-sm text-gray-400 font-mono leading-relaxed">Every paid action on the platform — token creation fees, launchpad buy fees, and off-ramp withdrawal fees. The same {sharePct}% share applies across all three.</p>
			</div>
			<div class="card p-5">
				<h4 class="syne font-bold text-white mb-2">Is there a referral cap?</h4>
				<p class="text-sm text-gray-400 font-mono leading-relaxed">No. Refer as many wallets as you want. There's no count limit, earnings ceiling, or expiry — once bound, that wallet credits you on every future paid action.</p>
			</div>
			<div class="card p-5">
				<h4 class="syne font-bold text-white mb-2">Can I refer myself?</h4>
				<p class="text-sm text-gray-400 font-mono leading-relaxed">No. The contract rejects self-referrals at the binding step. The same wallet can't be both the referrer and the referred.</p>
			</div>
			<div class="card p-5">
				<h4 class="syne font-bold text-white mb-2">What if my referral already has a referrer?</h4>
				<p class="text-sm text-gray-400 font-mono leading-relaxed">First-bind wins. Once a wallet is bound to a referrer, it stays bound forever — your link won't override theirs. Pre-register early to lock in the relationship.</p>
			</div>
		</div>
	</section>

	<!-- CTA -->
	<section class="section text-center pb-24">
		<div class="card p-10 sm:p-14 relative overflow-hidden bg-emerald-500/4 border-emerald-500/15">
			<div class="absolute inset-0 pointer-events-none bg-[radial-gradient(ellipse_at_50%_0%,rgba(16,185,129,0.08),transparent_70%)]"></div>
			<h2 class="font-display text-3xl sm:text-4xl font-bold text-heading mb-4 relative">{$t('aff.ctaTitle')}</h2>
			<p class="text-muted font-mono text-sm mb-8 relative">{$t('aff.ctaDesc')}</p>
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
	.gradient-text {
		background: linear-gradient(135deg, #10b981, #00d2ff);
		-webkit-background-clip: text;
		-webkit-text-fill-color: transparent;
		background-clip: text;
	}
</style>
