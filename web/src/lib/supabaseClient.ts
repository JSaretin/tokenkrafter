import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/public';

// Lazy-init: env vars not available at build time on Cloudflare
let _client: SupabaseClient | null = null;

export const supabase: SupabaseClient = new Proxy({} as SupabaseClient, {
	get(_target, prop) {
		if (!_client) {
			const url = env.PUBLIC_SUPABASE_URL;
			const key = env.PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY;
			if (!url || !key) {
				throw new Error('Supabase env vars missing: PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY');
			}
			_client = createClient(url, key);
		}
		return (_client as any)[prop];
	}
});
