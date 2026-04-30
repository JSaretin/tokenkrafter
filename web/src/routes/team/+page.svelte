<script lang="ts">
	import TeamMember from '$lib/TeamMember.svelte';
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();
	let teams = $derived(data.teams);
</script>

<svelte:head>
	<title>Team | TokenKrafter</title>
	<meta name="description" content="Meet the team behind TokenKrafter — building the future of fair token launches." />
</svelte:head>

<div class="page-wrap pb-10">
	<div class="max-w-4xl mx-auto px-4 sm:px-6 py-16">
		<div class="text-center mb-14">
			<h1 class="font-display text-3xl md:text-4xl font-bold mb-3 text-heading">Meet the Team</h1>
			<p class="text-sm font-mono max-w-lg mx-auto text-muted">
				Building the most accessible token creation and launch platform in Africa and beyond.
			</p>
		</div>

		<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
			{#each teams as member (member.name)}
				<TeamMember {member} />
			{/each}
		</div>

		<div class="mt-[60px] text-center p-10 bg-surface border border-line rounded-[20px]">
			<h2 class="font-display text-xl font-bold mb-2 text-heading">Want to join us?</h2>
			<p class="text-sm font-mono mb-4 text-muted">
				We're always looking for talented people who share our vision. Reach out if you're passionate about blockchain, DeFi, and building for Africa.
			</p>
			<a href="mailto:team@tokenkrafter.com" class="btn-primary text-sm px-6 py-3 no-underline inline-block">
				Get in Touch
			</a>
		</div>
	</div>
</div>
