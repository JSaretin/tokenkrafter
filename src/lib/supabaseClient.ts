import { createClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/public';

// Public client (anon key) — for reads from the browser
export const supabase = createClient(
	env.PUBLIC_SUPABASE_URL,
	env.PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
);
