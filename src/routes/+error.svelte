<script lang="ts">
	import { page } from '$app/state';
</script>

<svelte:head>
	<title>{page.status} | TokenKrafter</title>
</svelte:head>

<div class="error-page">
	<div class="error-card">
		<div class="error-code">{page.status}</div>
		<h1 class="error-title">
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
		<p class="error-message">
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
		<div class="error-actions">
			<a href="/" class="error-btn-primary">Go Home</a>
			<button onclick={() => history.back()} class="error-btn-secondary">Go Back</button>
		</div>
	</div>
</div>

<style>
	.error-page {
		min-height: calc(100vh - 200px);
		display: flex; align-items: center; justify-content: center;
		padding: 24px;
	}
	.error-card {
		text-align: center; max-width: 420px; width: 100%;
	}
	.error-code {
		font-family: 'Syne', sans-serif; font-size: 96px; font-weight: 800;
		line-height: 1; margin-bottom: 8px;
		background: linear-gradient(135deg, #00d2ff, #3a7bd5);
		-webkit-background-clip: text; -webkit-text-fill-color: transparent;
		background-clip: text;
	}
	.error-title {
		font-family: 'Syne', sans-serif; font-size: 24px; font-weight: 700;
		color: var(--text-heading); margin: 0 0 12px;
	}
	.error-message {
		font-family: 'Space Mono', monospace; font-size: 13px;
		color: var(--text-muted); line-height: 1.6; margin: 0 0 32px;
	}
	.error-actions {
		display: flex; gap: 12px; justify-content: center;
	}
	.error-btn-primary {
		padding: 12px 28px; border-radius: 10px; border: none;
		background: linear-gradient(135deg, #00d2ff, #3a7bd5);
		color: white; font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 700;
		text-decoration: none; transition: all 0.2s; cursor: pointer;
	}
	.error-btn-primary:hover { transform: translateY(-1px); box-shadow: 0 6px 28px rgba(0,210,255,0.3); }
	.error-btn-secondary {
		padding: 12px 28px; border-radius: 10px;
		border: 1px solid var(--border); background: transparent;
		color: var(--text-muted); font-family: 'Space Mono', monospace; font-size: 13px;
		cursor: pointer; transition: all 0.2s;
	}
	.error-btn-secondary:hover { color: var(--text); border-color: rgba(255,255,255,0.15); }
</style>
