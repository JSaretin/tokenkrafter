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
	import { t } from '$lib/i18n';

	let {
		open = $bindable(false),
		onConnected,
		onWalletConnect,
		onDisconnect = () => {},
	}: {
		open: boolean;
		onConnected: (address: string, type: 'embedded' | 'external') => void;
		onWalletConnect: () => void; // opens WalletConnect/AppKit
		/** Called when user chooses to disconnect from the PIN entry screen
		 *  (locked state — can't get to AccountPanel to disconnect normally). */
		onDisconnect: () => void;
	} = $props();

	type Step = 'choose' | 'google-loading' | 'completing-signin' | 'pin-setup' | 'pin-enter' | 'recovery-codes' | 'forgot-pin' | 'new-pin';

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
		// Don't let the user dismiss the modal while OAuth is still resolving.
		// Completing sign-in is a transitional state that auto-advances to
		// pin-enter or pin-setup once the backend finishes.
		if (step === 'google-loading' || step === 'completing-signin') return;
		open = false;
		reset();
	}

	/** Force-close the modal — used when OAuth fails, bypasses the guard. */
	export function forceClose() {
		open = false;
		reset();
	}

	/** Open modal at a specific step (called by layout after auth return) */
	export function openAt(s: Step) {
		reset();
		step = s;
		open = true;
	}

	// Whenever the modal closes (via parent unbinding `open`, the disconnect
	// button, or any other path), reset internal step state so the next
	// "Connect Wallet" click lands on the chooser instead of the previous
	// step (e.g. pin-enter sticking around after disconnect).
	$effect(() => {
		if (!open) reset();
	});

	// ── Quick Wallet (Google) ──

	async function handleGoogleLogin() {
		error = '';
		step = 'google-loading';

		try {
			// Remember where we are so /auth/callback can bounce the user
			// back after the OAuth round-trip. Without this the callback
			// defaults to `/` and drops context.
			if (typeof window !== 'undefined') {
				const here = window.location.pathname + window.location.search;
				sessionStorage.setItem('auth_return_to', here);
			}
			await signInWithGoogle();
			// Page redirects to Google — nothing after this runs
		} catch (e: any) {
			error = e.message || 'Google sign in failed';
			step = 'choose';
		}
	}

	async function handleCreateWallet() {
		if (pin.length < 6) { error = $t('wallet.pinMinDigits'); return; }
		if (pin !== pinConfirm) { error = $t('wallet.pinsMismatch'); return; }

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
		if (pin.length < 6) { error = $t('wallet.pinMinDigits'); return; }
		if (pin !== pinConfirm) { error = $t('wallet.pinsMismatch'); return; }
		if (!importMnemonic.trim()) { error = $t('wallet.enterRecoveryPhrase'); return; }
		if (!importAck) { error = $t('wallet.ackWarning'); return; }

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
		if (!pin) { error = $t('wallet.enterYourPin'); return; }

		error = '';
		loading = true;
		try {
			const ok = await unlockWallet(pin);
			if (!ok) {
				error = $t('wallet.wrongPin');
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
				error = $t('wallet.invalidRecoveryCode');
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
		if (pin.length < 6) { error = $t('wallet.pinMinDigits'); return; }
		if (pin !== pinConfirm) { error = $t('wallet.pinsMismatch'); return; }

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

	function handleModalKeydown(e: KeyboardEvent) {
		if (e.key !== 'Tab') return;
		const modal = e.currentTarget as HTMLElement;
		const focusable = modal.querySelectorAll<HTMLElement>(
			'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
		);
		if (focusable.length === 0) return;
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		if (e.shiftKey) {
			if (document.activeElement === first) { e.preventDefault(); last.focus(); }
		} else {
			if (document.activeElement === last) { e.preventDefault(); first.focus(); }
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
	<div class="fixed inset-0 z-[9999] bg-black/70 backdrop-blur-[4px] flex items-center justify-center p-4 max-[480px]:items-end max-[480px]:p-0" onclick={close} role="presentation">
		<div class="bg-background border border-line rounded-2xl p-6 w-full max-w-[380px] flex flex-col gap-3 max-[480px]:rounded-t-2xl max-[480px]:rounded-b-none max-[480px]:h-[85vh] max-[480px]:max-h-[85vh] max-[480px]:max-w-full max-[480px]:overflow-y-auto" onclick={(e) => e.stopPropagation()} role="dialog" aria-label="Connect wallet" tabindex="-1" onkeydown={handleModalKeydown}>

			<!-- 3-step progress indicator: Method → Secure → Backup. Hidden on
			     paths that don't fit the funnel (returning unlock, recovery). -->
			{#if stepperPos > 0}
				<div class="flex items-center gap-1 px-1 pb-2">
					{#each [$t('wallet.stepMethod'), $t('wallet.stepSecure'), $t('wallet.stepBackup')] as label, i}
						{@const idx = i + 1}
						{@const state = idx < stepperPos ? 'done' : idx === stepperPos ? 'active' : 'todo'}
						<div class="flex items-center gap-1.5">
							<div class={'w-[22px] h-[22px] rounded-full flex items-center justify-center font-display text-xs2 font-extrabold border transition ' +
								(state === 'active' ? 'bg-cyan-500/[0.12] text-brand-cyan border-cyan-500/[0.35] shadow-[0_0_0_3px_rgba(0,210,255,0.08)]' :
								 state === 'done' ? 'bg-emerald-500/[0.12] text-[#10b981] border-emerald-500/30' :
								 'bg-surface-input text-dim border-line')}>
								{#if state === 'done'}
									<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
								{:else}
									{idx}
								{/if}
							</div>
							<span class={'font-mono text-3xs transition-colors ' +
								(state === 'active' ? 'text-brand-cyan font-bold' :
								 state === 'done' ? 'text-[#10b981]' :
								 'text-dim')}>{label}</span>
						</div>
						{#if idx < 3}
							<div class={'flex-1 h-0.5 rounded-sm transition-colors ' + (idx < stepperPos ? 'bg-emerald-500/30' : 'bg-surface-hover')}></div>
						{/if}
					{/each}
				</div>
			{/if}

			{#if step === 'choose'}
				<div class="flex items-center justify-between">
					<h2 class="heading-2">{$t('wallet.connectWallet')}</h2>
					<button class="w-8 h-8 rounded-lg border-none bg-surface-hover text-dim flex items-center justify-center cursor-pointer transition-colors shrink-0 hover:bg-line-input hover:text-heading" aria-label="Close" onclick={close}>
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
					</button>
				</div>

				<button class="relative flex items-center gap-3 p-3.5 bg-cyan-500/[0.04] border border-cyan-500/20 rounded-xl cursor-pointer transition text-left font-[inherit] text-[inherit] hover:border-cyan-500/50" onclick={handleGoogleLogin}>
					<span class="absolute -top-2 right-2.5 inline-flex items-center gap-1 text-4xs px-2 py-0.5 rounded bg-gradient-to-br from-[#00d2ff] to-[#3a7bd5] text-white font-mono font-bold uppercase tracking-[0.05em] shadow-[0_2px_8px_rgba(0,210,255,0.3)]">
						<svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
						{$t('wallet.recommended')}
					</span>
					<div class="w-10 h-10 rounded-[10px] bg-surface-hover flex items-center justify-center shrink-0">
						<svg width="20" height="20" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
					</div>
					<div class="flex-1 flex flex-col gap-0.5">
						<span class="text-sm font-semibold text-heading font-display">{$t('wallet.quickWallet')}</span>
						<span class="text-3xs text-dim font-mono">{$t('wallet.quickWalletDesc')}</span>
					</div>
				</button>

				<button class="relative flex items-center gap-3 p-3.5 bg-surface border border-line rounded-xl cursor-pointer transition text-left font-[inherit] text-[inherit] hover:border-cyan-500/30" onclick={() => { onWalletConnect(); close(); }}>
					<div class="w-10 h-10 rounded-[10px] flex items-center justify-center shrink-0 bg-[rgba(59,153,252,0.08)]">
						<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M6.09 8.95a8.5 8.5 0 0 1 11.82 0l.39.38a.4.4 0 0 1 0 .58l-1.34 1.31a.21.21 0 0 1-.3 0l-.54-.53a5.93 5.93 0 0 0-8.24 0l-.58.56a.21.21 0 0 1-.3 0L5.67 9.94a.4.4 0 0 1 0-.58l.42-.41zm14.6 2.72 1.2 1.17a.4.4 0 0 1 0 .58l-5.38 5.27a.42.42 0 0 1-.59 0l-3.82-3.74a.1.1 0 0 0-.15 0l-3.82 3.74a.42.42 0 0 1-.59 0L2.16 13.42a.4.4 0 0 1 0-.58l1.2-1.17a.42.42 0 0 1 .59 0l3.82 3.74a.1.1 0 0 0 .15 0l3.82-3.74a.42.42 0 0 1 .59 0l3.82 3.74a.1.1 0 0 0 .15 0l3.82-3.74a.42.42 0 0 1 .59 0z" fill="#3B99FC"/></svg>
					</div>
					<div class="flex-1 flex flex-col gap-0.5">
						<span class="text-sm font-semibold text-heading font-display">{$t('wallet.walletConnect')}</span>
						<span class="text-3xs text-dim font-mono">{$t('wallet.walletConnectDesc')}</span>
					</div>
				</button>

			{:else if step === 'google-loading'}
				<div class="flex items-center justify-between"><h2 class="heading-2">{$t('wallet.signingIn')}</h2></div>
				<div class="flex flex-col items-center gap-3 py-6">
					<div class="w-8 h-8 border-2 border-line-input border-t-brand-cyan rounded-full animate-[spin_0.8s_linear_infinite]"></div>
					<p class="text-xs text-dim font-mono m-0 leading-[1.5]">{$t('wallet.redirectingGoogle')}</p>
				</div>

			{:else if step === 'completing-signin'}
				<div class="flex items-center justify-between"><h2 class="heading-2">{$t('wallet.signingIn')}</h2></div>
				<div class="flex flex-col items-center gap-3 py-6">
					<div class="w-8 h-8 border-2 border-line-input border-t-brand-cyan rounded-full animate-[spin_0.8s_linear_infinite]"></div>
					<p class="text-xs text-dim font-mono m-0 leading-[1.5]">Completing sign-in…</p>
				</div>

			{:else if step === 'pin-setup'}
				<h2 class="heading-2">{$t('wallet.secureWallet')}</h2>

				<!-- Explicit tabs replace the easy-to-miss inline toggle. -->
				<div class="flex gap-1 p-[3px] bg-surface-input border border-line rounded-[10px]">
					<button class={'flex-1 py-2.5 border-none bg-transparent cursor-pointer rounded-[7px] font-display text-xs font-bold transition-all duration-[120ms] hover:text-muted ' + (!isImporting ? 'bg-cyan-500/10 text-brand-cyan shadow-[0_0_0_1px_rgba(0,210,255,0.2)]' : 'text-dim')} onclick={() => { isImporting = false; error = ''; }}>
						{$t('wallet.createNew')}
					</button>
					<button class={'flex-1 py-2.5 border-none bg-transparent cursor-pointer rounded-[7px] font-display text-xs font-bold transition-all duration-[120ms] hover:text-muted ' + (isImporting ? 'bg-cyan-500/10 text-brand-cyan shadow-[0_0_0_1px_rgba(0,210,255,0.2)]' : 'text-dim')} onclick={() => { isImporting = true; error = ''; }}>
						{$t('wallet.importExisting')}
					</button>
				</div>

				<p class="text-xs text-dim font-mono m-0 leading-[1.5]">
					{#if isImporting}
						{$t('wallet.importHint')}
					{:else}
						{$t('wallet.createHint')}
					{/if}
				</p>

				{#if isImporting}
					<textarea class="w-full px-3.5 py-3 rounded-[10px] bg-surface-input border border-line text-heading font-mono text-base outline-none transition-[border-color] focus:border-cyan-500/40 placeholder:text-dim resize-y leading-[1.5]" rows="3" placeholder={$t('wallet.recoveryPhrasePlaceholder')} bind:value={importMnemonic} autocomplete="off" autocapitalize="off" spellcheck="false" data-lpignore="true" data-1p-ignore="true"></textarea>
				{/if}

				<input class="w-full px-3.5 py-3 rounded-[10px] bg-surface-input border border-line text-heading font-mono text-base outline-none transition-[border-color] focus:border-cyan-500/40 placeholder:text-dim [-webkit-text-security:disc] [text-security:disc]" type="tel" inputmode="numeric" autocomplete="one-time-code" data-lpignore="true" data-1p-ignore="true" placeholder={$t('wallet.enterPin')} bind:value={pin} maxlength="8" />
				<input class="w-full px-3.5 py-3 rounded-[10px] bg-surface-input border border-line text-heading font-mono text-base outline-none transition-[border-color] focus:border-cyan-500/40 placeholder:text-dim [-webkit-text-security:disc] [text-security:disc]" type="tel" inputmode="numeric" autocomplete="one-time-code" data-lpignore="true" data-1p-ignore="true" placeholder={$t('wallet.confirmPin')} bind:value={pinConfirm} maxlength="8"
					onkeydown={(e) => { if (e.key === 'Enter') { isImporting ? handleImportFirstWallet() : handleCreateWallet(); } }} />

				{#if isImporting}
					<label class="flex items-center gap-2 text-xs2 text-muted font-mono cursor-pointer">
						<input type="checkbox" bind:checked={importAck} class="accent-brand-cyan" />
						<span>{$t('wallet.importAck')}</span>
					</label>
				{/if}

				{#if error}<p class="text-xs2 text-[#f87171] font-mono m-0 px-2.5 py-1.5 bg-[rgba(248,113,113,0.08)] rounded-md">{error}</p>{/if}

				{#if isImporting}
					<button class="p-3 rounded-[10px] border-none cursor-pointer font-display text-sm font-bold transition w-full bg-gradient-to-br from-[#00d2ff] to-[#3a7bd5] text-white hover:-translate-y-px hover:shadow-[0_4px_20px_rgba(0,210,255,0.3)] disabled:opacity-50 disabled:cursor-not-allowed disabled:translate-y-0 disabled:shadow-none" onclick={handleImportFirstWallet} disabled={loading}>
						{loading ? $t('wallet.importing') : $t('wallet.importWallet')}
					</button>
				{:else}
					<button class="p-3 rounded-[10px] border-none cursor-pointer font-display text-sm font-bold transition w-full bg-gradient-to-br from-[#00d2ff] to-[#3a7bd5] text-white hover:-translate-y-px hover:shadow-[0_4px_20px_rgba(0,210,255,0.3)] disabled:opacity-50 disabled:cursor-not-allowed disabled:translate-y-0 disabled:shadow-none" onclick={handleCreateWallet} disabled={loading}>
						{loading ? $t('wallet.creating') : $t('wallet.createWallet')}
					</button>
				{/if}

			{:else if step === 'pin-enter'}
				<h2 class="heading-2">{$t('wallet.unlockWallet')}</h2>
				<p class="text-xs text-dim font-mono m-0 leading-[1.5]">{$t('wallet.enterPinToUnlock')}</p>

				<input class="w-full px-3.5 py-3 rounded-[10px] bg-surface-input border border-line text-heading font-mono text-base outline-none transition-[border-color] focus:border-cyan-500/40 placeholder:text-dim [-webkit-text-security:disc] [text-security:disc]" type="tel" inputmode="numeric" autocomplete="one-time-code" data-lpignore="true" data-1p-ignore="true" placeholder={$t('wallet.pinPlaceholder')} bind:value={pin} maxlength="8"
					onkeydown={(e) => { if (e.key === 'Enter') handleUnlock(); }} />

				{#if error}<p class="text-xs2 text-[#f87171] font-mono m-0 px-2.5 py-1.5 bg-[rgba(248,113,113,0.08)] rounded-md">{error}</p>{/if}

				<button class="p-3 rounded-[10px] border-none cursor-pointer font-display text-sm font-bold transition w-full bg-gradient-to-br from-[#00d2ff] to-[#3a7bd5] text-white hover:-translate-y-px hover:shadow-[0_4px_20px_rgba(0,210,255,0.3)] disabled:opacity-50 disabled:cursor-not-allowed disabled:translate-y-0 disabled:shadow-none" onclick={handleUnlock} disabled={loading}>
					{loading ? $t('wallet.unlocking') : $t('wallet.unlock')}
				</button>
				<div class="flex justify-between">
					<button class="bg-none border-none text-dim cursor-pointer font-mono text-xs2 underline p-1 hover:text-brand-cyan" onclick={() => { error = ''; step = 'forgot-pin'; }}>{$t('wallet.forgotPin')}</button>
					<button class="bg-none border-none cursor-pointer font-mono text-xs2 underline p-1 text-[#f87171] hover:text-[#ef4444]" onclick={() => { onDisconnect(); open = false; }}>{$t('wallet.disconnect')}</button>
				</div>

			{:else if step === 'recovery-codes'}
				<h2 class="heading-2">{$t('wallet.recoveryCodes')}</h2>
				<p class="text-xs text-dim font-mono m-0 leading-[1.5]">{$t('wallet.recoveryCodesHint')}</p>

				<div class="flex flex-col gap-1.5 p-3 bg-emerald-500/[0.06] border border-emerald-500/[0.15] rounded-[10px]">
					{#each recoveryCodes as code, i}
						<div class="font-mono text-13 text-[#10b981] tracking-[0.05em]">{i + 1}. {code}</div>
					{/each}
				</div>

				<button class="flex items-center justify-center gap-2 w-full p-2.5 rounded-[10px] border border-emerald-500/20 bg-emerald-500/[0.06] text-[#10b981] font-mono text-xs cursor-pointer transition hover:bg-emerald-500/[0.12] hover:border-emerald-500/30" onclick={() => {
					const content = `TokenKrafter Wallet Recovery Codes\n${'='.repeat(40)}\n\nKeep these codes safe. Each can recover your wallet if you forget your PIN.\nDo NOT share these with anyone.\n\n${recoveryCodes.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\nGenerated: ${new Date().toISOString()}\n`;
					const blob = new Blob([content], { type: 'text/plain' });
					const url = URL.createObjectURL(blob);
					const a = document.createElement('a');
					a.href = url; a.download = 'tokenkrafter-recovery-codes.txt'; a.click();
					URL.revokeObjectURL(url);
					codesConfirmed = true;
				}}>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
					{$t('wallet.saveToDevice')}
				</button>

				<label class="flex items-center gap-2 text-xs2 text-muted font-mono cursor-pointer">
					<input type="checkbox" bind:checked={codesConfirmed} class="accent-brand-cyan" />
					<span>{$t('wallet.savedCodes')}</span>
				</label>

				<button class="p-3 rounded-[10px] border-none cursor-pointer font-display text-sm font-bold transition w-full bg-gradient-to-br from-[#00d2ff] to-[#3a7bd5] text-white hover:-translate-y-px hover:shadow-[0_4px_20px_rgba(0,210,255,0.3)] disabled:opacity-50 disabled:cursor-not-allowed disabled:translate-y-0 disabled:shadow-none" onclick={handleCodesConfirmed} disabled={!codesConfirmed}>
					{$t('wallet.done')}
				</button>

			{:else if step === 'forgot-pin'}
				<h2 class="heading-2">{$t('wallet.recoverWallet')}</h2>
				<p class="text-xs text-dim font-mono m-0 leading-[1.5]">{$t('wallet.enterRecoveryCode')}</p>

				<input class="w-full px-3.5 py-3 rounded-[10px] bg-surface-input border border-line text-heading font-mono text-base outline-none transition-[border-color] focus:border-cyan-500/40 placeholder:text-dim" type="text" placeholder="XXXX-XXXX-XXXX-XXXX" bind:value={recoveryCode}
					onkeydown={(e) => { if (e.key === 'Enter') handleRecover(); }} />

				{#if error}<p class="text-xs2 text-[#f87171] font-mono m-0 px-2.5 py-1.5 bg-[rgba(248,113,113,0.08)] rounded-md">{error}</p>{/if}

				<button class="p-3 rounded-[10px] border-none cursor-pointer font-display text-sm font-bold transition w-full bg-gradient-to-br from-[#00d2ff] to-[#3a7bd5] text-white hover:-translate-y-px hover:shadow-[0_4px_20px_rgba(0,210,255,0.3)] disabled:opacity-50 disabled:cursor-not-allowed disabled:translate-y-0 disabled:shadow-none" onclick={handleRecover} disabled={loading}>
					{loading ? $t('wallet.verifying') : $t('wallet.recover')}
				</button>
				<button class="bg-none border-none text-dim cursor-pointer font-mono text-xs2 underline p-1 hover:text-brand-cyan" onclick={() => { error = ''; step = 'pin-enter'; }}>{$t('wallet.backToPin')}</button>

			{:else if step === 'new-pin'}
				<h2 class="heading-2">{$t('wallet.setNewPin')}</h2>
				<p class="text-xs text-dim font-mono m-0 leading-[1.5]">{$t('wallet.recoverySuccess')}</p>

				<input class="w-full px-3.5 py-3 rounded-[10px] bg-surface-input border border-line text-heading font-mono text-base outline-none transition-[border-color] focus:border-cyan-500/40 placeholder:text-dim [-webkit-text-security:disc] [text-security:disc]" type="tel" inputmode="numeric" autocomplete="one-time-code" data-lpignore="true" data-1p-ignore="true" placeholder={$t('wallet.newPin')} bind:value={pin} maxlength="8" />
				<input class="w-full px-3.5 py-3 rounded-[10px] bg-surface-input border border-line text-heading font-mono text-base outline-none transition-[border-color] focus:border-cyan-500/40 placeholder:text-dim [-webkit-text-security:disc] [text-security:disc]" type="tel" inputmode="numeric" autocomplete="one-time-code" data-lpignore="true" data-1p-ignore="true" placeholder={$t('wallet.confirmPin')} bind:value={pinConfirm} maxlength="8"
					onkeydown={(e) => { if (e.key === 'Enter') handleSetNewPin(); }} />

				{#if error}<p class="text-xs2 text-[#f87171] font-mono m-0 px-2.5 py-1.5 bg-[rgba(248,113,113,0.08)] rounded-md">{error}</p>{/if}

				<button class="p-3 rounded-[10px] border-none cursor-pointer font-display text-sm font-bold transition w-full bg-gradient-to-br from-[#00d2ff] to-[#3a7bd5] text-white hover:-translate-y-px hover:shadow-[0_4px_20px_rgba(0,210,255,0.3)] disabled:opacity-50 disabled:cursor-not-allowed disabled:translate-y-0 disabled:shadow-none" onclick={handleSetNewPin} disabled={loading}>
					{loading ? $t('wallet.saving') : $t('wallet.setPinContinue')}
				</button>
			{/if}

		</div>
	</div>
{/if}

