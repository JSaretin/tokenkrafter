<script lang="ts">
	import { page } from '$app/state';
</script>

<svelte:head>
	<title>{page.status} | TokenKrafter</title>
</svelte:head>

<div class="min-h-[calc(100vh-200px)] flex items-center justify-center p-6">
	<div class="text-center max-w-[420px] w-full">
		<div class="error-code font-display text-[96px] font-extrabold leading-none mb-2">{page.status}</div>
		<h1 class="heading-1 mb-3">
			{#if page.status === 404}
				Page not found
			{:else if page.status === 403}
				Access denied
			{:else if page.status === 500}
				Something went wrong
			{:else}
				Error
			{/if}
		</h1>
		<p class="font-mono text-13 text-muted leading-[1.6] m-0 mb-8">
			{#if page.error?.message}
				{page.error.message}
			{:else if page.status === 404}
				The page you're looking for doesn't exist or has been moved.
			{:else if page.status === 403}
				You don't have permission to access this page.
			{:else}
				An unexpected error occurred. Please try again.
			{/if}
		</p>
		<div class="flex gap-3 justify-center">
			<a href="/" class="error-btn-primary inline-block px-7 py-3 rounded-[10px] border-none text-white font-display text-sm font-bold no-underline cursor-pointer transition-all duration-200 hover:-translate-y-px hover:shadow-[0_6px_28px_rgba(0,210,255,0.3)]">Go Home</a>
			<button onclick={() => history.back()} class="px-7 py-3 rounded-[10px] border border-line bg-transparent text-muted font-mono text-13 cursor-pointer transition-all duration-200 hover:text-foreground hover:border-dim">Go Back</button>
		</div>
	</div>
</div>

<style>
	.error-code {
		background: linear-gradient(135deg, #00d2ff, #3a7bd5);
		-webkit-background-clip: text; -webkit-text-fill-color: transparent;
		background-clip: text;
	}
	.error-btn-primary {
		background: linear-gradient(135deg, #00d2ff, #3a7bd5);
	}
</style>
