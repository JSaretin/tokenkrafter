<script lang="ts">
	import { page } from '$app/state';
	import { chainSlug, type SupportedNetworks, type SupportedNetwork, type PaymentOption } from '$lib/structure';
	import { ethers } from 'ethers';
	import { getContext, onMount, onDestroy } from 'svelte';
	import { TOKEN_ABI, ROUTER_ABI, FACTORY_V2_ABI, PAIR_ABI, ERC20_ABI, FACTORY_ABI, ZERO_ADDRESS } from '$lib/tokenCrafter';
	import { LAUNCHPAD_FACTORY_ABI } from '$lib/launchpad';
	import { queryTradeLens, type TaxInfo } from '$lib/tradeLens';
	import { t } from '$lib/i18n';
	import { apiFetch } from '$lib/apiFetch';
	import { friendlyError } from '$lib/errorDecoder';
	import QrCode from '$lib/QrCode.svelte';
	import MintTab from './lib/MintTab.svelte';
	import BurnTab from './lib/BurnTab.svelte';
	import TaxTab from './lib/TaxTab.svelte';
	import PoolsTab from './lib/PoolsTab.svelte';
	import OverviewTab from './lib/OverviewTab.svelte';
	import ProtectionTab from './lib/ProtectionTab.svelte';
	import AboutTab from './lib/AboutTab.svelte';
	import ExistingPoolsList from './lib/ExistingPoolsList.svelte';
	import RegisterPoolForm from './lib/RegisterPoolForm.svelte';
	import NewPoolForm from './lib/NewPoolForm.svelte';

	let _getNetworks: () => SupportedNetworks = getContext('supportedNetworks');
	let supportedNetworks = $derived(_getNetworks());
	const addFeedback = getContext<(f: { message: string; type: string }) => void>('addFeedback');
	let getSigner: () => ethers.Signer | null = getContext('signer');
	let getUserAddress: () => string | null = getContext('userAddress');
	let connectWallet: () => Promise<boolean> = getContext('connectWallet');
	let getNetworkProviders: () => Map<number, ethers.JsonRpcProvider> = getContext('networkProviders');
	let getPaymentOptions: (network: SupportedNetwork) => PaymentOption[] = getContext('getPaymentOptions');

	let signer = $derived(getSigner());
	let userAddress = $derived(getUserAddress());

	let networkProviders = $derived(getNetworkProviders());

	// Fallback chain data so the page works without wallet connection
	const CHAIN_FALLBACK: Record<string, Partial<SupportedNetwork>> = {
		bsc: { name: 'BNB Smart Chain', symbol: 'bsc', chain_id: 56, native_coin: 'BNB', rpc: 'https://bsc-rpc.publicnode.com', usdt_address: '0x55d398326f99059fF775485246999027B3197955', usdc_address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', explorer_url: 'https://bscscan.com' },
		eth: { name: 'Ethereum', symbol: 'eth', chain_id: 1, native_coin: 'ETH', rpc: 'https://eth.llamarpc.com', usdt_address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', usdc_address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', explorer_url: 'https://etherscan.io' },
		base: { name: 'Base', symbol: 'base', chain_id: 8453, native_coin: 'ETH', rpc: 'https://mainnet.base.org', explorer_url: 'https://basescan.org' },
	};

	type ExtendedTokenInfo = {
		name: string;
		symbol: string;
		totalSupply: string;
		decimals: number;
		owner?: string;
		isMintable?: boolean;
		isTaxable?: boolean;
		isPartner?: boolean;
		buyTaxBps?: number;
		sellTaxBps?: number;
		transferTaxBps?: number;
		userBalance?: string;
		// Protection features
		tradingEnabled?: boolean;
		maxWalletAmount?: string;
		maxTransactionAmount?: string;
		cooldownTime?: number;
		blacklistWindow?: number;
		tradingEnabledAt?: number;
	};

	let tokenInfo: ExtendedTokenInfo | null = $state(null);
	let error: 'unsupported_network' | 'contract_error' | 'contract_not_found' | null = $state(null);
	let isLoading = $state(true);
	let network: SupportedNetwork | null = $state(null);
	let contractAddress = $state('');
	let activeTab = $state<'overview' | 'mint' | 'burn' | 'tax' | 'pools' | 'liquidity' | 'protection' | 'about'>('overview');
	let isOwner = $state(false);

	// Form states
	let mintAmount = $state('');
	let mintTo = $state('');
	let burnAmount = $state('');
	let buyTaxPctInput = $state('');
	let sellTaxPctInput = $state('');
	let transferTaxPctInput = $state('');
	let actionLoading = $state(false);

	// Tax distribution
	let taxWallets: { address: string; shareBps: string }[] = $state([]);
	let taxExemptAddr = $state('');
	let taxExemptValue = $state(true);

	// Pool management
	let poolAddressInput = $state('');
	let poolCheckAddr = $state('');
	let poolCheckResult: boolean | null = $state(null);

	// Token metadata (about)
	let metaLogoUrl = $state('');
	let metaLogoPreview = $state(''); // data URL for preview before upload
	let metaLogoFile: File | null = $state(null);
	let metaLogoUploading = $state(false);
	let metaLogoFileInput: HTMLInputElement | undefined = $state();
	let metaDescription = $state('');
	let metaWebsite = $state('');
	let metaTwitter = $state('');
	let metaTelegram = $state('');
	let metaLoading = $state(false);
	let metaSaving = $state(false);
	let metaLoaded = $state(false);

	// Supply formatting helper
	function fmtSupply(val: string | number): string {
		const n = typeof val === 'string' ? Number(val) : val;
		if (isNaN(n) || n === 0) return '0';
		if (n >= 1e12) return `${(n / 1e12).toFixed(1)}T`;
		if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
		if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
		if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
		return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
	}

	// Logo resize (same as BasicInfo — 256x256 max, skip GIF/SVG)
	const MAX_LOGO_SIZE = 256;
	const SKIP_RESIZE = ['image/gif', 'image/svg+xml'];
	function resizeImage(file: File): Promise<File> {
		return new Promise((resolve) => {
			if (SKIP_RESIZE.includes(file.type)) { resolve(file); return; }
			const img = new Image();
			img.onload = () => {
				if (img.width <= MAX_LOGO_SIZE && img.height <= MAX_LOGO_SIZE) { URL.revokeObjectURL(img.src); resolve(file); return; }
				const canvas = document.createElement('canvas');
				const scale = Math.min(MAX_LOGO_SIZE / img.width, MAX_LOGO_SIZE / img.height);
				canvas.width = Math.round(img.width * scale);
				canvas.height = Math.round(img.height * scale);
				const ctx = canvas.getContext('2d')!;
				ctx.imageSmoothingQuality = 'high';
				ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
				URL.revokeObjectURL(img.src);
				canvas.toBlob((blob) => {
					blob ? resolve(new File([blob], file.name, { type: file.type })) : resolve(file);
				}, file.type, 0.9);
			};
			img.onerror = () => resolve(file);
			img.src = URL.createObjectURL(file);
		});
	}

	async function handleMetaLogoUpload(e: Event) {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (!file) return;
		if (file.size > 2 * 1024 * 1024) { addFeedback({ message: 'Max 2 MB', type: 'error' }); return; }
		if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'].includes(file.type)) {
			addFeedback({ message: 'PNG, JPEG, WebP, GIF, or SVG only', type: 'error' }); return;
		}
		const processed = await resizeImage(file);
		metaLogoFile = processed;
		const reader = new FileReader();
		reader.onload = () => { metaLogoPreview = reader.result as string; };
		reader.readAsDataURL(processed);
	}

	async function uploadLogoFile(): Promise<string | null> {
		if (!metaLogoFile || !contractAddress) return null;
		metaLogoUploading = true;
		try {
			const chainId = network?.chain_id || 56;
			const form = new FormData();
			form.append('file', metaLogoFile);
			form.append('address', contractAddress.toLowerCase());
			form.append('chain_id', String(chainId));
			const res = await apiFetch('/api/token-metadata/upload', { method: 'POST', body: form });
			if (!res.ok) { const e = await res.json().catch(() => ({ message: 'Upload failed' })); throw new Error(e.message); }
			const data = await res.json();
			return data.logo_url || null;
		} catch (e: any) {
			addFeedback({ message: e.message || 'Logo upload failed', type: 'error' });
			return null;
		} finally { metaLogoUploading = false; }
	}

	async function loadMetadata() {
		if (metaLoaded || !contractAddress) return;
		metaLoading = true;
		try {
			const chainId = network?.chain_id || 56;
			const res = await fetch(`/api/token-metadata?address=${contractAddress.toLowerCase()}&chain_id=${chainId}`);
			if (res.ok) {
				const data = await res.json();
				if (data) {
					metaLogoUrl = data.logo_url || '';
					metaDescription = data.description || '';
					metaWebsite = data.website || '';
					metaTwitter = data.twitter || '';
					metaTelegram = data.telegram || '';
				}
			}
			metaLoaded = true;
		} catch {} finally { metaLoading = false; }
	}

	async function saveMetadata() {
		metaSaving = true;
		try {
			// Upload logo file first if pending
			if (metaLogoFile) {
				const url = await uploadLogoFile();
				if (url) {
					metaLogoUrl = url;
					metaLogoFile = null;
					metaLogoPreview = '';
				}
			}

			const chainId = network?.chain_id || 56;
			const res = await fetch('/api/token-metadata', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					address: contractAddress.toLowerCase(),
					chain_id: chainId,
					logo_url: metaLogoUrl || null,
					description: metaDescription || null,
					website: metaWebsite || null,
					twitter: metaTwitter || null,
					telegram: metaTelegram || null,
				}),
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({ message: 'Save failed' }));
				throw new Error(err.message || `HTTP ${res.status}`);
			}
			addFeedback({ message: 'Token info saved', type: 'success' });
		} catch (e: any) {
			addFeedback({ message: e.message || 'Failed to save', type: 'error' });
		} finally { metaSaving = false; }
	}

	// Protection features
	let maxWalletInput = $state('');
	let maxTxInput = $state('');
	let cooldownInput = $state('');
	let blacklistWindowInput = $state('');
	let blacklistAddrInput = $state('');
	let blacklistAction = $state(true);
	let excludeLimitsAddrInput = $state('');
	let excludeLimitsAction = $state(true);
	let blacklistCheckAddr = $state('');
	let blacklistCheckResult: boolean | null = $state(null);
	let excludedCheckAddr = $state('');
	let excludedCheckResult: boolean | null = $state(null);

	// Launchpad state
	let launchAddress: string | null = $state(null);
	let launchpadChecked = $state(false);

	// Token alias state
	let tokenAlias = $state('');
	let tokenAliasInput = $state('');
	let tokenAliasSaving = $state(false);
	let tokenAliasLoaded = $state(false);

	// Liquidity states
	let selectedRouter = $state('');

	// New pool creation states
	let newPoolBaseCoin = $state<'native' | 'usdt' | 'usdc'>('native');
	let newPoolMode = $state<'manual' | 'price'>('manual');
	let newPoolTokenAmount = $state('');
	let newPoolBaseAmount = $state('');
	let newPoolPricePerToken = $state('');
	let newPoolListBaseAmount = $state('');
	let showNewPool = $state(false);

	// Pool registration (platform-token addPool / addPoolByAddress surface).
	// Separate from the "add liquidity" flow above — this is about telling
	// the token contract "this address is one of my pools" so tax routing
	// + the pool-lock gate treat it correctly.
	let registerPoolBase = $state('');              // V2 base token address for addPool(base)
	let registerPoolByAddress = $state('');         // arbitrary pool address for addPoolByAddress
	let registerPoolLoading = $state(false);

	let newPoolCalculatedTokenAmount = $derived(() => {
		if (!newPoolPricePerToken || !newPoolListBaseAmount || Number(newPoolPricePerToken) <= 0) return '';
		return (Number(newPoolListBaseAmount) / Number(newPoolPricePerToken)).toFixed(6);
	});

	// Supply % allocated to liquidity (for new pool)
	let newPoolTokenPct = $derived(() => {
		if (!tokenInfo?.totalSupply) return 0;
		const amount = newPoolMode === 'price' ? Number(newPoolCalculatedTokenAmount()) : Number(newPoolTokenAmount);
		if (!amount || amount <= 0) return 0;
		return (amount / Number(tokenInfo.totalSupply)) * 100;
	});

	let newPoolSelectedBase = $derived(getBaseCoinOptions().find((b) => b.key === newPoolBaseCoin) ?? getBaseCoinOptions()[0]);

	// Existing pool lookup
	type ExistingPool = {
		baseSymbol: string;
		baseKey: string;
		pairAddress: string;
		reserve0: string;
		reserve1: string;
		token0: string;
		tokenReserve: number;
		baseReserve: number;
		pricePerToken: number;
		baseDecimals: number;
	};
	let existingPools: ExistingPool[] = $state([]);
	let poolsLoading = $state(false);
	let poolsLoaded = $state(false);

	// Per-pool add liquidity states
	let poolAddAmounts: Record<string, { baseAmount: string; tokenAmount: string; expanded: boolean }> = $state({});
	let poolAddLoading: Record<string, boolean> = $state({});

	// Per-pool remove liquidity states
	let poolRemoveLoading: Record<string, boolean> = $state({});
	let poolLpBalances: Record<string, bigint> = $state({});
	let poolRemovePct: Record<string, number> = $state({});

	// Deposit modal state
	let showDepositModal = $state(false);
	let depositInfo: {
		symbol: string;
		networkName: string;
		required: string;
		userBalance: string;
		deficit: string;
		decimals: number;
		isNative: boolean;
		// Callback to resume after deposit
		onResume: () => void;
	} | null = $state(null);
	let depositPollTimer: ReturnType<typeof setInterval> | null = null;
	let addressCopied = $state(false);

	// DEX router addresses
	const DEX_ROUTERS: Record<number, { name: string; address: string }[]> = {
		1: [{ name: 'Uniswap V2', address: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D' }],
		56: [{ name: 'PancakeSwap V2', address: '0x10ED43C718714eb63d5aA57B78B54704E256024E' }]
	};

	function getProvider(): ethers.JsonRpcProvider | null {
		if (!network) return null;
		return networkProviders.get(network.chain_id) ?? null;
	}

	function getBaseCoinOptions(): { key: string; symbol: string; address: string; decimals: number }[] {
		if (!network) return [];
		return [
			{ key: 'native', symbol: network.native_coin, address: ZERO_ADDRESS, decimals: 18 },
			{ key: 'usdt', symbol: 'USDT', address: network.usdt_address, decimals: network.chain_id === 56 ? 18 : 6 },
			{ key: 'usdc', symbol: 'USDC', address: network.usdc_address, decimals: network.chain_id === 56 ? 18 : 6 }
		];
	}


	async function checkLaunchpad() {
		if (!network || !contractAddress) return;
		try {
			if (!network.launchpad_address || network.launchpad_address === '0x') return;
			const provider = getProvider() ?? new ethers.JsonRpcProvider(network.rpc);
			const factory = new ethers.Contract(network.launchpad_address, LAUNCHPAD_FACTORY_ABI, provider);
			const addr: string = await factory.tokenToLaunch(contractAddress);
			if (addr && addr !== ZERO_ADDRESS) {
				launchAddress = addr;
			}
		} catch {}
		launchpadChecked = true;
	}

	async function loadToken() {
		const { chain_symbol, contract_addr } = page.params;
		contractAddress = contract_addr || '';

		if (!chain_symbol) { error = 'unsupported_network'; return; }
		if (!contract_addr) { error = 'contract_not_found'; return; }

		let net = supportedNetworks.find(
			(n) => n.symbol.toLowerCase() === chain_symbol.toLowerCase() || n.chain_id.toString() === chain_symbol
		);
		// Fallback to hardcoded chain data when wallet not connected
		if (!net) {
			const fb = CHAIN_FALLBACK[chain_symbol.toLowerCase()];
			if (fb) net = fb as SupportedNetwork;
		}
		if (!net) { error = 'unsupported_network'; return; }
		network = net;

		const provider = getProvider() ?? new ethers.JsonRpcProvider(net.rpc);
		try {
			const contract = new ethers.Contract(contract_addr, TOKEN_ABI, provider);
			const [name, symbol, decimals, totalSupply] = await Promise.all([
				contract.name(),
				contract.symbol(),
				contract.decimals(),
				contract.totalSupply()
			]);

			let owner: string | undefined;
			let buyTaxBps: number | undefined;
			let sellTaxBps: number | undefined;
			let transferTaxBps: number | undefined;
			let userBalance: string | undefined;

			try { owner = await contract.owner(); } catch {}
			try { buyTaxBps = Number(await contract.buyTaxBps()); } catch {}
			try { sellTaxBps = Number(await contract.sellTaxBps()); } catch {}
			try { transferTaxBps = Number(await contract.transferTaxBps()); } catch {}

			// Determine features from factory registry
			let isMintable: boolean | undefined;
			let isTaxable: boolean | undefined;
			let isPartner: boolean | undefined;
			try {
				const factory = new ethers.Contract(net.platform_address, FACTORY_ABI, provider);
				const info = await factory.tokenInfo(contract_addr);
				isMintable = info[1];
				isTaxable = info[2];
				isPartner = info[3];
			} catch {
				// Fallback: probe contract capabilities
				try { await contract.buyTaxBps.staticCall(); isTaxable = true; } catch { isTaxable = false; }
				isMintable = false;
				isPartner = false;
			}

			if (userAddress) {
				try {
					const bal = await contract.balanceOf(userAddress);
					userBalance = ethers.formatUnits(bal, ethers.toNumber(decimals));
				} catch {}
			}

			// Load protection features. New contracts replaced the
			// `tradingEnabled` boolean with a sentinel uint256 (`tradingStartTime`,
			// max value = not yet scheduled). We surface that as a derived
			// boolean here so the rest of the UI doesn't need to change.
			let tradingEnabled_: boolean | undefined;
			let maxWalletAmount_: string | undefined;
			let maxTransactionAmount_: string | undefined;
			let cooldownTime_: number | undefined;
			let blacklistWindow_: number | undefined;
			let tradingEnabledAt_: number | undefined;
			const dec = ethers.toNumber(decimals);

			try {
				const startTime: bigint = await contract.tradingStartTime();
				const SENTINEL = (1n << 256n) - 1n;
				tradingEnabled_ = startTime !== SENTINEL;
			} catch {}
			try { maxWalletAmount_ = ethers.formatUnits(await contract.maxWalletAmount(), dec); } catch {}
			try { maxTransactionAmount_ = ethers.formatUnits(await contract.maxTransactionAmount(), dec); } catch {}
			try { cooldownTime_ = Number(await contract.cooldownTime()); } catch {}
			try { blacklistWindow_ = Number(await contract.blacklistWindow()); } catch {}
			try { tradingEnabledAt_ = Number(await contract.tradingEnabledAt()); } catch {}

			tokenInfo = {
				name, symbol,
				decimals: dec,
				totalSupply: ethers.formatUnits(totalSupply, dec),
				owner, isMintable, isTaxable, isPartner, buyTaxBps, sellTaxBps, transferTaxBps, userBalance,
				tradingEnabled: tradingEnabled_,
				maxWalletAmount: maxWalletAmount_,
				maxTransactionAmount: maxTransactionAmount_,
				cooldownTime: cooldownTime_,
				blacklistWindow: blacklistWindow_,
				tradingEnabledAt: tradingEnabledAt_
			};

			isOwner = !!(owner && userAddress && owner.toLowerCase() === userAddress.toLowerCase());
			buyTaxPctInput = String((buyTaxBps ?? 0) / 100);
			sellTaxPctInput = String((sellTaxBps ?? 0) / 100);
			transferTaxPctInput = String((transferTaxBps ?? 0) / 100);
			if (userAddress) mintTo = userAddress;

			// Default router
			const routers = DEX_ROUTERS[net.chain_id];
			if (routers?.length) selectedRouter = routers[0].address;

		} catch (e) {
			error = 'contract_error';
			console.error('contract error', e);
		}
	}

	onMount(async () => {
		await loadToken();
		isLoading = false;
		checkLaunchpad();
		loadTokenAlias();
		loadMetadata(); // Load early so logo shows in header
		// Auto-load pools in background if router is set
		if (selectedRouter && !poolsLoaded) {
			lookupExistingPools();
		}
	});

	async function loadTokenAlias() {
		if (!contractAddress) return;
		try {
			const res = await fetch(`/api/token-alias?address=${encodeURIComponent(contractAddress)}`);
			const data = await res.json();
			if (data.alias) {
				tokenAlias = data.alias;
				tokenAliasInput = data.alias;
			}
		} catch {}
		tokenAliasLoaded = true;
	}

	async function saveTokenAlias() {
		if (!userAddress || !network || !contractAddress) return;
		const s = await ensureSigner();
		if (!s) return;

		tokenAliasSaving = true;
		try {
			const ts = Date.now();
			const origin = window.location.origin;
			const message = `Set token alias "${tokenAliasInput}" for ${contractAddress}\nOrigin: ${origin}\nTimestamp: ${ts}`;
			const signature = await s.signMessage(message);

			const res = await apiFetch('/api/token-alias', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					alias: tokenAliasInput,
					token_address: contractAddress,
					chain_id: network.chain_id,
					signature,
					signed_message: message
				})
			});

			if (res.ok) {
				const data = await res.json();
				tokenAlias = data.alias;
				addFeedback({ message: `Alias "${data.alias}" saved`, type: 'success' });
			} else {
				const err = await res.json().catch(() => ({ message: 'Failed to save alias' }));
				addFeedback({ message: err.message || 'Failed to save alias', type: 'error' });
			}
		} catch (e: any) {
			if (!e?.message?.includes('user rejected')) {
				addFeedback({ message: 'Failed to save alias', type: 'error' });
			}
		} finally {
			tokenAliasSaving = false;
		}
	}

	async function ensureSigner() {
		if (!signer || !userAddress) {
			const ok = await connectWallet();
			if (!ok) return null;
		}
		return signer;
	}

	async function doMint() {
		const s = await ensureSigner();
		if (!s || !network) return;
		actionLoading = true;
		try {
			const contract = new ethers.Contract(contractAddress, TOKEN_ABI, s);
			const amount = ethers.parseUnits(String(Number(mintAmount)), tokenInfo?.decimals ?? 18);
			const tx = await contract.mint(mintTo || userAddress, amount);
			addFeedback({ message: 'Minting...', type: 'info' });
			await tx.wait();
			addFeedback({ message: `Minted ${mintAmount} ${tokenInfo?.symbol}!`, type: 'success' });
			mintAmount = '';
			await loadToken();
		} catch (e: any) {
			addFeedback({ message: friendlyError(e), type: 'error' });
		} finally { actionLoading = false; }
	}

	async function doBurn() {
		const s = await ensureSigner();
		if (!s || !network) return;
		actionLoading = true;
		try {
			const contract = new ethers.Contract(contractAddress, TOKEN_ABI, s);
			const amount = ethers.parseUnits(String(Number(burnAmount)), tokenInfo?.decimals ?? 18);
			const tx = await contract.burn(amount);
			addFeedback({ message: 'Burning tokens...', type: 'info' });
			await tx.wait();
			addFeedback({ message: `Burned ${burnAmount} ${tokenInfo?.symbol}!`, type: 'success' });
			burnAmount = '';
			await loadToken();
		} catch (e: any) {
			addFeedback({ message: friendlyError(e), type: 'error' });
		} finally { actionLoading = false; }
	}

	async function doSetTaxes() {
		const s = await ensureSigner();
		if (!s) return;
		actionLoading = true;
		try {
			const contract = new ethers.Contract(contractAddress, TOKEN_ABI, s);
			const tx = await contract.setTaxes(
				Math.round(Number(buyTaxPctInput) * 100),
				Math.round(Number(sellTaxPctInput) * 100),
				Math.round(Number(transferTaxPctInput) * 100)
			);
			addFeedback({ message: 'Updating taxes...', type: 'info' });
			await tx.wait();
			addFeedback({ message: 'Tax rates updated!', type: 'success' });
			await loadToken();
		} catch (e: any) {
			addFeedback({ message: friendlyError(e), type: 'error' });
		} finally { actionLoading = false; }
	}

	async function doSetTaxDistribution() {
		const s = await ensureSigner();
		if (!s) return;
		actionLoading = true;
		try {
			const contract = new ethers.Contract(contractAddress, TOKEN_ABI, s);
			const wallets = taxWallets.map((w) => w.address);
			const shares = taxWallets.map((w) => Number(w.shareBps));
			const tx = await contract.setTaxDistribution(wallets, shares);
			addFeedback({ message: 'Updating tax distribution...', type: 'info' });
			await tx.wait();
			addFeedback({ message: 'Tax distribution updated!', type: 'success' });
		} catch (e: any) {
			addFeedback({ message: friendlyError(e), type: 'error' });
		} finally { actionLoading = false; }
	}

	async function doExcludeFromTax() {
		const s = await ensureSigner();
		if (!s || !taxExemptAddr) return;
		actionLoading = true;
		try {
			const contract = new ethers.Contract(contractAddress, TOKEN_ABI, s);
			const tx = await contract.excludeFromTax(taxExemptAddr, taxExemptValue);
			addFeedback({ message: 'Updating tax exemption...', type: 'info' });
			await tx.wait();
			addFeedback({ message: `Address ${taxExemptValue ? 'exempted from' : 'included in'} tax!`, type: 'success' });
			taxExemptAddr = '';
		} catch (e: any) {
			addFeedback({ message: friendlyError(e), type: 'error' });
		} finally { actionLoading = false; }
	}

	async function doAddPool() {
		const s = await ensureSigner();
		if (!s || !poolAddressInput) return;
		actionLoading = true;
		try {
			const contract = new ethers.Contract(contractAddress, TOKEN_ABI, s);
			const tx = await contract.addPool(poolAddressInput);
			addFeedback({ message: 'Adding pool...', type: 'info' });
			await tx.wait();
			addFeedback({ message: 'Pool added!', type: 'success' });
			poolAddressInput = '';
		} catch (e: any) {
			addFeedback({ message: friendlyError(e), type: 'error' });
		} finally { actionLoading = false; }
	}

	// removePool was removed from the contract — pools are one-way
	// registrations (prevents owners weaponizing the gate to selectively
	// block trading on pairs). doRemovePool deleted.

	async function doCheckPool() {
		if (!poolCheckAddr || !network) return;
		try {
			const provider = getProvider() ?? new ethers.JsonRpcProvider(network.rpc);
			const contract = new ethers.Contract(contractAddress, TOKEN_ABI, provider);
			// pools(addr) returns a struct { bool isPool }. Ethers v6 returns
			// bare scalar for single-field struct mappings.
			poolCheckResult = await contract.pools(poolCheckAddr);
		} catch (e: any) {
			addFeedback({ message: friendlyError(e), type: 'error' });
		}
	}

	function addTaxWallet() {
		taxWallets = [...taxWallets, { address: '', shareBps: '' }];
	}

	function removeTaxWallet(index: number) {
		taxWallets = taxWallets.filter((_, i) => i !== index);
	}

	async function lookupExistingPools() {
		if (!network || !selectedRouter) return;
		poolsLoading = true;
		existingPools = [];
		try {
			const provider = getProvider() ?? new ethers.JsonRpcProvider(network.rpc);
			const router = new ethers.Contract(selectedRouter, ROUTER_ABI, provider);
			const dexFactoryAddr = await router.factory();
			const wethAddr = await router.WETH();
			const dexFactory = new ethers.Contract(dexFactoryAddr, FACTORY_V2_ABI, provider);

			const baseCoins = getBaseCoinOptions();
			const results: ExistingPool[] = [];

			for (const base of baseCoins) {
				const baseAddr = base.address === ZERO_ADDRESS ? wethAddr : base.address;
				try {
					const pair = await dexFactory.getPair(contractAddress, baseAddr);
					if (pair && pair !== ZERO_ADDRESS) {
						const pairContract = new ethers.Contract(pair, PAIR_ABI, provider);
						const [reserves, token0] = await Promise.all([
							pairContract.getReserves(),
							pairContract.token0()
						]);
						const tokenDec = tokenInfo?.decimals ?? 18;
						const isToken0 = token0.toLowerCase() === contractAddress.toLowerCase();
						const tokenReserve = Number(ethers.formatUnits(reserves[isToken0 ? 0 : 1], tokenDec));
						const baseReserve = Number(ethers.formatUnits(reserves[isToken0 ? 1 : 0], base.decimals));
						const pricePerToken = tokenReserve > 0 ? baseReserve / tokenReserve : 0;

						results.push({
							baseSymbol: base.symbol,
							baseKey: base.key,
							pairAddress: pair,
							reserve0: ethers.formatUnits(reserves[0], isToken0 ? tokenDec : base.decimals),
							reserve1: ethers.formatUnits(reserves[1], isToken0 ? base.decimals : tokenDec),
							token0,
							tokenReserve,
							baseReserve,
							pricePerToken,
							baseDecimals: base.decimals
						});

						// Init per-pool add state
						if (!poolAddAmounts[pair]) {
							poolAddAmounts[pair] = { baseAmount: '', tokenAmount: '', expanded: false };
						}
					}
				} catch {}
			}
			existingPools = results;
			poolsLoaded = true;

			// Fetch LP token balances for each pool
			if (userAddress) {
				for (const pool of results) {
					try {
						const lpContract = new ethers.Contract(pool.pairAddress, [
							'function balanceOf(address) view returns (uint256)'
						], provider);
						poolLpBalances[pool.pairAddress] = await lpContract.balanceOf(userAddress);
					} catch { poolLpBalances[pool.pairAddress] = 0n; }
				}
			}
		} catch (e: any) {
			addFeedback({ message: 'Failed to lookup pools: ' + (friendlyError(e)), type: 'error' });
		} finally { poolsLoading = false; }
	}

	function isEmptyPool(pool: ExistingPool): boolean {
		return pool.tokenReserve === 0 && pool.baseReserve === 0;
	}

	function poolCalcTokenFromBase(pool: ExistingPool, baseAmount: string): string {
		if (!baseAmount || Number(baseAmount) <= 0 || pool.pricePerToken <= 0) return '';
		return (Number(baseAmount) / pool.pricePerToken).toFixed(6);
	}

	function poolCalcBaseFromToken(pool: ExistingPool, tokenAmount: string): string {
		if (!tokenAmount || Number(tokenAmount) <= 0) return '';
		return (Number(tokenAmount) * pool.pricePerToken).toFixed(6);
	}

	function poolTokenPct(pool: ExistingPool, tokenAmount: string): number {
		if (!tokenInfo?.totalSupply || !tokenAmount || Number(tokenAmount) <= 0) return 0;
		return (Number(tokenAmount) / Number(tokenInfo.totalSupply)) * 100;
	}

	function onPoolBaseInput(pool: ExistingPool) {
		const state = poolAddAmounts[pool.pairAddress];
		if (!state || isEmptyPool(pool)) return; // Don't auto-calc for empty pools
		state.tokenAmount = poolCalcTokenFromBase(pool, state.baseAmount);
	}

	function onPoolTokenInput(pool: ExistingPool) {
		const state = poolAddAmounts[pool.pairAddress];
		if (!state || isEmptyPool(pool)) return; // Don't auto-calc for empty pools
		state.baseAmount = poolCalcBaseFromToken(pool, state.tokenAmount);
	}

	async function checkBalances(
		tokenAmount: string,
		baseAmount: string,
		baseSymbol: string,
		baseKey: string,
		baseDecimals: number,
		baseAddress: string,
		onResume: () => void
	): Promise<boolean> {
		if (!userAddress || !network) return false;
		const provider = getProvider() ?? new ethers.JsonRpcProvider(network.rpc);

		// Check token balance
		const tokenContract = new ethers.Contract(contractAddress, TOKEN_ABI, provider);
		const tokenBal = await tokenContract.balanceOf(userAddress);
		const parsedTokenAmount = ethers.parseUnits(String(Number(tokenAmount)), tokenInfo?.decimals ?? 18);
		if (tokenBal < parsedTokenAmount) {
			const balFormatted = ethers.formatUnits(tokenBal, tokenInfo?.decimals ?? 18);
			const deficit = Number(tokenAmount) - Number(balFormatted);
			depositInfo = {
				symbol: tokenInfo?.symbol ?? 'TOKEN',
				networkName: network.name,
				required: tokenAmount,
				userBalance: Number(balFormatted).toFixed(4),
				deficit: deficit.toFixed(4),
				decimals: tokenInfo?.decimals ?? 18,
				isNative: false,
				onResume
			};
			showDepositModal = true;
			startDepositPoll(parsedTokenAmount, contractAddress, tokenInfo?.decimals ?? 18, false, onResume);
			return false;
		}

		// Check base balance
		const isNative = baseKey === 'native';
		let baseBal: bigint;
		const parsedBaseAmount = isNative
			? ethers.parseEther(String(Number(baseAmount)))
			: ethers.parseUnits(String(Number(baseAmount)), baseDecimals);

		if (isNative) {
			baseBal = await provider.getBalance(userAddress);
		} else {
			const baseContract = new ethers.Contract(baseAddress, ERC20_ABI, provider);
			baseBal = await baseContract.balanceOf(userAddress);
		}

		if (baseBal < parsedBaseAmount) {
			const balFormatted = isNative
				? ethers.formatEther(baseBal)
				: ethers.formatUnits(baseBal, baseDecimals);
			const deficit = Number(baseAmount) - Number(balFormatted);
			depositInfo = {
				symbol: baseSymbol,
				networkName: network.name,
				required: baseAmount,
				userBalance: Number(balFormatted).toFixed(4),
				deficit: deficit.toFixed(4),
				decimals: baseDecimals,
				isNative,
				onResume
			};
			showDepositModal = true;
			const checkAddr = isNative ? '' : baseAddress;
			startDepositPoll(parsedBaseAmount, checkAddr, baseDecimals, isNative, onResume);
			return false;
		}

		return true;
	}

	function startDepositPoll(requiredAmount: bigint, tokenAddr: string, decimals: number, isNative: boolean, onResume: () => void) {
		stopDepositPoll();
		depositPollTimer = setInterval(async () => {
			if (!userAddress || !network) return;
			try {
				const provider = getProvider() ?? new ethers.JsonRpcProvider(network.rpc);
				let bal: bigint;
				if (isNative) {
					bal = await provider.getBalance(userAddress);
				} else {
					const contract = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
					bal = await contract.balanceOf(userAddress);
				}
				if (bal >= requiredAmount) {
					stopDepositPoll();
					showDepositModal = false;
					depositInfo = null;
					addFeedback({ message: 'Deposit detected! Proceeding...', type: 'success' });
					onResume();
				} else if (depositInfo) {
					// Update displayed balance
					const balFormatted = isNative ? ethers.formatEther(bal) : ethers.formatUnits(bal, decimals);
					const deficit = Number(depositInfo.required) - Number(balFormatted);
					depositInfo.userBalance = Number(balFormatted).toFixed(4);
					depositInfo.deficit = deficit > 0 ? deficit.toFixed(4) : '0';
				}
			} catch {}
		}, 5000);
	}

	function stopDepositPoll() {
		if (depositPollTimer) {
			clearInterval(depositPollTimer);
			depositPollTimer = null;
		}
	}

	function closeDepositModal() {
		stopDepositPoll();
		showDepositModal = false;
		depositInfo = null;
	}

	async function copyAddress() {
		if (!userAddress) return;
		await navigator.clipboard.writeText(userAddress);
		addressCopied = true;
		setTimeout(() => { addressCopied = false; }, 2000);
	}

	onDestroy(() => {
		stopDepositPoll();
	});

	async function doAddToExistingPool(pool: ExistingPool) {
		const s = await ensureSigner();
		if (!s || !network || !selectedRouter) return;
		const state = poolAddAmounts[pool.pairAddress];
		if (!state?.tokenAmount || !state?.baseAmount) {
			addFeedback({ message: 'Please fill in amounts.', type: 'error' });
			return;
		}

		// Check balances before proceeding
		const baseOption = getBaseCoinOptions().find(b => b.symbol === pool.baseSymbol);
		const hasFunds = await checkBalances(
			state.tokenAmount,
			state.baseAmount,
			pool.baseSymbol,
			pool.baseKey,
			pool.baseDecimals,
			baseOption?.address ?? ZERO_ADDRESS,
			() => doAddToExistingPool(pool) // Retry after deposit
		);
		if (!hasFunds) return;

		poolAddLoading[pool.pairAddress] = true;

		try {
			const tokenContract = new ethers.Contract(contractAddress, TOKEN_ABI, s);
			const parsedTokenAmount = ethers.parseUnits(String(Number(state.tokenAmount)), tokenInfo?.decimals ?? 18);

			const allowance = await tokenContract.allowance(userAddress, selectedRouter);
			if (allowance < parsedTokenAmount) {
				addFeedback({ message: 'Approving tokens for router...', type: 'info' });
				const approveTx = await tokenContract.approve(selectedRouter, parsedTokenAmount);
				await approveTx.wait();
			}

			const router = new ethers.Contract(selectedRouter, ROUTER_ABI, s);
			const deadline = Math.floor(Date.now() / 1000) + 1200;

			if (pool.baseKey === 'native') {
				const ethAmount = ethers.parseEther(String(Number(state.baseAmount)));
				addFeedback({ message: 'Adding liquidity...', type: 'info' });
				const tx = await router.addLiquidityETH(
					contractAddress,
					parsedTokenAmount,
					parsedTokenAmount * 95n / 100n,
					ethAmount * 95n / 100n,
					userAddress,
					deadline,
					{ value: ethAmount }
				);
				await tx.wait();
			} else {
				const baseOption = getBaseCoinOptions().find(b => b.symbol === pool.baseSymbol);
				const parsedBaseAmount = ethers.parseUnits(String(Number(state.baseAmount)), pool.baseDecimals);
				const baseContract = new ethers.Contract(baseOption!.address, ERC20_ABI, s);
				const baseAllowance = await baseContract.allowance(userAddress, selectedRouter);
				if (baseAllowance < parsedBaseAmount) {
					addFeedback({ message: `Approving ${pool.baseSymbol}...`, type: 'info' });
					const approveTx = await baseContract.approve(selectedRouter, parsedBaseAmount);
					await approveTx.wait();
				}

				addFeedback({ message: 'Adding liquidity...', type: 'info' });
				const tx = await router.addLiquidity(
					contractAddress,
					baseOption!.address,
					parsedTokenAmount,
					parsedBaseAmount,
					parsedTokenAmount * 95n / 100n,
					parsedBaseAmount * 95n / 100n,
					userAddress,
					deadline
				);
				await tx.wait();
			}

			addFeedback({ message: 'Liquidity added successfully!', type: 'success' });
			state.tokenAmount = '';
			state.baseAmount = '';
			await lookupExistingPools(); // Refresh reserves
		} catch (e: any) {
			addFeedback({ message: friendlyError(e), type: 'error' });
		} finally { poolAddLoading[pool.pairAddress] = false; }
	}

	async function doRemoveLiquidity(pool: ExistingPool) {
		const s = await ensureSigner();
		if (!s || !network || !selectedRouter || !userAddress) return;

		const pct = poolRemovePct[pool.pairAddress] || 100;
		const lpBal = poolLpBalances[pool.pairAddress] || 0n;
		if (lpBal === 0n) {
			addFeedback({ message: 'No LP tokens to remove', type: 'error' });
			return;
		}

		const lpAmount = (lpBal * BigInt(pct)) / 100n;
		if (lpAmount === 0n) return;

		poolRemoveLoading[pool.pairAddress] = true;
		try {
			// Approve LP tokens to router
			const lpContract = new ethers.Contract(pool.pairAddress, [
				'function approve(address, uint256) returns (bool)',
				'function allowance(address, address) view returns (uint256)',
			], s);
			const allowance = await lpContract.allowance(userAddress, selectedRouter);
			if (allowance < lpAmount) {
				addFeedback({ message: 'Approving LP tokens...', type: 'info' });
				const approveTx = await lpContract.approve(selectedRouter, lpAmount);
				await approveTx.wait();
			}

			const router = new ethers.Contract(selectedRouter, [
				...ROUTER_ABI,
				'function removeLiquidityETHSupportingFeeOnTransferTokens(address token, uint256 liquidity, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) returns (uint256)',
			], s);
			const deadline = Math.floor(Date.now() / 1000) + 1200;
			const hasTax = tokenInfo?.isTaxable || tokenInfo?.isPartner;

			if (pool.baseKey === 'native') {
				addFeedback({ message: 'Removing liquidity...', type: 'info' });
				const tx = hasTax
					? await router.removeLiquidityETHSupportingFeeOnTransferTokens(
						contractAddress, lpAmount, 0, 0, userAddress, deadline
					)
					: await router.removeLiquidityETH(
						contractAddress, lpAmount, 0, 0, userAddress, deadline
					);
				await tx.wait();
			} else {
				const baseOption = getBaseCoinOptions().find(b => b.symbol === pool.baseSymbol);
				addFeedback({ message: 'Removing liquidity...', type: 'info' });
				const tx = await router.removeLiquidity(
					contractAddress,
					baseOption!.address,
					lpAmount,
					0, 0,
					userAddress,
					deadline
				);
				await tx.wait();
			}

			addFeedback({ message: `Removed ${pct}% liquidity from ${tokenInfo?.symbol}/${pool.baseSymbol}`, type: 'success' });
			poolRemovePct[pool.pairAddress] = 100;
			await lookupExistingPools();
		} catch (e: any) {
			addFeedback({ message: friendlyError(e), type: 'error' });
		} finally { poolRemoveLoading[pool.pairAddress] = false; }
	}

	async function doCreateNewPool() {
		const s = await ensureSigner();
		if (!s || !network || !selectedRouter) return;

		const tokenAmount = newPoolMode === 'price' ? newPoolCalculatedTokenAmount() : newPoolTokenAmount;
		const baseAmount = newPoolMode === 'price' ? newPoolListBaseAmount : newPoolBaseAmount;

		if (!tokenAmount || !baseAmount) {
			addFeedback({ message: 'Please fill in all amounts.', type: 'error' });
			return;
		}

		// Check balances before proceeding
		const hasFunds = await checkBalances(
			tokenAmount,
			baseAmount,
			newPoolSelectedBase.symbol,
			newPoolBaseCoin,
			newPoolSelectedBase.decimals,
			newPoolSelectedBase.address,
			() => doCreateNewPool() // Retry after deposit
		);
		if (!hasFunds) return;

		actionLoading = true;

		try {
			const tokenContract = new ethers.Contract(contractAddress, TOKEN_ABI, s);
			const parsedTokenAmount = ethers.parseUnits(String(Number(tokenAmount)), tokenInfo?.decimals ?? 18);

			const allowance = await tokenContract.allowance(userAddress, selectedRouter);
			if (allowance < parsedTokenAmount) {
				addFeedback({ message: 'Approving tokens for router...', type: 'info' });
				const approveTx = await tokenContract.approve(selectedRouter, parsedTokenAmount);
				await approveTx.wait();
			}

			const router = new ethers.Contract(selectedRouter, ROUTER_ABI, s);
			const deadline = Math.floor(Date.now() / 1000) + 1200;

			if (newPoolBaseCoin === 'native') {
				const ethAmount = ethers.parseEther(String(Number(baseAmount)));
				addFeedback({ message: 'Creating pool & adding liquidity...', type: 'info' });
				const tx = await router.addLiquidityETH(
					contractAddress,
					parsedTokenAmount,
					parsedTokenAmount * 95n / 100n,
					ethAmount * 95n / 100n,
					userAddress,
					deadline,
					{ value: ethAmount }
				);
				await tx.wait();
			} else {
				const baseInfo = newPoolSelectedBase;
				const parsedBaseAmount = ethers.parseUnits(String(Number(baseAmount)), baseInfo.decimals);

				const baseContract = new ethers.Contract(baseInfo.address, ERC20_ABI, s);
				const baseAllowance = await baseContract.allowance(userAddress, selectedRouter);
				if (baseAllowance < parsedBaseAmount) {
					addFeedback({ message: `Approving ${baseInfo.symbol}...`, type: 'info' });
					const approveTx = await baseContract.approve(selectedRouter, parsedBaseAmount);
					await approveTx.wait();
				}

				addFeedback({ message: 'Creating pool & adding liquidity...', type: 'info' });
				const tx = await router.addLiquidity(
					contractAddress,
					baseInfo.address,
					parsedTokenAmount,
					parsedBaseAmount,
					parsedTokenAmount * 95n / 100n,
					parsedBaseAmount * 95n / 100n,
					userAddress,
					deadline
				);
				await tx.wait();
			}

			addFeedback({ message: 'Pool created & liquidity added!', type: 'success' });
			newPoolTokenAmount = '';
			newPoolBaseAmount = '';
			newPoolPricePerToken = '';
			newPoolListBaseAmount = '';
			showNewPool = false;
			await lookupExistingPools(); // Refresh
		} catch (e: any) {
			addFeedback({ message: friendlyError(e), type: 'error' });
		} finally { actionLoading = false; }
	}

	// Register a V2-style pair as a pool via addPool(base). The token
	// contract resolves the pair address through its dexFactory internally,
	// so an owner can't mark an arbitrary wallet as a pool — it must be a
	// real V2 pair. Late additions carry no anti-snipe lock.
	async function doRegisterPoolByBase() {
		const s = await ensureSigner();
		if (!s) return;
		if (!registerPoolBase || !ethers.isAddress(registerPoolBase)) {
			addFeedback({ message: 'Enter a valid base token address', type: 'error' });
			return;
		}
		registerPoolLoading = true;
		try {
			const contract = new ethers.Contract(contractAddress, TOKEN_ABI, s);
			addFeedback({ message: 'Registering pool...', type: 'info' });
			const tx = await contract.addPool(registerPoolBase);
			await tx.wait();
			addFeedback({ message: 'Pool registered.', type: 'success' });
			registerPoolBase = '';
			await lookupExistingPools();
		} catch (e: any) {
			addFeedback({ message: friendlyError(e), type: 'error' });
		} finally {
			registerPoolLoading = false;
		}
	}

	// Register an arbitrary pool address (V3, Solidly fork, OTC settlement,
	// etc) via addPoolByAddress. Contract-side guard: only callable after
	// trading has already been opened, to prevent weaponizing the anti-snipe
	// lock against arbitrary wallets during the initial window.
	async function doAddPoolByAddress() {
		const s = await ensureSigner();
		if (!s) return;
		if (!registerPoolByAddress || !ethers.isAddress(registerPoolByAddress)) {
			addFeedback({ message: 'Enter a valid pool address', type: 'error' });
			return;
		}
		registerPoolLoading = true;
		try {
			const contract = new ethers.Contract(contractAddress, TOKEN_ABI, s);
			addFeedback({ message: 'Registering pool address...', type: 'info' });
			const tx = await contract.addPoolByAddress(registerPoolByAddress);
			await tx.wait();
			addFeedback({ message: 'Pool registered.', type: 'success' });
			registerPoolByAddress = '';
			await lookupExistingPools();
		} catch (e: any) {
			addFeedback({ message: friendlyError(e), type: 'error' });
		} finally {
			registerPoolLoading = false;
		}
	}

	// Protection action functions
	async function doEnableTrading() {
		const s = await ensureSigner();
		if (!s) return;
		actionLoading = true;
		try {
			const contract = new ethers.Contract(contractAddress, TOKEN_ABI, s);
			// Open trading immediately (0 delay). Anti-snipe windows are only
			// useful at the moment of first listing — by the time someone
			// reaches the manage-tokens page they're past that window.
			const tx = await contract.enableTrading(0);
			addFeedback({ message: 'Enabling trading...', type: 'info' });
			await tx.wait();
			addFeedback({ message: 'Trading enabled! Protections are now locked.', type: 'success' });
			await loadToken();
		} catch (e: any) {
			addFeedback({ message: friendlyError(e), type: 'error' });
		} finally { actionLoading = false; }
	}

	async function doSetMaxWallet() {
		const s = await ensureSigner();
		if (!s) return;
		actionLoading = true;
		try {
			const contract = new ethers.Contract(contractAddress, TOKEN_ABI, s);
			const amount = maxWalletInput ? ethers.parseUnits(String(Number(maxWalletInput)), tokenInfo?.decimals ?? 18) : 0n;
			const tx = await contract.setMaxWalletAmount(amount);
			addFeedback({ message: 'Setting max wallet...', type: 'info' });
			await tx.wait();
			addFeedback({ message: amount === 0n ? 'Max wallet disabled!' : 'Max wallet updated!', type: 'success' });
			await loadToken();
		} catch (e: any) {
			addFeedback({ message: friendlyError(e), type: 'error' });
		} finally { actionLoading = false; }
	}

	async function doSetMaxTx() {
		const s = await ensureSigner();
		if (!s) return;
		actionLoading = true;
		try {
			const contract = new ethers.Contract(contractAddress, TOKEN_ABI, s);
			const amount = maxTxInput ? ethers.parseUnits(String(Number(maxTxInput)), tokenInfo?.decimals ?? 18) : 0n;
			const tx = await contract.setMaxTransactionAmount(amount);
			addFeedback({ message: 'Setting max transaction...', type: 'info' });
			await tx.wait();
			addFeedback({ message: amount === 0n ? 'Max transaction disabled!' : 'Max transaction updated!', type: 'success' });
			await loadToken();
		} catch (e: any) {
			addFeedback({ message: friendlyError(e), type: 'error' });
		} finally { actionLoading = false; }
	}

	async function doSetCooldown() {
		const s = await ensureSigner();
		if (!s) return;
		actionLoading = true;
		try {
			const contract = new ethers.Contract(contractAddress, TOKEN_ABI, s);
			const seconds = cooldownInput ? Number(cooldownInput) : 0;
			const tx = await contract.setCooldownTime(seconds);
			addFeedback({ message: 'Setting cooldown...', type: 'info' });
			await tx.wait();
			addFeedback({ message: seconds === 0 ? 'Cooldown disabled!' : 'Cooldown updated!', type: 'success' });
			await loadToken();
		} catch (e: any) {
			addFeedback({ message: friendlyError(e), type: 'error' });
		} finally { actionLoading = false; }
	}

	async function doSetBlacklistWindow() {
		const s = await ensureSigner();
		if (!s) return;
		actionLoading = true;
		try {
			const contract = new ethers.Contract(contractAddress, TOKEN_ABI, s);
			const seconds = blacklistWindowInput ? Number(blacklistWindowInput) : 0;
			const tx = await contract.setBlacklistWindow(seconds);
			addFeedback({ message: 'Setting blacklist window...', type: 'info' });
			await tx.wait();
			addFeedback({ message: seconds === 0 ? 'Blacklist disabled!' : 'Blacklist window set!', type: 'success' });
			await loadToken();
		} catch (e: any) {
			addFeedback({ message: friendlyError(e), type: 'error' });
		} finally { actionLoading = false; }
	}

	async function doSetBlacklisted() {
		const s = await ensureSigner();
		if (!s || !blacklistAddrInput) return;
		actionLoading = true;
		try {
			const contract = new ethers.Contract(contractAddress, TOKEN_ABI, s);
			const tx = await contract.setBlacklisted(blacklistAddrInput, blacklistAction);
			addFeedback({ message: `${blacklistAction ? 'Blacklisting' : 'Unblacklisting'} address...`, type: 'info' });
			await tx.wait();
			addFeedback({ message: `Address ${blacklistAction ? 'blacklisted' : 'removed from blacklist'}!`, type: 'success' });
			blacklistAddrInput = '';
		} catch (e: any) {
			addFeedback({ message: friendlyError(e), type: 'error' });
		} finally { actionLoading = false; }
	}

	async function doSetExcludedFromLimits() {
		const s = await ensureSigner();
		if (!s || !excludeLimitsAddrInput) return;
		actionLoading = true;
		try {
			const contract = new ethers.Contract(contractAddress, TOKEN_ABI, s);
			const tx = await contract.setExcludedFromLimits(excludeLimitsAddrInput, excludeLimitsAction);
			addFeedback({ message: 'Updating limit exclusion...', type: 'info' });
			await tx.wait();
			addFeedback({ message: `Address ${excludeLimitsAction ? 'excluded from' : 'included in'} limits!`, type: 'success' });
			excludeLimitsAddrInput = '';
		} catch (e: any) {
			addFeedback({ message: friendlyError(e), type: 'error' });
		} finally { actionLoading = false; }
	}

	async function doCheckBlacklist() {
		if (!blacklistCheckAddr || !network) return;
		try {
			const provider = getProvider() ?? new ethers.JsonRpcProvider(network.rpc);
			const contract = new ethers.Contract(contractAddress, TOKEN_ABI, provider);
			blacklistCheckResult = await contract.blacklisted(blacklistCheckAddr);
		} catch (e: any) {
			addFeedback({ message: friendlyError(e), type: 'error' });
		}
	}

	async function doCheckExcluded() {
		if (!excludedCheckAddr || !network) return;
		try {
			const provider = getProvider() ?? new ethers.JsonRpcProvider(network.rpc);
			const contract = new ethers.Contract(contractAddress, TOKEN_ABI, provider);
			excludedCheckResult = await contract.isExcludedFromLimits(excludedCheckAddr);
		} catch (e: any) {
			addFeedback({ message: friendlyError(e), type: 'error' });
		}
	}

	function shortAddr(addr: string) {
		return addr.slice(0, 8) + '...' + addr.slice(-6);
	}

	const tabs = [
		{ id: 'overview', labelKey: 'mt.tabOverview', icon: 'O' },
		{ id: 'protection', labelKey: 'mt.tabProtection', icon: '#' },
		{ id: 'mint', labelKey: 'mt.tabMint', icon: '+', requires: 'mintable' as const },
		{ id: 'burn', labelKey: 'mt.tabBurn', icon: 'x', requires: 'mintable' as const },
		{ id: 'tax', labelKey: 'mt.tabTax', icon: '%', requires: 'taxable' as const },
		{ id: 'pools', labelKey: 'mt.tabPools', icon: '@', requires: 'pools' as const },
		{ id: 'liquidity', labelKey: 'mt.tabLiquidity', icon: '~' },
		{ id: 'about', labelKey: 'About', icon: 'i' }
	];

	function isTabVisible(tab: (typeof tabs)[0]) {
		if (tab.requires === 'mintable' && tokenInfo?.isMintable === false) return false;
		if (tab.requires === 'taxable' && tokenInfo?.isTaxable === false) return false;
		if (tab.requires === 'pools' && !tokenInfo?.isTaxable && !tokenInfo?.isPartner) return false;
		return true;
	}
</script>

<svelte:head>
	<title>Manage {tokenInfo?.name ?? 'Token'} | TokenKrafter</title>
	<meta name="description" content="Manage {tokenInfo?.name ?? 'your token'} ({tokenInfo?.symbol ?? ''}) — mint, burn, configure taxes, add DEX liquidity, and more on TokenKrafter." />
</svelte:head>

<div class="page-container max-w-6xl mx-auto px-4 sm:px-6 py-10">
	<a href="/manage-tokens" class="back-link">&larr; Back to Manage Tokens</a>

	{#if isLoading}
		<div class="flex items-center justify-center min-h-[50vh]">
			<div class="flex flex-col items-center gap-4">
				<div class="spinner w-12 h-12 rounded-full border-2 border-white/10 border-t-cyan-400"></div>
				<p class="text-gray-500 text-sm font-mono">{$t('mt.loadingToken')}</p>
			</div>
		</div>
	{:else if error}
		<div class="error-state text-center py-20">
			<div class="text-5xl mb-4">!</div>
			<h2 class="syne text-2xl font-bold text-white mb-2">
				{error === 'unsupported_network'
					? $t('mt.unsupportedNetwork')
					: error === 'contract_not_found'
						? $t('mt.contractNotFound')
						: $t('mt.contractError')}
			</h2>
			<p class="text-gray-400 font-mono text-sm mb-6">
				{error === 'unsupported_network'
					? $t('mt.unsupportedNetworkDesc')
					: error === 'contract_not_found'
						? $t('mt.contractNotFoundDesc')
						: $t('mt.contractErrorDesc')}
			</p>
			<a href="/manage-tokens" class="btn-secondary text-sm px-5 py-2.5 no-underline">&lt;- {$t('mt.back')}</a>
		</div>
	{:else if tokenInfo}
		<!-- Token Header -->
		<div class="token-header mb-8">
			<div class="flex items-start justify-between flex-wrap gap-4">
				<div class="flex items-center gap-4">
					{#if metaLogoUrl || metaLogoPreview}
						<img src={metaLogoPreview || metaLogoUrl} alt={tokenInfo.symbol} class="token-avatar-img" />
					{:else}
						<div class="token-avatar syne">
							{tokenInfo.symbol.slice(0, 2).toUpperCase()}
						</div>
					{/if}
					<div>
						<h1 class="syne text-2xl sm:text-3xl font-bold text-white">{tokenInfo.name}</h1>
						<div class="flex items-center gap-2 mt-1 flex-wrap">
							<span class="text-gray-400 font-mono text-sm">{tokenInfo.symbol}</span>
							<span class="text-gray-600">|</span>
							<span class="text-gray-400 font-mono text-xs">{network?.name}</span>
							{#if tokenInfo.isMintable}
								<span class="badge badge-cyan">{$t('mt.mintable')}</span>
							{/if}
							{#if tokenInfo.isTaxable}
								<span class="badge badge-amber">{$t('mt.taxable')}</span>
							{/if}
							{#if tokenInfo.isPartner}
								<span class="badge badge-purple">{$t('mt.partner')}</span>
							{/if}
							{#if isOwner}
								<span class="badge badge-emerald">{$t('mt.owner')}</span>
							{/if}
						</div>
					</div>
				</div>
				<a href="/manage-tokens" class="btn-secondary text-xs px-3 py-2 no-underline">&lt;- {$t('mt.back')}</a>
			</div>

			<div class="contract-addr-bar mt-4 font-mono">
				<span class="text-gray-500 text-xs">{$t('mt.contract')}:</span>
				<span class="text-cyan-400 text-xs ml-2">{contractAddress}</span>
			</div>
		</div>

		<!-- Stats Row -->
		<div class="stats-row mb-8 grid grid-cols-2 sm:grid-cols-4 gap-3">
			<div class="stat-card card p-4">
				<div class="stat-label">{$t('mt.totalSupply')}</div>
				<div class="stat-value rajdhani">{fmtSupply(tokenInfo.totalSupply)}</div>
				<div class="stat-unit">{tokenInfo.symbol}</div>
			</div>
			<div class="stat-card card p-4">
				<div class="stat-label">{$t('mt.decimals')}</div>
				<div class="stat-value rajdhani">{tokenInfo.decimals}</div>
				<div class="stat-unit">{$t('mt.precision')}</div>
			</div>
			{#if tokenInfo.userBalance !== undefined}
				<div class="stat-card card p-4">
					<div class="stat-label">{$t('mt.yourBalance')}</div>
					<div class="stat-value rajdhani">{fmtSupply(tokenInfo.userBalance)}</div>
					<div class="stat-unit">{tokenInfo.symbol}</div>
				</div>
			{/if}
			{#if tokenInfo.isTaxable && tokenInfo.buyTaxBps !== undefined}
				<div class="stat-card stat-card-tax card p-4">
					<div class="stat-label">Tax Rates</div>
					<div class="tax-rates-row">
						<div class="tax-rate-item">
							<span class="tax-rate-val rajdhani">{(tokenInfo.buyTaxBps / 100).toFixed(1)}%</span>
							<span class="tax-rate-type">Buy</span>
						</div>
						<span class="tax-rate-sep">/</span>
						<div class="tax-rate-item">
							<span class="tax-rate-val rajdhani">{((tokenInfo.sellTaxBps ?? 0) / 100).toFixed(1)}%</span>
							<span class="tax-rate-type">Sell</span>
						</div>
						<span class="tax-rate-sep">/</span>
						<div class="tax-rate-item">
							<span class="tax-rate-val rajdhani">{((tokenInfo.transferTaxBps ?? 0) / 100).toFixed(1)}%</span>
							<span class="tax-rate-type">Transfer</span>
						</div>
					</div>
				</div>
			{/if}
		</div>

		<!-- Tabs -->
		<div class="tabs-bar mb-6 flex gap-1 overflow-x-auto pb-1">
			{#each tabs.filter(isTabVisible) as tab}
				<button
					onclick={() => (activeTab = tab.id as typeof activeTab)}
					class="tab-btn font-mono {activeTab === tab.id ? 'active' : ''} cursor-pointer"
				>
					<span>{tab.icon}</span>
					<span>{$t(tab.labelKey)}</span>
				</button>
			{/each}
		</div>

		<!-- Tab Content -->
		<div class="tab-content">

			<!-- OVERVIEW TAB -->
			{#if activeTab === 'overview' && tokenInfo}
				<OverviewTab
					{tokenInfo}
					{network}
					{contractAddress}
					{launchpadChecked}
					{launchAddress}
					{isOwner}
					{tokenAliasLoaded}
					{tokenAlias}
					bind:tokenAliasInput
					{tokenAliasSaving}
					onSaveTokenAlias={saveTokenAlias}
				/>
			{/if}

			<!-- MINT TAB -->
			{#if activeTab === 'mint'}
				<MintTab
					bind:mintAmount
					bind:mintTo
					{isOwner}
					{actionLoading}
					tokenSymbol={tokenInfo.symbol}
					{userAddress}
					onMint={doMint}
				/>
			{/if}

			<!-- BURN TAB -->
			{#if activeTab === 'burn'}
				<BurnTab
					bind:burnAmount
					{actionLoading}
					tokenSymbol={tokenInfo.symbol}
					userBalance={tokenInfo.userBalance}
					onBurn={doBurn}
				/>
			{/if}

			<!-- TAX TAB -->
			{#if activeTab === 'tax' && tokenInfo}
				<TaxTab
					bind:buyTaxPctInput
					bind:sellTaxPctInput
					bind:transferTaxPctInput
					bind:taxExemptAddr
					bind:taxExemptValue
					bind:taxWallets
					{isOwner}
					{actionLoading}
					{tokenInfo}
					onSetTaxes={doSetTaxes}
					onSetTaxDistribution={doSetTaxDistribution}
					onExcludeFromTax={doExcludeFromTax}
					onAddTaxWallet={addTaxWallet}
					onRemoveTaxWallet={removeTaxWallet}
				/>
			{/if}

			<!-- POOLS TAB -->
			{#if activeTab === 'pools'}
				<PoolsTab
					bind:poolAddressInput
					bind:poolCheckAddr
					{poolCheckResult}
					{isOwner}
					{actionLoading}
					onAddPool={doAddPool}
					onCheckPool={doCheckPool}
				/>
			{/if}

			<!-- LIQUIDITY TAB -->
			{#if activeTab === 'protection' && tokenInfo}
				<ProtectionTab
					{tokenInfo}
					{isOwner}
					{actionLoading}
					bind:maxWalletInput
					bind:maxTxInput
					bind:cooldownInput
					bind:blacklistWindowInput
					bind:blacklistAddrInput
					bind:blacklistAction
					bind:blacklistCheckAddr
					{blacklistCheckResult}
					bind:excludeLimitsAddrInput
					bind:excludeLimitsAction
					bind:excludedCheckAddr
					{excludedCheckResult}
					onEnableTrading={doEnableTrading}
					onSetMaxWallet={doSetMaxWallet}
					onSetMaxTx={doSetMaxTx}
					onSetCooldown={doSetCooldown}
					onSetBlacklistWindow={doSetBlacklistWindow}
					onSetBlacklisted={doSetBlacklisted}
					onSetExcludedFromLimits={doSetExcludedFromLimits}
					onCheckBlacklist={doCheckBlacklist}
					onCheckExcluded={doCheckExcluded}
				/>
			{/if}

			{#if activeTab === 'liquidity' && tokenInfo}
				<div class="panel">
					<div class="panel-header">
						<div>
							<h3 class="syne text-lg font-bold text-white">{$t('mt.liquidity')}</h3>
							<p class="text-sm text-gray-500 font-mono mt-1">{$t('mt.liquidityDesc')}</p>
						</div>
						<span class="badge badge-purple">{$t('mt.dex')}</span>
					</div>

					<div class="form-fields">
						<ExistingPoolsList
							bind:selectedRouter
							dexRouters={DEX_ROUTERS[network?.chain_id ?? 1] ?? []}
							{existingPools}
							{poolsLoading}
							bind:poolsLoaded
							bind:poolAddAmounts
							{poolAddLoading}
							{poolLpBalances}
							bind:poolRemovePct
							{poolRemoveLoading}
							tokenSymbol={tokenInfo.symbol}
							tokenTotalSupply={tokenInfo.totalSupply}
							{userAddress}
							onLookupPools={lookupExistingPools}
							onSelectedRouterChange={() => { poolsLoaded = false; existingPools = []; }}
							{onPoolBaseInput}
							{onPoolTokenInput}
							onAddToExistingPool={doAddToExistingPool}
							onRemoveLiquidity={doRemoveLiquidity}
						/>

						{#if isOwner}
							<RegisterPoolForm
								bind:registerPoolBase
								bind:registerPoolByAddress
								{registerPoolLoading}
								onRegisterByBase={doRegisterPoolByBase}
								onRegisterByAddress={doAddPoolByAddress}
							/>
						{/if}

						<NewPoolForm
							bind:showNewPool
							bind:newPoolBaseCoin
							bind:newPoolMode
							bind:newPoolTokenAmount
							bind:newPoolBaseAmount
							bind:newPoolPricePerToken
							bind:newPoolListBaseAmount
							baseCoinOptions={getBaseCoinOptions()}
							selectedBase={newPoolSelectedBase}
							calculatedTokenAmount={newPoolCalculatedTokenAmount()}
							tokenPct={newPoolTokenPct()}
							tokenSymbol={tokenInfo.symbol}
							{userAddress}
							{actionLoading}
							onCreateNewPool={doCreateNewPool}
						/>
					</div>
				</div>
			{/if}

			<!-- ═══ About Tab ═══ -->
			{#if activeTab === 'about'}
				<AboutTab
					{metaLoaded}
					{metaLoading}
					{metaSaving}
					{metaLogoUploading}
					{metaLogoPreview}
					{metaLogoUrl}
					{metaLogoFile}
					bind:metaDescription
					bind:metaWebsite
					bind:metaTwitter
					bind:metaTelegram
					onLoadMetadata={loadMetadata}
					onLogoFileChosen={handleMetaLogoUpload}
					onSaveMetadata={saveMetadata}
				/>
			{/if}
		</div>
	{/if}
</div>

<!-- Deposit Modal -->
{#if showDepositModal && depositInfo}
	<div
		class="fixed inset-0 z-[80] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
		onclick={closeDepositModal}
	>
		<div
			class="deposit-modal w-full max-w-md rounded-2xl border shadow-2xl overflow-hidden" style="border-color: var(--border-input); background: var(--bg)"
			onclick={(e) => e.stopPropagation()}
		>
			<!-- Header -->
			<div class="deposit-modal-header">
				<div class="flex items-center gap-3">
					<div class="deposit-icon-circle">
						<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M12 2v20M2 12h20"/>
						</svg>
					</div>
					<div>
						<h2 class="syne text-lg font-bold text-white">{$t('mt.depositRequired')}</h2>
						<p class="text-gray-500 text-[11px] font-mono">{depositInfo.networkName} Network</p>
					</div>
				</div>
				<button onclick={closeDepositModal} class="deposit-close-btn cursor-pointer">
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<path d="M18 6L6 18M6 6l12 12"/>
					</svg>
				</button>
			</div>

			<!-- Amount Summary -->
			<div class="deposit-amount-section">
				<div class="deposit-amount-row">
					<span class="text-gray-500 text-xs font-mono">{$t('mt.required')}</span>
					<span class="text-white text-sm font-mono font-bold">{Number(depositInfo.required).toLocaleString()} {depositInfo.symbol}</span>
				</div>
				<div class="deposit-amount-row">
					<span class="text-gray-500 text-xs font-mono">{$t('mt.yourBalance')}</span>
					<span class="text-gray-300 text-sm font-mono">{Number(depositInfo.userBalance).toLocaleString()} {depositInfo.symbol}</span>
				</div>
				<div class="deposit-divider"></div>
				<div class="deposit-amount-row">
					<span class="text-amber-400 text-xs font-mono font-bold">{$t('mt.amountToDeposit')}</span>
					<span class="text-amber-300 text-lg font-mono font-bold">{Number(depositInfo.deficit).toLocaleString()} {depositInfo.symbol}</span>
				</div>
			</div>

			<!-- QR Code -->
			<div class="deposit-qr-section">
				<div class="deposit-qr-frame">
					<QrCode data={userAddress || ''} width={200} colorDark="#00d2ff" colorLight="#0d0d14" alt="Deposit address" />
				</div>
			</div>

			<!-- Address -->
			<div class="deposit-address-section">
				<label class="text-gray-500 text-[10px] font-mono uppercase tracking-wider">{$t('mt.depositAddress')}</label>
				<div class="deposit-address-row">
					<span class="text-cyan-400 text-xs font-mono break-all flex-1">{userAddress}</span>
					<button onclick={copyAddress} class="deposit-copy-btn cursor-pointer">
						{addressCopied ? $t('mt.copied') : $t('mt.copy')}
					</button>
				</div>
			</div>

			<!-- Warning -->
			<div class="deposit-warning">
				<svg class="flex-shrink-0 mt-0.5" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
					<line x1="12" y1="9" x2="12" y2="13"/>
					<line x1="12" y1="17" x2="12.01" y2="17"/>
				</svg>
				<span class="text-gray-400 text-[11px] font-mono">
					{$t('mt.depositWarning1')} <strong class="text-white">{depositInfo.symbol}</strong> {$t('mt.depositWarning2')} <strong class="text-white">{depositInfo.networkName}</strong>. {$t('mt.depositWarningEnd')}
				</span>
			</div>

			<!-- Footer -->
			<div class="deposit-footer">
				<div class="flex items-center gap-2">
					<div class="spinner-sm w-3.5 h-3.5 rounded-full border-2 border-white/10 border-t-cyan-400"></div>
					<span class="text-gray-500 text-[11px] font-mono">{$t('mt.monitoringDeposit')}</span>
				</div>
				<button onclick={closeDepositModal} class="btn-secondary text-xs px-4 py-2 cursor-pointer">{$t('common.cancel')}</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.back-link {
		display: inline-block; margin-bottom: 1.5rem;
		font-family: 'Space Mono', monospace; font-size: 12px;
		color: var(--text-dim); text-decoration: none; transition: color 0.15s;
	}
	.back-link:hover { color: #00d2ff; }

	.spinner { animation: spin 0.8s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }

	.syne { font-family: 'Syne', sans-serif; }
	.rajdhani { font-family: 'Rajdhani', sans-serif; font-variant-numeric: tabular-nums; }

	.token-avatar {
		width: 60px; height: 60px;
		border-radius: 16px;
		background: linear-gradient(135deg, rgba(0,210,255,0.2), rgba(99,102,241,0.2));
		border: 1px solid var(--border-input);
		display: flex; align-items: center; justify-content: center;
		font-size: 20px; font-weight: 800; color: var(--text-heading);
		flex-shrink: 0;
	}

	.contract-addr-bar {
		padding: 10px 14px;
		background: var(--bg-surface);
		border: 1px solid var(--bg-surface-hover);
		border-radius: 8px;
		overflow-x: auto;
		white-space: nowrap;
	}

	.stat-card {
		background: var(--bg-surface);
		border: 1px solid var(--border);
		border-radius: 12px;
	}
	.stat-label { font-size: 11px; color: var(--text-dim); font-family: 'Space Mono', monospace; text-transform: uppercase; letter-spacing: 0.05em; }
	.stat-value { font-size: 22px; font-weight: 700; color: var(--text-heading); margin: 4px 0 2px; font-family: 'Rajdhani', sans-serif; font-variant-numeric: tabular-nums; }
	.stat-unit { font-size: 11px; color: var(--text-dim); font-family: 'Space Mono', monospace; }

	/* Tax rates in stat card */
	.stat-card-tax { grid-column: span 1; }
	.tax-rates-row { display: flex; align-items: center; gap: 4px; margin: 4px 0 2px; flex-wrap: wrap; }
	.tax-rate-item { display: flex; flex-direction: column; align-items: center; gap: 0; min-width: 0; }
	.tax-rate-val { font-size: 14px; font-weight: 700; color: var(--text-heading); line-height: 1.2; font-family: 'Rajdhani', sans-serif; font-variant-numeric: tabular-nums; }
	.tax-rate-type { font-size: 8px; color: var(--text-dim); font-family: 'Space Mono', monospace; text-transform: uppercase; letter-spacing: 0.04em; }
	.tax-rate-sep { color: var(--text-dim); font-size: 12px; margin-top: -4px; }
	@media (min-width: 640px) {
		.tax-rate-val { font-size: 20px; }
		.tax-rate-type { font-size: 9px; }
		.tax-rate-sep { font-size: 16px; }
		.tax-rates-row { gap: 6px; }
	}

	/* Token avatar (logo) */
	.token-avatar-img {
		width: 60px; height: 60px;
		border-radius: 16px;
		object-fit: cover;
		border: 1px solid var(--border-input);
		flex-shrink: 0;
	}

	/* About section logo upload */
	:global(.about-form) { display: flex; flex-direction: column; gap: 14px; }
	:global(.about-logo-section) { display: flex; flex-direction: column; gap: 8px; }
	:global(.about-logo-row) { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
	:global(.about-logo-preview-wrap) { position: relative; }
	:global(.about-logo-img) { width: 72px; height: 72px; border-radius: 14px; object-fit: cover; border: 2px solid var(--border-input); }
	:global(.about-logo-change) {
		position: absolute; bottom: -4px; right: -4px;
		display: flex; align-items: center; gap: 4px;
		padding: 3px 8px; border-radius: 6px;
		background: var(--bg-surface-hover); border: 1px solid var(--border-input);
		color: #00d2ff; font-size: 10px; font-family: 'Space Mono', monospace;
		cursor: pointer; transition: all 0.15s;
	}
	:global(.about-logo-change:hover) { background: rgba(0,210,255,0.1); border-color: rgba(0,210,255,0.3); }
	:global(.about-logo-upload) {
		display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
		width: 140px; height: 100px;
		border: 2px dashed var(--border-input); border-radius: 14px;
		background: var(--bg-surface); color: var(--text-dim);
		cursor: pointer; transition: all 0.2s;
		font-family: 'Space Mono', monospace; font-size: 11px;
	}
	:global(.about-logo-upload:hover) { border-color: rgba(0,210,255,0.3); color: #00d2ff; background: rgba(0,210,255,0.04); }
	:global(.about-logo-hint) { font-size: 9px; color: var(--text-dim); }
	:global(.about-logo-pending) { font-size: 10px; color: #10b981; font-family: 'Space Mono', monospace; }
	:global(.hidden-file) { display: none; }

	/* Liquidity empty state */
	:global(.liq-empty-state) {
		display: flex; flex-direction: column; align-items: center; gap: 6px;
		padding: 24px 16px; text-align: center;
	}

	.tabs-bar {
		border-bottom: 1px solid var(--bg-surface-hover);
		padding-bottom: 0;
	}

	.tab-btn {
		display: flex; align-items: center; gap: 6px;
		padding: 8px 16px;
		border-radius: 8px 8px 0 0;
		font-size: 13px;
		color: var(--text-dim);
		background: transparent;
		border: none;
		border-bottom: 2px solid transparent;
		transition: all 0.15s;
		white-space: nowrap;
		margin-bottom: -1px;
	}
	.tab-btn:hover { color: var(--text); }
	.tab-btn.active {
		color: #00d2ff;
		border-bottom-color: #00d2ff;
		background: rgba(0,210,255,0.05);
	}

	/* Shared tab styles — :global() so they apply inside child components
	   (TaxTab, PoolsTab, OverviewTab, etc.) which Svelte's scoped CSS
	   would otherwise block. */
	:global(.panel) {
		background: var(--bg-surface);
		border: 1px solid var(--border);
		border-radius: 16px;
		padding: 24px;
	}

	:global(.sub-panel) {
		background: var(--bg-surface);
		border: 1px solid var(--bg-surface-hover);
		border-radius: 12px;
		padding: 16px;
	}

	:global(.panel-header) {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		margin-bottom: 20px;
		gap: 12px;
		flex-wrap: wrap;
	}

	:global(.form-fields) { display: flex; flex-direction: column; gap: 16px; }

	:global(.field-group) { display: flex; flex-direction: column; gap: 6px; }

	:global(.input-with-badge) { position: relative; }
	:global(.input-with-badge .input-field) { padding-right: 72px; }
	:global(.input-badge) {
		position: absolute;
		right: 12px;
		top: 50%;
		transform: translateY(-50%);
		font-size: 11px;
		font-family: 'Space Mono', monospace;
		color: var(--text-dim);
		background: var(--bg-surface-hover);
		padding: 2px 8px;
		border-radius: 4px;
	}

	:global(.field-hint) { font-size: 11px; color: var(--text-dim); font-family: 'Space Mono', monospace; }
	:global(.field-hint-btn) {
		font-size: 11px;
		color: #00d2ff;
		background: none;
		border: none;
		padding: 0;
		text-decoration: underline;
		opacity: 0.7;
		transition: opacity 0.15s;
		align-self: flex-start;
	}
	:global(.field-hint-btn:hover) { opacity: 1; }

	:global(.info-table) { display: flex; flex-direction: column; gap: 0; }
	:global(.info-row) {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 10px 0;
		border-bottom: 1px solid var(--bg-surface-hover);
		gap: 12px;
	}
	:global(.info-row:last-child) { border-bottom: none; }
	:global(.info-key) { font-size: 12px; color: var(--text-dim); font-family: 'Space Mono', monospace; flex-shrink: 0; }
	:global(.info-val) { font-size: 13px; color: var(--text); text-align: right; word-break: break-all; }

	:global(.owner-warning) {
		display: flex; align-items: center;
		gap: 8px;
		padding: 10px 14px;
		background: rgba(245,158,11,0.06);
		border: 1px solid rgba(245,158,11,0.15);
		border-radius: 8px;
		margin-bottom: 4px;
	}

	:global(.burn-warning) {
		display: flex; align-items: flex-start; gap: 8px;
		padding: 10px 14px;
		background: rgba(239,68,68,0.05);
		border: 1px solid rgba(239,68,68,0.15);
		border-radius: 8px;
	}

	:global(.mode-toggle) {
		display: flex;
		gap: 0;
		border: 1px solid var(--border-input);
		border-radius: 10px;
		overflow: hidden;
	}
	:global(.mode-btn) {
		flex: 1;
		padding: 10px 16px;
		font-size: 13px;
		font-family: 'Space Mono', monospace;
		color: var(--text-dim);
		background: transparent;
		border: none;
		transition: all 0.15s;
	}
	:global(.mode-btn.active) {
		color: #00d2ff;
		background: rgba(0,210,255,0.08);
	}
	:global(.mode-btn:hover:not(.active)) { color: var(--text); background: var(--bg-surface); }

	:global(.calc-result) {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 12px 14px;
		background: rgba(0,210,255,0.05);
		border: 1px solid rgba(0,210,255,0.15);
		border-radius: 8px;
	}

	:global(.pool-row) {
		padding: 10px 12px;
		background: var(--bg-surface);
		border: 1px solid var(--bg-surface-hover);
		border-radius: 8px;
	}

	:global(.pool-card) {
		border: 1px solid var(--border);
		border-radius: 12px;
		overflow: hidden;
		transition: border-color 0.2s;
	}
	:global(.pool-card:hover) {
		border-color: rgba(139,92,246,0.25);
	}

	:global(.pool-card-header) {
		display: flex;
		justify-content: space-between;
		align-items: center;
		width: 100%;
		padding: 14px 16px;
		background: var(--bg-surface);
		border: none;
		color: inherit;
		gap: 12px;
	}
	:global(.pool-card-header:hover) {
		background: var(--bg-surface-hover);
	}

	:global(.pool-pair-badge) {
		font-size: 11px;
		font-weight: 700;
		padding: 4px 10px;
		border-radius: 6px;
		background: rgba(139,92,246,0.15);
		color: #a78bfa;
		white-space: nowrap;
	}

	:global(.pool-expand-icon) {
		color: var(--text-dim);
		font-size: 14px;
		transition: transform 0.2s;
	}
	:global(.pool-expand-icon.expanded) {
		transform: rotate(180deg);
	}

	:global(.pool-card-body) {
		display: flex;
		flex-direction: column;
		gap: 14px;
		padding: 16px;
		border-top: 1px solid var(--bg-surface-hover);
		background: var(--bg-surface);
	}

	:global(.empty-pool-hint) {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 10px 14px;
		background: rgba(245,158,11,0.06);
		border: 1px solid rgba(245,158,11,0.15);
		border-radius: 8px;
	}

	:global(.liq-pct-bar) {
		padding: 10px 0;
	}
	:global(.pct-track) {
		height: 4px;
		background: var(--bg-surface-hover);
		border-radius: 999px;
		overflow: hidden;
	}
	:global(.pct-fill) {
		height: 100%;
		background: linear-gradient(90deg, #10b981, #00d2ff);
		border-radius: 999px;
		transition: width 0.3s;
	}

	:global(.liq-info-box) {
		padding: 14px;
		background: rgba(139,92,246,0.05);
		border: 1px solid rgba(139,92,246,0.15);
		border-radius: 10px;
		display: flex; flex-direction: column; gap: 8px;
	}
	:global(.liq-info-row) { display: flex; justify-content: space-between; align-items: center; }

	:global(.action-btn) {
		padding: 14px;
		width: 100%;
		font-weight: 700;
		font-size: 14px;
		border: none;
		border-radius: 12px;
		transition: all 0.2s;
		margin-top: 4px;
		cursor: pointer;
		font-family: 'Syne', sans-serif;
	}
	:global(.action-btn:disabled) { opacity: 0.4; cursor: not-allowed; transform: none !important; }

	:global(.mint-btn) {
		background: linear-gradient(135deg, #00d2ff, #3a7bd5);
		color: white;
	}
	:global(.mint-btn:hover:not(:disabled)) {
		transform: translateY(-1px);
		box-shadow: 0 8px 28px rgba(0,210,255,0.3);
	}

	:global(.burn-btn) {
		background: linear-gradient(135deg, #ef4444, #b91c1c);
		color: white;
	}
	:global(.burn-btn:hover:not(:disabled)) {
		transform: translateY(-1px);
		box-shadow: 0 8px 28px rgba(239,68,68,0.3);
	}

	:global(.tax-btn) {
		background: linear-gradient(135deg, #f59e0b, #d97706);
		color: white;
	}
	:global(.tax-btn:hover:not(:disabled)) {
		transform: translateY(-1px);
		box-shadow: 0 8px 28px rgba(245,158,11,0.3);
	}

	/* Remove liquidity */
	:global(.remove-liq-section) {
		margin-top: 14px; padding-top: 14px;
		border-top: 1px solid var(--bg-surface-hover);
	}
	:global(.remove-liq-header) { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
	:global(.remove-liq-label) { font-size: 12px; font-weight: 600; color: #f87171; font-family: 'Space Mono', monospace; }
	:global(.remove-liq-bal) { font-size: 10px; color: var(--text-dim); font-family: 'Space Mono', monospace; }
	:global(.remove-liq-pct-row) { display: flex; gap: 6px; margin-bottom: 10px; }
	:global(.remove-liq-pct-btn) {
		flex: 1; padding: 6px; border-radius: 6px;
		border: 1px solid var(--border); background: var(--bg-surface);
		color: var(--text-muted); font-family: 'Space Mono', monospace; font-size: 11px;
		cursor: pointer; transition: all 0.15s;
	}
	:global(.remove-liq-pct-btn:hover) { border-color: rgba(248,113,113,0.3); color: #f87171; }
	:global(.remove-liq-pct-btn.active) { border-color: rgba(248,113,113,0.4); background: rgba(248,113,113,0.08); color: #f87171; }

	:global(.liq-btn) {
		background: linear-gradient(135deg, #8b5cf6, #6d28d9);
		color: white;
	}
	:global(.liq-btn:hover:not(:disabled)) {
		transform: translateY(-1px);
		box-shadow: 0 8px 28px rgba(139,92,246,0.3);
	}

	:global(.badge) { display: inline-flex; align-items: center; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; font-family: 'Space Mono', monospace; }
	:global(.badge-cyan) { background: rgba(0,210,255,0.1); color: #00d2ff; border: 1px solid rgba(0,210,255,0.2); }
	:global(.badge-amber) { background: rgba(245,158,11,0.1); color: #f59e0b; border: 1px solid rgba(245,158,11,0.2); }
	:global(.badge-emerald) { background: rgba(16,185,129,0.1); color: #10b981; border: 1px solid rgba(16,185,129,0.2); }
	:global(.badge-purple) { background: rgba(139,92,246,0.1); color: #8b5cf6; border: 1px solid rgba(139,92,246,0.2); }

	:global(.label-text) { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); display: block; margin-bottom: 6px; font-family: 'Space Mono', monospace; }

	.no-underline { text-decoration: none; }
	a.no-underline { text-decoration: none; }

	:global(select option) { background: var(--select-bg); }

	:global(.input-field) {
		width: 100%;
		background: var(--bg-surface-hover);
		border: 1px solid var(--border-input);
		border-radius: 10px;
		padding: 12px 16px;
		color: var(--text);
		font-family: 'Space Mono', monospace;
		font-size: 14px;
		transition: all 0.2s;
		outline: none;
	}
	:global(.input-field:focus) {
		border-color: rgba(0,210,255,0.5);
		box-shadow: 0 0 0 3px rgba(0,210,255,0.08);
	}
	:global(.input-field:disabled) { opacity: 0.4; cursor: not-allowed; }
	:global(.input-field::placeholder) { color: var(--placeholder); }

	:global(.protection-notice) {
		padding: 12px 14px;
		background: rgba(0,210,255,0.05);
		border: 1px solid rgba(0,210,255,0.15);
		border-radius: 10px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	:global(.protection-notice.relax-only) {
		background: rgba(16,185,129,0.05);
		border-color: rgba(16,185,129,0.15);
	}

	:global(.protection-stat-row) {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 6px 0;
		border-bottom: 1px solid var(--bg-surface);
	}
	:global(.protection-stat-row:last-child) { border-bottom: none; }

	:global(.trading-enable-box) {
		background: rgba(245,158,11,0.05);
		border-color: rgba(245,158,11,0.2);
	}

	/* Deposit Modal */
	.deposit-modal {
		animation: modalSlideIn 0.25s ease-out;
	}
	@keyframes modalSlideIn {
		from { opacity: 0; transform: scale(0.95) translateY(10px); }
		to { opacity: 1; transform: scale(1) translateY(0); }
	}

	.deposit-modal-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 20px 24px;
		border-bottom: 1px solid var(--bg-surface-hover);
	}

	.deposit-icon-circle {
		width: 40px;
		height: 40px;
		border-radius: 12px;
		background: rgba(245,158,11,0.15);
		color: #f59e0b;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}

	.deposit-close-btn {
		width: 32px;
		height: 32px;
		border-radius: 8px;
		border: none;
		background: var(--bg-surface-hover);
		color: var(--text-dim);
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.15s;
	}
	.deposit-close-btn:hover {
		background: var(--border-input);
		color: var(--text-heading);
	}

	.deposit-amount-section {
		padding: 20px 24px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.deposit-amount-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.deposit-divider {
		border: none;
		border-top: 1px dashed var(--border);
		margin: 4px 0;
	}

	.deposit-qr-section {
		display: flex;
		justify-content: center;
		padding: 0 24px 20px;
	}

	.deposit-qr-frame {
		padding: 12px;
		background: var(--bg-surface);
		border: 1px solid var(--border);
		border-radius: 16px;
	}

	.deposit-qr-img {
		width: 180px;
		height: 180px;
		border-radius: 8px;
	}

	.deposit-address-section {
		padding: 0 24px 16px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.deposit-address-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 12px;
		background: var(--bg-surface);
		border: 1px solid var(--border);
		border-radius: 10px;
	}

	.deposit-copy-btn {
		padding: 4px 12px;
		border-radius: 6px;
		border: 1px solid rgba(0,210,255,0.3);
		background: rgba(0,210,255,0.08);
		color: #00d2ff;
		font-size: 11px;
		font-family: 'Space Mono', monospace;
		font-weight: 600;
		transition: all 0.15s;
		white-space: nowrap;
		flex-shrink: 0;
	}
	.deposit-copy-btn:hover {
		background: rgba(0,210,255,0.15);
		border-color: rgba(0,210,255,0.5);
	}

	.deposit-warning {
		display: flex;
		gap: 8px;
		margin: 0 24px 16px;
		padding: 10px 14px;
		background: rgba(245,158,11,0.06);
		border: 1px solid rgba(245,158,11,0.15);
		border-radius: 10px;
		color: #f59e0b;
	}

	.deposit-footer {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 16px 24px;
		border-top: 1px solid var(--bg-surface-hover);
		background: var(--bg-surface);
	}

	.spinner-sm { animation: spin 0.8s linear infinite; }

	/* Launchpad section */
	:global(.launchpad-status) {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 14px 16px;
		border-radius: 10px;
		background: var(--bg-surface-input);
		border: 1px solid var(--border);
	}
	:global(.launchpad-exists) {
		border-color: rgba(16, 185, 129, 0.2);
		background: rgba(16, 185, 129, 0.04);
	}
	:global(.launchpad-create) {
		border-style: dashed;
		border-color: rgba(0, 210, 255, 0.2);
	}
	.nav-cta {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		background: linear-gradient(135deg, #00d2ff, #3a7bd5);
		color: white;
		font-weight: 600;
		padding: 6px 14px;
		border-radius: 8px;
		border: none;
		cursor: pointer;
		transition: all 0.2s;
		font-family: 'Syne', sans-serif;
		font-size: 13px;
	}
	.nav-cta:hover {
		transform: translateY(-1px);
		box-shadow: 0 4px 16px rgba(0, 210, 255, 0.3);
	}
</style>
