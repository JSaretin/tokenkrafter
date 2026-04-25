<script lang="ts">
	import Skeleton from '$lib/Skeleton.svelte';

	let {
		metaLoaded,
		metaLoading,
		metaSaving,
		metaLogoUploading,
		metaLogoPreview,
		metaLogoUrl,
		metaLogoFile,
		metaDescription = $bindable(''),
		metaWebsite = $bindable(''),
		metaTwitter = $bindable(''),
		metaTelegram = $bindable(''),
		onLoadMetadata,
		onLogoFileChosen,
		onSaveMetadata,
	}: {
		metaLoaded: boolean;
		metaLoading: boolean;
		metaSaving: boolean;
		metaLogoUploading: boolean;
		metaLogoPreview: string;
		metaLogoUrl: string;
		metaLogoFile: File | null;
		metaDescription: string;
		metaWebsite: string;
		metaTwitter: string;
		metaTelegram: string;
		onLoadMetadata: () => void;
		onLogoFileChosen: (e: Event) => void;
		onSaveMetadata: () => void;
	} = $props();

	let fileInput: HTMLInputElement | undefined = $state();

	// Load metadata on first render of the about tab. Parent owns the actual
	// load function; we just kick it off once if the parent hasn't already.
	$effect(() => {
		if (!metaLoaded) onLoadMetadata();
	});
</script>

<div class="panel">
	<h3 class="syne text-base font-bold text-white mb-3">Token Info</h3>
	<p class="text-gray-500 text-xs font-mono mb-4">Add details about your token. This info appears on the explore page and token profile.</p>

	{#if metaLoading}
		<!-- Mirror the about-form layout so the page doesn't shift when metadata loads. -->
		<div class="flex flex-col gap-4">
			<div class="flex items-center gap-3">
				<Skeleton variant="rect" width={64} height={64} radius="12px" />
				<Skeleton width={120} height="1rem" />
			</div>
			<div class="flex flex-col gap-1.5">
				<Skeleton width={80} height="0.8rem" />
				<Skeleton width="100%" height="4.5rem" radius="10px" />
			</div>
			<div class="flex flex-col gap-1.5">
				<Skeleton width={80} height="0.8rem" />
				<Skeleton width="100%" height="2.5rem" radius="10px" />
			</div>
			<div class="grid grid-cols-2 gap-3">
				<div class="flex flex-col gap-1.5">
					<Skeleton width={80} height="0.8rem" />
					<Skeleton width="100%" height="2.5rem" radius="10px" />
				</div>
				<div class="flex flex-col gap-1.5">
					<Skeleton width={80} height="0.8rem" />
					<Skeleton width="100%" height="2.5rem" radius="10px" />
				</div>
			</div>
			<Skeleton width="100%" height="2.5rem" radius="10px" />
		</div>
	{:else}
		<div class="about-form">
			<!-- Logo Upload -->
			<div class="about-logo-section">
				<span class="label-text">Token Logo</span>
				<input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" class="hidden-file" bind:this={fileInput} onchange={onLogoFileChosen} />
				<div class="about-logo-row">
					{#if metaLogoPreview || metaLogoUrl}
						<div class="about-logo-preview-wrap">
							<img src={metaLogoPreview || metaLogoUrl} alt="Logo" class="about-logo-img" onerror={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
							<button class="about-logo-change" type="button" onclick={() => fileInput?.click()}>
								<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
								Change
							</button>
						</div>
					{:else}
						<button class="about-logo-upload" type="button" onclick={() => fileInput?.click()}>
							<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
							<span>Upload Logo</span>
							<span class="about-logo-hint">PNG, JPEG, WebP, GIF — max 2 MB</span>
						</button>
					{/if}
				</div>
				{#if metaLogoFile}
					<span class="about-logo-pending">New logo ready — will upload on save</span>
				{/if}
			</div>

			<label class="block">
	<span class="label-text">Description</span>
	<textarea id="meta-desc" class="input-field" rows="3" placeholder="What is this token about?" bind:value={metaDescription} style="resize: vertical;"></textarea>
</label>

			<label class="block">
	<span class="label-text">Website</span>
	<input id="meta-web" class="input-field" type="url" placeholder="https://yourtoken.com" bind:value={metaWebsite} />
</label>

			<div class="grid grid-cols-2 gap-3">
				<label class="block">
	<span class="label-text">Twitter / X</span>
	<input id="meta-tw" class="input-field" type="text" placeholder="@handle or URL" bind:value={metaTwitter} />
</label>
				<label class="block">
	<span class="label-text">Telegram</span>
	<input id="meta-tg" class="input-field" type="text" placeholder="@group or URL" bind:value={metaTelegram} />
</label>
			</div>

			<button class="action-btn syne cursor-pointer w-full mt-2" disabled={metaSaving || metaLogoUploading} onclick={onSaveMetadata}>
				{#if metaLogoUploading}
					Uploading logo...
				{:else if metaSaving}
					Saving...
				{:else}
					Save Token Info
				{/if}
			</button>
		</div>
	{/if}
</div>
