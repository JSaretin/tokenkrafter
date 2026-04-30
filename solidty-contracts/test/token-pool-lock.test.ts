import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { deployTokenStack, createToken } from "./helpers/fixtures";

// ---------------------------------------------------------------
// Pool-lock gate: the core anti-grifter / anti-snipe primitive.
//
// Properties we want to enforce:
//   1. Bases passed at init are registered as pools (marks set)
//   2. Before enableTrading is called, nobody can touch a registered pool
//      (grifter can't pre-seed at a manipulated price)
//   3. Exempt addresses (router, launch instance) bypass the gate so they
//      can seed liquidity during setup
//   4. After enableTrading(delay), the lock opens exactly `delay` seconds
//      later — not earlier (protects against owner sniping their own holders)
//   5. Peer-to-peer transfers (no pool involvement) are unrestricted from day 0
//   6. enableTrading is one-shot, caller-gated, delay-capped
//   7. addPool(base) and addPoolByAddress(pool) authorization boundaries
// ---------------------------------------------------------------
describe("Token pool-lock gate", () => {
  async function setup() {
    const stack = await deployTokenStack();
    const { token, tokenAddress } = await createToken(stack, stack.alice, {
      name: "Lock Test",
      symbol: "LOCK",
      supply: 1_000_000n,
    });
    return { stack, token, tokenAddress };
  }

  describe("Pool registration at init", () => {
    it("registers every supported base token as a pool", async () => {
      const { stack, token } = await setup();
      // The fixture factory's _supportedTokens is [USDT, native→WETH]
      // The factory skips address(0) and the token itself.
      const usdtAddr = await stack.usdt.getAddress();
      const wethAddr = await stack.weth.getAddress();

      // Both pairs should now exist on the mock DEX factory and be marked
      // as pools on the token.
      const usdtPair = await stack.dexFactory.getPair(
        await token.getAddress(),
        usdtAddr
      );
      const wethPair = await stack.dexFactory.getPair(
        await token.getAddress(),
        wethAddr
      );
      expect(usdtPair).to.not.equal(ethers.ZeroAddress);
      expect(wethPair).to.not.equal(ethers.ZeroAddress);
      expect((await token.pools(usdtPair)).isPool).to.equal(true);
      expect((await token.pools(wethPair)).isPool).to.equal(true);
    });

    it("starts with tradingStartTime = type(uint256).max (sentinel)", async () => {
      const { token } = await setup();
      const t = await token.tradingStartTime();
      expect(t).to.equal(2n ** 256n - 1n);
    });
  });

  describe("Grifter blocked from pre-seeding a pool", () => {
    it("reverts when a non-exempt holder tries to transfer into a registered pool", async () => {
      const { stack, token } = await setup();
      const usdtPair = await stack.dexFactory.getPair(
        await token.getAddress(),
        await stack.usdt.getAddress()
      );

      // Alice is the creator; give bob some tokens via a peer transfer (legal)
      await token.connect(stack.alice).transfer(stack.bob.address, 1000n);

      // Bob tries to seed the USDT pair — this is the grifter attack
      await expect(
        token.connect(stack.bob).transfer(usdtPair, 1000n)
      ).to.be.revertedWith("Pool locked");
    });

    it("also reverts for the creator/owner trying to dump during the lock", async () => {
      const { stack, token } = await setup();
      const usdtPair = await stack.dexFactory.getPair(
        await token.getAddress(),
        await stack.usdt.getAddress()
      );

      // Creator is not in isExcludedFromLimits (we removed auto-exclusion)
      // so even they cannot touch a pool before enableTrading
      await expect(
        token.connect(stack.alice).transfer(usdtPair, 1000n)
      ).to.be.revertedWith("Pool locked");
    });

    it("peer-to-peer transfers work unrestricted (no pool involvement)", async () => {
      const { stack, token } = await setup();
      // Creator → Bob: no pool in the transfer → gate doesn't fire
      await expect(token.connect(stack.alice).transfer(stack.bob.address, 1000n))
        .to.not.be.reverted;
      // Bob → Carol: same
      await expect(token.connect(stack.bob).transfer(stack.carol.address, 500n))
        .to.not.be.reverted;
    });
  });

  describe("Exempt addresses can seed liquidity during lock", () => {
    it("allows transfers into a pool when `from` is exempt", async () => {
      const { stack, token } = await setup();
      const usdtPair = await stack.dexFactory.getPair(
        await token.getAddress(),
        await stack.usdt.getAddress()
      );

      // Exempt bob — simulating "bob is the router"
      await token
        .connect(stack.alice)
        .setExcludedFromLimits(stack.bob.address, true);
      await token.connect(stack.alice).transfer(stack.bob.address, 10_000n);

      // Bob (exempt) seeds the pair — legal
      await expect(token.connect(stack.bob).transfer(usdtPair, 10_000n)).to.not
        .be.reverted;
    });

    it("allows transfers out of a pool when `to` is exempt", async () => {
      const { stack, token } = await setup();
      const usdtPair = await stack.dexFactory.getPair(
        await token.getAddress(),
        await stack.usdt.getAddress()
      );

      // Put some tokens in the pair via an exempt hand-off
      await token
        .connect(stack.alice)
        .setExcludedFromLimits(stack.bob.address, true);
      await token.connect(stack.alice).transfer(stack.bob.address, 10_000n);
      await token.connect(stack.bob).transfer(usdtPair, 10_000n);

      // Now simulate a refund path: pair → alice (alice is the recipient but
      // not exempt). Since `from == pool` and neither side is exempt, the
      // lock should still block this transfer.
      // Impersonate the pair address to send the transfer:
      await ethers.provider.send("hardhat_impersonateAccount", [usdtPair]);
      await ethers.provider.send("hardhat_setBalance", [
        usdtPair,
        "0x56BC75E2D63100000", // 100 ETH
      ]);
      const pairSigner = await ethers.getSigner(usdtPair);
      await expect(
        token.connect(pairSigner).transfer(stack.carol.address, 100n)
      ).to.be.revertedWith("Pool locked");

      // But if the destination IS exempt, it passes:
      await token
        .connect(stack.alice)
        .setExcludedFromLimits(stack.dave.address, true);
      await expect(
        token.connect(pairSigner).transfer(stack.dave.address, 100n)
      ).to.not.be.reverted;
    });
  });

  describe("enableTrading authorization and effects", () => {
    it("only owner / factory / authorized launcher can call enableTrading", async () => {
      const { stack, token } = await setup();
      await expect(
        token.connect(stack.bob).enableTrading(0)
      ).to.be.revertedWith("Not authorized");
    });

    it("caps delay at 24 hours", async () => {
      const { stack, token } = await setup();
      await expect(
        token.connect(stack.alice).enableTrading(25 * 3600)
      ).to.be.revertedWith("Delay > max");
    });

    it("can only be called once", async () => {
      const { stack, token } = await setup();
      await token.connect(stack.alice).enableTrading(0);
      await expect(
        token.connect(stack.alice).enableTrading(0)
      ).to.be.revertedWith("Already enabled");
    });

    it("sets tradingStartTime = now + delay", async () => {
      const { stack, token } = await setup();
      const delay = 3600;
      const tx = await token.connect(stack.alice).enableTrading(delay);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);
      expect(await token.tradingStartTime()).to.equal(
        BigInt(block!.timestamp) + BigInt(delay)
      );
    });
  });

  describe("Lock window timing", () => {
    it("pool transfers still revert during the delay window", async () => {
      const { stack, token } = await setup();
      const usdtPair = await stack.dexFactory.getPair(
        await token.getAddress(),
        await stack.usdt.getAddress()
      );

      // Exempt alice so she can seed (simulating the listing flow)
      await token
        .connect(stack.alice)
        .setExcludedFromLimits(stack.alice.address, true);
      await token.connect(stack.alice).transfer(usdtPair, 10_000n);

      // enableTrading with 1-hour delay
      await token.connect(stack.alice).enableTrading(3600);

      // Bob holds some tokens from a peer transfer
      await token
        .connect(stack.alice)
        .setExcludedFromLimits(stack.alice.address, false);
      await token.connect(stack.alice).transfer(stack.bob.address, 1000n);

      // Within the window, bob still cannot touch the pool
      await expect(
        token.connect(stack.bob).transfer(usdtPair, 500n)
      ).to.be.revertedWith("Pool locked");

      // Fast-forward past the window
      await time.increase(3601);

      // Now bob CAN sell into the pool
      await expect(
        token.connect(stack.bob).transfer(usdtPair, 500n)
      ).to.not.be.reverted;
    });

    it("zero-delay opens trading immediately", async () => {
      const { stack, token } = await setup();
      const usdtPair = await stack.dexFactory.getPair(
        await token.getAddress(),
        await stack.usdt.getAddress()
      );

      await token
        .connect(stack.alice)
        .setExcludedFromLimits(stack.alice.address, true);
      await token.connect(stack.alice).transfer(usdtPair, 10_000n);

      await token.connect(stack.alice).enableTrading(0);

      // No time advance — pool should be live
      await token
        .connect(stack.alice)
        .setExcludedFromLimits(stack.alice.address, false);
      await token.connect(stack.alice).transfer(stack.bob.address, 1000n);
      await expect(token.connect(stack.bob).transfer(usdtPair, 500n)).to.not.be
        .reverted;
    });
  });

  describe("addPool(base) — V2 base-by-lookup", () => {
    it("only owner or factory can call", async () => {
      const { stack, token } = await setup();
      const newBase = await (
        await ethers.getContractFactory("MockUSDT")
      ).deploy();
      await expect(
        token.connect(stack.bob).addPool(await newBase.getAddress())
      ).to.be.revertedWith("Not authorized");
    });

    it("resolves the pair via factory and marks it", async () => {
      const { stack, token } = await setup();
      const newBase = await (
        await ethers.getContractFactory("MockUSDT")
      ).deploy();
      await token.connect(stack.alice).addPool(await newBase.getAddress());
      const pair = await stack.dexFactory.getPair(
        await token.getAddress(),
        await newBase.getAddress()
      );
      expect((await token.pools(pair)).isPool).to.equal(true);
    });

    it("rejects duplicate base registration", async () => {
      const { stack, token } = await setup();
      await expect(
        token.connect(stack.alice).addPool(await stack.usdt.getAddress())
      ).to.be.revertedWith("Duplicate pool");
    });
  });

  describe("addPoolByAddress(pool) — arbitrary address for V3 / non-V2 DEXes", () => {
    it("reverts before trading is enabled (prevents weaponizing lock)", async () => {
      const { stack, token } = await setup();
      const fakePool = ethers.Wallet.createRandom().address;
      await expect(
        token.connect(stack.alice).addPoolByAddress(fakePool)
      ).to.be.revertedWith("Trading not open");
    });

    it("works after enableTrading + timelock window passes", async () => {
      const { stack, token } = await setup();
      await token.connect(stack.alice).enableTrading(0);

      const fakePool = ethers.Wallet.createRandom().address;
      await token.connect(stack.alice).addPoolByAddress(fakePool);
      expect((await token.pools(fakePool)).isPool).to.equal(true);
    });

    it("owner-only — factory cannot call it", async () => {
      const { stack, token } = await setup();
      await token.connect(stack.alice).enableTrading(0);
      await expect(
        token.connect(stack.bob).addPoolByAddress(
          ethers.Wallet.createRandom().address
        )
      ).to.be.reverted;
    });
  });

  describe("authorized launcher flow", () => {
    it("creator can authorize a contract and it can then enableTrading", async () => {
      const { stack, token } = await setup();
      // Use carol as a stand-in "launcher" — it's just a signer here, not a
      // real launch contract, but the authorization path works the same.
      await token
        .connect(stack.alice)
        .setAuthorizedLauncher(stack.carol.address, true);
      await expect(token.connect(stack.carol).enableTrading(0)).to.not.be
        .reverted;
    });

    it("unauthorized caller still reverts even after authorizedLauncher is set for another address", async () => {
      const { stack, token } = await setup();
      await token
        .connect(stack.alice)
        .setAuthorizedLauncher(stack.carol.address, true);
      await expect(
        token.connect(stack.bob).enableTrading(0)
      ).to.be.revertedWith("Not authorized");
    });
  });
});
