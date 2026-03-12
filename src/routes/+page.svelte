<script lang="ts">
	const features = [
		{
			icon: '~',
			title: 'Bonding Curves',
			desc: "Choose from multiple curve types — linear, exponential, or flat — to shape your token's price discovery.",
			color: 'cyan'
		},
		{
			icon: '#',
			title: 'Soft & Hard Caps',
			desc: 'Set fundraising goals with soft and hard caps. Launches finalize when the hard cap is reached.',
			color: 'orange'
		},
		{
			icon: '%',
			title: 'Anti-Whale Limits',
			desc: 'Cap individual buy amounts to prevent whales from dominating your launch and ensure fair distribution.',
			color: 'emerald'
		},
		{
			icon: 'V',
			title: 'Built-In Vesting',
			desc: 'Lock creator allocations with configurable vesting periods so the community knows tokens are safe.',
			color: 'purple'
		},
		{
			icon: 'T',
			title: 'Token Creation',
			desc: "Don't have a token yet? Create custom ERC-20 tokens with mintable, taxable, and partner features.",
			color: 'cyan'
		},
		{
			icon: '$',
			title: 'Flexible Payments',
			desc: 'Participants can contribute with native tokens, USDT, or USDC. Real-time pricing via DEX.',
			color: 'emerald'
		}
	];

	const steps = [
		{ n: '01', label: 'Create', desc: 'Set up your token and configure your launch — bonding curve, caps, duration, and anti-whale limits.' },
		{ n: '02', label: 'Launch', desc: 'Deposit tokens and go live. Participants buy in along the bonding curve at fair, transparent prices.' },
		{ n: '03', label: 'Finalize', desc: 'Once the hard cap or deadline is reached, finalize the launch and distribute tokens to all participants.' }
	];

	const tokenTypes = [
		{ label: 'Basic', fee: '10', desc: 'Standard ERC-20 token' },
		{ label: 'Mintable', fee: '20', desc: 'Mint new tokens + burn' },
		{ label: 'Taxable', fee: '25', desc: 'Custom buy/sell/transfer tax' },
		{ label: 'Taxable + Mintable', fee: '35', desc: 'Full tax + mint & burn' },
		{ label: 'Partner', fee: '15', desc: 'Featured + auto DEX pools' },
		{ label: 'Partner + Mintable', fee: '25', desc: 'Partner perks + mint & burn' },
		{ label: 'Partner + Taxable', fee: '30', desc: 'Partner perks + custom tax' },
		{ label: 'Partner + Tax + Mint', fee: '40', desc: 'Every feature combined' }
	];
</script>

<svelte:head>
	<title>TokenKrafter - Fair Launch Your Token With Bonding Curves</title>
	<meta name="description" content="Launch your token with bonding curve pricing, soft/hard caps, anti-whale limits, and vesting. Fair, transparent token launches on BSC and more." />
</svelte:head>

<div class="page-wrap">
	<!-- Hero -->
	<section class="hero-section">
		<div class="max-w-4xl mx-auto text-center px-4 sm:px-6">
			<div class="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-cyan-500/25 bg-cyan-500/8 mb-8">
				<div class="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse"></div>
				<span class="text-cyan-400 text-xs font-mono uppercase tracking-widest">Fair Token Launchpad</span>
			</div>

			<h1 class="hero-title syne">
				Fair Launch Your Token<br /><span class="gradient-text">With Bonding Curves</span>
			</h1>

			<p class="hero-sub font-mono">
				Launch your token with transparent bonding curve pricing, built-in soft/hard caps, anti-whale limits, and vesting — giving every participant a fair shot.
			</p>

			<div class="flex flex-wrap gap-4 justify-center mt-10">
				<a href="/launchpad" class="btn-primary text-sm px-6 py-3 no-underline">
					Explore Launches →
				</a>
				<a href="/launchpad/create" class="btn-secondary text-sm px-6 py-3 no-underline">
					Start a Launch
				</a>
			</div>

			<!-- Stats Bar -->
			<div class="stats-bar mt-16 grid grid-cols-2 sm:grid-cols-4 gap-4">
				{#each [['Fair', 'Bonding Curves'], ['Anti-Whale', 'Buy Limits'], ['Vesting', 'Built-In'], ['Multi', 'Chain Support']] as [val, label]}
					<div class="stat-item card p-4 text-center">
						<div class="syne text-2xl font-bold text-white">{val}</div>
						<div class="text-xs text-gray-500 mt-1 font-mono">{label}</div>
					</div>
				{/each}
			</div>
			<p class="text-xs text-gray-600 mt-2 font-mono">Transparent launches with bonding curve pricing — no presales, no insider advantages</p>
		</div>
	</section>

	<!-- Features -->
	<section class="section max-w-6xl mx-auto px-4 sm:px-6">
		<div class="text-center mb-12">
			<h2 class="syne text-3xl sm:text-4xl font-bold text-white">Built for Fair Launches</h2>
			<p class="text-gray-400 mt-3 font-mono text-sm">Everything you need to run a transparent, community-driven token launch.</p>
		</div>

		<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
			{#each features as f}
				<div class="feature-card card card-hover p-6 group">
					<div class="feature-icon-box {f.color} mb-4">{f.icon}</div>
					<h3 class="syne font-bold text-white mb-2">{f.title}</h3>
					<p class="text-sm text-gray-400 leading-relaxed font-mono">{f.desc}</p>
				</div>
			{/each}
		</div>
	</section>

	<!-- Pricing -->
	<section class="section max-w-5xl mx-auto px-4 sm:px-6">
		<div class="text-center mb-12">
			<h2 class="syne text-3xl sm:text-4xl font-bold text-white">Token Creation Pricing</h2>
			<p class="text-gray-400 mt-3 font-mono text-sm">Need a token first? One-time creation fee in USDT equivalent. No hidden costs.</p>
		</div>

		<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
			{#each tokenTypes as t}
				<div class="pricing-card card p-5">
					<div class="text-xs text-gray-500 font-mono uppercase tracking-wide mb-1">{t.desc}</div>
					<div class="syne font-bold text-white text-lg mb-1">{t.label}</div>
					<div class="pricing-amount">
						<span class="syne text-2xl font-black text-cyan-400">${t.fee}</span>
						<span class="text-xs text-gray-500 font-mono ml-1">USDT</span>
					</div>
				</div>
			{/each}
		</div>
	</section>

	<!-- How it Works -->
	<section class="section max-w-5xl mx-auto px-4 sm:px-6">
		<div class="text-center mb-12">
			<h2 class="syne text-3xl sm:text-4xl font-bold text-white">How It Works</h2>
			<p class="text-gray-400 mt-3 font-mono text-sm">From idea to fair launch in three steps.</p>
		</div>

		<div class="grid grid-cols-1 sm:grid-cols-3 gap-4 relative">
			{#each steps as step}
				<div class="step-card card p-6 relative">
					<div class="step-num syne text-5xl font-black text-white/5 absolute top-4 right-4">{step.n}</div>
					<div class="text-cyan-400 text-xs font-mono uppercase tracking-widest mb-2">{step.n}</div>
					<h3 class="syne font-bold text-white mb-2">{step.label}</h3>
					<p class="text-sm text-gray-400 font-mono leading-relaxed">{step.desc}</p>
				</div>
			{/each}
		</div>
	</section>

	<!-- Partner Highlight -->
	<section class="section max-w-3xl mx-auto px-4 sm:px-6">
		<div class="partner-highlight card p-8 sm:p-10 relative overflow-hidden">
			<div class="partner-glow absolute inset-0 pointer-events-none"></div>
			<div class="relative">
				<div class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-purple-500/30 bg-purple-500/10 mb-5">
					<span class="text-purple-400 text-xs font-mono uppercase tracking-widest">Partnership Program</span>
				</div>
				<h2 class="syne text-2xl sm:text-3xl font-bold text-white mb-3">Boost Your Launch</h2>
				<p class="text-gray-400 font-mono text-sm mb-6 leading-relaxed max-w-xl">
					Create a partner token and get featured across our launchpad, auto-created DEX liquidity pools, and priority marketing support. In exchange, a 1% fee applies on buy and sell trades.
				</p>
				<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
					{#each [
						'Featured on homepage & explore page',
						'Auto-created DEX liquidity pools',
						'Promoted across social channels',
						'Priority support & marketing guidance'
					] as perk}
						<div class="flex items-start gap-2">
							<span class="text-purple-400 font-bold text-sm mt-0.5">+</span>
							<span class="text-sm text-purple-200/80 font-mono">{perk}</span>
						</div>
					{/each}
				</div>
				<a href="/create" class="btn-partner mt-8 inline-block no-underline">
					Create a Partner Token →
				</a>
			</div>
		</div>
	</section>

	<!-- CTA -->
	<section class="section max-w-2xl mx-auto px-4 sm:px-6 text-center pb-24">
		<div class="cta-card card p-10 sm:p-14 relative overflow-hidden">
			<div class="cta-glow absolute inset-0 pointer-events-none"></div>
			<h2 class="syne text-3xl sm:text-4xl font-bold text-white mb-4 relative">Ready to Launch?</h2>
			<p class="text-gray-400 font-mono text-sm mb-8 relative">Set up your bonding curve, configure your caps, and go live. Fair launches start here.</p>
			<a href="/launchpad/create" class="btn-primary text-sm px-8 py-3 no-underline inline-block relative">
				Start Your Launch →
			</a>
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
		background: linear-gradient(135deg, #00d2ff, #a78bfa);
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

	/* Feature icons */
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
	.feature-icon-box.cyan {
		background: rgba(0,210,255,0.1);
		color: #00d2ff;
		border: 1px solid rgba(0,210,255,0.2);
	}
	.feature-icon-box.orange {
		background: rgba(251,146,60,0.1);
		color: #fb923c;
		border: 1px solid rgba(251,146,60,0.2);
	}
	.feature-icon-box.emerald {
		background: rgba(16,185,129,0.1);
		color: #10b981;
		border: 1px solid rgba(16,185,129,0.2);
	}
	.feature-icon-box.purple {
		background: rgba(139,92,246,0.1);
		color: #a78bfa;
		border: 1px solid rgba(139,92,246,0.2);
	}

	.feature-card {
		transition: all 0.25s;
	}
	.feature-card:hover {
		transform: translateY(-3px);
		box-shadow: 0 12px 40px rgba(0,0,0,0.3);
	}

	/* Pricing */
	.pricing-card {
		transition: all 0.2s;
		border-color: var(--border);
	}
	.pricing-card:hover {
		border-color: rgba(0,210,255,0.2);
		background: rgba(0,210,255,0.03);
		transform: translateY(-2px);
	}
	.pricing-amount {
		margin-top: 8px;
		display: flex;
		align-items: baseline;
	}

	/* Partner section */
	.partner-highlight {
		background: rgba(139,92,246,0.04);
		border-color: rgba(139,92,246,0.2);
	}
	.partner-glow {
		background: radial-gradient(ellipse at 50% 0%, rgba(139,92,246,0.1), transparent 70%);
	}
	.btn-partner {
		display: inline-block;
		background: linear-gradient(135deg, #8b5cf6, #a78bfa);
		color: var(--text-heading);
		font-weight: 700;
		padding: 12px 24px;
		border-radius: 10px;
		border: none;
		cursor: pointer;
		transition: all 0.2s;
		font-family: 'Syne', sans-serif;
		font-size: 14px;
	}
	.btn-partner:hover {
		transform: translateY(-1px);
		box-shadow: 0 6px 28px rgba(139,92,246,0.35);
	}

	/* CTA */
	.cta-card {
		background: rgba(0,210,255,0.04);
		border-color: rgba(0,210,255,0.15);
	}

	.cta-glow {
		background: radial-gradient(ellipse at 50% 0%, rgba(0,210,255,0.08), transparent 70%);
	}

	a.no-underline { text-decoration: none; }
</style>
