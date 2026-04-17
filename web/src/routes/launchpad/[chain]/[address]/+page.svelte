<script lang="ts">
	import { ethers } from 'ethers';
	import { getContext, onDestroy } from 'svelte';
	import { page } from '$app/state';
	import { shortAddr } from '$lib/formatters';
	import { t } from '$lib/i18n';
	import { apiFetch } from '$lib/apiFetch';
	import { friendlyError } from '$lib/errorDecoder';
	import QrCode from '$lib/QrCode.svelte';
	import { getKnownLogo } from '$lib/tokenLogo';
	import TokenPickerModal, { type PickerToken } from '$lib/TokenPickerModal.svelte';
	import { supabase } from '$lib/supabaseClient';
	import { favorites, toggleFavorite } from '$lib/favorites';
	import RecentTransactionsTicker from '$lib/RecentTransactionsTicker.svelte';
	import { chainSlug, type SupportedNetwork } from '$lib/structure';
	import type { WsProviderManager, EventSubscription } from '$lib/wsProvider';
	import { transferFilter } from '$lib/wsProvider';
	import { ERC20_ABI, ZERO_ADDRESS, FACTORY_ABI } from '$lib/tokenCrafter';
	import {
		LAUNCH_INSTANCE_ABI,
		LAUNCHPAD_FACTORY_ABI,
		type LaunchInfo,
		type LaunchState,
		type BuyPreview,
		fetchLaunchInfo,
		fetchTokenMeta,
		stateColor,
		stateLabel,
		formatUsdt,
		formatTokens,
		progressPercent,
		timeRemaining,
		CURVE_TYPES
	} from '$lib/launchpad';
	import Chart from '$lib/Chart.svelte';
	import LaunchCountdown from '$lib/LaunchCountdown.svelte';
	import BondingCurveChart from '$lib/BondingCurveChart.svelte';
	import PriceProgressChart from '$lib/PriceProgressChart.svelte';

	let getProvider: () => ethers.BrowserProvider | null = getContext('provider');
	let getSigner: () => ethers.Signer | null = getContext('signer');
	let getUserAddress: () => string | null = getContext('userAddress');
	let connectWallet: () => Promise<boolean> = getContext('connectWallet');
	const addFeedback = getContext<(f: { message: string; type: string }) => void>('addFeedback');
	let _getNetworks: () => SupportedNetwork[] = getContext('supportedNetworks');
	let supportedNetworks = $derived(_getNetworks());
	let getNetworkProviders: () => Map<number, ethers.JsonRpcProvider> = getContext('networkProviders');
	let getWsManager: () => WsProviderManager | null = getContext('wsManager');
	let getProvidersReady: () => boolean = getContext('providersReady');

	let signer = $derived(getSigner());
	let userAddress = $derived(getUserAddress());

	let networkProviders = $derived(getNetworkProviders());
	let providersReady = $derived(getProvidersReady());

	let { data: serverData }: { data: any } = $props();

	const launchAddress: string = page.params.address as string;

	// Pre-populate from server data for instant render (no RPC needed)
	const ssrLaunch = serverData?.launch;
	function ssrToLaunchInfo(row: any): LaunchInfo | null {
		if (!row) return null;
		return {
			address: row.address || '',
			token: row.token_address || '',
			creator: row.creator || '',
			curveType: row.curve_type ?? 0,
			state: row.state ?? 0,
			softCap: BigInt(row.soft_cap || '0'),
			hardCap: BigInt(row.hard_cap || '0'),
			deadline: BigInt(row.deadline || 0),
			startTimestamp: BigInt(row.start_timestamp || 0),
			totalBaseRaised: BigInt(row.total_base_raised || '0'),
			tokensSold: BigInt(row.tokens_sold || '0'),
			tokensForCurve: BigInt(row.tokens_for_curve || '0'),
			tokensForLP: BigInt(row.tokens_for_lp || '0'),
			creatorAllocationBps: BigInt(row.creator_allocation_bps || 0),
			currentPrice: BigInt(row.current_price || '0'),
			usdtAddress: row.usdt_address || '',
			totalTokensRequired: BigInt(row.total_tokens_required || '0'),
			totalTokensDeposited: BigInt(row.total_tokens_deposited || '0'),
			tokenName: row.token_name,
			tokenSymbol: row.token_symbol,
			tokenDecimals: row.token_decimals ?? 18,
			usdtDecimals: row.usdt_decimals ?? 18,
		};
	}
	let launch: LaunchInfo | null = $state(ssrToLaunchInfo(ssrLaunch));
	let network: SupportedNetwork | null = $state(serverData?.network || null);
	let tokenMeta = $state({
		name: ssrLaunch?.token_name || 'Loading...',
		symbol: ssrLaunch?.token_symbol || '...',
		decimals: ssrLaunch?.token_decimals ?? 18
	});
	let usdtDecimals = $state(ssrLaunch?.usdt_decimals ?? 18);
	// If SSR provided launch data, skip the loading spinner
	let loading = $state(!ssrLaunch);

	// Pre-populate badges from server
	let badges: string[] = $state(serverData?.badges || []);
	let tokenTrust: any = $state(serverData?.tokenTrust || null);
	let mobileAboutExpanded = $state(false);
	let buyAmount = $state(''); // always in USDT
	let buyPaymentMethod: 'usdt' | 'usdc' | 'native' | 'custom' = $state('usdt');
	let slippagePct = $state(5); // default 5% slippage tolerance
	let showSlippageMenu = $state(false);
	let showPayPicker = $state(false);
	let customPayToken: PickerToken | null = $state(null);
	let preview: BuyPreview | null = $state(null);
	let previewLoading = $state(false);
	let isBuying = $state(false);
	let isRefunding = $state(false);
	let isGraduating = $state(false);
	let isDepositing = $state(false);
	let tradingEnabled = $state(true); // assume true unless we detect otherwise
	let tradingOpensIn = $state(0n); // seconds until anti-snipe lock expires (-1 = never called, 0 = open)
	let isEnablingTrading = $state(false);
	// Creator reclaim (refunding-state) + platform sweep of stranded USDT.
	let isReclaiming = $state(false);
	let isSweeping = $state(false);
	let reclaimableBalance = $state(0n);     // contract's current token balance during Refunding
	let strandedUsdtBalance = $state(0n);    // contract's current USDT balance during Refunding
	let refundStartTimestamp = $state(0n);   // timestamp when refunding state began
	let lockDurationAfterListing = $state(0n);
	let vestingCliffSeconds = $state(0n);
	let vestingDurationSeconds = $state(0n);
	let creatorTotalTokens = $state(0n);
	let creatorClaimed = $state(0n);
	let graduationTimestamp = $state(0n);
	// Platform wallet (read from LaunchpadFactory). Gates the stranded-USDT
	// sweep button: after the audit L2 fix, `sweepStrandedUsdt()` is
	// platform-only and will revert for any other caller.
	let platformWalletAddress = $state<string>('');

	// Preflight status for Pending launches. preflightReason is one of:
	//   "" (ready), "NOT_PENDING", "NOT_FUNDED", "NOT_EXCLUDED_FROM_LIMITS",
	//   "NOT_TAX_EXEMPT", "NOT_AUTHORIZED_LAUNCHER".
	let preflightReady = $state(false);
	let preflightReason = $state('');
	let isActivating = $state(false);
	let graduationDismissed = $state(false);
	let linkCopiedFeedback = $state(false);

	// Off-chain metadata from database
	type Metadata = {
		description?: string; logo_url?: string; website?: string;
		twitter?: string; telegram?: string; discord?: string;
		video_url?: string;
	};
	let metadata: Metadata = $state(ssrLaunch ? {
		description: ssrLaunch.description,
		logo_url: ssrLaunch.logo_url,
		website: ssrLaunch.website,
		twitter: ssrLaunch.twitter,
		telegram: ssrLaunch.telegram,
		discord: ssrLaunch.discord,
		video_url: ssrLaunch.video_url,
	} : {});

	// Badge display config
	const BADGE_META: Record<string, { label: string; color: string; tooltip: string }> = {
		audit: { label: 'Audit', color: 'cyan', tooltip: 'Audited — contract code has been reviewed by a third-party auditor' },
		kyc: { label: 'KYC', color: 'emerald', tooltip: 'KYC — creator identity has been verified' },
		partner: { label: 'Partner', color: 'purple', tooltip: 'Partner — launched through a verified TokenKrafter partner' },
		doxxed: { label: 'Doxxed', color: 'amber', tooltip: 'Doxxed — creator has publicly revealed their identity' },
		safu: { label: 'SAFU', color: 'blue', tooltip: 'SAFU — passes all on-chain safety checks' },
		mintable: { label: 'Mintable', color: 'orange', tooltip: 'Mintable — token supply can be increased by owner' },
		taxable: { label: 'Taxable', color: 'amber', tooltip: 'Taxable — buy/sell transactions include a tax fee' },
		renounced: { label: 'No Owner', color: 'emerald', tooltip: 'Renounced — contract ownership has been permanently given up' }
	};

	// Inline editing
	let isEditing = $state(false);
	let isSavingMeta = $state(false);
	let isUploadingLogo = $state(false);
	let editDescription = $state('');
	let editWebsite = $state('');
	let editTwitter = $state('');
	let editTelegram = $state('');
	let editDiscord = $state('');
	let editVideoUrl = $state('');

	let isCreator = $derived(
		!!userAddress && !!launch && userAddress.toLowerCase() === launch.creator.toLowerCase()
	);

	function startEditing() {
		editDescription = metadata.description ?? '';
		editWebsite = metadata.website ?? '';
		editTwitter = metadata.twitter ?? '';
		editTelegram = metadata.telegram ?? '';
		editDiscord = metadata.discord ?? '';
		editVideoUrl = metadata.video_url ?? '';
		isEditing = true;
	}

	function cancelEditing() {
		isEditing = false;
	}

	async function handleLogoUpload(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file || !userAddress || !network || !signer) return;

		if (file.size > 512 * 1024) {
			addFeedback({ message: 'Image too large. Max 512 KB.', type: 'error' });
			input.value = '';
			return;
		}

		isUploadingLogo = true;
		try {
			const timestamp = Date.now();
			const msg = `TokenKrafter Upload\nLaunch: ${launchAddress}\nAction: upload logo\nOrigin: ${window.location.origin}\nTimestamp: ${timestamp}`;
			const signature = await signer.signMessage(msg);

			const fd = new FormData();
			fd.append('file', file);
			fd.append('address', launchAddress);
			fd.append('chain_id', String(network.chain_id));
			fd.append('signature', signature);
			fd.append('signed_message', msg);

			const res = await apiFetch('/api/launches/upload', { method: 'POST', body: fd });
			if (!res.ok) {
				const err = await res.json().catch(() => ({ message: 'Upload failed' }));
				throw new Error(err.message || 'Upload failed');
			}
			const { logo_url } = await res.json();
			metadata = { ...metadata, logo_url };
			addFeedback({ message: 'Logo uploaded!', type: 'success' });
		} catch (e: any) {
			addFeedback({ message: e.message || 'Upload failed', type: 'error' });
		} finally {
			isUploadingLogo = false;
			input.value = '';
		}
	}

	async function saveMetadata() {
		if (!userAddress || !network || !launch || !signer) return;
		isSavingMeta = true;
		try {
			const timestamp = Date.now();
			const msg = `TokenKrafter Metadata\nLaunch: ${launchAddress}\nAction: update metadata\nOrigin: ${window.location.origin}\nTimestamp: ${timestamp}`;
			const signature = await signer.signMessage(msg);

			const res = await fetch('/api/launches/metadata', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					address: launchAddress,
					chain_id: network.chain_id,
					signature,
					signed_message: msg,
					description: editDescription,
					website: editWebsite,
					twitter: editTwitter,
					telegram: editTelegram,
					discord: editDiscord,
					video_url: editVideoUrl
				})
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({ message: 'Failed to save' }));
				throw new Error(err.message || 'Failed to save');
			}
			metadata = {
				...metadata,
				description: editDescription || undefined,
				website: editWebsite || undefined,
				twitter: editTwitter || undefined,
				telegram: editTelegram || undefined,
				discord: editDiscord || undefined,
				video_url: editVideoUrl || undefined
			};
			isEditing = false;
			addFeedback({ message: 'Token info updated!', type: 'success' });
		} catch (e: any) {
			addFeedback({ message: e.message || 'Failed to save metadata', type: 'error' });
		} finally {
			isSavingMeta = false;
		}
	}

	// User position
	let userBasePaid = $state(0n);
	let userTokensBought = $state(0n);
	let maxBuyPerWallet = $state(0n);
	let minBuyUsdt = $state(0n);

	// Balance check & deposit modal
	let showDepositModal = $state(false);
	let userPaymentBalance = $state(0n);
	let paymentDecimals = $state(18);
	let requiredAmount = $state('');
	let balanceCheckInterval: ReturnType<typeof setInterval> | null = null;

	let progress = $derived.by(() => {
		const l = launch;
		return l ? progressPercent(l.totalBaseRaised, l.hardCap) : 0;
	});
	let paySymbol = $derived(
		buyPaymentMethod === 'native' ? (network?.native_coin || 'BNB') :
		buyPaymentMethod === 'custom' && customPayToken ? customPayToken.symbol :
		buyPaymentMethod.toUpperCase()
	);
	let payTokens = $derived.by((): PickerToken[] => {
		if (!network) return [];
		const nc = network.native_coin;
		const tokens: PickerToken[] = [
			{ address: network.usdt_address, symbol: 'USDT', name: 'Tether USD', decimals: usdtDecimals, logoUrl: getKnownLogo('USDT') },
		];
		if (network.usdc_address) {
			tokens.push({ address: network.usdc_address, symbol: 'USDC', name: 'USD Coin', decimals: 18, logoUrl: getKnownLogo('USDC') });
		}
		tokens.push({ address: ethers.ZeroAddress, symbol: nc, name: `${nc} (auto-converted)`, decimals: 18, isNative: true, logoUrl: getKnownLogo(nc) });
		const wrappedNative = new Set(['WBNB', 'WETH', 'WMATIC', 'WAVAX']);
		for (const b of network.default_bases ?? []) {
			if (!b.address || tokens.find(t => t.address.toLowerCase() === b.address.toLowerCase())) continue;
			if (wrappedNative.has(b.symbol.toUpperCase())) continue; // native coin already listed
			tokens.push({ address: b.address, symbol: b.symbol, name: b.name || b.symbol, decimals: 18, logoUrl: getKnownLogo(b.symbol) });
		}
		return tokens;
	});

	// Live swap estimate: show how much BNB/USDC the user will actually spend
	let swapEstimate = $state('');
	let swapEstimateLoading = $state(false);
	let _swapEstimateTimeout: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		const method = buyPaymentMethod;
		const amt = buyAmount;
		const net = network;
		const prov = signer?.provider ?? (net ? networkProviders.get(net.chain_id) : null);

		if (_swapEstimateTimeout) clearTimeout(_swapEstimateTimeout);

		if (method === 'usdt' || !amt || parseFloat(String(amt)) <= 0 || !net || !prov) {
			swapEstimate = '';
			swapEstimateLoading = false;
			return;
		}

		swapEstimateLoading = true;
		_swapEstimateTimeout = setTimeout(async () => {
			try {
				const routerAbi = [
					'function getAmountsIn(uint256 amountOut, address[] calldata path) view returns (uint256[] memory amounts)',
					'function WETH() view returns (address)'
				];
				const router = new ethers.Contract(net.dex_router, routerAbi, prov);
				const usdtNeeded = ethers.parseUnits(String(amt), usdtDecimals);

				if (method === 'native') {
					const weth = await router.WETH();
					const amounts = await router.getAmountsIn(usdtNeeded, [weth, net.usdt_address]);
					const val = parseFloat(ethers.formatEther(amounts[0]));
					swapEstimate = `\u2248 ${val < 0.00000001 ? '< 0.00000001' : val < 0.0001 ? val.toFixed(8).replace(/\.?0+$/, '') : val.toFixed(4)} ${net.native_coin || 'BNB'}`;
				} else {
					// USDC
					const dec = net.chain_id === 56 ? 18 : 6;
					const amounts = await router.getAmountsIn(usdtNeeded, [net.usdc_address, net.usdt_address]);
					const val = parseFloat(ethers.formatUnits(amounts[0], dec));
					swapEstimate = `\u2248 ${val.toFixed(2)} USDC`;
				}
			} catch {
				swapEstimate = '';
			} finally {
				swapEstimateLoading = false;
			}
		}, 400);
	});
	let softCapPct = $derived.by(() => {
		const l = launch;
		return l && l.hardCap > 0n ? Math.min(100, Number((l.softCap * 100n) / l.hardCap)) : 0;
	});
	let tokenProgress = $derived.by(() => {
		const l = launch;
		return l && l.tokensForCurve > 0n
			? Math.min(100, Number((l.tokensSold * 100n) / l.tokensForCurve))
			: 0;
	});

	// maxBuyPerWallet is now in USDT value (% of hard cap)
	let remainingBuyUsdt = $derived.by(() => {
		if (maxBuyPerWallet === 0n) return -1n; // no limit
		return maxBuyPerWallet > userBasePaid ? maxBuyPerWallet - userBasePaid : 0n;
	});

	let exceedsMaxBuy = $derived.by(() => {
		if (!preview || maxBuyPerWallet === 0n) return false;
		// Check if current buy amount would push basePaid over limit
		const buyUsdt = buyAmount ? BigInt(Math.floor(parseFloat(String(buyAmount)) * (10 ** usdtDecimals))) : 0n;
		return (userBasePaid + buyUsdt) > maxBuyPerWallet;
	});

	let maxBuyPct = $derived.by(() => {
		const l = launch;
		if (!l || l.hardCap === 0n || maxBuyPerWallet === 0n) return 0;
		return Number((maxBuyPerWallet * 10000n) / l.hardCap) / 100;
	});

	// Treat as maxed out when remaining < minBuy — no valid purchase is possible
	let atMaxBuy = $derived(
		maxBuyPerWallet > 0n && (remainingBuyUsdt === 0n || (minBuyUsdt > 0n && remainingBuyUsdt > 0n && remainingBuyUsdt < minBuyUsdt))
	);

	// Below-min-buy validation. Contract reverts with BelowMinBuy() if amount
	// is under minBuyUsdt. Surface this pre-flight so the button can disable
	// and the user sees *why* instead of the click silently no-op'ing.
	let belowMinBuy = $derived.by(() => {
		if (minBuyUsdt === 0n) return false;
		if (!buyAmount || parseFloat(String(buyAmount)) <= 0) return false;
		const buyUsdtWei = BigInt(Math.floor(parseFloat(String(buyAmount)) * (10 ** usdtDecimals)));
		return buyUsdtWei < minBuyUsdt;
	});
	let minBuyLabel = $derived.by(() => {
		if (minBuyUsdt === 0n) return '';
		return ethers.formatUnits(minBuyUsdt, usdtDecimals).replace(/\.?0+$/, '');
	});

	let allocationPct = $derived.by(() => {
		if (maxBuyPerWallet === 0n) return 0;
		if (atMaxBuy) return 100;
		return Math.min(100, Number((userBasePaid * 10000n) / maxBuyPerWallet) / 100);
	});

	let highImpact = $derived(preview ? Number(preview.priceImpactBps) > 1500 : false); // >15%
	let impactAccepted = $state(false);

	let paymentLabel = $derived(
		buyPaymentMethod === 'native' ? (network?.native_coin ?? 'BNB') :
		buyPaymentMethod === 'custom' && customPayToken ? customPayToken.symbol :
		buyPaymentMethod === 'usdt' ? 'USDT' : 'USDC'
	);

	// Countdown timer
	let countdownNow = $state(Date.now());
	let countdownInterval: ReturnType<typeof setInterval> | null = null;

	// Determine if this is a scheduled launch that hasn't started yet
	let isScheduled = $derived(
		launch && launch.startTimestamp > 0n && Number(launch.startTimestamp) * 1000 > countdownNow
	);

	let countdown = $derived.by(() => {
		if (!launch) return null;
		// If scheduled and not started, count down to start time
		const targetMs = isScheduled
			? Number(launch.startTimestamp) * 1000
			: Number(launch.deadline) * 1000;
		const diff = targetMs - countdownNow;
		if (diff <= 0) return { days: 0, hours: 0, minutes: 0, seconds: 0, ended: true };
		const days = Math.floor(diff / 86400000);
		const hours = Math.floor((diff % 86400000) / 3600000);
		const minutes = Math.floor((diff % 3600000) / 60000);
		const seconds = Math.floor((diff % 60000) / 1000);
		return { days, hours, minutes, seconds, ended: false };
	});

	$effect(() => {
		if (launch && !countdownInterval) {
			countdownInterval = setInterval(() => { countdownNow = Date.now(); }, 1000);
		}
		return () => {
			if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
		};
	});

	let refreshInterval: ReturnType<typeof setInterval> | null = null;
	let _wsSubs: EventSubscription[] = [];
	let _wsRefreshDebounce: ReturnType<typeof setTimeout> | null = null;
	let _wsBalanceDebounce: ReturnType<typeof setTimeout> | null = null;

	// Chain map for URL-based lookup
	const CHAIN_MAP: Record<string, number> = { bsc: 56, eth: 1, base: 8453, arbitrum: 42161, polygon: 137 };
	const targetChainId = CHAIN_MAP[page.params.chain?.toLowerCase() || 'bsc'] || 56;

	async function loadLaunch() {
		const net = supportedNetworks.find(n => n.chain_id === targetChainId);
		if (!net) { loading = false; return; }
		network = net;

		const prov = networkProviders.get(net.chain_id);
		if (!prov) { loading = false; return; }

		try {
			// Phase 1: Fetch core launch info (single eth_call) — merge with SSR data
			const info = await fetchLaunchInfo(launchAddress, prov);
			// Preserve SSR token metadata until Phase 2 fetches fresh values
			const prevLaunch = launch;
			launch = {
				...info,
				tokenName: prevLaunch?.tokenName || info.tokenName,
				tokenSymbol: prevLaunch?.tokenSymbol || info.tokenSymbol,
				tokenDecimals: prevLaunch?.tokenDecimals || info.tokenDecimals,
			};
			loading = false; // render now with on-chain data

			// Phase 2: All secondary data in parallel — non-blocking
			const instance = new ethers.Contract(launchAddress, LAUNCH_INSTANCE_ABI, prov);
			const tokenC = new ethers.Contract(info.token, PROTECTED_TOKEN_ABI, prov);

			const [meta, usdtMeta, tradingResult, vestingResult, settingsResult] = await Promise.all([
				// Token + USDT metadata
				fetchTokenMeta(info.token, prov),
				fetchTokenMeta(info.usdtAddress, prov),
				// Trading status
				tokenC.secondsUntilTradingOpens().catch(() => 0n),
				// Vesting + trust signals
				Promise.all([
					instance.vestingCliff().catch(() => 0n),
					instance.vestingDuration().catch(() => 0n),
					instance.lockDurationAfterListing().catch(() => 0n),
					instance.creatorTotalTokens().catch(() => 0n),
					instance.creatorClaimed().catch(() => 0n),
					instance.graduationTimestamp().catch(() => 0n),
				]),
				// Launch settings
				Promise.all([
					instance.maxBuyPerWallet().catch(() => 0n),
					instance.minBuyUsdt().catch(() => 0n),
				]),
			]);

			// Apply metadata
			tokenMeta = meta;
			usdtDecimals = usdtMeta.decimals;
			launch = { ...info, tokenName: meta.name, tokenSymbol: meta.symbol, tokenDecimals: meta.decimals, usdtDecimals: usdtMeta.decimals };

			// Apply trading status
			const SENTINEL = (1n << 256n) - 1n;
			tradingEnabled = tradingResult === 0n; // 0 = open, >0 = anti-snipe lock, SENTINEL = never called
			tradingOpensIn = tradingResult === SENTINEL ? -1n : tradingResult; // -1 = never called, 0 = open, >0 = seconds

			// Apply vesting
			const [vc, vd, lda, ctt, cc, gt] = vestingResult;
			vestingCliffSeconds = vc;
			vestingDurationSeconds = vd;
			lockDurationAfterListing = lda;
			creatorTotalTokens = ctt;
			creatorClaimed = cc;
			graduationTimestamp = gt;

			// Apply settings
			const [maxBuy, minBuy] = settingsResult;
			maxBuyPerWallet = maxBuy;
			minBuyUsdt = minBuy;

			// Phase 3: State-specific calls (non-blocking, run in background)
			if (info.state === 0) {
				instance.preflight().then(([ready, reason]: [boolean, string]) => {
					preflightReady = Boolean(ready);
					preflightReason = String(reason || '');
				}).catch(() => { preflightReady = false; preflightReason = ''; });
			}

			if (info.state === 3) {
				Promise.all([
					new ethers.Contract(info.token, ERC20_ABI, prov).balanceOf(launchAddress).catch(() => 0n),
					new ethers.Contract(info.usdtAddress, ERC20_ABI, prov).balanceOf(launchAddress).catch(() => 0n),
					instance.refundStartTimestamp().catch(() => 0n),
					instance.STRANDED_SWEEP_DELAY().catch(() => 0n),
					new ethers.Contract(net.launchpad_address, LAUNCHPAD_FACTORY_ABI, prov).platformWallet().catch(() => ''),
				]).then(([tokenBal, usdtBal, rts, ssd, pw]) => {
					reclaimableBalance = tokenBal;
					strandedUsdtBalance = usdtBal;
					refundStartTimestamp = rts;
					strandedSweepDelay = ssd;
					platformWalletAddress = pw;
				});
			}

			// Load user position (non-blocking)
			if (userAddress) {
				loadUserPosition(prov);
			}

			// Metadata already loaded from SSR — only fetch if empty
			if (!metadata.description && !metadata.logo_url) {
				try {
					const metaRes = await fetch(`/api/launches?address=${launchAddress}`);
					if (metaRes.ok) {
						const rows = await metaRes.json();
						if (rows?.[0]) {
							metadata = {
								description: rows[0].description, logo_url: rows[0].logo_url,
								website: rows[0].website, twitter: rows[0].twitter,
								telegram: rows[0].telegram, discord: rows[0].discord,
								video_url: rows[0].video_url
							};
						}
					}
				} catch {}
			}

			// Partner detection from chain
			try {
				const factory = new ethers.Contract(net.platform_address, FACTORY_ABI, prov);
				const tInfo = await factory.tokenInfo(info.token);
				if (tInfo.isPartnership && !badges.includes('partner')) {
					badges = [...badges, 'partner'];
				}
			} catch {}

		} catch {
			loading = false;
		}
	}

	async function loadUserPosition(provider: ethers.Provider) {
		if (!userAddress) return;
		const instance = new ethers.Contract(launchAddress, LAUNCH_INSTANCE_ABI, provider);
		const [paid, bought, maxBuy, minBuy] = await Promise.all([
			instance.basePaid(userAddress),
			instance.tokensBought(userAddress),
			instance.maxBuyPerWallet(),
			instance.minBuyUsdt().catch(() => 0n)
		]);
		userBasePaid = paid;
		userTokensBought = bought;
		maxBuyPerWallet = maxBuy;
		minBuyUsdt = minBuy;
	}

	async function refreshData() {
		const net = network;
		const l = launch;
		if (!net) return;
		const provider = networkProviders.get(net.chain_id);
		if (!provider || !l) return;

		try {
			const info = await fetchLaunchInfo(launchAddress, provider);
			launch = {
				...info,
				tokenName: tokenMeta.name,
				tokenSymbol: tokenMeta.symbol,
				tokenDecimals: tokenMeta.decimals
			};
			if (userAddress) await loadUserPosition(provider);
		} catch (e) {
			console.warn('Refresh failed:', e);
		}
	}

	// Set network as soon as supportedNetworks loads (before providers are ready)
	$effect(() => {
		if (!network && supportedNetworks.length > 0) {
			const net = supportedNetworks.find(n => n.chain_id === targetChainId);
			if (net) network = net;
		}
	});

	$effect(() => {
		if (providersReady) {
			loadLaunch();
		}
	});

	// Re-fetch user position when wallet changes (switch account, connect, disconnect)
	let _prevUserAddr: string | null = null;
	$effect(() => {
		const addr = userAddress;
		if (addr === _prevUserAddr) return;
		_prevUserAddr = addr;
		if (!addr) {
			// Disconnected — reset all user-specific state
			userBasePaid = 0n;
			userTokensBought = 0n;
			buyAmount = '';
			showDepositModal = false;
			userPaymentBalance = 0n;
			stopBalancePolling();
			return;
		}
		// New wallet connected — fetch their position
		const net = network;
		if (!net) return;
		const provider = networkProviders.get(net.chain_id);
		if (provider) loadUserPosition(provider);
	});

	// WS event-driven refresh for Pending + Active launches, with polling fallback
	$effect(() => {
		if (!launch || launch.state > 1) return; // only Pending (0) and Active (1)
		const ws = getWsManager();
		const chainId = network?.chain_id ?? targetChainId;

		for (const s of _wsSubs) s.unsubscribe();
		_wsSubs = [];

		if (ws) {
			const STATE_TOPICS = [
				ethers.id('LaunchActivated(address,uint256,uint256,uint256,uint256)'),
				ethers.id('Graduated(address,uint256,uint256,uint256,uint256,uint256,uint256,uint256)'),
				ethers.id('RefundingEnabled(address,uint256,uint256)'),
			];

			// TokenBought only fires on Active launches, but subscribing
			// early is harmless and avoids a re-subscribe on activation.
			const TOKEN_BOUGHT_TOPIC = ethers.id('TokenBought(address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)');
			const buySub = ws.subscribeLogs(chainId, {
				address: launchAddress,
				topics: [TOKEN_BOUGHT_TOPIC],
			}, () => {
				if (_wsRefreshDebounce) clearTimeout(_wsRefreshDebounce);
				_wsRefreshDebounce = setTimeout(() => { _wsRefreshDebounce = null; refreshData(); refreshLatestTransactions(); }, 500);
			});
			_wsSubs.push(buySub);

			for (const topic of STATE_TOPICS) {
				const sub = ws.subscribeLogs(chainId, {
					address: launchAddress,
					topics: [topic],
				}, () => { refreshData(); });
				_wsSubs.push(sub);
			}

			refreshInterval = setInterval(refreshData, 120_000);
		} else {
			refreshInterval = setInterval(refreshData, 15000);
		}

		return () => {
			if (refreshInterval) { clearInterval(refreshInterval); refreshInterval = null; }
			for (const s of _wsSubs) s.unsubscribe();
			_wsSubs = [];
		};
	});

	onDestroy(() => {
		if (refreshInterval) clearInterval(refreshInterval);
		if (_swapEstimateTimeout) clearTimeout(_swapEstimateTimeout);
		if (_wsRefreshDebounce) clearTimeout(_wsRefreshDebounce);
		if (_wsBalanceDebounce) clearTimeout(_wsBalanceDebounce);
		for (const s of _wsSubs) s.unsubscribe();
		_wsSubs = [];
		stopBalancePolling();
	});

	// Preview buy — always in USDT terms
	let previewTimeout: ReturnType<typeof setTimeout> | null = null;
	let previewError = $state('');

	async function estimateViaCurrentPrice(
		instance: ethers.Contract,
		usdtWei: bigint
	): Promise<BuyPreview | null> {
		try {
			const currentPrice: bigint = await instance.getCurrentPrice();
			if (currentPrice === 0n) return null;

			// No buy fee — platform earns from graduation only
			const fee = (usdtWei * 100n) / 10000n;
			const baseForTokens = usdtWei - fee;

			// estimate tokens: baseForTokens / currentPrice * 1e18
			const tokensOut = (baseForTokens * BigInt(10 ** tokenMeta.decimals)) / currentPrice;
			if (tokensOut === 0n) return null;

			// Price impact estimate: buyAmount relative to (totalRaised + hardCap) / 2
			// This gives a reasonable estimate for bonding curves
			let priceImpactBps = 0n;
			if (launch && launch.hardCap > 0n) {
				const poolSize = launch.totalBaseRaised > 0n ? launch.totalBaseRaised : launch.hardCap / 10n;
				priceImpactBps = (baseForTokens * 10000n) / poolSize;
			}

			return { tokensOut, fee, priceImpactBps };
		} catch {
			return null;
		}
	}

	$effect(() => {
		if (previewTimeout) clearTimeout(previewTimeout);
		const amt = buyAmount;
		const net = network;
		const l = launch;
		const amtNum = parseFloat(String(amt));
		if (!amt || !net || !l || l.state !== 1 || isNaN(amtNum) || amtNum <= 0) {
			preview = null;
			previewError = '';
			impactAccepted = false;
			return;
		}
		impactAccepted = false;
		previewTimeout = setTimeout(async () => {
			previewLoading = true;
			previewError = '';
			try {
				const provider = networkProviders.get(net.chain_id);
				if (!provider) return;
				const instance = new ethers.Contract(launchAddress, LAUNCH_INSTANCE_ABI, provider);
				const usdtWei = ethers.parseUnits(String(amt), usdtDecimals);
				const result = userAddress
					? await instance.previewBuyFor(userAddress, usdtWei)
					: await instance.previewBuy(usdtWei);
				const tokensOut = result[0];
				const fee = result[1];
				const priceImpactBps = result[2];
				if (tokensOut === 0n && fee === 0n) {
					preview = null;
				} else {
					preview = { tokensOut, fee, priceImpactBps };
				}
			} catch (e: any) {
				console.warn('Preview failed:', e);
				// Detect arithmetic overflow (Panic 0x11)
				const errStr = String(e?.data || e?.message || '');
				if (errStr.includes('0x11') || errStr.includes('OVERFLOW') || errStr.includes('overflow')) {
					// Fallback: estimate using getCurrentPrice
					try {
						const provider = networkProviders.get(net.chain_id);
						if (provider) {
							const instance = new ethers.Contract(launchAddress, LAUNCH_INSTANCE_ABI, provider);
							const usdtWei = ethers.parseUnits(String(amt), usdtDecimals);
							const est = await estimateViaCurrentPrice(instance, usdtWei);
							if (est) {
								preview = est;
								previewError = 'estimate';
								return;
							}
						}
					} catch {}
					preview = null;
					previewError = 'This launch has a curve overflow issue. The token supply may be too large for the bonding curve math. Consider creating a new launch with fewer tokens.';
				} else {
					preview = null;
					previewError = 'Preview calculation failed. Try a different amount.';
				}
			} finally {
				previewLoading = false;
			}
		}, 300);
	});

	function getPaymentAddress(): string {
		if (!network) return ZERO_ADDRESS;
		if (buyPaymentMethod === 'usdt') return network.usdt_address;
		if (buyPaymentMethod === 'usdc') return network.usdc_address;
		if (buyPaymentMethod === 'custom' && customPayToken) return customPayToken.address;
		return ZERO_ADDRESS; // native
	}

	async function checkPaymentBalance(): Promise<boolean> {
		if (!userAddress || !network || !signer) return false;
		const provider = signer.provider!;

		if (buyPaymentMethod === 'native') {
			const bal = await provider.getBalance(userAddress);
			userPaymentBalance = bal;
			paymentDecimals = 18;
			// For native, get a DEX quote to estimate BNB needed for the USDT amount
			try {
				const routerAbi = [
					'function getAmountsIn(uint256 amountOut, address[] calldata path) view returns (uint256[] memory amounts)',
					'function WETH() view returns (address)'
				];
				const router = new ethers.Contract(network.dex_router, routerAbi, provider);
				const weth = await router.WETH();
				const usdtNeeded = ethers.parseUnits(String(buyAmount), usdtDecimals);
				const amounts = await router.getAmountsIn(usdtNeeded, [weth, network.usdt_address]);
				const bnbNeeded = amounts[0];
				// Add 5% buffer for slippage + gas
				const bnbWithBuffer = bnbNeeded * 105n / 100n;
				return bal >= bnbWithBuffer;
			} catch {
				// If quote fails, just check they have some BNB
				return bal > ethers.parseEther('0.01');
			}
		} else {
			const payAddr = getPaymentAddress();
			const erc20 = new ethers.Contract(payAddr, ERC20_ABI, provider);
			const [bal, dec] = await Promise.all([
				erc20.balanceOf(userAddress),
				erc20.decimals()
			]);
			userPaymentBalance = bal;
			paymentDecimals = Number(dec);
			const needed = ethers.parseUnits(String(buyAmount), paymentDecimals);
			return bal >= needed;
		}
	}

	let _depositWsSub: EventSubscription | null = null;

	function startBalancePolling() {
		stopBalancePolling();
		const ws = getWsManager();
		const chainId = network?.chain_id ?? targetChainId;

		const checkAndResolve = async () => {
			const sufficient = await checkPaymentBalance();
			if (sufficient && showDepositModal) {
				stopBalancePolling();
				showDepositModal = false;
				addFeedback({ message: 'Deposit detected! You can now proceed.', type: 'success' });
			}
		};

		if (ws && userAddress) {
			_depositWsSub = ws.subscribeLogs(chainId, transferFilter(userAddress), () => {
				if (_wsBalanceDebounce) clearTimeout(_wsBalanceDebounce);
				_wsBalanceDebounce = setTimeout(() => { _wsBalanceDebounce = null; checkAndResolve(); }, 500);
			});
			// Slow fallback poll
			balanceCheckInterval = setInterval(checkAndResolve, 30_000);
		} else {
			balanceCheckInterval = setInterval(checkAndResolve, 5000);
		}
	}

	function stopBalancePolling() {
		if (balanceCheckInterval) {
			clearInterval(balanceCheckInterval);
			balanceCheckInterval = null;
		}
		if (_depositWsSub) {
			_depositWsSub.unsubscribe();
			_depositWsSub = null;
		}
	}

	function onPayTokenPick(token: PickerToken) {
		if (!network) return;
		const addr = token.address.toLowerCase();
		if (addr === network.usdt_address.toLowerCase()) {
			buyPaymentMethod = 'usdt';
			customPayToken = null;
		} else if (network.usdc_address && addr === network.usdc_address.toLowerCase()) {
			buyPaymentMethod = 'usdc';
			customPayToken = null;
		} else if (token.isNative || addr === ethers.ZeroAddress) {
			buyPaymentMethod = 'native';
			customPayToken = null;
		} else {
			buyPaymentMethod = 'custom';
			customPayToken = token;
			paymentDecimals = token.decimals;
		}
	}

	async function handleBuy() {
		if (!signer || !userAddress || !buyAmount || !network || !launch) {
			connectWallet();
			return;
		}

		// Pre-flight: if preview failed with overflow, warn user
		if (previewError && previewError !== 'estimate') {
			addFeedback({ message: 'Cannot buy: bonding curve has an overflow issue. This launch may need to be recreated.', type: 'error' });
			return;
		}

		// Check balance first
		const hasFunds = await checkPaymentBalance();
		if (!hasFunds) {
			requiredAmount = buyAmount;
			showDepositModal = true;
			startBalancePolling();
			return;
		}

		isBuying = true;
		try {
			const instance = new ethers.Contract(launchAddress, LAUNCH_INSTANCE_ABI, signer);
			const slipBps = BigInt(Math.round(slippagePct * 100)); // e.g. 5% → 500
			const minTokensOut = preview ? preview.tokensOut * (10000n - slipBps) / 10000n : 0n;

			if (buyPaymentMethod === 'native') {
				const routerAbi = [
					'function getAmountsIn(uint256 amountOut, address[] calldata path) view returns (uint256[] memory amounts)',
					'function WETH() view returns (address)'
				];
				const router = new ethers.Contract(network.dex_router, routerAbi, signer.provider!);
				const weth = await router.WETH();
				const usdtNeeded = ethers.parseUnits(String(buyAmount), usdtDecimals);
				const amounts = await router.getAmountsIn(usdtNeeded, [weth, network.usdt_address]);
				const bnbNeeded = amounts[0];
				const bnbToSend = bnbNeeded * (10000n + slipBps) / 10000n;
				const minUsdtOut = usdtNeeded * (10000n - slipBps) / 10000n;

				// Path: [native, USDT]. The contract rewrites address(0) → WETH
				// for the actual swap call.
				addFeedback({ message: `Swapping ${network.native_coin} → USDT and buying...`, type: 'info' });
				const tx = await instance.buy(
					[ethers.ZeroAddress, network.usdt_address],
					bnbToSend,
					minUsdtOut,
					minTokensOut,
					{ value: bnbToSend }
				);
				await tx.wait();
			} else {
				const paymentAddress = getPaymentAddress();
				const amountWei = ethers.parseUnits(String(buyAmount), paymentDecimals);
				// minUsdtOut for non-USDT tokens (USDC → USDT swap), 0 if paying USDT directly
				const minUsdtOut = buyPaymentMethod === 'usdt' ? 0n : amountWei * (10000n - slipBps) / 10000n;

				// Check allowance & approve
				const tokenContract = new ethers.Contract(paymentAddress, ERC20_ABI, signer);
				const allowance: bigint = await tokenContract.allowance(userAddress, launchAddress);
				if (allowance < amountWei) {
					addFeedback({ message: `Approving ${paymentLabel}...`, type: 'info' });
					const approveTx = await tokenContract.approve(launchAddress, amountWei);
					await approveTx.wait();
				}

				// Path: [paymentToken, USDT]. If paymentToken == USDT, the contract
				// short-circuits the swap (path can still be [USDT, USDT]).
				const path = paymentAddress.toLowerCase() === network.usdt_address.toLowerCase()
					? [network.usdt_address, network.usdt_address]
					: [paymentAddress, network.usdt_address];

				addFeedback({ message: 'Buying tokens...', type: 'info' });
				const tx = await instance.buy(path, amountWei, minUsdtOut, minTokensOut);
				await tx.wait();
			}

			addFeedback({ message: 'Tokens purchased!', type: 'success' });
			// Record transaction in activity feed (best effort)
			const savedAmount = buyAmount;
			const savedTokens = preview ? preview.tokensOut.toString() : '0';
			buyAmount = '';
			preview = null;
			await refreshData();
			recordTransaction(
				ethers.parseUnits(String(savedAmount), usdtDecimals).toString(),
				savedTokens
			);
		} catch (e: any) {
			const errStr = String(e?.data || e?.message || e?.shortMessage || '');
			if (errStr.includes('0x11') || errStr.includes('OVERFLOW') || errStr.includes('overflow')) {
				addFeedback({ message: 'Transaction failed: arithmetic overflow in bonding curve. This launch may need to be recreated with a smaller token supply.', type: 'error' });
			} else {
				addFeedback({ message: friendlyError(e), type: 'error' });
			}
		} finally {
			isBuying = false;
		}
	}

	async function handleEnableTrading() {
		if (!signer || !launch) return;
		isEnablingTrading = true;
		try {
			const tokenContract = new ethers.Contract(launch.token, PROTECTED_TOKEN_ABI, signer);
			addFeedback({ message: 'Enabling trading...', type: 'info' });
			// Open trading immediately (0 delay). The launchpad path doesn't
			// need an anti-snipe window here — graduation will handle the
			// per-pool lock when the curve fills.
			const tx = await tokenContract.enableTrading(0);
			await tx.wait();
			tradingEnabled = true;

			// Also exclude launch from limits + tax while we're at it
			try {
				const isExcluded = await tokenContract.isExcludedFromLimits(launchAddress);
				if (!isExcluded) {
					const tx2 = await tokenContract.setExcludedFromLimits(launchAddress, true);
					await tx2.wait();
				}
			} catch {}
			try {
				const isFree = await tokenContract.isTaxFree(launchAddress);
				if (!isFree) {
					const tx3 = await tokenContract.excludeFromTax(launchAddress, true);
					await tx3.wait();
				}
			} catch {}

			addFeedback({ message: 'Trading enabled! Buyers can now purchase.', type: 'success' });
		} catch (e: any) {
			addFeedback({ message: friendlyError(e), type: 'error' });
		} finally {
			isEnablingTrading = false;
		}
	}

	const PROTECTED_TOKEN_ABI = [
		'function setExcludedFromLimits(address account, bool excluded) external',
		'function excludeFromTax(address account, bool exempt) external',
		'function setAuthorizedLauncher(address launcher, bool authorized) external',
		'function isExcludedFromLimits(address) view returns (bool)',
		'function isTaxFree(address) view returns (bool)',
		'function isAuthorizedLauncher(address) view returns (bool)',
		'function secondsUntilTradingOpens() view returns (uint256)',
		'function tradingStartTime() view returns (uint256)',
		'function enableTrading(uint256 delay) external'
	];

	async function handleDeposit() {
		if (!signer || !userAddress || !launch || !network) {
			connectWallet();
			return;
		}

		isDepositing = true;
		try {
			const instance = new ethers.Contract(launchAddress, LAUNCH_INSTANCE_ABI, signer);
			const remaining = launch.totalTokensRequired - launch.totalTokensDeposited;

			if (remaining <= 0n) {
				addFeedback({ message: 'All tokens already deposited!', type: 'info' });
				await refreshData();
				return;
			}

			// Configure token for launchpad. The new contracts use a preflight
			// check inside LaunchInstance.depositTokens — if the launch isn't
			// excluded from limits, tax-exempt, AND authorized as a launcher,
			// the deposit succeeds but the launch stays Pending. So we set up
			// all three before depositing.
			//
			// Trading on the underlying token does NOT need to be enabled
			// here. Graduation will atomically call enableTrading(lockDuration)
			// once the curve fills, since the launch is now an authorized
			// launcher. Curve buys/refunds work because the launch instance
			// is in isExcludedFromLimits.
			const tokenContract = new ethers.Contract(launch.token, [...ERC20_ABI, ...PROTECTED_TOKEN_ABI], signer);

			try {
				const isExcluded: boolean = await tokenContract.isExcludedFromLimits(launchAddress);
				if (!isExcluded) {
					addFeedback({ message: 'Excluding launch from token limits...', type: 'info' });
					const tx = await tokenContract.setExcludedFromLimits(launchAddress, true);
					await tx.wait();
				}
			} catch {
				// Token may not implement the protection surface (external ERC20)
			}

			try {
				const isTaxFree: boolean = await tokenContract.isTaxFree(launchAddress);
				if (!isTaxFree) {
					addFeedback({ message: 'Excluding launch from token tax...', type: 'info' });
					const tx = await tokenContract.excludeFromTax(launchAddress, true);
					await tx.wait();
				}
			} catch {
				// Token may not be taxable — skip
			}

			try {
				const isAuth: boolean = await tokenContract.isAuthorizedLauncher(launchAddress);
				if (!isAuth) {
					addFeedback({ message: 'Authorizing launch instance...', type: 'info' });
					const tx = await tokenContract.setAuthorizedLauncher(launchAddress, true);
					await tx.wait();
				}
			} catch {
				// External token without isAuthorizedLauncher — preflight will skip this check
			}

			// Approve token transfer
			const allowance: bigint = await tokenContract.allowance(userAddress, launchAddress);
			if (allowance < remaining) {
				addFeedback({ message: `Approving ${tokenMeta.symbol}...`, type: 'info' });
				const approveTx = await tokenContract.approve(launchAddress, remaining);
				await approveTx.wait();
			}

			addFeedback({ message: 'Depositing tokens...', type: 'info' });
			const depositTx = await instance.depositTokens(remaining);
			await depositTx.wait();

			addFeedback({ message: 'Tokens deposited! Launch is now active.', type: 'success' });
			await refreshData();
		} catch (e: any) {
			addFeedback({ message: friendlyError(e), type: 'error' });
		} finally {
			isDepositing = false;
		}
	}

	async function handleRefund() {
		const l = launch;
		if (!signer || !userAddress || !l || !network) return;

		isRefunding = true;
		try {
			const tokenContract = new ethers.Contract(l.token, ERC20_ABI, signer);
			const allowance = await tokenContract.allowance(userAddress, launchAddress);
			if (allowance < userTokensBought) {
				addFeedback({ message: 'Approving token return...', type: 'info' });
				const approveTx = await tokenContract.approve(launchAddress, userTokensBought);
				await approveTx.wait();
			}

			addFeedback({ message: 'Processing refund...', type: 'info' });
			const instance = new ethers.Contract(launchAddress, LAUNCH_INSTANCE_ABI, signer);
			// New refund(uint256 tokensToReturn) supports partial refunds.
			// Pass the user's full position to keep the existing all-or-nothing UX.
			const tx = await instance.refund(userTokensBought);
			await tx.wait();
			addFeedback({ message: 'Refund successful!', type: 'success' });
			await refreshData();
		} catch (e: any) {
			addFeedback({ message: friendlyError(e), type: 'error' });
		} finally {
			isRefunding = false;
		}
	}

	async function handleGraduate() {
		if (!signer) return;
		isGraduating = true;
		try {
			const instance = new ethers.Contract(launchAddress, LAUNCH_INSTANCE_ABI, signer);
			addFeedback({ message: 'Graduating to DEX...', type: 'info' });
			const tx = await instance.graduate();
			await tx.wait();
			addFeedback({ message: 'Graduated! Liquidity added to DEX.', type: 'success' });
			await refreshData();
		} catch (e: any) {
			addFeedback({ message: friendlyError(e), type: 'error' });
		} finally {
			isGraduating = false;
		}
	}


	// Creator reclaim during Refunding — drains the contract's current
	// token balance to the creator. Refunds are USDT-out / tokens-in, so
	// any token in the contract at any moment during Refunding is free
	// to take. Subsequent calls pick up tokens returned by later refunds.
	async function handleReclaim() {
		if (!signer || !launch || launch.state !== 3) return;
		isReclaiming = true;
		try {
			const instance = new ethers.Contract(launchAddress, LAUNCH_INSTANCE_ABI, signer);
			addFeedback({ message: 'Reclaiming tokens...', type: 'info' });
			const tx = await instance.creatorWithdrawAvailable();
			await tx.wait();
			addFeedback({ message: 'Tokens reclaimed.', type: 'success' });
			await refreshData();
		} catch (e: any) {
			addFeedback({ message: friendlyError(e), type: 'error' });
		} finally {
			isReclaiming = false;
		}
	}

	// Manual activation for Pending launches. Only needed when the
	// preflight check wasn't satisfied at the moment of depositTokens —
	// e.g. the creator deposited first and authorized the launch later.
	// Idempotent with the auto-activation inside depositTokens.
	async function handleActivate() {
		if (!signer || !launch || launch.state !== 0) return;
		isActivating = true;
		try {
			const instance = new ethers.Contract(launchAddress, LAUNCH_INSTANCE_ABI, signer);
			addFeedback({ message: 'Activating launch...', type: 'info' });
			const tx = await instance.activate();
			await tx.wait();
			addFeedback({ message: 'Launch is now active.', type: 'success' });
			await refreshData();
		} catch (e: any) {
			addFeedback({ message: friendlyError(e), type: 'error' });
		} finally {
			isActivating = false;
		}
	}

	// Platform sweep of stranded USDT after 90 days of Refunding. For
	// buyers who abandoned their refund — the USDT goes to the platform
	// wallet, never to the caller. Contract-gated to msg.sender ==
	// platformWallet after the audit L2 fix, so the UI only renders
	// the button when the connected wallet matches.
	async function handleSweepStranded() {
		if (!signer || !launch || launch.state !== 3) return;
		isSweeping = true;
		try {
			const instance = new ethers.Contract(launchAddress, LAUNCH_INSTANCE_ABI, signer);
			addFeedback({ message: 'Sweeping stranded USDT...', type: 'info' });
			const tx = await instance.sweepStrandedUsdt();
			await tx.wait();
			addFeedback({ message: 'Stranded USDT swept to platform wallet.', type: 'success' });
			await refreshData();
		} catch (e: any) {
			addFeedback({ message: friendlyError(e), type: 'error' });
		} finally {
			isSweeping = false;
		}
	}

	// Derived state for the reclaim/sweep UI.
	// Sweep delay is read from the on-chain constant STRANDED_SWEEP_DELAY
	// (currently 5 years / 1825 days). Reading dynamically means any future
	// impl bump via setLaunchImplementation auto-propagates to the UI
	// without a frontend redeploy.
	let strandedSweepDelay = $state(0n); // loaded alongside refund state
	let sweepWindowOpen = $derived.by(() => {
		if (!launch || launch.state !== 3 || refundStartTimestamp === 0n || strandedSweepDelay === 0n) return false;
		return BigInt(Math.floor(Date.now() / 1000)) >= refundStartTimestamp + strandedSweepDelay;
	});
	let isPlatformWallet = $derived(
		!!userAddress &&
		!!platformWalletAddress &&
		userAddress.toLowerCase() === platformWalletAddress.toLowerCase()
	);
	let sweepAvailable = $derived(sweepWindowOpen && isPlatformWallet && strandedUsdtBalance > 0n);


	// ── Activity Feed (scroll-loaded, newest-first) ──
	type Purchase = {
		buyer: string;
		base_amount: string;
		tokens_received: string;
		fee: string;
		price: string;
		created_at: string;
	};
	const TX_PER_PAGE = 20;
	let txPage = $state(0);
	let txTotal = $state(0);
	let txItems: Purchase[] = $state([]);
	let txLoading = $state(true);
	let txLoadingMore = $state(false);
	let txHasMore = $derived(txItems.length < txTotal);
	let txRefreshInterval: ReturnType<typeof setInterval> | null = null;
	// Track whether this launch uses on-chain history or API fallback
	let txOnChain = $state(true);

	function relativeTime(iso: string): string {
		const diff = Date.now() - new Date(iso).getTime();
		if (diff < 60000) return $t('lpd.justNow');
		if (diff < 3600000) return $t('lpd.minutesAgo').replace('{n}', String(Math.floor(diff / 60000)));
		if (diff < 86400000) return $t('lpd.hoursAgo').replace('{n}', String(Math.floor(diff / 3600000)));
		return $t('lpd.daysAgo').replace('{n}', String(Math.floor(diff / 86400000)));
	}

	function parsePurchases(purchases: any[]): Purchase[] {
		return purchases.map((p: any) => ({
			buyer: p.buyer.toLowerCase(),
			base_amount: p.baseAmount.toString(),
			tokens_received: p.tokensReceived.toString(),
			fee: p.fee.toString(),
			price: p.price.toString(),
			created_at: new Date(Number(p.timestamp) * 1000).toISOString(),
		}));
	}

	function getTxInstance(provider: ethers.Provider) {
		return new ethers.Contract(launchAddress, [
			'function getPurchases(uint256 offset, uint256 limit) view returns (tuple(address buyer, uint256 baseAmount, uint256 tokensReceived, uint256 fee, uint256 price, uint256 timestamp)[] purchases, uint256 total)',
			'function totalPurchases() view returns (uint256)',
		], provider);
	}

	async function loadTransactions() {
		// Try reading from contract first (new impl with on-chain history)
		try {
			const net = network;
			if (net) {
				const provider = networkProviders.get(net.chain_id);
				if (provider) {
					const instance = getTxInstance(provider);
					const total = Number(await instance.totalPurchases());
					txTotal = total;
					if (total > 0) {
						const offset = Math.max(0, total - TX_PER_PAGE);
						const limit = Math.min(TX_PER_PAGE, total - offset);
						const { purchases } = await instance.getPurchases(offset, limit);
						txItems = parsePurchases(purchases).reverse(); // newest first
						txPage = 0;
						txOnChain = true;
						txLoading = false;
						return;
					} else {
						txItems = [];
						txOnChain = true;
						txLoading = false;
						return;
					}
				}
			}
		} catch {}

		// Fallback to API (old launches without on-chain history)
		txOnChain = false;
		try {
			const res = await fetch(`/api/launches/transactions?address=${launchAddress}&limit=20`);
			if (res.ok) {
				const data = await res.json();
				txItems = data;
				txTotal = data.length;
			}
		} catch {}
		txLoading = false;
	}

	async function loadMoreTransactions() {
		if (!txOnChain || txLoadingMore || !txHasMore) return;
		const net = network;
		if (!net) return;
		const provider = networkProviders.get(net.chain_id);
		if (!provider) return;

		txLoadingMore = true;
		try {
			const instance = getTxInstance(provider);
			const nextPage = txPage + 1;
			// Items already loaded = newest (nextPage * TX_PER_PAGE) items
			const endOffset = Math.max(0, txTotal - nextPage * TX_PER_PAGE);
			const offset = Math.max(0, endOffset - TX_PER_PAGE);
			const limit = Math.min(TX_PER_PAGE, endOffset - offset);
			if (limit <= 0) { txLoadingMore = false; return; }
			const { purchases } = await instance.getPurchases(offset, limit);
			const older = parsePurchases(purchases).reverse(); // newest first within this batch
			txItems = [...txItems, ...older];
			txPage = nextPage;
		} catch (e) {
			console.error('Failed to load more transactions', e);
		}
		txLoadingMore = false;
	}

	/** Poll refresh: only fetch the latest page (newest items) and merge new ones in */
	async function refreshLatestTransactions() {
		if (!txOnChain) return;
		const net = network;
		if (!net) return;
		const provider = networkProviders.get(net.chain_id);
		if (!provider) return;
		try {
			const instance = getTxInstance(provider);
			const total = Number(await instance.totalPurchases());
			if (total === txTotal && total > 0) return; // no new purchases
			const prevTotal = txTotal;
			txTotal = total;
			if (total === 0) { txItems = []; return; }
			const offset = Math.max(0, total - TX_PER_PAGE);
			const limit = Math.min(TX_PER_PAGE, total - offset);
			const { purchases } = await instance.getPurchases(offset, limit);
			const latest = parsePurchases(purchases).reverse();
			// Number of new items since last fetch
			const newCount = total - prevTotal;
			if (newCount > 0 && txItems.length > 0) {
				// Prepend only the new items, keep existing older items
				txItems = [...latest.slice(0, newCount), ...txItems];
			} else {
				txItems = latest;
			}
		} catch {}
	}

	async function recordTransaction(_baseAmount: string, _tokensReceived: string, _txHash?: string) {
		// Refresh from chain — new purchase will appear via getPurchases()
		await refreshLatestTransactions();
	}

	// Activity feed: WS events already trigger refreshLatestTransactions via launch sub.
	// Keep a slow fallback poll for safety.
	$effect(() => {
		const ws = getWsManager();
		if (launch && launch.state === 1) {
			loadTransactions();
			txRefreshInterval = setInterval(refreshLatestTransactions, ws ? 120_000 : 15000);
		} else {
			loadTransactions();
		}
		return () => {
			if (txRefreshInterval) { clearInterval(txRefreshInterval); txRefreshInterval = null; }
		};
	});

	onDestroy(() => {
		if (txRefreshInterval) clearInterval(txRefreshInterval);
		if (commentChannel) { commentChannel.unsubscribe(); commentChannel = null; }
	});

	// ── Comments / Discussion ──
	type Comment = {
		id: number;
		launch_address: string;
		chain_id: number;
		wallet_address: string;
		message: string;
		created_at: string;
	};
	let comments: Comment[] = $state([]);
	let commentsLoading = $state(true);
	let commentText = $state('');
	let isPostingComment = $state(false);

	async function loadComments() {
		try {
			const res = await fetch(`/api/launches/comments?address=${launchAddress}&limit=50`);
			if (res.ok) comments = await res.json();
		} catch { /* best effort */ }
		commentsLoading = false;
	}

	async function postComment() {
		if (!userAddress || !network || !signer || !commentText.trim()) return;
		const msg = commentText.trim();
		if (msg.length > 500) {
			addFeedback({ message: $t('lpd.commentTooLong'), type: 'error' });
			return;
		}
		isPostingComment = true;
		try {
			const timestamp = Date.now();
			const signMsg = `TokenKrafter Comment\nLaunch: ${launchAddress}\nOrigin: ${window.location.origin}\nTimestamp: ${timestamp}`;
			const signature = await signer.signMessage(signMsg);

			const res = await apiFetch('/api/launches/comments', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					launch_address: launchAddress,
					chain_id: network.chain_id,
					message: msg,
					signature,
					signed_message: signMsg
				})
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({ message: 'Failed to post comment' }));
				throw new Error(err.message || 'Failed to post comment');
			}
			const posted = await res.json();
			if (posted && !comments.find(c => c.id === posted.id)) {
				comments = [posted, ...comments];
			}
			commentText = '';
		} catch (e: any) {
			addFeedback({ message: e.message || 'Failed to post comment', type: 'error' });
		} finally {
			isPostingComment = false;
		}
	}

	// Subscribe to live comments via Supabase Realtime
	let commentChannel: ReturnType<typeof supabase.channel> | null = null;

	function subscribeToComments() {
		if (!launchAddress || commentChannel) return;
		commentChannel = supabase
			.channel(`comments-${launchAddress}`)
			.on('postgres_changes', {
				event: 'INSERT',
				schema: 'public',
				table: 'comments',
				filter: `launch_address=eq.${launchAddress.toLowerCase()}`
			}, (payload: any) => {
				const newComment = payload.new as Comment;
				if (newComment && !comments.find(c => c.id === newComment.id)) {
					comments = [newComment, ...comments];
				}
			})
			.subscribe();
	}

	$effect(() => {
		if (launch) {
			loadComments();
			subscribeToComments();
		}
	});
</script>

<svelte:head>
	<title>{tokenMeta.symbol} Launch | TokenKrafter Launchpad</title>
</svelte:head>

<!-- Deposit Modal -->
{#if showDepositModal && userAddress && network}
	<div class="modal-overlay" onclick={() => { showDepositModal = false; stopBalancePolling(); }}>
		<div class="modal-card" onclick={(e) => e.stopPropagation()}>
			<div class="flex justify-between items-center mb-4">
				<h2 class="syne text-xl font-bold text-white">{$t('lpd.insufficientBalance').replace('{token}', paymentLabel)}</h2>
				<button class="text-gray-500 hover:text-white text-lg cursor-pointer" onclick={() => { showDepositModal = false; stopBalancePolling(); }}>x</button>
			</div>

			<div class="text-center">
				<p class="text-gray-400 text-sm font-mono mb-1">
					{$t('lpd.youNeed')} <span class="text-cyan-400 font-semibold">{requiredAmount} {paymentLabel}</span> {$t('lpd.toComplete')}
				</p>
				<p class="text-gray-500 text-xs font-mono mb-4">
					{$t('lpd.currentBalance')}: {parseFloat(ethers.formatUnits(userPaymentBalance, paymentDecimals)).toFixed(4)} {paymentLabel}
				</p>

				<div class="qr-section mb-4">
					<div class="qr-box">
						<QrCode data={userAddress || ''} width={180} colorDark="#00d2ff" colorLight="#0d0d14" alt="Deposit address QR" />
					</div>
					<div class="address-box mt-3">
						<span class="text-cyan-400 text-xs font-mono break-all">{userAddress}</span>
					</div>
					<button
						class="text-gray-500 hover:text-cyan-400 text-[10px] font-mono mt-2 cursor-pointer transition"
						onclick={() => { navigator.clipboard.writeText(userAddress ?? ''); addFeedback({ message: 'Address copied!', type: 'success' }); }}
					>
						{$t('lpd.copyAddress')}
					</button>
				</div>

				<p class="text-gray-600 text-[10px] font-mono">
					{$t('lpd.sendTo').replace('{token}', paymentLabel)} <span class="text-gray-400">{network?.name || 'BSC'}</span>. {$t('lpd.autoDetect')}
				</p>

				<div class="flex items-center justify-center gap-2 mt-4">
					<div class="spinner-sm"></div>
					<span class="text-gray-500 text-xs font-mono">{$t('lpd.watchingDeposit')}</span>
				</div>
			</div>
		</div>
	</div>
{/if}

<div class="page-wrap max-w-6xl mx-auto px-4 sm:px-6 py-12">
	<!-- Back link -->
	<a href="/launchpad" class="text-gray-500 hover:text-cyan-400 text-sm font-mono transition no-underline mb-6 inline-block">
		← {$t('lpd.backToLaunchpad')}
	</a>

	{#if loading}
		<div class="flex flex-col items-center gap-4 py-20">
			<div class="spinner w-10 h-10 rounded-full border-2 border-white/10 border-t-cyan-400"></div>
			<p class="text-gray-500 text-sm font-mono">{$t('lpd.loading')}</p>
		</div>
	{:else if !launch && providersReady}
		<div class="text-center py-20">
			<p class="text-gray-400 font-mono text-sm">{$t('lpd.notFound')}</p>
			<a href="/launchpad" class="btn-primary text-sm px-5 py-2.5 mt-4 inline-block no-underline">
				{$t('lpd.browseLaunches')}
			</a>
		</div>
	{:else if !launch}
		<div class="flex flex-col items-center gap-4 py-20">
			<div class="spinner w-10 h-10 rounded-full border-2 border-white/10 border-t-cyan-400"></div>
			<p class="text-gray-500 text-sm font-mono">{$t('lpd.loading')}</p>
		</div>
	{:else}
		{@const color = stateColor(launch.state)}
		{@const nativeCoin = network?.native_coin || 'BNB'}
		{@const ud = usdtDecimals}

		<!-- Header -->
		<div class="token-header mb-6">
			<div class="token-header-top">
				<div class="token-identity">
					<div class="logo-upload-wrap">
						{#if metadata.logo_url}
							<img src={metadata.logo_url} alt="" class="token-logo card-logo-adapt" />
						{:else}
							<div class="token-logo token-logo-placeholder">
								<span>{(launch.tokenSymbol || '?')[0]}</span>
							</div>
						{/if}
						{#if isCreator}
							<label class="logo-upload-overlay" title="Upload logo (max 512 KB)">
								<input type="file" accept="image/*" class="hidden" onchange={handleLogoUpload} disabled={isUploadingLogo} />
								{#if isUploadingLogo}
									<span class="text-[10px]">...</span>
								{:else}
									<span class="text-[10px]">{$t('lpd.upload')}</span>
								{/if}
							</label>
						{/if}
					</div>
					<div>
						<div class="flex items-center gap-3 flex-wrap badge-row">
							<h1 class="syne text-2xl sm:text-3xl font-bold text-white leading-tight">
								{launch.tokenName || 'Unknown Token'}
							</h1>
							<span class="token-symbol-badge">{launch.tokenSymbol || '???'}</span>
							<span class="badge badge-{color} text-xs px-3 py-1">
								{stateLabel(launch.state)}
							</span>
							<!-- Badges -->
							{#each badges as badge}
								{#if BADGE_META[badge]}
									<span class="launch-badge badge-{BADGE_META[badge].color}" title={BADGE_META[badge].tooltip}>
										{BADGE_META[badge].label}
									</span>
								{/if}
							{/each}
							{#if tokenTrust?.is_safu}
								<span class="launch-badge badge-safu" title="SAFU — passes all on-chain safety checks">SAFU</span>
							{/if}
							{#if tokenTrust?.is_kyc}
								<span class="launch-badge badge-kyc" title="Creator identity verified">KYC</span>
							{/if}
							{#if tokenTrust?.lp_burned}
								<span class="launch-badge badge-lp" title="LP burned">LP Burned</span>
							{/if}
							{#if tokenTrust?.tax_ceiling_locked}
								<span class="launch-badge badge-locked" title="Tax ceiling locked">Tax Locked</span>
							{/if}
							{#if tokenTrust?.owner_renounced}
								<span class="launch-badge badge-renounced" title="Ownership renounced">Renounced</span>
							{/if}
							{#if tokenTrust}
								<span class="launch-badge badge-audited" title="Created via TokenKrafter audited contracts">Audited</span>
							{/if}
							{#if tokenTrust?.is_mintable}
								<span class="launch-badge badge-mintable" title="Token supply can be increased by owner">Mintable</span>
							{/if}
							{#if tokenTrust?.is_taxable && ((tokenTrust?.buy_tax_bps ?? 0) > 0 || (tokenTrust?.sell_tax_bps ?? 0) > 0)}
								{#if tokenTrust?.tax_ceiling_locked}
									<span class="launch-badge badge-tax-locked" title="Tax {((tokenTrust.buy_tax_bps ?? 0) / 100).toFixed(0)}/{((tokenTrust.sell_tax_bps ?? 0) / 100).toFixed(0)}% — rates locked at creation, cannot be increased">Tax {((tokenTrust.buy_tax_bps ?? 0) / 100).toFixed(0)}/{((tokenTrust.sell_tax_bps ?? 0) / 100).toFixed(0)}% Locked</span>
								{:else}
									<span class="launch-badge badge-taxable" title="Token has buy/sell tax — ceiling not locked">Tax {((tokenTrust.buy_tax_bps ?? 0) / 100).toFixed(0)}/{((tokenTrust.sell_tax_bps ?? 0) / 100).toFixed(0)}%</span>
								{/if}
							{/if}
							{#if tokenTrust?.is_partner}
								<span class="launch-badge badge-partner" title="Partner token">Partner</span>
							{/if}
							<!-- Favorite + Share buttons -->
							<button
								class="detail-fav-btn"
								onclick={() => toggleFavorite(launchAddress)}
								title={$favorites.includes(launchAddress.toLowerCase()) ? 'Remove from favorites' : 'Add to favorites'}
							>
								<svg width="18" height="18" viewBox="0 0 24 24" fill={$favorites.includes(launchAddress.toLowerCase()) ? '#00d2ff' : 'none'} stroke={$favorites.includes(launchAddress.toLowerCase()) ? '#00d2ff' : 'currentColor'} stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>
							</button>
							<a
								href={`https://x.com/intent/tweet?text=${encodeURIComponent(`🚀 Check out $${launch.tokenSymbol} on TokenKrafter!`)}&url=${encodeURIComponent(typeof window !== 'undefined' ? window.location.href : '')}`}
								target="_blank" rel="noopener" class="detail-fav-btn" title="Share on X"
							>𝕏</a>
							<button
								class="detail-fav-btn"
								title="Copy link"
								onclick={() => { if (typeof navigator !== 'undefined') { navigator.clipboard.writeText(window.location.href); addFeedback({ message: 'Link copied!', type: 'success' }); } }}
							>🔗</button>
						</div>
						<div class="header-tags">
							<span class="header-tag">{network?.name || 'BSC'}</span>
							<span class="header-tag">{CURVE_TYPES[launch.curveType]} {$t('lpd.curve')}</span>
							<span class="header-tag">{$t('lpd.creator')}: {shortAddr(launch.creator)}</span>
						</div>
						<!-- Social icons inline -->
						{#if metadata.website || metadata.twitter || metadata.telegram || metadata.discord}
							<div class="header-socials mt-2">
								{#if metadata.website}
									<a href={metadata.website} target="_blank" rel="noopener" class="header-social-icon" title="Website">🌐</a>
								{/if}
								{#if metadata.twitter}
									<a href={metadata.twitter.startsWith('http') ? metadata.twitter : `https://x.com/${metadata.twitter.replace('@', '')}`} target="_blank" rel="noopener" class="header-social-icon" title="Twitter">𝕏</a>
								{/if}
								{#if metadata.telegram}
									<a href={metadata.telegram.startsWith('http') ? metadata.telegram : `https://t.me/${metadata.telegram.replace('@', '')}`} target="_blank" rel="noopener" class="header-social-icon" title="Telegram">✈</a>
								{/if}
								{#if metadata.discord}
									<a href={metadata.discord.startsWith('http') ? metadata.discord : `https://discord.gg/${metadata.discord}`} target="_blank" rel="noopener" class="header-social-icon" title="Discord">💬</a>
								{/if}
							</div>
						{/if}
					</div>
				</div>
			</div>
		</div>

		<!-- Launch-specific rules (per-launch settings, not platform-wide guarantees) -->
		{#if badges.includes('taxable') || maxBuyPerWallet > 0n || lockDurationAfterListing > 0n || (launch.creatorAllocationBps > 0n && (vestingCliffSeconds > 0n || vestingDurationSeconds > 0n))}
		<div class="rules-card mb-4">
			<div class="rules-header">
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
				<span class="rules-title">Launch Settings</span>
			</div>
			<div class="rules-list">
				{#if badges.includes('taxable')}
					<div class="rules-item rules-enforced">
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
						<span>Tax rates locked — creator can't raise them</span>
					</div>
				{/if}
				{#if maxBuyPerWallet > 0n}
					<div class="rules-item rules-info">
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/></svg>
						<span>Max {formatUsdt(maxBuyPerWallet, usdtDecimals)} per wallet</span>
					</div>
				{/if}
				{#if lockDurationAfterListing > 0n}
					<div class="rules-item rules-info">
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
						<span>{Number(lockDurationAfterListing) >= 3600 ? `${Math.round(Number(lockDurationAfterListing) / 3600)}h` : `${Math.round(Number(lockDurationAfterListing) / 60)}m`} trading delay after graduation</span>
					</div>
				{/if}
				{#if launch.creatorAllocationBps > 0n && (vestingCliffSeconds > 0n || vestingDurationSeconds > 0n)}
					<div class="rules-item rules-info">
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
						<span>Creator tokens vested{vestingCliffSeconds > 0n ? ` — ${Math.round(Number(vestingCliffSeconds) / 86400)}d cliff` : ''}{vestingDurationSeconds > 0n ? ` + ${Math.round(Number(vestingDurationSeconds) / 86400)}d linear unlock` : ''}</span>
					</div>
				{/if}
			</div>
		</div>
		{/if}

		<!-- Graduation Celebration Banner -->
		{#if launch.state === 2 && !graduationDismissed}
			<div class="graduation-banner mb-6">
				<div class="graduation-particles"></div>
				<div class="graduation-content">
					<span class="graduation-text">🎉 {$t('lpd.graduatedBanner')}</span>
					<button class="graduation-dismiss" onclick={() => { graduationDismissed = true; }} title={$t('lpd.dismissBanner')}>✕</button>
				</div>
			</div>
		{/if}

		<!-- Creator vesting claim (graduated + creator has allocation) -->
		{#if launch.state === 2 && isCreator && launch.creatorAllocationBps > 0n && vestingDurationSeconds > 0n && graduationTimestamp > 0n}
			{@const elapsed = BigInt(Math.floor(tickNow / 1000)) - graduationTimestamp}
			{@const pastCliff = elapsed >= vestingCliffSeconds}
			{@const vestedTime = pastCliff ? elapsed - vestingCliffSeconds : 0n}
			{@const totalVested = vestedTime >= vestingDurationSeconds ? creatorTotalTokens : (vestingDurationSeconds > 0n ? (creatorTotalTokens * vestedTime / vestingDurationSeconds) : 0n)}
			{@const claimable = totalVested > creatorClaimed ? totalVested - creatorClaimed : 0n}
			<div class="card p-5 mb-4" style="border-color: rgba(139,92,246,0.2);">
				<div class="flex items-center justify-between mb-3">
					<h3 class="syne font-bold text-white text-sm">Creator Vesting</h3>
					<span class="text-purple-400 text-xs font-mono">{Math.round(Number(vestingDurationSeconds) / 86400)}d vest · {Math.round(Number(vestingCliffSeconds) / 86400)}d cliff</span>
				</div>
				<div class="detail-grid mb-3">
					<div class="detail-row">
						<span class="detail-label">Total allocation</span>
						<span class="detail-value">{formatTokens(creatorTotalTokens || 0n, launch.tokenDecimals)} {launch.tokenSymbol}</span>
					</div>
					<div class="detail-row">
						<span class="detail-label">Claimed</span>
						<span class="detail-value">{formatTokens(creatorClaimed || 0n, launch.tokenDecimals)} {launch.tokenSymbol}</span>
					</div>
					<div class="detail-row">
						<span class="detail-label">Claimable now</span>
						<span class="detail-value text-purple-400">{pastCliff ? formatTokens(claimable > 0n ? claimable : 0n, launch.tokenDecimals) : 'Cliff not reached'} {pastCliff && claimable > 0n ? launch.tokenSymbol : ''}</span>
					</div>
				</div>
				{#if pastCliff && claimable > 0n}
					<button class="btn-primary text-xs px-4 py-2 w-full" onclick={async () => {
						try {
							const net = network;
							if (!net) return;
							const provider = networkProviders.get(net.chain_id);
							if (!provider || !signer) { addFeedback({ message: 'Connect wallet first', type: 'error' }); return; }
							const s = (signer as any).connect ? (signer as any).connect(provider) : signer;
							const instance = new ethers.Contract(launch.address, ['function claimCreatorTokens()'], s);
							addFeedback({ message: 'Claiming vested tokens...', type: 'info' });
							const tx = await instance.claimCreatorTokens();
							await tx.wait();
							addFeedback({ message: 'Vested tokens claimed!', type: 'success' });
							refreshData();
						} catch (e: any) {
							addFeedback({ message: e.shortMessage || e.message || 'Claim failed', type: 'error' });
						}
					}}>
						Claim Vested Tokens
					</button>
				{:else if !pastCliff}
					<p class="text-gray-500 text-xs font-mono text-center">Cliff ends in {Math.max(0, Math.round(Number(vestingCliffSeconds - elapsed) / 86400))} days</p>
				{/if}
			</div>
		{/if}

		<div class="page-grid">
			<!-- About — own grid item so mobile can place it between buy and tokenomics -->
			<div class="about-col">
				{#if isEditing || metadata.description || metadata.video_url || isCreator}
				<div class="card p-6">
					{#if isEditing}
						<!-- Inline edit mode -->
						<div class="flex justify-between items-center mb-4">
							<h3 class="syne font-bold text-white">{$t('lpd.editTokenInfo')}</h3>
							<button onclick={cancelEditing} class="text-gray-500 hover:text-white text-xs font-mono cursor-pointer">{$t('common.cancel')}</button>
						</div>

						<div class="flex flex-col gap-4">
							<div>
								<label class="label-text" for="edit-desc">{$t('lpd.editDesc')}</label>
								<textarea id="edit-desc" class="input-field" rows="5" placeholder="Tell users about your token, its utility, roadmap..." bind:value={editDescription}></textarea>
							</div>

							<div>
								<label class="label-text" for="edit-video">{$t('lpd.editVideo')}</label>
								<input id="edit-video" type="url" class="input-field" placeholder="https://youtube.com/watch?v=... or https://x.com/.../video" bind:value={editVideoUrl} />
							</div>

							<div class="grid grid-cols-2 gap-3">
								<div>
									<label class="label-text" for="edit-website">{$t('lpd.editWebsite')}</label>
									<input id="edit-website" type="url" class="input-field" placeholder="https://..." bind:value={editWebsite} />
								</div>
								<div>
									<label class="label-text" for="edit-twitter">{$t('lpd.editTwitter')}</label>
									<input id="edit-twitter" class="input-field" placeholder="@handle or URL" bind:value={editTwitter} />
								</div>
							</div>
							<div class="grid grid-cols-2 gap-3">
								<div>
									<label class="label-text" for="edit-telegram">{$t('lpd.editTelegram')}</label>
									<input id="edit-telegram" class="input-field" placeholder="@group or URL" bind:value={editTelegram} />
								</div>
								<div>
									<label class="label-text" for="edit-discord">{$t('lpd.editDiscord')}</label>
									<input id="edit-discord" class="input-field" placeholder="Invite code or URL" bind:value={editDiscord} />
								</div>
							</div>

							<div class="flex gap-3">
								<button onclick={cancelEditing} class="btn-secondary flex-1 py-2.5 text-sm cursor-pointer">{$t('common.cancel')}</button>
								<button onclick={saveMetadata} disabled={isSavingMeta} class="btn-primary flex-1 py-2.5 text-sm cursor-pointer">
									{isSavingMeta ? $t('lpd.saving') : $t('lpd.saveChanges')}
								</button>
							</div>
						</div>
					{:else}
						<!-- View mode -->
						<div class="flex justify-between items-center mb-3">
							<h3 class="syne font-bold text-white">{$t('lpd.about')}</h3>
							{#if isCreator}
								<button onclick={startEditing} class="text-gray-500 hover:text-cyan-400 text-xs font-mono transition cursor-pointer">
									{metadata.description ? $t('lpd.editInfo') : $t('lpd.addInfo')}
								</button>
							{/if}
						</div>
						{#if metadata.description}
							<p class="text-gray-300 font-mono text-sm leading-relaxed whitespace-pre-line">{metadata.description}</p>
						{:else if isCreator}
							<button onclick={startEditing} class="empty-state-btn">
								<span class="text-gray-500 text-sm">{$t('lpd.addDescription')}</span>
							</button>
						{/if}

						<!-- Video embed -->
						{#if metadata.video_url}
							<div class="video-embed mt-4">
								{#if metadata.video_url.includes('youtube.com') || metadata.video_url.includes('youtu.be')}
									{@const videoId = metadata.video_url.includes('youtu.be')
										? metadata.video_url.split('/').pop()?.split('?')[0]
										: new URL(metadata.video_url).searchParams.get('v')}
									{#if videoId}
										<iframe
											src="https://www.youtube.com/embed/{videoId}"
											title="Video"
											class="video-iframe"
											allowfullscreen
											frameborder="0"
										></iframe>
									{/if}
								{:else}
									<a href={metadata.video_url} target="_blank" rel="noopener" class="video-link-card">
										<span class="text-lg">▶</span>
										<span class="text-gray-300 text-sm font-mono">{$t('lpd.watchVideo')}</span>
									</a>
								{/if}
							</div>
						{/if}
					{/if}
				</div>
				{/if}
			</div>

			<!-- Left: Tokenomics, Curve, Discussion -->
			<div class="left-col">
				<!-- Tokenomics -->
				<div class="card p-6 mb-4">
					<h3 class="syne font-bold text-white mb-4">{$t('lpd.tokenomics')}</h3>
					{#if launch}
					{@const totalTokens = launch.tokensForCurve + launch.tokensForLP + (launch.totalTokensRequired > 0n ? (launch.totalTokensRequired - launch.tokensForCurve - launch.tokensForLP) : 0n)}
					{@const curvePct = totalTokens > 0n ? Number((launch.tokensForCurve * 10000n) / totalTokens) / 100 : 0}
					{@const lpPct = totalTokens > 0n ? Number((launch.tokensForLP * 10000n) / totalTokens) / 100 : 0}
					{@const creatorPct = Number(launch.creatorAllocationBps) / 100}
					{@const remainPct = Math.max(0, 100 - curvePct - lpPct)}

					<!-- Pie chart -->
					{@const pieData = [
						{ value: curvePct, name: $t('lpd.curveSale'), itemStyle: { color: '#22d3ee' } },
						{ value: lpPct, name: $t('lpd.liquidityPool'), itemStyle: { color: '#a78bfa' } },
						...(remainPct > 0 ? [{ value: remainPct, name: $t('lpd.creatorLabel'), itemStyle: { color: '#fbbf24' } }] : []),
					]}
					<Chart option={{
						tooltip: { trigger: 'item', formatter: '{b}: {d}%' },
						legend: { bottom: 0, left: 'center', itemWidth: 10, itemHeight: 10, itemGap: 16, textStyle: { color: '#94a3b8', fontSize: 11, fontFamily: "'Rajdhani', sans-serif" } },
						series: [{
							type: 'pie',
							radius: ['45%', '75%'],
							center: ['50%', '45%'],
							avoidLabelOverlap: true,
							itemStyle: { borderRadius: 4, borderColor: 'transparent', borderWidth: 2 },
							label: { show: true, formatter: '{d}%', fontSize: 11, fontFamily: "'Rajdhani', sans-serif", fontWeight: 600 },
							labelLine: { length: 8, length2: 8 },
							data: pieData,
						}],
					}} height="220px" />

					<div class="detail-grid">
						<div class="detail-row">
							<span class="detail-label">{$t('lpd.tokensForCurve')}</span>
							<span class="detail-value">{formatTokens(launch.tokensForCurve, tokenMeta.decimals)}</span>
						</div>
						<div class="detail-row">
							<span class="detail-label">{$t('lpd.tokensForLP')}</span>
							<span class="detail-value">{formatTokens(launch.tokensForLP, tokenMeta.decimals)}</span>
						</div>
						{#if creatorPct > 0}
							<div class="detail-row">
								<span class="detail-label">{$t('lpd.creatorAllocation')}</span>
								<span class="detail-value">{creatorPct}%</span>
							</div>
						{/if}
						<div class="detail-row">
							<span class="detail-label">{$t('lpd.totalRequired')}</span>
							<span class="detail-value">{formatTokens(launch.totalTokensRequired, tokenMeta.decimals)}</span>
						</div>
					</div>
					{/if}
				</div>

				<!-- Price Curve -->
				<div class="card p-6 mb-4">
					<div class="flex items-center justify-between mb-4">
						<h3 class="syne font-bold text-white">{$t('lpd.priceCurve')}</h3>
						<span class="text-gray-500 text-xs font-mono">{CURVE_TYPES[launch.curveType]}</span>
					</div>
					<PriceProgressChart
						curveType={launch.curveType}
						tokensForCurve={launch.tokensForCurve}
						tokensSold={launch.tokensSold}
						currentPrice={launch.currentPrice}
						softCap={launch.softCap}
						hardCap={launch.hardCap}
						totalBaseRaised={launch.totalBaseRaised}
						{userBasePaid}
						{userTokensBought}
						tokenDecimals={tokenMeta.decimals}
						usdtDecimals={ud}
					/>
				</div>

				<!-- Sale Parameters & Contracts -->
				<div class="card sale-params mb-4">
					<h3 class="sale-params-title">Sale Details</h3>

					<!-- Trust highlights — the things buyers care about most -->
					<div class="sale-highlights">
						<div class="sale-highlight sale-highlight-green">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z"/><path d="M8 12l3 3 5-5"/></svg>
							<span>LP burned permanently at graduation</span>
						</div>
						<div class="sale-highlight">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/></svg>
							<span>Full refund if soft cap not reached</span>
						</div>
					</div>

					<div class="sale-rows">
						<div class="sale-row">
							<span class="sale-row-label">Buy fee</span>
							<span class="sale-row-val">1% <span class="sale-row-hint">per purchase</span></span>
						</div>
						<div class="sale-row">
							<span class="sale-row-label">Graduation fee</span>
							<span class="sale-row-val">1% <span class="sale-row-hint">of final raise</span></span>
						</div>
						{#if maxBuyPerWallet > 0n}
							<div class="sale-row">
								<span class="sale-row-label">Max per wallet</span>
								<span class="sale-row-val">{formatUsdt(maxBuyPerWallet, ud)} <span class="sale-row-hint">({maxBuyPct}%)</span></span>
							</div>
						{/if}
						{#if minBuyUsdt > 0n}
							<div class="sale-row">
								<span class="sale-row-label">Min buy</span>
								<span class="sale-row-val">{formatUsdt(minBuyUsdt, ud)}</span>
							</div>
						{/if}
						<div class="sale-row">
							<span class="sale-row-label">DEX at graduation</span>
							<span class="sale-row-val">{network?.symbol === 'BSC' ? 'PancakeSwap' : 'Uniswap'} V2</span>
						</div>
					</div>

					<div class="sale-contracts">
						<span class="sale-contracts-label">Contracts</span>
						{#each [
							['Token', launch.token, tokenTrust ? `/explore/${chainSlug(network?.chain_id ?? 56)}/${launch.token}` : `${network?.explorer_url || ''}/address/${launch.token}`],
							['Launch', launch.address, `${network?.explorer_url || ''}/address/${launch.address}`],
							['Creator', launch.creator, `${network?.explorer_url || ''}/address/${launch.creator}`],
						] as [label, addr, href]}
							<div class="sale-addr-row">
								<span>{label}</span>
								<div class="sale-addr-group">
									<a href={href} target={label === 'Token' && tokenTrust ? undefined : '_blank'} rel="noopener noreferrer" class="sale-addr">{addr.slice(0, 6)}…{addr.slice(-4)}</a>
									<button class="copy-addr-btn" title="Copy address" onclick={() => { navigator.clipboard.writeText(addr); addFeedback({ message: 'Copied!', type: 'success' }); }}>
										<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
									</button>
								</div>
							</div>
						{/each}
					</div>
				</div>

				<!-- Global Transaction Ticker (social proof) -->
				<div class="mb-4">
					<RecentTransactionsTicker launchAddress={launchAddress} limit={10} />
				</div>

				<!-- Activity Feed -->
				<div class="card p-6 mb-4">
					<div class="activity-header">
						<h3 class="syne font-bold text-white">{$t('lpd.recentActivity')}</h3>
						{#if launch.state === 1}
							<span class="activity-live-indicator"><span class="activity-live-pulse"></span>LIVE</span>
						{/if}
					</div>
					{#if txLoading}
						<div class="text-gray-500 text-xs font-mono text-center py-4">{$t('status.loading')}...</div>
					{:else if txItems.length === 0}
						<div class="activity-empty">
							<div class="activity-empty-icon">
								<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
							</div>
							<p>No buys yet</p>
							<span>Be the first — early buyers get the lowest price</span>
						</div>
					{:else}
						{@const totalBuyers = new Set(txItems.map(t => t.buyer)).size}
						{@const totalVol = txItems.reduce((sum, t) => sum + parseFloat(ethers.formatUnits(BigInt(t.base_amount) + BigInt(t.fee || '0'), usdtDecimals)), 0)}
						{@const recentBuys = txItems.filter(t => {
							const ts = typeof t.created_at === 'number' ? t.created_at * 1000 : new Date(t.created_at).getTime();
							return Date.now() - ts < 300000;
						}).length}
						{@const remainingUsdt = launch ? launch.hardCap - launch.totalBaseRaised : 0n}
						{@const remainingUsdtNum = Number(remainingUsdt) / (10 ** usdtDecimals)}
						<div class="activity-stats">
							<div class="activity-stat">
								<span class="activity-stat-val">{txTotal}</span>
								<span class="activity-stat-label">buys</span>
							</div>
							<div class="activity-stat-divider"></div>
							<div class="activity-stat">
								<span class="activity-stat-val">{totalBuyers}</span>
								<span class="activity-stat-label">buyers</span>
							</div>
							<div class="activity-stat-divider"></div>
							<div class="activity-stat">
								<span class="activity-stat-val">${totalVol >= 1000 ? (totalVol / 1000).toFixed(1) + 'K' : totalVol.toFixed(0)}</span>
								<span class="activity-stat-label">volume</span>
							</div>
						</div>

						<!-- Momentum + scarcity signals -->
						<div class="activity-signals">
							{#if recentBuys > 0}
								<div class="activity-signal signal-momentum">
									<span class="signal-pulse"></span>
									{recentBuys} {recentBuys === 1 ? 'buy' : 'buys'} in the last 5 min
								</div>
							{/if}
							{#if remainingUsdt > 0n && remainingUsdtNum < 500}
								<div class="activity-signal signal-scarcity">
									<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
									Only {formatUsdt(remainingUsdt, ud)} left until hard cap
								</div>
							{/if}
							{#if userBasePaid > 0n && launch && launch.currentPrice > 0n}
								{@const userAvg = Number(userBasePaid) / Number(userTokensBought)}
								{@const currentP = Number(launch.currentPrice) / (10 ** usdtDecimals)}
								{#if currentP > userAvg}
									{@const gain = ((currentP - userAvg) / userAvg * 100)}
									<div class="activity-signal signal-gain">
										<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/></svg>
										Your entry is {gain.toFixed(0)}% below current price
									</div>
								{/if}
							{/if}
						</div>
						{#if true}
						{@const firstBuyerAddr = txItems.length > 0 ? txItems[txItems.length - 1].buyer : ''}
						{@const curPriceForCtx = launch ? Number(launch.currentPrice) / (10 ** usdtDecimals) : 0}
						{@const buyerCounts = txItems.reduce((m, tx) => { m[tx.buyer] = (m[tx.buyer] || 0) + 1; return m; }, {} as Record<string, number>)}
						{@const softCapNum = launch ? Number(launch.softCap) / (10 ** usdtDecimals) : 0}
						{@const hardCapNum2 = launch ? Number(launch.hardCap) / (10 ** usdtDecimals) : 0}
						<div class="activity-list">
							{#each txItems as tx, i}
								{@const usdtVal = parseFloat(ethers.formatUnits(BigInt(tx.base_amount) + BigInt(tx.fee || '0'), usdtDecimals))}
								{@const tokVal = parseFloat(ethers.formatUnits(BigInt(tx.tokens_received), tokenMeta.decimals))}
								{@const hardCapVal = Number(launch.hardCap) / (10 ** usdtDecimals)}
								{@const isWhale = hardCapVal > 0 && (usdtVal / hardCapVal) >= 0.05}
								{@const isSelf = tx.buyer === userAddress?.toLowerCase()}
								{@const txTs = typeof tx.created_at === 'number' ? tx.created_at * 1000 : new Date(tx.created_at).getTime()}
								{@const ageMs = Date.now() - txTs}
								{@const isLive = ageMs < 300000}
								{@const fmtTok = tokVal > 1000000 ? (tokVal / 1000000).toFixed(1) + 'M' : tokVal > 1000 ? (tokVal / 1000).toFixed(1) + 'K' : tokVal.toFixed(0)}
								{@const isFirstBuyer = tx.buyer === firstBuyerAddr && i === txItems.length - 1}
								{@const isRepeat = (buyerCounts[tx.buyer] || 0) > 1}
								{@const txPrice = tokVal > 0 ? usdtVal / tokVal : 0}
								{@const priceDiffPct = curPriceForCtx > 0 && txPrice > 0 ? ((curPriceForCtx - txPrice) / txPrice * 100) : 0}

								<!-- Milestone markers — txItems is newest-first, so raised at row i = sum from i to end -->
								{#if i < txItems.length - 1}
									{@const raisedIncluding = txItems.slice(i).reduce((s, t) => s + parseFloat(ethers.formatUnits(BigInt(t.base_amount), usdtDecimals)), 0)}
									{@const raisedBefore = txItems.slice(i + 1).reduce((s, t) => s + parseFloat(ethers.formatUnits(BigInt(t.base_amount), usdtDecimals)), 0)}
									{#if softCapNum > 0 && raisedBefore < softCapNum && raisedIncluding >= softCapNum}
										<div class="activity-milestone milestone-sc">🎯 Soft cap reached!</div>
									{/if}
									{#if hardCapNum2 > 0 && raisedBefore < hardCapNum2 * 0.5 && raisedIncluding >= hardCapNum2 * 0.5}
										<div class="activity-milestone milestone-half">💎 50% to hard cap</div>
									{/if}
									{@const buyNumber = txItems.length - i}
									{#if buyNumber === 10}
										<div class="activity-milestone milestone-buyers">👥 10th purchase</div>
									{/if}
								{/if}

								<div class="activity-row" class:activity-latest={i === 0} class:activity-whale={isWhale} class:activity-self={isSelf} class:activity-live={isLive} style="animation-delay: {i * 40}ms">
									<div class="activity-left">
										{#if isLive}
											<span class="activity-live-dot"></span>
										{:else}
											<span class="activity-dot"></span>
										{/if}
										{#if i < txItems.length - 1}
											<span class="activity-line"></span>
										{/if}
									</div>
									<div class="activity-card">
										<div class="activity-card-top">
											<a href="{network?.explorer_url || ''}/address/{tx.buyer}" target="_blank" rel="noopener noreferrer" class="activity-addr">{isSelf ? 'You' : shortAddr(tx.buyer)}</a>
											{#if isFirstBuyer}<span class="activity-badge badge-first">🥇 First</span>{/if}
											{#if isWhale}<span class="activity-badge badge-whale">🐋</span>{/if}
											{#if isRepeat && !isSelf}<span class="activity-badge badge-repeat">🔁</span>{/if}
											{#if isLive}
												<span class="activity-live-badge">just now</span>
											{:else}
												<span class="activity-time">{relativeTime(tx.created_at)}</span>
											{/if}
										</div>
										<div class="activity-card-hero">
											<span class="activity-tok">{fmtTok}</span> <span class="activity-tok-sym">{tokenMeta.symbol}</span> <span class="activity-sep">·</span> <span class="activity-usd">${usdtVal < 0.01 ? '<0.01' : usdtVal.toFixed(2)}</span>
										</div>
										{#if priceDiffPct > 10}
											<div class="activity-price-ctx">bought {priceDiffPct > 999 ? (priceDiffPct / 100).toFixed(0) + 'x' : priceDiffPct.toFixed(0) + '%'} below current price</div>
										{/if}
									</div>
								</div>
							{/each}
						</div>

						<!-- Join CTA -->
						{#if launch.state === 1 && !userAddress}
							<div class="activity-join-cta">
								<span>Join {totalBuyers} buyer{totalBuyers !== 1 ? 's' : ''}</span>
								<button class="btn-primary text-xs px-4 py-2" onclick={connectWallet}>Connect & Buy →</button>
							</div>
						{:else if launch.state === 1 && userBasePaid === 0n}
							<div class="activity-join-cta">
								<span>Be buyer #{totalBuyers + 1}</span>
								<a href="#buy-amount" class="btn-primary text-xs px-4 py-2 no-underline">Buy Now →</a>
							</div>
						{/if}

						{#if txHasMore}
							<button class="load-more-btn" onclick={loadMoreTransactions} disabled={txLoadingMore}>
								{txLoadingMore ? `${$t('status.loading')}...` : `Load older (${txTotal - txItems.length} more)`}
							</button>
						{/if}
						{/if}
					{/if}
				</div>

				<!-- Discussion / Comments -->
				<div class="card p-6 mb-4">
					<h3 class="syne font-bold text-white mb-4">{$t('lpd.discussion')}</h3>

					<!-- Post new comment -->
					{#if userAddress}
						<div class="comment-form mb-4">
							<textarea
								class="input-field comment-input"
								rows="2"
								maxlength="500"
								placeholder={$t('lpd.commentPlaceholder')}
								bind:value={commentText}
							></textarea>
							<div class="flex justify-between items-center mt-2">
								<span class="text-gray-600 text-[10px] font-mono">{commentText.length}/500</span>
								<button
									onclick={postComment}
									disabled={isPostingComment || !commentText.trim()}
									class="btn-primary px-4 py-1.5 text-xs cursor-pointer"
								>
									{isPostingComment ? $t('lpd.posting') : $t('lpd.postComment')}
								</button>
							</div>
						</div>
					{:else}
						<div class="text-center py-3 mb-4 border border-dashed border-gray-700 rounded-lg">
							<p class="text-gray-500 text-xs font-mono">{$t('lpd.connectToComment')}</p>
						</div>
					{/if}

					<!-- Comments list -->
					{#if commentsLoading}
						<div class="text-gray-500 text-xs font-mono text-center py-4">{$t('status.loading')}...</div>
					{:else if comments.length === 0}
						<p class="text-gray-600 font-mono text-sm italic text-center py-4">{$t('lpd.noComments')}</p>
					{:else}
						<div class="comments-list">
							{#each comments as comment}
								<div class="comment-item">
									<div class="comment-header">
										<span class="text-cyan-400 text-xs font-mono font-semibold">{shortAddr(comment.wallet_address)}</span>
										<span class="text-gray-600 text-[10px] font-mono">{relativeTime(comment.created_at)}</span>
									</div>
									<p class="text-gray-300 text-sm font-mono leading-relaxed mt-1 whitespace-pre-line break-words">{comment.message}</p>
								</div>
							{/each}
						</div>
					{/if}
				</div>
				<!-- FAQ — dynamic based on token type -->
				{#if true}
				{@const isPlatformToken = !!tokenTrust}
				{@const isTaxable = tokenTrust?.is_taxable}
				{@const isMintable = tokenTrust?.is_mintable && !tokenTrust?.owner_renounced}
				{@const isExternal = !tokenTrust}
				{@const faqs = [
					{ q: $t('lpd.faqCurveQ'), a: $t('lpd.faqCurveA') },
					{ q: $t('lpd.faqHardCapQ'), a: $t('lpd.faqHardCapA') },
					{ q: $t('lpd.faqSoftCapQ'), a: $t('lpd.faqSoftCapA') },
					{ q: $t('lpd.faqSafeQ'), a: $t('lpd.faqSafeA') },
					{ q: $t('lpd.faqFeeQ'), a: $t('lpd.faqFeeA') },
					{ q: $t('lpd.faqCreatorQ'), a: $t('lpd.faqCreatorA') },
					...(isTaxable ? [{ q: $t('lpd.faqTaxQ'), a: $t('lpd.faqTaxA') }] : []),
					...(isMintable ? [{ q: $t('lpd.faqMintQ'), a: $t('lpd.faqMintA') }] : []),
					...(isExternal ? [{ q: $t('lpd.faqExternalQ'), a: $t('lpd.faqExternalA') }] : []),
					...(isPlatformToken ? [{ q: $t('lpd.faqAuditedQ'), a: $t('lpd.faqAuditedA') }] : []),
				]}
				<div class="card p-6 mb-4">
					<h3 class="syne font-bold mb-4" style="color: var(--text-heading)">{$t('lpd.faqTitle')}</h3>
					{#each faqs as faq, i}
						<details class="faq-item" class:faq-first={i === 0}>
							<summary class="faq-q">{faq.q}</summary>
							<p class="faq-a">{faq.a}</p>
						</details>
					{/each}
				</div>
				{/if}
			</div>

			<!-- Right: Actions & Progress -->
			<div class="right-col">
				<!-- Countdown Timer -->
				{#if countdown && launch.state === 1}
					<div class="card p-5 mb-4" style={isScheduled ? 'border-color: rgba(245, 158, 11, 0.2)' : ''}>
						<LaunchCountdown
							deadline={Number(launch.deadline)}
							size="lg"
							variant={isScheduled ? 'amber' : 'cyan'}
							label={isScheduled ? 'Sale Starts In' : $t('lpd.saleEndsIn')}
						/>
					</div>
				{/if}

				<!-- Mobile-only: compact About between timer and buy -->
				{#if metadata.description || isCreator}
					<div class="card p-4 mb-4 mobile-about">
						{#if isEditing}
							<!-- Inline edit on mobile -->
							<div class="flex justify-between items-center mb-3">
								<h4 class="syne font-bold text-sm" style="color: var(--text-heading)">{$t('lpd.editTokenInfo')}</h4>
								<button onclick={cancelEditing} class="text-gray-500 hover:text-white text-xs font-mono cursor-pointer">{$t('common.cancel')}</button>
							</div>
							<div class="flex flex-col gap-3">
								<textarea class="input-field" rows="4" placeholder="Tell users about your token..." bind:value={editDescription}></textarea>
								<input type="url" class="input-field" placeholder="Video URL (YouTube, X)" bind:value={editVideoUrl} />
								<div class="grid grid-cols-2 gap-2">
									<input type="url" class="input-field" placeholder="Website" bind:value={editWebsite} />
									<input class="input-field" placeholder="Twitter" bind:value={editTwitter} />
								</div>
								<div class="grid grid-cols-2 gap-2">
									<input class="input-field" placeholder="Telegram" bind:value={editTelegram} />
									<input class="input-field" placeholder="Discord" bind:value={editDiscord} />
								</div>
								<div class="flex gap-2">
									<button onclick={cancelEditing} class="btn-secondary flex-1 py-2 text-xs cursor-pointer">{$t('common.cancel')}</button>
									<button onclick={saveMetadata} disabled={isSavingMeta} class="btn-primary flex-1 py-2 text-xs cursor-pointer">
										{isSavingMeta ? $t('lpd.saving') : $t('lpd.saveChanges')}
									</button>
								</div>
							</div>
						{:else}
							<div class="flex justify-between items-center mb-2">
								<h4 class="syne font-bold text-sm" style="color: var(--text-heading)">{$t('lpd.about')}</h4>
								{#if isCreator}
									<button onclick={startEditing} class="text-gray-500 hover:text-cyan-400 text-xs font-mono transition cursor-pointer">
										{metadata.description ? $t('lpd.editInfo') : $t('lpd.addInfo')}
									</button>
								{/if}
							</div>
							{#if metadata.description}
								<p class="mobile-about-text" class:mobile-about-expanded={mobileAboutExpanded}>{metadata.description}</p>
								{#if metadata.description.length > 120}
									<button class="mobile-about-toggle" onclick={() => mobileAboutExpanded = !mobileAboutExpanded}>
										{mobileAboutExpanded ? 'Show less' : 'Read more'}
									</button>
								{/if}
							{:else if isCreator}
								<button onclick={startEditing} class="empty-state-btn">
									<span class="text-gray-500 text-xs">{$t('lpd.addDescription')}</span>
								</button>
							{/if}
						{/if}
					</div>
				{/if}

				<!-- Progress -->
				<div class="card p-5 mb-4">
					<!-- Progress bars -->
					<div class="mb-3">
						<div class="flex justify-between text-xs font-mono mb-1.5">
							<span class="text-gray-300 font-semibold">{formatUsdt(launch.totalBaseRaised, ud)}</span>
							<span class="text-gray-500">{formatUsdt(launch.hardCap, ud)}</span>
						</div>
						<div class="lp-progress-wrap">
							<div class="progress-track progress-track-lg">
								<div class="progress-fill progress-cyan" style="width: {Math.max(progress > 0 ? 0.5 : 0, progress)}%"></div>
							</div>
							{#if softCapPct > 0 && softCapPct < 100}
								<div class="lp-sc-marker" style="left: {softCapPct}%" title="Soft Cap: {formatUsdt(launch.softCap, ud)}">
									<div class="lp-sc-line"></div>
									<div class="lp-sc-label">SC</div>
								</div>
							{/if}
							<!-- Milestone ticks at 25%, 50%, 75% -->
							{#each [25, 50, 75] as pct}
								<div class="lp-milestone-tick" class:lp-milestone-reached={progress >= pct} style="left: {pct}%" title="{pct}%">
									<div class="lp-milestone-line"></div>
								</div>
							{/each}
							<!-- Ghost marker: where it was ~1h ago (estimated from txItems) -->
							{#if txItems.length > 0 && launch.hardCap > 0n}
								{@const oneHourAgo = Date.now() - 3600000}
								{@const recentBuysUsdt = txItems.reduce((sum, tx) => {
									const ts = typeof tx.created_at === 'number' ? tx.created_at * 1000 : new Date(tx.created_at).getTime();
									return ts > oneHourAgo ? sum + parseFloat(ethers.formatUnits(BigInt(tx.base_amount) + BigInt(tx.fee || '0'), usdtDecimals)) : sum;
								}, 0)}
								{@const ghostPct = Math.max(0, progress - (recentBuysUsdt / (Number(launch.hardCap) / (10 ** usdtDecimals)) * 100))}
								{#if ghostPct > 0 && progress - ghostPct > 0.5}
									<div class="lp-ghost-marker" style="left: {ghostPct}%" title="~1 hour ago"></div>
								{/if}
							{/if}
						</div>
						<div class="flex justify-between text-[10px] font-mono mt-1">
							<span class="text-gray-500">{progress}% {$t('lpd.raised')}</span>
							{#if launch.totalBaseRaised < launch.softCap}
								<span class="text-amber-400">{$t('lpd.softCapLabel')}: {progressPercent(launch.totalBaseRaised, launch.softCap)}%</span>
							{:else}
								<span class="text-emerald-400">{$t('lpd.softCapReached')}</span>
							{/if}
						</div>

						<!-- Context signals under progress bar -->
						{#if launch.state === 1}
							{@const remainingUsdt = launch.hardCap - launch.totalBaseRaised}
							{@const remainingNum = Number(remainingUsdt) / (10 ** usdtDecimals)}
							{@const startTs = launch.startTimestamp > 0n ? Number(launch.startTimestamp) : 0}
							{@const deadlineTs = Number(launch.deadline)}
							{@const totalDuration = deadlineTs - startTs}
							{@const elapsed = startTs > 0 ? Math.floor(Date.now() / 1000) - startTs : 0}
							{@const timePct = totalDuration > 0 ? Math.min(100, (elapsed / totalDuration) * 100) : 0}
							{@const curP = Number(launch.currentPrice) / (10 ** usdtDecimals)}
							{@const tokFrac = launch.tokensForCurve > 0n ? Number(launch.tokensSold) / Number(launch.tokensForCurve) : 0}
							{@const ct = Number(launch.curveType)}
							{@const curveFnAt = (x: number) => ct === 0 ? x : ct === 1 ? Math.sqrt(x) : ct === 2 ? x * x : (Math.exp(x * 3) - 1) / (Math.E ** 3 - 1)}
							{@const nextFrac = Math.min(1, tokFrac + 0.01)}
							{@const curveAtNow = curveFnAt(tokFrac)}
							{@const curveAtNext = curveFnAt(nextFrac)}
							{@const impactPct = curveAtNow > 0 ? ((curveAtNext - curveAtNow) / curveAtNow * 100) : 0}
							<div class="progress-context">
								{#if remainingNum > 0}
									<div class="ctx-line ctx-scarcity">
										<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
										<span>{formatUsdt(remainingUsdt, ud)} left until hard cap</span>
									</div>
								{/if}

								<!-- Velocity: raw speed in the last hour -->
								{#if txItems.length > 0}
									{@const now = countdownNow}
									{@const oneHrAgo = now - 3600000}
									{@const tenMinAgo = now - 600000}
									{@const hourBuys = txItems.filter(tx => { try { const ts = typeof tx.created_at === 'number' ? tx.created_at * 1000 : new Date(tx.created_at).getTime(); return !isNaN(ts) && ts > oneHrAgo; } catch { return false; } })}
									{@const hourVol = hourBuys.reduce((s, tx) => { try { return s + parseFloat(ethers.formatUnits(BigInt(tx.base_amount) + BigInt(tx.fee || '0'), usdtDecimals)); } catch { return s; } }, 0)}
									{@const recentCount = txItems.filter(tx => { try { const ts = typeof tx.created_at === 'number' ? tx.created_at * 1000 : new Date(tx.created_at).getTime(); return !isNaN(ts) && ts > tenMinAgo; } catch { return false; } }).length}
									{#if hourVol > 0}
										<div class="ctx-line ctx-velocity">
											<span>🔥</span>
											<span>+${hourVol.toFixed(2)} in the last hour{recentCount > 0 ? ` · ${recentCount} buy${recentCount > 1 ? 's' : ''} in 10 min` : ''}</span>
										</div>
									{/if}
								{/if}

								{#if timePct > 0 && progress > 0}
									{@const pace = progress / timePct}
									{#if pace > 1.5}
										<div class="ctx-line ctx-pace-fast">
											<span>🚀</span>
											<span>{progress.toFixed(1)}% raised in {timePct.toFixed(0)}% of time — ahead of pace</span>
										</div>
									{:else if pace < 0.5 && timePct > 20}
										<div class="ctx-line ctx-pace-slow">
											<span>⏳</span>
											<span>{progress.toFixed(1)}% raised, {(100 - timePct).toFixed(0)}% of time remaining</span>
										</div>
									{/if}
								{/if}

								{#if tokenProgress > 0 && Math.abs(progress - tokenProgress) > 3}
									<div class="ctx-line ctx-curve">
										<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/></svg>
										<span>{tokenProgress}% tokens sold = {progress}% of hard cap (price rises along curve)</span>
									</div>
								{/if}

								{#if impactPct > 0.1}
									<div class="ctx-line ctx-impact">
										<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/></svg>
										<span>Next 1% of tokens → price +{impactPct.toFixed(1)}%</span>
									</div>
								{/if}
							</div>
						{/if}
					</div>

					<div class="mb-4">
						<div class="flex justify-between text-xs font-mono mb-1.5">
							<span class="text-gray-300 font-semibold">{formatTokens(launch.tokensSold, tokenMeta.decimals)}</span>
							<span class="text-gray-500">{formatTokens(launch.tokensForCurve, tokenMeta.decimals)}</span>
						</div>
						<div class="progress-track">
							<div class="progress-fill progress-purple" style="width: {tokenProgress}%"></div>
						</div>
						<div class="text-right text-[10px] text-gray-400 font-mono mt-1">{tokenProgress}% {$t('lpd.tokensSold')}</div>
					</div>

					<!-- Buyer stats -->
					{#if launch.totalBuyers > 0 || launch.totalPurchases > 0}
						<div class="flex items-center gap-4 text-xs font-mono mb-4">
							{#if launch.totalBuyers > 0}
								<div class="flex items-center gap-1.5">
									<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#00d2ff" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
									<span class="text-cyan-400 font-bold">{launch.totalBuyers}</span>
									<span class="text-gray-400">buyer{launch.totalBuyers !== 1 ? 's' : ''}</span>
								</div>
							{/if}
							{#if launch.totalPurchases > 0}
								<div class="flex items-center gap-1.5">
									<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
									<span class="text-emerald-400 font-bold">{launch.totalPurchases}</span>
									<span class="text-gray-500">purchase{launch.totalPurchases !== 1 ? 's' : ''}</span>
								</div>
							{/if}
						</div>
					{/if}

					<!-- Sale info summary -->
					<div class="sale-info-divider"></div>
					<div class="detail-grid mt-4">
						<div class="detail-row">
							<span class="detail-label">{$t('lpd.status')}</span>
							<span class="detail-value status-{color}">{stateLabel(launch.state)}</span>
						</div>
						<div class="detail-row">
							<span class="detail-label">{$t('lpd.saleType')}</span>
							<span class="detail-value">{$t('lpd.fairLaunch')}</span>
						</div>
						<div class="detail-row">
							<span class="detail-label">{$t('lpd.currentRate')}</span>
							<span class="detail-value">1 USDT = {launch.currentPrice > 0n ? formatTokens((BigInt(10 ** usdtDecimals) * BigInt(10 ** tokenMeta.decimals)) / launch.currentPrice, tokenMeta.decimals) : '0'} {launch.tokenSymbol}</span>
						</div>
						<div class="detail-row">
							<span class="detail-label">{$t('lpd.currentRaised')}</span>
							<span class="detail-value">{formatUsdt(launch.totalBaseRaised, ud)}</span>
						</div>
					</div>
				</div>

				<!-- Deposit Box (Pending) -->
				{#if launch.state === 0 && userAddress?.toLowerCase() === launch.creator.toLowerCase()}
					{@const remaining = launch.totalTokensRequired - launch.totalTokensDeposited}
					{@const depositPct = launch.totalTokensRequired > 0n ? Number((launch.totalTokensDeposited * 100n) / launch.totalTokensRequired) : 0}
					<div class="card p-6 mb-4 border border-amber-500/20">
						<h3 class="syne font-bold text-amber-400 mb-2">{$t('lpd.depositRequired')}</h3>
						<p class="text-gray-400 text-xs font-mono mb-4">
							{$t('lpd.depositPendingMsg')}
						</p>

						<div class="detail-grid mb-4">
							<div class="detail-row">
								<span class="detail-label">{$t('lpd.totalRequired')}</span>
								<span class="detail-value">{formatTokens(launch.totalTokensRequired, tokenMeta.decimals)} {launch.tokenSymbol}</span>
							</div>
							<div class="detail-row">
								<span class="detail-label">{$t('lpd.deposited')}</span>
								<span class="detail-value">{formatTokens(launch.totalTokensDeposited, tokenMeta.decimals)} {launch.tokenSymbol}</span>
							</div>
							<div class="detail-row">
								<span class="detail-label">{$t('lpd.remaining')}</span>
								<span class="detail-value text-amber-400">{formatTokens(remaining, tokenMeta.decimals)} {launch.tokenSymbol}</span>
							</div>
						</div>

						<div class="mb-4">
							<div class="flex justify-between text-[10px] font-mono mb-1">
								<span class="text-gray-500">{$t('lpd.depositProgress')}</span>
								<span class="text-gray-400">{depositPct}%</span>
							</div>
							<div class="progress-track">
								<div class="progress-fill progress-amber" style="width: {depositPct}%"></div>
							</div>
						</div>

						{#if remaining > 0n}
							<button
								onclick={handleDeposit}
								disabled={isDepositing}
								class="btn-primary w-full py-3 text-sm cursor-pointer"
							>
								{isDepositing ? $t('lpd.depositing') : `${$t('lpd.approveDeposit')} ${formatTokens(remaining, tokenMeta.decimals)} ${launch.tokenSymbol}`}
							</button>
							<p class="text-gray-600 text-[10px] font-mono mt-2 text-center">
								{$t('lpd.depositNotice')}
							</p>
						{:else}
							<p class="text-emerald-400 text-xs font-mono text-center">{$t('lpd.allDeposited')}</p>
						{/if}

						<!-- Preflight checklist — shown when deposit is complete but
						     the launch didn't auto-activate (e.g. the launch instance
						     wasn't authorized as a launcher at deposit time). -->
						{#if remaining === 0n && !preflightReady && preflightReason}
							<div class="mt-4 pt-4 border-t border-white/5">
								<p class="text-amber-300 text-xs font-mono mb-3">
									Waiting on one more step before this launch can activate:
								</p>
								<div class="detail-grid mb-3">
									<div class="detail-row">
										<span class="detail-label">Tokens deposited</span>
										<span class="detail-value text-emerald-400">✓</span>
									</div>
									<div class="detail-row">
										<span class="detail-label">Exempt from limits</span>
										<span class="detail-value {preflightReason === 'NOT_EXCLUDED_FROM_LIMITS' ? 'text-red-400' : 'text-emerald-400'}">
											{preflightReason === 'NOT_EXCLUDED_FROM_LIMITS' ? '✗' : '✓'}
										</span>
									</div>
									<div class="detail-row">
										<span class="detail-label">Tax-free (if taxable)</span>
										<span class="detail-value {preflightReason === 'NOT_TAX_EXEMPT' ? 'text-red-400' : 'text-emerald-400'}">
											{preflightReason === 'NOT_TAX_EXEMPT' ? '✗' : '✓'}
										</span>
									</div>
									<div class="detail-row">
										<span class="detail-label">Authorized launcher</span>
										<span class="detail-value {preflightReason === 'NOT_AUTHORIZED_LAUNCHER' ? 'text-red-400' : 'text-emerald-400'}">
											{preflightReason === 'NOT_AUTHORIZED_LAUNCHER' ? '✗' : '✓'}
										</span>
									</div>
								</div>
								<p class="text-gray-500 text-[10px] font-mono mb-3">
									Click "Fix &amp; activate" to grant the missing permission on your token and activate the launch in one flow.
								</p>
								<button
									onclick={handleDeposit}
									disabled={isDepositing || isActivating}
									class="btn-primary w-full py-2.5 text-sm cursor-pointer"
								>
									{isDepositing || isActivating ? 'Working…' : 'Fix & activate'}
								</button>
							</div>
						{/if}

						<!-- Ready to activate manually — deposit was complete but
						     the auto-activation didn't fire (edge case; UI exposes
						     the `activate()` escape hatch). -->
						{#if remaining === 0n && preflightReady && launch.state === 0}
							<div class="mt-4 pt-4 border-t border-white/5">
								<p class="text-emerald-300 text-xs font-mono mb-3">
									Everything is in place. Activate the launch to start the curve.
								</p>
								<button
									onclick={handleActivate}
									disabled={isActivating}
									class="btn-primary w-full py-2.5 text-sm cursor-pointer"
								>
									{isActivating ? 'Activating…' : 'Activate launch'}
								</button>
							</div>
						{/if}
					</div>
				{:else if launch.state === 0}
					<div class="card p-6 mb-4 border border-amber-500/20">
						<h3 class="syne font-bold text-amber-400 mb-2">{$t('lpd.pendingLaunch')}</h3>
						<p class="text-gray-400 text-xs font-mono">
							{$t('lpd.pendingMsg')}
						</p>
						<div class="detail-grid mt-3">
							<div class="detail-row">
								<span class="detail-label">{$t('lpd.deposited')}</span>
								<span class="detail-value">
									{formatTokens(launch.totalTokensDeposited, tokenMeta.decimals)} / {formatTokens(launch.totalTokensRequired, tokenMeta.decimals)}
								</span>
							</div>
						</div>
					</div>
				{/if}

				<!-- Trading status banner — post-graduation only -->
				{#if !tradingEnabled && launch.state === 2}
					{#if tradingOpensIn > 0n}
						<!-- Anti-snipe lock countdown -->
						<div class="card p-4 mb-4 border border-amber-500/20">
							<div class="flex items-center gap-2 mb-1">
								<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
								<h3 class="syne font-bold text-amber-400 text-sm">Anti-snipe lock active</h3>
							</div>
							<p class="text-gray-400 text-xs font-mono">
								Trading opens automatically in <span class="text-amber-400 font-bold">{Math.ceil(Number(tradingOpensIn) / 60)} min</span>. This lock protects buyers from front-running bots at launch.
							</p>
						</div>
					{:else if tradingOpensIn === -1n && userAddress?.toLowerCase() === launch.creator.toLowerCase()}
						<!-- enableTrading was never called — creator needs to act -->
						<div class="card p-4 mb-4 border border-red-500/20">
							<h3 class="syne font-bold text-red-400 mb-2 text-sm">{$t('lpd.enableTradingTitle')}</h3>
							<p class="text-gray-400 text-xs font-mono mb-2">
								{$t('lpd.enableTradingMsg')}
							</p>
							<p class="text-gray-500 text-[10px] font-mono mb-3">
								{$t('lpd.enableTradingNote')}
							</p>
							<button
								onclick={handleEnableTrading}
								disabled={isEnablingTrading}
								class="btn-primary w-full py-2.5 text-sm cursor-pointer"
							>
								{#if isEnablingTrading}
									<span class="spinner-inline"></span> {$t('lpd.enabling')}
								{:else}
									{$t('lpd.enableTrading')}
								{/if}
							</button>
						</div>
					{:else if tradingOpensIn === -1n}
						<!-- Not creator, trading never enabled -->
						<div class="card p-4 mb-4 border border-red-500/20">
							<p class="text-red-400 text-xs font-mono">
								{$t('lpd.tradingNotEnabled')}
							</p>
						</div>
					{/if}
				{/if}

				<!-- Your Bag -->
				{#if userAddress && (userTokensBought > 0n || userBasePaid > 0n)}
					{@const avgPrice = userTokensBought > 0n ? (userBasePaid * BigInt(10 ** tokenMeta.decimals)) / userTokensBought : 0n}
					{@const currentVal = launch.currentPrice > 0n ? (userTokensBought * launch.currentPrice) / BigInt(10 ** tokenMeta.decimals) : 0n}
					{@const pnl = currentVal > 0n ? currentVal - userBasePaid : 0n}
					{@const pnlPct = userBasePaid > 0n ? Number((pnl * 10000n) / userBasePaid) / 100 : 0}
					{@const isUp = pnl > 0n}
					<div class="card pos-card mb-4">
						<div class="pos-header">
							<h3 class="pos-title">Your Bag</h3>
							{#if currentVal > 0n}
								<span class="pos-pnl" class:pos-up={isUp} class:pos-down={pnl < 0n}>
									{isUp ? '+' : ''}{pnlPct.toFixed(1)}%
								</span>
							{/if}
						</div>

						<div class="pos-hero">
							<span class="pos-hero-num">{formatTokens(userTokensBought, tokenMeta.decimals)}</span>
							<span class="pos-hero-sym">{tokenMeta.symbol}</span>
						</div>

						<div class="pos-grid">
							<div class="pos-detail">
								<span class="pos-detail-label">Spent</span>
								<span class="pos-detail-val">{formatUsdt(userBasePaid, ud)}</span>
							</div>
							{#if currentVal > 0n}
								<div class="pos-detail">
									<span class="pos-detail-label">Value now</span>
									<span class="pos-detail-val" class:pos-up={isUp}>{formatUsdt(currentVal, ud)}</span>
								</div>
							{/if}
							{#if avgPrice > 0n}
								<div class="pos-detail">
									<span class="pos-detail-label">Avg price</span>
									<span class="pos-detail-val">{formatUsdt(avgPrice, ud, 6)}</span>
								</div>
							{/if}
							<div class="pos-detail">
								<span class="pos-detail-label">Price now</span>
								<span class="pos-detail-val">{formatUsdt(launch.currentPrice, ud, 6)}</span>
							</div>
						</div>

						{#if maxBuyPerWallet > 0n && remainingBuyUsdt > 0n && !atMaxBuy}
							<div class="pos-limit-remaining-hint">
								{formatUsdt(remainingBuyUsdt, ud)} left to buy
							</div>
						{:else if maxBuyPerWallet > 0n && atMaxBuy}
							<div class="pos-limit-remaining-hint" style="color: #10b981">
								✓ Full allocation used ({formatUsdt(maxBuyPerWallet, ud)})
							</div>
						{/if}
					</div>
				{/if}

				<!-- Buy Box -->
				{#if launch.state === 1}
					{@const notStartedYet = launch.startTimestamp > 0n && BigInt(Math.floor(Date.now() / 1000)) < launch.startTimestamp}
					{#if notStartedYet}
						{@const diff = Number(launch.startTimestamp) - Math.floor(Date.now() / 1000)}
						<div class="card p-6 mb-4 text-center">
							<h3 class="syne font-bold text-amber-400 mb-2">{$t('lpd.scheduledLaunch')}</h3>
							<p class="text-gray-400 font-mono text-sm mb-1">
								{$t('lpd.buyingOpens')} {new Date(Number(launch.startTimestamp) * 1000).toLocaleString()}
							</p>
							<p class="text-white font-mono text-lg font-bold">
								{Math.floor(diff / 86400)}d {Math.floor((diff % 86400) / 3600)}h {Math.floor((diff % 3600) / 60)}m
							</p>
						</div>
					{/if}
					<div class="card p-6 mb-4" class:opacity-50={notStartedYet} class:pointer-events-none={notStartedYet}>
						<h3 class="syne font-bold text-white mb-4">{$t('lpd.buyTokens')}</h3>

						<!-- Remaining Buy Indicator -->
						{#if userAddress}
							<div class="remaining-buy-indicator mb-4">
								{#if maxBuyPerWallet === 0n}
									<span class="text-gray-500 text-xs font-mono">{$t('lpd.noBuyLimit')}</span>
								{:else if atMaxBuy}
									<div class="remaining-buy-detail">
										<div class="flex justify-between text-[10px] font-mono mb-1.5">
											<span class="text-emerald-400 font-semibold">Max allocation reached</span>
											<span class="text-emerald-400">100%</span>
										</div>
										<div class="remaining-buy-track">
											<div class="remaining-buy-fill remaining-buy-full" style="width: 100%"></div>
										</div>
										<div class="text-[10px] font-mono mt-1.5 text-gray-500">
											You've used your full {formatUsdt(maxBuyPerWallet, ud)} allocation
										</div>
									</div>
								{:else}
									<div class="remaining-buy-detail">
										<div class="flex justify-between text-[10px] font-mono mb-1.5">
											<span class="text-gray-500">{$t('lpd.allocationUsed')}</span>
											<span class="text-gray-400">{allocationPct.toFixed(1)}%</span>
										</div>
										<div class="remaining-buy-track">
											<div class="remaining-buy-fill" style="width: {allocationPct}%"></div>
										</div>
										<div class="text-[10px] font-mono mt-1.5 text-gray-400">
											{$t('lpd.remainingBuyUsdt').replace('{amount}', formatUsdt(remainingBuyUsdt, ud))}
										</div>
									</div>
								{/if}
							</div>
						{/if}

						<!-- Amount in USDT -->
						<div class="mb-3">
							<label class="label-text" for="buy-amount">{$t('lpd.amountUsdt')}</label>
							<input
								id="buy-amount"
								type="number"
								class="input-field"
								placeholder="e.g. 10"
								bind:value={buyAmount}
								step="any"
								min="0"
							/>
						</div>

						{#if swapEstimateLoading}
							<div class="text-gray-500 text-[10px] font-mono mt-1 mb-2">Estimating {paySymbol} cost...</div>
						{:else if swapEstimate}
							<div class="text-cyan-400 text-[11px] font-mono mt-1 mb-2">{swapEstimate}</div>
						{/if}

						<!-- Payment method select -->
						<div class="mb-3">
							<label class="label-text">{$t('lpd.payWith')}</label>
							<button class="pay-asset-btn" type="button" onclick={() => showPayPicker = true}>
								{#if getKnownLogo(paySymbol)}
									<img src={getKnownLogo(paySymbol)} alt="" class="pay-asset-logo" />
								{:else}
									<span class="pay-asset-letter">{paySymbol.charAt(0)}</span>
								{/if}
								<span class="pay-asset-name">{paySymbol}</span>
								{#if buyPaymentMethod === 'native'}<span class="pay-asset-tag">auto-converted</span>{/if}
								{#if buyPaymentMethod === 'custom'}<span class="pay-asset-tag">swap → USDT</span>{/if}
								<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M6 9l6 6 6-6"/></svg>
							</button>
						</div>

						<TokenPickerModal
							bind:open={showPayPicker}
							tokens={payTokens}
							onPick={onPayTokenPick}
							title="Pay with"
							chainId={network?.chain_id ?? targetChainId}
							provider={signer?.provider ?? networkProviders.get(network?.chain_id ?? targetChainId) ?? null}
							userAddress={userAddress || ''}
						/>

						<!-- Preview -->
						{#if preview && !previewLoading}
							<div class="preview-box mb-4">
								{#if previewError === 'estimate'}
									<div class="text-amber-400 text-[10px] font-mono text-center pb-1">
										{$t('lpd.approxEstimate')}
									</div>
								{/if}
								<div class="preview-row">
									<span class="text-gray-500">{$t('lpd.youReceive')}</span>
									<span class="text-white font-semibold">
										{previewError === 'estimate' ? '~' : ''}{formatTokens(preview.tokensOut, tokenMeta.decimals)} {launch.tokenSymbol}
									</span>
								</div>
								<div class="preview-row">
									<span class="text-gray-500">Buy Fee (1%)</span>
									<span class="text-amber-400">{preview.fee > 0n ? formatUsdt(preview.fee, ud) : 'None'}</span>
								</div>
								{#if preview.priceImpactBps > 0n}
									<div class="preview-row">
										<span class="text-gray-500">Price impact</span>
										<span class="text-emerald-400">
											{(Number(preview.priceImpactBps) / 100).toFixed(2)}%
											{#if Number(preview.priceImpactBps) > 500}
												· Early entry
											{/if}
										</span>
									</div>
								{/if}
								{#if maxBuyPerWallet > 0n}
									<div class="preview-row">
										<span class="text-gray-500">Max buy per wallet</span>
										<span class="text-cyan-300">{formatUsdt(maxBuyPerWallet, ud)} ({maxBuyPct}%)</span>
									</div>
								{/if}
							</div>
						{:else if previewLoading}
							<div class="preview-box mb-4">
								<div class="text-gray-500 text-xs font-mono text-center py-2">{$t('lpd.calculating')}</div>
							</div>
						{:else if previewError && previewError !== 'estimate'}
							<div class="exceed-warning mb-4">
								<span class="text-red-400 text-xs font-mono">{previewError}</span>
							</div>
						{/if}

						<!-- Max buy info -->
						{#if maxBuyPerWallet > 0n && userAddress}
							<div class="max-buy-info mb-3">
								<div class="flex justify-between text-[10px] font-mono">
									<span class="text-gray-500">{$t('lpd.maxBuyPerWallet')}</span>
									<span class="text-gray-400">{formatUsdt(maxBuyPerWallet, ud)} ({maxBuyPct}%)</span>
								</div>
								{#if userBasePaid > 0n}
									<div class="flex justify-between text-[10px] font-mono mt-1">
										<span class="text-gray-500">{$t('lpd.remainingLabel')}</span>
										<span class="{remainingBuyUsdt === 0n ? 'text-red-400' : 'text-gray-400'}">
											{remainingBuyUsdt === 0n ? $t('lpd.limitReached') : formatUsdt(remainingBuyUsdt, ud) + ' remaining'}
										</span>
									</div>
								{/if}
							</div>
						{/if}

						{#if exceedsMaxBuy}
							<div class="exceed-warning mb-3">
								<span class="text-red-400 text-xs font-mono">
									{$t('lpd.exceedsMaxBuy').replace('{pct}', String(maxBuyPct))}
								</span>
							</div>
						{/if}

						{#if belowMinBuy}
							<div class="exceed-warning mb-3">
								<span class="text-red-400 text-xs font-mono">
									Below minimum buy (${minBuyLabel})
								</span>
							</div>
						{/if}

						<!-- Slippage -->
						<div class="slippage-row">
							<button class="slippage-toggle" onclick={() => showSlippageMenu = !showSlippageMenu}>
								<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
								<span>Slippage {slippagePct}%</span>
							</button>
							{#if showSlippageMenu}
								<div class="slippage-options">
									{#each [1, 3, 5, 10] as pct}
										<button
											class="slip-opt"
											class:active={slippagePct === pct}
											onclick={() => { slippagePct = pct; showSlippageMenu = false; }}
										>{pct}%</button>
									{/each}
									<input
										type="number"
										class="slip-custom"
										placeholder="Custom"
										min="0.5"
										max="50"
										step="0.5"
										value={[1,3,5,10].includes(slippagePct) ? '' : slippagePct}
										onchange={(e) => {
											const v = parseFloat((e.target as HTMLInputElement).value);
											if (v >= 0.5 && v <= 50) { slippagePct = v; showSlippageMenu = false; }
										}}
									/>
								</div>
							{/if}
						</div>

						{#if userAddress}
							<button
								onclick={handleBuy}
								disabled={isBuying || !buyAmount || parseFloat(String(buyAmount)) <= 0 || exceedsMaxBuy || atMaxBuy || belowMinBuy}
								class="btn-primary w-full py-3 text-sm cursor-pointer"
							>
								{#if atMaxBuy}
									{$t('lpd.maxBuyReached')}
								{:else if exceedsMaxBuy}
									{$t('lpd.exceedsMaxBuyBtn')}
								{:else if belowMinBuy}
									Below minimum buy (${minBuyLabel})
								{:else}
									{isBuying ? $t('lpd.buying') : `${$t('lpd.buyWith')} ${paymentLabel}`}
								{/if}
							</button>
						{:else}
							<div class="connect-cta">
								<p class="text-gray-500 text-xs font-mono mb-3 text-center">{$t('lpd.connectToParticipate')}</p>
								<button onclick={connectWallet} class="btn-primary w-full py-3 text-sm cursor-pointer font-semibold">
									{$t('lpd.connectWallet')}
								</button>
							</div>
						{/if}
					</div>
				{/if}

				<!-- Graduate early -->
				{#if launch.state === 1 && userAddress?.toLowerCase() === launch.creator.toLowerCase()}
					{@const softCapReached = launch.totalBaseRaised >= launch.softCap}
					{#if softCapReached}
						<div class="card p-4 mb-4">
							<p class="text-gray-400 text-xs font-mono mb-3">{$t('lpd.softCapReachedGrad')}</p>
							<button
								onclick={handleGraduate}
								disabled={isGraduating}
								class="btn-primary w-full py-2.5 text-sm cursor-pointer"
							>
								{isGraduating ? $t('lpd.graduating') : $t('lpd.graduateToDex')}
							</button>
						</div>
					{/if}
				{/if}

				<!-- User Position -->
				{#if userAddress && (userBasePaid > 0n || userTokensBought > 0n)}
					<div class="card p-6 mb-4">
						<h3 class="syne font-bold text-white mb-4">{$t('lpd.yourPosition')}</h3>
						<div class="detail-grid">
							<div class="detail-row">
								<span class="detail-label">{$t('lpd.tokensBought')}</span>
								<span class="detail-value">{formatTokens(userTokensBought, tokenMeta.decimals)} {launch.tokenSymbol}</span>
							</div>
							<div class="detail-row">
								<span class="detail-label">{$t('lpd.totalSpent')}</span>
								<span class="detail-value">{formatUsdt(userBasePaid, ud)}</span>
							</div>
							{#if userTokensBought > 0n && userBasePaid > 0n}
								<div class="detail-row">
									<span class="detail-label">{$t('lpd.avgPrice')}</span>
									<span class="detail-value">
										{formatUsdt(
											(userBasePaid * BigInt(10 ** tokenMeta.decimals)) / userTokensBought,
											ud, 6
										)}
									</span>
								</div>
							{/if}
						</div>

						{#if launch.state === 3 && userBasePaid > 0n}
							<div class="card p-4 mt-4 mb-2" style="border-color: rgba(239,68,68,0.2); background: rgba(239,68,68,0.04);">
								<div class="detail-grid mb-3">
									<div class="detail-row">
										<span class="detail-label">Your USDT paid</span>
										<span class="detail-value text-red-400">{formatUsdt(userBasePaid, ud)}</span>
									</div>
									<div class="detail-row">
										<span class="detail-label">Tokens to return</span>
										<span class="detail-value">{formatTokens(userTokensBought, launch.tokenDecimals)} {launch.tokenSymbol}</span>
									</div>
								</div>
								<button
									onclick={handleRefund}
									disabled={isRefunding}
									class="btn-danger w-full py-2.5 text-sm cursor-pointer"
								>
									{isRefunding ? $t('lpd.processing') : `${$t('common.refund')} ${formatUsdt(userBasePaid, ud)}`}
								</button>
								<p class="text-gray-600 text-[10px] font-mono mt-2">
									Return your tokens to receive your USDT back pro-rata. Partial refunds supported.
								</p>
							</div>
						{/if}
					</div>
				{/if}

				<!-- Creator Reclaim (Refunding state only).
				     Stranded-USDT sweep was previously rendered inside this
				     panel but moved to its own platform-gated panel below,
				     since the L2 audit fix made sweepStrandedUsdt() platform-
				     only on-chain — the creator button would revert. -->
				{#if launch.state === 3 && userAddress && launch.creator.toLowerCase() === userAddress.toLowerCase()}
					<div class="card p-6 mb-4 border-amber-500/20">
						<h3 class="syne font-bold text-amber-300 mb-1">Creator tools</h3>
						<p class="text-gray-500 text-xs font-mono mb-4">
							This launch is refunding. You can reclaim the tokens that weren't sold (or that buyers have returned so far) at any time.
						</p>

						{#if reclaimableBalance > 0n}
							<div class="detail-row mb-3">
								<span class="detail-label">Reclaimable now</span>
								<span class="detail-value">{formatTokens(reclaimableBalance, tokenMeta.decimals)} {launch.tokenSymbol}</span>
							</div>
							<button
								onclick={handleReclaim}
								disabled={isReclaiming}
								class="btn-primary w-full py-2.5 text-sm cursor-pointer"
							>
								{isReclaiming ? 'Reclaiming…' : 'Reclaim available tokens'}
							</button>
							<p class="text-gray-600 text-[10px] font-mono mt-2">
								Each call drains the launch's current token balance. As more buyers refund, their returned tokens become reclaimable — call again to pick them up.
							</p>
						{:else}
							<p class="text-gray-600 text-xs font-mono">No tokens currently available to reclaim.</p>
						{/if}

					</div>
				{/if}

				<!-- Platform stranded-USDT sweep (Refunding state, platform
				     wallet only). Appears after the 90-day refund window
				     closes, when there's still USDT sitting on the launch
				     that nobody claimed. Sends the balance to the platform
				     wallet. On-chain: LaunchInstance.sweepStrandedUsdt(). -->
				{#if launch.state === 3 && isPlatformWallet && strandedUsdtBalance > 0n}
					<div class="card p-6 mb-4 border-cyan-500/20">
						<h3 class="syne font-bold text-cyan-300 mb-1">Platform tools</h3>
						<p class="text-gray-500 text-xs font-mono mb-4">
							You're connected as the platform wallet. The stranded USDT on this refunding launch can be swept after the 90-day buyer refund window closes.
						</p>
						<div class="detail-row mb-3">
							<span class="detail-label">Stranded USDT</span>
							<span class="detail-value">{formatUsdt(strandedUsdtBalance, ud)}</span>
						</div>
						{#if sweepWindowOpen}
							<button
								onclick={handleSweepStranded}
								disabled={isSweeping}
								class="btn-secondary w-full py-2.5 text-sm cursor-pointer"
							>
								{isSweeping ? 'Sweeping…' : 'Sweep stranded USDT to platform wallet'}
							</button>
							<p class="text-gray-600 text-[10px] font-mono mt-2">
								90-day refund window has passed. Abandoned refunds can no longer be claimed by buyers.
							</p>
						{:else if refundStartTimestamp > 0n}
							{@const unlockTs = Number(refundStartTimestamp) + Number(strandedSweepDelay)}
							{@const daysLeft = Math.max(0, Math.ceil((unlockTs * 1000 - Date.now()) / (24 * 60 * 60 * 1000)))}
							<p class="text-gray-600 text-xs font-mono">
								Sweep unlocks in {daysLeft} day{daysLeft === 1 ? '' : 's'}.
							</p>
						{/if}
					</div>
				{/if}

				<!-- (Share buttons moved to top of page) -->
			</div>
		</div>
	{/if}
</div>

<style>
	/* Pay asset picker */
	.pay-asset-btn {
		display: flex; align-items: center; gap: 8px; width: 100%;
		padding: 10px 12px; border-radius: 10px; cursor: pointer;
		background: var(--bg-surface); border: 1px solid var(--border);
		color: var(--text); font-family: 'Space Mono', monospace; font-size: 13px;
		transition: border-color 0.15s;
	}
	.pay-asset-btn:hover { border-color: rgba(0,210,255,0.3); }
	.pay-asset-logo { width: 22px; height: 22px; border-radius: 50%; object-fit: cover; flex-shrink: 0; }
	.pay-asset-letter {
		width: 22px; height: 22px; border-radius: 50%; flex-shrink: 0;
		display: flex; align-items: center; justify-content: center;
		background: rgba(0,210,255,0.15); color: #00d2ff; font-size: 10px; font-weight: 700;
	}
	.pay-asset-name { flex: 1; text-align: left; font-weight: 600; }
	.pay-asset-tag {
		font-size: 9px; color: var(--text-dim); background: var(--bg-surface-hover);
		padding: 2px 6px; border-radius: 4px;
	}
	.pay-picker-overlay {
		position: fixed; inset: 0; z-index: 90;
		background: rgba(0,0,0,0.6); backdrop-filter: blur(6px);
		display: flex; align-items: center; justify-content: center;
		padding: 16px; animation: fadeIn 0.15s ease-out;
	}
	@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
	.pay-picker {
		background: var(--bg); border: 1px solid var(--border);
		border-radius: 16px; width: 100%; max-width: 360px;
		box-shadow: 0 20px 60px rgba(0,0,0,0.5);
		animation: scaleIn 0.2s ease-out;
	}
	@keyframes scaleIn { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: scale(1); } }
	.pay-picker-header {
		display: flex; justify-content: space-between; align-items: center;
		padding: 16px 16px 12px; border-bottom: 1px solid var(--border);
	}
	.pay-picker-title { font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 700; color: white; }
	.pay-picker-close { background: none; border: none; color: var(--text-dim); cursor: pointer; padding: 4px; border-radius: 6px; }
	.pay-picker-close:hover { color: white; background: var(--bg-surface-hover); }
	.pay-picker-list { padding: 8px; }
	.pay-picker-item {
		display: flex; align-items: center; gap: 10px; width: 100%;
		padding: 10px; border-radius: 10px; cursor: pointer;
		background: none; border: none; color: var(--text); transition: background 0.1s;
	}
	.pay-picker-item:hover { background: var(--bg-surface-input); }
	.pay-picker-item.active { background: rgba(0,210,255,0.08); }
	.pay-picker-logo { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; flex-shrink: 0; }
	.pay-picker-letter {
		width: 32px; height: 32px; border-radius: 50%; flex-shrink: 0;
		display: flex; align-items: center; justify-content: center;
		background: rgba(0,210,255,0.12); color: #00d2ff; font-size: 13px; font-weight: 700;
	}
	.pay-picker-info { flex: 1; text-align: left; display: flex; flex-direction: column; gap: 1px; }
	.pay-picker-symbol { font-size: 13px; font-weight: 600; color: white; }
	.pay-picker-name { font-size: 10px; color: var(--text-dim); }

	.page-grid {
		display: grid;
		grid-template-columns: 1fr;
		gap: 24px;
	}
	/* Mobile: Buy first (with inline about), then rest. Hide about-col since mobile-about handles it. */
	@media (max-width: 1023px) {
		.right-col { order: -2; }
		.about-col { display: none; }
		.left-col { order: 0; }
	}
	/* Mobile-only compact about inside right-col */
	.mobile-about { display: none; }
	@media (max-width: 1023px) {
		.mobile-about { display: block; }
	}
	.mobile-about-text {
		font-family: 'Space Mono', monospace; font-size: 12px;
		color: var(--text-muted); line-height: 1.6;
		display: -webkit-box; -webkit-box-orient: vertical;
		-webkit-line-clamp: 2; line-clamp: 2;
		overflow: hidden; white-space: pre-line;
	}
	.mobile-about-text.mobile-about-expanded {
		-webkit-line-clamp: unset; line-clamp: unset;
	}
	.mobile-about-toggle {
		font-family: 'Space Mono', monospace; font-size: 11px;
		color: #00d2ff; background: none; border: none;
		cursor: pointer; padding: 4px 0 0; margin: 0;
	}
	@media (min-width: 1024px) {
		.page-grid {
			grid-template-columns: 1fr 400px;
			grid-template-rows: auto 1fr;
			align-items: start;
		}
		/* About spans left column, above tokenomics */
		.about-col { grid-column: 1; }
		.left-col { grid-column: 1; }
		.right-col { grid-column: 2; grid-row: 1 / -1; }
		.right-col {
			position: sticky;
			top: 80px;
			overflow-y: auto;
			overflow-x: hidden;
			scrollbar-width: thin;
			scrollbar-color: rgba(255, 255, 255, 0.1) transparent;
			padding-bottom: 24px;
		}
		.right-col::-webkit-scrollbar { width: 4px; }
		.right-col::-webkit-scrollbar-track { background: transparent; }
		.right-col::-webkit-scrollbar-thumb { background: var(--border-input); border-radius: 2px; }
	}

	.preview-box {
		padding: 12px;
		background: rgba(0, 210, 255, 0.03);
		border: 1px solid rgba(0, 210, 255, 0.1);
		border-radius: 10px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.preview-row {
		display: flex;
		justify-content: space-between;
		font-size: 12px;
		font-family: 'Space Mono', monospace;
	}

	.max-buy-info {
		padding: 8px 12px;
		background: var(--bg-surface);
		border: 1px solid var(--bg-surface-hover);
		border-radius: 8px;
	}

	.slippage-row {
		display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; position: relative;
	}
	.slippage-toggle {
		display: inline-flex; align-items: center; gap: 5px;
		background: none; border: none; color: var(--text-dim);
		font-family: 'Space Mono', monospace; font-size: 11px;
		cursor: pointer; padding: 4px 0; width: fit-content;
	}
	.slippage-toggle:hover { color: var(--text-heading); }
	.slippage-options {
		display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
	}
	.slip-opt {
		padding: 4px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.08);
		background: rgba(255,255,255,0.03); color: var(--text-muted);
		font-family: 'Space Mono', monospace; font-size: 11px; cursor: pointer;
	}
	.slip-opt:hover { border-color: rgba(0, 210, 255, 0.3); color: var(--text-heading); }
	.slip-opt.active {
		border-color: rgba(0, 210, 255, 0.5); background: rgba(0, 210, 255, 0.08); color: #00d2ff;
	}
	.slip-custom {
		width: 60px; padding: 4px 6px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.08);
		background: rgba(255,255,255,0.03); color: var(--text-heading);
		font-family: 'Space Mono', monospace; font-size: 11px; text-align: center;
	}
	.slip-custom:focus { border-color: rgba(0, 210, 255, 0.4); outline: none; }

	.exceed-warning {
		padding: 8px 12px;
		background: rgba(239, 68, 68, 0.06);
		border: 1px solid rgba(239, 68, 68, 0.15);
		border-radius: 8px;
	}
	.impact-notice {
		padding: 10px 12px;
		background: rgba(245, 158, 11, 0.05);
		border: 1px solid rgba(245, 158, 11, 0.15);
		border-radius: 10px;
		display: flex; flex-direction: column; gap: 6px;
	}
	.impact-notice-header {
		display: flex; align-items: center; gap: 6px;
		color: #f59e0b; font-size: 12px; font-family: 'Space Mono', monospace; font-weight: 600;
	}
	.impact-notice-desc {
		font-size: 11px; color: #92400e; font-family: 'Space Mono', monospace; line-height: 1.5;
	}
	.impact-notice-btn {
		align-self: flex-start;
		padding: 5px 14px; border-radius: 6px; border: 1px solid rgba(0, 210, 255, 0.25);
		background: rgba(0, 210, 255, 0.08); color: #00d2ff;
		font-family: 'Space Mono', monospace; font-size: 11px;
		cursor: pointer; transition: all 0.15s;
	}
	.impact-notice-btn:hover { background: rgba(0, 210, 255, 0.15); border-color: rgba(0, 210, 255, 0.4); }

	/* Progress bar with soft cap marker */
	/* Progress context signals */
	.progress-context {
		display: flex; flex-direction: column; gap: 4px;
		margin-top: 8px;
	}
	.ctx-line {
		display: flex; align-items: center; gap: 5px;
		font-family: 'Space Mono', monospace; font-size: 9px;
		padding: 4px 8px; border-radius: 6px;
	}
	.ctx-line svg { flex-shrink: 0; }
	.ctx-scarcity { color: #f59e0b; background: rgba(245,158,11,0.05); }
	.ctx-scarcity svg { color: #f59e0b; }
	.ctx-pace-fast { color: #00d2ff; background: rgba(0,210,255,0.05); }
	.ctx-pace-slow { color: var(--text-dim); background: rgba(255,255,255,0.02); }
	.ctx-curve { color: var(--text-muted); background: rgba(255,255,255,0.02); }
	.ctx-curve svg { color: var(--text-dim); }
	.ctx-velocity { color: #f59e0b; background: rgba(245,158,11,0.05); }
	.ctx-impact { color: #10b981; background: rgba(16,185,129,0.05); }
	.ctx-impact svg { color: #10b981; }

	.lp-progress-wrap { position: relative; }

	/* Milestone ticks on progress bar */
	.lp-milestone-tick {
		position: absolute; top: 0; transform: translateX(-50%);
		pointer-events: none; z-index: 1;
	}
	.lp-milestone-line {
		width: 1px; height: 16px;
		background: rgba(255,255,255,0.08);
		transition: background 0.3s;
	}
	.lp-milestone-reached .lp-milestone-line {
		background: rgba(0,210,255,0.25);
	}

	/* Ghost marker: where bar was ~1h ago */
	.lp-ghost-marker {
		position: absolute; top: 3px; transform: translateX(-50%);
		width: 6px; height: 10px; border-radius: 2px;
		background: rgba(255,255,255,0.1);
		border: 1px solid rgba(255,255,255,0.08);
		pointer-events: none; z-index: 1;
	}
	.lp-sc-marker {
		position: absolute; top: -4px; transform: translateX(-50%);
		display: flex; flex-direction: column; align-items: center; z-index: 2;
	}
	.lp-sc-line {
		width: 2px; height: 24px;
		background: #f59e0b; border-radius: 1px;
		box-shadow: 0 0 6px rgba(245, 158, 11, 0.4);
	}
	.lp-sc-label {
		font-size: 9px; color: #f59e0b; font-family: 'Space Mono', monospace;
		font-weight: 700; margin-top: 2px; background: var(--bg, #0f172a);
		padding: 1px 4px; border-radius: 3px; border: 1px solid rgba(245, 158, 11, 0.3);
	}

	/* Override progress bar height for detail view */
	.progress-track {
		height: 8px;
		border-radius: 4px;
	}
	.progress-fill {
		border-radius: 4px;
		min-width: 4px;
		transition: width 0.3s ease;
	}

	.status-cyan { color: #00d2ff; }
	.status-amber { color: #f59e0b; }
	.status-purple { color: #a78bfa; }
	.status-red { color: #f87171; }

	/* Token header */
	.token-header {
		border-bottom: 1px solid var(--bg-surface-hover);
		padding-bottom: 20px;
	}
	.token-header-top {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 16px;
	}
	.token-identity {
		display: flex;
		align-items: flex-start;
		gap: 16px;
	}
	.token-logo {
		width: 56px;
		height: 56px;
		border-radius: 50%;
		object-fit: cover;
		flex-shrink: 0;
		border: 2px solid var(--bg-surface-hover);
	}
	.token-logo-placeholder {
		display: flex;
		align-items: center;
		justify-content: center;
		background: linear-gradient(135deg, rgba(0, 210, 255, 0.15), rgba(139, 92, 246, 0.15));
		font-size: 22px;
		font-weight: 700;
		color: #00d2ff;
		font-family: 'Syne', sans-serif;
	}
	.token-symbol-badge {
		font-size: 13px;
		font-family: 'Space Mono', monospace;
		color: var(--text-dim);
		background: var(--bg-surface);
		border: 1px solid var(--bg-surface-hover);
		padding: 2px 10px;
		border-radius: 6px;
	}
	.header-tags { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
	@media (max-width: 640px) {
		.header-tags { display: none; }
	}
	.header-tag {
		font-size: 11px;
		font-family: 'Space Mono', monospace;
		color: var(--text-dim);
		background: rgba(255, 255, 255, 0.03);
		border: 1px solid var(--border);
		padding: 2px 8px;
		border-radius: 4px;
	}
	/* Trust signal pills */
	/* Launch Rules */
	.rules-card {
		background: var(--bg-surface); border: 1px solid var(--border);
		border-radius: 14px; padding: 14px 16px;
	}
	.rules-header {
		display: flex; align-items: center; gap: 6px; margin-bottom: 10px;
	}
	.rules-title {
		font-family: 'Syne', sans-serif; font-size: 12px; font-weight: 800;
		color: var(--text-heading); letter-spacing: 0.02em;
	}
	.rules-list { display: flex; flex-direction: column; gap: 8px; }
	.rules-item {
		display: flex; align-items: flex-start; gap: 8px;
		font-family: 'Rajdhani', sans-serif; font-size: 12px;
		line-height: 1.3;
	}
	.rules-item svg { flex-shrink: 0; margin-top: 1px; }
	.rules-enforced { color: #10b981; }
	.rules-info { color: var(--text-muted); }

	.header-socials {
		display: flex;
		gap: 6px;
	}
	.header-social-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 30px;
		border-radius: 8px;
		background: var(--bg-surface);
		border: 1px solid var(--bg-surface-hover);
		font-size: 14px;
		text-decoration: none;
		transition: all 0.15s ease;
	}
	.header-social-icon:hover {
		border-color: rgba(0, 210, 255, 0.4);
		background: rgba(0, 210, 255, 0.06);
	}

	/* Tokenomics allocation bar */
	.alloc-bar {
		display: flex;
		height: 12px;
		border-radius: 6px;
		overflow: hidden;
		background: var(--bg-surface-hover);
	}
	.alloc-segment {
		height: 100%;
		min-width: 2px;
		transition: width 0.3s ease;
	}
	.alloc-cyan {
		background: linear-gradient(90deg, #00d2ff, #3a7bd5);
	}
	.alloc-purple {
		background: linear-gradient(90deg, #8b5cf6, #a78bfa);
	}
	.alloc-amber {
		background: linear-gradient(90deg, #f59e0b, #fbbf24);
	}

	.alloc-legend {
		display: flex;
		flex-wrap: wrap;
		gap: 16px;
	}
	.legend-item {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		font-family: 'Space Mono', monospace;
	}
	.legend-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}
	.legend-label {
		color: var(--text-dim);
	}
	.legend-value {
		color: var(--text);
		font-weight: 600;
	}

	/* Address truncation */
	.addr-value {
		font-size: 11px !important;
		max-width: 200px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* Sale Details */
	.sale-params { padding: 18px 20px; }
	.sale-params-title {
		font-family: 'Syne', sans-serif; font-size: 13px; font-weight: 800;
		color: var(--text-heading); margin-bottom: 12px;
	}
	.sale-highlights {
		display: flex; flex-direction: column; gap: 6px;
		margin-bottom: 14px;
	}
	.sale-highlight {
		display: flex; align-items: center; gap: 8px;
		padding: 8px 12px; border-radius: 8px;
		background: rgba(0, 210, 255, 0.04);
		border: 1px solid rgba(0, 210, 255, 0.08);
		font-family: 'Space Mono', monospace; font-size: 11px;
		color: var(--text-muted);
	}
	.sale-highlight svg { color: #00d2ff; flex-shrink: 0; }
	.sale-highlight-green {
		background: rgba(16, 185, 129, 0.06);
		border-color: rgba(16, 185, 129, 0.12);
	}
	.sale-highlight-green svg { color: #10b981; }
	.sale-highlight-green span { color: #10b981; font-weight: 600; }
	.sale-rows { margin-bottom: 14px; }
	.sale-row {
		display: flex; justify-content: space-between; align-items: center;
		padding: 8px 0;
		border-bottom: 1px solid var(--border-subtle);
	}
	.sale-row:last-child { border-bottom: none; }
	.sale-row-label {
		font-family: 'Space Mono', monospace; font-size: 11px;
		color: var(--text-dim);
	}
	.sale-row-val {
		font-family: 'Syne', sans-serif; font-size: 13px; font-weight: 700;
		color: var(--text-heading);
	}
	.sale-row-hint { font-size: 10px; color: var(--text-dim); font-weight: 400; }

	.sale-contracts {
		border-top: 1px solid var(--border-subtle); padding-top: 12px;
	}
	.sale-contracts-label {
		display: block; font-family: 'Rajdhani', sans-serif; font-size: 10px;
		color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.03em;
		margin-bottom: 8px;
	}
	.sale-addr-row {
		display: flex; justify-content: space-between; align-items: center;
		padding: 4px 0;
		font-family: 'Rajdhani', sans-serif; font-size: 11px;
	}
	.sale-addr-row span { color: var(--text-dim); }
	.sale-addr {
		color: var(--text-muted); text-decoration: none;
		font-family: 'Space Mono', monospace; font-size: 10px;
	}
	.sale-addr:hover { color: #00d2ff; }
	.sale-addr-group { display: flex; align-items: center; gap: 6px; }
	.copy-addr-btn {
		background: none; border: none; cursor: pointer; padding: 2px;
		color: var(--text-dim); opacity: 0.5; transition: opacity 0.15s;
	}
	.copy-addr-btn:hover { opacity: 1; color: #00d2ff; }

	/* Your Bag */
	.pos-card { padding: 20px; }
	.pos-header {
		display: flex; align-items: center; justify-content: space-between;
		margin-bottom: 8px;
	}
	.pos-title {
		font-family: 'Syne', sans-serif; font-size: 13px; font-weight: 800;
		color: var(--text-heading);
	}
	.pos-pnl {
		font-family: 'Rajdhani', sans-serif; font-size: 13px; font-weight: 700;
		padding: 2px 8px; border-radius: 6px;
	}
	.pos-pnl.pos-up { color: #10b981; background: rgba(16,185,129,0.1); }
	.pos-pnl.pos-down { color: #f87171; background: rgba(248,113,113,0.1); }
	.pos-detail-val.pos-up { color: #10b981; }
	.pos-detail-val.pos-down { color: #f87171; }

	.pos-hero { margin-bottom: 14px; }
	.pos-hero-num {
		font-family: 'Syne', sans-serif; font-size: 26px; font-weight: 800;
		color: var(--text-heading);
	}
	.pos-hero-sym {
		font-family: 'Rajdhani', sans-serif; font-size: 14px; font-weight: 600;
		color: var(--text-muted); margin-left: 6px;
	}

	.pos-grid {
		display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
		margin-bottom: 14px;
	}
	.pos-detail {
		padding: 8px 10px; border-radius: 8px;
		background: var(--bg-surface-hover);
	}
	.pos-detail-label {
		display: block; font-family: 'Rajdhani', sans-serif; font-size: 10px;
		color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.03em;
		margin-bottom: 2px;
	}
	.pos-detail-val {
		display: block; font-family: 'Syne', sans-serif; font-size: 14px;
		font-weight: 700; color: var(--text-heading);
	}

	.pos-limit-remaining-hint {
		padding-top: 10px; border-top: 1px solid var(--border-subtle);
		font-family: 'Space Mono', monospace; font-size: 10px;
		color: var(--text-muted); text-align: center;
	}
	.pos-limit-maxed { color: #f87171; }
	.pos-limit {
		padding-top: 12px; border-top: 1px solid var(--border-subtle);
	}
	.pos-limit-header {
		display: flex; justify-content: space-between;
		font-family: 'Rajdhani', sans-serif; font-size: 11px;
		color: var(--text-dim); margin-bottom: 6px;
	}
	.pos-limit-remaining {
		display: block; text-align: right;
		font-family: 'Rajdhani', sans-serif; font-size: 11px;
		color: var(--text-dim); margin-top: 4px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		margin-top: 2px;
	}

	/* Modal */
	.modal-overlay {
		position: fixed;
		inset: 0;
		z-index: 1000;
		background: rgba(0, 0, 0, 0.7);
		backdrop-filter: blur(4px);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 16px;
	}
	.modal-card {
		background: var(--select-bg);
		border: 1px solid var(--border);
		border-radius: 16px;
		padding: 24px;
		max-width: 420px;
		width: 100%;
	}
	.qr-section {
		display: flex;
		flex-direction: column;
		align-items: center;
	}
	.qr-box {
		padding: 12px;
		background: var(--bg-surface);
		border: 1px solid var(--border-input);
		border-radius: 12px;
	}
	.qr-img {
		width: 180px;
		height: 180px;
		border-radius: 8px;
	}
	.address-box {
		padding: 8px 14px;
		background: rgba(0, 210, 255, 0.04);
		border: 1px solid rgba(0, 210, 255, 0.12);
		border-radius: 8px;
		max-width: 100%;
		word-break: break-all;
	}
	.badge-red {
		background: rgba(239, 68, 68, 0.1);
		color: #f87171;
		border: 1px solid rgba(239, 68, 68, 0.2);
	}

	/* Logo upload overlay */
	.logo-upload-wrap {
		position: relative;
		flex-shrink: 0;
	}
	.logo-upload-overlay {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(0, 0, 0, 0.6);
		border-radius: 50%;
		opacity: 0;
		transition: opacity 0.15s ease;
		cursor: pointer;
		color: var(--text-heading);
		font-family: 'Space Mono', monospace;
	}
	.logo-upload-wrap:hover .logo-upload-overlay {
		opacity: 1;
	}
	.logo-upload-overlay input[type="file"] {
		display: none;
	}

	/* Launch badges */
	.launch-badge {
		font-size: 10px;
		font-weight: 600;
		font-family: 'Space Mono', monospace;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 2px 8px;
		border-radius: 4px;
	}
	.badge-cyan { background: rgba(0, 210, 255, 0.12); color: #00d2ff; border: 1px solid rgba(0, 210, 255, 0.25); }
	.badge-emerald { background: rgba(16, 185, 129, 0.12); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.25); }
	.badge-purple { background: rgba(139, 92, 246, 0.12); color: #a78bfa; border: 1px solid rgba(139, 92, 246, 0.25); }
	.badge-amber { background: rgba(245, 158, 11, 0.12); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.25); }
	.badge-blue { background: rgba(59, 130, 246, 0.12); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.25); }
	.badge-safu { background: rgba(16, 185, 129, 0.2); color: #10b981; font-weight: 800; border: 1px solid rgba(16, 185, 129, 0.3); }
	.badge-kyc { background: rgba(59, 130, 246, 0.15); color: #60a5fa; font-weight: 800; border: 1px solid rgba(59, 130, 246, 0.3); }
	.badge-lp { background: rgba(59, 130, 246, 0.12); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.2); }
	.badge-locked { background: rgba(139, 92, 246, 0.12); color: #a78bfa; border: 1px solid rgba(139, 92, 246, 0.2); }
	.badge-renounced { background: rgba(16, 185, 129, 0.12); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.2); }
	.badge-audited { background: rgba(0, 210, 255, 0.12); color: #00d2ff; border: 1px solid rgba(0, 210, 255, 0.2); }
	.badge-mintable { background: rgba(245, 158, 11, 0.12); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.2); }
	.badge-taxable { background: rgba(245, 158, 11, 0.12); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.2); }
	.badge-tax-locked { background: rgba(16, 185, 129, 0.12); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.2); }
	.badge-partner { background: rgba(139, 92, 246, 0.12); color: #a78bfa; border: 1px solid rgba(139, 92, 246, 0.2); }
	.badge-orange { background: rgba(249, 115, 22, 0.12); color: #fb923c; border: 1px solid rgba(249, 115, 22, 0.25); }

	/* Video embed */
	.video-embed {
		border-radius: 12px;
		overflow: hidden;
	}
	.video-iframe {
		width: 100%;
		aspect-ratio: 16 / 9;
		border-radius: 12px;
		border: 1px solid var(--bg-surface-hover);
	}
	.video-link-card {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 14px 16px;
		background: var(--bg-surface);
		border: 1px solid var(--bg-surface-hover);
		border-radius: 12px;
		text-decoration: none;
		transition: border-color 0.15s ease;
	}
	.video-link-card:hover {
		border-color: rgba(0, 210, 255, 0.3);
	}

	/* Empty state prompt */
	.empty-state-btn {
		width: 100%;
		padding: 20px;
		background: rgba(0, 210, 255, 0.03);
		border: 1px dashed rgba(0, 210, 255, 0.15);
		border-radius: 10px;
		cursor: pointer;
		transition: all 0.15s ease;
		text-align: center;
	}
	.empty-state-btn:hover {
		background: rgba(0, 210, 255, 0.06);
		border-color: rgba(0, 210, 255, 0.3);
	}

	/* Countdown timer */
	.countdown-grid {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 8px;
	}
	.countdown-box {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
		padding: 10px 4px;
		background: linear-gradient(135deg, rgba(0, 210, 255, 0.08), rgba(139, 92, 246, 0.08));
		border: 1px solid rgba(0, 210, 255, 0.15);
		border-radius: 10px;
	}
	.countdown-num {
		font-size: 22px;
		font-weight: 700;
		color: var(--text-heading);
		font-family: 'Space Mono', monospace;
		line-height: 1;
	}
	.countdown-num-amber {
		color: #f59e0b;
	}
	.countdown-label {
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-dim);
		font-family: 'Space Mono', monospace;
	}

	/* Progress bar large variant */
	.progress-track-lg {
		height: 16px;
		border-radius: 8px;
		background: var(--bg-surface-input, rgba(255,255,255,0.06));
		border: 1px solid var(--border-subtle, rgba(255,255,255,0.05));
	}

	/* Sale info divider */
	.sale-info-divider {
		height: 1px;
		background: var(--bg-surface-hover);
		margin: 0;
	}

	/* Share section */
	.share-row {
		display: flex;
		justify-content: center;
		gap: 10px;
	}
	.share-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		border-radius: 50%;
		background: var(--bg-surface);
		border: 1px solid var(--bg-surface-hover);
		font-size: 16px;
		cursor: pointer;
		transition: all 0.15s ease;
		text-decoration: none;
		color: inherit;
	}
	.share-btn:hover {
		border-color: rgba(0, 210, 255, 0.4);
		background: rgba(0, 210, 255, 0.06);
		transform: scale(1.05);
	}

	/* Connect CTA */
	.connect-cta {
		padding-top: 8px;
		border-top: 1px solid var(--bg-surface-hover);
		margin-top: 8px;
	}

	select option {
		background: var(--select-bg);
	}

	/* Favorite button on detail page header */
	.detail-fav-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: var(--bg-surface);
		border: 1px solid var(--border);
		border-radius: 50%;
		width: 34px;
		height: 34px;
		cursor: pointer;
		transition: all var(--transition-fast);
		color: var(--text-dim);
		flex-shrink: 0;
	}
	.detail-fav-btn:hover {
		border-color: rgba(0, 210, 255, 0.4);
		background: rgba(0, 210, 255, 0.08);
		color: #00d2ff;
	}

	/* Activity Feed */
	/* Activity — empty state */
	.activity-empty { text-align: center; padding: 28px 16px; }
	.activity-empty-icon {
		width: 48px; height: 48px; border-radius: 50%; margin: 0 auto 10px;
		background: var(--bg-surface); display: flex;
		align-items: center; justify-content: center;
		color: var(--text-dim); opacity: 0.5;
	}
	.activity-empty p { font-family: 'Syne', sans-serif; font-size: 13px; font-weight: 700; color: var(--text-muted); margin: 0 0 4px; }
	.activity-empty span { font-family: 'Space Mono', monospace; font-size: 10px; color: var(--text-dim); }

	/* Activity — summary stats bar */
	.activity-stats {
		display: flex; align-items: center; justify-content: center; gap: 16px;
		padding: 10px 0 14px; margin-bottom: 4px;
		border-bottom: 1px solid var(--border-subtle);
	}
	.activity-stat { display: flex; flex-direction: column; align-items: center; gap: 1px; }
	.activity-stat-val {
		font-family: 'Syne', sans-serif; font-size: 16px; font-weight: 800;
		color: var(--text-heading);
	}
	.activity-stat-label {
		font-family: 'Rajdhani', sans-serif; font-size: 10px;
		color: var(--text-muted, #94a3b8); text-transform: uppercase; letter-spacing: 0.03em;
	}
	.activity-stat-divider { width: 1px; height: 24px; background: var(--border-subtle); }

	/* Activity — momentum signals */
	.activity-signals { display: flex; flex-direction: column; gap: 6px; padding: 10px 0; }
	.activity-signal {
		display: flex; align-items: center; gap: 6px;
		font-family: 'Space Mono', monospace; font-size: 10px; font-weight: 600;
		padding: 6px 10px; border-radius: 8px;
	}
	.signal-momentum {
		color: #00d2ff; background: rgba(0,210,255,0.06); border: 1px solid rgba(0,210,255,0.1);
	}
	.signal-pulse {
		width: 6px; height: 6px; border-radius: 50%; background: #00d2ff;
		box-shadow: 0 0 6px rgba(0,210,255,0.5);
		animation: pulse-glow 2s ease-in-out infinite;
	}
	.signal-scarcity {
		color: #f59e0b; background: rgba(245,158,11,0.06); border: 1px solid rgba(245,158,11,0.1);
	}
	.signal-scarcity svg { color: #f59e0b; flex-shrink: 0; }
	.signal-gain {
		color: #10b981; background: rgba(16,185,129,0.06); border: 1px solid rgba(16,185,129,0.1);
	}
	.signal-gain svg { color: #10b981; flex-shrink: 0; }

	/* Activity header */
	.activity-header {
		display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;
	}
	.activity-live-indicator {
		display: flex; align-items: center; gap: 5px;
		font-family: 'Space Mono', monospace; font-size: 9px; font-weight: 700;
		color: #10b981; text-transform: uppercase; letter-spacing: 0.08em;
	}
	.activity-live-pulse {
		width: 7px; height: 7px; border-radius: 50%; background: #10b981;
		box-shadow: 0 0 8px rgba(16,185,129,0.6);
		animation: pulse-glow 2s ease-in-out infinite;
	}

	/* Activity — badges */
	.activity-badge {
		font-size: 9px; padding: 1px 5px; border-radius: 4px;
		font-family: 'Space Mono', monospace; font-weight: 600;
	}
	.badge-first { background: rgba(245,158,11,0.1); color: #f59e0b; }
	.badge-top { background: rgba(239,68,68,0.1); color: #f87171; }
	.badge-whale { background: rgba(245,158,11,0.08); color: #f59e0b; }
	.badge-repeat { background: rgba(139,92,246,0.08); color: #a78bfa; }

	/* Activity — price context */
	.activity-price-ctx {
		font-family: 'Space Mono', monospace; font-size: 9px;
		color: #10b981; margin-top: 2px; opacity: 0.7;
	}

	/* Activity — milestone markers */
	.activity-milestone {
		display: flex; align-items: center;
		gap: 8px; margin: 8px 0;
		font-family: 'Space Mono', monospace;
		font-size: 10px; font-weight: 700;
	}
	.activity-milestone::before,
	.activity-milestone::after {
		content: ''; flex: 1; height: 1px;
	}
	.milestone-sc { color: #10b981; }
	.milestone-sc::before, .milestone-sc::after { background: rgba(16,185,129,0.25); }
	.milestone-half { color: #00d2ff; }
	.milestone-half::before, .milestone-half::after { background: rgba(0,210,255,0.2); }
	.milestone-buyers { color: #a78bfa; }
	.milestone-buyers::before, .milestone-buyers::after { background: rgba(139,92,246,0.2); }

	/* Activity — join CTA */
	.activity-join-cta {
		display: flex; align-items: center; justify-content: space-between;
		padding: 12px 14px; margin-top: 12px;
		border-radius: 10px;
		background: linear-gradient(135deg, rgba(0,210,255,0.06), rgba(16,185,129,0.06));
		border: 1px solid rgba(0,210,255,0.12);
		font-family: 'Syne', sans-serif; font-size: 13px; font-weight: 700;
		color: var(--text-heading);
	}

	/* Activity — row animation */
	.activity-row {
		animation: activity-slide-in 0.3s ease-out both;
	}
	@keyframes activity-slide-in {
		from { opacity: 0; transform: translateY(-6px); }
		to { opacity: 1; transform: translateY(0); }
	}

	/* Activity — timeline */
	.activity-list { display: flex; flex-direction: column; gap: 0; padding-top: 8px; }

	.activity-row {
		display: flex; gap: 12px; min-height: 52px;
	}
	.activity-left {
		display: flex; flex-direction: column; align-items: center;
		width: 12px; flex-shrink: 0; padding-top: 6px;
	}
	.activity-dot {
		width: 8px; height: 8px; border-radius: 50%;
		background: var(--border); flex-shrink: 0;
	}
	.activity-live-dot {
		width: 8px; height: 8px; border-radius: 50%;
		background: #00d2ff; flex-shrink: 0;
		animation: pulse-dot 2s ease-in-out infinite;
	}
	@keyframes pulse-dot {
		0%, 100% { box-shadow: 0 0 0 0 rgba(0, 210, 255, 0.4); }
		50% { box-shadow: 0 0 0 6px rgba(0, 210, 255, 0); }
	}
	.activity-line {
		width: 1.5px; flex: 1; background: var(--border-subtle);
		margin: 3px 0;
	}
	.activity-latest .activity-line { background: rgba(0,210,255,0.2); }

	.activity-card {
		flex: 1; min-width: 0; padding-bottom: 12px;
	}
	.activity-card-top {
		display: flex; align-items: baseline; flex-wrap: wrap;
		gap: 4px 6px; margin-bottom: 2px;
	}
	.activity-addr { text-decoration: none; }
	.activity-addr:hover { color: #00d2ff; }
	a.activity-addr {
		font-family: 'Space Mono', monospace; font-size: 12px;
		color: var(--text); font-weight: 700;
	}
	.activity-self .activity-addr { color: #00d2ff; }
	.activity-latest .activity-addr { color: var(--text-heading); }
	.activity-time {
		font-family: 'Space Mono', monospace; font-size: 10px;
		color: var(--text-dim); white-space: nowrap; margin-left: auto;
	}
	.activity-live-badge {
		font-family: 'Space Mono', monospace; font-size: 9px; font-weight: 700;
		color: #00d2ff; margin-left: auto;
		padding: 1px 6px; border-radius: 4px;
		background: rgba(0,210,255,0.1); border: 1px solid rgba(0,210,255,0.15);
		animation: pulse-glow 2s ease-in-out infinite;
	}

	/* Buy line: "368.7K SMS · $9.90" */
	.activity-card-hero {
		font-family: 'Rajdhani', sans-serif; font-size: 14px;
		font-weight: 600; line-height: 1.4;
		font-variant-numeric: tabular-nums;
	}
	.activity-tok { color: var(--text-muted); }
	.activity-tok-sym { color: var(--text-dim); font-size: 12px; }
	.activity-sep { color: var(--text-dim); font-size: 10px; margin: 0 2px; }
	.activity-usd { color: #10b981; font-weight: 700; font-size: 15px; }
	.activity-whale .activity-usd { color: #f59e0b; font-size: 16px; }
	.activity-latest .activity-usd { color: #00d2ff; }

	/* Latest row highlight */
	.activity-live .activity-card {
		background: rgba(0,210,255,0.04);
		border-radius: 8px; padding: 6px 10px; margin: -6px -10px;
		border: 1px solid rgba(0,210,255,0.08);
	}
	.load-more-btn {
		display: block;
		width: 100%;
		margin-top: 12px;
		padding: 8px 0;
		background: rgba(255, 255, 255, 0.04);
		border: 1px solid var(--border-subtle);
		border-radius: 8px;
		color: var(--gray-400, #9ca3af);
		font-family: var(--font-mono, monospace);
		font-size: 11px;
		cursor: pointer;
		transition: background 0.15s, border-color 0.15s;
	}
	.load-more-btn:hover:not(:disabled) {
		background: rgba(255, 255, 255, 0.08);
		border-color: rgba(0, 210, 255, 0.3);
		color: #e5e7eb;
	}
	.load-more-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* FAQ */
	.faq-item {
		border-top: 1px solid var(--divider);
		padding: 0;
	}
	.faq-first { border-top: none; }
	.faq-q {
		padding: 12px 0;
		font-family: 'Syne', sans-serif;
		font-size: 13px;
		font-weight: 600;
		color: var(--text-heading);
		cursor: pointer;
		list-style: none;
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	.faq-q::after {
		content: '+';
		font-size: 16px;
		color: var(--text-dim);
		flex-shrink: 0;
		transition: transform 0.2s;
	}
	details[open] .faq-q::after {
		content: '−';
		color: #00d2ff;
	}
	.faq-q::-webkit-details-marker { display: none; }
	.faq-a {
		font-family: 'Space Mono', monospace;
		font-size: 11px;
		color: var(--text-muted);
		line-height: 1.6;
		padding: 0 0 14px;
		margin: 0;
	}

	/* Comments / Discussion */
	.comment-form {
		border-bottom: 1px solid rgba(255, 255, 255, 0.06);
		padding-bottom: 16px;
	}
	.comment-input {
		resize: vertical;
		min-height: 48px;
		max-height: 120px;
	}
	.comments-list {
		display: flex;
		flex-direction: column;
		gap: 0;
	}
	.comment-item {
		padding: 12px 0;
		border-bottom: 1px solid var(--border-subtle);
	}
	.comment-item:last-child {
		border-bottom: none;
	}
	.comment-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	/* Share buttons row (top of detail page) */
	.share-buttons-row {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.share-buttons-group {
		display: flex;
		gap: 8px;
	}
	.share-icon-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		border-radius: 8px;
		background: var(--bg-surface);
		border: 1px solid var(--bg-surface-hover);
		font-size: 14px;
		cursor: pointer;
		transition: all 0.15s ease;
		text-decoration: none;
		color: inherit;
	}
	.share-icon-btn:hover {
		border-color: rgba(0, 210, 255, 0.4);
		background: rgba(0, 210, 255, 0.06);
		transform: scale(1.05);
	}

	/* Graduation celebration banner */
	.graduation-banner {
		position: relative;
		overflow: hidden;
		border-radius: 14px;
		background: linear-gradient(135deg, rgba(16, 185, 129, 0.12), rgba(52, 211, 153, 0.08));
		border: 1px solid rgba(16, 185, 129, 0.3);
		padding: 16px 20px;
	}
	.graduation-content {
		position: relative;
		z-index: 1;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
	.graduation-text {
		font-size: 14px;
		font-family: 'Space Mono', monospace;
		color: #34d399;
		font-weight: 600;
	}
	.graduation-dismiss {
		flex-shrink: 0;
		width: 28px;
		height: 28px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 50%;
		background: rgba(16, 185, 129, 0.1);
		border: 1px solid rgba(16, 185, 129, 0.2);
		color: #34d399;
		font-size: 12px;
		cursor: pointer;
		transition: all 0.15s ease;
	}
	.graduation-dismiss:hover {
		background: rgba(16, 185, 129, 0.2);
		border-color: rgba(16, 185, 129, 0.4);
	}
	.graduation-particles {
		position: absolute;
		inset: 0;
		overflow: hidden;
		pointer-events: none;
	}
	.graduation-particles::before,
	.graduation-particles::after {
		content: '';
		position: absolute;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		opacity: 0;
	}
	.graduation-particles::before {
		background: #34d399;
		animation: sparkle1 2.5s ease-in-out infinite;
		top: 20%;
		left: 10%;
	}
	.graduation-particles::after {
		background: #10b981;
		animation: sparkle2 3s ease-in-out infinite 0.5s;
		top: 60%;
		right: 15%;
	}
	@keyframes sparkle1 {
		0%, 100% { opacity: 0; transform: translateY(0) scale(0.5); }
		25% { opacity: 0.8; transform: translateY(-12px) scale(1); }
		50% { opacity: 0.4; transform: translateY(-20px) scale(0.7); }
		75% { opacity: 0; transform: translateY(-28px) scale(0.3); }
	}
	@keyframes sparkle2 {
		0%, 100% { opacity: 0; transform: translateY(0) scale(0.5); }
		30% { opacity: 0.7; transform: translateY(-10px) scale(1.1); }
		60% { opacity: 0.3; transform: translateY(-18px) scale(0.6); }
		90% { opacity: 0; transform: translateY(-24px) scale(0.2); }
	}

	/* Remaining buy indicator */
	.remaining-buy-indicator {
		padding: 10px 12px;
		background: var(--bg-surface);
		border: 1px solid var(--bg-surface-hover);
		border-radius: 10px;
	}
	.remaining-buy-maxed {
		text-align: center;
		padding: 4px 0;
	}
	.remaining-buy-track {
		height: 6px;
		border-radius: 3px;
		background: var(--bg-surface-hover);
		overflow: hidden;
	}
	.remaining-buy-fill {
		height: 100%;
		border-radius: 3px;
		background: linear-gradient(90deg, #00d2ff, #3a7bd5);
		transition: width 0.3s ease;
	}
	.remaining-buy-full {
		background: linear-gradient(90deg, #10b981, #059669);
	}

	/* Fix 1: Light-mode card visibility */
	:global(:root.light) .card {
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06), 0 0 0 1px rgba(0, 0, 0, 0.04);
	}
	:global(:root.light) .position-stat,
	:global(:root.light) .rule-chip,
	:global(:root.light) .countdown-box {
		background: rgba(0, 0, 0, 0.025);
		border-color: rgba(0, 0, 0, 0.08);
	}
	:global(:root.light) .max-buy-info,
	:global(:root.light) .remaining-buy-indicator {
		background: rgba(0, 0, 0, 0.02);
		border-color: rgba(0, 0, 0, 0.08);
	}
	:global(:root.light) .preview-box {
		background: rgba(0, 150, 200, 0.04);
		border-color: rgba(0, 150, 200, 0.12);
	}
	:global(:root.light) .launch-badge {
		box-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.06);
	}
	:global(:root.light) .header-tag {
		background: rgba(0, 0, 0, 0.03);
		border-color: rgba(0, 0, 0, 0.08);
		color: var(--text-muted);
	}
	:global(:root.light) .countdown-box {
		background: linear-gradient(135deg, rgba(0, 150, 200, 0.06), rgba(100, 60, 200, 0.06));
		border-color: rgba(0, 150, 200, 0.12);
	}
	:global(:root.light) .countdown-num {
		color: var(--text-heading);
	}

	/* Fix 3: Bag amount + symbol pairing */
	.bag-amount {
		display: inline;
		font-family: 'Space Mono', monospace;
	}
	.bag-symbol {
		font-size: 0.75em;
		opacity: 0.6;
		font-weight: 600;
	}

	/* Fix 5: Mobile badge wrapping + countdown scaling */
	.badge-row {
		flex-wrap: wrap;
		gap: 6px;
	}
	@media (max-width: 500px) {
		.badge-row {
			gap: 4px;
		}
		.countdown-box {
			padding: 6px 2px;
		}
		.countdown-num {
			font-size: 16px;
		}
		.countdown-label {
			font-size: 7px;
		}
		.card { padding: 12px; }
		.card.p-6 { padding: 12px; }
		.card.p-5 { padding: 10px; }
	}
</style>
