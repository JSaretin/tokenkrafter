/**
 * Platform config — loaded from Supabase, cached in memory.
 * Used by both client (layout) and server (API routes).
 */
import { supabase } from '$lib/supabaseClient';
import type { SupportedNetwork } from '$lib/structure';

export interface PlatformConfig {
	networks: SupportedNetwork[];
	site: {
		name: string;
		description: string;
		support_email: string;
	};
	social_links: {
		twitter: string;
		telegram_group: string;
		telegram_channel: string;
		discord: string;
		facebook: string;
		youtube: string;
	};
}

const DEFAULT_CONFIG: PlatformConfig = {
	networks: [],
	site: { name: 'TokenKrafter', description: '', support_email: '' },
	social_links: { twitter: '', telegram_group: '', telegram_channel: '', discord: '', facebook: '', youtube: '' }
};

let cached: PlatformConfig | null = null;
let cacheTime = 0;
const CACHE_TTL = 60_000; // 1 min

export async function loadConfig(): Promise<PlatformConfig> {
	if (cached && Date.now() - cacheTime < CACHE_TTL) return cached;

	try {
		const { data } = await supabase
			.from('platform_config')
			.select('key, value')
			.in('key', ['networks', 'site', 'social_links']);

		if (data && data.length > 0) {
			const config = { ...DEFAULT_CONFIG };
			for (const row of data) {
				if (row.key === 'networks' && Array.isArray(row.value)) {
					config.networks = row.value;
				} else if (row.key === 'site' && row.value) {
					config.site = { ...DEFAULT_CONFIG.site, ...row.value };
				} else if (row.key === 'social_links' && row.value) {
					config.social_links = { ...DEFAULT_CONFIG.social_links, ...row.value };
				}
			}
			cached = config;
			cacheTime = Date.now();
			return config;
		}
	} catch {}

	return cached || DEFAULT_CONFIG;
}

/** Invalidate cache (called when admin updates config) */
export function invalidateConfigCache() {
	cached = null;
	cacheTime = 0;
}

/** Get networks only (convenience) */
export async function getNetworks(): Promise<SupportedNetwork[]> {
	const config = await loadConfig();
	return config.networks;
}
