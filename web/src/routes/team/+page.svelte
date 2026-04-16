<svelte:head>
	<title>Team | TokenKrafter</title>
	<meta name="description" content="Meet the team behind TokenKrafter — building the future of fair token launches." />
</svelte:head>

<div class="page-wrap">
	<div class="max-w-4xl mx-auto px-4 sm:px-6 py-16">
		<div class="text-center mb-14">
			<h1 class="syne text-3xl md:text-4xl font-bold mb-3" style="color: var(--text-heading);">Meet the Team</h1>
			<p class="text-sm font-mono max-w-lg mx-auto" style="color: var(--text-muted);">
				Building the most accessible token creation and launch platform in Africa and beyond.
			</p>
		</div>

		<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
			{#each team as member}
				<div class="team-card">
					<div class="team-avatar">
						{#if member.image}
							<img src={member.image} alt={member.name} class="team-img" />
						{:else}
							<span class="team-initial">{member.name.charAt(0)}</span>
						{/if}
					</div>
					<h3 class="team-name">{member.name}</h3>
					<span class="team-role">{member.role}</span>
					<p class="team-bio">{member.bio}</p>
					{#if member.socials}
						<div class="team-socials">
							{#if member.socials.twitter}
								<a href={member.socials.twitter} target="_blank" rel="noopener" class="team-social" title="X / Twitter">
									<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
								</a>
							{/if}
							{#if member.socials.linkedin}
								<a href={member.socials.linkedin} target="_blank" rel="noopener" class="team-social" title="LinkedIn">
									<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
								</a>
							{/if}
							{#if member.socials.github}
								<a href={member.socials.github} target="_blank" rel="noopener" class="team-social" title="GitHub">
									<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/></svg>
								</a>
							{/if}
							{#if member.socials.website}
								<a href={member.socials.website} target="_blank" rel="noopener" class="team-social" title="Website">
									<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>
								</a>
							{/if}
						</div>
					{/if}
				</div>
			{/each}
		</div>

		<!-- Join the team -->
		<div class="join-section">
			<h2 class="syne text-xl font-bold mb-2" style="color: var(--text-heading);">Want to join us?</h2>
			<p class="text-sm font-mono mb-4" style="color: var(--text-muted);">
				We're always looking for talented people who share our vision. Reach out if you're passionate about blockchain, DeFi, and building for Africa.
			</p>
			<a href="mailto:team@tokenkrafter.com" class="btn-primary text-sm px-6 py-3 no-underline inline-block">
				Get in Touch
			</a>
		</div>
	</div>
</div>

<script>
	// Team members — update with real info
	const team = [
		{
			name: 'JSaretin',
			role: 'Founder & Lead Developer',
			bio: 'Full-stack blockchain developer building accessible DeFi tools for the African market. Passionate about bringing financial inclusion through crypto.',
			image: '', // Add URL to photo
			socials: {
				twitter: 'https://x.com/jsaretin',
				github: 'https://github.com/jsaretin',
				website: 'https://jsaretin.com'
			}
		}
		// Add more team members here:
		// {
		// 	name: 'Name',
		// 	role: 'Role',
		// 	bio: 'Short bio...',
		// 	image: '',
		// 	socials: { twitter: '', linkedin: '', github: '' }
		// }
	];
</script>

<style>
	.page-wrap { padding-bottom: 40px; }
	.syne { font-family: 'Syne', sans-serif; }

	.team-card {
		background: var(--bg-surface);
		border: 1px solid var(--border);
		border-radius: 16px;
		padding: 28px 24px;
		text-align: center;
		transition: all 0.2s;
	}
	.team-card:hover {
		border-color: rgba(0, 210, 255, 0.2);
		transform: translateY(-2px);
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
	}

	.team-avatar {
		width: 80px; height: 80px; border-radius: 50%;
		margin: 0 auto 16px; overflow: hidden;
		border: 2px solid rgba(0, 210, 255, 0.2);
		display: flex; align-items: center; justify-content: center;
		background: rgba(0, 210, 255, 0.08);
	}
	.team-img { width: 100%; height: 100%; object-fit: cover; }
	.team-initial {
		font-family: 'Syne', sans-serif; font-size: 28px; font-weight: 700;
		color: #00d2ff;
	}

	.team-name {
		font-family: 'Syne', sans-serif; font-size: 16px; font-weight: 700;
		color: var(--text-heading); margin-bottom: 4px;
	}
	.team-role {
		display: block; font-family: 'Space Mono', monospace; font-size: 11px;
		color: #00d2ff; text-transform: uppercase; letter-spacing: 0.05em;
		margin-bottom: 12px;
	}
	.team-bio {
		font-family: 'Space Mono', monospace; font-size: 12px;
		color: var(--text-muted); line-height: 1.6; margin-bottom: 16px;
	}

	.team-socials { display: flex; justify-content: center; gap: 10px; }
	.team-social {
		width: 32px; height: 32px; border-radius: 8px;
		display: flex; align-items: center; justify-content: center;
		background: var(--bg-surface-hover); color: var(--text-muted);
		border: 1px solid var(--border); transition: all 0.15s;
		text-decoration: none;
	}
	.team-social:hover {
		color: #00d2ff; border-color: rgba(0, 210, 255, 0.3);
		background: rgba(0, 210, 255, 0.08);
	}

	.join-section {
		margin-top: 60px; text-align: center;
		padding: 40px; background: var(--bg-surface);
		border: 1px solid var(--border); border-radius: 20px;
	}

	a.no-underline { text-decoration: none; }
</style>
