/**
 * One-off script: rasterize static/brand/icon.svg to PNGs at the sizes
 * the app actually needs (favicon, iOS touch icon, PWA icons, OG).
 *
 * Run: bun scripts/rasterize-brand.mjs
 */
import { Resvg } from '@resvg/resvg-js';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ICON_SVG = fs.readFileSync(path.join(ROOT, 'static/brand/icon.svg'));
const LOGO_SVG = fs.readFileSync(path.join(ROOT, 'static/brand/logo.svg'));

function render(svg, size, outPath, { background = null } = {}) {
	const resvg = new Resvg(svg, {
		fitTo: { mode: 'width', value: size },
		background: background || undefined,
	});
	const pngBuf = resvg.render().asPng();
	fs.writeFileSync(outPath, pngBuf);
	console.log(`  ${outPath} — ${size}x${size} — ${(pngBuf.length / 1024).toFixed(1)}kB`);
}

const outputs = [
	// Favicon sizes
	{ svg: ICON_SVG, size: 32, out: 'static/favicon-32.png' },
	{ svg: ICON_SVG, size: 180, out: 'static/apple-touch-icon.png' },
	// PWA
	{ svg: ICON_SVG, size: 192, out: 'static/icon-192.png' },
	{ svg: ICON_SVG, size: 512, out: 'static/icon-512.png' },
	// Brand folder: high-res reference PNGs
	{ svg: ICON_SVG, size: 512, out: 'static/brand/icon-512.png' },
	{ svg: ICON_SVG, size: 1024, out: 'static/brand/icon-1024.png' },
	{ svg: LOGO_SVG, size: 1024, out: 'static/brand/logo-1024.png' },
];

console.log('Rasterizing brand SVGs…\n');
for (const { svg, size, out } of outputs) {
	render(svg, size, path.join(ROOT, out));
}
console.log('\n✓ Done');
