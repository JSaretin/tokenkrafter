<script lang="ts">
	import { shortAddr } from '$lib/formatters';
	import { t } from '$lib/i18n';
	import { favorites } from '$lib/favorites';
	import { CURVE_TYPES, stateColor, stateLabel, type LaunchInfo } from '$lib/launchpad';
	import type { SupportedNetwork } from '$lib/structure';

	type Metadata = {
		description?: string;
		logo_url?: string;
		website?: string;
		twitter?: string;
		telegram?: string;
		discord?: string;
		video_url?: string;
	};

	type TokenTrust = {
		is_safu?: boolean;
		is_kyc?: boolean;
		lp_burned?: boolean;
		tax_ceiling_locked?: boolean;
		owner_renounced?: boolean;
		is_mintable?: boolean;
		is_taxable?: boolean;
		is_partner?: boolean;
		buy_tax_bps?: number;
		sell_tax_bps?: number;
	} | null;

	let {
		launch,
		launchAddress,
		metadata,
		tokenTrust,
		badges,
		isCreator,
		network,
		logoUploading = false,
		onLogoUpload,
		onToggleFavorite,
		onCopyLink
	}: {
		launch: LaunchInfo;
		launchAddress: string;
		metadata: Metadata;
		tokenTrust: TokenTrust;
		badges: string[];
		isCreator: boolean;
		network: SupportedNetwork | null;
		logoUploading?: boolean;
		onLogoUpload: (file: File) => void;
		onToggleFavorite: () => void;
		onCopyLink: () => void;
	} = $props();

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

	const LAUNCH_BADGE_BASE = 'text-3xs font-semibold font-mono uppercase tracking-[0.04em] px-2 py-0.5 rounded border';
	const LAUNCH_BADGE_COLOR: Record<string, string> = {
		cyan: 'bg-cyan/[0.12] text-cyan border-cyan/25',
		emerald: 'bg-success/[0.12] text-emerald-400 border-success/25',
		purple: 'bg-purple-dark/[0.12] text-purple border-purple-dark/25',
		amber: 'bg-warning/[0.12] text-warning-light border-warning/25',
		blue: 'bg-blue/[0.12] text-blue-400 border-blue/25',
		orange: 'bg-orange/[0.12] text-orange border-orange/25',
	};

	let color = $derived(stateColor(launch.state));

	function handleFileChange(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (file) onLogoUpload(file);
		input.value = '';
	}
</script>

<div class="border-b border-[var(--bg-surface-hover)] pb-5 mb-6">
	<div class="flex justify-between items-start gap-4">
		<div class="flex items-start gap-4">
			<div class="group relative shrink-0">
				{#if metadata.logo_url}
					<img src={metadata.logo_url} alt="" class="w-14 h-14 rounded-full object-cover shrink-0 border-2 border-[var(--bg-surface-hover)] card-logo-adapt" />
				{:else}
					<div class="w-14 h-14 rounded-full shrink-0 border-2 border-[var(--bg-surface-hover)] flex items-center justify-center bg-gradient-to-br from-cyan-400/15 to-purple-400/15 text-lg2 font-bold text-cyan syne">
						<span>{(launch.tokenSymbol || '?')[0]}</span>
					</div>
				{/if}
				{#if isCreator}
					<label class="absolute inset-0 flex items-center justify-center bg-black/60 rounded-full opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer text-[var(--text-heading)] font-mono" title={$t('lpd.uploadLogoTitle')}>
						<input type="file" accept="image/*" class="hidden" onchange={handleFileChange} disabled={logoUploading} />
						{#if logoUploading}
							<span class="text-xs2">...</span>
						{:else}
							<span class="text-xs2">{$t('lpd.upload')}</span>
						{/if}
					</label>
				{/if}
			</div>
			<div>
				<div class="flex items-center gap-1.5 flex-wrap max-[500px]:gap-1">
					<h1 class="heading-1 leading-tight">
						{launch.tokenName || $t('lp.unknownToken')}
					</h1>
					<span class="text-sm2 font-mono text-[var(--text-dim)] bg-[var(--bg-surface)] border border-[var(--bg-surface-hover)] px-2.5 py-0.5 rounded-md">{launch.tokenSymbol || '???'}</span>
					<span class="badge badge-{color} text-xs px-3 py-1">
						{stateLabel(launch.state)}
					</span>
					<!-- Badges -->
					{#each badges as badge}
						{#if BADGE_META[badge]}
							<span class={LAUNCH_BADGE_BASE + ' ' + (LAUNCH_BADGE_COLOR[BADGE_META[badge].color] ?? LAUNCH_BADGE_COLOR.cyan)} title={BADGE_META[badge].tooltip}>
								{BADGE_META[badge].label}
							</span>
						{/if}
					{/each}
					{#if tokenTrust?.is_safu}
						<span class={LAUNCH_BADGE_BASE + ' bg-success/20 text-success font-extrabold border-success/30'} title={$t('lpd.tooltipSafu')}>{$t('lp.badgeSafu')}</span>
					{/if}
					{#if tokenTrust?.is_kyc}
						<span class={LAUNCH_BADGE_BASE + ' bg-blue/15 text-blue-400 font-extrabold border-blue/30'} title={$t('lpd.tooltipKyc')}>{$t('lp.badgeKyc')}</span>
					{/if}
					{#if tokenTrust?.lp_burned}
						<span class={LAUNCH_BADGE_BASE + ' bg-blue/[0.12] text-blue-400 border-blue/20'} title={$t('lpd.tooltipLpBurned')}>{$t('lp.badgeLpBurned')}</span>
					{/if}
					{#if tokenTrust?.tax_ceiling_locked}
						<span class={LAUNCH_BADGE_BASE + ' bg-purple-dark/[0.12] text-purple border-purple-dark/20'} title={$t('lpd.tooltipTaxLocked')}>{$t('lp.badgeTaxLocked')}</span>
					{/if}
					{#if tokenTrust?.owner_renounced}
						<span class={LAUNCH_BADGE_BASE + ' bg-success/[0.12] text-emerald-400 border-success/20'} title={$t('lpd.tooltipOwnerRenounced')}>{$t('lp.badgeRenounced')}</span>
					{/if}
					{#if tokenTrust}
						<span class={LAUNCH_BADGE_BASE + ' bg-cyan/[0.12] text-cyan border-cyan/20'} title={$t('lpd.tooltipAudited')}>{$t('lp.badgeAudited')}</span>
					{/if}
					{#if tokenTrust?.is_mintable}
						<span class={LAUNCH_BADGE_BASE + ' bg-warning/[0.12] text-warning-light border-warning/20'} title={$t('lpd.tooltipMintable2')}>{$t('lp.badgeMintable')}</span>
					{/if}
					{#if tokenTrust?.is_taxable && ((tokenTrust?.buy_tax_bps ?? 0) > 0 || (tokenTrust?.sell_tax_bps ?? 0) > 0)}
						{#if tokenTrust?.tax_ceiling_locked}
							<span class={LAUNCH_BADGE_BASE + ' bg-success/[0.12] text-success border-success/20'} title="Tax {((tokenTrust.buy_tax_bps ?? 0) / 100).toFixed(0)}/{((tokenTrust.sell_tax_bps ?? 0) / 100).toFixed(0)}%">Tax {((tokenTrust.buy_tax_bps ?? 0) / 100).toFixed(0)}/{((tokenTrust.sell_tax_bps ?? 0) / 100).toFixed(0)}% {$t('lp.badgeTaxLocked')}</span>
						{:else}
							<span class={LAUNCH_BADGE_BASE + ' bg-warning/[0.12] text-warning border-warning/20'} title="Tax {((tokenTrust.buy_tax_bps ?? 0) / 100).toFixed(0)}/{((tokenTrust.sell_tax_bps ?? 0) / 100).toFixed(0)}%">Tax {((tokenTrust.buy_tax_bps ?? 0) / 100).toFixed(0)}/{((tokenTrust.sell_tax_bps ?? 0) / 100).toFixed(0)}%</span>
						{/if}
					{/if}
					{#if tokenTrust?.is_partner}
						<span class={LAUNCH_BADGE_BASE + ' bg-purple-dark/[0.12] text-purple border-purple-dark/20'} title={$t('lpd.tooltipPartner2')}>{$t('lp.badgePartner')}</span>
					{/if}
					<!-- Favorite + Share buttons -->
					<button
						class="inline-flex items-center justify-center bg-[var(--bg-surface)] border border-[var(--border)] rounded-full w-[34px] h-[34px] cursor-pointer transition-all duration-150 text-[var(--text-dim)] shrink-0 hover:border-cyan-400/40 hover:bg-cyan-400/[0.08] hover:text-cyan"
						onclick={onToggleFavorite}
						title={$favorites.includes(launchAddress.toLowerCase()) ? $t('lp.removeFromFavorites') : $t('lp.addToFavorites')}
					>
						<svg width="18" height="18" viewBox="0 0 24 24" fill={$favorites.includes(launchAddress.toLowerCase()) ? '#00d2ff' : 'none'} stroke={$favorites.includes(launchAddress.toLowerCase()) ? '#00d2ff' : 'currentColor'} stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>
					</button>
					<a
						href={`https://x.com/intent/tweet?text=${encodeURIComponent(`🚀 Check out $${launch.tokenSymbol} on TokenKrafter!`)}&url=${encodeURIComponent(typeof window !== 'undefined' ? window.location.href : '')}`}
						target="_blank" rel="noopener" class="inline-flex items-center justify-center bg-[var(--bg-surface)] border border-[var(--border)] rounded-full w-[34px] h-[34px] cursor-pointer transition-all duration-150 text-[var(--text-dim)] shrink-0 hover:border-cyan-400/40 hover:bg-cyan-400/[0.08] hover:text-cyan no-underline" title={$t('lpd.shareOnXTitle')}
					>𝕏</a>
					<button
						class="inline-flex items-center justify-center bg-[var(--bg-surface)] border border-[var(--border)] rounded-full w-[34px] h-[34px] cursor-pointer transition-all duration-150 text-[var(--text-dim)] shrink-0 hover:border-cyan-400/40 hover:bg-cyan-400/[0.08] hover:text-cyan"
						title={$t('lpd.copyLinkTitle')}
						onclick={onCopyLink}
					>🔗</button>
				</div>
				<div class="flex items-center gap-2 mt-2 flex-wrap max-sm:hidden">
					<span class="text-xs3 font-mono text-[var(--text-dim)] bg-white/[0.03] border border-[var(--border)] px-2 py-0.5 rounded">{network?.name || 'BSC'}</span>
					<span class="text-xs3 font-mono text-[var(--text-dim)] bg-white/[0.03] border border-[var(--border)] px-2 py-0.5 rounded">{CURVE_TYPES[launch.curveType]} {$t('lpd.curve')}</span>
					<span class="text-xs3 font-mono text-[var(--text-dim)] bg-white/[0.03] border border-[var(--border)] px-2 py-0.5 rounded">{$t('lpd.creator')}: {shortAddr(launch.creator)}</span>
				</div>
				<!-- Social icons inline -->
				{#if metadata.website || metadata.twitter || metadata.telegram || metadata.discord}
					<div class="flex gap-1.5 mt-2">
						{#if metadata.website}
							<a href={metadata.website} target="_blank" rel="noopener" class="inline-flex items-center justify-center w-[30px] h-[30px] rounded-lg bg-[var(--bg-surface)] border border-[var(--bg-surface-hover)] text-sm no-underline transition-all duration-150 hover:border-cyan-400/40 hover:bg-cyan-400/[0.06]" title={$t('lpd.titleWebsite')}>🌐</a>
						{/if}
						{#if metadata.twitter}
							<a href={metadata.twitter.startsWith('http') ? metadata.twitter : `https://x.com/${metadata.twitter.replace('@', '')}`} target="_blank" rel="noopener" class="inline-flex items-center justify-center w-[30px] h-[30px] rounded-lg bg-[var(--bg-surface)] border border-[var(--bg-surface-hover)] text-sm no-underline transition-all duration-150 hover:border-cyan-400/40 hover:bg-cyan-400/[0.06]" title={$t('lpd.titleTwitter')}>𝕏</a>
						{/if}
						{#if metadata.telegram}
							<a href={metadata.telegram.startsWith('http') ? metadata.telegram : `https://t.me/${metadata.telegram.replace('@', '')}`} target="_blank" rel="noopener" class="inline-flex items-center justify-center w-[30px] h-[30px] rounded-lg bg-[var(--bg-surface)] border border-[var(--bg-surface-hover)] text-sm no-underline transition-all duration-150 hover:border-cyan-400/40 hover:bg-cyan-400/[0.06]" title={$t('lpd.titleTelegram')}>✈</a>
						{/if}
						{#if metadata.discord}
							<a href={metadata.discord.startsWith('http') ? metadata.discord : `https://discord.gg/${metadata.discord}`} target="_blank" rel="noopener" class="inline-flex items-center justify-center w-[30px] h-[30px] rounded-lg bg-[var(--bg-surface)] border border-[var(--bg-surface-hover)] text-sm no-underline transition-all duration-150 hover:border-cyan-400/40 hover:bg-cyan-400/[0.06]" title={$t('lpd.titleDiscord')}>💬</a>
						{/if}
					</div>
				{/if}
			</div>
		</div>
	</div>
</div>
