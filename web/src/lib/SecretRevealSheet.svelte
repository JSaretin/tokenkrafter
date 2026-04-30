<!--
  SecretRevealSheet — three-step gauntlet for revealing a recovery
  phrase or a single account's private key. Renders as an 80vh
  bottom-up sheet (matching the wallet switcher pattern) so it sits
  consistently in the wallet UX.

  Steps:
    1. Acknowledgement checklist — five checkboxes the user must
       individually accept. Forces a slow read.
    2. PIN — verifies the device PIN (same one used to unlock).
    3. Long-press reveal — secret is hidden behind a 1.5s press;
       releasing aborts. Once revealed, shows the secret + a QR code
       so the user can scan it into a hardware wallet / paper backup
       app without typing.

  Copy-to-clipboard is offered post-reveal. We discourage it (paper
  backup is safer), but plenty of users will paste into a password
  manager regardless — better to give them a button than have them
  retype off-screen and get it wrong.
-->
<script lang="ts">
	import { onDestroy } from 'svelte';
	import { fade } from 'svelte/transition';
	import { unlockWallet, exportSeedPhrase, exportPrivateKey } from './embeddedWallet';
	import { generateQR } from './qr';

	let {
		open = $bindable(false),
		kind,
		accountIndex = 0,
		accountAddress = '',
		walletName = '',
	}: {
		open: boolean;
		kind: 'seed' | 'key';
		accountIndex?: number;
		accountAddress?: string;
		walletName?: string;
	} = $props();

	type Step = 'ack' | 'pin' | 'reveal';
	let step = $state<Step>('ack');

	// Per-kind ack list — wording tuned to surface the specific risks
	// (recoverability vs single-account loss) so the user can't blast
	// through it on autopilot.
	const ACK_SEED = [
		"This phrase IS my wallet — anyone with these words can move every coin in every account.",
		"TokenKrafter staff will NEVER ask for this phrase. Anyone who does is trying to steal from me.",
		"I will write it on paper, store it offline, and never paste it into a chat, email, or website I don't 100% trust.",
		"I am alone. No one is shoulder-surfing, screen-recording, or screen-sharing right now.",
		"If I lose this phrase AND lose my device, my funds are gone forever — TokenKrafter cannot recover them.",
	];
	const ACK_KEY = [
		"This private key controls THIS one account. Anyone who has it can move all its funds.",
		"TokenKrafter staff will NEVER ask for this key. Requests for it are scams.",
		"I will treat it like cash — never paste it into a website or chat I don't 100% trust.",
		"I am alone. No one is shoulder-surfing, screen-recording, or screen-sharing right now.",
		"My recovery phrase is safer than this key — prefer that for backups whenever possible.",
	];

	let acks = $derived(kind === 'seed' ? ACK_SEED : ACK_KEY);
	let ackChecked = $state<boolean[]>([]);
	$effect(() => {
		// Reinitialise the boolean array whenever the kind changes or
		// the sheet reopens, so the second use doesn't inherit the
		// previous answers.
		if (open) ackChecked = Array(acks.length).fill(false);
	});
	let allAcked = $derived(ackChecked.length === acks.length && ackChecked.every(Boolean));

	// PIN
	let pinInput = $state('');
	let pinError = $state('');
	let pinChecking = $state(false);

	// Reveal
	let revealedValue = $state('');
	let qrDataUrl = $state('');
	let isPressing = $state(false);
	let pressProgress = $state(0); // 0–1
	let pressTimer: ReturnType<typeof setInterval> | null = null;
	let pressStart = 0;
	const PRESS_HOLD_MS = 1500;
	let revealed = $state(false);
	let copied = $state(false);
	let copyTimer: ReturnType<typeof setTimeout> | null = null;
	let showQr = $state(false);

	function lockAgain() {
		revealed = false;
		showQr = false;
		isPressing = false;
		pressProgress = 0;
		copied = false;
		if (copyTimer) { clearTimeout(copyTimer); copyTimer = null; }
		clearPressTimer();
	}

	async function copySecret() {
		if (!revealedValue) return;
		try {
			await navigator.clipboard.writeText(revealedValue);
			copied = true;
			if (copyTimer) clearTimeout(copyTimer);
			copyTimer = setTimeout(() => { copied = false; }, 1500);
		} catch {
			// Clipboard write blocked — leave button state alone.
		}
	}

	function clearPressTimer() {
		if (pressTimer) {
			clearInterval(pressTimer);
			pressTimer = null;
		}
	}

	function startPress() {
		if (revealed || !revealedValue) return;
		isPressing = true;
		pressStart = Date.now();
		pressProgress = 0;
		clearPressTimer();
		pressTimer = setInterval(() => {
			const elapsed = Date.now() - pressStart;
			pressProgress = Math.min(1, elapsed / PRESS_HOLD_MS);
			if (elapsed >= PRESS_HOLD_MS) {
				clearPressTimer();
				revealed = true;
				isPressing = false;
			}
		}, 50);
	}

	function endPress() {
		if (!isPressing || revealed) {
			isPressing = false;
			return;
		}
		isPressing = false;
		pressProgress = 0;
		clearPressTimer();
	}

	async function submitPin() {
		if (pinChecking) return;
		pinError = '';
		pinChecking = true;
		try {
			const ok = await unlockWallet(pinInput);
			if (!ok) {
				pinError = 'Incorrect PIN';
				return;
			}
			// Pull the secret immediately so we don't have to keep the
			// PIN around in component state.
			let value: string | null;
			if (kind === 'seed') {
				value = exportSeedPhrase();
			} else {
				value = exportPrivateKey(accountIndex);
			}
			if (!value) {
				pinError = 'Failed to read secret — try again';
				return;
			}
			revealedValue = value;
			pinInput = '';
			step = 'reveal';
			// Pre-render the QR off the critical path; the reveal screen
			// will render whatever's ready.
			generateQR(value, { width: 256, margin: 1 })
				.then((url) => { qrDataUrl = url; })
				.catch(() => { qrDataUrl = ''; });
		} finally {
			pinChecking = false;
		}
	}

	function reset() {
		step = 'ack';
		ackChecked = Array(acks.length).fill(false);
		pinInput = '';
		pinError = '';
		pinChecking = false;
		revealedValue = '';
		qrDataUrl = '';
		isPressing = false;
		pressProgress = 0;
		revealed = false;
		copied = false;
		showQr = false;
		if (copyTimer) { clearTimeout(copyTimer); copyTimer = null; }
		clearPressTimer();
	}

	function handleClose() {
		if (pinChecking) return;
		open = false;
		reset();
	}

	onDestroy(clearPressTimer);

	// Display words as a numbered grid for the seed phrase. Private
	// key is just one long hex string — render mono and wrap.
	let seedWords = $derived(kind === 'seed' && revealedValue
		? revealedValue.trim().split(/\s+/)
		: []);

	// Group the 0x-prefixed hex into 4-char chunks so the user can
	// verify it by eye / read it aloud without losing their place.
	let groupedKey = $derived(kind === 'key' && revealedValue
		? (() => {
			const m = revealedValue.match(/^0x([0-9a-fA-F]+)$/);
			if (!m) return revealedValue;
			return '0x ' + (m[1].match(/.{1,4}/g) ?? []).join(' ');
		})()
		: '');

	let title = $derived(
		kind === 'seed' ? 'Reveal recovery phrase' : 'Reveal private key',
	);
	let subtitle = $derived(
		kind === 'seed'
			? walletName ? `Wallet: ${walletName}` : ''
			: accountAddress ? `Account: ${accountAddress.slice(0, 6)}…${accountAddress.slice(-4)}` : '',
	);
</script>

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="srs-backdrop" onclick={handleClose} transition:fade={{ duration: 180 }}>
		<div class="srs-sheet" onclick={(e) => e.stopPropagation()}>
			<button class="srs-close" onclick={handleClose} aria-label="Close" disabled={pinChecking}>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
			</button>

			<div class="srs-head">
				<div class="srs-title">{title}</div>
				{#if subtitle}<div class="srs-subtitle">{subtitle}</div>{/if}
				{#if step !== 'reveal'}
					<div class="srs-steps">
						<span class={'srs-dot ' + (step === 'ack' ? 'is-active' : 'is-done')}></span>
						<span class={'srs-dot ' + (step === 'pin' ? 'is-active' : '')}></span>
					</div>
				{/if}
			</div>

			<div class="srs-body">
				{#if step === 'ack'}
					<p class="srs-hint">
						Read each statement and tick to confirm. You'll need to acknowledge all of them before continuing.
					</p>
					<div class="srs-acks">
						{#each acks as text, i}
							<label class="srs-ack">
								<input type="checkbox" bind:checked={ackChecked[i]} />
								<span>{text}</span>
							</label>
						{/each}
					</div>
				{:else if step === 'pin'}
					<p class="srs-hint">
						Enter your device PIN. This is the same PIN you use to unlock TokenKrafter.
					</p>
					<input
						class="srs-input"
						type="tel"
						inputmode="numeric"
						style="-webkit-text-security: disc; text-security: disc;"
						autocomplete="off"
						bind:value={pinInput}
						disabled={pinChecking}
						onkeydown={(e) => { if (e.key === 'Enter') submitPin(); }}
					/>
					{#if pinError}<div class="srs-error">{pinError}</div>{/if}
				{:else}
					{#if revealed}
						<div class="srs-warn">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/></svg>
							<span>{kind === 'seed' ? 'Treat this phrase like cash. Anyone with it owns your wallet.' : 'Treat this key like cash. Anyone with it owns this account.'}</span>
						</div>
					{:else}
						<p class="srs-hint">Press and hold to reveal. Release to hide.</p>
					{/if}

					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<div
						class={'srs-secret-wrap ' + (revealed ? 'is-revealed' : '') + (showQr ? ' is-qr' : '')}
						onpointerdown={startPress}
						onpointerup={endPress}
						onpointerleave={endPress}
						onpointercancel={endPress}
					>
						{#if revealed}
							{#if showQr && qrDataUrl}
								<div class="srs-qr-drawer">
									<img class="srs-qr-large" src={qrDataUrl} alt="QR code for the secret" />
									<p class="srs-qr-caption">Scan with a hardware wallet or trusted backup app.</p>
								</div>
							{:else if kind === 'seed'}
								<div class={'srs-words ' + (seedWords.length > 12 ? 'is-24' : 'is-12')}>
									{#each seedWords as word, i}
										<div class="srs-word">
											<span class="srs-word-num">{i + 1}</span>
											<span class="srs-word-text">{word}</span>
										</div>
									{/each}
								</div>
							{:else}
								<div class="srs-key">{groupedKey}</div>
							{/if}
						{:else}
							<div class="srs-mask">
								<div class="srs-mask-icon">
									<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
								</div>
								<span class="srs-mask-label">{isPressing ? 'Hold to reveal…' : 'Press &amp; hold'}</span>
								<div class="srs-press-bar">
									<div class="srs-press-fill" style="width: {Math.round(pressProgress * 100)}%"></div>
								</div>
							</div>
						{/if}
					</div>

					{#if revealed}
						<div class="srs-actions">
							<button
								class={'srs-action ' + (copied ? 'is-copied' : '')}
								onclick={copySecret}
								type="button"
							>
								{#if copied}
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
									Copied
								{:else}
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
									Copy
								{/if}
							</button>
							{#if qrDataUrl}
								<button
									class={'srs-action ' + (showQr ? 'is-on' : '')}
									onclick={() => { showQr = !showQr; }}
									type="button"
								>
									{#if showQr}
										<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
										Show {kind === 'seed' ? 'phrase' : 'key'}
									{:else}
										<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM18 18h3v3h-3zM14 19h3"/></svg>
										Show QR
									{/if}
								</button>
							{/if}
							<button class="srs-action srs-action-danger" onclick={lockAgain} type="button">
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
								Lock
							</button>
						</div>
					{/if}
				{/if}
			</div>

			{#if step !== 'reveal'}
				<div class="srs-footer">
					{#if step === 'ack'}
						<button class="srs-btn srs-btn-ghost" onclick={handleClose}>Cancel</button>
						<button class="srs-btn srs-btn-primary" disabled={!allAcked} onclick={() => { step = 'pin'; }}>
							Continue
						</button>
					{:else if step === 'pin'}
						<button class="srs-btn srs-btn-ghost" onclick={() => { step = 'ack'; pinError = ''; }}>Back</button>
						<button class="srs-btn srs-btn-primary" disabled={!pinInput || pinChecking} onclick={submitPin}>
							{pinChecking ? 'Checking…' : 'Verify PIN'}
						</button>
					{/if}
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.srs-backdrop {
		/* Contained inside the AccountPanel (.ap) — fills the wallet
		   panel entirely. Not a bottom sheet — the reveal flow takes
		   over the whole wallet screen until dismissed. */
		position: absolute; inset: 0; z-index: 70;
		background: var(--bg);
		display: flex; flex-direction: column;
		border-radius: inherit;
		overflow: hidden;
	}
	.srs-sheet {
		position: relative;
		width: 100%; height: 100%;
		background: var(--bg);
		display: flex; flex-direction: column;
		overflow: hidden;
		animation: srsFadeIn 0.18s ease-out;
	}
	@keyframes srsFadeIn {
		from { opacity: 0; }
		to { opacity: 1; }
	}
	.srs-close {
		position: absolute; top: 10px; right: 12px; z-index: 1;
		width: 28px; height: 28px; border-radius: 8px; border: none;
		background: var(--bg-surface-input); color: var(--text-dim); cursor: pointer;
		display: flex; align-items: center; justify-content: center; transition: all 0.12s;
	}
	.srs-close:hover { background: var(--bg-surface-hover); color: var(--text-heading); }
	.srs-close:disabled { opacity: 0.5; cursor: not-allowed; }

	.srs-head {
		padding: 14px 18px 10px;
		border-bottom: 1px solid var(--border);
	}
	.srs-title {
		font-family: 'Syne', sans-serif; font-size: 15px; font-weight: 800;
		color: var(--text-heading);
	}
	.srs-subtitle {
		font-family: 'Space Mono', monospace; font-size: 11px;
		color: var(--text-dim); margin-top: 4px;
	}
	.srs-steps { display: flex; gap: 6px; margin-top: 10px; }
	.srs-dot {
		width: 24px; height: 4px; border-radius: 2px;
		background: var(--bg-surface-hover);
	}
	.srs-dot.is-active { background: #f59e0b; }
	.srs-dot.is-done { background: #10b981; }

	.srs-body {
		flex: 1; overflow-y: auto;
		padding: 14px 18px 16px;
		display: flex; flex-direction: column; gap: 12px;
	}
	.srs-hint {
		margin: 0; font-family: 'Space Mono', monospace; font-size: 11px;
		color: var(--text-muted); line-height: 1.55;
	}

	.srs-acks { display: flex; flex-direction: column; gap: 10px; }
	.srs-ack {
		display: flex; gap: 10px; align-items: flex-start;
		padding: 10px 12px; border-radius: 10px;
		background: rgba(248, 113, 113, 0.04);
		border: 1px solid rgba(248, 113, 113, 0.12);
		font-family: 'Space Mono', monospace; font-size: 11px;
		color: var(--text-muted); line-height: 1.5; cursor: pointer;
		transition: border-color 0.12s, background-color 0.12s;
	}
	.srs-ack:has(input:checked) {
		background: rgba(16, 185, 129, 0.06);
		border-color: rgba(16, 185, 129, 0.3);
		color: var(--text-heading);
	}
	.srs-ack input {
		margin-top: 2px; width: 14px; height: 14px; flex-shrink: 0; accent-color: #10b981;
	}

	.srs-input {
		width: 100%; padding: 11px 12px; border-radius: 10px; box-sizing: border-box;
		background: var(--bg-surface-input); border: 1px solid var(--border);
		color: var(--text-heading);
		font-family: 'Space Mono', monospace; font-size: 14px;
		outline: none; transition: border-color 0.12s;
		text-align: center; letter-spacing: 0.4em;
	}
	.srs-input:focus { border-color: rgba(245, 158, 11, 0.5); }

	.srs-error {
		font-family: 'Space Mono', monospace; font-size: 11px;
		color: #f87171; padding: 6px 8px; border-radius: 6px;
		background: rgba(248, 113, 113, 0.06);
	}

	.srs-secret-wrap {
		min-height: 200px; padding: 18px;
		border-radius: 14px;
		border: 1px dashed rgba(245, 158, 11, 0.35);
		background: rgba(245, 158, 11, 0.03);
		display: flex; align-items: center; justify-content: center;
		user-select: none; -webkit-user-select: none;
		touch-action: none;
		cursor: pointer;
	}
	.srs-secret-wrap.is-revealed {
		border-style: solid;
		border-color: rgba(248, 113, 113, 0.35);
		background: rgba(248, 113, 113, 0.04);
		cursor: default;
	}
	.srs-mask {
		display: flex; flex-direction: column; align-items: center; gap: 12px;
		color: var(--text-dim);
	}
	.srs-mask-icon {
		width: 56px; height: 56px; border-radius: 50%;
		background: rgba(245, 158, 11, 0.08);
		display: flex; align-items: center; justify-content: center;
		color: #f59e0b;
	}
	.srs-mask-label {
		font-family: 'Syne', sans-serif; font-size: 13px; font-weight: 700;
		color: var(--text-heading); letter-spacing: 0.05em;
	}
	.srs-press-bar {
		width: 140px; height: 4px; border-radius: 2px;
		background: var(--bg-surface-hover); overflow: hidden;
	}
	.srs-press-fill {
		height: 100%;
		background: linear-gradient(90deg, #f59e0b, #ef4444);
		transition: width 60ms linear;
	}

	.srs-warn {
		display: flex; gap: 8px; align-items: flex-start;
		padding: 9px 11px; border-radius: 10px;
		background: rgba(239, 68, 68, 0.08);
		border: 1px solid rgba(239, 68, 68, 0.25);
		color: #fca5a5;
		font-family: 'Space Mono', monospace; font-size: 11px;
		line-height: 1.45;
	}
	.srs-warn svg { flex-shrink: 0; margin-top: 1px; color: #f87171; }

	.srs-words {
		display: grid; gap: 6px; width: 100%;
	}
	.srs-words.is-12 { grid-template-columns: repeat(3, 1fr); }
	.srs-words.is-24 { grid-template-columns: repeat(4, 1fr); }
	.srs-word {
		display: flex; gap: 6px; align-items: baseline;
		padding: 7px 8px; border-radius: 8px;
		background: var(--bg-surface-input); border: 1px solid var(--border);
	}
	.srs-word-num {
		font-family: 'Space Mono', monospace; font-size: 9px;
		color: var(--text-dim); min-width: 14px; text-align: right;
	}
	.srs-word-text {
		font-family: 'Space Mono', monospace; font-size: 12px;
		color: var(--text-heading); font-weight: 700;
		overflow: hidden; text-overflow: ellipsis;
	}
	.srs-key {
		font-family: 'Space Mono', monospace; font-size: 13px;
		color: var(--text-heading); word-break: break-all;
		line-height: 1.7; letter-spacing: 0.04em;
		text-align: center;
	}

	.srs-actions {
		display: flex; gap: 8px; align-items: stretch;
	}
	.srs-action {
		flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
		padding: 10px 8px; border-radius: 10px;
		background: var(--bg-surface-input); border: 1px solid var(--border);
		color: var(--text-heading);
		font-family: 'Syne', sans-serif; font-size: 11px; font-weight: 700;
		cursor: pointer; transition: all 0.12s;
		white-space: nowrap;
	}
	.srs-action:hover { background: var(--bg-surface-hover); }
	.srs-action.is-copied {
		background: rgba(16, 185, 129, 0.12);
		border-color: rgba(16, 185, 129, 0.4);
		color: #10b981;
	}
	.srs-action.is-on {
		background: rgba(245, 158, 11, 0.12);
		border-color: rgba(245, 158, 11, 0.4);
		color: #f59e0b;
	}
	.srs-action-danger {
		color: #f87171;
	}
	.srs-action-danger:hover {
		background: rgba(239, 68, 68, 0.1);
		border-color: rgba(239, 68, 68, 0.3);
	}

	.srs-qr-drawer {
		display: flex; flex-direction: column; align-items: center; gap: 10px;
		width: 100%;
	}
	.srs-qr-large {
		width: 200px; height: 200px; image-rendering: pixelated;
		padding: 10px; background: white; border-radius: 8px;
	}
	.srs-qr-caption {
		margin: 0; font-family: 'Space Mono', monospace; font-size: 10px;
		color: var(--text-dim); text-align: center;
	}

	.srs-footer {
		padding: 12px 18px calc(12px + env(safe-area-inset-bottom));
		border-top: 1px solid var(--border);
		display: flex; gap: 8px;
	}
	.srs-btn {
		flex: 1; padding: 11px; border-radius: 10px; border: none;
		font-family: 'Syne', sans-serif; font-size: 13px; font-weight: 700;
		cursor: pointer; transition: all 0.12s;
	}
	.srs-btn-ghost { background: var(--bg-surface-input); color: var(--text-heading); }
	.srs-btn-ghost:hover:not(:disabled) { background: var(--bg-surface-hover); }
	.srs-btn-primary {
		background: linear-gradient(135deg, #f59e0b, #ef4444); color: white;
	}
	.srs-btn-primary:hover:not(:disabled) { filter: brightness(1.08); }
	.srs-btn:disabled { opacity: 0.5; cursor: not-allowed; }
	.srs-btn-full { flex: 1; }
</style>
