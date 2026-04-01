import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env as pubEnv } from '$env/dynamic/public';
import { env } from '$env/dynamic/private';

// Lazy-init: Cloudflare Pages doesn't have env vars at build time
let _client: SupabaseClient | null = null;

export const supabaseAdmin: SupabaseClient = new Proxy({} as SupabaseClient, {
	get(_target, prop) {
		if (!_client) {
			_client = createClient(pubEnv.PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
		}
		return (_client as any)[prop];
	}
});
