<script lang="ts">
	import { t } from '$lib/i18n';

	type Metadata = {
		description?: string;
		video_url?: string;
		website?: string;
		twitter?: string;
		telegram?: string;
		discord?: string;
	};

	let {
		variant = 'desktop',
		metadata,
		isCreator,
		isEditing = $bindable(false),
		editDescription = $bindable(''),
		editWebsite = $bindable(''),
		editTwitter = $bindable(''),
		editTelegram = $bindable(''),
		editDiscord = $bindable(''),
		editVideoUrl = $bindable(''),
		isSavingMeta,
		mobileAboutExpanded = $bindable(false),
		onStartEdit,
		onCancelEdit,
		onSave,
	}: {
		variant?: 'desktop' | 'mobile';
		metadata: Metadata;
		isCreator: boolean;
		isEditing: boolean;
		editDescription: string;
		editWebsite: string;
		editTwitter: string;
		editTelegram: string;
		editDiscord: string;
		editVideoUrl: string;
		isSavingMeta: boolean;
		mobileAboutExpanded?: boolean;
		onStartEdit: () => void;
		onCancelEdit: () => void;
		onSave: () => Promise<void>;
	} = $props();
</script>

{#if variant === 'desktop'}
	<div class="max-lg:hidden lg:col-[1]">
		{#if isEditing || metadata.description || metadata.video_url || isCreator}
			<div class="card p-6">
				{#if isEditing}
					<!-- Inline edit mode -->
					<div class="flex justify-between items-center mb-4">
						<h3 class="syne font-bold text-white">{$t('lpd.editTokenInfo')}</h3>
						<button onclick={onCancelEdit} class="text-gray-500 hover:text-white text-xs font-mono cursor-pointer">{$t('common.cancel')}</button>
					</div>

					<div class="flex flex-col gap-4">
						<div>
							<label class="label-text" for="edit-desc">{$t('lpd.editDesc')}</label>
							<textarea id="edit-desc" class="input-field" rows="5" placeholder={$t('lpd.aboutPlaceholder')} bind:value={editDescription}></textarea>
						</div>

						<div>
							<label class="label-text" for="edit-video">{$t('lpd.editVideo')}</label>
							<input id="edit-video" type="url" class="input-field" placeholder={$t('lpd.videoPlaceholder')} bind:value={editVideoUrl} />
						</div>

						<div class="grid grid-cols-2 gap-3">
							<div>
								<label class="label-text" for="edit-website">{$t('lpd.editWebsite')}</label>
								<input id="edit-website" type="url" class="input-field" placeholder={$t('lpd.websitePlaceholderUrl')} bind:value={editWebsite} />
							</div>
							<div>
								<label class="label-text" for="edit-twitter">{$t('lpd.editTwitter')}</label>
								<input id="edit-twitter" class="input-field" placeholder={$t('lpd.twitterPlaceholder')} bind:value={editTwitter} />
							</div>
						</div>
						<div class="grid grid-cols-2 gap-3">
							<div>
								<label class="label-text" for="edit-telegram">{$t('lpd.editTelegram')}</label>
								<input id="edit-telegram" class="input-field" placeholder={$t('lpd.telegramPlaceholder')} bind:value={editTelegram} />
							</div>
							<div>
								<label class="label-text" for="edit-discord">{$t('lpd.editDiscord')}</label>
								<input id="edit-discord" class="input-field" placeholder={$t('lpd.discordPlaceholder')} bind:value={editDiscord} />
							</div>
						</div>

						<div class="flex gap-3">
							<button onclick={onCancelEdit} class="btn-secondary flex-1 py-2.5 text-sm cursor-pointer">{$t('common.cancel')}</button>
							<button onclick={onSave} disabled={isSavingMeta} class="btn-primary flex-1 py-2.5 text-sm cursor-pointer">
								{isSavingMeta ? $t('lpd.saving') : $t('lpd.saveChanges')}
							</button>
						</div>
					</div>
				{:else}
					<!-- View mode -->
					<div class="flex justify-between items-center mb-3">
						<h3 class="syne font-bold text-white">{$t('lpd.about')}</h3>
						{#if isCreator}
							<button onclick={onStartEdit} class="text-gray-500 hover:text-cyan-400 text-xs font-mono transition cursor-pointer">
								{metadata.description ? $t('lpd.editInfo') : $t('lpd.addInfo')}
							</button>
						{/if}
					</div>
					{#if metadata.description}
						<p class="text-gray-300 font-mono text-sm leading-relaxed whitespace-pre-line">{metadata.description}</p>
					{:else if isCreator}
						<button onclick={onStartEdit} class="w-full py-5 bg-cyan-400/[0.03] border border-dashed border-cyan-400/15 rounded-[10px] cursor-pointer transition-all duration-150 text-center hover:bg-cyan-400/[0.06] hover:border-cyan-400/30">
							<span class="text-gray-500 text-sm">{$t('lpd.addDescription')}</span>
						</button>
					{/if}

					<!-- Video embed -->
					{#if metadata.video_url}
						<div class="rounded-xl overflow-hidden mt-4">
							{#if metadata.video_url.includes('youtube.com') || metadata.video_url.includes('youtu.be')}
								{@const videoId = metadata.video_url.includes('youtu.be')
									? metadata.video_url.split('/').pop()?.split('?')[0]
									: new URL(metadata.video_url).searchParams.get('v')}
								{#if videoId}
									<iframe
										src="https://www.youtube.com/embed/{videoId}"
										title="Video"
										class="w-full aspect-video rounded-xl border border-[var(--bg-surface-hover)]"
										allowfullscreen
										frameborder="0"
									></iframe>
								{/if}
							{:else}
								<a href={metadata.video_url} target="_blank" rel="noopener" class="flex items-center gap-2.5 py-3.5 px-4 bg-[var(--bg-surface)] border border-[var(--bg-surface-hover)] rounded-xl no-underline transition-[border-color] duration-150 hover:border-cyan-400/30">
									<span class="text-lg">▶</span>
									<span class="text-gray-300 text-sm font-mono">{$t('lpd.watchVideo')}</span>
								</a>
							{/if}
						</div>
					{/if}
				{/if}
			</div>
		{/if}
	</div>
{:else}
	<!-- Mobile-only: compact About between timer and buy -->
	{#if metadata.description || isCreator}
		<div class="card p-4 mb-4 hidden max-lg:block">
			{#if isEditing}
				<!-- Inline edit on mobile -->
				<div class="flex justify-between items-center mb-3">
					<h4 class="syne font-bold text-sm text-(--text-heading)">{$t('lpd.editTokenInfo')}</h4>
					<button onclick={onCancelEdit} class="text-gray-500 hover:text-white text-xs font-mono cursor-pointer">{$t('common.cancel')}</button>
				</div>
				<div class="flex flex-col gap-3">
					<textarea class="input-field" rows="4" placeholder={$t('lpd.aboutPlaceholderShort')} bind:value={editDescription}></textarea>
					<input type="url" class="input-field" placeholder={$t('lpd.videoUrlShort')} bind:value={editVideoUrl} />
					<div class="grid grid-cols-2 gap-2">
						<input type="url" class="input-field" placeholder={$t('lpd.websiteShort')} bind:value={editWebsite} />
						<input class="input-field" placeholder={$t('lpd.twitterShort')} bind:value={editTwitter} />
					</div>
					<div class="grid grid-cols-2 gap-2">
						<input class="input-field" placeholder={$t('lpd.telegramShort')} bind:value={editTelegram} />
						<input class="input-field" placeholder={$t('lpd.discordShort')} bind:value={editDiscord} />
					</div>
					<div class="flex gap-2">
						<button onclick={onCancelEdit} class="btn-secondary flex-1 py-2 text-xs cursor-pointer">{$t('common.cancel')}</button>
						<button onclick={onSave} disabled={isSavingMeta} class="btn-primary flex-1 py-2 text-xs cursor-pointer">
							{isSavingMeta ? $t('lpd.saving') : $t('lpd.saveChanges')}
						</button>
					</div>
				</div>
			{:else}
				<div class="flex justify-between items-center mb-2">
					<h4 class="syne font-bold text-sm text-(--text-heading)">{$t('lpd.about')}</h4>
					{#if isCreator}
						<button onclick={onStartEdit} class="text-gray-500 hover:text-cyan-400 text-xs font-mono transition cursor-pointer">
							{metadata.description ? $t('lpd.editInfo') : $t('lpd.addInfo')}
						</button>
					{/if}
				</div>
				{#if metadata.description}
					<p class={"font-mono text-xs text-[var(--text-muted)] leading-relaxed whitespace-pre-line line-clamp-2 overflow-hidden " + (mobileAboutExpanded ? "!line-clamp-none" : "")}>{metadata.description}</p>
					{#if metadata.description.length > 120}
						<button class="font-mono text-xs3 text-cyan bg-transparent border-none cursor-pointer pt-1 p-0" onclick={() => mobileAboutExpanded = !mobileAboutExpanded}>
							{mobileAboutExpanded ? $t('lpd.showLess') : $t('lpd.readMore')}
						</button>
					{/if}
				{:else if isCreator}
					<button onclick={onStartEdit} class="w-full py-5 bg-cyan-400/[0.03] border border-dashed border-cyan-400/15 rounded-[10px] cursor-pointer transition-all duration-150 text-center hover:bg-cyan-400/[0.06] hover:border-cyan-400/30">
						<span class="text-gray-500 text-xs">{$t('lpd.addDescription')}</span>
					</button>
				{/if}
			{/if}
		</div>
	{/if}
{/if}
