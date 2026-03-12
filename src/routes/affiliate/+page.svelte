<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import { ethers } from 'ethers';
	import { TokenFactory, ZERO_ADDRESS } from '$lib/tokenCrafter';
	import type { SupportedNetworks, SupportedNetwork, PaymentOption } from '$lib/structure';

	let connectWallet: () => Promise<boolean> = getContext('connectWallet');
	let getSigner: () => ethers.Signer | null = getContext('signer');
	let getUserAddress: () => string | null = getContext('userAddress');
	let addFeedback: (f: { message: string; type: string }) => void = getContext('addFeedback');
	let supportedNetworks: SupportedNetworks = getContext('supportedNetworks');
	let getNetworkProviders: () => Map<number, ethers.JsonRpcProvider> = getContext('networkProviders');
	let getProvidersReady: () => boolean = getContext('providersReady');
	let getPaymentOptions: (n: SupportedNetwork) => PaymentOption[] = getContext('getPaymentOptions');

	let userAddress = $derived(getUserAddress());
	let signer = $derived(getSigner());
	let providersReady = $derived(getProvidersReady());

	// Selected network for stats
	let selectedNetworkIdx = $state(0);
	let selectedNetwork = $derived(supportedNetworks[selectedNetworkIdx]);

	// Referral stats
	let loading = $state(false);
	let claiming = $state<string | null>(null);
	let referralLink = $derived(userAddress ? `${typeof window !== 'undefined' ? window.location.origin : ''}/create?ref=${userAddress}` : '');
	let copied = $state(false);

	// Stats data
	let totalReferred = $state<bigint>(0n);
	let earnings: { symbol: string; address: string; earned: bigint; pending: bigint; decimals: number }[] = $state([]);
	let referralChain: string[] = $state([]);
	let referralPercents: bigint[] = $state([]);
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
		try {
			await navigator.clipboard.writeText(referralLink);
			copied = true;
			addFeedback({ message: 'Referral link copied!', type: 'success' });
			setTimeout(() => (copied = false), 2000);
		} catch {
			addFeedback({ message: 'Failed to copy link.', type: 'error' });
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
			const paymentOptions = getPaymentOptions(selectedNetwork);
			const paymentAddresses = paymentOptions.map((p) => p.address);

			const [stats, chain, percents, levels, autoDist, referrer] = await Promise.all([
				factory.getReferralStats(userAddress, paymentAddresses),
				factory.getReferralChain(userAddress),
				factory.getReferralPercents(),
				factory.getReferralLevels(),
				factory.getAutoDistributeReward(),
				factory.getReferrer(userAddress)
			]);

			totalReferred = stats.referred;
			referralChain = [...chain];
			referralPercents = [...percents];
			referralLevels = levels;
			autoDistribute = autoDist;
			myReferrer = referrer !== ZERO_ADDRESS ? referrer : null;

			earnings = paymentOptions.map((p, i) => ({
				symbol: p.symbol,
				address: p.address,
				earned: stats.earned[i] ?? 0n,
				pending: stats.pending[i] ?? 0n,
				decimals: p.decimals
			}));
		} catch (e: any) {
			console.error('Failed to load referral stats:', e);
			addFeedback({ message: 'Failed to load referral stats.', type: 'error' });
		} finally {
			loading = false;
		}
	}

	async function claimReward(paymentToken: string, symbol: string) {
		if (!signer || !selectedNetwork) return;
		claiming = paymentToken;
		try {
			const factory = new TokenFactory(selectedNetwork.platform_address, signer);
			await factory.claimReward(paymentToken);
			addFeedback({ message: `${symbol} reward claimed!`, type: 'success' });
			await loadStats();
		} catch (e: any) {
			console.error('Claim failed:', e);
			addFeedback({ message: e?.reason || 'Claim failed.', type: 'error' });
		} finally {
			claiming = null;
		}
	}

	$effect(() => {
		if (userAddress && providersReady) {
			loadStats();
		}
	});
</script>

<svelte:head>
	<title>Affiliate Program | TokenKrafter</title>
	<meta name="description" content="Join the TokenKrafter affiliate program — earn commissions by referring users to create and deploy tokens on our platform." />
</svelte:head>

<div class="page-wrap">
	<!-- Hero -->
	<section class="hero-section">
		<div class="max-w-4xl mx-auto text-center px-4 sm:px-6">
			<div class="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-emerald-500/25 bg-emerald-500/8 mb-8">
				<div class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></div>
				<span class="text-emerald-400 text-xs font-mono uppercase tracking-widest">Affiliate Program</span>
			</div>

			<h1 class="hero-title syne">
				Earn By <span class="gradient-text">Sharing</span>
			</h1>

			<p class="hero-sub font-mono">
				Refer creators to TokenKrafter and earn a percentage of their token creation fees.
				Multi-level rewards, paid automatically or on-demand.
			</p>
		</div>
	</section>

	<!-- How It Works -->
	<section class="section max-w-5xl mx-auto px-4 sm:px-6">
		<div class="text-center mb-12">
			<h2 class="syne text-3xl sm:text-4xl font-bold text-white">How It Works</h2>
			<p class="text-gray-400 mt-3 font-mono text-sm">A simple 3-level referral system that rewards you for growing the community.</p>
		</div>

		<div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
			{#each [
				{ n: '01', label: 'Share Your Link', desc: 'Connect your wallet to get a unique referral link. Share it with anyone interested in creating tokens.' },
				{ n: '02', label: 'They Create Tokens', desc: 'When someone uses your link to create a token, you\'re registered as their referrer permanently.' },
				{ n: '03', label: 'Earn Rewards', desc: 'You earn a percentage of the creation fee. Rewards are paid in the same token used for payment.' }
			] as step}
				<div class="step-card card p-6 relative">
					<div class="step-num syne text-5xl font-black text-white/5 absolute top-4 right-4">{step.n}</div>
					<div class="text-emerald-400 text-xs font-mono uppercase tracking-widest mb-2">{step.n}</div>
					<h3 class="syne font-bold text-white mb-2">{step.label}</h3>
					<p class="text-sm text-gray-400 font-mono leading-relaxed">{step.desc}</p>
				</div>
			{/each}
		</div>
	</section>

	<!-- Reward Tiers -->
	<section class="section max-w-4xl mx-auto px-4 sm:px-6">
		<div class="text-center mb-12">
			<h2 class="syne text-3xl sm:text-4xl font-bold text-white">Reward Tiers</h2>
			<p class="text-gray-400 mt-3 font-mono text-sm">Earn from up to 3 levels of referrals in your chain.</p>
		</div>

		<div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
			{#each [
				{ level: 'Level 1', pct: '5%', desc: 'Direct referrals', color: 'emerald', detail: 'Someone creates a token using your link' },
				{ level: 'Level 2', pct: '3%', desc: 'Referrals of your referrals', color: 'cyan', detail: 'Your referral brings in another creator' },
				{ level: 'Level 3', pct: '2%', desc: 'Third-degree referrals', color: 'purple', detail: 'The chain extends one more level deep' }
			] as tier}
				<div class="tier-card card p-6 text-center">
					<div class="tier-badge badge badge-{tier.color} mx-auto mb-4">{tier.level}</div>
					<div class="syne text-4xl font-black text-white mb-2">{tier.pct}</div>
					<div class="text-sm text-gray-300 font-mono mb-2">{tier.desc}</div>
					<p class="text-xs text-gray-500 font-mono">{tier.detail}</p>
				</div>
			{/each}
		</div>

		<div class="mt-6 card p-5">
			<div class="flex items-start gap-3">
				<span class="text-cyan-400 text-lg mt-0.5">i</span>
				<div>
					<p class="text-sm text-gray-300 font-mono leading-relaxed">
						<strong class="text-white">Example:</strong> You refer Alice, who creates a token paying $40 USDT.
						You earn <span class="text-emerald-400">$2 (5%)</span>.
						Later, Alice refers Bob who creates a $25 token — you earn <span class="text-cyan-400">$0.75 (3%)</span> from Level 2.
					</p>
				</div>
			</div>
		</div>
	</section>

	<!-- Key Details -->
	<section class="section max-w-4xl mx-auto px-4 sm:px-6">
		<div class="text-center mb-10">
			<h2 class="syne text-3xl sm:text-4xl font-bold text-white">Key Details</h2>
		</div>

		<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
			{#each [
				{ icon: '$', title: 'Paid in Creation Currency', desc: 'Rewards are denominated in whatever token the creator uses to pay — USDT, USDC, or native coin.' },
				{ icon: '~', title: 'Auto or Manual Distribution', desc: 'When auto-distribute is enabled, rewards are sent to your wallet immediately. Otherwise, claim them anytime.' },
				{ icon: '#', title: 'Permanent Referral Mapping', desc: 'Once someone is linked to your referral, the relationship is permanent. You earn on all their future token creations.' },
				{ icon: '!', title: 'No Limits', desc: 'There\'s no cap on how many people you can refer or how much you can earn. The more you share, the more you earn.' }
			] as detail}
				<div class="card card-hover p-6 group">
					<div class="feature-icon-box emerald mb-4">{detail.icon}</div>
					<h3 class="syne font-bold text-white mb-2">{detail.title}</h3>
					<p class="text-sm text-gray-400 leading-relaxed font-mono">{detail.desc}</p>
				</div>
			{/each}
		</div>
	</section>

	<!-- Your Referral Dashboard -->
	<section class="section max-w-4xl mx-auto px-4 sm:px-6">
		<div class="text-center mb-10">
			<h2 class="syne text-3xl sm:text-4xl font-bold text-white">Your Dashboard</h2>
			<p class="text-gray-400 mt-3 font-mono text-sm">Track your referrals, earnings, and claim pending rewards.</p>
		</div>

		{#if !userAddress}
			<div class="card p-10 text-center">
				<div class="text-5xl mb-4 opacity-20">W</div>
				<h3 class="syne text-xl font-bold text-white mb-3">Connect Your Wallet</h3>
				<p class="text-sm text-gray-400 font-mono mb-6 max-w-sm mx-auto">
					Connect your wallet to see your referral link, stats, and claim rewards.
				</p>
				<button onclick={connectWallet} class="btn-primary text-sm px-6 py-3 cursor-pointer">
					Connect Wallet
				</button>
			</div>
		{:else}
			<!-- Referral Link -->
			<div class="card p-6 mb-4">
				<div class="label-text mb-3">Your Referral Link</div>
				<div class="flex gap-2 items-stretch">
					<div class="ref-link-box flex-1 flex items-center px-4 py-3 rounded-lg overflow-hidden" style="background: var(--bg-surface-input); border: 1px solid var(--border-input)">
						<span class="text-sm font-mono truncate" style="color: var(--text)">{referralLink}</span>
					</div>
					<button onclick={copyLink} class="btn-primary text-sm px-5 flex-shrink-0 cursor-pointer">
						{copied ? 'Copied!' : 'Copy'}
					</button>
				</div>
				<p class="text-xs text-gray-500 font-mono mt-2">
					Share this link with potential token creators. When they deploy using your link, you earn rewards.
				</p>
			</div>

			<!-- Network Selector -->
			<div class="mb-4">
				<div class="label-text mb-2">Network</div>
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
						<span class="text-gray-500 text-sm font-mono">Loading stats...</span>
					</div>
				</div>
			{:else}
				<!-- Stats Grid -->
				<div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
					<div class="card p-4 text-center">
						<div class="syne text-2xl font-bold text-white">{totalReferred.toString()}</div>
						<div class="text-xs text-gray-500 mt-1 font-mono">Total Referred</div>
					</div>
					<div class="card p-4 text-center">
						<div class="syne text-2xl font-bold text-white">{referralLevels}</div>
						<div class="text-xs text-gray-500 mt-1 font-mono">Reward Levels</div>
					</div>
					<div class="card p-4 text-center">
						<div class="syne text-2xl font-bold text-white">{referralChain.length}</div>
						<div class="text-xs text-gray-500 mt-1 font-mono">Chain Depth</div>
					</div>
					<div class="card p-4 text-center">
						<div class="syne text-2xl font-bold text-emerald-400">{autoDistribute ? 'Auto' : 'Manual'}</div>
						<div class="text-xs text-gray-500 mt-1 font-mono">Distribution</div>
					</div>
				</div>

				<!-- Your Referrer -->
				{#if myReferrer}
					<div class="card p-4 mb-4 flex items-center gap-3">
						<span class="text-xs text-gray-500 font-mono uppercase">Your Referrer:</span>
						<span class="text-sm text-cyan-400 font-mono">{formatAddress(myReferrer)}</span>
					</div>
				{/if}

				<!-- Earnings Table -->
				<div class="card overflow-hidden mb-4">
					<div class="p-4 border-b border-white/5">
						<h3 class="section-title">Earnings & Rewards</h3>
					</div>
					<div class="overflow-x-auto">
						<table class="w-full text-sm font-mono">
							<thead>
								<tr class="text-left text-gray-500 text-xs uppercase">
									<th class="px-4 py-3">Token</th>
									<th class="px-4 py-3">Total Earned</th>
									<th class="px-4 py-3">Pending</th>
									<th class="px-4 py-3 text-right">Action</th>
								</tr>
							</thead>
							<tbody>
								{#each earnings as e}
									<tr class="border-t border-white/5 hover:bg-white/2">
										<td class="px-4 py-3 text-white font-semibold">{e.symbol}</td>
										<td class="px-4 py-3 text-emerald-400">{formatAmount(e.earned, e.decimals)}</td>
										<td class="px-4 py-3 text-amber-400">{formatAmount(e.pending, e.decimals)}</td>
										<td class="px-4 py-3 text-right">
											{#if e.pending > 0n}
												<button
													onclick={() => claimReward(e.address, e.symbol)}
													disabled={claiming === e.address}
													class="btn-primary text-xs px-4 py-1.5 cursor-pointer"
												>
													{#if claiming === e.address}
														<span class="spinner-inline"></span> Claiming...
													{:else}
														Claim
													{/if}
												</button>
											{:else}
												<span class="text-gray-600 text-xs">No rewards</span>
											{/if}
										</td>
									</tr>
								{/each}
								{#if earnings.length === 0}
									<tr>
										<td colspan="4" class="px-4 py-8 text-center text-gray-500">No earnings data yet</td>
									</tr>
								{/if}
							</tbody>
						</table>
					</div>
				</div>

				<!-- Referral Chain -->
				{#if referralChain.length > 0}
					<div class="card p-4">
						<h3 class="section-title mb-3">Your Referral Chain</h3>
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
	<section class="section max-w-3xl mx-auto px-4 sm:px-6">
		<div class="text-center mb-10">
			<h2 class="syne text-3xl sm:text-4xl font-bold text-white">FAQ</h2>
		</div>

		<div class="flex flex-col gap-3">
			{#each [
				{ q: 'How do I start earning?', a: 'Connect your wallet above to get your unique referral link. Share it with anyone who wants to create tokens. When they use your link during token creation, you\'re automatically registered as their referrer.' },
				{ q: 'When do I receive my rewards?', a: 'If auto-distribution is enabled (default), rewards are sent to your wallet immediately when a referred user creates a token. If manual mode is active, rewards accumulate and you can claim them anytime from the dashboard above.' },
				{ q: 'What tokens are rewards paid in?', a: 'Rewards are paid in the same token used for the creation fee — USDT, USDC, or the chain\'s native coin (ETH, BNB, etc.).' },
				{ q: 'Is there a limit on referrals?', a: 'No. You can refer as many people as you want, and there\'s no cap on earnings. The referral relationship is permanent once established.' },
				{ q: 'What about circular referrals?', a: 'The smart contract prevents direct circular referral chains. If Alice refers Bob, Bob cannot set Alice as his referrer.' },
				{ q: 'Do I earn from all levels?', a: 'Yes. With 3 levels active, you earn 5% from your direct referrals (L1), 3% from their referrals (L2), and 2% from the third level (L3). All percentages are based on the creation fee.' }
			] as faq}
				<div class="card p-5">
					<h4 class="syne font-bold text-white mb-2">{faq.q}</h4>
					<p class="text-sm text-gray-400 font-mono leading-relaxed">{faq.a}</p>
				</div>
			{/each}
		</div>
	</section>

	<!-- CTA -->
	<section class="section max-w-2xl mx-auto px-4 sm:px-6 text-center pb-24">
		<div class="cta-card card p-10 sm:p-14 relative overflow-hidden">
			<div class="cta-glow absolute inset-0 pointer-events-none"></div>
			<h2 class="syne text-3xl sm:text-4xl font-bold text-white mb-4 relative">Start Earning Today</h2>
			<p class="text-gray-400 font-mono text-sm mb-8 relative">Share your link, grow the community, and earn from every token created through your referral chain.</p>
			{#if userAddress}
				<button onclick={copyLink} class="btn-primary text-sm px-8 py-3 cursor-pointer relative">
					{copied ? 'Link Copied!' : 'Copy Your Referral Link'}
				</button>
			{:else}
				<button onclick={connectWallet} class="btn-primary text-sm px-8 py-3 cursor-pointer relative">
					Connect Wallet to Get Started
				</button>
			{/if}
		</div>
	</section>
</div>

<style>
	.page-wrap { padding-bottom: 40px; }

	.hero-section {
		padding: 80px 0 60px;
	}

	.hero-title {
		font-size: clamp(2.5rem, 6vw, 4.5rem);
		font-weight: 800;
		line-height: 1.1;
		color: var(--text-heading);
		margin-bottom: 20px;
	}

	.gradient-text {
		background: linear-gradient(135deg, #10b981, #00d2ff);
		-webkit-background-clip: text;
		-webkit-text-fill-color: transparent;
		background-clip: text;
	}

	.hero-sub {
		font-size: 16px;
		color: #94a3b8;
		max-width: 560px;
		margin: 0 auto;
		line-height: 1.7;
	}

	.section { margin: 60px auto; }

	.feature-icon-box {
		width: 40px;
		height: 40px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 10px;
		font-size: 18px;
		font-weight: 800;
		font-family: 'Syne', sans-serif;
	}
	.feature-icon-box.emerald {
		background: rgba(16,185,129,0.1);
		color: #10b981;
		border: 1px solid rgba(16,185,129,0.2);
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

	.cta-card {
		background: rgba(16,185,129,0.04);
		border-color: rgba(16,185,129,0.15);
	}
	.cta-glow {
		background: radial-gradient(ellipse at 50% 0%, rgba(16,185,129,0.08), transparent 70%);
	}

	.spinner-inline {
		display: inline-block;
		width: 12px;
		height: 12px;
		border: 2px solid var(--border-input);
		border-top-color: #00d2ff;
		border-radius: 50%;
		animation: spin 0.6s linear infinite;
	}

	@keyframes spin { to { transform: rotate(360deg); } }

	table { border-collapse: collapse; }
</style>
