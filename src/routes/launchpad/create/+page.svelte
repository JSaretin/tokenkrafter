<script lang="ts">
	import { ethers } from 'ethers';
	import { getContext } from 'svelte';
	import { goto } from '$app/navigation';
	import type { SupportedNetwork, PaymentOption } from '$lib/structure';
	import { ERC20_ABI, ZERO_ADDRESS } from '$lib/tokenCrafter';
	import {
		LAUNCHPAD_FACTORY_ABI,
		LAUNCH_INSTANCE_ABI,
		CURVE_TYPES
	} from '$lib/launchpad';
	import BondingCurveChart from '$lib/BondingCurveChart.svelte';

	let getSigner: () => ethers.Signer | null = getContext('signer');
	let getUserAddress: () => string | null = getContext('userAddress');
	let connectWallet: () => Promise<boolean> = getContext('connectWallet');
	const addFeedback = getContext<(f: { message: string; type: string }) => void>('addFeedback');
	const supportedNetworks: SupportedNetwork[] = getContext('supportedNetworks');
	let getNetworkProviders: () => Map<number, ethers.JsonRpcProvider> = getContext('networkProviders');
	let getPaymentOptions: (network: SupportedNetwork) => PaymentOption[] = getContext('getPaymentOptions');

	let signer = $derived(getSigner());
	let userAddress = $derived(getUserAddress());
	let networkProviders = $derived(getNetworkProviders());

	const launchpadNetworks = supportedNetworks.filter(
		(n) => n.launchpad_address && n.launchpad_address !== '0x'
	);

	// Form state
	let selectedNetworkIdx = $state(0);
	let tokenAddress = $state('');
	let tokenName = $state('');
	let tokenSymbol = $state('');
	let tokenDecimals = $state(18);
	let tokenBalance = $state(0n);
	let tokenLoading = $state(false);
	let tokensForLaunch = $state('');
	let curveType = $state(0);
	let softCap = $state('');
	let hardCap = $state('');
	let durationDays = $state('30');
	let maxBuyBps = $state('200');
	let creatorAllocationBps = $state('0');
	let vestingDays = $state('0');
	let selectedPaymentIdx = $state(0);
	let scheduledStart = $state(false);
	let startDate = $state('');

	// Off-chain metadata
	let description = $state('');
	let logoUrl = $state('');
	let website = $state('');
	let twitter = $state('');
	let telegram = $state('');
	let discord = $state('');

	let isCreating = $state(false);
	let step = $state<'form' | 'review' | 'creating' | 'depositing' | 'done'>('form');
	let launchAddress = $state('');

	let selectedNetwork = $derived(launchpadNetworks[selectedNetworkIdx]);
	let paymentOptions = $derived(selectedNetwork ? getPaymentOptions(selectedNetwork) : []);

	// Fee
	let launchFee = $state(0n);
	let feeLoading = $state(false);

	// Auto-fetch token metadata when address changes
	let fetchTimeout: ReturnType<typeof setTimeout> | null = null;
	$effect(() => {
		if (fetchTimeout) clearTimeout(fetchTimeout);
		const addr = tokenAddress;
		if (!addr || !ethers.isAddress(addr) || !selectedNetwork) {
			tokenName = '';
			tokenSymbol = '';
			tokenBalance = 0n;
			return;
		}
		fetchTimeout = setTimeout(async () => {
			tokenLoading = true;
			try {
				const provider = networkProviders.get(selectedNetwork.chain_id);
				if (!provider) return;
				const token = new ethers.Contract(addr, [
					'function name() view returns (string)',
					'function symbol() view returns (string)',
					'function decimals() view returns (uint8)',
					'function balanceOf(address) view returns (uint256)'
				], provider);
				const [name, symbol, dec, bal] = await Promise.all([
					token.name().catch(() => ''),
					token.symbol().catch(() => ''),
					token.decimals().catch(() => 18),
					userAddress ? token.balanceOf(userAddress).catch(() => 0n) : Promise.resolve(0n)
				]);
				tokenName = name;
				tokenSymbol = symbol;
				tokenDecimals = Number(dec);
				tokenBalance = bal;
			} catch {
				tokenName = '';
				tokenSymbol = '';
			} finally {
				tokenLoading = false;
			}
		}, 500);
	});

	// Fetch launch fee when network or payment token changes
	$effect(() => {
		const net = selectedNetwork;
		const payIdx = selectedPaymentIdx;
		if (!net || paymentOptions.length === 0) return;
		const opt = paymentOptions[payIdx];
		if (!opt) return;

		(async () => {
			feeLoading = true;
			try {
				const provider = networkProviders.get(net.chain_id);
				if (!provider) return;
				const factory = new ethers.Contract(net.launchpad_address, LAUNCHPAD_FACTORY_ABI, provider);
				launchFee = await factory.getLaunchFee(opt.address);
			} catch {
				launchFee = 0n;
			} finally {
				feeLoading = false;
			}
		})();
	});

	function tokensForLaunchBigInt(): bigint {
		if (!tokensForLaunch) return 0n;
		try {
			return ethers.parseUnits(String(tokensForLaunch), tokenDecimals);
		} catch {
			return 0n;
		}
	}

	let launchPercent = $derived.by(() => {
		if (!tokensForLaunch || tokenBalance === 0n) return 0;
		try {
			const launch = tokensForLaunchBigInt();
			if (launch === 0n) return 0;
			return Math.min(100, Number((launch * 100n) / tokenBalance));
		} catch {
			return 0;
		}
	});

	function setLaunchPercent(pct: number) {
		if (tokenBalance === 0n) return;
		const amount = (tokenBalance * BigInt(pct)) / 100n;
		tokensForLaunch = ethers.formatUnits(amount, tokenDecimals);
	}

	let startTimestampValue = $derived.by(() => {
		if (!scheduledStart || !startDate) return 0n;
		const ts = Math.floor(new Date(startDate).getTime() / 1000);
		return ts > 0 ? BigInt(ts) : 0n;
	});

	function validate(): string | null {
		if (!ethers.isAddress(tokenAddress)) return 'Invalid token address';
		if (!tokenName) return 'Could not fetch token info';
		if (!tokensForLaunch || parseFloat(tokensForLaunch) <= 0) return 'Enter tokens for launch';
		if (tokensForLaunchBigInt() > tokenBalance) return 'Insufficient token balance';
		if (!softCap || parseFloat(softCap) <= 0) return 'Enter soft cap';
		if (!hardCap || parseFloat(hardCap) <= 0) return 'Enter hard cap';
		if (parseFloat(hardCap) < parseFloat(softCap)) return 'Hard cap must be >= soft cap';
		if (scheduledStart) {
			if (!startDate) return 'Select a start date';
			if (startTimestampValue <= BigInt(Math.floor(Date.now() / 1000))) return 'Start date must be in the future';
		}
		return null;
	}

	function goToReview() {
		const err = validate();
		if (err) {
			addFeedback({ message: err, type: 'error' });
			return;
		}
		step = 'review';
	}

	async function handleCreate() {
		if (!signer || !userAddress) {
			connectWallet();
			return;
		}

		const err = validate();
		if (err) {
			addFeedback({ message: err, type: 'error' });
			return;
		}

		isCreating = true;
		step = 'creating';

		try {
			const net = selectedNetwork;
			const payOpt = paymentOptions[selectedPaymentIdx];
			const isNative = payOpt.address === ZERO_ADDRESS;

			// If ERC20 payment for launch fee, approve LaunchpadFactory
			if (!isNative && launchFee > 0n) {
				const erc20 = new ethers.Contract(payOpt.address, ERC20_ABI, signer);
				const allowance = await erc20.allowance(userAddress, net.launchpad_address);
				if (allowance < launchFee) {
					addFeedback({ message: `Approving ${payOpt.symbol} for launch fee...`, type: 'info' });
					const approveTx = await erc20.approve(net.launchpad_address, launchFee);
					await approveTx.wait();
				}
			}

			const factory = new ethers.Contract(net.launchpad_address, LAUNCHPAD_FACTORY_ABI, signer);
			const txOptions = isNative && launchFee > 0n ? { value: launchFee } : {};

			addFeedback({ message: 'Creating launch...', type: 'info' });
			const tx = await factory.createLaunch(
				tokenAddress,
				tokensForLaunchBigInt(),
				BigInt(curveType),
				ethers.parseUnits(String(softCap), 18),
				ethers.parseUnits(String(hardCap), 18),
				BigInt(durationDays),
				BigInt(maxBuyBps),
				BigInt(creatorAllocationBps),
				BigInt(vestingDays),
				payOpt.address,
				startTimestampValue,
				txOptions
			);
			const receipt = await tx.wait();

			// Extract launch address from event
			const createdEvent = receipt?.logs?.find((log: any) => {
				try {
					const parsed = factory.interface.parseLog({ topics: [...log.topics], data: log.data });
					return parsed?.name === 'LaunchCreated';
				} catch {
					return false;
				}
			});
			if (createdEvent) {
				const parsed = factory.interface.parseLog({ topics: [...createdEvent.topics], data: createdEvent.data });
				launchAddress = parsed?.args?.launch ?? '';
			}

			addFeedback({ message: 'Launch created! Now deposit tokens to activate.', type: 'success' });

			// Auto-deposit: approve token + deposit
			step = 'depositing';
			const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
			const totalTokens = tokensForLaunchBigInt();

			const allowance = await tokenContract.allowance(userAddress, launchAddress);
			if (allowance < totalTokens) {
				addFeedback({ message: `Approving ${tokenSymbol}...`, type: 'info' });
				const approveTx = await tokenContract.approve(launchAddress, totalTokens);
				await approveTx.wait();
			}

			const instance = new ethers.Contract(launchAddress, LAUNCH_INSTANCE_ABI, signer);
			addFeedback({ message: 'Depositing tokens...', type: 'info' });
			const depositTx = await instance.depositTokens(totalTokens);
			await depositTx.wait();

			addFeedback({ message: 'Launch is live!', type: 'success' });

			// Save to database (best-effort, don't block on failure)
			try {
				await fetch('/api/launches', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						address: launchAddress,
						chain_id: selectedNetwork.chain_id,
						token_address: tokenAddress,
						creator: userAddress,
						curve_type: curveType,
						state: 1,
						soft_cap: ethers.parseUnits(String(softCap), 18).toString(),
						hard_cap: ethers.parseUnits(String(hardCap), 18).toString(),
						tokens_for_curve: tokensForLaunchBigInt().toString(),
						creator_allocation_bps: parseInt(creatorAllocationBps),
						deadline: Math.floor(Date.now() / 1000) + parseInt(durationDays) * 86400,
						start_timestamp: Number(startTimestampValue),
						total_tokens_required: tokensForLaunchBigInt().toString(),
						total_tokens_deposited: tokensForLaunchBigInt().toString(),
						token_name: tokenName,
						token_symbol: tokenSymbol,
						token_decimals: tokenDecimals,
						description: description || undefined,
						logo_url: logoUrl || undefined,
						website: website || undefined,
						twitter: twitter || undefined,
						telegram: telegram || undefined,
						discord: discord || undefined
					})
				});
			} catch {}

			step = 'done';
		} catch (e: any) {
			const errData = String(e?.data || e?.message || e?.shortMessage || '');
			const knownErrors: Record<string, string> = {
				'0xc1b18801': 'This token already has a launch. Each token can only have one active launch.',
				'0x59dc379f': 'Only the token owner can create a launch.',
				'0x5c9e11e8': 'Invalid caps. Hard cap must be >= soft cap and both must be > 0.',
				'0x76166401': 'Invalid duration. Must be between 7 and 90 days.',
				'0x0bc4ed45': 'Invalid max buy. Must be between 0.5% and 5%.',
				'0xb1bb0391': 'Invalid creator allocation. Must be 0-5%.',
				'0x8bdb5381': 'Invalid vesting. Must be 0, 30, 60, or 90 days.',
			};
			const matched = Object.entries(knownErrors).find(([sel]) => errData.includes(sel));
			addFeedback({ message: matched ? matched[1] : (e.shortMessage || e.message || 'Failed'), type: 'error' });
			step = 'form';
		} finally {
			isCreating = false;
		}
	}
</script>

<svelte:head>
	<title>Create Launch | TokenKrafter Launchpad</title>
</svelte:head>

<div class="page-wrap max-w-3xl mx-auto px-4 sm:px-6 py-12">
	<a
		href="/launchpad"
		class="text-gray-500 hover:text-cyan-400 text-sm font-mono transition no-underline mb-6 inline-block"
	>
		← Back to Launchpad
	</a>

	<h1 class="syne text-3xl font-bold text-white mb-2">Create a Launch</h1>
	<p class="text-gray-400 font-mono text-sm mb-8">
		Launch an existing token on a bonding curve. Users buy at rising prices, then the launch
		auto-graduates to DEX with permanent liquidity.
	</p>

	{#if step === 'done'}
		<div class="card p-8 text-center">
			<div class="text-5xl mb-4 syne font-bold text-emerald-400">Live!</div>
			<h2 class="syne text-2xl font-bold text-white mb-2">Launch Created & Activated</h2>
			<p class="text-gray-400 font-mono text-sm mb-6">
				Your {tokenSymbol} token is now live on the bonding curve.
			</p>
			{#if launchAddress}
				<a
					href="/launchpad/{launchAddress}"
					class="btn-primary text-sm px-6 py-3 no-underline inline-block"
				>
					View Launch →
				</a>
			{/if}
		</div>
	{:else if step === 'creating' || step === 'depositing'}
		<div class="card p-8 text-center">
			<div class="spinner w-12 h-12 rounded-full border-2 border-white/10 border-t-cyan-400 mx-auto mb-6"></div>
			<p class="text-cyan-300 font-mono text-sm">
				{step === 'creating' ? 'Creating launch contract...' : 'Depositing tokens...'}
			</p>
		</div>
	{:else if step === 'review'}
		<!-- Review -->
		<div class="card p-6">
			<div class="flex justify-between items-center mb-6">
				<h2 class="syne text-xl font-bold text-white">Review Launch</h2>
				<button onclick={() => (step = 'form')} class="text-gray-500 hover:text-white text-sm font-mono transition cursor-pointer">
					Edit
				</button>
			</div>

			<div class="detail-grid mb-6">
				<div class="detail-row">
					<span class="detail-label">Token</span>
					<span class="detail-value">{tokenName} ({tokenSymbol})</span>
				</div>
				<div class="detail-row">
					<span class="detail-label">Network</span>
					<span class="detail-value text-cyan-300">{selectedNetwork.name}</span>
				</div>
				<div class="detail-row">
					<span class="detail-label">Tokens for launch</span>
					<span class="detail-value">{Number(tokensForLaunch).toLocaleString()} {tokenSymbol}</span>
				</div>
				<div class="detail-row">
					<span class="detail-label">Curve</span>
					<span class="detail-value">{CURVE_TYPES[curveType]}</span>
				</div>
				<div class="detail-row">
					<span class="detail-label">Soft Cap</span>
					<span class="detail-value">${softCap} USDT</span>
				</div>
				<div class="detail-row">
					<span class="detail-label">Hard Cap</span>
					<span class="detail-value">${hardCap} USDT</span>
				</div>
				<div class="detail-row">
					<span class="detail-label">Duration</span>
					<span class="detail-value">{durationDays} days</span>
				</div>
				<div class="detail-row">
					<span class="detail-label">Max buy</span>
					<span class="detail-value">{(parseInt(maxBuyBps) / 100).toFixed(1)}% of curve</span>
				</div>
				{#if scheduledStart && startDate}
					<div class="detail-row">
						<span class="detail-label">Starts</span>
						<span class="detail-value">{new Date(startDate).toLocaleString()}</span>
					</div>
				{/if}
				<div class="detail-row">
					<span class="detail-label">Creator alloc</span>
					<span class="detail-value">{(parseInt(creatorAllocationBps) / 100).toFixed(1)}%</span>
				</div>
				{#if parseInt(creatorAllocationBps) > 0}
					<div class="detail-row">
						<span class="detail-label">Vesting</span>
						<span class="detail-value">{vestingDays} days</span>
					</div>
				{/if}
				{#if description}
					<div class="detail-row">
						<span class="detail-label">Description</span>
						<span class="detail-value text-sm" style="max-width: 60%; text-align: right;">{description.slice(0, 80)}{description.length > 80 ? '...' : ''}</span>
					</div>
				{/if}
				{#if website || twitter || telegram || discord}
					<div class="detail-row">
						<span class="detail-label">Socials</span>
						<span class="detail-value text-xs">
							{[website && 'Web', twitter && 'Twitter', telegram && 'TG', discord && 'Discord'].filter(Boolean).join(' · ')}
						</span>
					</div>
				{/if}
			</div>

			{#if launchFee > 0n}
				<div class="fee-section mb-4">
					<div class="flex justify-between items-center">
						<span class="text-gray-500 text-xs font-mono">Launch Fee</span>
						<span class="text-white text-sm font-mono font-bold">
							{feeLoading
								? '...'
								: parseFloat(
										ethers.formatUnits(launchFee, paymentOptions[selectedPaymentIdx]?.decimals ?? 18)
									).toFixed(4) + ' ' + (paymentOptions[selectedPaymentIdx]?.symbol ?? '')}
						</span>
					</div>
				</div>
			{/if}

			<div class="info-notice mb-4">
				<p class="text-gray-400 text-xs font-mono">
					After creation, you'll be prompted to approve and deposit tokens. The launch activates automatically once tokens are deposited.
				</p>
			</div>

			<button onclick={handleCreate} disabled={isCreating} class="btn-primary w-full py-3 text-sm cursor-pointer">
				{isCreating ? 'Creating...' : 'Create & Fund Launch'}
			</button>
		</div>
	{:else}
		<!-- Form -->
		<div class="card p-6">
			<!-- Network -->
			<div class="field-group mb-5">
				<label class="label-text" for="network">Network</label>
				<select id="network" class="input-field" bind:value={selectedNetworkIdx}>
					{#each launchpadNetworks as net, i}
						<option value={i}>{net.name} ({net.native_coin})</option>
					{/each}
				</select>
			</div>

			<!-- Token Address -->
			<div class="field-group mb-5">
				<label class="label-text" for="token-addr">Token Address</label>
				<input
					id="token-addr"
					type="text"
					class="input-field"
					placeholder="0x..."
					bind:value={tokenAddress}
				/>
				{#if tokenLoading}
					<span class="text-gray-500 text-xs font-mono mt-1">Loading token info...</span>
				{:else if tokenName}
					<div class="token-info-bar mt-2">
						<span class="text-emerald-400 text-xs font-mono">{tokenName} ({tokenSymbol})</span>
						{#if userAddress}
							<span class="text-gray-500 text-xs font-mono">
								Balance: {parseFloat(ethers.formatUnits(tokenBalance, tokenDecimals)).toLocaleString()}
							</span>
						{/if}
					</div>
				{/if}
			</div>

			<!-- Tokens for Launch -->
			<div class="field-group mb-5">
				<label class="label-text" for="tokens-launch">Tokens for Launch</label>
				<input
					id="tokens-launch"
					type="text"
					inputmode="decimal"
					class="input-field"
					placeholder="e.g. 400000"
					bind:value={tokensForLaunch}
				/>
				{#if tokenBalance > 0n}
					<div class="pct-buttons mt-2">
						{#each [25, 50, 75, 100] as pct}
							<button
								type="button"
								class="pct-btn"
								class:pct-btn-active={launchPercent === pct}
								onclick={() => setLaunchPercent(pct)}
							>
								{pct === 100 ? 'MAX' : pct + '%'}
							</button>
						{/each}
					</div>
				{/if}
				{#if tokenBalance > 0n && tokensForLaunch}
					{@const pct = launchPercent}
					{@const exceeds = tokensForLaunchBigInt() > tokenBalance}
					<div class="supply-bar mt-2" class:supply-bar-error={exceeds}>
						<div class="flex justify-between text-[10px] font-mono mb-1">
							<span class="{exceeds ? 'text-red-400' : 'text-gray-500'}">{exceeds ? 'Exceeds balance!' : pct + '% of your balance'}</span>
							<span class="text-gray-400">
								{parseFloat(String(tokensForLaunch)).toLocaleString()} / {parseFloat(ethers.formatUnits(tokenBalance, tokenDecimals)).toLocaleString()} {tokenSymbol}
							</span>
						</div>
						<div class="progress-track">
							<div class="progress-fill {exceeds ? 'progress-red' : ''}" style="width: {pct}%"></div>
						</div>
						<div class="flex justify-between text-[10px] font-mono mt-1.5">
							<span class="text-gray-600">70% curve</span>
							<span class="text-gray-600">{parseInt(creatorAllocationBps) > 0 ? (100 - 70 - parseInt(creatorAllocationBps) / 100) + '% LP · ' + (parseInt(creatorAllocationBps) / 100) + '% creator' : '30% LP'}</span>
						</div>
					</div>
				{/if}
			</div>

			<hr class="divider" />

			<!-- Curve Type -->
			<div class="field-group mb-5">
				<label class="label-text" for="curve">Curve Type</label>
				<select id="curve" class="input-field" bind:value={curveType}>
					{#each CURVE_TYPES as ct, i}
						<option value={i}>{ct}</option>
					{/each}
				</select>
				<span class="text-gray-600 text-[10px] font-mono mt-1">
					{#if curveType === 0}
						Steady price increase. Good for predictable pricing.
					{:else if curveType === 1}
						Slower price growth. Favors early buyers moderately.
					{:else if curveType === 2}
						Aggressive price curve. Strong FOMO effect.
					{:else}
						Exponential growth. Maximum early-buyer advantage.
					{/if}
				</span>
				<div class="mt-3">
					<BondingCurveChart curveType={curveType} width={260} height={140} />
				</div>
			</div>

			<!-- Caps -->
			<div class="grid grid-cols-2 gap-4 mb-5">
				<div class="field-group">
					<label class="label-text" for="soft-cap">Soft Cap (USDT)</label>
					<input id="soft-cap" type="number" class="input-field" placeholder="5" bind:value={softCap} step="any" min="0" />
				</div>
				<div class="field-group">
					<label class="label-text" for="hard-cap">Hard Cap (USDT)</label>
					<input id="hard-cap" type="number" class="input-field" placeholder="50" bind:value={hardCap} step="any" min="0" />
				</div>
			</div>

			<!-- Duration + Max Buy -->
			<div class="grid grid-cols-2 gap-4 mb-5">
				<div class="field-group">
					<label class="label-text" for="duration">Duration (days)</label>
					<select id="duration" class="input-field" bind:value={durationDays}>
						{#each [7, 14, 21, 30, 45, 60, 90] as d}
							<option value={String(d)}>{d} days</option>
						{/each}
					</select>
				</div>
				<div class="field-group">
					<label class="label-text" for="max-buy">Max Buy per Wallet</label>
					<select id="max-buy" class="input-field" bind:value={maxBuyBps}>
						<option value="50">0.5%</option>
						<option value="100">1%</option>
						<option value="200">2%</option>
						<option value="300">3%</option>
						<option value="500">5%</option>
					</select>
				</div>
			</div>

			<!-- Scheduled Start -->
			<div class="field-group mb-5">
				<label class="label-text">
					<input type="checkbox" bind:checked={scheduledStart} class="mr-2 accent-cyan-400" />
					Schedule future start
				</label>
				<span class="text-gray-600 text-[10px] font-mono mt-1">
					If enabled, buying won't start until the scheduled date. Otherwise it starts immediately after token deposit.
				</span>
				{#if scheduledStart}
					<input
						type="datetime-local"
						class="input-field mt-2"
						bind:value={startDate}
						min={new Date(Date.now() + 60000).toISOString().slice(0, 16)}
					/>
					{#if startDate}
						{@const ts = Math.floor(new Date(startDate).getTime() / 1000)}
						{@const now = Math.floor(Date.now() / 1000)}
						<span class="text-gray-500 text-[10px] font-mono mt-1">
							{ts > now ? `Starts in ${Math.floor((ts - now) / 86400)}d ${Math.floor(((ts - now) % 86400) / 3600)}h` : 'Must be in the future'}
						</span>
					{/if}
				{/if}
			</div>

			<hr class="divider" />

			<!-- Creator Allocation -->
			<div class="grid grid-cols-2 gap-4 mb-5">
				<div class="field-group">
					<label class="label-text" for="creator-alloc">Creator Allocation</label>
					<select id="creator-alloc" class="input-field" bind:value={creatorAllocationBps}>
						<option value="0">None (0%)</option>
						<option value="100">1%</option>
						<option value="200">2%</option>
						<option value="300">3%</option>
						<option value="500">5%</option>
					</select>
				</div>
				{#if parseInt(creatorAllocationBps) > 0}
					<div class="field-group">
						<label class="label-text" for="vesting">Vesting Period</label>
						<select id="vesting" class="input-field" bind:value={vestingDays}>
							<option value="30">30 days</option>
							<option value="60">60 days</option>
							<option value="90">90 days</option>
						</select>
					</div>
				{/if}
			</div>

			<hr class="divider" />

			<!-- Project Metadata (optional) -->
			<div class="mb-1">
				<span class="label-text">Project Info (optional)</span>
				<p class="text-gray-600 text-[10px] font-mono mb-4">Help participants learn about your project. Shown on your launch page.</p>
			</div>

			<div class="field-group mb-4">
				<label class="label-text" for="description">Description</label>
				<textarea
					id="description"
					class="input-field"
					rows="3"
					placeholder="What is your token about?"
					bind:value={description}
					style="resize: vertical; min-height: 60px;"
				></textarea>
			</div>

			<div class="field-group mb-4">
				<label class="label-text" for="logo-url">Logo URL</label>
				<input id="logo-url" type="url" class="input-field" placeholder="https://example.com/logo.png" bind:value={logoUrl} />
			</div>

			<div class="grid grid-cols-2 gap-4 mb-4">
				<div class="field-group">
					<label class="label-text" for="website">Website</label>
					<input id="website" type="url" class="input-field" placeholder="https://..." bind:value={website} />
				</div>
				<div class="field-group">
					<label class="label-text" for="twitter">Twitter / X</label>
					<input id="twitter" type="text" class="input-field" placeholder="@handle or URL" bind:value={twitter} />
				</div>
			</div>

			<div class="grid grid-cols-2 gap-4 mb-5">
				<div class="field-group">
					<label class="label-text" for="telegram">Telegram</label>
					<input id="telegram" type="text" class="input-field" placeholder="t.me/group or @handle" bind:value={telegram} />
				</div>
				<div class="field-group">
					<label class="label-text" for="discord">Discord</label>
					<input id="discord" type="text" class="input-field" placeholder="discord.gg/invite" bind:value={discord} />
				</div>
			</div>

			<hr class="divider" />

			<!-- Payment for launch fee -->
			{#if paymentOptions.length > 0}
				<div class="field-group mb-5">
					<label class="label-text" for="payment">Launch Fee Payment</label>
					<select id="payment" class="input-field" bind:value={selectedPaymentIdx}>
						{#each paymentOptions as opt, i}
							<option value={i}>{opt.name}</option>
						{/each}
					</select>
					{#if launchFee > 0n}
						<span class="text-gray-500 text-xs font-mono mt-1">
							Fee: {parseFloat(
								ethers.formatUnits(launchFee, paymentOptions[selectedPaymentIdx]?.decimals ?? 18)
							).toFixed(4)}
							{paymentOptions[selectedPaymentIdx]?.symbol ?? ''}
						</span>
					{:else if !feeLoading}
						<span class="text-emerald-400 text-xs font-mono mt-1">No launch fee</span>
					{/if}
				</div>
			{/if}

			<button onclick={goToReview} class="btn-primary w-full py-3 text-sm cursor-pointer">
				Review Launch
			</button>
		</div>
	{/if}
</div>

<style>
	.page-wrap {
		padding-bottom: 40px;
	}
	.no-underline {
		text-decoration: none;
	}

	.field-group {
		display: flex;
		flex-direction: column;
	}

	.token-info-bar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 8px 12px;
		background: rgba(16, 185, 129, 0.05);
		border: 1px solid rgba(16, 185, 129, 0.15);
		border-radius: 8px;
	}

	.detail-grid {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.detail-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	.detail-label {
		font-size: 12px;
		color: #6b7280;
		font-family: 'Space Mono', monospace;
	}
	.detail-value {
		font-size: 13px;
		color: var(--text);
		font-family: 'Space Mono', monospace;
		font-weight: 600;
	}

	.fee-section {
		padding: 12px;
		background: rgba(0, 210, 255, 0.03);
		border: 1px solid rgba(0, 210, 255, 0.1);
		border-radius: 10px;
	}

	.info-notice {
		padding: 10px 12px;
		background: rgba(245, 158, 11, 0.05);
		border: 1px solid rgba(245, 158, 11, 0.12);
		border-radius: 8px;
	}

	.spinner {
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	.syne {
		font-family: 'Syne', sans-serif;
	}
	.label-text {
		font-size: 12px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: #94a3b8;
		display: block;
		margin-bottom: 6px;
	}
	.divider {
		border: none;
		border-top: 1px solid var(--bg-surface-hover);
		margin: 20px 0;
	}

	.pct-buttons {
		display: flex;
		gap: 6px;
	}
	.pct-btn {
		flex: 1;
		padding: 6px 0;
		font-size: 11px;
		font-family: 'Space Mono', monospace;
		font-weight: 600;
		color: #94a3b8;
		background: var(--bg-surface-hover);
		border: 1px solid var(--border);
		border-radius: 6px;
		cursor: pointer;
		transition: all 0.15s ease;
		text-align: center;
	}
	.pct-btn:hover {
		color: #00d2ff;
		border-color: rgba(0, 210, 255, 0.3);
		background: rgba(0, 210, 255, 0.06);
	}
	.pct-btn-active {
		color: #00d2ff;
		border-color: rgba(0, 210, 255, 0.4);
		background: rgba(0, 210, 255, 0.1);
	}

	.supply-bar {
		padding: 10px 12px;
		background: rgba(0, 210, 255, 0.03);
		border: 1px solid rgba(0, 210, 255, 0.08);
		border-radius: 10px;
	}
	.supply-bar-error {
		background: rgba(239, 68, 68, 0.05);
		border-color: rgba(239, 68, 68, 0.2);
	}
	.progress-track {
		width: 100%;
		height: 6px;
		background: var(--bg-surface-hover);
		border-radius: 3px;
		overflow: hidden;
	}
	.progress-fill {
		height: 100%;
		border-radius: 3px;
		background: linear-gradient(90deg, #00d2ff, #3a7bd5);
		transition: width 0.3s ease;
	}
	.progress-red {
		background: linear-gradient(90deg, #ef4444, #dc2626);
	}
</style>
