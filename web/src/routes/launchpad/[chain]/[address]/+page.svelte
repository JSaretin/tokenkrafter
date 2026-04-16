<script lang="ts">
	import { ethers } from 'ethers';
	import { getContext, onDestroy } from 'svelte';
	import { page } from '$app/state';
	import { t } from '$lib/i18n';
	import { apiFetch } from '$lib/apiFetch';
	import { friendlyError } from '$lib/errorDecoder';
	import QrCode from '$lib/QrCode.svelte';
	import { getKnownLogo } from '$lib/tokenLogo';
	import TokenPickerModal, { type PickerToken } from '$lib/TokenPickerModal.svelte';
	import { supabase } from '$lib/supabaseClient';
	import { favorites, toggleFavorite } from '$lib/favorites';
	import RecentTransactionsTicker from '$lib/RecentTransactionsTicker.svelte';
	import type { SupportedNetwork } from '$lib/structure';
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

	// Pre-populate from server data for instant render
	const ssrLaunch = serverData?.launch;
	let launch: LaunchInfo | null = $state(null);
	let network: SupportedNetwork | null = $state(null);
	let tokenMeta = $state({
		name: ssrLaunch?.token_name || 'Loading...',
		symbol: ssrLaunch?.token_symbol || '...',
		decimals: ssrLaunch?.token_decimals ?? 18
	});
	let usdtDecimals = $state(ssrLaunch?.usdt_decimals ?? 18);
	let loading = $state(true);

	// Pre-populate badges from server
	let badges: string[] = $state(serverData?.badges || []);
	let buyAmount = $state(''); // always in USDT
	let buyPaymentMethod: 'usdt' | 'usdc' | 'native' | 'custom' = $state('usdt');
	let showPayPicker = $state(false);
	let customPayToken: PickerToken | null = $state(null);
	let preview: BuyPreview | null = $state(null);
	let previewLoading = $state(false);
	let isBuying = $state(false);
	let isRefunding = $state(false);
	let isGraduating = $state(false);
	let isDepositing = $state(false);
	let tradingEnabled = $state(true); // assume true unless we detect otherwise
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
	const BADGE_META: Record<string, { label: string; color: string }> = {
		audit: { label: 'Audit', color: 'cyan' },
		kyc: { label: 'KYC', color: 'emerald' },
		partner: { label: 'Partner', color: 'purple' },
		doxxed: { label: 'Doxxed', color: 'amber' },
		safu: { label: 'SAFU', color: 'blue' },
		mintable: { label: 'Mintable', color: 'orange' },
		taxable: { label: 'Taxable', color: 'amber' },
		renounced: { label: 'No Owner', color: 'emerald' }
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

	let atMaxBuy = $derived(maxBuyPerWallet > 0n && remainingBuyUsdt === 0n);

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
		// Target the specific chain from URL — no iteration needed
		const net = supportedNetworks.find(n => n.chain_id === targetChainId);
		if (!net) { loading = false; return; }

		const prov = networkProviders.get(net.chain_id);
		if (!prov) { loading = false; return; }

		try {
			const info = await fetchLaunchInfo(launchAddress, prov);
			launch = info;
			network = net;
			const [meta, usdtMeta] = await Promise.all([
				fetchTokenMeta(info.token, prov),
				fetchTokenMeta(info.usdtAddress, prov)
			]);
			tokenMeta = meta;
			usdtDecimals = usdtMeta.decimals;
			launch = { ...info, tokenName: meta.name, tokenSymbol: meta.symbol, tokenDecimals: meta.decimals, usdtDecimals: usdtMeta.decimals };

			// Check if trading is enabled. New contracts replaced the boolean
			// flag with a sentinel uint256: secondsUntilTradingOpens() returns
			// type(uint256).max if not yet scheduled, 0 if already open, or
			// the remaining countdown otherwise. Treat anything other than
			// "not yet scheduled" as enabled (countdown is fine for the UI —
			// the contract gates trading on the actual timestamp anyway).
			try {
				const tokenC = new ethers.Contract(info.token, PROTECTED_TOKEN_ABI, prov);
				const seconds: bigint = await tokenC.secondsUntilTradingOpens();
				const SENTINEL = (1n << 256n) - 1n;
				tradingEnabled = seconds !== SENTINEL;
			} catch {
				tradingEnabled = true;
			}

			// Load trust signal data (vesting, lock duration, creator claim state)
			try {
				const instance = new ethers.Contract(launchAddress, LAUNCH_INSTANCE_ABI, prov);
				const [vc, vd, lda, ctt, cc, gt] = await Promise.all([
					instance.vestingCliff(),
					instance.vestingDuration(),
					instance.lockDurationAfterListing(),
					instance.creatorTotalTokens(),
					instance.creatorClaimed(),
					instance.graduationTimestamp()
				]);
				vestingCliffSeconds = vc;
				vestingDurationSeconds = vd;
				lockDurationAfterListing = lda;
				creatorTotalTokens = ctt;
				creatorClaimed = cc;
				graduationTimestamp = gt;
			} catch {
				vestingCliffSeconds = 0n;
				vestingDurationSeconds = 0n;
			}

			// For Pending launches, load the preflight status so we can
			// show the creator a checklist of what's missing before the
			// launch can go live.
			if (info.state === 0) {
				try {
					const instance = new ethers.Contract(launchAddress, LAUNCH_INSTANCE_ABI, prov);
					const [ready, reason] = await instance.preflight();
					preflightReady = Boolean(ready);
					preflightReason = String(reason || '');
				} catch {
					preflightReady = false;
					preflightReason = '';
				}
			}

			// Load reclaim / sweep state if we're in Refunding. We need:
			//   - the launch's current token balance (available for creator reclaim)
			//   - the launch's current USDT balance (available for platform sweep after 90 days)
			//   - refundStartTimestamp (gates the sweep window)
			//   - lockDurationAfterListing (informational for the UI)
			//   - platformWallet (gates who can call sweepStrandedUsdt — the
			//     audit L2 fix made this platform-only)
			if (info.state === 3) {
				try {
					const tokenC = new ethers.Contract(info.token, ERC20_ABI, prov);
					reclaimableBalance = await tokenC.balanceOf(launchAddress);
				} catch { reclaimableBalance = 0n; }
				try {
					const usdtC = new ethers.Contract(info.usdtAddress, ERC20_ABI, prov);
					strandedUsdtBalance = await usdtC.balanceOf(launchAddress);
				} catch { strandedUsdtBalance = 0n; }
				try {
					const instance = new ethers.Contract(launchAddress, LAUNCH_INSTANCE_ABI, prov);
					const [rts, lda, ssd] = await Promise.all([
						instance.refundStartTimestamp(),
						instance.lockDurationAfterListing(),
						instance.STRANDED_SWEEP_DELAY(),
					]);
					refundStartTimestamp = rts;
					lockDurationAfterListing = lda;
					strandedSweepDelay = ssd;
				} catch {
					refundStartTimestamp = 0n;
					lockDurationAfterListing = 0n;
					strandedSweepDelay = 0n;
				}
				try {
					const lpFactory = new ethers.Contract(
						net.launchpad_address,
						LAUNCHPAD_FACTORY_ABI,
						prov
					);
					platformWalletAddress = await lpFactory.platformWallet();
				} catch {
					platformWalletAddress = '';
				}
			}

			if (userAddress) {
				await loadUserPosition(prov);
			} else {
				// Load minBuy floor even without a connected user so the
				// UI can validate amounts & disable the buy button.
				try {
					const instance = new ethers.Contract(launchAddress, LAUNCH_INSTANCE_ABI, prov);
					minBuyUsdt = await instance.minBuyUsdt();
				} catch { minBuyUsdt = 0n; }
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

			loading = false;
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

	$effect(() => {
		if (providersReady) {
			loadLaunch();
		}
	});

	// WS event-driven refresh for active launches, with polling fallback
	$effect(() => {
		if (!launch || launch.state !== 1) return;
		const ws = getWsManager();
		const chainId = network?.chain_id ?? targetChainId;

		// Clean up previous subscriptions
		for (const s of _wsSubs) s.unsubscribe();
		_wsSubs = [];

		if (ws) {
			const TOKEN_BOUGHT_TOPIC = ethers.id('TokenBought(address,uint256,uint256,uint256)');
			const STATE_TOPICS = [
				ethers.id('Graduated(address,uint256,address,uint256)'),
				ethers.id('RefundingEnabled(uint256,uint256)'),
			];

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

			// Slow safety-net poll with WS active
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
			// Slippage: accept 2% less tokens than preview estimates
			const minTokensOut = preview ? preview.tokensOut * 98n / 100n : 0n;

			// New unified buy(path, amountIn, minUsdtOut, minTokensOut) payable.
			// path[0] = address(0) signals native payment (msg.value must == amountIn).
			// For ERC20 payments msg.value must be 0.
			if (buyPaymentMethod === 'native') {
				// Get DEX quote for how much BNB is needed to produce buyAmount USDT
				const routerAbi = [
					'function getAmountsIn(uint256 amountOut, address[] calldata path) view returns (uint256[] memory amounts)',
					'function WETH() view returns (address)'
				];
				const router = new ethers.Contract(network.dex_router, routerAbi, signer.provider!);
				const weth = await router.WETH();
				const usdtNeeded = ethers.parseUnits(String(buyAmount), usdtDecimals);
				const amounts = await router.getAmountsIn(usdtNeeded, [weth, network.usdt_address]);
				const bnbNeeded = amounts[0];
				// 3% buffer for swap slippage
				const bnbToSend = bnbNeeded * 103n / 100n;
				const minUsdtOut = usdtNeeded * 98n / 100n;

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
				const minUsdtOut = buyPaymentMethod === 'usdt' ? 0n : amountWei * 98n / 100n;

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

	function shortAddr(addr: string) {
		return addr.slice(0, 6) + '...' + addr.slice(-4);
	}

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
					{$t('lpd.sendTo').replace('{token}', paymentLabel)} <span class="text-gray-400">{network.name}</span>. {$t('lpd.autoDetect')}
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
	{:else if !launch || !network}
		<div class="text-center py-20">
			<p class="text-gray-400 font-mono text-sm">{$t('lpd.notFound')}</p>
			<a href="/launchpad" class="btn-primary text-sm px-5 py-2.5 mt-4 inline-block no-underline">
				{$t('lpd.browseLaunches')}
			</a>
		</div>
	{:else}
		{@const color = stateColor(launch.state)}
		{@const nativeCoin = network.native_coin}
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
						<div class="flex items-center gap-3 flex-wrap">
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
									<span class="launch-badge badge-{BADGE_META[badge].color}">
										{BADGE_META[badge].label}
									</span>
								{/if}
							{/each}
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
						<div class="flex items-center gap-2 mt-2 flex-wrap">
							<span class="header-tag">{network.name}</span>
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

		<!-- Trust Signals -->
		<div class="trust-signals mb-4">
			<span class="trust-pill trust-green">LP Burns at Graduation</span>
			{#if badges.includes('taxable')}
				<span class="trust-pill trust-green">Tax Ceiling Locked</span>
			{/if}
			{#if maxBuyPerWallet > 0n}
				<span class="trust-pill trust-cyan">Max Buy: {formatUsdt(maxBuyPerWallet, usdtDecimals)} USDT per wallet</span>
			{/if}
			{#if lockDurationAfterListing > 0n}
				<span class="trust-pill trust-cyan">Anti-Snipe: {Number(lockDurationAfterListing) >= 3600 ? `${Math.round(Number(lockDurationAfterListing) / 3600)}h` : `${Math.round(Number(lockDurationAfterListing) / 60)}m`} trading delay</span>
			{/if}
			<span class="trust-pill trust-green">Refunds if soft cap missed</span>
			{#if launch.creatorAllocationBps > 0n && (vestingCliffSeconds > 0n || vestingDurationSeconds > 0n)}
				<span class="trust-pill trust-cyan">Creator vesting: {vestingCliffSeconds > 0n ? `${Math.round(Number(vestingCliffSeconds) / 86400)}d cliff` : ''}{vestingCliffSeconds > 0n && vestingDurationSeconds > 0n ? ' + ' : ''}{vestingDurationSeconds > 0n ? `${Math.round(Number(vestingDurationSeconds) / 86400)}d vest` : ''}</span>
			{/if}
		</div>

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
			<!-- Left: Token-focused content -->
			<div class="left-col">
				<!-- About / Inline Editor — hidden for non-creators when there's nothing to show -->
				{#if isEditing || metadata.description || metadata.video_url || isCreator}
				<div class="card p-6 mb-4">
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

				<!-- Tokenomics -->
				<div class="card p-6 mb-4">
					<h3 class="syne font-bold text-white mb-4">{$t('lpd.tokenomics')}</h3>
					{#if launch}
					{@const totalTokens = launch.tokensForCurve + launch.tokensForLP + (launch.totalTokensRequired > 0n ? (launch.totalTokensRequired - launch.tokensForCurve - launch.tokensForLP) : 0n)}
					{@const curvePct = totalTokens > 0n ? Number((launch.tokensForCurve * 10000n) / totalTokens) / 100 : 0}
					{@const lpPct = totalTokens > 0n ? Number((launch.tokensForLP * 10000n) / totalTokens) / 100 : 0}
					{@const creatorPct = Number(launch.creatorAllocationBps) / 100}
					{@const remainPct = Math.max(0, 100 - curvePct - lpPct)}

					<!-- Allocation bar -->
					<div class="alloc-bar mb-4">
						{#if curvePct > 0}
							<div class="alloc-segment alloc-cyan" style="width: {curvePct}%" title="Curve: {curvePct}%"></div>
						{/if}
						{#if lpPct > 0}
							<div class="alloc-segment alloc-purple" style="width: {lpPct}%" title="Liquidity: {lpPct}%"></div>
						{/if}
						{#if remainPct > 0}
							<div class="alloc-segment alloc-amber" style="width: {remainPct}%" title="Creator: {remainPct}%"></div>
						{/if}
					</div>

					<div class="alloc-legend mb-5">
						<div class="legend-item">
							<span class="legend-dot bg-cyan-400"></span>
							<span class="legend-label">{$t('lpd.curveSale')}</span>
							<span class="legend-value">{curvePct}%</span>
						</div>
						<div class="legend-item">
							<span class="legend-dot bg-purple-400"></span>
							<span class="legend-label">{$t('lpd.liquidityPool')}</span>
							<span class="legend-value">{lpPct}%</span>
						</div>
						{#if remainPct > 0}
							<div class="legend-item">
								<span class="legend-dot bg-amber-400"></span>
								<span class="legend-label">{$t('lpd.creatorLabel')}</span>
								<span class="legend-value">{remainPct}%</span>
							</div>
						{/if}
					</div>

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
						hardCap={launch.hardCap}
						tokenDecimals={tokenMeta.decimals}
						usdtDecimals={ud}
					/>
				</div>

				<!-- Sale Rules & Contract Info -->
				<div class="card p-6 mb-4">
					<h3 class="syne font-bold text-white mb-4">Launch Rules</h3>
					<div class="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
						<div class="rule-chip">
							<span class="rule-chip-value">1%</span>
							<span class="rule-chip-label">Buy Fee</span>
						</div>
						<div class="rule-chip">
							<span class="rule-chip-value">1%</span>
							<span class="rule-chip-label">Graduation Fee</span>
						</div>
						<div class="rule-chip">
							<span class="rule-chip-value">{maxBuyPerWallet > 0n ? formatUsdt(maxBuyPerWallet, ud) : 'None'}</span>
							<span class="rule-chip-label">Max Buy ({maxBuyPct}%)</span>
						</div>
						<div class="rule-chip">
							<span class="rule-chip-value">{network.symbol === 'BSC' ? 'PCS' : 'Uni'} V2</span>
							<span class="rule-chip-label">DEX (LP Burned)</span>
						</div>
						{#if minBuyUsdt > 0n}
							<div class="rule-chip">
								<span class="rule-chip-value">{formatUsdt(minBuyUsdt, ud)}</span>
								<span class="rule-chip-label">Min Buy</span>
							</div>
						{/if}
					</div>

					<div class="detail-grid">
						<div class="detail-row">
							<span class="detail-label">Token</span>
							<span class="detail-value addr-value text-cyan-400">{launch.token}</span>
						</div>
						<div class="detail-row">
							<span class="detail-label">Launch</span>
							<span class="detail-value addr-value">{launch.address}</span>
						</div>
						<div class="detail-row">
							<span class="detail-label">Creator</span>
							<span class="detail-value addr-value">{launch.creator}</span>
						</div>
					</div>
				</div>

				<!-- Global Transaction Ticker (social proof) -->
				<div class="mb-4">
					<RecentTransactionsTicker launchAddress={launchAddress} limit={10} />
				</div>

				<!-- Activity Feed -->
				<div class="card p-6 mb-4">
					<h3 class="syne font-bold text-white mb-4">{$t('lpd.recentActivity')}</h3>
					{#if txLoading}
						<div class="text-gray-500 text-xs font-mono text-center py-4">{$t('status.loading')}...</div>
					{:else if txItems.length === 0}
						<p class="text-gray-600 font-mono text-sm italic text-center py-4">{$t('lpd.noActivity')}</p>
					{:else}
						<div class="activity-list">
							{#each txItems as tx, i}
								<div class="activity-item" class:activity-latest={i === 0}>
									{#if i === 0}
										<span class="activity-pulse"></span>
									{/if}
									<div class="activity-content">
										<span class="text-cyan-400 text-xs font-mono font-semibold">{shortAddr(tx.buyer)}</span>
										<span class="text-gray-500 text-xs font-mono">
											{$t('lpd.bought')} {formatUsdt(BigInt(tx.base_amount), usdtDecimals)}
										</span>
										<span class="text-gray-400 text-xs font-mono">
											→ {formatTokens(BigInt(tx.tokens_received), tokenMeta.decimals)} {tokenMeta.symbol}
										</span>
										{#if tx.price && BigInt(tx.price) > 0n}
											<span class="text-gray-600 text-[10px] font-mono">@ {formatUsdt(BigInt(tx.price), usdtDecimals, 6)}</span>
										{/if}
									</div>
									<span class="text-gray-600 text-[10px] font-mono whitespace-nowrap">{relativeTime(tx.created_at)}</span>
								</div>
							{/each}
						</div>
						{#if txHasMore}
							<button class="load-more-btn" onclick={loadMoreTransactions} disabled={txLoadingMore}>
								{txLoadingMore ? `${$t('status.loading')}...` : `Load older (${txTotal - txItems.length} more)`}
							</button>
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
			</div>

			<!-- Right: Actions & Progress -->
			<div class="right-col">
				<!-- Countdown Timer -->
				{#if countdown && launch.state === 1}
					<div class="card p-5 mb-4" style={isScheduled ? 'border-color: rgba(245, 158, 11, 0.2)' : ''}>
						<div class="text-center mb-3">
							<span class="{isScheduled ? 'text-amber-400' : 'text-gray-400'} text-xs font-mono uppercase tracking-wider">
								{#if isScheduled}
									Sale Starts In
								{:else}
									{countdown.ended ? $t('lpd.saleEnded') : $t('lpd.saleEndsIn')}
								{/if}
							</span>
						</div>
						{#if !countdown.ended}
							{@const numClass = isScheduled ? 'countdown-num countdown-num-amber' : 'countdown-num'}
							<div class="countdown-grid">
								<div class="countdown-box">
									<span class={numClass}>{String(countdown.days).padStart(2, '0')}</span>
									<span class="countdown-label">{$t('lpd.days')}</span>
								</div>
								<div class="countdown-box">
									<span class={numClass}>{String(countdown.hours).padStart(2, '0')}</span>
									<span class="countdown-label">{$t('lpd.hours')}</span>
								</div>
								<div class="countdown-box">
									<span class={numClass}>{String(countdown.minutes).padStart(2, '0')}</span>
									<span class="countdown-label">{$t('lpd.min')}</span>
								</div>
								<div class="countdown-box">
									<span class={numClass}>{String(countdown.seconds).padStart(2, '0')}</span>
									<span class="countdown-label">{$t('lpd.sec')}</span>
								</div>
							</div>
						{:else}
							<div class="text-center text-red-400 text-sm font-mono">{$t('lpd.deadlineReached')}</div>
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
						</div>
						<div class="flex justify-between text-[10px] font-mono mt-1">
							<span class="text-gray-500">{progress}% {$t('lpd.raised')}</span>
							{#if launch.totalBaseRaised < launch.softCap}
								<span class="text-amber-400">{$t('lpd.softCapLabel')}: {progressPercent(launch.totalBaseRaised, launch.softCap)}%</span>
							{:else}
								<span class="text-emerald-400">{$t('lpd.softCapReached')}</span>
							{/if}
						</div>
					</div>

					<div class="mb-4">
						<div class="flex justify-between text-xs font-mono mb-1.5">
							<span class="text-gray-300 font-semibold">{formatTokens(launch.tokensSold, tokenMeta.decimals)}</span>
							<span class="text-gray-500">{formatTokens(launch.tokensForCurve, tokenMeta.decimals)}</span>
						</div>
						<div class="progress-track">
							<div class="progress-fill progress-purple" style="width: {tokenProgress}%"></div>
						</div>
						<div class="text-right text-[10px] text-gray-500 font-mono mt-1">{tokenProgress}% {$t('lpd.tokensSold')}</div>
					</div>

					<!-- Buyer stats -->
					{#if launch.totalBuyers > 0 || launch.totalPurchases > 0}
						<div class="flex items-center gap-4 text-xs font-mono mb-4">
							{#if launch.totalBuyers > 0}
								<div class="flex items-center gap-1.5">
									<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#00d2ff" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
									<span class="text-cyan-400 font-bold">{launch.totalBuyers}</span>
									<span class="text-gray-500">buyer{launch.totalBuyers !== 1 ? 's' : ''}</span>
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

				<!-- Enable Trading Banner — only shown AFTER graduation (state 2),
				     not during an active curve. During the curve, the launch
				     instance is excluded from limits + authorized launcher, so
				     it can transfer tokens to buyers regardless of the token's
				     tradingEnabled flag. Trading gets auto-enabled on graduation. -->
				{#if !tradingEnabled && launch.state === 2 && userAddress?.toLowerCase() === launch.creator.toLowerCase()}
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
				{:else if !tradingEnabled && launch.state === 2}
					<div class="card p-4 mb-4 border border-red-500/20">
						<p class="text-red-400 text-xs font-mono">
							{$t('lpd.tradingNotEnabled')}
						</p>
					</div>
				{/if}

				<!-- Your Position -->
				{#if userAddress && (userTokensBought > 0n || userBasePaid > 0n)}
					<div class="card p-5 mb-4">
						<h3 class="syne font-bold text-white text-sm mb-3">Your Position</h3>
						<div class="grid grid-cols-2 gap-3">
							<div class="position-stat">
								<span class="position-stat-value">{formatTokens(userTokensBought, tokenMeta.decimals)}</span>
								<span class="position-stat-label">{tokenMeta.symbol} Bought</span>
							</div>
							<div class="position-stat">
								<span class="position-stat-value">{formatUsdt(userBasePaid, ud)}</span>
								<span class="position-stat-label">USDT Spent</span>
							</div>
						</div>
						{#if maxBuyPerWallet > 0n}
							<div class="mt-3">
								<div class="flex justify-between text-[10px] font-mono mb-1">
									<span class="text-gray-500">Buy Limit Used</span>
									<span class="text-gray-400">{allocationPct.toFixed(1)}%</span>
								</div>
								<div class="progress-track">
									<div class="progress-fill progress-purple" style="width: {allocationPct}%"></div>
								</div>
								<div class="text-right text-[10px] font-mono mt-1 text-gray-500">
									{remainingBuyUsdt > 0n ? formatUsdt(remainingBuyUsdt, ud) + ' remaining' : 'Limit reached'}
								</div>
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
									<div class="remaining-buy-maxed">
										<span class="text-red-400 text-xs font-mono font-semibold">{$t('lpd.maxAllocationReached')}</span>
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
							chainId={network.chain_id}
							provider={signer?.provider ?? networkProviders.get(network.chain_id) ?? null}
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
	@media (min-width: 1024px) {
		.page-grid {
			grid-template-columns: 1fr 400px;
			align-items: start;
		}
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
	.lp-progress-wrap { position: relative; }
	.lp-sc-marker {
		position: absolute; top: -2px; transform: translateX(-50%);
		display: flex; flex-direction: column; align-items: center;
	}
	.lp-sc-line {
		width: 2px; height: 12px;
		background: #f59e0b; border-radius: 1px;
	}
	.lp-sc-label {
		font-size: 8px; color: #f59e0b; font-family: 'Space Mono', monospace;
		font-weight: 700; margin-top: 1px;
	}

	/* Override progress bar height for detail view */
	.progress-track {
		height: 8px;
		border-radius: 4px;
	}
	.progress-fill {
		border-radius: 4px;
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
	.trust-signals { display: flex; flex-wrap: wrap; gap: 6px; }
	.trust-pill {
		font-size: 10px; font-family: 'Space Mono', monospace; font-weight: 600;
		padding: 3px 10px; border-radius: 99px; white-space: nowrap;
	}
	.trust-green { background: rgba(16,185,129,0.12); color: #10b981; border: 1px solid rgba(16,185,129,0.25); }
	.trust-cyan { background: rgba(0,210,255,0.1); color: #00d2ff; border: 1px solid rgba(0,210,255,0.2); }

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

	/* Rule chips */
	.rule-chip {
		text-align: center;
		padding: 8px;
		border-radius: 8px;
		background: var(--bg-surface-hover);
		border: 1px solid var(--border-subtle);
	}
	.rule-chip-value {
		display: block;
		font-size: 13px;
		font-weight: 700;
		color: var(--text-heading);
		font-family: 'Space Mono', monospace;
	}
	.rule-chip-label {
		display: block;
		font-size: 9px;
		color: var(--text-muted);
		font-family: 'Space Mono', monospace;
		margin-top: 2px;
	}

	/* Your Position */
	.position-stat {
		text-align: center;
		padding: 10px 8px;
		border-radius: 8px;
		background: var(--bg-surface-hover);
		border: 1px solid var(--border-subtle);
	}
	.position-stat-value {
		display: block;
		font-size: 14px;
		font-weight: 700;
		color: var(--text-heading);
		font-family: 'Space Mono', monospace;
	}
	.position-stat-label {
		display: block;
		font-size: 9px;
		color: var(--text-muted);
		font-family: 'Space Mono', monospace;
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
		height: 12px;
		border-radius: 6px;
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
	.activity-list {
		display: flex;
		flex-direction: column;
		gap: 0;
	}
	.activity-item {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 0;
		border-bottom: 1px solid var(--border-subtle);
		position: relative;
	}
	.activity-item:last-child {
		border-bottom: none;
	}
	.activity-content {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		align-items: center;
		flex: 1;
		min-width: 0;
	}
	.activity-latest {
		background: rgba(0, 210, 255, 0.03);
		margin: 0 -24px;
		padding: 10px 24px;
		border-radius: 8px;
	}
	.activity-pulse {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: #00d2ff;
		flex-shrink: 0;
		animation: pulse-dot 2s ease-in-out infinite;
	}
	@keyframes pulse-dot {
		0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(0, 210, 255, 0.4); }
		50% { opacity: 0.6; box-shadow: 0 0 0 6px rgba(0, 210, 255, 0); }
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
</style>
