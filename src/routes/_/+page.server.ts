import { redirect, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { env } from '$env/dynamic/private';

export const load: PageServerLoad = async ({ cookies }) => {
	const session = cookies.get('admin_session');
	if (!session || session !== env.ADMIN_SECRET) {
		return { authenticated: false };
	}
	return { authenticated: true };
};

export const actions: Actions = {
	login: async ({ request, cookies }) => {
		const formData = await request.formData();
		const password = formData.get('password') as string;

		if (!password || password !== env.ADMIN_SECRET) {
			return fail(401, { error: 'Invalid password' });
		}

		cookies.set('admin_session', env.ADMIN_SECRET, {
			path: '/_',
			httpOnly: true,
			secure: true,
			sameSite: 'strict',
			maxAge: 60 * 60 * 24 // 24 hours
		});

		return { success: true };
	},

	logout: async ({ cookies }) => {
		cookies.delete('admin_session', { path: '/_' });
		throw redirect(303, '/_');
	}
};
