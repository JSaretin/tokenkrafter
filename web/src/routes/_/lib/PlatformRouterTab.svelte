<script lang="ts">
	import { getContext } from 'svelte';
	import { ethers } from 'ethers';
	import type { SupportedNetwork } from '$lib/structure';
	import { ERC20_DECIMALS_ABI } from '$lib/commonABIs';
	import { ZERO_ADDRESS } from '$lib/tokenCrafter';
	import { friendlyError } from '$lib/errorDecoder';
	import Skeleton from '$lib/Skeleton.svelte';

	// Narrow ABI — just the admin surface + read helpers. PlatformRouter has
	// no getState() aggregator, so we call individual getters.
	const PLATFORM_ROUTER_ADMIN_ABI = [
		'function owner() view returns (address)',
		'function paused() view returns (bool)',
		'function minLiquidity() view returns (uint256)',
		'function pause() external',
		'function unpause() external',
		'function setMinLiquidity(uint256 amount) external',
		'function withdrawStuckTokens(address token) external',
	] as const;

	let { selectedNetwork }: { selectedNetwork: SupportedNetwork } = $props();

	const addFeedback = getContext<(f: { message: string; type: string }) => void>('addFeedback');
	let getSigner: () => ethers.Signer | null = getContext('signer');
	let getNetworkProviders: () => Map<number, ethers.JsonRpcProvider> = getContext('networkProviders');
	let signer = $derived(getSigner());
	let networkProviders = $derived(getNetworkProviders());

	// State
	let loading = $state(false);
	let owner = $state('');
	let isOwner = $state(false);
	let isPaused = $state(false);
	let minLiquidity = $state(0n);
	let usdtDecimals = $state(18);

	// Form state
	let newMinLiquidity = $state('');
	let stuckToken = $state('');
	let processing = $state(false);

	async function loadData() {
		if (!selectedNetwork?.router_address || selectedNetwork.router_address === '0x') return;
		loading = true;
		try {
			const provider = networkProviders.get(selectedNetwork.chain_id);
			if (!provider) return;
			const router = new ethers.Contract(
				selectedNetwork.router_address,
				PLATFORM_ROUTER_ADMIN_ABI,
				provider,
			);

			const [o, p, ml] = await Promise.all([
				router.owner(),
				router.paused(),
				router.minLiquidity(),
			]);

			owner = o;
			isPaused = p;
			minLiquidity = ml;

			// Resolve USDT decimals so we can display minLiquidity in human terms
			// when the admin is threshold-ing on USDT liquidity.
			if (selectedNetwork.usdt_address) {
				try {
					const usdtC = new ethers.Contract(
						selectedNetwork.usdt_address,
						ERC20_DECIMALS_ABI,
						provider,
					);
					usdtDecimals = Number(await usdtC.decimals());
				} catch {}
			}

			const userAddr = signer ? await (signer as any).getAddress() : '';
			isOwner = userAddr ? userAddr.toLowerCase() === owner.toLowerCase() : false;

			newMinLiquidity = ethers.formatUnits(minLiquidity, usdtDecimals);
		} catch (e: any) {
			addFeedback({ message: friendlyError(e), type: 'error' });
		} finally {
			loading = false;
		}
	}

	async function execTx(label: string, fn: (r: any) => Promise<any>) {
		if (!signer) {
			addFeedback({ message: 'Connect wallet', type: 'error' });
			return;
		}
		processing = true;
		try {
			addFeedback({ message: `${label}...`, type: 'info' });
			const router = new ethers.Contract(
				selectedNetwork.router_address,
				PLATFORM_ROUTER_ADMIN_ABI,
				signer,
			);
			const tx = await fn(router);
			await tx.wait();
			addFeedback({ message: `${label} done`, type: 'success' });
			await loadData();
		} catch (e) {
			addFeedback({ message: friendlyError(e), type: 'error' });
		} finally {
			processing = false;
		}
	}

	$effect(() => {
		if (selectedNetwork?.router_address) loadData();
	});
</script>

{#if loading}
	<!-- Skeleton mirrors the admin tab layout: status-grid + 3 setting cards. -->
	<div class="space-y-4">
		<div class="card p-4 flex flex-col gap-3">
			<Skeleton width={140} height="0.95rem" />
			<div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
				{#each Array(3) as _}
					<div class="bg-white/[0.02] border border-line rounded-lg py-2.5 px-3 flex flex-col gap-2">
						<Skeleton width="55%" height="0.7rem" />
						<Skeleton width="75%" height="1rem" />
					</div>
				{/each}
			</div>
		</div>
		{#each Array(3) as _}
			<div class="card p-4 flex flex-col gap-2">
				<Skeleton width={160} height="0.95rem" />
				<Skeleton width="100%" height="0.75rem" />
				<Skeleton width="80%" height="0.75rem" />
				<div class="flex gap-2 pt-1">
					<Skeleton width="100%" height="2.25rem" radius="10px" />
				</div>
			</div>
		{/each}
	</div>
{:else if !selectedNetwork?.router_address || selectedNetwork.router_address === '0x'}
	<div class="card p-8 text-center">
		<p class="text-gray-400">No PlatformRouter deployed on this network</p>
	</div>
{:else if !isOwner}
	<div class="card p-8 text-center">
		<p class="text-gray-400 mb-2">Only the PlatformRouter owner can manage settings</p>
		<p class="text-xs text-gray-600 font-mono">Owner: {owner}</p>
	</div>
{:else}
	<div class="space-y-4">
		<!-- Status Overview -->
		<div class="card p-4">
			<h3 class="text-white text-sm font-semibold mb-3">PlatformRouter Status</h3>
			<div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
				<div class="bg-white/[0.02] border border-line rounded-lg py-2.5 px-3">
					<span class="block text-3xs font-mono text-dim uppercase tracking-[0.05em]">Status</span>
					<span
						class={'block text-sm font-bold font-mono mt-0.5 ' + (isPaused ? 'text-red-400' : 'text-emerald-400')}
					>
						{isPaused ? 'PAUSED' : 'ACTIVE'}
					</span>
				</div>
				<div class="bg-white/[0.02] border border-line rounded-lg py-2.5 px-3">
					<span class="block text-3xs font-mono text-dim uppercase tracking-[0.05em]">Min Liquidity</span>
					<span class="block text-sm font-bold font-mono mt-0.5 text-cyan-400">
						{minLiquidity > 0n
							? parseFloat(ethers.formatUnits(minLiquidity, usdtDecimals)).toLocaleString()
							: 'disabled'}
					</span>
				</div>
				<div class="bg-white/[0.02] border border-line rounded-lg py-2.5 px-3">
					<span class="block text-3xs font-mono text-dim uppercase tracking-[0.05em]">Address</span>
					<span class="block text-xs font-bold font-mono mt-0.5 text-gray-400">
						{selectedNetwork.router_address.slice(0, 6)}…{selectedNetwork.router_address.slice(-4)}
					</span>
				</div>
			</div>
		</div>

		<!-- Pause / Unpause -->
		<div class="card p-4">
			<h3 class="text-white text-sm font-semibold mb-2">Emergency Pause</h3>
			<p class="text-xs text-gray-500 font-mono mb-3">
				Halts all token creation and listing through the router. Use only for incident response.
			</p>
			<div class="flex gap-2">
				{#if isPaused}
					<button
						class="btn-primary text-xs px-4 py-2 cursor-pointer flex-1"
						disabled={processing}
						onclick={() => execTx('Unpause', (r: any) => r.unpause())}
					>
						Unpause
					</button>
				{:else}
					<button
						class="btn-danger text-xs px-4 py-2 cursor-pointer flex-1"
						disabled={processing}
						onclick={() => execTx('Pause', (r: any) => r.pause())}
					>
						Pause Router
					</button>
				{/if}
			</div>
		</div>

		<!-- Min Liquidity -->
		<div class="card p-4">
			<h3 class="text-white text-sm font-semibold mb-2">Min Liquidity</h3>
			<p class="text-xs text-gray-500 font-mono mb-3">
				Minimum base-token amount required per pool when seeding liquidity. Set to 0 to disable the
				floor.
			</p>
			<div class="flex gap-2">
				<input
					class="input-field flex-1"
					type="number"
					min="0"
					step="any"
					bind:value={newMinLiquidity}
					placeholder="0"
				/>
				<button
					class="btn-primary text-xs px-4 py-2 cursor-pointer whitespace-nowrap"
					disabled={processing || newMinLiquidity === ''}
					onclick={() => {
						const amount = ethers.parseUnits(String(newMinLiquidity || '0'), usdtDecimals);
						return execTx('Set min liquidity', (r: any) => r.setMinLiquidity(amount));
					}}
				>
					Update
				</button>
			</div>
		</div>

		<!-- Stuck token rescue -->
		<div class="card p-4">
			<h3 class="text-white text-sm font-semibold mb-2">Rescue Stuck Tokens</h3>
			<p class="text-xs text-gray-500 font-mono mb-3">
				Recover tokens accidentally sent to the router. Pass the zero address to sweep native coin.
				Funds go to the router owner.
			</p>
			<div class="flex gap-2">
				<input
					class="input-field flex-1"
					type="text"
					placeholder="0x... (blank = native coin)"
					bind:value={stuckToken}
				/>
				<button
					class="btn-primary text-xs px-4 py-2 cursor-pointer whitespace-nowrap"
					disabled={processing}
					onclick={() =>
						execTx('Rescue stuck tokens', (r: any) =>
							r.withdrawStuckTokens(stuckToken.trim() === '' ? ZERO_ADDRESS : stuckToken.trim()),
						)}
				>
					Rescue
				</button>
			</div>
		</div>
	</div>
{/if}
