<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import { supabase } from '$lib/supabaseClient';
	import Skeleton from '$lib/Skeleton.svelte';
	import { SOCIAL_PLATFORMS, type Team, type Social, type SocialPlatform } from '$lib/team';

	const addFeedback = getContext<(f: { message: string; type: string }) => void>('addFeedback');

	type DefaultBase = { address: string; symbol: string; name?: string };

	let networks: any[] = $state([]);
	let site: any = $state({ name: '', description: '', support_email: '' });
	let socials: any = $state({});
	let team: Team[] = $state([]);
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
		affiliate_address: '',
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
			.in('key', ['networks', 'site', 'social_links', 'team']);

		for (const row of data || []) {
			if (row.key === 'networks') networks = row.value || [];
			else if (row.key === 'site') site = row.value || {};
			else if (row.key === 'social_links') socials = row.value || {};
			else if (row.key === 'team' && Array.isArray(row.value)) team = row.value as Team[];
		}
		loading = false;
	});

	// ── Team editor helpers ─────────────────────────────────────
	function addTeamMember() {
		team = [
			...team,
			{ name: '', title: '', about: '', socials: [] },
		];
	}

	function removeTeamMember(idx: number) {
		team = team.filter((_, i) => i !== idx);
	}

	function moveTeamMember(idx: number, dir: -1 | 1) {
		const swap = idx + dir;
		if (swap < 0 || swap >= team.length) return;
		const next = [...team];
		[next[idx], next[swap]] = [next[swap], next[idx]];
		team = next;
	}

	function addMemberSocial(idx: number) {
		const next = [...team];
		next[idx] = {
			...next[idx],
			socials: [...next[idx].socials, { platform: 'x', url: '' } as Social],
		};
		team = next;
	}

	function removeMemberSocial(memberIdx: number, socialIdx: number) {
		const next = [...team];
		next[memberIdx] = {
			...next[memberIdx],
			socials: next[memberIdx].socials.filter((_, i) => i !== socialIdx),
		};
		team = next;
	}

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
		newNetwork = { chain_id: '', name: '', symbol: '', native_coin: '', usdt_address: '', usdc_address: '', platform_address: '', launchpad_address: '', router_address: '', dex_router: '', trade_router_address: '', affiliate_address: '', rpc: '', ws_rpc: '', daemon_rpc: '', explorer_url: '', gecko_network: '', default_bases: [] };
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
	<!-- Skeleton mirrors site-info / socials / networks panels. -->
	<div class="space-y-6">
		{#each Array(3) as _}
			<div class="card p-5 flex flex-col gap-3">
				<Skeleton width={140} height="1.05rem" />
				{#each Array(3) as _}
					<div class="flex flex-col gap-1.5">
						<Skeleton width={80} height="0.7rem" />
						<Skeleton width="100%" height="2.5rem" radius="10px" />
					</div>
				{/each}
				<Skeleton width={140} height="2rem" radius="10px" />
			</div>
		{/each}
	</div>
{:else}
	<div class="space-y-6">
		<!-- Site Info -->
		<div class="card p-5">
			<h3 class="font-numeric text-lg font-semibold text-heading mb-4">Site Info</h3>
			<div class="space-y-3">
				<label class="block">
	<span class="label-text">Site Name</span>
	<input class="input-field" bind:value={site.name} />
</label>
				<label class="block">
	<span class="label-text">Description</span>
	<textarea class="input-field" rows="2" bind:value={site.description}></textarea>
</label>
				<label class="block">
	<span class="label-text">Support Email</span>
	<input class="input-field" bind:value={site.support_email} />
</label>
				<button class="btn-primary text-xs px-4 py-2 cursor-pointer" disabled={saving} onclick={() => saveConfig('site', site)}>
					{saving ? 'Saving...' : 'Save Site Info'}
				</button>
			</div>
		</div>

		<!-- Social Links — paired URL + optional Label override per channel.
		     Label override lets the operator replace the default footer
		     text (e.g. show plain "Telegram" instead of "Telegram Channel"
		     when there's only one Telegram presence). Empty URL hides
		     the channel entirely. Footer cache: edge holds the previous
		     row for up to a week — purge via Cloudflare to push instantly. -->
		<div class="card p-5">
			<h3 class="font-numeric text-lg font-semibold text-heading mb-4">Social Links</h3>
			<p class="text-3xs text-muted font-mono mb-4 leading-normal">
				URL is required for the channel to render. Label override is optional — leave blank to use the default name shown in the footer.
			</p>
			<div class="flex flex-col gap-4">
				{#each [
					{ key: 'twitter', defaultLabel: 'Twitter', urlPlaceholder: 'https://x.com/...' },
					{ key: 'telegram_group', defaultLabel: 'Telegram Group', urlPlaceholder: 'https://t.me/...' },
					{ key: 'telegram_channel', defaultLabel: 'Telegram Channel', urlPlaceholder: 'https://t.me/...' },
					{ key: 'discord', defaultLabel: 'Discord', urlPlaceholder: 'https://discord.gg/...' },
					{ key: 'facebook', defaultLabel: 'Facebook', urlPlaceholder: 'https://facebook.com/...' },
					{ key: 'youtube', defaultLabel: 'YouTube', urlPlaceholder: 'https://youtube.com/...' },
				] as s}
					<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
						<label class="block">
							<span class="label-text">{s.defaultLabel} — URL</span>
							<input class="input-field" placeholder={s.urlPlaceholder} bind:value={socials[s.key]} />
						</label>
						<label class="block">
							<span class="label-text">{s.defaultLabel} — Label override</span>
							<input class="input-field" placeholder={s.defaultLabel} bind:value={socials[`${s.key}_label`]} />
						</label>
					</div>
				{/each}
			</div>
			<button class="btn-primary text-xs px-4 py-2 mt-4 cursor-pointer" disabled={saving} onclick={() => saveConfig('social_links', socials)}>
				{saving ? 'Saving...' : 'Save Socials'}
			</button>
		</div>

		<!-- Team — roster shown on /team. Order in this list = render
		     order on the page. Each member has free-form name/title/about
		     and a list of socials (platform + url). The X social, if
		     present, drives the auto-loaded avatar. -->
		<div class="card p-5">
			<div class="flex justify-between items-center mb-4">
				<h3 class="font-numeric text-lg font-semibold text-heading mb-0">Team ({team.length})</h3>
				<button class="btn-primary text-xs px-3 py-1.5 cursor-pointer" onclick={addTeamMember}>+ Add Member</button>
			</div>
			<p class="text-3xs text-muted font-mono mb-4 leading-normal">
				Order here = order on the team page. The X social URL (if set) auto-loads each member's profile picture.
			</p>

			<div class="flex flex-col gap-4">
				{#each team as member, i (i)}
					<div class="bg-surface-input border border-line rounded-xl p-4">
						<div class="flex justify-between items-center mb-3">
							<span class="font-mono text-xs2 text-muted">Member {i + 1}</span>
							<div class="flex gap-1.5">
								<button class="btn-secondary text-3xs px-2 py-1 cursor-pointer" disabled={i === 0} onclick={() => moveTeamMember(i, -1)} title="Move up">↑</button>
								<button class="btn-secondary text-3xs px-2 py-1 cursor-pointer" disabled={i === team.length - 1} onclick={() => moveTeamMember(i, 1)} title="Move down">↓</button>
								<button class="btn-danger text-3xs px-2 py-1 cursor-pointer" onclick={() => removeTeamMember(i)} title="Remove">Remove</button>
							</div>
						</div>

						<div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
							<label class="block">
								<span class="label-text">Name</span>
								<input class="input-field" placeholder="Jane Doe" bind:value={team[i].name} />
							</label>
							<label class="block">
								<span class="label-text">Title</span>
								<input class="input-field" placeholder="Founder &amp; Lead Developer" bind:value={team[i].title} />
							</label>
						</div>

						<label class="block mb-3">
							<span class="label-text">About</span>
							<textarea class="input-field min-h-20 resize-y" placeholder="Short bio…" bind:value={team[i].about}></textarea>
						</label>

						<div class="border-t border-line pt-3">
							<div class="flex justify-between items-center mb-2">
								<span class="label-text mb-0">Socials</span>
								<button class="btn-secondary text-3xs px-2 py-1 cursor-pointer" onclick={() => addMemberSocial(i)}>+ Add Social</button>
							</div>

							{#if member.socials.length === 0}
								<p class="text-3xs text-dim font-mono italic m-0">No socials yet</p>
							{/if}

							<div class="flex flex-col gap-2">
								{#each member.socials as _social, j (j)}
									<div class="flex gap-2 items-center">
										<select class="input-field w-auto!" bind:value={team[i].socials[j].platform}>
											{#each SOCIAL_PLATFORMS as p}
												<option value={p}>{p}</option>
											{/each}
										</select>
										<input class="input-field flex-1" placeholder="https://..." bind:value={team[i].socials[j].url} />
										<button class="btn-danger text-3xs px-2 py-1 cursor-pointer shrink-0" onclick={() => removeMemberSocial(i, j)} title="Remove">×</button>
									</div>
								{/each}
							</div>
						</div>
					</div>
				{/each}
			</div>

			<button class="btn-primary text-xs px-4 py-2 mt-4 cursor-pointer" disabled={saving} onclick={() => saveConfig('team', team)}>
				{saving ? 'Saving...' : 'Save Team'}
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
						<label class="block">
	<span class="label-text">Chain ID</span>
	<input class="input-field" type="number" placeholder="56" bind:value={newNetwork.chain_id} />
</label>
						<label class="block">
	<span class="label-text">Name</span>
	<input class="input-field" placeholder="BSC" bind:value={newNetwork.name} />
</label>
						<label class="block">
	<span class="label-text">Symbol</span>
	<input class="input-field" placeholder="BSC" bind:value={newNetwork.symbol} />
</label>
						<label class="block">
	<span class="label-text">Native Coin</span>
	<input class="input-field" placeholder="BNB" bind:value={newNetwork.native_coin} />
</label>
						<label class="block">
	<span class="label-text">RPC URL</span>
	<input class="input-field" placeholder="https://..." bind:value={newNetwork.rpc} />
</label>
						<label class="block">
	<span class="label-text">WS RPC URL (public — frontend)</span>
	<input class="input-field" placeholder="wss://..." bind:value={newNetwork.ws_rpc} />
</label>
						<label class="block">
	<span class="label-text">Daemon RPC (private — server only)</span>
	<input class="input-field" placeholder="wss://... or https://..." bind:value={newNetwork.daemon_rpc} />
</label>
						<label class="block">
	<span class="label-text">USDT Address</span>
	<input class="input-field" placeholder="0x..." bind:value={newNetwork.usdt_address} />
</label>
						<label class="block">
	<span class="label-text">USDC Address</span>
	<input class="input-field" placeholder="0x..." bind:value={newNetwork.usdc_address} />
</label>
						<label class="block">
	<span class="label-text">Token Factory</span>
	<input class="input-field" placeholder="0x..." bind:value={newNetwork.platform_address} />
</label>
						<label class="block">
	<span class="label-text">Launchpad Factory</span>
	<input class="input-field" placeholder="0x..." bind:value={newNetwork.launchpad_address} />
</label>
						<label class="block">
	<span class="label-text">Platform Router</span>
	<input class="input-field" placeholder="0x..." bind:value={newNetwork.router_address} />
</label>
						<label class="block">
	<span class="label-text">DEX Router</span>
	<input class="input-field" placeholder="0x..." bind:value={newNetwork.dex_router} />
</label>
						<label class="block">
	<span class="label-text">Trade Router</span>
	<input class="input-field" placeholder="0x..." bind:value={newNetwork.trade_router_address} />
</label>
						<label class="block">
	<span class="label-text">Affiliate</span>
	<input class="input-field" placeholder="0x..." bind:value={newNetwork.affiliate_address} />
</label>
						<label class="block">
	<span class="label-text">Explorer URL</span>
	<input class="input-field" placeholder="https://bscscan.com" bind:value={newNetwork.explorer_url} />
</label>
						<label class="block">
	<span class="label-text">Gecko Network</span>
	<input class="input-field" placeholder="bsc" bind:value={newNetwork.gecko_network} />
</label>
					</div>

					<!-- Default partner bases for the create wizard -->
					<div class="bases-editor mt-3">
						<div class="flex justify-between items-center mb-2">
							<span class="label-text mb-0">Default Pool Bases (pre-selected in wizard)</span>
							<button type="button" class="btn-secondary text-3xs px-2 py-1 cursor-pointer" onclick={addNewNetworkBaseRow}>+ Add Base</button>
						</div>
						{#each newNetwork.default_bases as base, bi}
							<div class="grid grid-cols-12 gap-2 mb-2">
								<input class="input-field text-xs col-span-6" placeholder="0x... address" bind:value={base.address} />
								<input class="input-field text-xs col-span-2" placeholder="SYMBOL" bind:value={base.symbol} />
								<input class="input-field text-xs col-span-3" placeholder="Name (optional)" bind:value={base.name} />
								<button type="button" class="btn-danger text-3xs col-span-1 cursor-pointer" onclick={() => removeNewNetworkBaseRow(bi)}>×</button>
							</div>
						{/each}
						{#if newNetwork.default_bases.length === 0}
							<p class="text-gray-500 text-3xs font-mono">No bases. Wizard will only show on-chain custom adds.</p>
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
						<button class="btn-danger text-3xs px-2 py-1 cursor-pointer" onclick={() => removeNetwork(i)}>
							Remove
						</button>
					</div>
					<div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
						<label class="block">
	<span class="label-text text-xs4">RPC</span>
	<input class="input-field text-xs" bind:value={net.rpc} />
</label>
						<label class="block">
	<span class="label-text text-xs4">WS RPC (public)</span>
	<input class="input-field text-xs" placeholder="wss://..." bind:value={net.ws_rpc} />
</label>
						<label class="block">
	<span class="label-text text-xs4">Daemon RPC (private)</span>
	<input class="input-field text-xs" placeholder="wss:// or https://..." bind:value={net.daemon_rpc} />
</label>
						<label class="block">
	<span class="label-text text-xs4">USDT</span>
	<input class="input-field text-xs" bind:value={net.usdt_address} />
</label>
						<label class="block">
	<span class="label-text text-xs4">Token Factory</span>
	<input class="input-field text-xs" bind:value={net.platform_address} />
</label>
						<label class="block">
	<span class="label-text text-xs4">Launchpad</span>
	<input class="input-field text-xs" bind:value={net.launchpad_address} />
</label>
						<label class="block">
	<span class="label-text text-xs4">Platform Router</span>
	<input class="input-field text-xs" bind:value={net.router_address} />
</label>
						<label class="block">
	<span class="label-text text-xs4">Trade Router</span>
	<input class="input-field text-xs" bind:value={net.trade_router_address} />
</label>
						<label class="block">
	<span class="label-text text-xs4">DEX Router</span>
	<input class="input-field text-xs" bind:value={net.dex_router} />
</label>
						<label class="block">
	<span class="label-text text-xs4">USDC</span>
	<input class="input-field text-xs" bind:value={net.usdc_address} />
</label>
						<label class="block">
	<span class="label-text text-xs4">Affiliate</span>
	<input class="input-field text-xs" bind:value={net.affiliate_address} />
</label>
						<label class="block">
	<span class="label-text text-xs4">Explorer URL</span>
	<input class="input-field text-xs" bind:value={net.explorer_url} />
</label>
						<label class="block">
	<span class="label-text text-xs4">Gecko Network</span>
	<input class="input-field text-xs" bind:value={net.gecko_network} />
</label>
					</div>

					<!-- Default partner bases editor -->
					<div class="bases-editor mt-3">
						<div class="flex justify-between items-center mb-2">
							<span class="label-text text-xs4 mb-0">Default Pool Bases ({(net.default_bases || []).length})</span>
							<button type="button" class="btn-secondary text-3xs px-2 py-1 cursor-pointer" onclick={() => addBaseRow(net)}>+ Add Base</button>
						</div>
						{#each (net.default_bases || []) as base, bi}
							<div class="grid grid-cols-12 gap-2 mb-2">
								<input class="input-field text-xs col-span-6" placeholder="0x... address" bind:value={base.address} />
								<input class="input-field text-xs col-span-2" placeholder="SYMBOL" bind:value={base.symbol} />
								<input class="input-field text-xs col-span-3" placeholder="Name (optional)" bind:value={base.name} />
								<button type="button" class="btn-danger text-3xs col-span-1 cursor-pointer" onclick={() => removeBaseRow(net, bi)}>×</button>
							</div>
						{/each}
						{#if !(net.default_bases?.length)}
							<p class="text-gray-500 text-3xs font-mono">No bases configured</p>
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
