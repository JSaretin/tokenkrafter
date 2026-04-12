<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { supabase } from '$lib/supabaseClient';

	let status = $state('Signing in...');

	onMount(async () => {
		try {
			// Supabase redirects here with #access_token=... in the URL hash
			const { data, error } = await supabase.auth.getSession();

			if (error) {
				status = 'Sign in failed. Redirecting...';
				setTimeout(() => goto('/'), 2000);
				return;
			}

			if (data.session) {
				status = 'Success! Redirecting...';
				// Redirect to where they came from, or home
				const returnTo = sessionStorage.getItem('auth_return_to') || '/';
				sessionStorage.removeItem('auth_return_to');
				goto(returnTo);
			} else {
				status = 'No session found. Redirecting...';
				setTimeout(() => goto('/'), 2000);
			}
		} catch {
			status = 'Something went wrong. Redirecting...';
			setTimeout(() => goto('/'), 2000);
		}
	});
</script>

<div class="callback-page">
	<div class="spinner"></div>
	<p>{status}</p>
</div>

<style>
	.callback-page {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		min-height: 60vh;
		gap: 16px;
		color: var(--text-muted);
		font-family: 'Space Mono', monospace;
		font-size: 14px;
	}
	.spinner {
		width: 32px;
		height: 32px;
		border: 2px solid rgba(255,255,255,0.1);
		border-top-color: #00d2ff;
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }
</style>
