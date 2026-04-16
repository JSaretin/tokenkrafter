import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/public';

// Lazy-init: env vars not available at build time on Cloudflare
let _client: SupabaseClient | null = null;

export const supabase: SupabaseClient = new Proxy({} as SupabaseClient, {
	get(_target, prop) {
		if (!_client) {
			_client = createClient(env.PUBLIC_SUPABASE_URL, env.PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY);
		}
		return (_client as any)[prop];
	}
});
