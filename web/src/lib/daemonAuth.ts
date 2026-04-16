import { env } from '$env/dynamic/private';

/**
 * Check if a request is from an authenticated daemon.
 * Daemons use TX_CONFIRM_SECRET (worker key on VPS).
 * Also accepts SYNC_SECRET for backwards compatibility during migration.
 */
export function isDaemonAuth(request: Request): boolean {
	const auth = request.headers.get('authorization');
	if (!auth) return false;
	return !!(env.TX_CONFIRM_SECRET && auth === `Bearer ${env.TX_CONFIRM_SECRET}`) ||
		!!(env.SYNC_SECRET && auth === `Bearer ${env.SYNC_SECRET}`);
}

/**
 * Check if a request has the vault-level secret.
 * Only for financial operations (withdrawal confirm, Flutterwave transfers).
 * SYNC_SECRET never leaves Cloudflare env.
 */
export function isVaultAuth(request: Request): boolean {
	const auth = request.headers.get('authorization');
	if (!auth) return false;
	return !!(env.SYNC_SECRET && auth === `Bearer ${env.SYNC_SECRET}`);
}
