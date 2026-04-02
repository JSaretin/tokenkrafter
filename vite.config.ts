import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	server: {
		host: true,
		allowedHosts: 'all',
		watch: {
			ignored: ['**/solidty-contracts/**', '**/daemon-state*.json']
		}
	}
});
