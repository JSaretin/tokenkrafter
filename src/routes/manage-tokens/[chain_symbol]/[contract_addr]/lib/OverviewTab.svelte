<script lang="ts">
	import { t } from '$lib/i18n';
	import { chainSlug, type SupportedNetwork } from '$lib/structure';
	import { fmtSupply, shortAddr } from '$lib/formatters';

	type TokenSummary = {
		name: string;
		symbol: string;
		totalSupply: string;
		decimals: number;
		owner?: string;
		isMintable?: boolean;
		isTaxable?: boolean;
		isPartner?: boolean;
	};

	let {
		tokenInfo,
		network,
		contractAddress,
		launchpadChecked,
		launchAddress,
		isOwner,
		tokenAliasLoaded,
		tokenAlias,
		tokenAliasInput = $bindable(''),
		tokenAliasSaving,
		onSaveTokenAlias,
	}: {
		tokenInfo: TokenSummary;
		network: SupportedNetwork | null | undefined;
		contractAddress: string;
		launchpadChecked: boolean;
		launchAddress: string | null;
		isOwner: boolean;
		tokenAliasLoaded: boolean;
		tokenAlias: string;
		tokenAliasInput: string;
		tokenAliasSaving: boolean;
		onSaveTokenAlias: () => void;
	} = $props();
</script>

<div class="panel">
	<h3 class="syne text-lg font-bold text-white mb-4">{$t('mt.tokenInfo')}</h3>
	<div class="info-table">
		{#each [
			[$t('mt.name'), tokenInfo.name],
			[$t('mt.symbol'), tokenInfo.symbol],
			[$t('mt.totalSupply'), fmtSupply(tokenInfo.totalSupply, tokenInfo.decimals) + ' ' + tokenInfo.symbol],
			[$t('mt.decimals'), String(tokenInfo.decimals)],
			[$t('mt.network'), network?.name ?? 'Unknown'],
			[$t('mt.mintable'), tokenInfo.isMintable !== undefined ? (tokenInfo.isMintable ? $t('mt.yes') : $t('mt.no')) : $t('mt.na')],
			[$t('mt.taxable'), tokenInfo.isTaxable !== undefined ? (tokenInfo.isTaxable ? $t('mt.yes') : $t('mt.no')) : $t('mt.na')],
			[$t('mt.partner'), tokenInfo.isPartner !== undefined ? (tokenInfo.isPartner ? $t('mt.yes') : $t('mt.no')) : $t('mt.na')],
			...(tokenInfo.owner ? [[$t('mt.owner'), shortAddr(tokenInfo.owner)]] : [])
		] as [label, value]}
			<div class="info-row">
				<span class="info-key">{label}</span>
				<span class="info-val font-mono">{value}</span>
			</div>
		{/each}
	</div>
</div>

<!-- Launchpad Section -->
{#if launchpadChecked}
	<div class="panel mt-4">
		<h3 class="syne text-lg font-bold text-white mb-3">{$t('mt.launchpad')}</h3>
		{#if launchAddress}
			<div class="launchpad-status launchpad-exists">
				<div class="flex items-center gap-3">
					<span class="w-2.5 h-2.5 rounded-full bg-emerald-400 shrink-0"></span>
					<div>
						<p class="text-sm text-white font-mono">{$t('mt.launchpadExists')}</p>
						<p class="text-xs text-gray-500 font-mono mt-0.5">{launchAddress.slice(0, 10)}...{launchAddress.slice(-8)}</p>
					</div>
				</div>
				<a href="/launchpad/{chainSlug(network?.chain_id ?? 56)}/{launchAddress}" class="btn-primary text-xs px-4 py-2 no-underline shrink-0">
					{$t('mt.viewLaunchpad')} →
				</a>
			</div>
		{:else if isOwner}
			<div class="launchpad-status launchpad-create">
				<div class="flex items-center gap-3">
					<span class="w-2.5 h-2.5 rounded-full bg-gray-600 shrink-0"></span>
					<div>
						<p class="text-sm text-white font-mono">{$t('mt.noLaunchpad')}</p>
						<p class="text-xs text-gray-500 font-mono mt-0.5">{$t('mt.noLaunchpadDesc')}</p>
					</div>
				</div>
				<a href="/create?launch=true&token={contractAddress}&chain={network?.symbol}" class="nav-cta no-underline shrink-0 text-xs">
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
					{$t('mt.createLaunchpad')}
				</a>
			</div>
		{:else}
			<div class="launchpad-status">
				<div class="flex items-center gap-3">
					<span class="w-2.5 h-2.5 rounded-full bg-gray-600 shrink-0"></span>
					<p class="text-sm text-gray-500 font-mono">{$t('mt.noLaunchpad')}</p>
				</div>
			</div>
		{/if}
	</div>
{/if}

<!-- Token Alias -->
{#if tokenAliasLoaded && isOwner}
	<div class="panel mt-4">
		<h3 class="syne text-lg font-bold text-white mb-3">Token Alias</h3>
		<p class="text-gray-400 text-xs font-mono mb-3">
			Set a short alias for your token. Share trade links like <span class="text-cyan-400">/trade?token={tokenAliasInput || 'mytoken'}</span>
		</p>
		<div class="flex items-center gap-2">
			<input
				type="text"
				class="input-field flex-1 text-sm"
				placeholder="e.g. mytoken"
				bind:value={tokenAliasInput}
				maxlength="30"
			/>
			<button
				class="btn-primary text-xs px-4 py-2.5 shrink-0"
				onclick={onSaveTokenAlias}
				disabled={tokenAliasSaving || !tokenAliasInput.trim() || tokenAliasInput.trim() === tokenAlias}
			>
				{#if tokenAliasSaving}
					Saving...
				{:else if tokenAlias}
					Update Alias
				{:else}
					Set Alias
				{/if}
			</button>
		</div>
		{#if tokenAlias}
			<p class="text-emerald-400 text-xs font-mono mt-2">
				Current alias: <span class="text-white">{tokenAlias}</span>
			</p>
		{/if}
	</div>
{:else if tokenAliasLoaded && tokenAlias}
	<div class="panel mt-4">
		<h3 class="syne text-lg font-bold text-white mb-3">Token Alias</h3>
		<p class="text-gray-400 text-xs font-mono">
			Alias: <span class="text-cyan-400">{tokenAlias}</span> — <a href="/trade?token={tokenAlias}" class="text-cyan-400 underline">Trade link</a>
		</p>
	</div>
{/if}
