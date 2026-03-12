<script lang="ts">
	import { ethers } from 'ethers';
	import { getContext, onDestroy } from 'svelte';
	import { page } from '$app/state';
	import type { SupportedNetwork } from '$lib/structure';
	import { ERC20_ABI, ZERO_ADDRESS, FACTORY_ABI } from '$lib/tokenCrafter';
	import {
		LAUNCH_INSTANCE_ABI,
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

	let getProvider: () => ethers.BrowserProvider | null = getContext('provider');
	let getSigner: () => ethers.Signer | null = getContext('signer');
	let getUserAddress: () => string | null = getContext('userAddress');
	let connectWallet: () => Promise<boolean> = getContext('connectWallet');
	const addFeedback = getContext<(f: { message: string; type: string }) => void>('addFeedback');
	const supportedNetworks: SupportedNetwork[] = getContext('supportedNetworks');
	let getNetworkProviders: () => Map<number, ethers.JsonRpcProvider> = getContext('networkProviders');
	let getProvidersReady: () => boolean = getContext('providersReady');

	let signer = $derived(getSigner());
	let userAddress = $derived(getUserAddress());
	let networkProviders = $derived(getNetworkProviders());
	let providersReady = $derived(getProvidersReady());

	const launchAddress: string = page.params.address as string;

	let launch: LaunchInfo | null = $state(null);
	let network: SupportedNetwork | null = $state(null);
	let tokenMeta = $state({ name: 'Loading...', symbol: '...', decimals: 18 });
	let usdtDecimals = $state(18);
	let loading = $state(true);
	let buyAmount = $state(''); // always in USDT
	let buyPaymentMethod: 'usdt' | 'usdc' | 'native' = $state('usdt');
	let preview: BuyPreview | null = $state(null);
	let previewLoading = $state(false);
	let isBuying = $state(false);
	let isRefunding = $state(false);
	let isGraduating = $state(false);
	let isDepositing = $state(false);
	let tradingEnabled = $state(true); // assume true unless we detect otherwise
	let isEnablingTrading = $state(false);

	// Off-chain metadata from database
	type Metadata = {
		description?: string; logo_url?: string; website?: string;
		twitter?: string; telegram?: string; discord?: string;
		video_url?: string;
	};
	let metadata: Metadata = $state({});

	// Badges (from separate table + chain detection)
	let badges: string[] = $state([]);
	const BADGE_META: Record<string, { label: string; color: string }> = {
		audit: { label: 'Audit', color: 'cyan' },
		kyc: { label: 'KYC', color: 'emerald' },
		partner: { label: 'Partner', color: 'purple' },
		doxxed: { label: 'Doxxed', color: 'amber' },
		safu: { label: 'SAFU', color: 'blue' }
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
		if (!file || !userAddress || !network) return;

		if (file.size > 512 * 1024) {
			addFeedback({ message: 'Image too large. Max 512 KB.', type: 'error' });
			input.value = '';
			return;
		}

		isUploadingLogo = true;
		try {
			const fd = new FormData();
			fd.append('file', file);
			fd.append('address', launchAddress);
			fd.append('chain_id', String(network.chain_id));
			fd.append('wallet_address', userAddress);

			const res = await fetch('/api/launches/upload', { method: 'POST', body: fd });
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
		if (!userAddress || !network || !launch) return;
		isSavingMeta = true;
		try {
			const res = await fetch('/api/launches/metadata', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					address: launchAddress,
					chain_id: network.chain_id,
					wallet_address: userAddress,
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
	let tokenProgress = $derived.by(() => {
		const l = launch;
		return l && l.tokensForCurve > 0n
			? Math.min(100, Number((l.tokensSold * 100n) / l.tokensForCurve))
			: 0;
	});

	let remainingBuyTokens = $derived.by(() => {
		if (maxBuyPerWallet === 0n) return -1n; // no limit
		return maxBuyPerWallet > userTokensBought ? maxBuyPerWallet - userTokensBought : 0n;
	});

	let exceedsMaxBuy = $derived.by(() => {
		if (!preview || maxBuyPerWallet === 0n) return false;
		return (userTokensBought + preview.tokensOut) > maxBuyPerWallet;
	});

	let maxBuyPct = $derived.by(() => {
		const l = launch;
		if (!l || l.tokensForCurve === 0n || maxBuyPerWallet === 0n) return 0;
		return Number((maxBuyPerWallet * 10000n) / l.tokensForCurve) / 100;
	});

	let atMaxBuy = $derived(maxBuyPerWallet > 0n && remainingBuyTokens === 0n);

	let highImpact = $derived(preview ? Number(preview.priceImpactBps) > 1500 : false); // >15%

	let paymentLabel = $derived(
		buyPaymentMethod === 'native' ? (network?.native_coin ?? 'BNB') :
		buyPaymentMethod === 'usdt' ? 'USDT' : 'USDC'
	);

	// Countdown timer
	let countdownNow = $state(Date.now());
	let countdownInterval: ReturnType<typeof setInterval> | null = null;
	let countdown = $derived.by(() => {
		if (!launch) return null;
		const deadlineMs = Number(launch.deadline) * 1000;
		const diff = deadlineMs - countdownNow;
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

	async function loadLaunch() {
		for (const net of supportedNetworks) {
			const prov = networkProviders.get(net.chain_id);
			if (!prov) continue;

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

				// Check if trading is enabled
				try {
					const tokenC = new ethers.Contract(info.token, PROTECTED_TOKEN_ABI, prov);
					tradingEnabled = await tokenC.tradingEnabled();
				} catch {
					tradingEnabled = true; // assume enabled if function doesn't exist
				}

				// Load user position
				if (userAddress) {
					await loadUserPosition(prov);
				}

				// Fetch off-chain metadata + badges + partner detection (best-effort, parallel)
				const [metaRes, badgeRes, partnerInfo] = await Promise.all([
					fetch(`/api/launches?address=${launchAddress}`).catch(() => null),
					fetch(`/api/badges?address=${launchAddress}&chain_id=${net.chain_id}`).catch(() => null),
					(async () => {
						try {
							const factory = new ethers.Contract(net.platform_address, FACTORY_ABI, prov);
							const tokenInfo = await factory.getTokenInfo(info.token);
							return tokenInfo.isPartnership as boolean;
						} catch { return false; }
					})()
				]);

				if (metaRes?.ok) {
					const rows = await metaRes.json();
					if (rows?.[0]) {
						metadata = {
							description: rows[0].description,
							logo_url: rows[0].logo_url,
							website: rows[0].website,
							twitter: rows[0].twitter,
							telegram: rows[0].telegram,
							discord: rows[0].discord,
							video_url: rows[0].video_url
						};
					}
				}

				// Merge DB badges + chain-detected partner
				const dbBadges: string[] = [];
				if (badgeRes?.ok) {
					const rows = await badgeRes.json();
					for (const r of rows) dbBadges.push(r.badge_type);
				}
				if (partnerInfo && !dbBadges.includes('partner')) {
					dbBadges.push('partner');
				}
				badges = dbBadges;

				loading = false;
				return;
			} catch {
				// Try next network
			}
		}
		loading = false;
	}

	async function loadUserPosition(provider: ethers.Provider) {
		if (!userAddress) return;
		const instance = new ethers.Contract(launchAddress, LAUNCH_INSTANCE_ABI, provider);
		const [paid, bought, maxBuy] = await Promise.all([
			instance.basePaid(userAddress),
			instance.tokensBought(userAddress),
			instance.maxBuyPerWallet()
		]);
		userBasePaid = paid;
		userTokensBought = bought;
		maxBuyPerWallet = maxBuy;
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

	// Auto-refresh every 15s for active launches
	$effect(() => {
		if (launch && launch.state === 1) {
			refreshInterval = setInterval(refreshData, 15000);
		}
		return () => {
			if (refreshInterval) clearInterval(refreshInterval);
		};
	});

	onDestroy(() => {
		if (refreshInterval) clearInterval(refreshInterval);
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

			// fee = 1% (BUY_FEE_BPS = 100)
			const fee = (usdtWei * 100n) / 10000n;
			const baseForTokens = usdtWei - fee;

			// estimate tokens: baseForTokens / currentPrice * 1e18
			const tokensOut = (baseForTokens * BigInt(10 ** tokenMeta.decimals)) / currentPrice;
			if (tokensOut === 0n) return null;

			// Rough price impact estimate using linear approximation
			const remaining = launch ? launch.tokensForCurve - launch.tokensSold : 0n;
			let priceImpactBps = 0n;
			if (remaining > 0n && tokensOut > 0n) {
				// Impact ≈ tokensOut / remaining * 10000 (simple linear estimate)
				priceImpactBps = (tokensOut * 10000n) / remaining;
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
			return;
		}
		previewTimeout = setTimeout(async () => {
			previewLoading = true;
			previewError = '';
			try {
				const provider = networkProviders.get(net.chain_id);
				if (!provider) return;
				const instance = new ethers.Contract(launchAddress, LAUNCH_INSTANCE_ABI, provider);
				const usdtWei = ethers.parseUnits(String(amt), usdtDecimals);
				const result = await instance.previewBuy(usdtWei);
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

	function startBalancePolling() {
		stopBalancePolling();
		balanceCheckInterval = setInterval(async () => {
			const sufficient = await checkPaymentBalance();
			if (sufficient && showDepositModal) {
				stopBalancePolling();
				showDepositModal = false;
				addFeedback({ message: 'Deposit detected! You can now proceed.', type: 'success' });
			}
		}, 5000);
	}

	function stopBalancePolling() {
		if (balanceCheckInterval) {
			clearInterval(balanceCheckInterval);
			balanceCheckInterval = null;
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

			if (buyPaymentMethod === 'native') {
				// Get DEX quote for how much BNB is needed
				const routerAbi = [
					'function getAmountsIn(uint256 amountOut, address[] calldata path) view returns (uint256[] memory amounts)',
					'function WETH() view returns (address)'
				];
				const router = new ethers.Contract(network.dex_router, routerAbi, signer.provider!);
				const weth = await router.WETH();
				const usdtNeeded = ethers.parseUnits(String(buyAmount), usdtDecimals);
				const amounts = await router.getAmountsIn(usdtNeeded, [weth, network.usdt_address]);
				const bnbNeeded = amounts[0];
				// Add 3% buffer for slippage
				const bnbToSend = bnbNeeded * 103n / 100n;
				// minUsdtOut: accept 2% slippage on the DEX swap
				const minUsdtOut = usdtNeeded * 98n / 100n;

				addFeedback({ message: `Swapping ${network.native_coin} → USDT and buying...`, type: 'info' });
				const tx = await instance.buy(minUsdtOut, minTokensOut, { value: bnbToSend });
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

				addFeedback({ message: 'Buying tokens...', type: 'info' });
				const tx = await instance.buyWithToken(paymentAddress, amountWei, minUsdtOut, minTokensOut);
				await tx.wait();
			}

			addFeedback({ message: 'Tokens purchased!', type: 'success' });
			buyAmount = '';
			preview = null;
			await refreshData();
		} catch (e: any) {
			const errStr = String(e?.data || e?.message || e?.shortMessage || '');
			if (errStr.includes('0x11') || errStr.includes('OVERFLOW') || errStr.includes('overflow')) {
				addFeedback({ message: 'Transaction failed: arithmetic overflow in bonding curve. This launch may need to be recreated with a smaller token supply.', type: 'error' });
			} else {
				addFeedback({ message: e.shortMessage || e.message || 'Buy failed', type: 'error' });
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
			const tx = await tokenContract.enableTrading();
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
			addFeedback({ message: e.shortMessage || e.message || 'Failed to enable trading', type: 'error' });
		} finally {
			isEnablingTrading = false;
		}
	}

	const PROTECTED_TOKEN_ABI = [
		'function setExcludedFromLimits(address account, bool excluded) external',
		'function excludeFromTax(address account, bool exempt) external',
		'function isExcludedFromLimits(address) view returns (bool)',
		'function isTaxFree(address) view returns (bool)',
		'function tradingEnabled() view returns (bool)',
		'function enableTrading() external'
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

			// Configure token for launchpad: enable trading, exclude from limits + tax
			const tokenContract = new ethers.Contract(launch.token, [...ERC20_ABI, ...PROTECTED_TOKEN_ABI], signer);

			// Enable trading — required so buyers can receive and transfer tokens
			try {
				const tradingOn: boolean = await tokenContract.tradingEnabled();
				if (!tradingOn) {
					addFeedback({ message: 'Enabling trading on token...', type: 'info' });
					const tx = await tokenContract.enableTrading();
					await tx.wait();
					addFeedback({ message: 'Trading enabled.', type: 'success' });
				}
			} catch {
				// Token may not have trading gate — skip
			}

			// Exclude launch contract from limits (max tx, max wallet, cooldown)
			try {
				const isExcluded: boolean = await tokenContract.isExcludedFromLimits(launchAddress);
				if (!isExcluded) {
					addFeedback({ message: 'Excluding launch from token limits...', type: 'info' });
					const tx = await tokenContract.setExcludedFromLimits(launchAddress, true);
					await tx.wait();
				}
			} catch {
				// Token may not have protection features — skip
			}

			// Exclude launch contract from tax
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
			addFeedback({ message: e.shortMessage || e.message || 'Deposit failed', type: 'error' });
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
			const tx = await instance.refund();
			await tx.wait();
			addFeedback({ message: 'Refund successful!', type: 'success' });
			await refreshData();
		} catch (e: any) {
			addFeedback({ message: e.shortMessage || e.message || 'Refund failed', type: 'error' });
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
			addFeedback({ message: e.shortMessage || e.message || 'Graduation failed', type: 'error' });
		} finally {
			isGraduating = false;
		}
	}

	async function handleEnableRefunds() {
		if (!signer) return;
		try {
			const instance = new ethers.Contract(launchAddress, LAUNCH_INSTANCE_ABI, signer);
			addFeedback({ message: 'Enabling refunds...', type: 'info' });
			const tx = await instance.enableRefunds();
			await tx.wait();
			addFeedback({ message: 'Refunds enabled!', type: 'success' });
			await refreshData();
		} catch (e: any) {
			addFeedback({ message: e.shortMessage || e.message || 'Failed', type: 'error' });
		}
	}

	function shortAddr(addr: string) {
		return addr.slice(0, 6) + '...' + addr.slice(-4);
	}
</script>

<svelte:head>
	<title>{tokenMeta.symbol} Launch | TokenKrafter Launchpad</title>
</svelte:head>

<!-- Deposit Modal -->
{#if showDepositModal && userAddress && network}
	<div class="modal-overlay" onclick={() => { showDepositModal = false; stopBalancePolling(); }}>
		<div class="modal-card" onclick={(e) => e.stopPropagation()}>
			<div class="flex justify-between items-center mb-4">
				<h2 class="syne text-xl font-bold text-white">Insufficient {paymentLabel} Balance</h2>
				<button class="text-gray-500 hover:text-white text-lg cursor-pointer" onclick={() => { showDepositModal = false; stopBalancePolling(); }}>x</button>
			</div>

			<div class="text-center">
				<p class="text-gray-400 text-sm font-mono mb-1">
					You need <span class="text-cyan-400 font-semibold">{requiredAmount} {paymentLabel}</span> to complete this purchase.
				</p>
				<p class="text-gray-500 text-xs font-mono mb-4">
					Current balance: {parseFloat(ethers.formatUnits(userPaymentBalance, paymentDecimals)).toFixed(4)} {paymentLabel}
				</p>

				<div class="qr-section mb-4">
					<div class="qr-box">
						<img
							src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data={userAddress}&bgcolor=0d0d14&color=00d2ff"
							alt="Deposit address QR"
							class="qr-img"
						/>
					</div>
					<div class="address-box mt-3">
						<span class="text-cyan-400 text-xs font-mono break-all">{userAddress}</span>
					</div>
					<button
						class="text-gray-500 hover:text-cyan-400 text-[10px] font-mono mt-2 cursor-pointer transition"
						onclick={() => { navigator.clipboard.writeText(userAddress ?? ''); addFeedback({ message: 'Address copied!', type: 'success' }); }}
					>
						Copy Address
					</button>
				</div>

				<p class="text-gray-600 text-[10px] font-mono">
					Send {paymentLabel} to the address above on <span class="text-gray-400">{network.name}</span>. This page will auto-detect your deposit.
				</p>

				<div class="flex items-center justify-center gap-2 mt-4">
					<div class="spinner-sm"></div>
					<span class="text-gray-500 text-xs font-mono">Watching for deposit...</span>
				</div>
			</div>
		</div>
	</div>
{/if}

<div class="page-wrap max-w-6xl mx-auto px-4 sm:px-6 py-12">
	<!-- Back link -->
	<a href="/launchpad" class="text-gray-500 hover:text-cyan-400 text-sm font-mono transition no-underline mb-6 inline-block">
		← Back to Launchpad
	</a>

	{#if loading}
		<div class="flex flex-col items-center gap-4 py-20">
			<div class="spinner w-10 h-10 rounded-full border-2 border-white/10 border-t-cyan-400"></div>
			<p class="text-gray-500 text-sm font-mono">Loading launch data...</p>
		</div>
	{:else if !launch || !network}
		<div class="text-center py-20">
			<p class="text-gray-400 font-mono text-sm">Launch not found on any supported network.</p>
			<a href="/launchpad" class="btn-primary text-sm px-5 py-2.5 mt-4 inline-block no-underline">
				Browse Launches
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
							<img src={metadata.logo_url} alt="" class="token-logo" />
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
									<span class="text-[10px]">Upload</span>
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
						</div>
						<div class="flex items-center gap-2 mt-2 flex-wrap">
							<span class="header-tag">{network.name}</span>
							<span class="header-tag">{CURVE_TYPES[launch.curveType]} Curve</span>
							<span class="header-tag">Creator: {shortAddr(launch.creator)}</span>
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

		<div class="page-grid">
			<!-- Left: Token-focused content -->
			<div class="left-col">
				<!-- About / Inline Editor -->
				<div class="card p-6 mb-4">
					{#if isEditing}
						<!-- Inline edit mode -->
						<div class="flex justify-between items-center mb-4">
							<h3 class="syne font-bold text-white">Edit Token Info</h3>
							<button onclick={cancelEditing} class="text-gray-500 hover:text-white text-xs font-mono cursor-pointer">Cancel</button>
						</div>

						<div class="flex flex-col gap-4">
							<div>
								<label class="label-text" for="edit-desc">Description</label>
								<textarea id="edit-desc" class="input-field" rows="5" placeholder="Tell users about your token, its utility, roadmap..." bind:value={editDescription}></textarea>
							</div>

							<div>
								<label class="label-text" for="edit-video">Video (YouTube / X link)</label>
								<input id="edit-video" type="url" class="input-field" placeholder="https://youtube.com/watch?v=... or https://x.com/.../video" bind:value={editVideoUrl} />
							</div>

							<div class="grid grid-cols-2 gap-3">
								<div>
									<label class="label-text" for="edit-website">Website</label>
									<input id="edit-website" type="url" class="input-field" placeholder="https://..." bind:value={editWebsite} />
								</div>
								<div>
									<label class="label-text" for="edit-twitter">Twitter</label>
									<input id="edit-twitter" class="input-field" placeholder="@handle or URL" bind:value={editTwitter} />
								</div>
							</div>
							<div class="grid grid-cols-2 gap-3">
								<div>
									<label class="label-text" for="edit-telegram">Telegram</label>
									<input id="edit-telegram" class="input-field" placeholder="@group or URL" bind:value={editTelegram} />
								</div>
								<div>
									<label class="label-text" for="edit-discord">Discord</label>
									<input id="edit-discord" class="input-field" placeholder="Invite code or URL" bind:value={editDiscord} />
								</div>
							</div>

							<div class="flex gap-3">
								<button onclick={cancelEditing} class="btn-secondary flex-1 py-2.5 text-sm cursor-pointer">Cancel</button>
								<button onclick={saveMetadata} disabled={isSavingMeta} class="btn-primary flex-1 py-2.5 text-sm cursor-pointer">
									{isSavingMeta ? 'Saving...' : 'Save Changes'}
								</button>
							</div>
						</div>
					{:else}
						<!-- View mode -->
						<div class="flex justify-between items-center mb-3">
							<h3 class="syne font-bold text-white">About</h3>
							{#if isCreator}
								<button onclick={startEditing} class="text-gray-500 hover:text-cyan-400 text-xs font-mono transition cursor-pointer">
									{metadata.description ? 'Edit info' : '+ Add info'}
								</button>
							{/if}
						</div>
						{#if metadata.description}
							<p class="text-gray-300 font-mono text-sm leading-relaxed whitespace-pre-line">{metadata.description}</p>
						{:else if isCreator}
							<button onclick={startEditing} class="empty-state-btn">
								<span class="text-gray-500 text-sm">Add a description, links, and badges to attract buyers</span>
							</button>
						{:else}
							<p class="text-gray-600 font-mono text-sm italic">No description provided yet.</p>
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
										<span class="text-gray-300 text-sm font-mono">Watch Video</span>
									</a>
								{/if}
							</div>
						{/if}
					{/if}
				</div>

				<!-- Tokenomics -->
				<div class="card p-6 mb-4">
					<h3 class="syne font-bold text-white mb-4">Tokenomics</h3>
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
							<span class="legend-label">Curve Sale</span>
							<span class="legend-value">{curvePct}%</span>
						</div>
						<div class="legend-item">
							<span class="legend-dot bg-purple-400"></span>
							<span class="legend-label">Liquidity Pool</span>
							<span class="legend-value">{lpPct}%</span>
						</div>
						{#if remainPct > 0}
							<div class="legend-item">
								<span class="legend-dot bg-amber-400"></span>
								<span class="legend-label">Creator</span>
								<span class="legend-value">{remainPct}%</span>
							</div>
						{/if}
					</div>

					<div class="detail-grid">
						<div class="detail-row">
							<span class="detail-label">Tokens for Curve</span>
							<span class="detail-value">{formatTokens(launch.tokensForCurve, tokenMeta.decimals)}</span>
						</div>
						<div class="detail-row">
							<span class="detail-label">Tokens for LP</span>
							<span class="detail-value">{formatTokens(launch.tokensForLP, tokenMeta.decimals)}</span>
						</div>
						{#if creatorPct > 0}
							<div class="detail-row">
								<span class="detail-label">Creator Allocation</span>
								<span class="detail-value">{creatorPct}%</span>
							</div>
						{/if}
						<div class="detail-row">
							<span class="detail-label">Total Required</span>
							<span class="detail-value">{formatTokens(launch.totalTokensRequired, tokenMeta.decimals)}</span>
						</div>
					</div>
					{/if}
				</div>

				<!-- Bonding Curve -->
				<div class="card p-6 mb-4">
					<BondingCurveChart curveType={launch.curveType} progress={tokenProgress} />
				</div>

				<!-- Sale Details -->
				<div class="card p-6 mb-4">
					<h3 class="syne font-bold text-white mb-4">Sale Details</h3>
					<div class="detail-grid">
						<div class="detail-row">
							<span class="detail-label">Curve Type</span>
							<span class="detail-value">{CURVE_TYPES[launch.curveType]}</span>
						</div>
						<div class="detail-row">
							<span class="detail-label">Current Price</span>
							<span class="detail-value">{formatUsdt(launch.currentPrice, ud, 6)}</span>
						</div>
						<div class="detail-row">
							<span class="detail-label">Soft Cap</span>
							<span class="detail-value">{formatUsdt(launch.softCap, ud)}</span>
						</div>
						<div class="detail-row">
							<span class="detail-label">Hard Cap</span>
							<span class="detail-value">{formatUsdt(launch.hardCap, ud)}</span>
						</div>
						<div class="detail-row">
							<span class="detail-label">Deadline</span>
							<span class="detail-value">{timeRemaining(launch.deadline)}</span>
						</div>
						<div class="detail-row">
							<span class="detail-label">Max Buy / Wallet</span>
							<span class="detail-value">{maxBuyPerWallet > 0n ? formatTokens(maxBuyPerWallet, tokenMeta.decimals) + ' (' + maxBuyPct + '%)' : 'No limit'}</span>
						</div>
						<div class="detail-row">
							<span class="detail-label">Buy Fee</span>
							<span class="detail-value">1%</span>
						</div>
						<div class="detail-row">
							<span class="detail-label">Graduation Fee</span>
							<span class="detail-value">3%</span>
						</div>
						<div class="detail-row">
							<span class="detail-label">DEX Listing</span>
							<span class="detail-value">{network.symbol === 'BSC' ? 'PancakeSwap' : 'Uniswap'}</span>
						</div>
						<div class="detail-row">
							<span class="detail-label">LP</span>
							<span class="detail-value">Burned (permanent)</span>
						</div>
					</div>
				</div>

				<!-- Token Contract -->
				<div class="card p-6 mb-4">
					<h3 class="syne font-bold text-white mb-4">Token Contract</h3>
					<div class="detail-grid">
						<div class="detail-row">
							<span class="detail-label">Name</span>
							<span class="detail-value">{launch.tokenName}</span>
						</div>
						<div class="detail-row">
							<span class="detail-label">Symbol</span>
							<span class="detail-value">{launch.tokenSymbol}</span>
						</div>
						<div class="detail-row">
							<span class="detail-label">Decimals</span>
							<span class="detail-value">{tokenMeta.decimals}</span>
						</div>
						<div class="detail-row">
							<span class="detail-label">Token Address</span>
							<span class="detail-value addr-value">{launch.token}</span>
						</div>
						<div class="detail-row">
							<span class="detail-label">Launch Address</span>
							<span class="detail-value addr-value">{launch.address}</span>
						</div>
						<div class="detail-row">
							<span class="detail-label">Creator</span>
							<span class="detail-value addr-value">{launch.creator}</span>
						</div>
						<div class="detail-row">
							<span class="detail-label">Network</span>
							<span class="detail-value text-cyan-300">{network.name}</span>
						</div>
					</div>
				</div>
			</div>

			<!-- Right: Actions & Progress -->
			<div class="right-col">
				<!-- Countdown Timer -->
				{#if countdown && launch.state === 1}
					<div class="card p-5 mb-4">
						<div class="text-center mb-3">
							<span class="text-gray-400 text-xs font-mono uppercase tracking-wider">
								{countdown.ended ? 'Sale Ended' : 'Sale Ends In'}
							</span>
						</div>
						{#if !countdown.ended}
							<div class="countdown-grid">
								<div class="countdown-box">
									<span class="countdown-num">{String(countdown.days).padStart(2, '0')}</span>
									<span class="countdown-label">Days</span>
								</div>
								<div class="countdown-box">
									<span class="countdown-num">{String(countdown.hours).padStart(2, '0')}</span>
									<span class="countdown-label">Hours</span>
								</div>
								<div class="countdown-box">
									<span class="countdown-num">{String(countdown.minutes).padStart(2, '0')}</span>
									<span class="countdown-label">Min</span>
								</div>
								<div class="countdown-box">
									<span class="countdown-num">{String(countdown.seconds).padStart(2, '0')}</span>
									<span class="countdown-label">Sec</span>
								</div>
							</div>
						{:else}
							<div class="text-center text-red-400 text-sm font-mono">Deadline reached</div>
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
						<div class="progress-track progress-track-lg">
							<div class="progress-fill progress-cyan" style="width: {progress}%"></div>
						</div>
						<div class="flex justify-between text-[10px] font-mono mt-1">
							<span class="text-gray-500">{progress}% raised</span>
							{#if launch.totalBaseRaised < launch.softCap}
								<span class="text-amber-400">Soft cap: {progressPercent(launch.totalBaseRaised, launch.softCap)}%</span>
							{:else}
								<span class="text-emerald-400">Soft cap reached</span>
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
						<div class="text-right text-[10px] text-gray-500 font-mono mt-1">{tokenProgress}% tokens sold</div>
					</div>

					<!-- Sale info summary -->
					<div class="sale-info-divider"></div>
					<div class="detail-grid mt-4">
						<div class="detail-row">
							<span class="detail-label">Status</span>
							<span class="detail-value status-{color}">{stateLabel(launch.state)}</span>
						</div>
						<div class="detail-row">
							<span class="detail-label">Sale Type</span>
							<span class="detail-value">Fair Launch</span>
						</div>
						<div class="detail-row">
							<span class="detail-label">Current Rate</span>
							<span class="detail-value">1 USDT = {launch.currentPrice > 0n ? formatTokens((BigInt(10 ** usdtDecimals) * BigInt(10 ** tokenMeta.decimals)) / launch.currentPrice, tokenMeta.decimals) : '0'} {launch.tokenSymbol}</span>
						</div>
						<div class="detail-row">
							<span class="detail-label">Current Raised</span>
							<span class="detail-value">{formatUsdt(launch.totalBaseRaised, ud)}</span>
						</div>
					</div>
				</div>

				<!-- Deposit Box (Pending) -->
				{#if launch.state === 0 && userAddress?.toLowerCase() === launch.creator.toLowerCase()}
					{@const remaining = launch.totalTokensRequired - launch.totalTokensDeposited}
					{@const depositPct = launch.totalTokensRequired > 0n ? Number((launch.totalTokensDeposited * 100n) / launch.totalTokensRequired) : 0}
					<div class="card p-6 mb-4 border border-amber-500/20">
						<h3 class="syne font-bold text-amber-400 mb-2">Deposit Required</h3>
						<p class="text-gray-400 text-xs font-mono mb-4">
							Your launch is pending. Deposit tokens to activate it.
						</p>

						<div class="detail-grid mb-4">
							<div class="detail-row">
								<span class="detail-label">Total Required</span>
								<span class="detail-value">{formatTokens(launch.totalTokensRequired, tokenMeta.decimals)} {launch.tokenSymbol}</span>
							</div>
							<div class="detail-row">
								<span class="detail-label">Deposited</span>
								<span class="detail-value">{formatTokens(launch.totalTokensDeposited, tokenMeta.decimals)} {launch.tokenSymbol}</span>
							</div>
							<div class="detail-row">
								<span class="detail-label">Remaining</span>
								<span class="detail-value text-amber-400">{formatTokens(remaining, tokenMeta.decimals)} {launch.tokenSymbol}</span>
							</div>
						</div>

						<div class="mb-4">
							<div class="flex justify-between text-[10px] font-mono mb-1">
								<span class="text-gray-500">Deposit Progress</span>
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
								{isDepositing ? 'Depositing...' : `Approve & Deposit ${formatTokens(remaining, tokenMeta.decimals)} ${launch.tokenSymbol}`}
							</button>
							<p class="text-gray-600 text-[10px] font-mono mt-2 text-center">
								This will approve and transfer your tokens to the launch contract.
							</p>
						{:else}
							<p class="text-emerald-400 text-xs font-mono text-center">All tokens deposited. Activating...</p>
						{/if}
					</div>
				{:else if launch.state === 0}
					<div class="card p-6 mb-4 border border-amber-500/20">
						<h3 class="syne font-bold text-amber-400 mb-2">Pending Launch</h3>
						<p class="text-gray-400 text-xs font-mono">
							This launch is waiting for the creator to deposit tokens. It will activate once fully funded.
						</p>
						<div class="detail-grid mt-3">
							<div class="detail-row">
								<span class="detail-label">Deposited</span>
								<span class="detail-value">
									{formatTokens(launch.totalTokensDeposited, tokenMeta.decimals)} / {formatTokens(launch.totalTokensRequired, tokenMeta.decimals)}
								</span>
							</div>
						</div>
					</div>
				{/if}

				<!-- Enable Trading Banner -->
				{#if !tradingEnabled && launch.state === 1 && userAddress?.toLowerCase() === launch.creator.toLowerCase()}
					<div class="card p-4 mb-4 border border-red-500/20">
						<h3 class="syne font-bold text-red-400 mb-2 text-sm">Enable Trading to Activate Launch</h3>
						<p class="text-gray-400 text-xs font-mono mb-2">
							Trading must be enabled for buyers to purchase and trade your token. This is required for the launchpad and DEX graduation to work.
						</p>
						<p class="text-gray-500 text-[10px] font-mono mb-3">
							Tax settings (rates, wallets) can still be configured after enabling. Anti-whale limits (max wallet, max tx) can be set freely. Only cooldown time gets locked at its current value.
						</p>
						<button
							onclick={handleEnableTrading}
							disabled={isEnablingTrading}
							class="btn-primary w-full py-2.5 text-sm cursor-pointer"
						>
							{isEnablingTrading ? 'Enabling...' : 'Enable Trading'}
						</button>
					</div>
				{:else if !tradingEnabled && launch.state === 1}
					<div class="card p-4 mb-4 border border-red-500/20">
						<p class="text-red-400 text-xs font-mono">
							Trading is not enabled on this token yet. The creator needs to enable trading before purchases can be made.
						</p>
					</div>
				{/if}

				<!-- Buy Box -->
				{#if launch.state === 1}
					<div class="card p-6 mb-4">
						<h3 class="syne font-bold text-white mb-4">Buy Tokens</h3>

						<!-- Amount in USDT -->
						<div class="mb-3">
							<label class="label-text" for="buy-amount">Amount (USDT)</label>
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

						<!-- Payment method select -->
						<div class="mb-3">
							<label class="label-text" for="pay-method">Pay with</label>
							<select id="pay-method" class="input-field" bind:value={buyPaymentMethod}>
								<option value="usdt">USDT</option>
								<option value="usdc">USDC</option>
								<option value="native">{nativeCoin} (auto-converted to USDT)</option>
							</select>
						</div>

						<!-- Preview -->
						{#if preview && !previewLoading}
							<div class="preview-box mb-4">
								{#if previewError === 'estimate'}
									<div class="text-amber-400 text-[10px] font-mono text-center pb-1">
										Approximate estimate (curve math overflow)
									</div>
								{/if}
								<div class="preview-row">
									<span class="text-gray-500">You receive</span>
									<span class="text-white font-semibold">
										~{formatTokens(preview.tokensOut, tokenMeta.decimals)} {launch.tokenSymbol}
									</span>
								</div>
								<div class="preview-row">
									<span class="text-gray-500">Fee (1%)</span>
									<span class="text-gray-300">{formatUsdt(preview.fee, ud)}</span>
								</div>
								{#if preview.priceImpactBps > 0n}
									<div class="preview-row">
										<span class="text-gray-500">Price impact</span>
										<span
											class="{Number(preview.priceImpactBps) > 500
												? 'text-red-400'
												: Number(preview.priceImpactBps) > 200
													? 'text-amber-400'
													: 'text-emerald-400'}"
										>
											{previewError === 'estimate' ? '~' : ''}{(Number(preview.priceImpactBps) / 100).toFixed(2)}%
										</span>
									</div>
								{/if}
							</div>
						{:else if previewLoading}
							<div class="preview-box mb-4">
								<div class="text-gray-500 text-xs font-mono text-center py-2">Calculating...</div>
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
									<span class="text-gray-500">Max buy per wallet</span>
									<span class="text-gray-400">{formatTokens(maxBuyPerWallet, tokenMeta.decimals)} {launch.tokenSymbol} ({maxBuyPct}%)</span>
								</div>
								{#if userTokensBought > 0n}
									<div class="flex justify-between text-[10px] font-mono mt-1">
										<span class="text-gray-500">Remaining</span>
										<span class="{remainingBuyTokens === 0n ? 'text-red-400' : 'text-gray-400'}">
											{remainingBuyTokens === 0n ? 'Limit reached' : formatTokens(remainingBuyTokens, tokenMeta.decimals) + ' ' + launch.tokenSymbol}
										</span>
									</div>
								{/if}
							</div>
						{/if}

						{#if exceedsMaxBuy}
							<div class="exceed-warning mb-3">
								<span class="text-red-400 text-xs font-mono">
									This purchase would exceed the max buy limit ({maxBuyPct}% of curve tokens per wallet).
								</span>
							</div>
						{/if}
						{#if highImpact}
							<div class="exceed-warning mb-3">
								<span class="text-red-400 text-xs font-mono">
									Price impact is too high ({preview ? (Number(preview.priceImpactBps) / 100).toFixed(1) : 0}%). Try a smaller amount.
								</span>
							</div>
						{/if}

						{#if userAddress}
							<button
								onclick={handleBuy}
								disabled={isBuying || !buyAmount || parseFloat(String(buyAmount)) <= 0 || exceedsMaxBuy || atMaxBuy || highImpact}
								class="btn-primary w-full py-3 text-sm cursor-pointer"
							>
								{#if atMaxBuy}
									Max Buy Reached
								{:else if exceedsMaxBuy}
									Exceeds Max Buy
								{:else if highImpact}
									Impact Too High
								{:else}
									{isBuying ? "Buying..." : `Buy with ${paymentLabel}`}
								{/if}
							</button>
						{:else}
							<div class="connect-cta">
								<p class="text-gray-500 text-xs font-mono mb-3 text-center">Connect your wallet to participate</p>
								<button onclick={connectWallet} class="btn-primary w-full py-3 text-sm cursor-pointer font-semibold">
									Connect Wallet
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
							<p class="text-gray-400 text-xs font-mono mb-3">Soft cap reached. You can graduate early.</p>
							<button
								onclick={handleGraduate}
								disabled={isGraduating}
								class="btn-primary w-full py-2.5 text-sm cursor-pointer"
							>
								{isGraduating ? 'Graduating...' : 'Graduate to DEX'}
							</button>
						</div>
					{/if}
				{/if}

				<!-- Enable Refunds -->
				{#if launch.state === 1 && launch.totalBaseRaised < launch.softCap}
					{@const deadlineMs = Number(launch.deadline) * 1000}
					{#if Date.now() >= deadlineMs}
						<div class="card p-4 mb-4 border-red-500/20">
							<p class="text-red-300 text-xs font-mono mb-3">Deadline passed. Soft cap not reached.</p>
							<button
								onclick={handleEnableRefunds}
								class="btn-danger w-full py-2.5 text-sm cursor-pointer"
							>
								Enable Refunds
							</button>
						</div>
					{/if}
				{/if}

				<!-- User Position -->
				{#if userAddress && (userBasePaid > 0n || userTokensBought > 0n)}
					<div class="card p-6 mb-4">
						<h3 class="syne font-bold text-white mb-4">Your Position</h3>
						<div class="detail-grid">
							<div class="detail-row">
								<span class="detail-label">Tokens bought</span>
								<span class="detail-value">{formatTokens(userTokensBought, tokenMeta.decimals)} {launch.tokenSymbol}</span>
							</div>
							<div class="detail-row">
								<span class="detail-label">Total spent</span>
								<span class="detail-value">{formatUsdt(userBasePaid, ud)}</span>
							</div>
							{#if userTokensBought > 0n && userBasePaid > 0n}
								<div class="detail-row">
									<span class="detail-label">Avg price</span>
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
							<button
								onclick={handleRefund}
								disabled={isRefunding}
								class="btn-danger w-full py-2.5 text-sm mt-4 cursor-pointer"
							>
								{isRefunding ? 'Processing...' : `Refund ${formatUsdt(userBasePaid, ud)}`}
							</button>
							<p class="text-gray-600 text-[10px] font-mono mt-2">
								You must return all purchased tokens to get a refund (in USDT). Buy fee is non-refundable.
							</p>
						{/if}
					</div>
				{/if}

				<!-- Share -->
				<div class="card p-5 mb-4">
					<p class="text-gray-400 text-xs font-mono text-center mb-3">Share this launch</p>
					<div class="share-row">
						<a
							href={`https://x.com/intent/tweet?text=${encodeURIComponent(`Check out $${launch.tokenSymbol} on TokenCrafter!`)}&url=${encodeURIComponent(typeof window !== 'undefined' ? window.location.href : '')}`}
							target="_blank"
							rel="noopener"
							class="share-btn"
							title="Share on X"
						>𝕏</a>
						<a
							href={`https://t.me/share/url?url=${encodeURIComponent(typeof window !== 'undefined' ? window.location.href : '')}&text=${encodeURIComponent(`Check out $${launch.tokenSymbol} on TokenCrafter!`)}`}
							target="_blank"
							rel="noopener"
							class="share-btn"
							title="Share on Telegram"
						>✈</a>
						<button
							class="share-btn"
							title="Copy link"
							onclick={() => { if (typeof navigator !== 'undefined') { navigator.clipboard.writeText(window.location.href); addFeedback({ message: 'Link copied!', type: 'success' }); } }}
						>🔗</button>
					</div>
				</div>
			</div>
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
			top: 24px;
			max-height: calc(100vh - 48px);
			overflow-y: auto;
			scrollbar-width: thin;
			scrollbar-color: rgba(255, 255, 255, 0.1) transparent;
		}
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

	.progress-track {
		width: 100%;
		height: 8px;
		background: var(--bg-surface-hover);
		border-radius: 4px;
		overflow: hidden;
	}
	.progress-fill {
		height: 100%;
		border-radius: 4px;
		transition: width 0.3s ease;
	}
	.progress-cyan {
		background: linear-gradient(90deg, #00d2ff, #3a7bd5);
	}
	.progress-purple {
		background: linear-gradient(90deg, #8b5cf6, #a78bfa);
	}
	.progress-amber {
		background: linear-gradient(90deg, #f59e0b, #fbbf24);
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
		color: #6b7280;
		background: var(--bg-surface);
		border: 1px solid var(--bg-surface-hover);
		padding: 2px 10px;
		border-radius: 6px;
	}
	.header-tag {
		font-size: 11px;
		font-family: 'Space Mono', monospace;
		color: #4b5563;
		background: rgba(255, 255, 255, 0.03);
		border: 1px solid rgba(255, 255, 255, 0.06);
		padding: 2px 8px;
		border-radius: 4px;
	}
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
		color: #6b7280;
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
	.spinner-sm {
		width: 14px;
		height: 14px;
		border: 2px solid var(--border-input);
		border-top-color: #00d2ff;
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
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

	.badge {
		display: inline-flex;
		align-items: center;
		padding: 3px 10px;
		border-radius: 999px;
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.badge-cyan {
		background: rgba(0, 210, 255, 0.1);
		color: #00d2ff;
		border: 1px solid rgba(0, 210, 255, 0.2);
	}
	.badge-amber {
		background: rgba(245, 158, 11, 0.1);
		color: #f59e0b;
		border: 1px solid rgba(245, 158, 11, 0.2);
	}
	.badge-purple {
		background: rgba(139, 92, 246, 0.1);
		color: #a78bfa;
		border: 1px solid rgba(139, 92, 246, 0.2);
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
		color: #fff;
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
		color: #fff;
		font-family: 'Space Mono', monospace;
		line-height: 1;
	}
	.countdown-label {
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: #6b7280;
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
</style>
