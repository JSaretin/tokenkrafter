<script lang="ts">
	let {
		registerPoolBase = $bindable(''),
		registerPoolByAddress = $bindable(''),
		registerPoolLoading,
		onRegisterByBase,
		onRegisterByAddress,
	}: {
		registerPoolBase: string;
		registerPoolByAddress: string;
		registerPoolLoading: boolean;
		onRegisterByBase: () => void;
		onRegisterByAddress: () => void;
	} = $props();
</script>

<div class="sub-panel">
	<h4 class="syne text-sm font-bold text-white mb-2">Register Pool</h4>
	<p class="text-gray-500 text-xs font-mono mb-3">
		Tell the token contract about a pool so transfers in/out route correctly (buy/sell tax, pool-lock gate). Only needed for DEXes your token wasn't created with.
	</p>

	<!-- By base token (V2 auto-lookup) -->
	<div class="field-group">
		<label class="label-text" for="register-pool-base">By base token (V2 auto-lookup)</label>
		<div class="flex gap-2">
			<input
				id="register-pool-base"
				class="input-field flex-1"
				type="text"
				placeholder="0x..."
				bind:value={registerPoolBase}
			/>
			<button
				class="btn-primary text-xs px-4 py-2 cursor-pointer whitespace-nowrap"
				disabled={registerPoolLoading || !registerPoolBase}
				onclick={onRegisterByBase}
			>
				{registerPoolLoading ? '...' : 'Register'}
			</button>
		</div>
		<span class="text-gray-600 text-[10px] font-mono">Pass a base ERC20 address. The contract resolves the pair through its DEX factory.</span>
	</div>

	<!-- By pool address (V3 / non-V2 DEXes) -->
	<div class="field-group mt-4">
		<label class="label-text" for="register-pool-addr">By pool address (V3 / non-V2 DEXes)</label>
		<div class="flex gap-2">
			<input
				id="register-pool-addr"
				class="input-field flex-1"
				type="text"
				placeholder="0x..."
				bind:value={registerPoolByAddress}
			/>
			<button
				class="btn-primary text-xs px-4 py-2 cursor-pointer whitespace-nowrap"
				disabled={registerPoolLoading || !registerPoolByAddress}
				onclick={onRegisterByAddress}
			>
				{registerPoolLoading ? '...' : 'Register'}
			</button>
		</div>
		<span class="text-amber-500/70 text-[10px] font-mono">Only callable after public trading has been enabled. Marking an address as a pool subjects its transfers to tax routing on taxable variants.</span>
	</div>
</div>
