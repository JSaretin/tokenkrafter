<script lang="ts">
	import {
		signInWithGoogle,
		createNewWallet,
		importWallet,
		unlockWallet,
		recoverWithCode,
		setNewPin,
		getWalletState,
	} from './embeddedWallet';
	import { friendlyError } from './errorDecoder';

	let {
		open = $bindable(false),
		onConnected,
		onWalletConnect,
	}: {
		open: boolean;
		onConnected: (address: string, type: 'embedded' | 'external') => void;
		onWalletConnect: () => void; // opens WalletConnect/AppKit
	} = $props();

	type Step = 'choose' | 'google-loading' | 'pin-setup' | 'pin-enter' | 'recovery-codes' | 'forgot-pin' | 'new-pin';

	let step = $state<Step>('choose');

	// ── Step indicator helper ────────────────────────────────────────────
	// The funnel maps every internal `step` to one of three labels the
	// user actually understands. The unlock-only path (returning user) and
	// the recovery path bypass the stepper entirely — there's nothing
	// "step 1 of 3" about typing your PIN.
	function getStepperPosition(s: Step): 0 | 1 | 2 | 3 {
		// 0 = no stepper, 1..3 = active step
		switch (s) {
			case 'choose':
				return 1;
			case 'pin-setup':
				return 2;
			case 'recovery-codes':
				return 3;
			default:
				return 0;
		}
	}
	let stepperPos = $derived(getStepperPosition(step));
	let pin = $state('');
	let pinConfirm = $state('');
	let recoveryCode = $state('');
	let recoveryCodes = $state<string[]>([]);
	let error = $state('');
	let loading = $state(false);
	let codesConfirmed = $state(false);

	function reset() {
		step = 'choose';
		pin = '';
		pinConfirm = '';
		recoveryCode = '';
		recoveryCodes = [];
		error = '';
		loading = false;
		codesConfirmed = false;
	}

	function close() {
		open = false;
		reset();
	}

	/** Open modal at a specific step (called by layout after auth return) */
	export function openAt(s: Step) {
		reset();
		step = s;
		open = true;
	}

	// ── Quick Wallet (Google) ──

	async function handleGoogleLogin() {
		error = '';
		step = 'google-loading';

		try {
			await signInWithGoogle();
			// Page redirects to Google — nothing after this runs
		} catch (e: any) {
			error = e.message || 'Google sign in failed';
			step = 'choose';
		}
	}

	async function handleCreateWallet() {
		if (pin.length < 6) { error = 'PIN must be at least 6 digits'; return; }
		if (pin !== pinConfirm) { error = 'PINs do not match'; return; }

		error = '';
		loading = true;
		try {
			const result = await createNewWallet('Primary', pin);
			recoveryCodes = result.recoveryCodes;
			step = 'recovery-codes';
			const addr = result.wallet.accounts[0]?.address || '';
			onConnected(addr, 'embedded');
		} catch (e: any) {
			error = friendlyError(e);
		} finally {
			loading = false;
		}
	}

	// ── Import-existing-wallet flow (first-time connect) ──
	let isImporting = $state(false);
	let importMnemonic = $state('');
	let importAck = $state(false);

	async function handleImportFirstWallet() {
		if (pin.length < 6) { error = 'PIN must be at least 6 digits'; return; }
		if (pin !== pinConfirm) { error = 'PINs do not match'; return; }
		if (!importMnemonic.trim()) { error = 'Enter your recovery phrase'; return; }
		if (!importAck) { error = 'Acknowledge the warning'; return; }

		error = '';
		loading = true;
		try {
			// First-time import: pass `pin` explicitly so embeddedWallet caches
			// it as the shared PIN, skips the throwaway-primary step, and
			// activates the imported wallet as the only wallet on record.
			const imported = await importWallet('Imported', importMnemonic, pin);
			const addr = imported.accounts[0]?.address || '';
			onConnected(addr, 'embedded');
			close();
		} catch (e) {
			error = friendlyError(e);
		} finally {
			loading = false;
		}
	}

	async function handleUnlock() {
		if (!pin) { error = 'Enter your PIN'; return; }

		error = '';
		loading = true;
		try {
			const ok = await unlockWallet(pin);
			if (!ok) {
				error = 'Wrong PIN';
				loading = false;
				return;
			}
			const state = getWalletState();
			if (state.activeAccount) {
				onConnected(state.activeAccount.address, 'embedded');
				close();
			}
		} catch (e: any) {
			error = e.message || 'Failed to unlock';
		} finally {
			loading = false;
		}
	}

	async function handleRecover() {
		if (!recoveryCode) { error = 'Enter a recovery code'; return; }

		error = '';
		loading = true;
		try {
			const ok = await recoverWithCode(recoveryCode.toUpperCase().trim());
			if (!ok) {
				error = 'Invalid recovery code';
				loading = false;
				return;
			}
			pin = '';
			pinConfirm = '';
			step = 'new-pin';
		} catch (e: any) {
			error = e.message || 'Recovery failed';
		} finally {
			loading = false;
		}
	}

	async function handleSetNewPin() {
		if (pin.length < 6) { error = 'PIN must be at least 6 digits'; return; }
		if (pin !== pinConfirm) { error = 'PINs do not match'; return; }

		error = '';
		loading = true;
		try {
			const codes = await setNewPin(pin);
			recoveryCodes = codes;
			step = 'recovery-codes';
			const state = getWalletState();
			if (state.activeAccount) {
				onConnected(state.activeAccount.address, 'embedded');
			}
		} catch (e: any) {
			error = e.message || 'Failed to set PIN';
		} finally {
			loading = false;
		}
	}

	function handleCodesConfirmed() {
		close();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') close();
	}
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
	<div class="wm-overlay" onclick={close} role="presentation">
		<div class="wm-modal" onclick={(e) => e.stopPropagation()} role="dialog" tabindex="-1">

			<!-- 3-step progress indicator: Method → Secure → Backup. Hidden on
			     paths that don't fit the funnel (returning unlock, recovery). -->
			{#if stepperPos > 0}
				<div class="wm-stepper">
					{#each ['Method', 'Secure', 'Backup'] as label, i}
						{@const idx = i + 1}
						{@const state = idx < stepperPos ? 'done' : idx === stepperPos ? 'active' : 'todo'}
						<div class="wm-step wm-step-{state}">
							<div class="wm-step-dot">
								{#if state === 'done'}
									<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
								{:else}
									{idx}
								{/if}
							</div>
							<span class="wm-step-label">{label}</span>
						</div>
						{#if idx < 3}
							<div class="wm-step-line wm-step-line-{idx < stepperPos ? 'done' : 'todo'}"></div>
						{/if}
					{/each}
				</div>
			{/if}

			{#if step === 'choose'}
				<div class="wm-header">
					<h2 class="wm-title">Connect Wallet</h2>
					<button class="wm-close" aria-label="Close" onclick={close}>
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
					</button>
				</div>

				<button class="wm-option wm-option-primary" onclick={handleGoogleLogin}>
					<span class="wm-rec-badge">Recommended</span>
					<div class="wm-option-icon">
						<svg width="20" height="20" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
					</div>
					<div class="wm-option-info">
						<span class="wm-option-title">Quick Wallet</span>
						<span class="wm-option-desc">Sign in with Google · Instant · No app needed</span>
					</div>
				</button>

				<button class="wm-option" onclick={() => { onWalletConnect(); close(); }}>
					<div class="wm-option-icon wm-option-icon-wc">
						<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M6.09 8.95a8.5 8.5 0 0 1 11.82 0l.39.38a.4.4 0 0 1 0 .58l-1.34 1.31a.21.21 0 0 1-.3 0l-.54-.53a5.93 5.93 0 0 0-8.24 0l-.58.56a.21.21 0 0 1-.3 0L5.67 9.94a.4.4 0 0 1 0-.58l.42-.41zm14.6 2.72 1.2 1.17a.4.4 0 0 1 0 .58l-5.38 5.27a.42.42 0 0 1-.59 0l-3.82-3.74a.1.1 0 0 0-.15 0l-3.82 3.74a.42.42 0 0 1-.59 0L2.16 13.42a.4.4 0 0 1 0-.58l1.2-1.17a.42.42 0 0 1 .59 0l3.82 3.74a.1.1 0 0 0 .15 0l3.82-3.74a.42.42 0 0 1 .59 0l3.82 3.74a.1.1 0 0 0 .15 0l3.82-3.74a.42.42 0 0 1 .59 0z" fill="#3B99FC"/></svg>
					</div>
					<div class="wm-option-info">
						<span class="wm-option-title">WalletConnect</span>
						<span class="wm-option-desc">MetaMask, Trust Wallet, etc.</span>
					</div>
				</button>

			{:else if step === 'google-loading'}
				<div class="wm-header"><h2 class="wm-title">Signing in...</h2></div>
				<div class="wm-center">
					<div class="wm-spinner"></div>
					<p class="wm-hint">Redirecting to Google...</p>
				</div>

			{:else if step === 'pin-setup'}
				<h2 class="wm-title">Secure your wallet</h2>

				<!-- Explicit tabs replace the easy-to-miss inline toggle. -->
				<div class="wm-mode-tabs">
					<button class="wm-mode-tab" class:active={!isImporting} onclick={() => { isImporting = false; error = ''; }}>
						Create new
					</button>
					<button class="wm-mode-tab" class:active={isImporting} onclick={() => { isImporting = true; error = ''; }}>
						Import existing
					</button>
				</div>

				<p class="wm-hint">
					{#if isImporting}
						Paste your 12 or 24 word recovery phrase. We'll encrypt it with your PIN locally — your seed never leaves this browser.
					{:else}
						This PIN encrypts your new wallet. Only you know it — we can't recover it.
					{/if}
				</p>

				{#if isImporting}
					<textarea class="wm-input wm-textarea" rows="3" placeholder="12 or 24 word recovery phrase" bind:value={importMnemonic} autocomplete="off" autocapitalize="off" spellcheck="false" data-lpignore="true" data-1p-ignore="true"></textarea>
				{/if}

				<input class="wm-input" type="tel" inputmode="numeric" autocomplete="one-time-code" data-lpignore="true" data-1p-ignore="true" style="-webkit-text-security: disc; text-security: disc;" placeholder="Enter PIN (6+ digits)" bind:value={pin} maxlength="8" />
				<input class="wm-input" type="tel" inputmode="numeric" autocomplete="one-time-code" data-lpignore="true" data-1p-ignore="true" style="-webkit-text-security: disc; text-security: disc;" placeholder="Confirm PIN" bind:value={pinConfirm} maxlength="8"
					onkeydown={(e) => { if (e.key === 'Enter') { isImporting ? handleImportFirstWallet() : handleCreateWallet(); } }} />

				{#if isImporting}
					<label class="wm-checkbox">
						<input type="checkbox" bind:checked={importAck} />
						<span>Imported wallets have no platform recovery — I have my own backup.</span>
					</label>
				{/if}

				{#if error}<p class="wm-error">{error}</p>{/if}

				{#if isImporting}
					<button class="wm-btn wm-btn-primary" onclick={handleImportFirstWallet} disabled={loading}>
						{loading ? 'Importing...' : 'Import Wallet'}
					</button>
				{:else}
					<button class="wm-btn wm-btn-primary" onclick={handleCreateWallet} disabled={loading}>
						{loading ? 'Creating...' : 'Create Wallet'}
					</button>
				{/if}

			{:else if step === 'pin-enter'}
				<h2 class="wm-title">Unlock Wallet</h2>
				<p class="wm-hint">Enter your PIN to unlock</p>

				<input class="wm-input" type="tel" inputmode="numeric" autocomplete="one-time-code" data-lpignore="true" data-1p-ignore="true" style="-webkit-text-security: disc; text-security: disc;" placeholder="PIN" bind:value={pin} maxlength="8" autofocus
					onkeydown={(e) => { if (e.key === 'Enter') handleUnlock(); }} />

				{#if error}<p class="wm-error">{error}</p>{/if}

				<button class="wm-btn wm-btn-primary" onclick={handleUnlock} disabled={loading}>
					{loading ? 'Unlocking...' : 'Unlock'}
				</button>
				<div class="wm-links">
					<button class="wm-btn-link" onclick={() => { error = ''; step = 'forgot-pin'; }}>Forgot PIN?</button>
					<button class="wm-btn-link" onclick={async () => { error = ''; step = 'google-loading'; await signInWithGoogle(true); }}>Switch Google account</button>
				</div>

			{:else if step === 'recovery-codes'}
				<h2 class="wm-title">Recovery Codes</h2>
				<p class="wm-hint">Save these codes somewhere safe. Each can unlock your wallet if you forget your PIN. They won't be shown again.</p>

				<div class="wm-codes">
					{#each recoveryCodes as code, i}
						<div class="wm-code">{i + 1}. {code}</div>
					{/each}
				</div>

				<button class="wm-btn wm-btn-download" onclick={() => {
					const content = `TokenKrafter Wallet Recovery Codes\n${'='.repeat(40)}\n\nKeep these codes safe. Each can recover your wallet if you forget your PIN.\nDo NOT share these with anyone.\n\n${recoveryCodes.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\nGenerated: ${new Date().toISOString()}\n`;
					const blob = new Blob([content], { type: 'text/plain' });
					const url = URL.createObjectURL(blob);
					const a = document.createElement('a');
					a.href = url; a.download = 'tokenkrafter-recovery-codes.txt'; a.click();
					URL.revokeObjectURL(url);
					codesConfirmed = true;
				}}>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
					Save to Device
				</button>

				<label class="wm-checkbox">
					<input type="checkbox" bind:checked={codesConfirmed} />
					<span>I've saved my recovery codes</span>
				</label>

				<button class="wm-btn wm-btn-primary" onclick={handleCodesConfirmed} disabled={!codesConfirmed}>
					Done
				</button>

			{:else if step === 'forgot-pin'}
				<h2 class="wm-title">Recover Wallet</h2>
				<p class="wm-hint">Enter one of your recovery codes</p>

				<input class="wm-input" type="text" placeholder="XXXX-XXXX-XXXX-XXXX" bind:value={recoveryCode}
					onkeydown={(e) => { if (e.key === 'Enter') handleRecover(); }} />

				{#if error}<p class="wm-error">{error}</p>{/if}

				<button class="wm-btn wm-btn-primary" onclick={handleRecover} disabled={loading}>
					{loading ? 'Verifying...' : 'Recover'}
				</button>
				<button class="wm-btn-link" onclick={() => { error = ''; step = 'pin-enter'; }}>Back to PIN</button>

			{:else if step === 'new-pin'}
				<h2 class="wm-title">Set New PIN</h2>
				<p class="wm-hint">Recovery successful. Set a new PIN for your wallet.</p>

				<input class="wm-input" type="tel" inputmode="numeric" autocomplete="one-time-code" data-lpignore="true" data-1p-ignore="true" style="-webkit-text-security: disc; text-security: disc;" placeholder="New PIN (6+ digits)" bind:value={pin} maxlength="8" />
				<input class="wm-input" type="tel" inputmode="numeric" autocomplete="one-time-code" data-lpignore="true" data-1p-ignore="true" style="-webkit-text-security: disc; text-security: disc;" placeholder="Confirm PIN" bind:value={pinConfirm} maxlength="8"
					onkeydown={(e) => { if (e.key === 'Enter') handleSetNewPin(); }} />

				{#if error}<p class="wm-error">{error}</p>{/if}

				<button class="wm-btn wm-btn-primary" onclick={handleSetNewPin} disabled={loading}>
					{loading ? 'Saving...' : 'Set PIN & Continue'}
				</button>
			{/if}

		</div>
	</div>
{/if}

<style>
	/* 3-step progress indicator */
	.wm-stepper {
		display: flex; align-items: center; gap: 4px;
		padding: 0 4px 8px;
	}
	.wm-step { display: flex; align-items: center; gap: 6px; }
	.wm-step-dot {
		width: 22px; height: 22px; border-radius: 50%;
		display: flex; align-items: center; justify-content: center;
		font-family: 'Syne', sans-serif; font-size: 11px; font-weight: 800;
		background: rgba(255,255,255,0.04); color: #475569;
		border: 1px solid rgba(255,255,255,0.06);
		transition: all 0.2s;
	}
	.wm-step-label {
		font-family: 'Space Mono', monospace; font-size: 10px;
		color: #475569; transition: color 0.2s;
	}
	.wm-step-active .wm-step-dot {
		background: rgba(0,210,255,0.12); color: #00d2ff;
		border-color: rgba(0,210,255,0.35);
		box-shadow: 0 0 0 3px rgba(0,210,255,0.08);
	}
	.wm-step-active .wm-step-label { color: #00d2ff; font-weight: 700; }
	.wm-step-done .wm-step-dot {
		background: rgba(16,185,129,0.12); color: #10b981;
		border-color: rgba(16,185,129,0.3);
	}
	.wm-step-done .wm-step-label { color: #10b981; }
	.wm-step-line {
		flex: 1; height: 2px; border-radius: 1px;
		background: rgba(255,255,255,0.05); transition: background 0.2s;
	}
	.wm-step-line-done { background: rgba(16,185,129,0.3); }

	/* Create / Import mode tabs (replaces inline link toggle) */
	.wm-mode-tabs {
		display: flex; gap: 4px; padding: 3px;
		background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06);
		border-radius: 10px;
	}
	.wm-mode-tab {
		flex: 1; padding: 9px; border: none; background: transparent;
		color: #64748b; cursor: pointer; border-radius: 7px;
		font-family: 'Syne', sans-serif; font-size: 12px; font-weight: 700;
		transition: all 0.12s;
	}
	.wm-mode-tab:hover { color: #94a3b8; }
	.wm-mode-tab.active {
		background: rgba(0,210,255,0.1); color: #00d2ff;
		box-shadow: 0 0 0 1px rgba(0,210,255,0.2);
	}

	.wm-overlay {
		position: fixed; inset: 0; z-index: 9999;
		background: rgba(0,0,0,0.7); backdrop-filter: blur(4px);
		display: flex; align-items: center; justify-content: center;
		padding: 16px;
	}
	.wm-modal {
		background: #0f1118; border: 1px solid rgba(255,255,255,0.08);
		border-radius: 16px; padding: 24px; width: 100%; max-width: 380px;
		display: flex; flex-direction: column; gap: 12px;
	}
	.wm-title {
		font-family: 'Syne', sans-serif; font-size: 18px; font-weight: 800;
		color: #fff; margin: 0;
	}
	.wm-hint {
		font-size: 12px; color: #64748b; font-family: 'Space Mono', monospace;
		margin: 0; line-height: 1.5;
	}
	.wm-option {
		position: relative;
		display: flex; align-items: center; gap: 12px; padding: 14px;
		background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);
		border-radius: 12px; cursor: pointer; transition: all 0.15s;
		text-align: left; font-family: inherit; color: inherit;
	}
	.wm-option:hover { border-color: rgba(0,210,255,0.3); }
	.wm-option-primary { border-color: rgba(0,210,255,0.2); background: rgba(0,210,255,0.04); }
	.wm-option-primary:hover { border-color: rgba(0,210,255,0.5); }
	.wm-option-icon {
		width: 40px; height: 40px; border-radius: 10px;
		background: rgba(255,255,255,0.05); display: flex;
		align-items: center; justify-content: center; flex-shrink: 0;
	}
	.wm-option-info { flex: 1; display: flex; flex-direction: column; gap: 2px; }
	.wm-option-title { font-size: 14px; font-weight: 600; color: #fff; font-family: 'Syne', sans-serif; }
	.wm-option-desc { font-size: 10px; color: #64748b; font-family: 'Space Mono', monospace; }
	.wm-option-icon-wc { background: rgba(59,153,252,0.08); }

	/* Header with close button */
	.wm-header { display: flex; align-items: center; justify-content: space-between; }
	.wm-close {
		width: 32px; height: 32px; border-radius: 8px; border: none;
		background: rgba(255,255,255,0.05); color: #64748b;
		display: flex; align-items: center; justify-content: center;
		cursor: pointer; transition: all 0.15s; flex-shrink: 0;
	}
	.wm-close:hover { background: rgba(255,255,255,0.1); color: #fff; }

	/* Recommended badge — absolute top-right of option */
	.wm-rec-badge {
		position: absolute; top: -8px; right: 10px;
		font-size: 8px; padding: 2px 8px; border-radius: 4px;
		background: linear-gradient(135deg, #00d2ff, #3a7bd5); color: white;
		font-family: 'Space Mono', monospace; font-weight: 700;
		text-transform: uppercase; letter-spacing: 0.05em;
		box-shadow: 0 2px 8px rgba(0,210,255,0.3);
	}
	.wm-input {
		width: 100%; padding: 12px 14px; border-radius: 10px;
		background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
		color: #fff; font-family: 'Space Mono', monospace; font-size: 16px;
		outline: none; transition: border-color 0.15s;
	}
	.wm-input:focus { border-color: rgba(0,210,255,0.4); }
	.wm-input::placeholder { color: #374151; }
	.wm-textarea { font-family: 'Space Mono', monospace; resize: vertical; line-height: 1.5; }
	.wm-btn {
		padding: 12px; border-radius: 10px; border: none; cursor: pointer;
		font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 700;
		transition: all 0.15s; width: 100%;
	}
	.wm-btn:disabled { opacity: 0.5; cursor: not-allowed; }
	.wm-btn-primary {
		background: linear-gradient(135deg, #00d2ff, #3a7bd5); color: white;
	}
	.wm-btn-primary:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 4px 20px rgba(0,210,255,0.3); }
	.wm-links { display: flex; justify-content: space-between; }
	.wm-btn-link {
		background: none; border: none; color: #64748b; cursor: pointer;
		font-family: 'Space Mono', monospace; font-size: 11px;
		text-decoration: underline; padding: 4px;
	}
	.wm-btn-link:hover { color: #00d2ff; }
	.wm-error {
		font-size: 11px; color: #f87171; font-family: 'Space Mono', monospace;
		margin: 0; padding: 6px 10px; background: rgba(248,113,113,0.08);
		border-radius: 6px;
	}
	.wm-codes {
		display: flex; flex-direction: column; gap: 6px;
		padding: 12px; background: rgba(16,185,129,0.06);
		border: 1px solid rgba(16,185,129,0.15); border-radius: 10px;
	}
	.wm-code {
		font-family: 'Space Mono', monospace; font-size: 13px;
		color: #10b981; letter-spacing: 0.05em;
	}
	.wm-btn-download {
		display: flex; align-items: center; justify-content: center; gap: 8px;
		width: 100%; padding: 10px; border-radius: 10px;
		border: 1px solid rgba(16,185,129,0.2); background: rgba(16,185,129,0.06);
		color: #10b981; font-family: 'Space Mono', monospace; font-size: 12px;
		cursor: pointer; transition: all 0.15s;
	}
	.wm-btn-download:hover { background: rgba(16,185,129,0.12); border-color: rgba(16,185,129,0.3); }
	.wm-checkbox {
		display: flex; align-items: center; gap: 8px;
		font-size: 11px; color: #94a3b8; font-family: 'Space Mono', monospace;
		cursor: pointer;
	}
	.wm-checkbox input { accent-color: #00d2ff; }
	.wm-center {
		display: flex; flex-direction: column; align-items: center;
		gap: 12px; padding: 24px 0;
	}
	.wm-spinner {
		width: 32px; height: 32px; border: 2px solid rgba(255,255,255,0.1);
		border-top-color: #00d2ff; border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }
</style>
