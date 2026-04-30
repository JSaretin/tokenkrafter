import type { PageServerLoad } from './$types';
import type { Team } from '$lib/team';

// Default roster — used when platform_config.team is empty/missing
// so the page never goes blank in fresh deploys. Operator can
// override entirely from /admin → Config → Team.
const DEFAULT_TEAMS: Team[] = [
	{
		name: 'JSaretin',
		title: 'Founder & Lead Developer',
		about:
			'Full-stack blockchain developer building accessible DeFi tools for the African market. Passionate about bringing financial inclusion through crypto.',
		socials: [
			{ platform: 'x', url: 'https://x.com/jsaretin' },
			{ platform: 'github', url: 'https://github.com/jsaretin' },
			{ platform: 'site', url: 'https://jsaretin.com' },
		],
	},
	{
		name: 'Beauty Osaretin',
		title: 'Co-Founder',
		about:
			'Co-founder who shaped TokenKrafter from day one — helping plan every part of the product alongside the founder, from vision to execution.',
		socials: [{ platform: 'x', url: 'https://x.com/beauty_osaretin' }],
	},
];

export const load: PageServerLoad = async ({ fetch }) => {
	let teams: Team[] = DEFAULT_TEAMS;
	try {
		const res = await fetch('/api/config/team');
		if (res.ok) {
			const body = await res.json();
			if (Array.isArray(body?.team) && body.team.length > 0) {
				teams = body.team as Team[];
			}
		}
	} catch {}
	return { teams };
};
