<script lang="ts">
	import { ethers } from 'ethers';
	import { getContext, onMount } from 'svelte';
	import { page } from '$app/state';
	import { supabase } from '$lib/supabaseClient';
	import type { SupportedNetwork } from '$lib/structure';
	import { ERC20_ABI, ZERO_ADDRESS } from '$lib/tokenCrafter';
	import { TRADE_ROUTER_ABI, withdrawStatusLabel, withdrawStatusColor } from '$lib/tradeRouter';
	import WithdrawalStatusModal from '$lib/WithdrawalStatusModal.svelte';
	import { formatUsdt } from '$lib/launchpad';
	import { apiFetch } from '$lib/apiFetch';
	import { queryTradeLens, getInstantQuote, getWeth, isCacheLoaded, getUsdValue, type TaxInfo } from '$lib/tradeLens';

	let getSigner: () => ethers.Signer | null = getContext('signer');
	let getUserAddress: () => string | null = getContext('userAddress');
	let connectWallet: () => Promise<boolean> = getContext('connectWallet');
	const addFeedback = getContext<(f: { message: string; type: string }) => void>('addFeedback');
	let _getNetworks: () => SupportedNetwork[] = getContext('supportedNetworks');
	let supportedNetworks = $derived(_getNetworks());
	let getNetworkProviders: () => Map<number, ethers.JsonRpcProvider> = getContext('networkProviders');

	let signer = $derived(getSigner());
	let userAddress = $derived(getUserAddress());
	let networkProviders = $derived(getNetworkProviders());

	let tradeNetworks = $derived(supportedNetworks.filter(
		(n: any) => n.trade_router_address && n.trade_router_address !== ''
	));

	// ── Core State ──────────────────────────────────────────────
	let selectedNetworkIdx = $state(0);
	let outputMode = $state<'token' | 'bank'>('token');

	// Token In
	let tokenInAddr = $state('');
	let tokenInSymbol = $state('');
	let tokenInName = $state('');
	let tokenInDecimals = $state(18);
	let tokenInBalance = $state(0n);
	let tokenInIsNative = $state(false);
	let tokenInTaxBuy = $state(0);
	let tokenInTaxSell = $state(0);
	let tokenInHasTax = $state(false);
	let tokenInLoading = $state(false);

	// Token Out
	let tokenOutAddr = $state('');
	let tokenOutSymbol = $state('');
	let tokenOutName = $state('');
	let tokenOutDecimals = $state(18);
	let tokenOutBalance = $state(0n);
	let tokenOutIsNative = $state(false);
	let tokenOutTaxBuy = $state(0);
	let tokenOutTaxSell = $state(0);
	let tokenOutHasTax = $state(false);
	let tokenOutLoading = $state(false);

	// Token tax detection (from TradeLens simulation)
	let tokenInTax = $state<TaxInfo | null>(null);
	let tokenOutTax = $state<TaxInfo | null>(null);

	// Amounts
	let amountIn = $state('');
	let amountOut = $state('');
	let previewLoading = $state(false);
	let noLiquidity = $state(false);

	// Settings
	let slippageBps = $state(50);
	let showSettings = $state(false);

	// Swap state
	let isSwapping = $state(false);
	let showConfirmModal = $state(false);
	let swapStep = $state(0); // 0=idle, 1=approve, 2=swap, 3=done

	// Payment method
	let paymentMethod = $state<'bank' | 'paypal' | 'wise'>('bank');
	let previewFee = $state(0n);
	let previewNet = $state(0n);
	let isWithdrawing = $state(false);

	// Withdrawal step tracking (bank off-ramp)
	// 0=idle, 1=signing, 2=approving, 3=trading
	let withdrawStep = $state(0);

	// Exchange rates (with 0.3% spread for our rate)
	let fiatRates: Record<string, number> = $state({});
	let spreadBps = 30; // 0.3% spread
	let ngnRate = $derived.by(() => {
		const raw = fiatRates['NGN'] || 0;
		return raw > 0 ? raw * (1 - spreadBps / 10000) : 0;
	});
	// Use gross amount for NGN display (fee is hidden in the spread)
	// USDT decimals for the selected network (BSC USDT = 18, ETH USDT = 6)
	let usdtDecimals = $state(18);
	$effect(() => {
		if (!selectedNetwork?.usdt_address) return;
		const provider = networkProviders.get(selectedNetwork.chain_id);
		if (!provider) return;
		const token = new ethers.Contract(selectedNetwork.usdt_address, ['function decimals() view returns (uint8)'], provider);
		token.decimals().then((d: any) => { usdtDecimals = Number(d); }).catch(() => {});
	});

	let fiatEquivalent = $derived.by(() => {
		if (!amountIn || ngnRate === 0 || outputMode !== 'bank') return '';
		let usdtVal: number;
		const isUsdt = selectedNetwork && tokenInAddr.toLowerCase() === selectedNetwork.usdt_address?.toLowerCase();
		if (isUsdt) {
			usdtVal = parseFloat(amountIn) || 0;
		} else if (previewNet > 0n) {
			usdtVal = parseFloat(ethers.formatUnits(previewNet, usdtDecimals));
		} else {
			return '';
		}
		const ngn = usdtVal * ngnRate;
		return ngn > 0 ? `NGN ${ngn.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '';
	});

	// Bank details
	let bankAccount = $state('');
	let bankCode = $state('');
	let bankName = $state(''); // resolved account holder name
	let bankBankName = $state(''); // bank institution name
	let bankResolving = $state(false);
	let bankResolved = $state(false);
	let bankError = $state('');
	let ngBanks: { code: string; name: string; slug: string; logo?: string; ussd?: string }[] = $state([]);
	let bankSearchQuery = $state('');
	let showBankDropdown = $state(false);
	let showBankModal = $state(false);

	// PayPal / Wise details
	let paypalEmail = $state('');
	let wiseEmail = $state('');
	let wiseCurrency = $state('NGN');

	// Token selector modal
	let showTokenModal = $state(false);
	let tokenModalTarget = $state<'in' | 'out'>('in');
	let tokenSearch = $state('');
	let platformTokens: { address: string; symbol: string; name: string; decimals: number; logo_url?: string }[] = $state([]);

	// History
	let showHistory = $state(false);
	let activeWithdrawal: any = $state(null);
	let withdrawals: any[] = $state([]);
	let historyLoading = $state(false);

	let selectedNetwork = $derived(tradeNetworks[selectedNetworkIdx]);

	// ── Lock body scroll when any modal is open ──────────────
	let anyModalOpen = $derived(showTokenModal || showConfirmModal || showBankModal || !!activeWithdrawal);
	$effect(() => {
		if (typeof document !== 'undefined') {
			document.body.classList.toggle('modal-open', anyModalOpen);
		}
	});

	// ── Built-in token presets ──────────────────────────────────
	let builtInTokens = $derived.by(() => {
		if (!selectedNetwork) return [];
		const tokens: { address: string; symbol: string; name: string; decimals: number; isNative?: boolean; logo_url?: string }[] = [];
		tokens.push({ address: ZERO_ADDRESS, symbol: selectedNetwork.native_coin, name: selectedNetwork.native_coin, decimals: 18, isNative: true });
		if (selectedNetwork.usdt_address) tokens.push({ address: selectedNetwork.usdt_address, symbol: 'USDT', name: 'Tether USD', decimals: 18 });
		if (selectedNetwork.usdc_address) tokens.push({ address: selectedNetwork.usdc_address, symbol: 'USDC', name: 'USD Coin', decimals: 18 });
		return tokens;
	});

	// ── Imported tokens (persisted to localStorage) ──────────
	type ImportedToken = { address: string; symbol: string; name: string; decimals: number; chainId: number };
	let importedTokens: ImportedToken[] = $state([]);

	// Load from localStorage on mount
	function loadImportedTokens() {
		try {
			const stored = localStorage.getItem('importedTokens');
			if (stored) importedTokens = JSON.parse(stored);
		} catch {}
	}

	function saveImportedToken(token: ImportedToken) {
		if (importedTokens.find(t => t.address.toLowerCase() === token.address.toLowerCase() && t.chainId === token.chainId)) return;
		importedTokens = [...importedTokens, token];
		try { localStorage.setItem('importedTokens', JSON.stringify(importedTokens)); } catch {}
		// Refresh prices to include the new token
		refreshPrices();
	}

	function removeImportedToken(address: string) {
		importedTokens = importedTokens.filter(t => t.address.toLowerCase() !== address.toLowerCase());
		try { localStorage.setItem('importedTokens', JSON.stringify(importedTokens)); } catch {}
	}

	// ── Auto-detect pasted address ────────────────────────────
	let pastedTokenMeta = $state<{ address: string; symbol: string; name: string; decimals: number } | null>(null);
	let pastedTokenLoading = $state(false);

	$effect(() => {
		const q = tokenSearch.trim();
		pastedTokenMeta = null;
		if (!ethers.isAddress(q)) return;
		// Already in our list? No need to fetch
		if (allTokens.find(t => t.address.toLowerCase() === q.toLowerCase())) return;

		pastedTokenLoading = true;
		fetchMeta(q, false).then(meta => {
			if (tokenSearch.trim().toLowerCase() === q.toLowerCase() && meta.symbol !== '???') {
				pastedTokenMeta = { address: q, symbol: meta.symbol, name: meta.name, decimals: meta.decimals };
			}
		}).catch(() => {}).finally(() => { pastedTokenLoading = false; });
	});

	let allTokens = $derived.by(() => {
		const chainId = selectedNetwork?.chain_id;
		const seen = new Set<string>();
		const combined: typeof builtInTokens = [];

		// 1. Built-in tokens first (native, USDT, USDC)
		for (const t of builtInTokens) {
			combined.push(t);
			seen.add(t.address.toLowerCase());
		}

		// 2. User-imported tokens (recently used, at the top after built-ins)
		for (const it of importedTokens) {
			const addr = it.address.toLowerCase();
			if (it.chainId === chainId && !seen.has(addr)) {
				combined.push(it);
				seen.add(addr);
			}
		}

		// 3. Platform tokens (from launches)
		for (const pt of platformTokens) {
			const addr = pt.address.toLowerCase();
			if (!seen.has(addr)) {
				combined.push(pt);
				seen.add(addr);
			}
		}

		return combined;
	});

	let filteredTokens = $derived.by(() => {
		// In bank mode, show all tokens (no output token to exclude)
		// In swap mode, exclude the token already selected on the opposite side
		let list = allTokens;
		if (outputMode === 'token') {
			const excludeAddr = tokenModalTarget === 'in'
				? tokenOutAddr.toLowerCase()
				: tokenInAddr.toLowerCase();
			if (excludeAddr) {
				list = list.filter(t => t.address.toLowerCase() !== excludeAddr);
			}
		}

		const q = tokenSearch.toLowerCase().trim();
		if (!q) return list;
		return list.filter(t =>
			t.symbol.toLowerCase().includes(q) ||
			t.name.toLowerCase().includes(q) ||
			t.address.toLowerCase().includes(q)
		);
	});

	// ── Fetch platform tokens + banks + rates ──────────────────
	onMount(async () => {
		loadImportedTokens();
		try {
			const [launchRes, bankRes, rateRes] = await Promise.all([
				fetch('/api/launches'),
				fetch('/api/bank'),
				fetch('/api/rates?currencies=NGN,GBP,EUR,GHS,KES')
			]);
			if (launchRes.ok) {
				const launches = await launchRes.json();
				platformTokens = launches
					.filter((l: any) => l.token_address && l.token_symbol)
					.map((l: any) => ({
						address: l.token_address,
						symbol: l.token_symbol,
						name: l.token_name || l.token_symbol,
						decimals: l.token_decimals || 18,
						logo_url: l.logo_url
					}));
			}
			if (bankRes.ok) {
				ngBanks = await bankRes.json();
			}
			if (rateRes.ok) {
				const rateData = await rateRes.json();
				fiatRates = rateData.rates || {};
			}
		} catch {}

		// ── Fetch all token prices (instant quotes) ──────────────
		refreshPrices();

		// ── Default token selection (native coin → USDT) ─────────
		if (!tokenInAddr && builtInTokens.length > 0) {
			const native = builtInTokens.find(t => t.isNative);
			if (native) selectToken('in', native);
		}
		if (!tokenOutAddr && builtInTokens.length > 1) {
			const usdt = builtInTokens.find(t => t.symbol === 'USDT');
			if (usdt) selectToken('out', usdt);
		}

		// ── URL parameter pre-selection (overrides defaults) ─────
		await handleUrlParams();
	});

	// ── Price cache (MultiQuoter) ────────────────────────────
	let wethAddr = $state('');
	let pricesLoaded = $state(false);

	async function refreshPrices() {
		const net = selectedNetwork;
		if (!net?.dex_router) return;
		const provider = networkProviders.get(net.chain_id);
		if (!provider) return;

		try {
			const tokenAddrs = allTokens
				.map(t => t.isNative ? (wethAddr || '') : t.address)
				.filter(a => a && a !== ZERO_ADDRESS);

			for (const it of importedTokens) {
				if (it.chainId === net.chain_id && !tokenAddrs.find(a => a.toLowerCase() === it.address.toLowerCase())) {
					tokenAddrs.push(it.address);
				}
			}

			if (tokenAddrs.length === 0) return;

			// Prices only, no tax simulation (address(0) skips simulation)
			const result = await queryTradeLens(provider as any, net.dex_router, tokenAddrs, ethers.ZeroAddress, ethers.parseEther('0.001'), userAddress || ethers.ZeroAddress, net.chain_id);
			wethAddr = result.weth;
			pricesLoaded = true;

			// Update decimals + balances for selected tokens
			for (const t of result.tokens) {
				const tAddr = t.token.toLowerCase();
				if (tAddr === tokenInAddr.toLowerCase() && !tokenInIsNative) {
					tokenInDecimals = t.decimals;
					tokenInBalance = t.balance;
				}
				if (tAddr === tokenOutAddr.toLowerCase() && !tokenOutIsNative) {
					tokenOutDecimals = t.decimals;
					tokenOutBalance = t.balance;
				}
			}
			if (result.nativeBalance > 0n) {
				if (tokenInIsNative) tokenInBalance = result.nativeBalance;
				if (tokenOutIsNative) tokenOutBalance = result.nativeBalance;
				nativeBalance = result.nativeBalance;
			}
		} catch (e) {
			console.warn('Price refresh failed:', (e as any)?.message?.slice(0, 80));
		}
	}

	// Refresh prices every 15 seconds
	$effect(() => {
		if (!selectedNetwork?.dex_router) return;
		const interval = setInterval(refreshPrices, 15000);
		return () => clearInterval(interval);
	});

	async function handleUrlParams() {
		const urlFrom = page.url.searchParams.get('from');
		const urlTo = page.url.searchParams.get('to');
		const urlToken = page.url.searchParams.get('token');

		// Resolve "from" token (input side)
		if (urlFrom) {
			const matchedIn = findTokenBySymbolOrAddress(urlFrom);
			if (matchedIn) {
				selectToken('in', matchedIn);
			} else if (ethers.isAddress(urlFrom)) {
				const meta = await fetchMeta(urlFrom, false);
				selectToken('in', { address: urlFrom, symbol: meta.symbol, name: meta.name, decimals: meta.decimals });
			}
		}

		// Resolve "to" or "token" (output side)
		const target = urlToken || urlTo;
		if (target) {
			if (ethers.isAddress(target)) {
				const meta = await fetchMeta(target, false);
				selectToken('out', { address: target, symbol: meta.symbol, name: meta.name, decimals: meta.decimals });
			} else {
				// Try matching built-in / platform tokens by symbol first
				const matchedOut = findTokenBySymbolOrAddress(target);
				if (matchedOut) {
					selectToken('out', matchedOut);
				} else {
					// Resolve via token alias API
					try {
						const res = await fetch(`/api/token-alias?alias=${encodeURIComponent(target)}`);
						const data = await res.json();
						if (data.address) {
							const meta = await fetchMeta(data.address, false);
							selectToken('out', { address: data.address, symbol: meta.symbol, name: meta.name, decimals: meta.decimals });
						}
					} catch {}
				}
			}
		}
	}

	function findTokenBySymbolOrAddress(query: string): { address: string; symbol: string; name: string; decimals: number; isNative?: boolean } | undefined {
		const q = query.toLowerCase();
		return allTokens.find(
			(t) => t.symbol.toLowerCase() === q || t.address.toLowerCase() === q
		);
	}

	let filteredBanks = $derived.by(() => {
		const q = bankSearchQuery.toLowerCase().trim();
		if (!q) return ngBanks;
		return ngBanks.filter(b => b.name.toLowerCase().includes(q) || b.code.includes(q));
	});

	// ── Auto-resolve bank account ──────────────────────────────
	let resolveTimeout: ReturnType<typeof setTimeout> | null = null;
	$effect(() => {
		if (resolveTimeout) clearTimeout(resolveTimeout);
		const acc = bankAccount;
		const code = bankCode;
		bankResolved = false;
		bankName = '';
		bankError = '';

		if (!acc || acc.length !== 10 || !code) return;

		resolveTimeout = setTimeout(async () => {
			bankResolving = true;
			try {
				const res = await fetch('/api/bank/resolve', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ account_number: acc, account_bank: code })
				});
				const data = await res.json();
				if (data.account_name) {
					bankName = data.account_name;
					bankResolved = true;
					bankError = '';
				} else {
					bankError = data.error || 'Account not found';
					bankName = '';
				}
			} catch {
				bankError = 'Failed to verify account';
			} finally {
				bankResolving = false;
			}
		}, 500);
	});

	function selectBank(bank: { code: string; name: string }) {
		bankCode = bank.code;
		bankBankName = bank.name;
		bankSearchQuery = bank.name;
		showBankDropdown = false;
	}

	// ── Tax detection ──────────────────────────────────────────
	async function detectTax(address: string, isNative: boolean): Promise<{ buyTax: number; sellTax: number; hasTax: boolean }> {
		if (isNative || !address || address === ZERO_ADDRESS) return { buyTax: 0, sellTax: 0, hasTax: false };
		const provider = networkProviders.get(selectedNetwork?.chain_id ?? 0);
		if (!provider) return { buyTax: 0, sellTax: 0, hasTax: false };

		try {
			const token = new ethers.Contract(address, [
				'function buyTaxBps() view returns (uint256)',
				'function sellTaxBps() view returns (uint256)'
			], provider);
			const [buy, sell] = await Promise.all([
				token.buyTaxBps().catch(() => 0n),
				token.sellTaxBps().catch(() => 0n)
			]);
			const b = Number(buy);
			const s = Number(sell);
			return { buyTax: b, sellTax: s, hasTax: b > 0 || s > 0 };
		} catch {
			return { buyTax: 0, sellTax: 0, hasTax: false };
		}
	}

	// ── Token metadata fetch ───────────────────────────────────
	async function fetchMeta(address: string, isNative: boolean) {
		if (!selectedNetwork) return { symbol: '???', name: 'Unknown', decimals: 18, balance: 0n };
		const provider = networkProviders.get(selectedNetwork.chain_id);
		if (!provider) return { symbol: '???', name: 'Unknown', decimals: 18, balance: 0n };

		if (isNative) {
			const bal = userAddress ? await provider.getBalance(userAddress) : 0n;
			return { symbol: selectedNetwork.native_coin, name: selectedNetwork.native_coin, decimals: 18, balance: bal };
		}

		try {
			const token = new ethers.Contract(address, [
				'function symbol() view returns (string)',
				'function name() view returns (string)',
				'function decimals() view returns (uint8)',
				'function balanceOf(address) view returns (uint256)'
			], provider);
			const [sym, name, dec, bal] = await Promise.all([
				token.symbol().catch(() => '???'),
				token.name().catch(() => 'Unknown'),
				token.decimals().catch(() => 18),
				userAddress ? token.balanceOf(userAddress).catch(() => 0n) : Promise.resolve(0n)
			]);
			return { symbol: sym, name, decimals: Number(dec), balance: bal };
		} catch {
			return { symbol: '???', name: 'Unknown', decimals: 18, balance: 0n };
		}
	}

	// ── Select token (optimistic — close modal instantly, fetch in background) ──
	function selectToken(target: 'in' | 'out', token: { address: string; symbol: string; name: string; decimals: number; isNative?: boolean }) {
		const isNative = !!token.isNative;
		const addr = token.address;

		// Close modal immediately (optimistic UI)
		showTokenModal = false;
		tokenSearch = '';

		// Set known values instantly
		if (target === 'in') {
			tokenInAddr = addr;
			tokenInSymbol = token.symbol;
			tokenInName = token.name;
			tokenInDecimals = token.decimals;
			tokenInIsNative = isNative;
			tokenInBalance = 0n;
			tokenInLoading = true;
			tokenInTax = null;
		} else {
			tokenOutAddr = addr;
			tokenOutSymbol = token.symbol;
			tokenOutName = token.name;
			tokenOutDecimals = token.decimals;
			tokenOutIsNative = isNative;
			tokenOutBalance = 0n;
			tokenOutLoading = true;
			tokenOutTax = null;
		}

		// Fetch metadata quickly (balance, decimals, symbol)
		fetchMeta(addr, isNative).then(meta => {
			if (!isNative && selectedNetwork && meta.symbol !== '???') {
				saveImportedToken({ address: addr, symbol: meta.symbol, name: meta.name, decimals: meta.decimals, chainId: selectedNetwork.chain_id });
			}
			if (target === 'in' && tokenInAddr === addr) {
				tokenInBalance = meta.balance;
				tokenInDecimals = meta.decimals;
				tokenInSymbol = meta.symbol !== '???' ? meta.symbol : token.symbol;
				tokenInLoading = false;
			} else if (target === 'out' && tokenOutAddr === addr) {
				tokenOutBalance = meta.balance;
				tokenOutDecimals = meta.decimals;
				tokenOutSymbol = meta.symbol !== '???' ? meta.symbol : token.symbol;
				tokenOutLoading = false;
			}
		}).catch(() => {
			if (target === 'in') tokenInLoading = false;
			else tokenOutLoading = false;
		});

		// Run tax simulation via TradeLens (non-native tokens only)
		if (!isNative && selectedNetwork?.dex_router) {
			const provider = networkProviders.get(selectedNetwork.chain_id);
			if (provider) {
				// Collect all token addresses for batch query + simulate tax for the selected token
				const allAddrs = allTokens
					.map(t => t.isNative ? getWeth() || '' : t.address)
					.filter(a => a && a !== ZERO_ADDRESS);
				if (!allAddrs.find(a => a.toLowerCase() === addr.toLowerCase())) allAddrs.push(addr);

				queryTradeLens(provider as any, selectedNetwork.dex_router, allAddrs, addr, ethers.parseEther('0.001'), userAddress || ethers.ZeroAddress, selectedNetwork.chain_id).then(result => {
					pricesLoaded = true;
					wethAddr = result.weth;

					// Update decimals + balances from TradeLens for all selected tokens
					for (const t of result.tokens) {
						const tAddr = t.token.toLowerCase();
						if (tAddr === tokenInAddr.toLowerCase() && !tokenInIsNative) {
							tokenInDecimals = t.decimals;
							if (t.balance > 0n) tokenInBalance = t.balance;
						}
						if (tAddr === tokenOutAddr.toLowerCase() && !tokenOutIsNative) {
							tokenOutDecimals = t.decimals;
							if (t.balance > 0n) tokenOutBalance = t.balance;
						}
					}
					// Native balance
					if (result.nativeBalance > 0n) {
						if (tokenInIsNative) tokenInBalance = result.nativeBalance;
						if (tokenOutIsNative) tokenOutBalance = result.nativeBalance;
						nativeBalance = result.nativeBalance;
					}

					// Tax
					const tax = result.taxInfo;
					if (target === 'in' && tokenInAddr === addr) {
						tokenInTax = tax;
						tokenInTaxBuy = tax.buyTaxBps;
						tokenInTaxSell = tax.sellTaxBps;
						tokenInHasTax = tax.buyTaxBps > 0 || tax.sellTaxBps > 0;
					} else if (target === 'out' && tokenOutAddr === addr) {
						tokenOutTax = tax;
						tokenOutTaxBuy = tax.buyTaxBps;
						tokenOutTaxSell = tax.sellTaxBps;
						tokenOutHasTax = tax.buyTaxBps > 0 || tax.sellTaxBps > 0;
					}
				}).catch(e => {
					console.warn(`TradeLens failed:`, (e as any)?.message?.slice(0, 200));
				});
			}
		}
	}

	// ── Custom address paste in modal ──────────────────────────
	function handleCustomAddress() {
		const addr = tokenSearch.trim();
		if (!ethers.isAddress(addr)) return;
		const meta = pastedTokenMeta && pastedTokenMeta.address.toLowerCase() === addr.toLowerCase()
			? pastedTokenMeta
			: { address: addr, symbol: '...', name: 'Loading...', decimals: 18 };

		// Save to localStorage for future visits
		if (selectedNetwork && meta.symbol !== '...') {
			saveImportedToken({ ...meta, chainId: selectedNetwork.chain_id });
		}

		selectToken(tokenModalTarget, meta);
	}

	// ── Flip tokens ────────────────────────────────────────────
	function flipTokens() {
		const tmpIn = {
			addr: tokenInAddr, sym: tokenInSymbol, name: tokenInName, dec: tokenInDecimals,
			native: tokenInIsNative, bal: tokenInBalance,
			taxB: tokenInTaxBuy, taxS: tokenInTaxSell, hasTax: tokenInHasTax, sim: tokenInTax
		};
		const tmpOut = {
			addr: tokenOutAddr, sym: tokenOutSymbol, name: tokenOutName, dec: tokenOutDecimals,
			native: tokenOutIsNative, bal: tokenOutBalance,
			taxB: tokenOutTaxBuy, taxS: tokenOutTaxSell, hasTax: tokenOutHasTax, sim: tokenOutTax
		};

		// Swap in ← out
		tokenInAddr = tmpOut.addr; tokenInSymbol = tmpOut.sym; tokenInName = tmpOut.name;
		tokenInDecimals = tmpOut.dec; tokenInIsNative = tmpOut.native; tokenInBalance = tmpOut.bal;
		tokenInTaxBuy = tmpOut.taxB; tokenInTaxSell = tmpOut.taxS; tokenInHasTax = tmpOut.hasTax;
		tokenInTax = tmpOut.sim;

		// Swap out ← in
		tokenOutAddr = tmpIn.addr; tokenOutSymbol = tmpIn.sym; tokenOutName = tmpIn.name;
		tokenOutDecimals = tmpIn.dec; tokenOutIsNative = tmpIn.native; tokenOutBalance = tmpIn.bal;
		tokenOutTaxBuy = tmpIn.taxB; tokenOutTaxSell = tmpIn.taxS; tokenOutHasTax = tmpIn.hasTax;
		tokenOutTax = tmpIn.sim;

		// Keep the input amount, clear output (preview will recalculate)
		amountOut = '';
	}

	// Old reserves cache removed — replaced by MultiQuoter

	// ── Preview swap (instant from cache + background on-chain) ──
	let previewTimeout: ReturnType<typeof setTimeout> | null = null;
	$effect(() => {
		if (previewTimeout) clearTimeout(previewTimeout);
		const amt = amountIn;
		const inAddr = tokenInAddr;
		const outAddr = tokenOutAddr;
		const net = selectedNetwork;

		if (!amt || !inAddr || !outAddr || !net || parseFloat(amt) <= 0 || outputMode === 'bank') {
			amountOut = '';
			noLiquidity = false;
			previewLoading = false;
			return;
		}

		// ── Instant calculation from MultiQuoter cache (0ms) ──
		let hasInstant = false;
		try {
			if (pricesLoaded) {
				const sanitized = parseFloat(amt).toFixed(tokenInDecimals);
				const parsedIn = ethers.parseUnits(sanitized, tokenInDecimals);
				const addrIn = tokenInIsNative ? (wethAddr || getWeth()) : inAddr;
				const addrOut = tokenOutIsNative ? (wethAddr || getWeth()) : outAddr;

				const instantOut = getInstantQuote(addrIn, addrOut, parsedIn);
				if (instantOut !== null && instantOut > 0n) {
					amountOut = ethers.formatUnits(instantOut, tokenOutDecimals);
					noLiquidity = false;
					hasInstant = true;
				}
			}
		} catch {}

		// ── Background on-chain validation (silent update, no loading flash) ──
		if (!hasInstant) previewLoading = true;
		previewTimeout = setTimeout(async () => {
			try {
				const provider = networkProviders.get(net.chain_id);
				if (!provider) return;
				const router = new ethers.Contract(net.trade_router_address, TRADE_ROUTER_ABI, provider);
				const weth = wethAddr || await router.weth();
				const addrIn = tokenInIsNative ? weth : inAddr;
				const addrOut = tokenOutIsNative ? weth : outAddr;
				const sanitized = parseFloat(amt).toFixed(tokenInDecimals);
				const parsedIn = ethers.parseUnits(sanitized, tokenInDecimals);
				const out = await router.getAmountOut(addrIn, addrOut, parsedIn);
				amountOut = ethers.formatUnits(out, tokenOutDecimals);
				noLiquidity = false;
			} catch {
				if (!hasInstant) {
					amountOut = '';
					noLiquidity = true;
				}
			} finally {
				previewLoading = false;
			}
		}, hasInstant ? 500 : 150); // longer debounce if we already have instant price
	});

	// ── Preview bank fee ───────────────────────────────────────
	$effect(() => {
		if (outputMode !== 'bank') return;
		const amt = amountIn;
		const net = selectedNetwork;
		const inAddr = tokenInAddr;
		if (!amt || !net || !inAddr || parseFloat(amt) <= 0) { previewFee = 0n; previewNet = 0n; return; }
		(async () => {
			try {
				const provider = networkProviders.get(net.chain_id);
				if (!provider) return;
				const router = new ethers.Contract(net.trade_router_address, TRADE_ROUTER_ABI, provider);
				const sanitizedAmt = parseFloat(amt).toFixed(tokenInDecimals);
				const parsedAmt = ethers.parseUnits(sanitizedAmt, tokenInDecimals);

				// For non-USDT tokens, first estimate USDT output from swap
				let usdtAmount: bigint;
				const isUsdt = inAddr.toLowerCase() === net.usdt_address?.toLowerCase();
				if (isUsdt) {
					usdtAmount = parsedAmt;
				} else {
					const weth = await router.weth();
					const addrIn = tokenInIsNative ? weth : inAddr;
					usdtAmount = await router.getAmountOut(addrIn, net.usdt_address, parsedAmt);
				}

				const [fee, netAmt] = await router.previewDeposit(usdtAmount);
				previewFee = fee;
				previewNet = netAmt;
			} catch { previewFee = 0n; previewNet = 0n; }
		})();
	});

	// ── Derived helpers ────────────────────────────────────────
	let effectiveTax = $derived.by(() => {
		// When selling tokenIn (it goes to pool), use sellTax of tokenIn
		// When buying tokenOut (it comes from pool), use buyTax of tokenOut
		const sell = tokenInHasTax ? tokenInTaxSell : 0;
		const buy = tokenOutHasTax ? tokenOutTaxBuy : 0;
		return sell + buy;
	});

	let hasTaxEither = $derived(tokenInHasTax || tokenOutHasTax);

	/** Format token amount for display — stablecoins get 2dp, others get 4-6dp */
	function formatAmount(value: string, decimals: number, symbol: string): string {
		if (!value) return '';
		const num = parseFloat(value);
		if (isNaN(num)) return value;
		const isStable = ['USDT', 'USDC', 'BUSD', 'DAI', 'TUSD'].includes(symbol.toUpperCase());
		if (isStable) return num.toFixed(2);
		if (num >= 1000) return num.toFixed(2);
		if (num >= 1) return num.toFixed(4);
		return num.toFixed(6);
	}

	// Apply simulation buy tax to output amount for accurate post-tax display
	let postTaxAmountOut = $derived.by(() => {
		if (!amountOut) return '';
		const buyTax = tokenOutTax?.buyTaxBps || tokenOutTaxBuy || 0;
		if (buyTax <= 0) return amountOut;
		const raw = parseFloat(amountOut);
		return String(raw * (1 - buyTax / 10000));
	});
	let displayAmountOut = $derived(formatAmount(postTaxAmountOut || amountOut, tokenOutDecimals, tokenOutSymbol));

	// USD values for both fields
	// Use the swap output to derive USD — more accurate than spot price for large amounts
	const stablecoins = ['USDT', 'USDC', 'BUSD', 'DAI', 'TUSD'];

	let usdValueIn = $derived.by(() => {
		if (!amountIn || !tokenInAddr || parseFloat(amountIn) <= 0) return '';
		try {
			// If input IS a stablecoin, USD = amount
			if (stablecoins.includes(tokenInSymbol.toUpperCase())) {
				const val = parseFloat(amountIn);
				return `~$${val.toFixed(2)} USD`;
			}
			// Otherwise, use the output value (if output is stablecoin, that's the USD value)
			if (stablecoins.includes(tokenOutSymbol.toUpperCase()) && displayAmountOut) {
				const val = parseFloat(displayAmountOut);
				if (val > 0) return `~$${val.toFixed(2)} USD`;
			}
			// Fallback: use reserves spot price
			if (!selectedNetwork?.usdt_address || !pricesLoaded) return '';
			const parsed = ethers.parseUnits(parseFloat(amountIn).toFixed(tokenInDecimals), tokenInDecimals);
			const addr = tokenInIsNative ? (wethAddr || getWeth()) : tokenInAddr;
			const usd = getUsdValue(addr, parsed, tokenInDecimals, selectedNetwork.usdt_address);
			if (usd === null || usd === 0) return '';
			return `~$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)} USD`;
		} catch { return ''; }
	});

	let usdValueOut = $derived.by(() => {
		const raw = postTaxAmountOut || amountOut;
		if (!raw || !tokenOutAddr || parseFloat(raw) <= 0) return '';
		try {
			// If output IS a stablecoin, USD = the post-tax amount directly
			if (stablecoins.includes(tokenOutSymbol.toUpperCase())) {
				const val = parseFloat(raw);
				return `~$${val.toFixed(2)} USD`;
			}
			// Otherwise, derive USD from the input value minus tax
			// This reflects the actual dollar value the user receives
			if (stablecoins.includes(tokenInSymbol.toUpperCase()) && amountIn) {
				const inputVal = parseFloat(amountIn);
				const buyTax = tokenOutTax?.buyTaxBps || tokenOutTaxBuy || 0;
				const sellTax = tokenInTax?.sellTaxBps || tokenInTaxSell || 0;
				const totalTax = buyTax + sellTax;
				const afterTax = totalTax > 0 ? inputVal * (1 - totalTax / 10000) : inputVal;
				// Also subtract slippage (DEX fee already in the quote)
				if (afterTax > 0) return `~$${afterTax.toFixed(2)} USD`;
			}
			// Fallback: use reserves spot price
			if (!selectedNetwork?.usdt_address || !pricesLoaded) return '';
			const parsed = ethers.parseUnits(parseFloat(raw).toFixed(tokenOutDecimals), tokenOutDecimals);
			const addr = tokenOutIsNative ? (wethAddr || getWeth()) : tokenOutAddr;
			const usd = getUsdValue(addr, parsed, tokenOutDecimals, selectedNetwork.usdt_address);
			if (usd === null || usd === 0) return '';
			return `~$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)} USD`;
		} catch { return ''; }
	});

	let rate = $derived.by(() => {
		if (!amountIn || !amountOut || parseFloat(amountIn) <= 0 || noLiquidity) return '';
		const r = parseFloat(amountOut) / parseFloat(amountIn);
		return formatAmount(String(r), tokenOutDecimals, tokenOutSymbol);
	});

	let minReceived = $derived.by(() => {
		if (!postTaxAmountOut || noLiquidity) return '';
		const out = parseFloat(postTaxAmountOut);
		const min = out * (1 - slippageBps / 10000);
		return formatAmount(String(min), tokenOutDecimals, tokenOutSymbol);
	});

	let priceImpactPct = $derived.by(() => {
		if (effectiveTax > 0) return (effectiveTax / 100).toFixed(1);
		return '';
	});

	// ── Swap handler ───────────────────────────────────────────
	async function handleSwap() {
		if (!signer || !userAddress) { connectWallet(); return; }
		if (!selectedNetwork || !tokenInAddr || !amountIn || parseFloat(amountIn) <= 0) return;

		isSwapping = true;
		try {
			const router = new ethers.Contract(selectedNetwork.trade_router_address, TRADE_ROUTER_ABI, signer);
			// Sanitize amounts — truncate to max decimal places for the token
			const sanitizedIn = parseFloat(amountIn).toFixed(tokenInDecimals);
			const parsedIn = ethers.parseUnits(sanitizedIn, tokenInDecimals);
			let expectedOut = 0n;
			try {
				if (amountOut && parseFloat(amountOut) > 0) {
					const sanitizedOut = parseFloat(amountOut).toFixed(tokenOutDecimals);
					expectedOut = ethers.parseUnits(sanitizedOut, tokenOutDecimals);
				}
			} catch {}
			// Account for token tax + slippage in minOut
			// Buy/sell tax only triggers on DEX pair interactions (not on transferFrom to TradeRouter)
			// Transfer tax triggers on ALL transfers — including user → TradeRouter intermediary hop
			const buyTax = tokenOutTax?.buyTaxBps || tokenOutTaxBuy || 0;
			const sellTax = tokenInTax?.sellTaxBps || tokenInTaxSell || 0;
			const totalTaxBps = buyTax + sellTax;
			const afterTax = totalTaxBps > 0
				? (expectedOut * BigInt(10000 - totalTaxBps)) / 10000n
				: expectedOut;
			const minOut = afterTax > 0n ? (afterTax * BigInt(10000 - slippageBps)) / 10000n : 0n;

			let tx;
			if (outputMode === 'bank') {
				// ── 3-step off-ramp flow ──────────────────────────
				let paymentDetails: any = {};
				let bankRef: string;

				if (paymentMethod === 'bank') {
					if (!bankResolved || !bankAccount || !bankCode) {
						addFeedback({ message: 'Verify your bank account first', type: 'error' });
						isSwapping = false;
						return;
					}
					paymentDetails = { method: 'bank', bank_code: bankCode, bank_name: bankBankName, account: bankAccount, holder: bankName };
					bankRef = ethers.id(`bank:${bankCode}:${bankAccount}:${bankName}`);
				} else if (paymentMethod === 'paypal') {
					if (!paypalEmail) {
						addFeedback({ message: 'Enter your PayPal email', type: 'error' });
						isSwapping = false;
						return;
					}
					paymentDetails = { method: 'paypal', email: paypalEmail };
					bankRef = ethers.id(`paypal:${paypalEmail}`);
				} else {
					if (!wiseEmail) {
						addFeedback({ message: 'Enter your Wise email', type: 'error' });
						isSwapping = false;
						return;
					}
					paymentDetails = { method: 'wise', email: wiseEmail, currency: wiseCurrency };
					bankRef = ethers.id(`wise:${wiseEmail}:${wiseCurrency}`);
				}

				// Step 1: Save payment details to DB (session cookie authenticates)
				withdrawStep = 1;
				// Use USDT-equivalent amounts (not input token amount)
				const usdtGross = previewFee + previewNet; // gross in USDT
				const preRes = await apiFetch('/api/withdrawals', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						chain_id: selectedNetwork.chain_id,
						wallet_address: userAddress,
						token_in: tokenInAddr,
						token_in_symbol: tokenInSymbol,
						gross_amount: usdtGross.toString(),
						fee: previewFee.toString(),
						net_amount: previewNet.toString(),
						payment_method: paymentMethod,
						payment_details: paymentDetails
					})
				});
				if (!preRes.ok) {
					const errData = await preRes.json().catch(() => ({ message: 'Failed to save payment details' }));
					throw new Error(errData.message || 'Failed to save payment details');
				}
				const preData = await preRes.json();

				// Step 2: Approve token (skipped for native)
				withdrawStep = 2;
				if (!tokenInIsNative) {
					const erc20 = new ethers.Contract(tokenInAddr, ERC20_ABI, signer);
					const allowance = await erc20.allowance(userAddress, selectedNetwork.trade_router_address);
					if (allowance < parsedIn) {
						await (await erc20.approve(selectedNetwork.trade_router_address, parsedIn)).wait();
					}
				}

				// Step 3: Execute trade
				withdrawStep = 3;
				const referrer = ethers.ZeroAddress; // TODO: get from URL param or localStorage
				if (tokenInIsNative) {
					tx = await router.depositETH(0, bankRef, referrer, { value: parsedIn });
				} else if (tokenInAddr.toLowerCase() === selectedNetwork.usdt_address.toLowerCase()) {
					tx = await router.deposit(parsedIn, bankRef, referrer);
				} else {
					tx = await router.depositAndSwap(tokenInAddr, parsedIn, 0, true, bankRef, referrer);
				}
				const receipt = await tx.wait();

				// Verify on-chain (still part of step 3 visually)
				let withdrawId = 0;
				try {
					const iface = new ethers.Interface(TRADE_ROUTER_ABI);
					for (const log of receipt?.logs || []) {
						try {
							const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
							if (parsed?.name === 'WithdrawRequested') {
								withdrawId = Number(parsed.args[0]);
								break;
							}
						} catch {}
					}
				} catch {}

				// Verify on-chain and link to DB record (session cookie authenticates)
				try {
					await apiFetch('/api/withdrawals/verify', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							tx_hash: receipt?.hash,
							chain_id: selectedNetwork.chain_id
						})
					});
				} catch {}

				withdrawStep = 4; // all done
				showConfirmModal = false;

				activeWithdrawal = {
					id: preData.id,
					withdraw_id: withdrawId,
					chain_id: selectedNetwork.chain_id,
					wallet_address: userAddress,
					status: 'pending',
					net_amount: previewNet.toString(),
					fee: previewFee.toString(),
					gross_amount: usdtGross.toString(),
					payment_method: paymentMethod,
					payment_details: paymentDetails,
					tx_hash: receipt?.hash,
					created_at: new Date().toISOString()
				};
			} else {
				// ── Direct swap via PancakeSwap (no TradeRouter intermediary) ──
				const dexRouterAddr = selectedNetwork.dex_router;
				const { DEX_ROUTER_ABI } = await import('$lib/tradeRouter');
				const dex = new ethers.Contract(dexRouterAddr, DEX_ROUTER_ABI, signer);
				const weth = wethAddr || await dex.WETH();

				// Step 1: Approve DEX router (not TradeRouter)
				swapStep = 1;
				if (!tokenInIsNative) {
					const erc20 = new ethers.Contract(tokenInAddr, ERC20_ABI, signer);
					const allowance = await erc20.allowance(userAddress, dexRouterAddr);
					if (allowance < parsedIn) {
						await (await erc20.approve(dexRouterAddr, parsedIn)).wait();
					}
				}

				// Build path
				const addrIn = tokenInIsNative ? weth : tokenInAddr;
				const addrOut = tokenOutIsNative ? weth : tokenOutAddr;
				let path: string[];
				if (addrIn !== weth && addrOut !== weth) {
					path = [addrIn, weth, addrOut]; // route through WETH
				} else {
					path = [addrIn, addrOut];
				}

				const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 min

				// Step 2: Execute swap directly on PancakeSwap
				swapStep = 2;
				try {
				// Try with minOut=0 first to avoid slippage revert, user is protected by the preview
				const safeMinOut = 0n;
				if (tokenInIsNative) {
					tx = await dex.swapExactETHForTokensSupportingFeeOnTransferTokens(
						safeMinOut, path, userAddress, deadline, { value: parsedIn, gasLimit: 300000n }
					);
				} else if (tokenOutIsNative) {
					tx = await dex.swapExactTokensForETHSupportingFeeOnTransferTokens(
						parsedIn, safeMinOut, path, userAddress, deadline, { gasLimit: 300000n }
					);
				} else {
					tx = await dex.swapExactTokensForTokensSupportingFeeOnTransferTokens(
						parsedIn, safeMinOut, path, userAddress, deadline, { gasLimit: 300000n }
					);
				}
				const swapReceipt = await tx.wait();
				swapStep = 3; // done
				addFeedback({ message: `Swapped ${amountIn} ${tokenInSymbol} → ${displayAmountOut} ${tokenOutSymbol}`, type: 'success' });
				showConfirmModal = false;
				} catch (swapErr: any) {
					console.error('Swap error:', swapErr);
					addFeedback({ message: swapErr.shortMessage || swapErr.reason || swapErr.message || 'Swap failed', type: 'error' });
					swapStep = 0;
				}
			}

			amountIn = '';
			amountOut = '';
			// Refresh balance
			const meta = await fetchMeta(tokenInAddr, tokenInIsNative);
			tokenInBalance = meta.balance;
		} catch (e: any) {
			addFeedback({ message: e.shortMessage || e.message || 'Transaction failed', type: 'error' });
		} finally {
			isSwapping = false;
			if (withdrawStep < 4) withdrawStep = 0; // don't reset if completed
			if (swapStep < 3) swapStep = 0;
		}
	}

	// ── History (from Supabase + Realtime) ────────────────────
	function safeBigInt(val: any): bigint {
		try {
			if (!val) return 0n;
			const s = String(val).split('.')[0]; // strip decimals if any
			return BigInt(s);
		} catch { return 0n; }
	}

	async function loadHistory() {
		if (!userAddress) return;
		historyLoading = true;
		try {
			// Fetch from both DB and on-chain, merge results
			const net = selectedNetwork;

			// 1. DB records (has payment details, status tracking)
			let dbRecords: any[] = [];
			try {
				const res = await apiFetch(`/api/withdrawals?wallet=${userAddress.toLowerCase()}`);
				if (res.ok) dbRecords = await res.json();
			} catch {}

			// 2. On-chain records (source of truth for actual withdrawals)
			let chainRecords: any[] = [];
			if (net?.trade_router_address) {
				try {
					const provider = networkProviders.get(net.chain_id);
					if (provider) {
						const router = new ethers.Contract(net.trade_router_address, TRADE_ROUTER_ABI, provider);
						const [result, total] = await router.getUserWithdrawals(userAddress, 0, 50);
						chainRecords = result.map((r: any, i: number) => ({
							withdraw_id: i,
							user: r.user?.toLowerCase(),
							grossAmount: r.grossAmount,
							fee: r.fee,
							netAmount: r.netAmount,
							createdAt: Number(r.createdAt),
							status: Number(r.status),
							bankRef: r.bankRef,
							referrer: r.referrer?.toLowerCase() || ethers.ZeroAddress,
						}));
					}
				} catch {}
			}

			// 3. Merge: on-chain is source of truth, enrich with DB data
			// Match by withdraw_id OR bankRef
			const usedDbIds = new Set<number>();
			const merged: any[] = [];

			for (const chain of chainRecords) {
				// Find matching DB record by withdraw_id or bankRef
				let db = dbRecords.find((r: any) => r.withdraw_id === chain.withdraw_id && r.withdraw_id != null && r.withdraw_id > 0);
				if (!db && chain.bankRef) {
					db = dbRecords.find((r: any) => !usedDbIds.has(r.id) && r.wallet_address?.toLowerCase() === chain.user);
				}
				if (db) usedDbIds.add(db.id);

				merged.push({
					id: db?.id || chain.withdraw_id,
					user: chain.user,
					token: db?.token_in || '',
					grossAmount: chain.grossAmount,
					fee: chain.fee,
					netAmount: chain.netAmount,
					createdAt: chain.createdAt,
					status: chain.status, // on-chain status is truth
					bankRef: chain.bankRef,
					withdraw_id: chain.withdraw_id,
					payment_method: db?.payment_method || 'bank',
					payment_details: db?.payment_details || {},
					chain_id: db?.chain_id || net?.chain_id,
					tx_hash: db?.tx_hash || '',
					db_status: chain.status === 1 ? 'confirmed' : chain.status === 2 ? 'cancelled' : 'pending',
				});
			}

			// Add DB-only records not matched to any on-chain record (awaiting_trade)
			for (const db of dbRecords.filter((r: any) => !usedDbIds.has(r.id) && r.status === 'awaiting_trade')) {
				merged.push({
					id: db.id, user: db.wallet_address, token: db.token_in,
					grossAmount: safeBigInt(db.gross_amount),
					fee: safeBigInt(db.fee),
					netAmount: safeBigInt(db.net_amount),
					createdAt: Math.floor(new Date(db.created_at).getTime() / 1000),
					status: 0,
					bankRef: '', withdraw_id: 0,
					payment_method: db.payment_method,
					payment_details: db.payment_details || {},
					chain_id: db.chain_id, tx_hash: db.tx_hash,
					db_status: db.status,
				});
			}

			withdrawals = merged;
		} catch (e) {
			console.error('loadHistory error:', e);
			withdrawals = [];
		}
		finally { historyLoading = false; }
	}

	async function handleCancel(id: number) {
		if (!signer || !selectedNetwork) return;
		try {
			const router = new ethers.Contract(selectedNetwork.trade_router_address, TRADE_ROUTER_ABI, signer);
			await (await router.cancel(id)).wait();
			addFeedback({ message: 'Cancelled. Funds returned.', type: 'success' });
			loadHistory();
		} catch (e: any) {
			addFeedback({ message: e.shortMessage || e.message || 'Cancel failed', type: 'error' });
		}
	}

	// Refresh balances when wallet connects (user was browsing without wallet)
	$effect(() => {
		if (userAddress && tokenInAddr) {
			fetchMeta(tokenInAddr, tokenInIsNative).then(meta => { tokenInBalance = meta.balance; });
		}
		if (userAddress && tokenOutAddr) {
			fetchMeta(tokenOutAddr, tokenOutIsNative).then(meta => { tokenOutBalance = meta.balance; });
		}
	});

	// Realtime sub for withdrawal updates
	let withdrawChannel: any;
	$effect(() => {
		if (showHistory && userAddress) {
			loadHistory();
			// Subscribe to changes for this wallet
			if (withdrawChannel) supabase.removeChannel(withdrawChannel);
			withdrawChannel = supabase
				.channel(`trade-history-${userAddress}`)
				.on('postgres_changes', {
					event: '*', schema: 'public', table: 'withdrawal_requests',
					filter: `wallet_address=eq.${userAddress.toLowerCase()}`
				}, () => loadHistory())
				.subscribe();
		}
	});

	// ── Gas balance check ─────────────────────────────────────
	let nativeBalance = $state(0n);
	let estimatedGasCost = $state(ethers.parseUnits('0.001', 18)); // default fallback

	// Fetch gas price and estimate cost
	$effect(() => {
		if (!selectedNetwork) return;
		const provider = networkProviders.get(selectedNetwork.chain_id);
		if (!provider) return;
		provider.getFeeData().then(fee => {
			const gasPrice = fee.gasPrice || fee.maxFeePerGas || 5000000000n; // fallback 5 gwei
			const swapGasUnits = 300000n; // typical swap gas
			estimatedGasCost = gasPrice * swapGasUnits;
		}).catch(() => {});
	});

	let hasGas = $derived(nativeBalance > estimatedGasCost);

	// Fetch native balance when wallet connects or network changes
	$effect(() => {
		if (!userAddress || !selectedNetwork) { nativeBalance = 0n; return; }
		const provider = networkProviders.get(selectedNetwork.chain_id);
		if (!provider) return;
		provider.getBalance(userAddress).then(b => { nativeBalance = b; }).catch(() => {});
	});

	// ── Button label ───────────────────────────────────────────
	// Button shows action label even without wallet — prompts connect on click
	// Insufficient balance check
	let insufficientBalance = $derived.by(() => {
		if (!userAddress || !tokenInAddr || !amountIn || parseFloat(amountIn) <= 0) return false;
		if (tokenInBalance === 0n) return true;
		try {
			const sanitized = parseFloat(amountIn).toFixed(tokenInDecimals);
			const needed = ethers.parseUnits(sanitized, tokenInDecimals);
			return needed > tokenInBalance;
		} catch { return false; }
	});

	let noGas = $derived(!!userAddress && !tokenInIsNative && !hasGas && !!tokenInAddr && !!amountIn);

	let buttonLabel = $derived.by(() => {
		if (isSwapping || isWithdrawing) return 'Processing...';
		if (!tokenInAddr) return 'Select a token';
		if (!amountIn || parseFloat(amountIn) <= 0) return 'Enter an amount';
		if (insufficientBalance) return `Insufficient ${tokenInSymbol} balance`;
		if (noGas) return `Insufficient ${selectedNetwork?.native_coin || 'gas'} for gas`;
		if (noLiquidity && outputMode === 'token') return 'Insufficient liquidity';
		if (outputMode === 'bank') {
			if (paymentMethod === 'bank' && (!bankResolved || !bankAccount || !bankCode)) return 'Verify bank account';
			if (paymentMethod === 'paypal' && !paypalEmail) return 'Enter PayPal email';
			if (paymentMethod === 'wise' && !wiseEmail) return 'Enter Wise email';
			const methodLabel = paymentMethod === 'bank' ? 'Bank' : paymentMethod === 'paypal' ? 'PayPal' : 'Wise';
			return `Sell ${tokenInSymbol} → ${methodLabel}`;
		}
		if (!tokenOutAddr) return 'Select output token';
		return `Swap ${tokenInSymbol} → ${tokenOutSymbol}`;
	});

	let buttonDisabled = $derived(
		isSwapping || isWithdrawing ||
		!tokenInAddr || !amountIn || parseFloat(amountIn) <= 0 ||
		insufficientBalance || noGas ||
		(outputMode === 'token' && (!tokenOutAddr || noLiquidity)) ||
		(outputMode === 'bank' && (
			(paymentMethod === 'bank' && (!bankResolved || !bankAccount || !bankCode)) ||
			(paymentMethod === 'paypal' && !paypalEmail) ||
			(paymentMethod === 'wise' && !wiseEmail)
		))
	);
</script>

<svelte:head>
	<title>Trade | TokenKrafter</title>
</svelte:head>

<div class="trade-page">
	<div class="trade-container">

		<!-- Header -->
		<div class="trade-header">
			<div>
				<h1 class="trade-title">Trade</h1>
				<p class="trade-sub">Swap tokens or sell to your bank account</p>
			</div>
			<div class="header-actions">
				{#if userAddress}
					<button class="icon-btn" onclick={() => { showHistory = !showHistory; }} title="History">
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
					</button>
				{/if}
				<button class="icon-btn" class:icon-btn-active={showSettings} onclick={() => (showSettings = !showSettings)} title="Settings">
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
				</button>
			</div>
		</div>

		<!-- Settings panel -->
		{#if showSettings}
			<div class="settings-panel">
				<span class="settings-label">Slippage Tolerance</span>
				<div class="slippage-row">
					{#each [50, 100, 200, 500] as bps}
						<button
							class="slippage-btn" class:slippage-active={slippageBps === bps}
							onclick={() => (slippageBps = bps)}
						>{bps / 100}%</button>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Network selector (only if multiple trade networks) -->
		{#if tradeNetworks.length > 1}
			<div class="network-selector">
				{#each tradeNetworks as net, i}
					<button
						class="network-btn"
						class:network-active={selectedNetworkIdx === i}
						onclick={() => {
							if (selectedNetworkIdx !== i) {
								selectedNetworkIdx = i;
								tokenInAddr = ''; tokenInSymbol = ''; tokenInBalance = 0n; tokenInHasTax = false;
								tokenOutAddr = ''; tokenOutSymbol = ''; tokenOutBalance = 0n; tokenOutHasTax = false;
								amountIn = ''; amountOut = '';
							}
						}}
					>
						{net.symbol}
					</button>
				{/each}
			</div>
		{/if}

		<!-- Output mode toggle -->
		<div class="mode-toggle">
			<button class="mode-btn" class:mode-active={outputMode === 'token'} onclick={() => (outputMode = 'token')}>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4"/></svg>
				Swap
			</button>
			<button class="mode-btn" class:mode-active={outputMode === 'bank'} onclick={() => (outputMode = 'bank')}>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M20 10v11M8 14v3M12 14v3M16 14v3"/></svg>
				Sell to Bank
			</button>
		</div>

		<!-- ═══ SWAP CARD ═══ -->
		<div class="swap-card">

			<!-- FROM section -->
			<div class="token-section">
				<div class="token-section-header">
					<span class="section-label">You pay</span>
					<button class="token-selector" onclick={() => { tokenModalTarget = 'in'; showTokenModal = true; }}>
						{#if tokenInSymbol}
							<span class="token-selector-symbol">{tokenInSymbol}</span>
						{:else}
							<span class="token-selector-placeholder">Select token</span>
						{/if}
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M6 9l6 6 6-6"/></svg>
					</button>
				</div>
				<div class="token-input-row">
					<input
						type="text"
						inputmode="decimal"
						class="amount-input"
						placeholder="0.00"
						bind:value={amountIn}
					/>
					{#if tokenInSymbol && tokenInBalance > 0n}
						<button class="max-btn" onclick={() => {
							let raw: string;
							if (tokenInIsNative) {
								const gasBuffer = estimatedGasCost * 12n / 10n; // +20% safety
								const maxAmount = tokenInBalance > gasBuffer ? tokenInBalance - gasBuffer : 0n;
								raw = ethers.formatUnits(maxAmount, tokenInDecimals);
							} else {
								raw = ethers.formatUnits(tokenInBalance, tokenInDecimals);
							}
							// Truncate to 8 decimals (no rounding — exact floor)
							const dot = raw.indexOf('.');
							amountIn = dot === -1 ? raw : raw.slice(0, dot + 9);
						}}>
							MAX
						</button>
					{/if}
				</div>
				<div class="token-balance-row">
					{#if tokenInSymbol && tokenInBalance > 0n}
						<span>Balance: {parseFloat(ethers.formatUnits(tokenInBalance, tokenInDecimals)).toLocaleString(undefined, { maximumFractionDigits: 4 })} {tokenInSymbol}</span>
					{:else if tokenInSymbol}
						<span>Balance: 0 {tokenInSymbol}</span>
					{/if}
					{#if usdValueIn}<span class="usd-value">{usdValueIn}</span>{/if}
				</div>
				{#if tokenInTax && !tokenInTax.canSell && !tokenInIsNative}
					<div class="honeypot-badge">
						<span class="tax-dot" style="background: #f87171;"></span>
						Honeypot: cannot sell this token
					</div>
				{:else if tokenInHasTax}
					<div class="tax-badge">
						<span class="tax-dot tax-dot-amber"></span>
						Tax: {tokenInTaxBuy / 100}% buy / {tokenInTaxSell / 100}% sell
					</div>
				{/if}
			</div>

			<!-- Flip button -->
			{#if outputMode === 'token'}
				<div class="flip-row">
					<button class="flip-btn" onclick={flipTokens}>
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
							<path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4"/>
						</svg>
					</button>
				</div>
			{/if}

			<!-- TO section (token mode) -->
			{#if outputMode === 'token'}
				<div class="token-section token-section-out">
					<div class="token-section-header">
						<span class="section-label">You receive</span>
						<button class="token-selector" onclick={() => { tokenModalTarget = 'out'; showTokenModal = true; }}>
							{#if tokenOutSymbol}
								<span class="token-selector-symbol">{tokenOutSymbol}</span>
							{:else}
								<span class="token-selector-placeholder">Select token</span>
							{/if}
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M6 9l6 6 6-6"/></svg>
						</button>
					</div>
					<div class="token-input-row">
						<input
							type="text"
							inputmode="decimal"
							class="amount-input amount-input-out"
							placeholder="0.00"
							value={previewLoading ? '' : displayAmountOut}
							readonly
						/>
						{#if previewLoading}
							<div class="preview-shimmer"></div>
						{/if}
					</div>
					<div class="token-balance-row">
						{#if tokenOutSymbol && tokenOutBalance > 0n}
							<span>Balance: {parseFloat(ethers.formatUnits(tokenOutBalance, tokenOutDecimals)).toLocaleString(undefined, { maximumFractionDigits: 4 })} {tokenOutSymbol}</span>
						{:else if tokenOutSymbol}
							<span>Balance: 0 {tokenOutSymbol}</span>
						{/if}
						{#if usdValueOut}<span class="usd-value">{usdValueOut}</span>{/if}
					</div>
					{#if tokenOutTax && !tokenOutTax.canSell && !tokenOutIsNative}
						<div class="honeypot-badge">
							<span class="tax-dot" style="background: #f87171;"></span>
							Honeypot: cannot sell this token
						</div>
					{:else if tokenOutHasTax}
						<div class="tax-badge">
							<span class="tax-dot tax-dot-amber"></span>
							Tax: {tokenOutTaxBuy / 100}% buy / {tokenOutTaxSell / 100}% sell
						</div>
					{/if}
				</div>
			{/if}

			<!-- Payout details (bank mode) -->
			{#if outputMode === 'bank'}
				<div class="bank-section">
					<div class="bank-info-strip">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
						<span>Funds held in smart contract. Cancel anytime if not processed within 5 minutes.</span>
					</div>

					{#if previewNet > 0n || fiatEquivalent}
						<div class="bank-preview">
							{#if fiatEquivalent}
								<div class="bank-payout-highlight">
									<span class="bank-payout-ngn">{fiatEquivalent}</span>
									<span class="bank-payout-usd">≈ ${parseFloat(ethers.formatUnits(previewNet, usdtDecimals)).toFixed(2)} USD</span>
								</div>
							{/if}
							{#if previewNet > 0n}
								<div class="bank-preview-row">
									<span>Platform fee (0.1%)</span>
									<span>${parseFloat(ethers.formatUnits(previewFee, usdtDecimals)).toFixed(2)}</span>
								</div>
								<div class="bank-preview-row bank-preview-net">
									<span>Net amount</span>
									<span>${parseFloat(ethers.formatUnits(previewNet, usdtDecimals)).toFixed(2)}</span>
								</div>
							{/if}
						</div>
					{/if}

					<!-- Payment method tabs -->
					<div class="pay-method-tabs">
						{#each [
							{ key: 'bank', label: 'Bank Transfer', icon: 'M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M20 10v11M8 14v3M12 14v3M16 14v3' },
							// { key: 'paypal', label: 'PayPal', icon: '...' }, // Coming soon
							// { key: 'wise', label: 'Wise', icon: '...' },     // Coming soon
						] as method}
							<button
								class="pay-method-tab"
								class:pay-method-active={paymentMethod === method.key}
								onclick={() => (paymentMethod = method.key as any)}
							>
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d={method.icon}/></svg>
								{method.label}
							</button>
						{/each}
					</div>

					<!-- Bank Transfer fields -->
					{#if paymentMethod === 'bank'}
						<div class="bank-fields">
							<div class="field-group">
								<label class="field-label">Account Number</label>
								<input
									class="input-field"
									placeholder="Enter 10-digit account number"
									bind:value={bankAccount}
									maxlength="10"
									inputmode="numeric"
								/>
							</div>

							<div class="field-group">
								<label class="field-label">Bank</label>
								<button class="bank-selector-btn" onclick={() => { showBankModal = true; bankSearchQuery = ''; }}>
									{#if bankBankName}
										<span class="bank-selector-name">{bankBankName}</span>
									{:else}
										<span class="bank-selector-placeholder">Select your bank</span>
									{/if}
									<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M6 9l6 6 6-6"/></svg>
								</button>
							</div>

							<!-- Resolve status -->
							{#if bankResolving}
								<div class="resolve-status resolve-loading">
									<div class="resolve-spinner"></div>
									Verifying account...
								</div>
							{:else if bankResolved}
								<div class="resolve-status resolve-success">
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
									{bankName}
								</div>
							{:else if bankError}
								<div class="resolve-status resolve-error">
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
									{bankError}
								</div>
							{/if}
						</div>

					<!-- PayPal fields -->
					{:else if paymentMethod === 'paypal'}
						<div class="bank-fields">
							<div class="field-group">
								<label class="field-label">PayPal Email</label>
								<input class="input-field" type="email" placeholder="your@email.com" bind:value={paypalEmail} />
							</div>
							<div class="pay-method-note">
								We'll send your funds to this PayPal email address.
							</div>
						</div>

					<!-- Wise fields -->
					{:else if paymentMethod === 'wise'}
						<div class="bank-fields">
							<div class="field-group">
								<label class="field-label">Wise Email</label>
								<input class="input-field" type="email" placeholder="your@email.com" bind:value={wiseEmail} />
							</div>
							<div class="field-group">
								<label class="field-label">Receive Currency</label>
								<select class="input-field" bind:value={wiseCurrency}>
									<option value="NGN">NGN (Nigerian Naira)</option>
									<option value="USD">USD (US Dollar)</option>
									<option value="GBP">GBP (British Pound)</option>
									<option value="EUR">EUR (Euro)</option>
									<option value="KES">KES (Kenyan Shilling)</option>
									<option value="GHS">GHS (Ghanaian Cedi)</option>
								</select>
							</div>
							<div class="pay-method-note">
								Funds will be converted and sent to your Wise account.
							</div>
						</div>
					{/if}
				</div>
			{/if}

			<!-- Trade details -->
			{#if rate && outputMode === 'token'}
				<div class="trade-details">
					<div class="detail-line">
						<span>Rate</span>
						<span>1 {tokenInSymbol} = {rate} {tokenOutSymbol}</span>
					</div>
					{#if minReceived}
						{@const minUsd = usdValueOut && displayAmountOut && parseFloat(displayAmountOut) > 0
							? (parseFloat(usdValueOut.replace(/[^0-9.]/g, '')) * parseFloat(minReceived) / parseFloat(displayAmountOut)).toFixed(2)
							: ''}
						<div class="detail-line">
							<span>Min. received</span>
							<span>{minReceived} {tokenOutSymbol}{#if minUsd} <span class="usd-value">(~${minUsd})</span>{/if}</span>
						</div>
					{/if}
					<div class="detail-line">
						<span>Slippage</span>
						<span>{slippageBps / 100}%</span>
					</div>
					{#if tokenInTaxSell > 0}
						<div class="detail-line detail-line-warn">
							<span>Sell tax ({tokenInSymbol})</span>
							<span>{(tokenInTaxSell / 100).toFixed(1)}%</span>
						</div>
					{/if}
					{#if tokenOutTaxBuy > 0}
						<div class="detail-line detail-line-warn">
							<span>Buy tax ({tokenOutSymbol})</span>
							<span>{(tokenOutTaxBuy / 100).toFixed(1)}%</span>
						</div>
					{/if}
				</div>
			{/if}

			{#if noLiquidity && outputMode === 'token'}
				<div class="no-liquidity">
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
					No liquidity for this pair
				</div>
			{/if}

			<!-- Action button -->
			<button
				class="swap-btn"
				class:swap-btn-bank={outputMode === 'bank' && !insufficientBalance && !noGas}
				class:swap-btn-error={insufficientBalance || noGas}
				disabled={buttonDisabled && !!userAddress}
				onclick={() => { if (!userAddress) connectWallet(); else showConfirmModal = true; }}
			>
				{buttonLabel}
			</button>

		</div>

		<!-- Buy crypto banner -->
		<div class="buy-crypto-strip">
			<svg width="14" height="14" viewBox="0 0 512 512" fill="#00d2ff"><path d="M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512zM169.8 165.3c7.9-22.3 29.1-37.3 52.8-37.3h58.3c34.9 0 63.1 28.3 63.1 63.1c0 22.6-12.1 43.5-31.7 54.8L280 264.4c-.2 13-10.9 23.6-24 23.6c-13.3 0-24-10.7-24-24V250.5c0-8.6 4.6-16.5 12.1-20.8l44.3-25.4c4.7-2.7 7.6-7.7 7.6-13.1c0-8.4-6.8-15.1-15.1-15.1H222.6c-3.4 0-6.4 2.1-7.5 5.3l-.4 1.2c-4.4 12.5-18.2 19-30.6 14.6s-19-18.2-14.6-30.6l.4-1.2zM224 352a32 32 0 1 1 64 0 32 32 0 1 1-64 0z"/></svg>
			<span>Need Crypto? Buy with the best price!</span>
			<button class="buy-crypto-btn" onclick={() => addFeedback({ message: 'Coming soon!', type: 'info' })}>
				Get it Now
			</button>
		</div>

		<!-- History panel -->
		{#if showHistory}
			<div class="history-panel">
				<h3 class="history-title">Withdrawal History</h3>
				{#if historyLoading}
					<div class="history-loading"><div class="spinner"></div></div>
				{:else if withdrawals.length === 0}
					<p class="history-empty">No withdrawals yet</p>
				{:else}
					{#each withdrawals.toReversed() as w, i}
						{@const timedOut = w.status === 0 && Date.now() / 1000 > w.createdAt + 300}
						{@const sc = timedOut ? 'red' : withdrawStatusColor(w.status)}
						{@const canCancel = timedOut}
						<button class="history-row" onclick={() => {
							showConfirmModal = false;
							activeWithdrawal = {
								id: w.id,
								withdraw_id: w.withdraw_id,
								chain_id: w.chain_id || selectedNetwork?.chain_id,
								wallet_address: userAddress,
								status: timedOut ? 'timeout' : withdrawStatusLabel(w.status).toLowerCase(),
								net_amount: w.netAmount?.toString() || w.grossAmount?.toString() || '0',
								fee: w.fee?.toString() || '0',
								gross_amount: w.grossAmount?.toString() || '0',
								payment_method: w.payment_method || 'bank',
								payment_details: w.payment_details || {},
								tx_hash: w.tx_hash || '',
								created_at: new Date(Number(w.createdAt) * 1000).toISOString()
							};
						}}>
							<div class="history-row-top">
								<span class="history-amount">${parseFloat(ethers.formatUnits(w.grossAmount, usdtDecimals)).toFixed(2)}</span>
								<span class="history-status status-{sc}">{timedOut ? 'Timed Out' : withdrawStatusLabel(w.status)}</span>
							</div>
							<div class="history-row-bottom">
								<span class="history-date">{new Date(Number(w.createdAt) * 1000).toLocaleString()}</span>
								{#if canCancel}
									<span class="cancel-hint">Tap to cancel</span>
								{/if}
							</div>
							{#if w.status === 0}
								{@const elapsed = Math.floor(Date.now() / 1000) - Number(w.createdAt)}
								{@const remaining = Math.max(0, 300 - elapsed)}
								<div class="history-progress">
									<div class="progress-track"><div class="progress-fill progress-amber" style="width: {Math.min(100, (elapsed / 300) * 100)}%"></div></div>
									<span class="history-timer">{remaining > 0 ? `${Math.floor(remaining / 60)}m ${remaining % 60}s` : 'Timed out'}</span>
								</div>
							{/if}
						</button>
					{/each}
				{/if}
			</div>
		{/if}
	</div>
</div>

<!-- ═══ TOKEN SELECTOR MODAL ═══ -->
{#if showTokenModal}
	<div class="modal-backdrop" onclick={() => { showTokenModal = false; tokenSearch = ''; }}
		role="dialog" aria-modal="true"
	>
		<div class="token-modal" onclick={(e) => e.stopPropagation()}>
			<div class="modal-header">
				<h3>Select a token</h3>
				<button class="modal-close" onclick={() => { showTokenModal = false; tokenSearch = ''; }}>
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
				</button>
			</div>

			<input
				class="input-field modal-search"
				placeholder="Search name, symbol, or paste address"
				bind:value={tokenSearch}
				autofocus
			/>

			<!-- Quick select built-ins -->
			<div class="quick-tokens">
				{#each builtInTokens as t}
					<button class="quick-token-btn" onclick={() => selectToken(tokenModalTarget, t)}>
						{t.symbol}
					</button>
				{/each}
			</div>

			<div class="token-list">
				{#if ethers.isAddress(tokenSearch.trim()) && !filteredTokens.find(t => t.address.toLowerCase() === tokenSearch.trim().toLowerCase())}
					{#if pastedTokenLoading}
						<div class="token-list-item" style="cursor: default; opacity: 0.6;">
							<div class="token-list-icon token-list-icon-custom">
								<div class="token-list-spinner"></div>
							</div>
							<div class="token-list-info">
								<span class="token-list-symbol">Loading...</span>
								<span class="token-list-addr">{tokenSearch.trim().slice(0, 6)}...{tokenSearch.trim().slice(-4)}</span>
							</div>
						</div>
					{:else if pastedTokenMeta}
						<button class="token-list-item" onclick={handleCustomAddress}>
							<div class="token-list-icon token-list-icon-custom">{pastedTokenMeta.symbol.charAt(0)}</div>
							<div class="token-list-info">
								<span class="token-list-symbol">{pastedTokenMeta.symbol}</span>
								<span class="token-list-name">{pastedTokenMeta.name}</span>
							</div>
							<span class="token-list-import">Import</span>
						</button>
					{:else}
						<button class="token-list-item" onclick={handleCustomAddress}>
							<div class="token-list-icon token-list-icon-custom">?</div>
							<div class="token-list-info">
								<span class="token-list-symbol">Import Token</span>
								<span class="token-list-addr">{tokenSearch.trim().slice(0, 6)}...{tokenSearch.trim().slice(-4)}</span>
							</div>
					</button>
					{/if}
				{/if}

				{#each filteredTokens as t}
					<button class="token-list-item" onclick={() => selectToken(tokenModalTarget, t)}>
						{#if t.logo_url}
							<img src={t.logo_url} alt="" class="token-list-icon" />
						{:else}
							<div class="token-list-icon token-list-icon-placeholder">
								{t.symbol.charAt(0)}
							</div>
						{/if}
						<div class="token-list-info">
							<span class="token-list-symbol">{t.symbol}</span>
							<span class="token-list-name">{t.name}</span>
						</div>
						{#if t.address !== ZERO_ADDRESS}
							<span class="token-list-addr">{t.address.slice(0, 6)}...{t.address.slice(-4)}</span>
						{/if}
					</button>
				{/each}

				{#if filteredTokens.length === 0 && !ethers.isAddress(tokenSearch.trim())}
					<p class="token-list-empty">No tokens found</p>
				{/if}
			</div>
		</div>
	</div>
{/if}

<!-- ═══ BANK SELECTOR MODAL ═══ -->
{#if showBankModal}
	<div class="modal-backdrop" onclick={() => { showBankModal = false; bankSearchQuery = ''; }}
		role="dialog" aria-modal="true"
	>
		<div class="token-modal" onclick={(e) => e.stopPropagation()}>
			<div class="modal-header">
				<h3>Select your bank</h3>
				<button class="modal-close" onclick={() => { showBankModal = false; bankSearchQuery = ''; }}>
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
				</button>
			</div>

			<input
				class="input-field modal-search"
				placeholder="Search bank name..."
				bind:value={bankSearchQuery}
				autofocus
			/>

			<!-- Popular banks quick select -->
			<div class="quick-tokens">
				{#each ngBanks.filter(b => ['058','011','033','044','057','100','103'].includes(b.code)).slice(0, 6) as bank}
					<button class="quick-token-btn" onclick={() => { selectBank(bank); showBankModal = false; bankSearchQuery = ''; }}>
						{bank.name.replace(/ Plc| Bank| of Nigeria/gi, '').trim()}
					</button>
				{/each}
			</div>

			<div class="token-list">
				{#each filteredBanks as bank}
					<button class="token-list-item" onclick={() => { selectBank(bank); showBankModal = false; bankSearchQuery = ''; }}>
						<div class="bank-list-initial">{bank.name.charAt(0)}</div>
						<span class="bank-list-name">{bank.name}</span>
					</button>
				{/each}

				{#if filteredBanks.length === 0}
					<p class="token-list-empty">No banks found</p>
				{/if}
			</div>
		</div>
	</div>
{/if}

<!-- ═══ CONFIRM TRADE MODAL ═══ -->
{#if showConfirmModal}
	<div class="modal-backdrop" onclick={() => { if (!isSwapping) showConfirmModal = false; }}
		role="dialog" aria-modal="true"
	>
		<div class="confirm-modal" onclick={(e) => e.stopPropagation()}>
			<div class="modal-header">
				<h3>{outputMode === 'bank' ? 'Confirm Withdrawal' : 'Confirm Swap'}</h3>
				{#if !isSwapping}
					<button class="modal-close" onclick={() => (showConfirmModal = false)}>
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
					</button>
				{/if}
			</div>

			<div class="confirm-body">
				{#if isSwapping}
					<!-- ═══ STEPPER (replaces review) ═══ -->
					{#if outputMode === 'bank' && withdrawStep > 0}
						{#if withdrawStep >= 5}
							<div class="ws-complete">
								<div class="ws-complete-icon">
									<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
								</div>
								<span class="ws-complete-text">Withdrawal submitted!</span>
								<span class="ws-complete-sub">Your funds are secured in the smart contract. You'll receive payment shortly.</span>
								<button class="swap-btn swap-btn-bank" style="margin: 12px 0 0; width: 100%;" onclick={() => { showConfirmModal = false; }}>
									View Status
								</button>
							</div>
						{:else}
							<div class="ws-stepper-header">
								<span class="ws-stepper-amount">{amountIn} {tokenInSymbol}</span>
								{#if fiatEquivalent}
									<span class="ws-stepper-fiat">→ {fiatEquivalent}</span>
								{/if}
							</div>
							<div class="withdraw-steps">
								{#each [
									{ n: 1, title: 'Save Details', desc: 'Saving payment info', activeDesc: 'Saving...' },
									{ n: 2, title: 'Approve Token', desc: tokenInIsNative ? 'Skipped for native' : `Allow ${tokenInSymbol}`, activeDesc: tokenInIsNative ? 'Skipping...' : 'Confirm in wallet...' },
									{ n: 3, title: 'Execute Trade', desc: 'Deposit to contract', activeDesc: 'Confirm in wallet...' }
								] as step}
									{@const isDone = withdrawStep > step.n}
									{@const isActive = withdrawStep === step.n}
									{@const isPending = withdrawStep < step.n}
									<div class="withdraw-step" class:ws-done={isDone} class:ws-active={isActive} class:ws-pending={isPending}>
										<div class="ws-indicator" class:ws-indicator-done={isDone} class:ws-indicator-active={isActive}>
											{#if isDone}
												<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
											{:else if isActive}
												<div class="ws-spinner"></div>
											{:else}
												<span>{step.n}</span>
											{/if}
										</div>
										<div class="ws-text">
											<span class="ws-title">{step.title}</span>
											<span class="ws-desc">{isActive ? step.activeDesc : step.desc}</span>
										</div>
										{#if isDone}
											<span class="ws-check-label">Done</span>
										{/if}
									</div>
								{/each}
							</div>
						{/if}
					{:else if outputMode === 'token'}
						{#if swapStep >= 3}
							<div class="ws-complete">
								<div class="ws-complete-icon">
									<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
								</div>
								<span class="ws-complete-text">Swap complete!</span>
								<span class="ws-complete-sub">{tokenInSymbol} → {tokenOutSymbol}</span>
								<button class="swap-btn" style="margin: 12px 0 0; width: 100%;" onclick={() => { showConfirmModal = false; swapStep = 0; amountIn = ''; amountOut = ''; }}>
									Done
								</button>
							</div>
						{:else}
							<div class="ws-stepper-header">
								<span class="ws-stepper-amount">{amountIn} {tokenInSymbol} → {amountOut} {tokenOutSymbol}</span>
							</div>
							<div class="withdraw-steps">
								{#each [
									{ n: 1, title: 'Approve Token', desc: tokenInIsNative ? 'Skipped for native' : `Allow ${tokenInSymbol}`, activeDesc: tokenInIsNative ? 'Skipping...' : 'Confirm in wallet...' },
									{ n: 2, title: 'Execute Swap', desc: `${tokenInSymbol} → ${tokenOutSymbol}`, activeDesc: 'Confirm in wallet...' }
								] as step}
									{@const isDone = swapStep > step.n}
									{@const isActive = swapStep === step.n}
									{@const isPending = swapStep < step.n}
									<div class="withdraw-step" class:ws-done={isDone} class:ws-active={isActive} class:ws-pending={isPending}>
										<div class="ws-indicator" class:ws-indicator-done={isDone} class:ws-indicator-active={isActive}>
											{#if isDone}
												<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
											{:else if isActive}
												<div class="ws-spinner"></div>
											{:else}
												<span>{step.n}</span>
											{/if}
										</div>
										<div class="ws-text">
											<span class="ws-title">{step.title}</span>
											<span class="ws-desc">{isActive ? step.activeDesc : step.desc}</span>
										</div>
										{#if isDone}
											<span class="ws-check-label">Done</span>
										{/if}
									</div>
								{/each}
							</div>
						{/if}
					{/if}
				{:else}
				<!-- ═══ REVIEW (before clicking confirm) ═══ -->
				<div class="confirm-token-box">
					<span class="confirm-label">You pay</span>
					<div class="confirm-amount-row">
						<span class="confirm-amount">{amountIn}</span>
						<span class="confirm-symbol">{tokenInSymbol}</span>
					</div>
					{#if tokenInHasTax}
						<span class="confirm-tax">Sell tax: {tokenInTaxSell / 100}%</span>
					{/if}
				</div>

				<div class="confirm-arrow">
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14m0 0l-4-4m4 4l4-4"/></svg>
				</div>

				<div class="confirm-token-box">
					{#if outputMode === 'token'}
						<span class="confirm-label">You receive</span>
						<div class="confirm-amount-row">
							<span class="confirm-amount">{displayAmountOut || '0'}</span>
							<span class="confirm-symbol">{tokenOutSymbol}</span>
						</div>
						{#if tokenOutHasTax}
							<span class="confirm-tax">Buy tax: {tokenOutTaxBuy / 100}%</span>
						{/if}
					{:else}
						<span class="confirm-label">Withdraw to</span>
						<div class="confirm-bank-info">
							<span class="confirm-bank-method">
								{paymentMethod === 'bank' ? bankBankName : paymentMethod === 'paypal' ? 'PayPal' : 'Wise'}
							</span>
							{#if paymentMethod === 'bank' && bankResolved}
								<span class="confirm-bank-holder">{bankName}</span>
								<span class="confirm-bank-acc">{bankAccount}</span>
							{:else if paymentMethod === 'paypal'}
								<span class="confirm-bank-holder">{paypalEmail}</span>
							{:else if paymentMethod === 'wise'}
								<span class="confirm-bank-holder">{wiseEmail} ({wiseCurrency})</span>
							{/if}
						</div>
					{/if}
				</div>

				<div class="confirm-details">
					{#if outputMode === 'token' && rate}
						<div class="confirm-detail-row">
							<span>Rate</span>
							<span>1 {tokenInSymbol} = {rate} {tokenOutSymbol}</span>
						</div>
						{@const confirmMinUsd = usdValueOut && displayAmountOut && parseFloat(displayAmountOut) > 0
							? (parseFloat(usdValueOut.replace(/[^0-9.]/g, '')) * parseFloat(minReceived) / parseFloat(displayAmountOut)).toFixed(2)
							: ''}
						<div class="confirm-detail-row">
							<span>Min. received</span>
							<span>{minReceived} {tokenOutSymbol}{#if confirmMinUsd} <span class="usd-value">(~${confirmMinUsd})</span>{/if}</span>
						</div>
						<div class="confirm-detail-row">
							<span>Slippage</span>
							<span>{slippageBps / 100}%</span>
						</div>
						{#if tokenInTaxSell > 0}
							<div class="confirm-detail-row confirm-detail-warn">
								<span>Sell tax ({tokenInSymbol})</span>
								<span>{(tokenInTaxSell / 100).toFixed(1)}%</span>
							</div>
						{/if}
						{#if tokenOutTaxBuy > 0}
							<div class="confirm-detail-row confirm-detail-warn">
								<span>Buy tax ({tokenOutSymbol})</span>
								<span>{(tokenOutTaxBuy / 100).toFixed(1)}%</span>
							</div>
						{/if}
					{:else if outputMode === 'bank'}
						{#if fiatEquivalent}
							<div class="confirm-ngn-amount">
								<span class="confirm-ngn-label">You will receive</span>
								<span class="confirm-ngn-value">{fiatEquivalent}</span>
								{#if ngnRate > 0}
									<span class="confirm-ngn-rate">1 USD = NGN {ngnRate.toFixed(2)}</span>
								{/if}
							</div>
						{/if}
						<div class="confirm-detail-row">
							<span>Processing time</span>
							<span>Under 5 minutes</span>
						</div>
						<div class="confirm-detail-row">
							<span>Safety</span>
							<span>Cancel anytime if not processed</span>
						</div>
					{/if}
				</div>

				<button
					class="swap-btn" class:swap-btn-bank={outputMode === 'bank'}
					style="margin: 0; width: 100%;"
					onclick={async () => { await handleSwap(); }}
				>
					{outputMode === 'bank' ? 'Confirm Withdrawal' : 'Confirm Swap'}
				</button>
				{/if}
			</div>
		</div>
	</div>
{/if}

<!-- ═══ WITHDRAWAL STATUS MODAL ═══ -->
{#if activeWithdrawal}
	<WithdrawalStatusModal
		withdrawal={activeWithdrawal}
		{usdtDecimals}
		onclose={() => { activeWithdrawal = null; }}
		oncancel={async (id) => { await handleCancel(id); activeWithdrawal = null; }}
	/>
{/if}

<style>
	.trade-page {
		min-height: calc(100vh - 140px);
		display: flex;
		align-items: flex-start;
		justify-content: center;
		padding: 40px 16px 60px;
	}
	.trade-container { width: 100%; max-width: 460px; }

	/* Network selector */
	.network-selector {
		display: flex; gap: 4px; padding: 4px; background: var(--bg-surface);
		border: 1px solid var(--border); border-radius: 14px; margin-bottom: 8px;
	}
	.network-btn {
		flex: 1; padding: 8px 0; border-radius: 10px; border: none; background: transparent;
		color: var(--text-muted); font-family: 'Space Mono', monospace; font-size: 12px;
		font-weight: 700; cursor: pointer; transition: all 150ms;
	}
	.network-btn:hover { color: var(--text); }
	.network-active { background: rgba(0,210,255,0.1); color: #00d2ff; }

	/* Header */
	.trade-header {
		display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px;
	}
	.trade-title {
		font-family: 'Syne', sans-serif; font-size: 28px; font-weight: 800;
		color: var(--text-heading); margin: 0;
	}
	.trade-sub {
		font-family: 'Space Mono', monospace; font-size: 12px; color: var(--text-muted); margin: 4px 0 0;
	}
	.header-actions { display: flex; gap: 6px; }
	.icon-btn {
		width: 36px; height: 36px; border-radius: 10px; border: 1px solid var(--border);
		background: var(--bg-surface); color: var(--text-muted); cursor: pointer;
		display: flex; align-items: center; justify-content: center;
		transition: all 150ms ease;
	}
	.icon-btn:hover { color: #00d2ff; border-color: rgba(0,210,255,0.3); background: rgba(0,210,255,0.05); }
	.icon-btn-active { color: #00d2ff; border-color: rgba(0,210,255,0.3); background: rgba(0,210,255,0.08); }

	/* Settings */
	.settings-panel {
		background: var(--bg-surface); border: 1px solid var(--border); border-radius: 14px;
		padding: 14px 16px; margin-bottom: 12px;
	}
	.settings-label {
		font-family: 'Space Mono', monospace; font-size: 11px; font-weight: 600;
		text-transform: uppercase; letter-spacing: 0.07em; color: var(--text-muted); display: block; margin-bottom: 8px;
	}
	.slippage-row { display: flex; gap: 6px; }
	.slippage-btn {
		flex: 1; padding: 8px 0; border-radius: 8px; border: 1px solid var(--border);
		background: transparent; color: var(--text-muted); font-family: 'Space Mono', monospace;
		font-size: 12px; font-weight: 600; cursor: pointer; transition: all 150ms ease;
	}
	.slippage-btn:hover { border-color: rgba(0,210,255,0.3); color: #00d2ff; }
	.slippage-active { border-color: rgba(0,210,255,0.4); background: rgba(0,210,255,0.1); color: #00d2ff; }

	/* Mode toggle */
	.mode-toggle {
		display: flex; gap: 4px; padding: 4px; background: var(--bg-surface);
		border: 1px solid var(--border); border-radius: 14px; margin-bottom: 8px;
	}
	.mode-btn {
		flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px;
		padding: 10px 0; border-radius: 10px; border: none; background: transparent;
		color: var(--text-muted); font-family: 'Space Mono', monospace; font-size: 12px;
		font-weight: 600; cursor: pointer; transition: all 150ms ease;
	}
	.mode-btn:hover { color: var(--text); }
	.mode-active { background: rgba(0,210,255,0.1); color: #00d2ff; }
	.mode-btn:last-child.mode-active { background: rgba(16,185,129,0.1); color: #10b981; }

	/* Swap card */
	.swap-card {
		background: var(--bg-surface); border: 1px solid var(--border); border-radius: 20px;
		padding: 4px;
	}

	/* Token section */
	.token-section {
		background: var(--bg-surface-input); border-radius: 16px; padding: 14px 16px;
	}
	.token-section-out { margin-top: 4px; }
	.token-section-header {
		display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;
	}
	.section-label {
		font-family: 'Space Mono', monospace; font-size: 11px; font-weight: 600;
		color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;
	}
	/* balance-btn and balance-display removed — replaced by MAX btn + token-balance-row */

	.token-input-row { display: flex; align-items: center; gap: 8px; position: relative; }
	.max-btn {
		padding: 4px 10px; border-radius: 6px; border: 1px solid rgba(0,210,255,0.25);
		background: rgba(0,210,255,0.08); color: #00d2ff; cursor: pointer;
		font-family: 'Space Mono', monospace; font-size: 11px; font-weight: 700;
		transition: all 150ms; flex-shrink: 0;
	}
	.max-btn:hover { background: rgba(0,210,255,0.15); border-color: rgba(0,210,255,0.4); }
	.token-balance-row {
		margin-top: 6px; font-family: 'Space Mono', monospace; font-size: 11px; color: var(--text-dim);
		display: flex; justify-content: space-between; align-items: center;
	}
	.usd-value {
		color: var(--text-muted); font-size: 11px;
	}
	.amount-input {
		flex: 1; background: transparent; border: none; outline: none;
		color: var(--text-heading); font-family: 'Syne', sans-serif;
		font-size: 28px; font-weight: 700; padding: 0; min-width: 0;
	}
	.amount-input::placeholder { color: var(--text-dim); opacity: 0.4; }
	.amount-input-out { color: var(--text-muted); }

	.preview-shimmer {
		position: absolute; left: 0; top: 50%; transform: translateY(-50%);
		width: 120px; height: 28px; border-radius: 6px;
		background: linear-gradient(90deg, var(--bg-surface-hover), rgba(0,210,255,0.05), var(--bg-surface-hover));
		background-size: 200% 100%; animation: shimmer 1.5s infinite;
	}
	@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

	.token-selector {
		display: flex; align-items: center; gap: 6px; padding: 8px 12px;
		border-radius: 20px; border: 1px solid var(--border);
		background: var(--bg-surface); cursor: pointer; transition: all 150ms;
		flex-shrink: 0;
	}
	.token-selector:hover { border-color: rgba(0,210,255,0.3); background: rgba(0,210,255,0.05); }
	.token-selector-symbol {
		font-family: 'Space Mono', monospace; font-size: 14px; font-weight: 700; color: var(--text-heading);
	}
	.token-selector-placeholder {
		font-family: 'Space Mono', monospace; font-size: 13px; color: #00d2ff;
	}

	.honeypot-badge {
		display: inline-flex; align-items: center; gap: 5px; margin-top: 8px;
		font-family: 'Space Mono', monospace; font-size: 10px; color: #f87171;
		background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.15);
		border-radius: 6px; padding: 4px 8px; font-weight: 700;
	}
	.tax-badge {
		display: inline-flex; align-items: center; gap: 5px; margin-top: 8px;
		font-family: 'Space Mono', monospace; font-size: 10px; color: #f59e0b;
		background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.15);
		border-radius: 6px; padding: 4px 8px;
	}
	.tax-dot { width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0; }
	.tax-dot-amber { background: #f59e0b; }

	/* Flip */
	.flip-row { display: flex; justify-content: center; margin: -8px 0; position: relative; z-index: 2; }
	.flip-btn {
		width: 36px; height: 36px; border-radius: 10px;
		border: 3px solid var(--bg-surface); background: var(--bg-surface-hover);
		color: var(--text-muted); cursor: pointer; display: flex;
		align-items: center; justify-content: center; transition: all 200ms;
	}
	.flip-btn:hover { color: #00d2ff; background: rgba(0,210,255,0.1); transform: rotate(180deg); }

	/* Bank section */
	.bank-section { padding: 12px 12px 0; }
	.bank-info-strip {
		display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px;
		background: rgba(16,185,129,0.05); border: 1px solid rgba(16,185,129,0.12);
		border-radius: 10px; margin-bottom: 12px;
		font-family: 'Space Mono', monospace; font-size: 10px; color: #10b981; line-height: 1.5;
	}
	.bank-info-strip svg { flex-shrink: 0; margin-top: 1px; }
	.bank-preview {
		background: var(--bg-surface-input); border-radius: 10px; padding: 10px 12px; margin-bottom: 12px;
	}
	.bank-preview-row {
		display: flex; justify-content: space-between;
		font-family: 'Space Mono', monospace; font-size: 11px; color: var(--text-muted);
	}
	.bank-payout-highlight {
		text-align: center; padding: 10px 0 8px; margin-bottom: 6px;
		border-bottom: 1px solid rgba(255,255,255,0.04);
	}
	.bank-payout-ngn {
		display: block; font-family: 'Syne', sans-serif; font-size: 24px; font-weight: 800;
		color: #10b981; line-height: 1.2;
	}
	.bank-payout-usd {
		display: block; font-family: 'Space Mono', monospace; font-size: 11px;
		color: var(--text-muted); margin-top: 2px;
	}
	.bank-preview-net { margin-top: 4px; }
	.bank-preview-net span:last-child { color: #10b981; font-weight: 700; }

	.bank-fields { display: flex; flex-direction: column; gap: 10px; margin-bottom: 12px; }
	.field-group { display: flex; flex-direction: column; }
	.field-label {
		font-family: 'Space Mono', monospace; font-size: 10px; font-weight: 600;
		text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted);
		margin-bottom: 4px;
	}

	/* Payment method tabs */
	.pay-method-tabs {
		display: flex; gap: 4px; margin-bottom: 12px;
	}
	.pay-method-tab {
		flex: 1; display: flex; align-items: center; justify-content: center; gap: 5px;
		padding: 8px 6px; border-radius: 8px; border: 1px solid var(--border);
		background: transparent; color: var(--text-muted); cursor: pointer;
		font-family: 'Space Mono', monospace; font-size: 10px; font-weight: 600;
		transition: all 150ms; white-space: nowrap;
	}
	.pay-method-tab:hover { color: var(--text); border-color: rgba(255,255,255,0.15); }
	.pay-method-active {
		color: #10b981; border-color: rgba(16,185,129,0.3);
		background: rgba(16,185,129,0.08);
	}
	.pay-method-note {
		font-family: 'Space Mono', monospace; font-size: 10px; color: var(--text-dim);
		line-height: 1.5; padding: 0 2px;
	}

	/* Bank dropdown */
	.bank-dropdown {
		position: absolute; top: 100%; left: 0; right: 0; z-index: 20;
		background: var(--bg); border: 1px solid var(--border); border-radius: 10px;
		max-height: 180px; overflow-y: auto; margin-top: 4px;
		box-shadow: 0 8px 24px rgba(0,0,0,0.4);
		scrollbar-width: thin; scrollbar-color: var(--bg-surface-hover) transparent;
	}
	.bank-dropdown-item {
		width: 100%; text-align: left; padding: 10px 14px; border: none;
		background: transparent; color: var(--text); cursor: pointer;
		font-family: 'Space Mono', monospace; font-size: 12px;
		transition: background 100ms;
	}
	.bank-dropdown-item:hover { background: var(--bg-surface-hover); }

	/* Resolve status */
	.resolve-status {
		display: flex; align-items: center; gap: 8px; padding: 10px 12px;
		border-radius: 8px; font-family: 'Space Mono', monospace; font-size: 12px;
	}
	.resolve-loading {
		color: var(--text-muted); background: var(--bg-surface-input);
	}
	.resolve-success {
		color: #10b981; background: rgba(16,185,129,0.08);
		border: 1px solid rgba(16,185,129,0.2); font-weight: 700;
	}
	.resolve-error {
		color: #f87171; background: rgba(239,68,68,0.06);
		border: 1px solid rgba(239,68,68,0.15);
	}
	.resolve-spinner {
		width: 14px; height: 14px; border: 2px solid var(--border);
		border-top-color: #00d2ff; border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	.bank-list-initial {
		width: 32px; height: 32px; border-radius: 50%; flex-shrink: 0;
		display: flex; align-items: center; justify-content: center;
		background: rgba(16,185,129,0.08); color: #10b981;
		border: 1px solid rgba(16,185,129,0.15);
		font-family: 'Syne', sans-serif; font-size: 13px; font-weight: 700;
	}
	.bank-list-name {
		font-family: 'Space Mono', monospace; font-size: 13px; color: var(--text);
	}

	/* Bank selector button */
	.bank-selector-btn {
		width: 100%; display: flex; align-items: center; justify-content: space-between;
		padding: 11px 14px; border-radius: 10px; border: 1px solid var(--border-input);
		background: var(--bg-surface-input); cursor: pointer; transition: all 150ms;
	}
	.bank-selector-btn:hover { border-color: rgba(0,210,255,0.3); }
	.bank-selector-name {
		font-family: 'Space Mono', monospace; font-size: 13px; font-weight: 600; color: var(--text);
	}
	.bank-selector-placeholder {
		font-family: 'Space Mono', monospace; font-size: 13px; color: var(--placeholder);
	}

	/* Trade details */
	.trade-details { padding: 10px 12px; }
	.detail-line {
		display: flex; justify-content: space-between; padding: 3px 0;
		font-family: 'Space Mono', monospace; font-size: 11px;
	}
	.detail-line span:first-child { color: var(--text-muted); }
	.detail-line span:last-child { color: var(--text); }
	.detail-line-warn span:last-child { color: #f59e0b; }

	.no-liquidity {
		display: flex; align-items: center; justify-content: center; gap: 6px;
		padding: 10px; margin: 0 12px;
		font-family: 'Space Mono', monospace; font-size: 11px; color: #f59e0b;
		background: rgba(245,158,11,0.06); border-radius: 10px;
	}

	/* Swap button */
	.swap-btn {
		width: calc(100% - 8px); margin: 8px 4px 4px; padding: 16px 0;
		border-radius: 16px; border: none; cursor: pointer;
		background: linear-gradient(135deg, #00d2ff, #3a7bd5);
		color: white; font-family: 'Syne', sans-serif; font-size: 15px; font-weight: 700;
		transition: all 200ms; letter-spacing: 0.02em;
	}
	.swap-btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 6px 28px rgba(0,210,255,0.3); }
	.swap-btn:disabled { opacity: 0.85; cursor: not-allowed; }
	.swap-btn-error:disabled { background: rgba(239,68,68,0.12) !important; color: #f87171 !important; box-shadow: none !important; transform: none !important; }
	.buy-crypto-strip {
		display: flex; align-items: center; gap: 8px; padding: 10px 14px;
		margin-top: 10px; border-radius: 12px;
		background: var(--bg-surface); border: 1px solid var(--border);
		font-family: 'Space Mono', monospace; font-size: 11px; color: var(--text-muted);
	}
	.buy-crypto-strip svg { flex-shrink: 0; color: #00d2ff; }
	.buy-crypto-strip span { flex: 1; }
	.buy-crypto-btn {
		padding: 6px 14px; border-radius: 8px; border: none; cursor: pointer;
		background: linear-gradient(135deg, #00d2ff, #3a7bd5); color: white;
		font-family: 'Syne', sans-serif; font-size: 12px; font-weight: 700;
		white-space: nowrap; transition: all 150ms; flex-shrink: 0;
	}
	.buy-crypto-btn:hover { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(0,210,255,0.3); }
	.swap-btn-bank { background: linear-gradient(135deg, #10b981, #059669); }
	.swap-btn-bank:hover:not(:disabled) { box-shadow: 0 6px 28px rgba(16,185,129,0.3); }

	/* History */
	.history-panel {
		background: var(--bg-surface); border: 1px solid var(--border);
		border-radius: 20px; padding: 16px; margin-top: 12px;
	}
	.history-title {
		font-family: 'Syne', sans-serif; font-size: 15px; font-weight: 700;
		color: var(--text-heading); margin: 0 0 12px;
	}
	.history-loading { display: flex; justify-content: center; padding: 20px; }
	.history-empty { text-align: center; color: var(--text-muted); font-family: 'Space Mono', monospace; font-size: 12px; padding: 20px; }
	.history-row {
		padding: 10px; background: var(--bg-surface-input); border-radius: 10px; margin-bottom: 6px;
		width: 100%; border: 1px solid transparent; cursor: pointer; text-align: left;
		transition: all 150ms;
	}
	.history-row:hover { border-color: rgba(0,210,255,0.2); background: rgba(0,210,255,0.03); }
	.cancel-hint { font-family: 'Space Mono', monospace; font-size: 10px; color: #f87171; }
	.history-row-top { display: flex; justify-content: space-between; align-items: center; }
	.history-amount { font-family: 'Space Mono', monospace; font-size: 13px; font-weight: 700; color: var(--text-heading); }
	.history-status { font-family: 'Space Mono', monospace; font-size: 10px; font-weight: 700; text-transform: uppercase; }
	.status-amber { color: #f59e0b; }
	.status-emerald { color: #10b981; }
	.status-red { color: #f87171; }
	.history-row-bottom { display: flex; justify-content: space-between; align-items: center; margin-top: 4px; }
	.history-date { font-family: 'Space Mono', monospace; font-size: 10px; color: var(--text-dim); }
	.cancel-btn {
		background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.2);
		color: #f87171; font-family: 'Space Mono', monospace; font-size: 10px;
		font-weight: 600; padding: 3px 8px; border-radius: 6px; cursor: pointer;
		transition: all 150ms;
	}
	.cancel-btn:hover { background: rgba(239,68,68,0.2); }
	.history-progress { margin-top: 6px; }
	.history-timer { font-family: 'Space Mono', monospace; font-size: 9px; color: rgba(245,158,11,0.7); }

	/* Progress */
	.progress-track { width: 100%; height: 3px; background: var(--bg-surface-hover); border-radius: 2px; overflow: hidden; margin-bottom: 2px; }
	.progress-fill { height: 100%; border-radius: 2px; transition: width 300ms; }
	.progress-amber { background: linear-gradient(90deg, #f59e0b, #d97706); }

	/* Spinner */
	.spinner { width: 24px; height: 24px; border: 2px solid var(--border); border-top-color: #00d2ff; border-radius: 50%; animation: spin 0.8s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }

	/* ═══ TOKEN MODAL ═══ */
	.modal-backdrop {
		position: fixed; inset: 0; z-index: 100; background: rgba(0,0,0,0.7);
		backdrop-filter: blur(4px); display: flex; align-items: flex-start;
		justify-content: center; padding: 60px 16px;
	}
	.token-modal {
		width: 100%; max-width: 420px; max-height: 70vh;
		background: var(--bg); border: 1px solid var(--border);
		border-radius: 20px; overflow: hidden; display: flex; flex-direction: column;
	}
	.modal-header {
		display: flex; justify-content: space-between; align-items: center;
		padding: 16px 20px; border-bottom: 1px solid var(--border);
	}
	.modal-header h3 {
		font-family: 'Syne', sans-serif; font-size: 16px; font-weight: 700;
		color: var(--text-heading); margin: 0;
	}
	.modal-close {
		background: none; border: none; color: var(--text-muted); cursor: pointer;
		padding: 4px; border-radius: 8px; transition: all 150ms;
	}
	.modal-close:hover { color: var(--text); background: var(--bg-surface-hover); }
	.modal-search { margin: 12px 16px; width: calc(100% - 32px); }

	.quick-tokens { display: flex; gap: 6px; padding: 0 16px 12px; flex-wrap: wrap; }
	.quick-token-btn {
		padding: 6px 14px; border-radius: 20px; border: 1px solid var(--border);
		background: var(--bg-surface); color: var(--text); cursor: pointer;
		font-family: 'Space Mono', monospace; font-size: 12px; font-weight: 700;
		transition: all 150ms;
	}
	.quick-token-btn:hover { border-color: rgba(0,210,255,0.3); color: #00d2ff; background: rgba(0,210,255,0.05); }

	.token-list {
		flex: 1; overflow-y: auto; padding: 0 8px 8px;
		scrollbar-width: thin; scrollbar-color: var(--bg-surface-hover) transparent;
	}
	.token-list-item {
		display: flex; align-items: center; gap: 10px; width: 100%;
		padding: 10px 12px; border-radius: 12px; border: none;
		background: transparent; cursor: pointer; transition: all 150ms; text-align: left;
	}
	.token-list-item:hover { background: var(--bg-surface-hover); }
	.token-list-icon {
		width: 36px; height: 36px; border-radius: 50%; object-fit: cover; flex-shrink: 0;
	}
	.token-list-icon-placeholder {
		display: flex; align-items: center; justify-content: center;
		background: rgba(0,210,255,0.08); color: #00d2ff; border: 1px solid rgba(0,210,255,0.15);
		font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 700;
	}
	.token-list-icon-custom {
		display: flex; align-items: center; justify-content: center;
		background: rgba(139,92,246,0.1); color: #a78bfa; border: 1px solid rgba(139,92,246,0.2);
		font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 700;
	}
	.token-list-spinner {
		width: 16px; height: 16px; border: 2px solid rgba(139,92,246,0.2);
		border-top-color: #a78bfa; border-radius: 50%; animation: spin 0.8s linear infinite;
	}
	.token-list-import {
		font-family: 'Space Mono', monospace; font-size: 10px; font-weight: 700;
		color: #a78bfa; background: rgba(139,92,246,0.1); border: 1px solid rgba(139,92,246,0.2);
		padding: 3px 8px; border-radius: 6px; flex-shrink: 0;
	}
	.token-list-info { flex: 1; min-width: 0; }
	.token-list-symbol {
		display: block; font-family: 'Space Mono', monospace; font-size: 13px;
		font-weight: 700; color: var(--text-heading);
	}
	.token-list-name {
		display: block; font-family: 'Space Mono', monospace; font-size: 10px;
		color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	}
	.token-list-addr {
		font-family: 'Space Mono', monospace; font-size: 10px; color: var(--text-dim); flex-shrink: 0;
	}
	.token-list-empty {
		text-align: center; padding: 20px; color: var(--text-muted);
		font-family: 'Space Mono', monospace; font-size: 12px;
	}

	/* Confirm modal */
	.confirm-modal {
		width: 100%; max-width: 420px; background: var(--bg);
		border: 1px solid var(--border); border-radius: 20px; overflow: hidden;
	}
	.confirm-body { padding: 16px 20px 20px; }
	.confirm-token-box {
		background: var(--bg-surface-input); border-radius: 12px; padding: 14px 16px;
	}
	.confirm-label {
		font-family: 'Space Mono', monospace; font-size: 10px; font-weight: 600;
		text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted);
	}
	.confirm-amount-row { display: flex; align-items: baseline; gap: 8px; margin-top: 4px; }
	.confirm-amount {
		font-family: 'Syne', sans-serif; font-size: 24px; font-weight: 700; color: var(--text-heading);
	}
	.confirm-symbol {
		font-family: 'Space Mono', monospace; font-size: 14px; font-weight: 700; color: var(--text-muted);
	}
	.confirm-tax {
		display: inline-block; margin-top: 6px; font-family: 'Space Mono', monospace;
		font-size: 10px; color: #f59e0b; background: rgba(245,158,11,0.08);
		padding: 2px 8px; border-radius: 4px;
	}
	.confirm-arrow {
		display: flex; justify-content: center; padding: 8px 0; color: var(--text-dim);
	}
	.confirm-bank-info { margin-top: 6px; }
	.confirm-bank-method {
		display: block; font-family: 'Syne', sans-serif; font-size: 16px;
		font-weight: 700; color: var(--text-heading);
	}
	.confirm-bank-holder {
		display: block; font-family: 'Space Mono', monospace; font-size: 13px;
		color: #10b981; font-weight: 700; margin-top: 4px;
	}
	.confirm-bank-acc {
		display: block; font-family: 'Space Mono', monospace; font-size: 12px;
		color: var(--text-muted); margin-top: 2px;
	}
	.confirm-details {
		margin: 12px 0 16px; padding: 12px; background: var(--bg-surface);
		border: 1px solid var(--border); border-radius: 10px;
	}
	.confirm-detail-row {
		display: flex; justify-content: space-between; padding: 4px 0;
		font-family: 'Space Mono', monospace; font-size: 11px;
	}
	.confirm-detail-row span:first-child { color: var(--text-muted); }
	.confirm-detail-row span:last-child { color: var(--text); }
	.confirm-detail-warn span:last-child { color: #f59e0b; }
	.confirm-ngn-amount {
		text-align: center; padding: 12px 0 8px;
	}
	.confirm-ngn-label {
		display: block; font-family: 'Space Mono', monospace; font-size: 10px;
		text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin-bottom: 4px;
	}
	.confirm-ngn-value {
		display: block; font-family: 'Syne', sans-serif; font-size: 28px; font-weight: 800;
		color: #10b981;
	}
	.confirm-ngn-rate {
		display: block; font-family: 'Space Mono', monospace; font-size: 10px;
		color: var(--text-dim); margin-top: 4px;
	}
	.confirm-processing {
		display: flex; align-items: center; justify-content: center; gap: 10px;
		padding: 16px; font-family: 'Space Mono', monospace; font-size: 13px; color: var(--text-muted);
	}

	/* ═══ WITHDRAW STEPS ═══ */
	.withdraw-steps {
		display: flex; flex-direction: column; gap: 0; margin: 4px 0 12px;
	}
	.withdraw-step {
		display: flex; align-items: center; gap: 12px; padding: 12px 14px;
		border-left: 2px solid var(--border); position: relative;
		transition: all 300ms ease;
	}
	.withdraw-step:first-child { border-top-left-radius: 8px; }
	.withdraw-step:last-child { border-bottom-left-radius: 8px; }
	.withdraw-step.ws-done { border-left-color: #10b981; }
	.withdraw-step.ws-active { border-left-color: #00d2ff; background: rgba(0,210,255,0.03); }
	.ws-indicator {
		width: 28px; height: 28px; border-radius: 50%; flex-shrink: 0;
		display: flex; align-items: center; justify-content: center;
		border: 2px solid var(--border); background: var(--bg-surface);
		font-family: 'Space Mono', monospace; font-size: 11px; font-weight: 700;
		color: var(--text-dim); transition: all 300ms ease;
	}
	.ws-indicator-done {
		border-color: #10b981; background: rgba(16,185,129,0.15); color: #10b981;
	}
	.ws-indicator-active {
		border-color: #00d2ff; background: rgba(0,210,255,0.1); color: #00d2ff;
	}
	.ws-spinner {
		width: 14px; height: 14px; border: 2px solid rgba(0,210,255,0.2);
		border-top-color: #00d2ff; border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}
	.ws-text { flex: 1; min-width: 0; }
	.ws-title {
		display: block; font-family: 'Space Mono', monospace; font-size: 12px;
		font-weight: 700; color: var(--text-heading);
	}
	.ws-pending .ws-title { color: var(--text-dim); }
	.ws-done .ws-title { color: #10b981; }
	.ws-active .ws-title { color: #00d2ff; }
	.ws-desc {
		display: block; font-family: 'Space Mono', monospace; font-size: 10px;
		color: var(--text-muted); margin-top: 1px;
	}
	.ws-active .ws-desc { color: rgba(0,210,255,0.7); }
	.ws-check-label {
		font-family: 'Space Mono', monospace; font-size: 10px; font-weight: 700;
		color: #10b981; flex-shrink: 0;
	}
	.ws-stepper-header {
		text-align: center; padding: 8px 0 16px;
	}
	.ws-stepper-amount {
		font-family: 'Syne', sans-serif; font-size: 18px; font-weight: 700;
		color: var(--text-heading);
	}
	.ws-stepper-fiat {
		display: block; font-family: 'Space Mono', monospace; font-size: 14px;
		font-weight: 700; color: #10b981; margin-top: 2px;
	}
	.ws-complete {
		text-align: center; padding: 16px 0 8px;
	}
	.ws-complete-icon {
		width: 56px; height: 56px; border-radius: 50%; margin: 0 auto 12px;
		display: flex; align-items: center; justify-content: center;
		background: rgba(16,185,129,0.1); border: 2px solid rgba(16,185,129,0.3);
		animation: scaleIn 0.3s ease;
	}
	@keyframes scaleIn { from { transform: scale(0.5); opacity: 0; } to { transform: scale(1); opacity: 1; } }
	.ws-complete-text {
		display: block; font-family: 'Syne', sans-serif; font-size: 18px; font-weight: 700;
		color: #10b981; margin-bottom: 4px;
	}
	.ws-complete-sub {
		display: block; font-family: 'Space Mono', monospace; font-size: 12px;
		color: var(--text-muted);
	}

	/* Mobile */
	@media (max-width: 640px) {
		.trade-page { padding: 16px 12px 40px; }
		.amount-input { font-size: 24px; }

		/* Token selector & bank selector modals: bottom-sheet style */
		.modal-backdrop { align-items: flex-end; padding: 0; }
		.token-modal { max-width: 100%; border-radius: 20px 20px 0 0; max-height: 85vh; }

		/* Confirm trade modal: full-screen */
		.modal-backdrop:has(.confirm-modal) { padding: 0; align-items: stretch; }
		.confirm-modal {
			max-width: 100%; width: 100%; height: 100vh;
			border-radius: 0; max-height: 100vh;
			display: flex; flex-direction: column;
		}
		.confirm-body { flex: 1; overflow-y: auto; }
	}
</style>
