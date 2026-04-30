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
