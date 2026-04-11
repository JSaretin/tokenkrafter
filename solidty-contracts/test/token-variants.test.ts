import { expect } from "chai";
import { ethers } from "hardhat";
import { deployTokenStack, createToken } from "./helpers/fixtures";

// ---------------------------------------------------------------
// Variant behaviors that need to still work after folding PoolManaged
// into BasicTokenImpl. Each variant now uses `pools[addr].isPool` for
// buy/sell detection.
// ---------------------------------------------------------------
describe("Token variants", () => {
  describe("Mintable", () => {
    it("owner can mint after deploy; mint bypasses pool-lock gate", async () => {
      const stack = await deployTokenStack();
      const { token } = await createToken(stack, stack.alice, {
        isMintable: true,
      });
      const before = await token.balanceOf(stack.alice.address);
      // Mint from zero-address → _checkProtections is skipped even though
      // tradingStartTime is still the sentinel. Confirms mintable variants
      // aren't broken by the removal of the creator auto-exemption.
      await token.connect(stack.alice).mint(stack.alice.address, 1000n);
      const after = await token.balanceOf(stack.alice.address);
      expect(after - before).to.equal(1000n);
    });

    it("holder can burn their own tokens", async () => {
      const stack = await deployTokenStack();
      const { token } = await createToken(stack, stack.alice, {
        isMintable: true,
      });
      const before = await token.balanceOf(stack.alice.address);
      await token.connect(stack.alice).burn(500n);
      expect(await token.balanceOf(stack.alice.address)).to.equal(before - 500n);
    });

    it("non-owner cannot mint", async () => {
      const stack = await deployTokenStack();
      const { token } = await createToken(stack, stack.alice, {
        isMintable: true,
      });
      await expect(
        token.connect(stack.bob).mint(stack.bob.address, 1000n)
      ).to.be.reverted;
    });
  });

  describe("Taxable — buy/sell/transfer detection via pools mapping", () => {
    async function setupTaxable() {
      const stack = await deployTokenStack();
      const { token, tokenAddress } = await createToken(stack, stack.alice, {
        isTaxable: true,
        supply: 10_000_000n,
      });
      // 5% buy, 5% sell, 1% transfer
      await token.connect(stack.alice).setTaxes(500, 500, 100);
      // Single tax wallet gets 100%
      await token
        .connect(stack.alice)
        .setTaxDistribution([stack.platform.address], [10000]);

      // Open trading so regular transfers route through the tax gate
      // (with no delay — we're testing tax math, not anti-snipe)
      await token
        .connect(stack.alice)
        .setExcludedFromLimits(stack.alice.address, true);
      // Tax exclusion is a separate mapping from limit exclusion; alice must
      // be tax-free for fixture hand-offs to reach recipients untaxed.
      await token.connect(stack.alice).excludeFromTax(stack.alice.address, true);
      await token.connect(stack.alice).enableTrading(0);

      const usdtPair = await stack.dexFactory.getPair(
        tokenAddress,
        await stack.usdt.getAddress()
      );
      return { stack, token, tokenAddress, usdtPair };
    }

    it("transfer tax applies for peer-to-peer (no pool involved)", async () => {
      const { stack, token } = await setupTaxable();
      await token.connect(stack.alice).transfer(stack.bob.address, 10_000n);
      const platformBefore = await token.balanceOf(stack.platform.address);

      // Bob → Carol: 1% transfer tax (100 of 10_000 → platform)
      await token.connect(stack.bob).transfer(stack.carol.address, 10_000n);
      expect(await token.balanceOf(stack.carol.address)).to.equal(9_900n);
      expect(await token.balanceOf(stack.platform.address)).to.equal(
        platformBefore + 100n
      );
    });

    it("buy tax applies when from == pool", async () => {
      const { stack, token, usdtPair } = await setupTaxable();
      // Fund the pool from alice (excluded) — tax-free hand-off
      await token.connect(stack.alice).transfer(usdtPair, 100_000n);

      // Simulate a "buy" by transferring from the pair to bob
      await ethers.provider.send("hardhat_impersonateAccount", [usdtPair]);
      await ethers.provider.send("hardhat_setBalance", [
        usdtPair,
        "0x56BC75E2D63100000",
      ]);
      const pairSigner = await ethers.getSigner(usdtPair);

      const platformBefore = await token.balanceOf(stack.platform.address);
      await token.connect(pairSigner).transfer(stack.bob.address, 10_000n);

      // 5% buy tax → bob receives 9,500
      expect(await token.balanceOf(stack.bob.address)).to.equal(9_500n);
      expect(await token.balanceOf(stack.platform.address)).to.equal(
        platformBefore + 500n
      );
    });

    it("sell tax applies when to == pool", async () => {
      const { stack, token, usdtPair } = await setupTaxable();
      // Give bob some tokens (tax-free hand-off from excluded alice)
      await token.connect(stack.alice).transfer(stack.bob.address, 10_000n);

      const platformBefore = await token.balanceOf(stack.platform.address);
      await token.connect(stack.bob).transfer(usdtPair, 10_000n);

      // 5% sell tax
      expect(await token.balanceOf(usdtPair)).to.equal(9_500n);
      expect(await token.balanceOf(stack.platform.address)).to.equal(
        platformBefore + 500n
      );
    });

    it("caps: buy <= 10%, sell <= 10%, transfer <= 5%, total <= 25%", async () => {
      const stack = await deployTokenStack();
      const { token } = await createToken(stack, stack.alice, {
        isTaxable: true,
      });
      await expect(
        token.connect(stack.alice).setTaxes(1001, 0, 0)
      ).to.be.revertedWith("Buy tax <= 10%");
      await expect(
        token.connect(stack.alice).setTaxes(0, 1001, 0)
      ).to.be.revertedWith("Sell tax <= 10%");
      await expect(
        token.connect(stack.alice).setTaxes(0, 0, 501)
      ).to.be.revertedWith("Transfer tax <= 5%");
      await expect(
        token.connect(stack.alice).setTaxes(1000, 1000, 501)
      ).to.be.revertedWith("Transfer tax <= 5%");
    });
  });

  describe("Partner — 1% factory fee on pool interactions", () => {
    async function setupPartner() {
      const stack = await deployTokenStack();
      const { token, tokenAddress } = await createToken(stack, stack.alice, {
        isPartner: true,
        supply: 10_000_000n,
      });
      await token
        .connect(stack.alice)
        .setExcludedFromLimits(stack.alice.address, true);
      await token.connect(stack.alice).enableTrading(0);

      const usdtPair = await stack.dexFactory.getPair(
        tokenAddress,
        await stack.usdt.getAddress()
      );
      return { stack, token, tokenAddress, usdtPair };
    }

    it("partnership fee routes to tokenFactory on sells", async () => {
      const { stack, token, usdtPair } = await setupPartner();
      // Give bob tokens
      await token.connect(stack.alice).transfer(stack.bob.address, 10_000n);

      const factoryAddr = await stack.tokenFactory.getAddress();
      const factoryBefore = await token.balanceOf(factoryAddr);

      await token.connect(stack.bob).transfer(usdtPair, 10_000n);

      // 1% partnership → factory; pool receives 99%
      expect(await token.balanceOf(usdtPair)).to.equal(9_900n);
      expect(await token.balanceOf(factoryAddr)).to.equal(factoryBefore + 100n);
    });

    it("partnership fee also applies on buys", async () => {
      const { stack, token, usdtPair } = await setupPartner();
      // Fund pool (excluded alice → pair: no tax at all for partner variant)
      await token.connect(stack.alice).transfer(usdtPair, 100_000n);

      const factoryAddr = await stack.tokenFactory.getAddress();
      const factoryBefore = await token.balanceOf(factoryAddr);

      // Simulate buy: pair → bob
      await ethers.provider.send("hardhat_impersonateAccount", [usdtPair]);
      await ethers.provider.send("hardhat_setBalance", [
        usdtPair,
        "0x56BC75E2D63100000",
      ]);
      const pairSigner = await ethers.getSigner(usdtPair);
      await token.connect(pairSigner).transfer(stack.bob.address, 10_000n);

      expect(await token.balanceOf(stack.bob.address)).to.equal(9_900n);
      expect(await token.balanceOf(factoryAddr)).to.equal(factoryBefore + 100n);
    });

    it("peer-to-peer transfers carry no partnership fee", async () => {
      const { stack, token } = await setupPartner();
      await token.connect(stack.alice).transfer(stack.bob.address, 10_000n);
      const factoryAddr = await stack.tokenFactory.getAddress();
      const factoryBefore = await token.balanceOf(factoryAddr);

      await token.connect(stack.bob).transfer(stack.carol.address, 10_000n);
      expect(await token.balanceOf(stack.carol.address)).to.equal(10_000n);
      expect(await token.balanceOf(factoryAddr)).to.equal(factoryBefore);
    });
  });

  describe("PartnerTaxable — stacks 1% partnership + user taxes", () => {
    it("buy applies partnership(1%) + buyTax on top", async () => {
      const stack = await deployTokenStack();
      const { token, tokenAddress } = await createToken(stack, stack.alice, {
        isPartner: true,
        isTaxable: true,
        supply: 10_000_000n,
      });
      // 5% buy, 0% sell, 0% transfer (partner cap is 9%/9%/5%)
      await token.connect(stack.alice).setTaxes(500, 0, 0);
      await token
        .connect(stack.alice)
        .setTaxDistribution([stack.dave.address], [10000]);
      await token
        .connect(stack.alice)
        .setExcludedFromLimits(stack.alice.address, true);
      await token.connect(stack.alice).enableTrading(0);

      const usdtPair = await stack.dexFactory.getPair(
        tokenAddress,
        await stack.usdt.getAddress()
      );
      await token.connect(stack.alice).transfer(usdtPair, 100_000n);

      await ethers.provider.send("hardhat_impersonateAccount", [usdtPair]);
      await ethers.provider.send("hardhat_setBalance", [
        usdtPair,
        "0x56BC75E2D63100000",
      ]);
      const pairSigner = await ethers.getSigner(usdtPair);

      const factoryAddr = await stack.tokenFactory.getAddress();
      const factoryBefore = await token.balanceOf(factoryAddr);
      const daveBefore = await token.balanceOf(stack.dave.address);

      await token.connect(pairSigner).transfer(stack.bob.address, 10_000n);

      // 1% partnership (100) + 5% buy (500) → bob receives 9_400
      expect(await token.balanceOf(stack.bob.address)).to.equal(9_400n);
      expect(await token.balanceOf(factoryAddr)).to.equal(factoryBefore + 100n);
      expect(await token.balanceOf(stack.dave.address)).to.equal(daveBefore + 500n);
    });

    it("caps at 9% buy, 9% sell, 5% transfer, total 24%", async () => {
      const stack = await deployTokenStack();
      const { token } = await createToken(stack, stack.alice, {
        isPartner: true,
        isTaxable: true,
      });
      await expect(
        token.connect(stack.alice).setTaxes(901, 0, 0)
      ).to.be.revertedWith("Buy tax <= 9% (partner)");
      await expect(
        token.connect(stack.alice).setTaxes(0, 901, 0)
      ).to.be.revertedWith("Sell tax <= 9% (partner)");
    });
  });
});
