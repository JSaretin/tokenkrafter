import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Redirect old /token/[chain]/[address] to /explore/[chain]/[address]
export const load: PageServerLoad = async ({ params }) => {
	redirect(301, `/explore/${params.chain}/${params.address}`);
};
