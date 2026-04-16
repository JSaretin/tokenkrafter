<script lang="ts">
	import { t } from '$lib/i18n';

	type ProtectionTokenInfo = {
		symbol: string;
		tradingEnabled?: boolean;
		maxWalletAmount?: string;
		maxTransactionAmount?: string;
		cooldownTime?: number;
		blacklistWindow?: number;
		tradingEnabledAt?: number;
	};

	let {
		tokenInfo,
		isOwner,
		actionLoading,
		maxWalletInput = $bindable(''),
		maxTxInput = $bindable(''),
		cooldownInput = $bindable(''),
		blacklistWindowInput = $bindable(''),
		blacklistAddrInput = $bindable(''),
		blacklistAction = $bindable(true),
		blacklistCheckAddr = $bindable(''),
		blacklistCheckResult,
		excludeLimitsAddrInput = $bindable(''),
		excludeLimitsAction = $bindable(true),
		excludedCheckAddr = $bindable(''),
		excludedCheckResult,
		tradingDelay = $bindable(0),
		onEnableTrading,
		onSetMaxWallet,
		onSetMaxTx,
		onSetCooldown,
		onSetBlacklistWindow,
		onSetBlacklisted,
		onSetExcludedFromLimits,
		onCheckBlacklist,
		onCheckExcluded,
	}: {
		tokenInfo: ProtectionTokenInfo;
		isOwner: boolean;
		actionLoading: boolean;
		maxWalletInput: string;
		maxTxInput: string;
		cooldownInput: string;
		blacklistWindowInput: string;
		blacklistAddrInput: string;
		blacklistAction: boolean;
		blacklistCheckAddr: string;
		blacklistCheckResult: boolean | null;
		excludeLimitsAddrInput: string;
		excludeLimitsAction: boolean;
		excludedCheckAddr: string;
		excludedCheckResult: boolean | null;
		tradingDelay: number;
		onEnableTrading: () => void;
		onSetMaxWallet: () => void;
		onSetMaxTx: () => void;
		onSetCooldown: () => void;
		onSetBlacklistWindow: () => void;
		onSetBlacklisted: () => void;
		onSetExcludedFromLimits: () => void;
		onCheckBlacklist: () => void;
		onCheckExcluded: () => void;
	} = $props();
</script>

<div class="panel">
	<div class="panel-header">
		<div>
			<h3 class="syne text-lg font-bold text-white">{$t('mt.tokenProtection')}</h3>
			<p class="text-sm text-gray-500 font-mono mt-1">
				{$t('mt.protectionDesc')}
			</p>
		</div>
		{#if tokenInfo.tradingEnabled}
			<span class="badge badge-emerald">{$t('mt.tradingLive')}</span>
		{:else}
			<span class="badge badge-amber">{$t('mt.preTrading')}</span>
		{/if}
	</div>

	{#if !tokenInfo.tradingEnabled}
		<div class="protection-notice mb-4">
			<span class="text-cyan-400 text-xs font-mono font-bold">{$t('mt.preTradingMode')}</span>
			<span class="text-gray-400 text-xs font-mono">
				{$t('mt.preTradingDesc')}
			</span>
		</div>
	{:else}
		<div class="protection-notice relax-only mb-4">
			<span class="text-emerald-400 text-xs font-mono font-bold">{$t('mt.tradingIsLive')}</span>
			<span class="text-gray-400 text-xs font-mono">
				{$t('mt.tradingIsLiveDesc')}
			</span>
		</div>
	{/if}

	<!-- Current Status -->
	<div class="sub-panel mb-4">
		<h4 class="syne text-sm font-bold text-white mb-3">{$t('mt.currentSettings')}</h4>
		<div class="flex flex-col gap-2">
			<div class="protection-stat-row">
				<span class="text-gray-500 text-xs font-mono">{$t('mt.trading')}</span>
				<span class="text-xs font-mono {tokenInfo.tradingEnabled ? 'text-emerald-400' : 'text-amber-400'}">
					{tokenInfo.tradingEnabled ? $t('mt.enabled') : $t('mt.notEnabled')}
				</span>
			</div>
			<div class="protection-stat-row">
				<span class="text-gray-500 text-xs font-mono">{$t('mt.maxWallet')}</span>
				<span class="text-xs font-mono {Number(tokenInfo.maxWalletAmount ?? 0) > 0 ? 'text-cyan-300' : 'text-gray-600'}">
					{Number(tokenInfo.maxWalletAmount ?? 0) > 0 ? `${Number(tokenInfo.maxWalletAmount).toLocaleString()} ${tokenInfo.symbol}` : $t('mt.noLimit')}
				</span>
			</div>
			<div class="protection-stat-row">
				<span class="text-gray-500 text-xs font-mono">{$t('mt.maxTransaction')}</span>
				<span class="text-xs font-mono {Number(tokenInfo.maxTransactionAmount ?? 0) > 0 ? 'text-cyan-300' : 'text-gray-600'}">
					{Number(tokenInfo.maxTransactionAmount ?? 0) > 0 ? `${Number(tokenInfo.maxTransactionAmount).toLocaleString()} ${tokenInfo.symbol}` : $t('mt.noLimit')}
				</span>
			</div>
			<div class="protection-stat-row">
				<span class="text-gray-500 text-xs font-mono">{$t('mt.cooldown')}</span>
				<span class="text-xs font-mono {(tokenInfo.cooldownTime ?? 0) > 0 ? 'text-cyan-300' : 'text-gray-600'}">
					{(tokenInfo.cooldownTime ?? 0) > 0 ? `${tokenInfo.cooldownTime}s` : $t('mt.disabled')}
				</span>
			</div>
			<div class="protection-stat-row">
				<span class="text-gray-500 text-xs font-mono">{$t('mt.blacklist')}</span>
				<span class="text-xs font-mono {(tokenInfo.blacklistWindow ?? 0) > 0 ? 'text-cyan-300' : 'text-gray-600'}">
					{#if (tokenInfo.blacklistWindow ?? 0) === 0}
						{$t('mt.disabled')}
					{:else if tokenInfo.tradingEnabled && tokenInfo.tradingEnabledAt}
						{@const expiresAt = tokenInfo.tradingEnabledAt + (tokenInfo.blacklistWindow ?? 0)}
						{@const now = Math.floor(Date.now() / 1000)}
						{now > expiresAt ? $t('mt.expired') : `${$t('mt.active')} (${$t('mt.expiresIn')} ${Math.round((expiresAt - now) / 3600)}h)`}
					{:else}
						Window: {Math.round((tokenInfo.blacklistWindow ?? 0) / 3600)}h {$t('mt.windowAfterTrading')}
					{/if}
				</span>
			</div>
		</div>
	</div>

	{#if isOwner}
		<div class="form-fields">
			<!-- Enable Trading -->
			{#if !tokenInfo.tradingEnabled}
				<div class="sub-panel trading-enable-box">
					<h4 class="syne text-sm font-bold text-white mb-2">{$t('mt.enableTrading')}</h4>
					<p class="text-gray-500 text-xs font-mono mb-3">
						{$t('mt.enableTradingDesc')}
					</p>
					<div class="field-group mb-3">
						<label class="label-text" for="trading-delay">Anti-snipe delay</label>
						<select id="trading-delay" class="input-field" bind:value={tradingDelay}>
							<option value={0}>None (immediate)</option>
							<option value={300}>5 minutes</option>
							<option value={1800}>30 minutes</option>
							<option value={3600}>1 hour</option>
							<option value={21600}>6 hours</option>
							<option value={86400}>24 hours</option>
						</select>
						<span class="field-hint font-mono">Delays public DEX trading after enabling. Max 24 hours.</span>
					</div>
					<button
						onclick={onEnableTrading}
						disabled={actionLoading}
						class="action-btn syne cursor-pointer w-full"
					>
						{actionLoading ? $t('mt.enabling') : $t('mt.enableTrading')}
					</button>
				</div>
			{/if}

			<!-- Max Wallet -->
			<div class="field-group">
				<label class="label-text" for="max-wallet">{$t('mt.maxWalletAmount')}</label>
				<div class="input-with-badge">
					<input
						id="max-wallet"
						class="input-field"
						type="number"
						min="0"
						bind:value={maxWalletInput}
						placeholder={tokenInfo.tradingEnabled && Number(tokenInfo.maxWalletAmount ?? 0) > 0 ? `Current: ${Number(tokenInfo.maxWalletAmount).toLocaleString()} (can only increase)` : 'e.g. 10000'}
					/>
					<span class="input-badge">{tokenInfo.symbol}</span>
				</div>
				<span class="field-hint font-mono">{$t('mt.setTo0Disable')} {tokenInfo.tradingEnabled ? $t('mt.canOnlyIncrease') : ''}</span>
				<button onclick={onSetMaxWallet} disabled={actionLoading} class="action-btn mt-2 syne cursor-pointer">
					{actionLoading ? $t('mt.setting') : $t('mt.setMaxWallet')}
				</button>
			</div>

			<!-- Max Transaction -->
			<div class="field-group">
				<label class="label-text" for="max-tx">{$t('mt.maxTxAmount')}</label>
				<div class="input-with-badge">
					<input
						id="max-tx"
						class="input-field"
						type="number"
						min="0"
						bind:value={maxTxInput}
						placeholder={tokenInfo.tradingEnabled && Number(tokenInfo.maxTransactionAmount ?? 0) > 0 ? `Current: ${Number(tokenInfo.maxTransactionAmount).toLocaleString()} (can only increase)` : 'e.g. 5000'}
					/>
					<span class="input-badge">{tokenInfo.symbol}</span>
				</div>
				<span class="field-hint font-mono">{$t('mt.setTo0Disable')} {tokenInfo.tradingEnabled ? $t('mt.canOnlyIncrease') : ''}</span>
				<button onclick={onSetMaxTx} disabled={actionLoading} class="action-btn mt-2 syne cursor-pointer">
					{actionLoading ? $t('mt.setting') : $t('mt.setMaxTx')}
				</button>
			</div>

			<!-- Cooldown -->
			<div class="field-group">
				<label class="label-text" for="cooldown">{$t('mt.cooldownTime')}</label>
				<div class="input-with-badge">
					<input
						id="cooldown"
						class="input-field"
						type="number"
						min="0"
						bind:value={cooldownInput}
						placeholder={tokenInfo.tradingEnabled && (tokenInfo.cooldownTime ?? 0) > 0 ? `Current: ${tokenInfo.cooldownTime}s (can only decrease)` : 'e.g. 30'}
					/>
					<span class="input-badge">sec</span>
				</div>
				<span class="field-hint font-mono">{$t('mt.setTo0Disable')} {tokenInfo.tradingEnabled ? $t('mt.canOnlyDecrease') : ''} {$t('mt.cooldownHint')}</span>
				<button onclick={onSetCooldown} disabled={actionLoading} class="action-btn mt-2 syne cursor-pointer">
					{actionLoading ? $t('mt.setting') : $t('mt.setCooldown')}
				</button>
			</div>

			<!-- Blacklist Window (only before trading) -->
			{#if !tokenInfo.tradingEnabled}
				<div class="field-group">
					<label class="label-text" for="bl-window">{$t('mt.blacklistWindow')}</label>
					<div class="input-with-badge">
						<input
							id="bl-window"
							class="input-field"
							type="number"
							min="0"
							max="259200"
							bind:value={blacklistWindowInput}
							placeholder="e.g. 86400 (24 hours)"
						/>
						<span class="input-badge">sec</span>
					</div>
					<span class="field-hint font-mono">{$t('mt.blacklistWindowHint')}</span>
					<button onclick={onSetBlacklistWindow} disabled={actionLoading} class="action-btn mt-2 syne cursor-pointer">
						{actionLoading ? $t('mt.setting') : $t('mt.setBlacklistWindow')}
					</button>
				</div>
			{/if}

			<!-- Blacklist Management -->
			{#if (tokenInfo.blacklistWindow ?? 0) > 0}
				<div class="sub-panel">
					<h4 class="syne text-sm font-bold text-white mb-3">{$t('mt.blacklistManagement')}</h4>
					<div class="field-group">
						<label class="label-text" for="bl-addr">{$t('mt.address')}</label>
						<input id="bl-addr" class="input-field" bind:value={blacklistAddrInput} placeholder="0x..." />
					</div>
					<div class="flex gap-2 mt-2">
						<select class="input-field" style="max-width: 150px;" bind:value={blacklistAction}>
							<option value={true}>{$t('mt.blacklist')}</option>
							<option value={false}>{$t('mt.unblacklist')}</option>
						</select>
						<button onclick={onSetBlacklisted} disabled={actionLoading || !blacklistAddrInput} class="action-btn syne cursor-pointer flex-1">
							{actionLoading ? $t('mt.updating') : blacklistAction ? $t('mt.blockAddress') : $t('mt.unblockAddress')}
						</button>
					</div>

					<!-- Check if address is blacklisted -->
					<div class="mt-3">
						<div class="flex gap-2">
							<input class="input-field flex-1" bind:value={blacklistCheckAddr} placeholder={$t('mt.checkAddress')} />
							<button onclick={onCheckBlacklist} class="btn-secondary text-xs px-3 py-1.5 cursor-pointer">{$t('mt.check')}</button>
						</div>
						{#if blacklistCheckResult !== null}
							<div class="text-xs font-mono mt-1 {blacklistCheckResult ? 'text-red-400' : 'text-emerald-400'}">
								{blacklistCheckResult ? $t('mt.blacklisted') : $t('mt.notBlacklisted')}
							</div>
						{/if}
					</div>
				</div>
			{/if}

			<!-- Exclude from Limits -->
			<div class="sub-panel">
				<h4 class="syne text-sm font-bold text-white mb-3">{$t('mt.limitExclusions')}</h4>
				<p class="text-gray-500 text-xs font-mono mb-3">{$t('mt.limitExclusionsDesc')}</p>
				<div class="field-group">
					<label class="label-text" for="exclude-addr">{$t('mt.address')}</label>
					<input id="exclude-addr" class="input-field" bind:value={excludeLimitsAddrInput} placeholder="0x..." />
				</div>
				<div class="flex gap-2 mt-2">
					<select class="input-field" style="max-width: 150px;" bind:value={excludeLimitsAction}>
						<option value={true}>{$t('mt.exclude')}</option>
						<option value={false}>{$t('mt.include')}</option>
					</select>
					<button onclick={onSetExcludedFromLimits} disabled={actionLoading || !excludeLimitsAddrInput} class="action-btn syne cursor-pointer flex-1">
						{actionLoading ? $t('mt.updating') : excludeLimitsAction ? $t('mt.excludeFromLimits') : $t('mt.includeInLimits')}
					</button>
				</div>

				<!-- Check if excluded -->
				<div class="mt-3">
					<div class="flex gap-2">
						<input class="input-field flex-1" bind:value={excludedCheckAddr} placeholder={$t('mt.checkAddress')} />
						<button onclick={onCheckExcluded} class="btn-secondary text-xs px-3 py-1.5 cursor-pointer">{$t('mt.check')}</button>
					</div>
					{#if excludedCheckResult !== null}
						<div class="text-xs font-mono mt-1 {excludedCheckResult ? 'text-cyan-300' : 'text-gray-400'}">
							{excludedCheckResult ? $t('mt.excludedFromLimits') : $t('mt.subjectToLimits')}
						</div>
					{/if}
				</div>
			</div>
		</div>
	{:else}
		<div class="text-center py-6">
			<p class="text-gray-500 font-mono text-sm">{$t('mt.onlyOwnerProtection')}</p>
		</div>
	{/if}
</div>
