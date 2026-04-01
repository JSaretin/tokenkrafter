import { createClient } from '@supabase/supabase-js';
import { env as pubEnv } from '$env/dynamic/public';
import { env } from '$env/dynamic/private';

// Server-side client (service role key) — for writes from API routes
export const supabaseAdmin = createClient(
	pubEnv.PUBLIC_SUPABASE_URL,
	env.SUPABASE_SERVICE_ROLE_KEY
);
