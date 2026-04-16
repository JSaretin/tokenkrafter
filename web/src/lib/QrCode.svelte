<script lang="ts">
	import { generateQR } from './qr';

	let {
		data = '',
		width = 180,
		colorDark = '#ffffff',
		colorLight = '#0a0b10',
		margin = 2,
		alt = 'QR Code',
	}: {
		data: string;
		width?: number;
		colorDark?: string;
		colorLight?: string;
		margin?: number;
		alt?: string;
	} = $props();

	let src = $state('');

	$effect(() => {
		if (data) {
			generateQR(data, { width, colorDark, colorLight, margin })
				.then((url) => { src = url; })
				.catch(() => { src = ''; });
		} else {
			src = '';
		}
	});
</script>

{#if src}
	<img {src} {alt} {width} height={width} class="qr-img" style="image-rendering: pixelated; border-radius: 4px;" />
{:else if data}
	<div class="qr-placeholder" style="width:{width}px;height:{width}px;display:flex;align-items:center;justify-content:center;color:#475569;font-size:11px;font-family:'Space Mono',monospace;">
		Generating...
	</div>
{/if}
