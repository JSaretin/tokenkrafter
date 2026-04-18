import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { deployTokenStack, createToken, PARSE_USDT } from "./helpers/fixtures";

/**
 * Comprehensive test suite for all 8 token variants.
 *
 * Bitfield (mintable=1, taxable=2, partner=4):
 *   0 BasicTokenImpl
 *   1 MintableTokenImpl
 *   2 TaxableTokenImpl
 *   3 TaxableMintableTokenImpl
 *   4 PartnerTokenImpl
 *   5 PartnerMintableTokenImpl
 *   6 PartnerTaxableTokenImpl
 *   7 PartnerTaxableMintableTokenImpl
 *
 * Hard caps per contract inspection:
 *   TaxableTokenImpl:        buy 400bps  sell 400bps  transfer 200bps
 *   PartnerTaxableTokenImpl: buy 350bps  sell 350bps  transfer 200bps (plus 50bps partner fee)
 *   Partner fee constant:    PARTNERSHIP_BPS = 50 (0.5%)
 */

// Helpers to simulate pool activity. Because the MockUniswapV2Router does not
// actually route through the pair address registered with the token, we talk
// directly to the pair to simulate DEX buys and sells.
async function impersonate(address: string) {
  await ethers.provider.send("hardhat_impersonateAccount", [address]);
  await ethers.provider.send("hardhat_setBalance", [
    address,
    "0x56BC75E2D63100000", // 100 ETH
  ]);
  return ethers.getSigner(address);
}

async function getUsdtPair(stack: any, tokenAddress: string) {
  return stack.dexFactory.getPair(tokenAddress, await stack.usdt.getAddress());
}

describe("Token variants — comprehensive behavior suite", () => {
  // ============================================================
  // BasicToken
  // ============================================================
  describe("BasicTokenImpl (type 0)", () => {
    it("performs standard ERC20 transfers", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice);
      const decimals = await token.decimals();
      const amt = 1000n * 10n ** BigInt(decimals);
      await expect(token.connect(s.alice).transfer(s.bob.address, amt))
        .to.emit(token, "Transfer")
        .withArgs(s.alice.address, s.bob.address, amt);
      expect(await token.balanceOf(s.bob.address)).to.equal(amt);
    });

    it("owner-only setMaxWalletAmount", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice);
      await expect(
        token.connect(s.bob).setMaxWalletAmount(1n)
      ).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
      await token.connect(s.alice).setMaxWalletAmount(123n);
      expect(await token.maxWalletAmount()).to.equal(123n);
    });

    it("owner-only enableTrading", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice);
      await expect(
        token.connect(s.bob).enableTrading(0)
      ).to.be.revertedWith("Not authorized");
      await token.connect(s.alice).enableTrading(0);
    });

    it("allows transfer to self", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice);
      const balBefore = await token.balanceOf(s.alice.address);
      await expect(token.connect(s.alice).transfer(s.alice.address, 100n)).to
        .not.be.reverted;
      expect(await token.balanceOf(s.alice.address)).to.equal(balBefore);
    });

    it("allows transfer of 0", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice);
      await expect(token.connect(s.alice).transfer(s.bob.address, 0n)).to.not.be
        .reverted;
      expect(await token.balanceOf(s.bob.address)).to.equal(0n);
    });

    it("approve + transferFrom works", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice);
      await token.connect(s.alice).approve(s.bob.address, 500n);
      expect(await token.allowance(s.alice.address, s.bob.address)).to.equal(
        500n
      );
      await token
        .connect(s.bob)
        .transferFrom(s.alice.address, s.carol.address, 500n);
      expect(await token.balanceOf(s.carol.address)).to.equal(500n);
      expect(await token.allowance(s.alice.address, s.bob.address)).to.equal(
        0n
      );
    });
  });

  // ============================================================
  // MintableToken
  // ============================================================
  describe("MintableTokenImpl (type 1)", () => {
    it("owner can mint, tracks totalSupply", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice, { isMintable: true });
      const before = await token.totalSupply();
      await token.connect(s.alice).mint(s.bob.address, 12345n);
      expect(await token.totalSupply()).to.equal(before + 12345n);
      expect(await token.balanceOf(s.bob.address)).to.equal(12345n);
    });

    it("non-owner cannot mint", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice, { isMintable: true });
      await expect(
        token.connect(s.bob).mint(s.bob.address, 1n)
      ).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
    });

    it("any holder can burn", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice, { isMintable: true });
      await token.connect(s.alice).transfer(s.bob.address, 1000n);
      const tsBefore = await token.totalSupply();
      await token.connect(s.bob).burn(500n);
      expect(await token.totalSupply()).to.equal(tsBefore - 500n);
      expect(await token.balanceOf(s.bob.address)).to.equal(500n);
    });
  });

  // ============================================================
  // TaxableToken
  // ============================================================
  describe("TaxableTokenImpl (type 2)", () => {
    // Helper: set up a taxable token with seeded pool + open trading.
    // Alice is marked BOTH excluded-from-limits (pool lock bypass) AND
    // tax-free (so the seeding transfer doesn't take a sell tax out of the
    // pair balance). Both flags are cleared before returning.
    async function taxableWithLiveTrading(opts?: {
      buy?: number;
      sell?: number;
      transfer?: number;
    }) {
      const s = await deployTokenStack();
      const { token, tokenAddress } = await createToken(s, s.alice, {
        isTaxable: true,
      });
      const pair = await getUsdtPair(s, tokenAddress);

      // Configure taxes
      await token
        .connect(s.alice)
        .setTaxes(opts?.buy ?? 300, opts?.sell ?? 400, opts?.transfer ?? 100);

      // Seed the pair using exempt + tax-free sender
      await token
        .connect(s.alice)
        .setExcludedFromLimits(s.alice.address, true);
      await token.connect(s.alice).excludeFromTax(s.alice.address, true);
      await token.connect(s.alice).transfer(pair, 100_000n);

      // Open trading immediately
      await token.connect(s.alice).enableTrading(0);

      // Drop both exemptions so we can test real flows
      await token
        .connect(s.alice)
        .setExcludedFromLimits(s.alice.address, false);
      await token.connect(s.alice).excludeFromTax(s.alice.address, false);

      const pairSigner = await impersonate(pair);
      return { s, token, tokenAddress, pair, pairSigner };
    }

    it("applies buy tax when from == pool", async () => {
      const { s, token, pair, pairSigner } = await taxableWithLiveTrading({
        buy: 400,
        sell: 0,
        transfer: 0,
      });
      // Pool → bob simulates a buy
      await token.connect(pairSigner).transfer(s.bob.address, 1000n);
      // 4% of 1000 = 40 burned (no tax wallets -> burn)
      expect(await token.balanceOf(s.bob.address)).to.equal(960n);
      // Pair balance lost the full 1000
      expect(await token.balanceOf(pair)).to.equal(100_000n - 1000n);
    });

    it("applies sell tax when to == pool", async () => {
      const { s, token, pair } = await taxableWithLiveTrading({
        buy: 0,
        sell: 400,
        transfer: 0,
      });
      // Give bob tokens (peer-to-peer, 0 transfer tax)
      await token.connect(s.alice).transfer(s.bob.address, 2000n);
      // bob sells into pool
      await token.connect(s.bob).transfer(pair, 1000n);
      // 4% of 1000 = 40 burned; pair gets 960
      expect(await token.balanceOf(pair)).to.equal(100_000n + 960n);
      expect(await token.balanceOf(s.bob.address)).to.equal(1000n);
    });

    it("applies transfer tax when neither side is a pool", async () => {
      const { s, token } = await taxableWithLiveTrading({
        buy: 0,
        sell: 0,
        transfer: 200,
      });
      await token.connect(s.alice).transfer(s.bob.address, 1000n);
      // 2% of 1000 = 20 burned
      expect(await token.balanceOf(s.bob.address)).to.equal(980n);
    });

    it("enforces hard caps: buy 4%, sell 4%, transfer 2%", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice, { isTaxable: true });
      await expect(
        token.connect(s.alice).setTaxes(401, 0, 0)
      ).to.be.revertedWith("Buy tax > cap");
      await expect(
        token.connect(s.alice).setTaxes(0, 401, 0)
      ).to.be.revertedWith("Sell tax > cap");
      await expect(
        token.connect(s.alice).setTaxes(0, 0, 201)
      ).to.be.revertedWith("Transfer tax > cap");
      // At the caps it should succeed
      await expect(token.connect(s.alice).setTaxes(400, 400, 200)).to.not.be
        .reverted;
    });

    it("setTaxes emits TaxesUpdated", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice, { isTaxable: true });
      await expect(token.connect(s.alice).setTaxes(100, 200, 50))
        .to.emit(token, "TaxesUpdated")
        .withArgs(100, 200, 50);
    });

    it("lockTaxCeiling snapshots current taxes + emits event", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice, { isTaxable: true });
      await token.connect(s.alice).setTaxes(100, 200, 50);
      await expect(token.connect(s.alice).lockTaxCeiling())
        .to.emit(token, "TaxCeilingLocked")
        .withArgs(100, 200, 50);
      expect(await token.taxCeilingIsLocked()).to.equal(true);
      expect(await token.taxCeilingBuy()).to.equal(100);
    });

    it("setTaxes rejects values above ceiling after lock", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice, { isTaxable: true });
      await token.connect(s.alice).setTaxes(100, 200, 50);
      await token.connect(s.alice).lockTaxCeiling();
      await expect(
        token.connect(s.alice).setTaxes(150, 200, 50)
      ).to.be.revertedWith("Buy > ceiling");
      await expect(
        token.connect(s.alice).setTaxes(100, 250, 50)
      ).to.be.revertedWith("Sell > ceiling");
      await expect(
        token.connect(s.alice).setTaxes(100, 200, 60)
      ).to.be.revertedWith("Transfer > ceiling");
      // Lowering is fine
      await expect(token.connect(s.alice).setTaxes(50, 100, 25)).to.not.be
        .reverted;
    });

    it("ceiling lock is permanent once trading starts (unlock reverts)", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice, { isTaxable: true });
      await token.connect(s.alice).setTaxes(100, 200, 50);
      await token
        .connect(s.alice)
        .setAuthorizedLauncher(s.carol.address, true);
      await token.connect(s.alice).lockTaxCeiling();
      await token.connect(s.alice).enableTrading(0);
      await expect(
        token.connect(s.carol).unlockTaxCeiling()
      ).to.be.revertedWith("Trading started");
    });

    it("unlockTaxCeiling only by authorized launcher", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice, { isTaxable: true });
      await token.connect(s.alice).setTaxes(100, 200, 50);
      await token.connect(s.alice).lockTaxCeiling();
      // Owner cannot unlock
      await expect(
        token.connect(s.alice).unlockTaxCeiling()
      ).to.be.revertedWith("Only launcher");
      // Random cannot unlock
      await expect(
        token.connect(s.bob).unlockTaxCeiling()
      ).to.be.revertedWith("Only launcher");
      // Authorized launcher can
      await token
        .connect(s.alice)
        .setAuthorizedLauncher(s.carol.address, true);
      await expect(token.connect(s.carol).unlockTaxCeiling())
        .to.emit(token, "TaxCeilingUnlocked");
      expect(await token.taxCeilingIsLocked()).to.equal(false);
    });

    it("enableTrading snapshots ceiling if not already locked", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice, { isTaxable: true });
      await token.connect(s.alice).setTaxes(250, 300, 75);
      // No explicit lockTaxCeiling — enableTrading should lock
      await token.connect(s.alice).enableTrading(0);
      expect(await token.taxCeilingIsLocked()).to.equal(true);
      expect(await token.taxCeilingBuy()).to.equal(250);
      expect(await token.taxCeilingSell()).to.equal(300);
      expect(await token.taxCeilingTransfer()).to.equal(75);
    });

    it("0/0/0 ceiling still enforced — cannot add tax later", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice, { isTaxable: true });
      // Leave taxes at 0/0/0, lock
      await token.connect(s.alice).lockTaxCeiling();
      await expect(
        token.connect(s.alice).setTaxes(10, 0, 0)
      ).to.be.revertedWith("Buy > ceiling");
    });

    it("factory is auto-tax-exempt at initialization", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice, { isTaxable: true });
      expect(
        await token.isTaxFree(await s.tokenFactory.getAddress())
      ).to.equal(true);
    });

    it("isTaxFree sender bypasses tax", async () => {
      const { s, token } = await taxableWithLiveTrading({
        buy: 0,
        sell: 0,
        transfer: 200,
      });
      await token.connect(s.alice).excludeFromTax(s.alice.address, true);
      await token.connect(s.alice).transfer(s.bob.address, 1000n);
      expect(await token.balanceOf(s.bob.address)).to.equal(1000n);
    });

    it("isTaxFree recipient bypasses tax", async () => {
      const { s, token } = await taxableWithLiveTrading({
        buy: 0,
        sell: 0,
        transfer: 200,
      });
      await token.connect(s.alice).excludeFromTax(s.bob.address, true);
      await token.connect(s.alice).transfer(s.bob.address, 1000n);
      expect(await token.balanceOf(s.bob.address)).to.equal(1000n);
    });

    it("distributes tax across multiple wallets by shares", async () => {
      const s = await deployTokenStack();
      const { token, tokenAddress } = await createToken(s, s.alice, {
        isTaxable: true,
      });
      // 60/40 split between bob and carol
      await token
        .connect(s.alice)
        .setTaxDistribution(
          [s.bob.address, s.carol.address],
          [6000, 4000]
        );
      await token.connect(s.alice).setTaxes(0, 0, 200);
      const pair = await getUsdtPair(s, tokenAddress);
      await token
        .connect(s.alice)
        .setExcludedFromLimits(s.alice.address, true);
      await token.connect(s.alice).excludeFromTax(s.alice.address, true);
      await token.connect(s.alice).transfer(pair, 10_000n);
      await token.connect(s.alice).enableTrading(0);
      await token
        .connect(s.alice)
        .setExcludedFromLimits(s.alice.address, false);
      await token.connect(s.alice).excludeFromTax(s.alice.address, false);

      // Peer-to-peer (neither alice nor dave is a tax wallet, dave not exempt)
      await token.connect(s.alice).transfer(s.dave.address, 10_000n);
      // 2% = 200; 60%/40% = 120/80
      expect(await token.balanceOf(s.bob.address)).to.equal(120n);
      expect(await token.balanceOf(s.carol.address)).to.equal(80n);
      expect(await token.balanceOf(s.dave.address)).to.equal(9800n);
    });

    it("tax-wallet addresses auto-marked isTaxFree", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice, { isTaxable: true });
      expect(await token.isTaxFree(s.bob.address)).to.equal(false);
      await token
        .connect(s.alice)
        .setTaxDistribution([s.bob.address], [10000]);
      expect(await token.isTaxFree(s.bob.address)).to.equal(true);
    });

    it("non-owner cannot setTaxes", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice, { isTaxable: true });
      await expect(
        token.connect(s.bob).setTaxes(100, 200, 50)
      ).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
    });
  });

  // ============================================================
  // PartnerToken
  // ============================================================
  describe("PartnerTokenImpl (type 4)", () => {
    // Seeds the pair with exactly 100_000 tokens by routing through the
    // factory, which is exempt from the partner fee. Path:
    //   alice → factory (no pool, no fee) → pair (factory-side, no fee).
    // This avoids the 0.5% fee that would apply on a direct alice→pair send.
    async function partnerWithLiveTrading() {
      const s = await deployTokenStack();
      const { token, tokenAddress } = await createToken(s, s.alice, {
        isPartner: true,
      });
      const pair = await getUsdtPair(s, tokenAddress);
      const factoryAddr = await s.tokenFactory.getAddress();

      // alice → factory (peer, no fee). We still need pool-lock bypass on
      // the second hop because factory→pair touches the pool mapping.
      await token.connect(s.alice).transfer(factoryAddr, 100_000n);
      const factorySigner = await impersonate(factoryAddr);
      // factory → pair: pool-involved, BUT `from == tokenFactory` so partner
      // fee path is skipped. Pool lock still fires though — factory isn't in
      // isExcludedFromLimits by default. Exclude it.
      await token
        .connect(s.alice)
        .setExcludedFromLimits(factoryAddr, true);
      await token.connect(factorySigner).transfer(pair, 100_000n);
      await token.connect(s.alice).enableTrading(0);

      const pairSigner = await impersonate(pair);
      return { s, token, tokenAddress, pair, pairSigner };
    }

    it("charges 0.5% partnership fee on buys (pool → wallet)", async () => {
      const { s, token, pair, pairSigner } = await partnerWithLiveTrading();
      const factoryAddr = await s.tokenFactory.getAddress();
      const factoryBefore = await token.balanceOf(factoryAddr);
      await token.connect(pairSigner).transfer(s.bob.address, 10_000n);
      // 0.5% of 10000 = 50 to factory, 9950 to bob
      expect(await token.balanceOf(s.bob.address)).to.equal(9950n);
      expect((await token.balanceOf(factoryAddr)) - factoryBefore).to.equal(
        50n
      );
    });

    it("charges 0.5% partnership fee on sells (wallet → pool)", async () => {
      const { s, token, pair } = await partnerWithLiveTrading();
      await token.connect(s.alice).transfer(s.bob.address, 10_000n);
      const factoryAddr = await s.tokenFactory.getAddress();
      const factoryBefore = await token.balanceOf(factoryAddr);
      await token.connect(s.bob).transfer(pair, 10_000n);
      // 0.5% of 10000 = 50 to factory, 9950 to pair
      expect((await token.balanceOf(factoryAddr)) - factoryBefore).to.equal(
        50n
      );
      expect(await token.balanceOf(pair)).to.equal(100_000n + 9950n);
    });

    it("no partnership fee on peer-to-peer transfer", async () => {
      const { s, token } = await partnerWithLiveTrading();
      const factoryAddr = await s.tokenFactory.getAddress();
      const factoryBefore = await token.balanceOf(factoryAddr);
      await token.connect(s.alice).transfer(s.bob.address, 10_000n);
      expect(await token.balanceOf(s.bob.address)).to.equal(10_000n);
      expect(await token.balanceOf(factoryAddr)).to.equal(factoryBefore);
    });

    it("no fee when counterparty is the factory itself", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice, { isPartner: true });
      const factoryAddr = await s.tokenFactory.getAddress();
      // Peer-to-peer alice → factory has no pool involvement, but we also
      // want to confirm factory-involvement shorts out the fee path even when
      // a pool WOULD be involved. Here we just assert alice → factory yields
      // an exact 1:1 transfer with no fee deduction.
      const before = await token.balanceOf(factoryAddr);
      await token.connect(s.alice).transfer(factoryAddr, 1000n);
      expect((await token.balanceOf(factoryAddr)) - before).to.equal(1000n);
    });
  });

  // ============================================================
  // PartnerTaxableToken
  // ============================================================
  describe("PartnerTaxableTokenImpl (type 6)", () => {
    it("enforces tighter caps (buy 3.5%, sell 3.5%, transfer 2%)", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice, {
        isTaxable: true,
        isPartner: true,
      });
      await expect(
        token.connect(s.alice).setTaxes(351, 0, 0)
      ).to.be.revertedWith("Buy tax > 3.5%");
      await expect(
        token.connect(s.alice).setTaxes(0, 351, 0)
      ).to.be.revertedWith("Sell tax > 3.5%");
      await expect(
        token.connect(s.alice).setTaxes(0, 0, 201)
      ).to.be.revertedWith("Transfer tax > 2%");
      // At the caps succeeds
      await expect(token.connect(s.alice).setTaxes(350, 350, 200)).to.not.be
        .reverted;
    });

    it("stacks 0.5% partnership on top of user tax on buys", async () => {
      const s = await deployTokenStack();
      const { token, tokenAddress } = await createToken(s, s.alice, {
        isTaxable: true,
        isPartner: true,
      });
      const factoryAddr = await s.tokenFactory.getAddress();
      const pair = await getUsdtPair(s, tokenAddress);

      // Set 3.5% buy tax (burned because no tax wallets)
      await token.connect(s.alice).setTaxes(350, 350, 100);
      await token
        .connect(s.alice)
        .setExcludedFromLimits(s.alice.address, true);
      await token.connect(s.alice).transfer(pair, 100_000n);
      await token.connect(s.alice).enableTrading(0);
      await token
        .connect(s.alice)
        .setExcludedFromLimits(s.alice.address, false);

      const factoryBefore = await token.balanceOf(factoryAddr);
      const pairSigner = await impersonate(pair);
      // Buy of 10_000: 0.5% (50) to factory, 3.5% (350) burned, 9600 to bob
      await token.connect(pairSigner).transfer(s.bob.address, 10_000n);
      expect(await token.balanceOf(s.bob.address)).to.equal(9600n);
      expect((await token.balanceOf(factoryAddr)) - factoryBefore).to.equal(
        50n
      );
    });

    it("stacks 0.5% partnership on top of user tax on sells", async () => {
      const s = await deployTokenStack();
      const { token, tokenAddress } = await createToken(s, s.alice, {
        isTaxable: true,
        isPartner: true,
      });
      const factoryAddr = await s.tokenFactory.getAddress();
      const pair = await getUsdtPair(s, tokenAddress);

      await token.connect(s.alice).setTaxes(0, 200, 0);

      // Seed the pair via the factory (factory involvement skips partner fee
      // AND user tax, so the pair gets exactly 100_000).
      await token.connect(s.alice).transfer(factoryAddr, 100_000n);
      const factorySigner = await impersonate(factoryAddr);
      await token
        .connect(s.alice)
        .setExcludedFromLimits(factoryAddr, true);
      await token.connect(factorySigner).transfer(pair, 100_000n);
      await token.connect(s.alice).enableTrading(0);

      // Give bob tokens via peer transfer (0 transfer tax, no pool → no
      // partner fee either).
      await token.connect(s.alice).transfer(s.bob.address, 10_000n);
      const factoryBefore = await token.balanceOf(factoryAddr);
      const pairBefore = await token.balanceOf(pair);
      await token.connect(s.bob).transfer(pair, 10_000n);
      // 0.5% = 50 factory; 2% = 200 burned; 9750 to pair
      expect((await token.balanceOf(factoryAddr)) - factoryBefore).to.equal(
        50n
      );
      expect((await token.balanceOf(pair)) - pairBefore).to.equal(9750n);
    });

    it("peer-to-peer: only user transferTax applies, no partner fee", async () => {
      const s = await deployTokenStack();
      const { token, tokenAddress } = await createToken(s, s.alice, {
        isTaxable: true,
        isPartner: true,
      });
      const factoryAddr = await s.tokenFactory.getAddress();
      const pair = await getUsdtPair(s, tokenAddress);
      await token.connect(s.alice).setTaxes(0, 0, 200);
      await token
        .connect(s.alice)
        .setExcludedFromLimits(s.alice.address, true);
      await token.connect(s.alice).transfer(pair, 10_000n);
      await token.connect(s.alice).enableTrading(0);
      await token
        .connect(s.alice)
        .setExcludedFromLimits(s.alice.address, false);

      const factoryBefore = await token.balanceOf(factoryAddr);
      await token.connect(s.alice).transfer(s.bob.address, 10_000n);
      // 2% transfer tax burned = 200; bob gets 9800; factory unchanged
      expect(await token.balanceOf(s.bob.address)).to.equal(9800n);
      expect(await token.balanceOf(factoryAddr)).to.equal(factoryBefore);
    });
  });

  // ============================================================
  // Trading gate — common to all variants
  // ============================================================
  describe("Trading gate", () => {
    it("secondsUntilTradingOpens returns type(uint256).max sentinel before enable", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice);
      expect(await token.secondsUntilTradingOpens()).to.equal(
        2n ** 256n - 1n
      );
    });

    it("enableTrading(0) → secondsUntilTradingOpens returns 0", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice);
      await token.connect(s.alice).enableTrading(0);
      expect(await token.secondsUntilTradingOpens()).to.equal(0n);
    });

    it("enableTrading(delay) → secondsUntilTradingOpens returns remaining", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice);
      await token.connect(s.alice).enableTrading(600);
      const remaining = await token.secondsUntilTradingOpens();
      expect(remaining).to.be.greaterThan(0n);
      expect(remaining).to.be.lessThanOrEqual(600n);
      await time.increase(601);
      expect(await token.secondsUntilTradingOpens()).to.equal(0n);
    });

    it("rejects delay > MAX_TRADING_DELAY (24h)", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice);
      await expect(
        token.connect(s.alice).enableTrading(24 * 3600 + 1)
      ).to.be.revertedWith("Delay > max");
    });

    it("cannot enable trading twice", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice);
      await token.connect(s.alice).enableTrading(0);
      await expect(
        token.connect(s.alice).enableTrading(0)
      ).to.be.revertedWith("Already enabled");
    });

    it("authorized launcher can enable trading", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice);
      await token
        .connect(s.alice)
        .setAuthorizedLauncher(s.carol.address, true);
      await expect(token.connect(s.carol).enableTrading(0)).to.not.be.reverted;
    });

    it("random address cannot enable trading", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice);
      await expect(
        token.connect(s.bob).enableTrading(0)
      ).to.be.revertedWith("Not authorized");
    });

    it("works on every variant", async () => {
      const s = await deployTokenStack();
      const variants = [
        { isMintable: false, isTaxable: false, isPartner: false },
        { isMintable: true, isTaxable: false, isPartner: false },
        { isMintable: false, isTaxable: true, isPartner: false },
        { isMintable: true, isTaxable: true, isPartner: false },
        { isMintable: false, isTaxable: false, isPartner: true },
        { isMintable: true, isTaxable: false, isPartner: true },
        { isMintable: false, isTaxable: true, isPartner: true },
        { isMintable: true, isTaxable: true, isPartner: true },
      ];
      for (const v of variants) {
        const { token } = await createToken(s, s.alice, v);
        await expect(token.connect(s.alice).enableTrading(0)).to.not.be
          .reverted;
        expect(await token.secondsUntilTradingOpens()).to.equal(0n);
      }
    });
  });

  // ============================================================
  // Limits
  // ============================================================
  describe("Limits (maxWallet / maxTx / cooldown)", () => {
    it("blocks transfer exceeding maxTransactionAmount", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice);
      await token.connect(s.alice).setMaxTransactionAmount(1000n);
      await token.connect(s.alice).enableTrading(0);
      // Alice (owner) is not auto-excluded, expect revert > cap
      await expect(
        token.connect(s.alice).transfer(s.bob.address, 1001n)
      ).to.be.revertedWith("Exceeds max transaction");
      // At the cap succeeds
      await expect(token.connect(s.alice).transfer(s.bob.address, 1000n)).to
        .not.be.reverted;
    });

    it("blocks receive that would push above maxWalletAmount", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice);
      await token.connect(s.alice).setMaxWalletAmount(1000n);
      await token.connect(s.alice).enableTrading(0);
      await token.connect(s.alice).transfer(s.bob.address, 1000n);
      await expect(
        token.connect(s.alice).transfer(s.bob.address, 1n)
      ).to.be.revertedWith("Exceeds max wallet");
    });

    it("enforces cooldown between sends for same wallet", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice);
      await token.connect(s.alice).setCooldownTime(60);
      await token.connect(s.alice).enableTrading(0);

      // Fund bob once (alice is non-exempt but has never transferred, so her
      // lastTransferTime is 0 — no cooldown on first send).
      await token.connect(s.alice).transfer(s.bob.address, 1000n);
      // Bob's first transfer passes — no prior timestamp yet.
      await expect(
        token.connect(s.bob).transfer(s.carol.address, 100n)
      ).to.not.be.reverted;
      // Bob's second transfer within cooldown window reverts.
      await expect(
        token.connect(s.bob).transfer(s.carol.address, 100n)
      ).to.be.revertedWith("Cooldown active");

      await time.increase(61);
      await expect(token.connect(s.bob).transfer(s.carol.address, 100n)).to.not
        .be.reverted;
    });

    it("isExcludedFromLimits bypasses all limits", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice);
      await token.connect(s.alice).setMaxTransactionAmount(1n);
      await token.connect(s.alice).setMaxWalletAmount(1n);
      await token.connect(s.alice).enableTrading(0);
      await token
        .connect(s.alice)
        .setExcludedFromLimits(s.alice.address, true);
      // Now alice can transfer freely
      await expect(token.connect(s.alice).transfer(s.bob.address, 100_000n))
        .to.not.be.reverted;
    });

    it("cannot tighten maxWallet after trading starts", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice);
      await token.connect(s.alice).setMaxWalletAmount(1000n);
      await token.connect(s.alice).enableTrading(0);
      await expect(
        token.connect(s.alice).setMaxWalletAmount(500n)
      ).to.be.revertedWith("Can only relax after trading");
      // Relaxing is fine
      await expect(token.connect(s.alice).setMaxWalletAmount(2000n)).to.not.be
        .reverted;
      // Disabling (=0) is fine
      await expect(token.connect(s.alice).setMaxWalletAmount(0n)).to.not.be
        .reverted;
    });

    it("cannot tighten cooldown after trading starts", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice);
      await token.connect(s.alice).setCooldownTime(60);
      await token.connect(s.alice).enableTrading(0);
      await expect(
        token.connect(s.alice).setCooldownTime(120)
      ).to.be.revertedWith("Can only relax after trading");
      // Relax (lower) is fine
      await expect(token.connect(s.alice).setCooldownTime(30)).to.not.be
        .reverted;
    });

    it("cannot add a maxWallet that wasn't set pre-trading", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice);
      await token.connect(s.alice).enableTrading(0);
      // No limit was set before trading → can't add one now
      await expect(
        token.connect(s.alice).setMaxWalletAmount(1000n)
      ).to.be.revertedWith("Can only relax after trading");
    });
  });

  // ============================================================
  // Blacklist window
  // ============================================================
  describe("Blacklist window", () => {
    it("setBlacklistWindow only pre-trading", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice);
      await token.connect(s.alice).enableTrading(0);
      await expect(
        token.connect(s.alice).setBlacklistWindow(60)
      ).to.be.revertedWith("Cannot change after trading");
    });

    it("cannot blacklist without blacklistWindow set", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice);
      await expect(
        token.connect(s.alice).setBlacklisted(s.bob.address, true)
      ).to.be.revertedWith("Blacklist not enabled");
    });

    it("blacklisted address cannot send or receive", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice);
      await token.connect(s.alice).setBlacklistWindow(3600);
      await token.connect(s.alice).setBlacklisted(s.bob.address, true);
      await token.connect(s.alice).enableTrading(0);

      await expect(
        token.connect(s.alice).transfer(s.bob.address, 100n)
      ).to.be.revertedWith("Blacklisted");
      // Give alice→carol so carol has tokens, then try carol→bob (blacklisted receiver)
      await token.connect(s.alice).transfer(s.carol.address, 500n);
      await expect(
        token.connect(s.carol).transfer(s.bob.address, 100n)
      ).to.be.revertedWith("Blacklisted");
    });

    it("blacklist window expires — cannot blacklist new accounts after", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice);
      await token.connect(s.alice).setBlacklistWindow(100);
      await token.connect(s.alice).enableTrading(0);
      await time.increase(200);
      await expect(
        token.connect(s.alice).setBlacklisted(s.bob.address, true)
      ).to.be.revertedWith("Blacklist window expired");
    });

    it("cannot blacklist the owner", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice);
      await token.connect(s.alice).setBlacklistWindow(3600);
      await expect(
        token.connect(s.alice).setBlacklisted(s.alice.address, true)
      ).to.be.revertedWith("Cannot blacklist owner");
    });

    it("non-blacklisted peer-to-peer unaffected", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice);
      await token.connect(s.alice).setBlacklistWindow(3600);
      await token.connect(s.alice).setBlacklisted(s.bob.address, true);
      await token.connect(s.alice).enableTrading(0);
      await expect(
        token.connect(s.alice).transfer(s.carol.address, 500n)
      ).to.not.be.reverted;
    });
  });

  // ============================================================
  // Pool lock (anti-snipe window tied to enableTrading delay)
  // ============================================================
  describe("Pool lock / anti-snipe", () => {
    it("before enableTrading, any pool-involved transfer reverts", async () => {
      const s = await deployTokenStack();
      const { token, tokenAddress } = await createToken(s, s.alice);
      const pair = await getUsdtPair(s, tokenAddress);
      await expect(
        token.connect(s.alice).transfer(pair, 1n)
      ).to.be.revertedWith("Pool locked");
    });

    it("during delay window, pool transfers still revert", async () => {
      const s = await deployTokenStack();
      const { token, tokenAddress } = await createToken(s, s.alice);
      const pair = await getUsdtPair(s, tokenAddress);
      await token
        .connect(s.alice)
        .setExcludedFromLimits(s.alice.address, true);
      await token.connect(s.alice).transfer(pair, 10_000n);
      await token.connect(s.alice).enableTrading(3600);
      await token
        .connect(s.alice)
        .setExcludedFromLimits(s.alice.address, false);
      await token.connect(s.alice).transfer(s.bob.address, 500n);
      await expect(
        token.connect(s.bob).transfer(pair, 100n)
      ).to.be.revertedWith("Pool locked");
      await time.increase(3601);
      await expect(token.connect(s.bob).transfer(pair, 100n)).to.not.be
        .reverted;
    });

    it("exempt addresses bypass pool lock", async () => {
      const s = await deployTokenStack();
      const { token, tokenAddress } = await createToken(s, s.alice);
      const pair = await getUsdtPair(s, tokenAddress);
      await token
        .connect(s.alice)
        .setExcludedFromLimits(s.alice.address, true);
      await expect(token.connect(s.alice).transfer(pair, 1000n)).to.not.be
        .reverted;
    });
  });

  // ============================================================
  // Adversarial
  // ============================================================
  describe("Adversarial", () => {
    it("unauthorized setTaxes reverts", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice, { isTaxable: true });
      await expect(
        token.connect(s.bob).setTaxes(100, 100, 50)
      ).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
    });

    it("unauthorized enableTrading reverts", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice);
      await expect(
        token.connect(s.bob).enableTrading(0)
      ).to.be.revertedWith("Not authorized");
    });

    it("cannot break tax ceiling after lock by raising", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice, { isTaxable: true });
      await token.connect(s.alice).setTaxes(50, 50, 25);
      await token.connect(s.alice).lockTaxCeiling();
      // Try all variants of raising
      await expect(
        token.connect(s.alice).setTaxes(51, 50, 25)
      ).to.be.revertedWith("Buy > ceiling");
      await expect(
        token.connect(s.alice).setTaxes(50, 51, 25)
      ).to.be.revertedWith("Sell > ceiling");
      await expect(
        token.connect(s.alice).setTaxes(50, 50, 26)
      ).to.be.revertedWith("Transfer > ceiling");
    });

    it("factory can forceRelaxTaxes but not raise", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice, { isTaxable: true });
      await token.connect(s.alice).setTaxes(200, 200, 100);
      const factoryAddr = await s.tokenFactory.getAddress();
      const factorySigner = await impersonate(factoryAddr);
      // Raise attempt
      await expect(
        token.connect(factorySigner).forceRelaxTaxes(300, 200, 100)
      ).to.be.revertedWith("Can only reduce buy");
      // Reduce succeeds
      await expect(
        token.connect(factorySigner).forceRelaxTaxes(100, 100, 50)
      ).to.not.be.reverted;
      expect(await token.buyTaxBps()).to.equal(100);
    });

    it("blacklist applies to peer-to-peer (no pool bypass trick)", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice);
      await token.connect(s.alice).setBlacklistWindow(3600);
      // Give bob tokens BEFORE blacklisting (so bob has balance to test with).
      await token.connect(s.alice).transfer(s.bob.address, 100n);
      await token.connect(s.alice).setBlacklisted(s.bob.address, true);
      await token.connect(s.alice).enableTrading(0);
      // Even a peer-to-peer transfer (no pool involvement) is rejected
      // because _checkProtections enforces the blacklist gate unconditionally.
      await expect(
        token.connect(s.bob).transfer(s.carol.address, 50n)
      ).to.be.revertedWith("Blacklisted");
    });

    it("cannot re-initialize a clone", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice);
      await expect(
        token.initialize(
          "Hack",
          "HCK",
          1n,
          18,
          s.alice.address,
          await s.tokenFactory.getAddress(),
          await s.dexFactory.getAddress(),
          []
        )
      ).to.be.reverted;
    });

    it("supply > 1e30 is rejected by factory (boundary)", async () => {
      const s = await deployTokenStack();
      const tooBig = 10n ** 30n + 1n;
      const fee = await s.tokenFactory.creationFee(0);
      await s.usdt.mint(s.alice.address, fee);
      await s.usdt
        .connect(s.alice)
        .approve(await s.tokenFactory.getAddress(), fee);
      await expect(
        s.tokenFactory.connect(s.alice).createToken(
          {
            name: "Huge",
            symbol: "HUG",
            totalSupply: tooBig,
            decimals: 18,
            isTaxable: false,
            isMintable: false,
            isPartner: false,
            bases: [
              await s.weth.getAddress(),
              await s.usdt.getAddress(),
            ],
          },
          ethers.ZeroAddress
        )
      ).to.be.revertedWithCustomError(s.tokenFactory, "InvalidParams");
    });

    it("supply == 1e30 succeeds (boundary)", async () => {
      const s = await deployTokenStack();
      const atBoundary = 10n ** 30n;
      const fee = await s.tokenFactory.creationFee(0);
      await s.usdt.mint(s.alice.address, fee);
      await s.usdt
        .connect(s.alice)
        .approve(await s.tokenFactory.getAddress(), fee);
      await expect(
        s.tokenFactory.connect(s.alice).createToken(
          {
            name: "BigOK",
            symbol: "BOK",
            totalSupply: atBoundary,
            decimals: 18,
            isTaxable: false,
            isMintable: false,
            isPartner: false,
            bases: [
              await s.weth.getAddress(),
              await s.usdt.getAddress(),
            ],
          },
          ethers.ZeroAddress
        )
      ).to.emit(s.tokenFactory, "TokenCreated");
    });

    it("transferFrom over allowance reverts", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice);
      await token.connect(s.alice).approve(s.bob.address, 100n);
      await expect(
        token
          .connect(s.bob)
          .transferFrom(s.alice.address, s.carol.address, 101n)
      ).to.be.revertedWithCustomError(token, "ERC20InsufficientAllowance");
    });
  });
});
