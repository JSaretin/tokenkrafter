<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import { supabase } from '$lib/supabaseClient';

	const addFeedback = getContext<(f: { message: string; type: string }) => void>('addFeedback');

	type DefaultBase = { address: string; symbol: string; name?: string };

	let networks: any[] = $state([]);
	let site: any = $state({ name: '', description: '', support_email: '' });
	let socials: any = $state({});
	let loading = $state(true);
	let saving = $state(false);

	// New network form
	let showAddNetwork = $state(false);
	let newNetwork = $state({
		chain_id: '',
		name: '',
		symbol: '',
		native_coin: '',
		usdt_address: '',
		usdc_address: '',
		platform_address: '',
		launchpad_address: '',
		router_address: '',
		dex_router: '',
		trade_router_address: '',
		trade_lens_address: '',
		rpc: '',
		ws_rpc: '',
		daemon_rpc: '',
		explorer_url: '',
		gecko_network: '',
		default_bases: [] as DefaultBase[],
	});

	onMount(async () => {
		const { data } = await supabase
			.from('platform_config')
			.select('key, value')
			.in('key', ['networks', 'site', 'social_links']);

		for (const row of data || []) {
			if (row.key === 'networks') networks = row.value || [];
			else if (row.key === 'site') site = row.value || {};
			else if (row.key === 'social_links') socials = row.value || {};
		}
		loading = false;
	});

	async function saveConfig(key: string, value: any) {
		saving = true;
		try {
			const res = await fetch('/api/config', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ key, value })
			});

			if (!res.ok) {
				const err = await res.json().catch(() => ({ message: 'Save failed' }));
				throw new Error(err.message || 'Save failed');
			}

			addFeedback({ message: `${key} saved`, type: 'success' });
		} catch (e: any) {
			addFeedback({ message: e.message || 'Save failed', type: 'error' });
		} finally { saving = false; }
	}

	function addNetwork() {
		const net = {
			...newNetwork,
			chain_id: parseInt(newNetwork.chain_id) || 0
		};
		if (!net.chain_id || !net.name) {
			addFeedback({ message: 'Chain ID and name required', type: 'error' });
			return;
		}
		networks = [...networks, net];
		showAddNetwork = false;
		newNetwork = { chain_id: '', name: '', symbol: '', native_coin: '', usdt_address: '', usdc_address: '', platform_address: '', launchpad_address: '', router_address: '', dex_router: '', trade_router_address: '', trade_lens_address: '', rpc: '', ws_rpc: '', daemon_rpc: '', explorer_url: '', gecko_network: '', default_bases: [] };
	}

	function removeNetwork(idx: number) {
		networks = networks.filter((_: any, i: number) => i !== idx);
	}

	// ── Default bases editors ───────────────────────────────
	// Backs the create-wizard's pool-base multi-select. Each entry seeds
	// the token's `bases[]` at deploy time so the pool-lock gate covers
	// every default trading pair from block one — closes the grifter
	// vector where someone opens a WBNB pair at a malicious initial price
	// before the creator's real listing.

	function ensureBasesArr(net: any) {
		if (!Array.isArray(net.default_bases)) net.default_bases = [];
	}

	function addBaseRow(net: any) {
		ensureBasesArr(net);
		net.default_bases = [...net.default_bases, { address: '', symbol: '', name: '' }];
		networks = [...networks];
	}

	function removeBaseRow(net: any, idx: number) {
		ensureBasesArr(net);
		net.default_bases = net.default_bases.filter((_: any, i: number) => i !== idx);
		networks = [...networks];
	}

	function addNewNetworkBaseRow() {
		newNetwork.default_bases = [...newNetwork.default_bases, { address: '', symbol: '', name: '' }];
	}

	function removeNewNetworkBaseRow(idx: number) {
		newNetwork.default_bases = newNetwork.default_bases.filter((_, i) => i !== idx);
	}
</script>

{#if loading}
	<div class="card p-8 text-center">
		<div class="spinner mx-auto mb-3 w-6 h-6 rounded-full border-2 border-line border-t-brand-cyan"></div>
		<span class="text-gray-500 font-mono text-xs">Loading config...</span>
	</div>
{:else}
	<div class="space-y-6">
		<!-- Site Info -->
		<div class="card p-5">
			<h3 class="font-numeric text-lg font-semibold text-heading mb-4">Site Info</h3>
			<div class="space-y-3">
				<div>
					<label class="label-text">Site Name</label>
					<input class="input-field" bind:value={site.name} />
				</div>
				<div>
					<label class="label-text">Description</label>
					<textarea class="input-field" rows="2" bind:value={site.description}></textarea>
				</div>
				<div>
					<label class="label-text">Support Email</label>
					<input class="input-field" bind:value={site.support_email} />
				</div>
				<button class="btn-primary text-xs px-4 py-2 cursor-pointer" disabled={saving} onclick={() => saveConfig('site', site)}>
					{saving ? 'Saving...' : 'Save Site Info'}
				</button>
			</div>
		</div>

		<!-- Social Links -->
		<div class="card p-5">
			<h3 class="font-numeric text-lg font-semibold text-heading mb-4">Social Links</h3>
			<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
				<div>
					<label class="label-text">Twitter / X</label>
					<input class="input-field" placeholder="https://x.com/..." bind:value={socials.twitter} />
				</div>
				<div>
					<label class="label-text">Telegram Group</label>
					<input class="input-field" placeholder="https://t.me/..." bind:value={socials.telegram_group} />
				</div>
				<div>
					<label class="label-text">Telegram Channel</label>
					<input class="input-field" placeholder="https://t.me/..." bind:value={socials.telegram_channel} />
				</div>
				<div>
					<label class="label-text">Discord</label>
					<input class="input-field" placeholder="https://discord.gg/..." bind:value={socials.discord} />
				</div>
				<div>
					<label class="label-text">Facebook</label>
					<input class="input-field" placeholder="https://facebook.com/..." bind:value={socials.facebook} />
				</div>
				<div>
					<label class="label-text">YouTube</label>
					<input class="input-field" placeholder="https://youtube.com/..." bind:value={socials.youtube} />
				</div>
			</div>
			<button class="btn-primary text-xs px-4 py-2 mt-4 cursor-pointer" disabled={saving} onclick={() => saveConfig('social_links', socials)}>
				{saving ? 'Saving...' : 'Save Socials'}
			</button>
		</div>

		<!-- Networks -->
		<div class="card p-5">
			<div class="flex justify-between items-center mb-4">
				<h3 class="font-numeric text-lg font-semibold text-heading mb-0">Supported Networks ({networks.length})</h3>
				<button class="btn-primary text-xs px-3 py-1.5 cursor-pointer" onclick={() => (showAddNetwork = !showAddNetwork)}>
					{showAddNetwork ? 'Cancel' : '+ Add Network'}
				</button>
			</div>

			<!-- Add network form -->
			{#if showAddNetwork}
				<div class="mb-4 bg-surface-input border border-[rgba(0,210,255,0.15)] rounded-xl p-4">
					<div class="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-3">
						<div>
							<label class="label-text">Chain ID</label>
							<input class="input-field" type="number" placeholder="56" bind:value={newNetwork.chain_id} />
						</div>
						<div>
							<label class="label-text">Name</label>
							<input class="input-field" placeholder="BSC" bind:value={newNetwork.name} />
						</div>
						<div>
							<label class="label-text">Symbol</label>
							<input class="input-field" placeholder="BSC" bind:value={newNetwork.symbol} />
						</div>
						<div>
							<label class="label-text">Native Coin</label>
							<input class="input-field" placeholder="BNB" bind:value={newNetwork.native_coin} />
						</div>
						<div>
							<label class="label-text">RPC URL</label>
							<input class="input-field" placeholder="https://..." bind:value={newNetwork.rpc} />
						</div>
						<div>
							<label class="label-text">WS RPC URL (public — frontend)</label>
							<input class="input-field" placeholder="wss://..." bind:value={newNetwork.ws_rpc} />
						</div>
						<div>
							<label class="label-text">Daemon RPC (private — server only)</label>
							<input class="input-field" placeholder="wss://... or https://..." bind:value={newNetwork.daemon_rpc} />
						</div>
						<div>
							<label class="label-text">USDT Address</label>
							<input class="input-field" placeholder="0x..." bind:value={newNetwork.usdt_address} />
						</div>
						<div>
							<label class="label-text">USDC Address</label>
							<input class="input-field" placeholder="0x..." bind:value={newNetwork.usdc_address} />
						</div>
						<div>
							<label class="label-text">Token Factory</label>
							<input class="input-field" placeholder="0x..." bind:value={newNetwork.platform_address} />
						</div>
						<div>
							<label class="label-text">Launchpad Factory</label>
							<input class="input-field" placeholder="0x..." bind:value={newNetwork.launchpad_address} />
						</div>
						<div>
							<label class="label-text">Platform Router</label>
							<input class="input-field" placeholder="0x..." bind:value={newNetwork.router_address} />
						</div>
						<div>
							<label class="label-text">DEX Router</label>
							<input class="input-field" placeholder="0x..." bind:value={newNetwork.dex_router} />
						</div>
						<div>
							<label class="label-text">Trade Router</label>
							<input class="input-field" placeholder="0x..." bind:value={newNetwork.trade_router_address} />
						</div>
						<div>
							<label class="label-text">TradeLens</label>
							<input class="input-field" placeholder="0x..." bind:value={newNetwork.trade_lens_address} />
						</div>
						<div>
							<label class="label-text">Explorer URL</label>
							<input class="input-field" placeholder="https://bscscan.com" bind:value={newNetwork.explorer_url} />
						</div>
						<div>
							<label class="label-text">Gecko Network</label>
							<input class="input-field" placeholder="bsc" bind:value={newNetwork.gecko_network} />
						</div>
					</div>

					<!-- Default partner bases for the create wizard -->
					<div class="bases-editor mt-3">
						<div class="flex justify-between items-center mb-2">
							<span class="label-text mb-0">Default Pool Bases (pre-selected in wizard)</span>
							<button type="button" class="btn-secondary text-[10px] px-2 py-1 cursor-pointer" onclick={addNewNetworkBaseRow}>+ Add Base</button>
						</div>
						{#each newNetwork.default_bases as base, bi}
							<div class="grid grid-cols-12 gap-2 mb-2">
								<input class="input-field text-xs col-span-6" placeholder="0x... address" bind:value={base.address} />
								<input class="input-field text-xs col-span-2" placeholder="SYMBOL" bind:value={base.symbol} />
								<input class="input-field text-xs col-span-3" placeholder="Name (optional)" bind:value={base.name} />
								<button type="button" class="btn-danger text-[10px] col-span-1 cursor-pointer" onclick={() => removeNewNetworkBaseRow(bi)}>×</button>
							</div>
						{/each}
						{#if newNetwork.default_bases.length === 0}
							<p class="text-gray-500 text-[10px] font-mono">No bases. Wizard will only show on-chain custom adds.</p>
						{/if}
					</div>

					<button class="btn-primary text-xs px-4 py-2 cursor-pointer mt-3" onclick={addNetwork}>
						Add Network
					</button>
				</div>
			{/if}

			<!-- Existing networks -->
			{#each networks as net, i}
				<div class="mb-3 bg-surface-input border border-line rounded-[10px] p-3">
					<div class="flex justify-between items-center mb-2">
						<div>
							<span class="text-sm font-bold text-white font-mono">{net.name}</span>
							<span class="text-xs text-gray-500 font-mono ml-2">Chain {net.chain_id}</span>
							<span class="text-xs text-cyan-400 font-mono ml-2">{net.native_coin || net.symbol}</span>
						</div>
						<button class="btn-danger text-[10px] px-2 py-1 cursor-pointer" onclick={() => removeNetwork(i)}>
							Remove
						</button>
					</div>
					<div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
						<div>
							<label class="label-text text-[9px]">RPC</label>
							<input class="input-field text-xs" bind:value={net.rpc} />
						</div>
						<div>
							<label class="label-text text-[9px]">WS RPC (public)</label>
							<input class="input-field text-xs" placeholder="wss://..." bind:value={net.ws_rpc} />
						</div>
						<div>
							<label class="label-text text-[9px]">Daemon RPC (private)</label>
							<input class="input-field text-xs" placeholder="wss:// or https://..." bind:value={net.daemon_rpc} />
						</div>
						<div>
							<label class="label-text text-[9px]">USDT</label>
							<input class="input-field text-xs" bind:value={net.usdt_address} />
						</div>
						<div>
							<label class="label-text text-[9px]">Token Factory</label>
							<input class="input-field text-xs" bind:value={net.platform_address} />
						</div>
						<div>
							<label class="label-text text-[9px]">Launchpad</label>
							<input class="input-field text-xs" bind:value={net.launchpad_address} />
						</div>
						<div>
							<label class="label-text text-[9px]">Platform Router</label>
							<input class="input-field text-xs" bind:value={net.router_address} />
						</div>
						<div>
							<label class="label-text text-[9px]">Trade Router</label>
							<input class="input-field text-xs" bind:value={net.trade_router_address} />
						</div>
						<div>
							<label class="label-text text-[9px]">DEX Router</label>
							<input class="input-field text-xs" bind:value={net.dex_router} />
						</div>
						<div>
							<label class="label-text text-[9px]">USDC</label>
							<input class="input-field text-xs" bind:value={net.usdc_address} />
						</div>
						<div>
							<label class="label-text text-[9px]">TradeLens</label>
							<input class="input-field text-xs" bind:value={net.trade_lens_address} />
						</div>
						<div>
							<label class="label-text text-[9px]">Explorer URL</label>
							<input class="input-field text-xs" bind:value={net.explorer_url} />
						</div>
						<div>
							<label class="label-text text-[9px]">Gecko Network</label>
							<input class="input-field text-xs" bind:value={net.gecko_network} />
						</div>
					</div>

					<!-- Default partner bases editor -->
					<div class="bases-editor mt-3">
						<div class="flex justify-between items-center mb-2">
							<span class="label-text text-[9px] mb-0">Default Pool Bases ({(net.default_bases || []).length})</span>
							<button type="button" class="btn-secondary text-[10px] px-2 py-1 cursor-pointer" onclick={() => addBaseRow(net)}>+ Add Base</button>
						</div>
						{#each (net.default_bases || []) as base, bi}
							<div class="grid grid-cols-12 gap-2 mb-2">
								<input class="input-field text-xs col-span-6" placeholder="0x... address" bind:value={base.address} />
								<input class="input-field text-xs col-span-2" placeholder="SYMBOL" bind:value={base.symbol} />
								<input class="input-field text-xs col-span-3" placeholder="Name (optional)" bind:value={base.name} />
								<button type="button" class="btn-danger text-[10px] col-span-1 cursor-pointer" onclick={() => removeBaseRow(net, bi)}>×</button>
							</div>
						{/each}
						{#if !(net.default_bases?.length)}
							<p class="text-gray-500 text-[10px] font-mono">No bases configured</p>
						{/if}
					</div>
				</div>
			{/each}

			{#if networks.length === 0}
				<p class="text-gray-500 text-sm font-mono text-center py-4">No networks configured</p>
			{/if}

			<button class="btn-primary text-xs px-4 py-2 mt-2 cursor-pointer w-full" disabled={saving} onclick={() => saveConfig('networks', networks)}>
				{saving ? 'Saving...' : 'Save All Networks'}
			</button>
		</div>
	</div>
{/if}
