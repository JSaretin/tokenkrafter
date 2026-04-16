/**
 * Local QR code generation — no external API calls.
 * Uses the `qrcode` npm package to render a data URL synchronously-ish.
 */
import QRCode from 'qrcode';

/**
 * Generate a QR code as a data:image/png base64 URL.
 *
 * @param data   The string to encode (e.g. a wallet address)
 * @param opts   Optional color/size overrides
 * @returns      Promise<string> — a data URL ready for <img src="">
 */
export async function generateQR(
	data: string,
	opts?: {
		width?: number;
		colorDark?: string;
		colorLight?: string;
		margin?: number;
	}
): Promise<string> {
	return QRCode.toDataURL(data, {
		width: opts?.width ?? 200,
		margin: opts?.margin ?? 2,
		color: {
			dark: opts?.colorDark ?? '#ffffff',
			light: opts?.colorLight ?? '#0a0b10',
		},
		errorCorrectionLevel: 'M',
	});
}
