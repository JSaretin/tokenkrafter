<script lang="ts" module>
	export type SocialPlatform =
		| 'site'
		| 'x'
		| 'telegram'
		| 'github'
		| 'linkedin'
		| 'discord'
		| 'email';

	export interface Social {
		platform: SocialPlatform;
		url: string;
	}

	export interface Team {
		name: string;
		title: string;
		about: string;
		socials: Social[];
	}

	const socialLabels: Record<SocialPlatform, string> = {
		site: 'Website',
		x: 'X / Twitter',
		telegram: 'Telegram',
		github: 'GitHub',
		linkedin: 'LinkedIn',
		discord: 'Discord',
		email: 'Email'
	};
</script>

<script lang="ts">
	let { member }: { member: Team } = $props();

	// Auto-derive an avatar from the X social URL when present. The
	// proxy endpoint hides unavatar.io behind our domain + edge cache;
	// 404 / network failure falls back to the initial-letter circle so
	// the layout never collapses.
	const X_URL_RE = /^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/(?:#!\/)?@?([A-Za-z0-9_]{1,15})\/?(?:\?.*)?$/i;
	let xUsername = $derived.by(() => {
		const xs = member.socials.find((s) => s.platform === 'x');
		if (!xs) return null;
		const m = xs.url.match(X_URL_RE);
		return m ? m[1] : null;
	});
	let avatarFailed = $state(false);
	let showAvatar = $derived(xUsername !== null && !avatarFailed);
</script>

<div
	class="bg-surface border border-line rounded-2xl px-6 py-7 text-center transition-all duration-200 hover:border-[rgba(0,210,255,0.2)] hover:-translate-y-0.5 hover:shadow-[0_8px_32px_rgba(0,0,0,0.2)]"
>
	<div
		class="w-20 h-20 rounded-full mx-auto mb-4 overflow-hidden border-2 border-[rgba(0,210,255,0.2)] flex items-center justify-center bg-[rgba(0,210,255,0.08)]"
	>
		{#if showAvatar}
			<img
				src={`/api/avatar/x/${xUsername}`}
				alt={`${member.name} avatar`}
				class="w-full h-full object-cover"
				loading="lazy"
				decoding="async"
				onerror={() => { avatarFailed = true; }}
			/>
		{:else}
			<span class="font-display text-28 font-bold text-[#00d2ff]">{member.name.charAt(0)}</span>
		{/if}
	</div>
	<h3 class="font-display text-base font-bold text-heading mb-1">{member.name}</h3>
	<span
		class="block font-mono text-xs2 text-[#00d2ff] uppercase tracking-[0.05em] mb-3"
	>{member.title}</span>
	<p class="font-mono text-xs text-muted leading-[1.6] mb-4">{member.about}</p>
	{#if member.socials.length}
		<div class="flex justify-center gap-2.5 flex-wrap">
			{#each member.socials as social (social.platform + social.url)}
				<a
					href={social.url}
					target="_blank"
					rel="noopener"
					title={socialLabels[social.platform]}
					aria-label={socialLabels[social.platform]}
					class="w-8 h-8 rounded-lg flex items-center justify-center bg-surface-hover text-muted border border-line transition-all duration-150 no-underline hover:text-[#00d2ff] hover:border-[rgba(0,210,255,0.3)] hover:bg-[rgba(0,210,255,0.08)]"
				>
					{#if social.platform === 'x'}
						<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
					{:else if social.platform === 'telegram'}
						<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221l-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.446 1.394c-.14.18-.357.295-.6.295l.213-3.053 5.56-5.022c.24-.213-.054-.334-.373-.121l-6.87 4.326-2.96-.924c-.64-.203-.658-.643.135-.953l11.566-4.458c.538-.196 1.006.128.832.938z"/></svg>
					{:else if social.platform === 'github'}
						<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/></svg>
					{:else if social.platform === 'linkedin'}
						<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
					{:else if social.platform === 'discord'}
						<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.79 19.79 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
					{:else if social.platform === 'email'}
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
					{:else}
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>
					{/if}
				</a>
			{/each}
		</div>
	{/if}
</div>
