export type SocialPlatform =
	| 'site'
	| 'x'
	| 'telegram'
	| 'github'
	| 'linkedin'
	| 'discord'
	| 'email';

export interface Social {
	platform: SocialPlatform;
	url: string;
}

export interface Team {
	name: string;
	title: string;
	about: string;
	socials: Social[];
}

export const SOCIAL_LABELS: Record<SocialPlatform, string> = {
	site: 'Website',
	x: 'X / Twitter',
	telegram: 'Telegram',
	github: 'GitHub',
	linkedin: 'LinkedIn',
	discord: 'Discord',
	email: 'Email',
};

export const SOCIAL_PLATFORMS: SocialPlatform[] = [
	'x',
	'telegram',
	'github',
	'linkedin',
	'discord',
	'site',
	'email',
];

/**
 * Normalise a raw social input into a usable URL based on the
 * selected platform. Operator-friendly so admins can paste `jsaretin`
 * (or `@jsaretin`) instead of the full `https://x.com/jsaretin`.
 *
 * Rules:
 *   - Already-URL values (http://, https://, mailto:) pass through.
 *   - Bare handles → platform-specific URL (with `@` prefix stripped).
 *   - Bare domains under `site` get `https://` prepended.
 *   - Invalid / unrecognised inputs return the trimmed original so we
 *     never silently drop user data — the operator sees what they
 *     entered and can fix it.
 */
const URL_PROTOCOL_RE = /^https?:\/\//i;
const MAILTO_RE = /^mailto:/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeSocialUrl(platform: SocialPlatform, raw: string): string {
	const v = (raw ?? '').trim();
	if (!v) return v;
	if (URL_PROTOCOL_RE.test(v) || MAILTO_RE.test(v)) return v;

	switch (platform) {
		case 'x':
			return `https://x.com/${v.replace(/^@/, '')}`;
		case 'telegram':
			return `https://t.me/${v.replace(/^@/, '')}`;
		case 'github':
			return `https://github.com/${v.replace(/^@/, '')}`;
		case 'linkedin': {
			// Accept "in/handle", "company/foo", "school/bar"; treat a
			// bare handle as a personal profile (most common case).
			const cleaned = v.replace(/^@/, '');
			return cleaned.includes('/')
				? `https://linkedin.com/${cleaned}`
				: `https://linkedin.com/in/${cleaned}`;
		}
		case 'discord':
			// Bare invite codes resolve through discord.gg.
			return `https://discord.gg/${v.replace(/^@/, '')}`;
		case 'email':
			return EMAIL_RE.test(v) ? `mailto:${v}` : v;
		case 'site':
			// Bare domains get https; anything else is left as-is so a
			// user typing partial garbage doesn't get a misleading link.
			return /^[^\s/?#]+\.[^\s/?#]+/.test(v) ? `https://${v}` : v;
	}
}
