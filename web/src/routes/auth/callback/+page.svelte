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

<div class="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-muted font-mono text-sm">
	<div class="spinner w-8 h-8 rounded-full border-2 border-line-input border-t-[#00d2ff]"></div>
	<p>{status}</p>
</div>

<style>
	.spinner { animation: spin 0.8s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }
</style>
