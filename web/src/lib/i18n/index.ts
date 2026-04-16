import { writable, derived } from 'svelte/store';
import en from './en';
import zh from './zh';
import ja from './ja';
import ko from './ko';
import vi from './vi';
import th from './th';

export type Locale = 'en' | 'zh' | 'ja' | 'ko' | 'vi' | 'th';
export type TranslationKey = keyof typeof en;

const translations: Record<Locale, Record<string, string>> = { en, zh, ja, ko, vi, th };

export const locales: { code: Locale; label: string; flag: string }[] = [
	{ code: 'en', label: 'English', flag: 'EN' },
	{ code: 'zh', label: '\u4E2D\u6587', flag: 'CN' },
	{ code: 'ja', label: '\u65E5\u672C\u8A9E', flag: 'JP' },
	{ code: 'ko', label: '\uD55C\uAD6D\uC5B4', flag: 'KR' },
	{ code: 'vi', label: 'Ti\u1EBFng Vi\u1EC7t', flag: 'VN' },
	{ code: 'th', label: '\u0E44\u0E17\u0E22', flag: 'TH' }
];

function getInitialLocale(): Locale {
	if (typeof window !== 'undefined') {
		const saved = localStorage.getItem('locale') as Locale | null;
		if (saved && translations[saved]) return saved;
	}
	return 'en';
}

export const locale = writable<Locale>(getInitialLocale());

// Persist locale changes to localStorage
locale.subscribe((val) => {
	if (typeof window !== 'undefined') {
		localStorage.setItem('locale', val);
	}
});

/**
 * Derived store that provides the translation function.
 * Usage in components: $t('nav.home')
 */
export const t = derived(locale, ($locale) => {
	return (key: TranslationKey): string => {
		return translations[$locale]?.[key] ?? translations.en[key] ?? key;
	};
});
