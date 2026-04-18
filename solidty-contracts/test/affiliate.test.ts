import { expect } from "chai";
import { ethers } from "hardhat";
import { PARSE_USDT, deployDex } from "./helpers/fixtures";

/**
 * Deploy Affiliate contract on top of MockUSDT.
 */
async function deployAffiliateStack() {
  const [owner, reporter, factory, alice, bob, carol, dave, eve] =
    await ethers.getSigners();
  const { usdt } = await deployDex();

  const Affiliate = await ethers.getContractFactory("Affiliate");
  const affiliate = await Affiliate.deploy(await usdt.getAddress(), owner.address);

  return { owner, reporter, factory, alice, bob, carol, dave, eve, usdt, affiliate };
}

/** Fund `reporter` with USDT and max-approve Affiliate for pulls. */
async function fundReporter(
  usdt: any,
  reporter: any,
  affiliate: any,
  amount: bigint
) {
  await usdt.mint(reporter.address, amount);
  await usdt
    .connect(reporter)
    .approve(await affiliate.getAddress(), ethers.MaxUint256);
}

describe("Affiliate", () => {
  describe("Deployment", () => {
    it("sets owner, usdt, and default minClaim = 1 USDT (1e6)", async () => {
      const { affiliate, usdt, owner } = await deployAffiliateStack();
      expect(await affiliate.owner()).to.equal(owner.address);
      expect(await affiliate.usdt()).to.equal(await usdt.getAddress());
      expect(await affiliate.shareBps()).to.equal(2500n);
      expect(await affiliate.minClaim()).to.equal(PARSE_USDT(1));
      expect(await affiliate.usdtDecimals()).to.equal(6n);
    });
  });

  describe("registerReferrer", () => {
    it("first call binds sticky referrer for msg.sender", async () => {
      const { affiliate, alice, bob } = await deployAffiliateStack();
      await affiliate.connect(alice).registerReferrer(bob.address);
      expect(await affiliate.referrerOf(alice.address)).to.equal(bob.address);
      const stats = await affiliate.stats(bob.address);
      expect(stats.referredCount).to.equal(1n);
    });

    it("emits ReferrerSet with args", async () => {
      const { affiliate, alice, bob } = await deployAffiliateStack();
      await expect(affiliate.connect(alice).registerReferrer(bob.address))
        .to.emit(affiliate, "ReferrerSet")
        .withArgs(alice.address, bob.address);
    });

    it("subsequent calls are no-ops (sticky)", async () => {
      const { affiliate, alice, bob, carol } = await deployAffiliateStack();
      await affiliate.connect(alice).registerReferrer(bob.address);
      await affiliate.connect(alice).registerReferrer(carol.address);
      expect(await affiliate.referrerOf(alice.address)).to.equal(bob.address);
      const cStats = await affiliate.stats(carol.address);
      expect(cStats.referredCount).to.equal(0n);
    });

    it("reverts on self-referral", async () => {
      const { affiliate, alice } = await deployAffiliateStack();
      await expect(
        affiliate.connect(alice).registerReferrer(alice.address)
      ).to.be.revertedWithCustomError(affiliate, "SelfReferral");
    });

    it("reverts on zero referrer", async () => {
      const { affiliate, alice } = await deployAffiliateStack();
      await expect(
        affiliate.connect(alice).registerReferrer(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(affiliate, "ZeroReferrer");
    });
  });

  describe("setAuthorized", () => {
    it("owner can authorize/deauthorize reporter", async () => {
      const { affiliate, owner, reporter } = await deployAffiliateStack();
      await affiliate.connect(owner).setAuthorized(reporter.address, true);
      expect(await affiliate.authorized(reporter.address)).to.equal(true);
      await affiliate.connect(owner).setAuthorized(reporter.address, false);
      expect(await affiliate.authorized(reporter.address)).to.equal(false);
    });

    it("emits AuthorizedReporter with args", async () => {
      const { affiliate, owner, reporter } = await deployAffiliateStack();
      await expect(
        affiliate.connect(owner).setAuthorized(reporter.address, true)
      )
        .to.emit(affiliate, "AuthorizedReporter")
        .withArgs(reporter.address, true);
    });

    it("authorized factory can whitelist its own clones", async () => {
      const { affiliate, owner, factory, reporter } =
        await deployAffiliateStack();
      await affiliate.connect(owner).setAuthorizedFactory(factory.address, true);
      await affiliate.connect(factory).setAuthorized(reporter.address, true);
      expect(await affiliate.authorized(reporter.address)).to.equal(true);
    });

    it("non-owner, non-factory reverts", async () => {
      const { affiliate, alice, reporter } = await deployAffiliateStack();
      await expect(
        affiliate.connect(alice).setAuthorized(reporter.address, true)
      ).to.be.revertedWithCustomError(affiliate, "NotAuthorized");
    });
  });

  describe("setAuthorizedFactory", () => {
    it("owner only", async () => {
      const { affiliate, owner, factory, alice } = await deployAffiliateStack();
      await affiliate.connect(owner).setAuthorizedFactory(factory.address, true);
      expect(await affiliate.authorizedFactory(factory.address)).to.equal(true);
      await expect(
        affiliate.connect(alice).setAuthorizedFactory(factory.address, true)
      ).to.be.revertedWithCustomError(affiliate, "OwnableUnauthorizedAccount");
    });
  });

  describe("report", () => {
    it("reverts when called by unauthorized sender", async () => {
      const { affiliate, alice, bob, reporter } = await deployAffiliateStack();
      await expect(
        affiliate.connect(reporter).report(alice.address, bob.address, 100n)
      ).to.be.revertedWithCustomError(affiliate, "NotAuthorized");
    });

    it("authorized reporter can bind ref on first call and pull cut", async () => {
      const { affiliate, usdt, owner, reporter, alice, bob } =
        await deployAffiliateStack();
      await affiliate.connect(owner).setAuthorized(reporter.address, true);
      await fundReporter(usdt, reporter, affiliate, PARSE_USDT(100));

      const fee = PARSE_USDT(10); // 10 USDT fee
      const expectedCut = (fee * 2500n) / 10000n; // 25%

      await expect(
        affiliate.connect(reporter).report(alice.address, bob.address, fee)
      )
        .to.emit(affiliate, "Reported")
        .withArgs(alice.address, bob.address, fee, expectedCut);

      expect(await affiliate.referrerOf(alice.address)).to.equal(bob.address);
      const stats = await affiliate.stats(bob.address);
      expect(stats.pending).to.equal(expectedCut);
      expect(stats.totalEarned).to.equal(expectedCut);
      expect(stats.referredCount).to.equal(1n);
      expect(stats.actionCount).to.equal(1n);
      expect(await affiliate.totalPending()).to.equal(expectedCut);
    });

    it("sticky: second report with different ref is ignored", async () => {
      const { affiliate, usdt, owner, reporter, alice, bob, carol } =
        await deployAffiliateStack();
      await affiliate.connect(owner).setAuthorized(reporter.address, true);
      await fundReporter(usdt, reporter, affiliate, PARSE_USDT(100));

      await affiliate
        .connect(reporter)
        .report(alice.address, bob.address, PARSE_USDT(10));
      await affiliate
        .connect(reporter)
        .report(alice.address, carol.address, PARSE_USDT(10));

      expect(await affiliate.referrerOf(alice.address)).to.equal(bob.address);
      const bStats = await affiliate.stats(bob.address);
      expect(bStats.pending).to.equal(PARSE_USDT(5)); // 25% * 20 USDT
      const cStats = await affiliate.stats(carol.address);
      expect(cStats.pending).to.equal(0n);
    });

    it("report with ref == user reverts with SelfReferral", async () => {
      const { affiliate, owner, reporter, alice } = await deployAffiliateStack();
      await affiliate.connect(owner).setAuthorized(reporter.address, true);
      await expect(
        affiliate
          .connect(reporter)
          .report(alice.address, alice.address, PARSE_USDT(10))
      ).to.be.revertedWithCustomError(affiliate, "SelfReferral");
    });

    it("no referrer + ref=0 → no-op credit", async () => {
      const { affiliate, usdt, owner, reporter, alice } =
        await deployAffiliateStack();
      await affiliate.connect(owner).setAuthorized(reporter.address, true);
      await fundReporter(usdt, reporter, affiliate, PARSE_USDT(100));
      const before = await usdt.balanceOf(reporter.address);
      await affiliate
        .connect(reporter)
        .report(alice.address, ethers.ZeroAddress, PARSE_USDT(10));
      expect(await usdt.balanceOf(reporter.address)).to.equal(before);
      expect(await affiliate.totalPending()).to.equal(0n);
    });

    it("bound referrer gets cut when ref=0 on subsequent report", async () => {
      const { affiliate, usdt, owner, reporter, alice, bob } =
        await deployAffiliateStack();
      await affiliate.connect(owner).setAuthorized(reporter.address, true);
      await fundReporter(usdt, reporter, affiliate, PARSE_USDT(100));
      await affiliate
        .connect(reporter)
        .report(alice.address, bob.address, PARSE_USDT(4));
      await affiliate
        .connect(reporter)
        .report(alice.address, ethers.ZeroAddress, PARSE_USDT(4));
      const stats = await affiliate.stats(bob.address);
      expect(stats.pending).to.equal(PARSE_USDT(2)); // 25% * 8 USDT
      expect(stats.actionCount).to.equal(2n);
    });

    it("zero fee short-circuits (no pull, no credit)", async () => {
      const { affiliate, owner, reporter, alice, bob, usdt } =
        await deployAffiliateStack();
      await affiliate.connect(owner).setAuthorized(reporter.address, true);
      await fundReporter(usdt, reporter, affiliate, PARSE_USDT(100));
      await affiliate
        .connect(reporter)
        .report(alice.address, bob.address, 0n);
      // The referrer is still bound (ref branch runs before fee==0)
      expect(await affiliate.referrerOf(alice.address)).to.equal(bob.address);
      const stats = await affiliate.stats(bob.address);
      expect(stats.pending).to.equal(0n);
    });

    it("reverts when reporter has not approved USDT", async () => {
      const { affiliate, usdt, owner, reporter, alice, bob } =
        await deployAffiliateStack();
      await affiliate.connect(owner).setAuthorized(reporter.address, true);
      await usdt.mint(reporter.address, PARSE_USDT(100));
      // no approval
      await expect(
        affiliate
          .connect(reporter)
          .report(alice.address, bob.address, PARSE_USDT(10))
      ).to.be.reverted; // SafeERC20 forwards the underlying allowance revert
    });
  });

  describe("claim", () => {
    async function setupWithPending(amount: bigint) {
      const ctx = await deployAffiliateStack();
      await ctx.affiliate
        .connect(ctx.owner)
        .setAuthorized(ctx.reporter.address, true);
      await fundReporter(ctx.usdt, ctx.reporter, ctx.affiliate, PARSE_USDT(1000));
      await ctx.affiliate
        .connect(ctx.reporter)
        .report(ctx.alice.address, ctx.bob.address, amount);
      return ctx;
    }

    it("transfers accrued USDT to referrer and zeros pending", async () => {
      const { affiliate, usdt, bob } = await setupWithPending(PARSE_USDT(40));
      const pending = (PARSE_USDT(40) * 2500n) / 10000n; // 10 USDT
      const before = await usdt.balanceOf(bob.address);
      await affiliate.connect(bob).claim();
      expect((await usdt.balanceOf(bob.address)) - before).to.equal(pending);
      const stats = await affiliate.stats(bob.address);
      expect(stats.pending).to.equal(0n);
      expect(stats.totalEarned).to.equal(pending);
      expect(await affiliate.totalPending()).to.equal(0n);
    });

    it("emits Claimed", async () => {
      const { affiliate, bob } = await setupWithPending(PARSE_USDT(40));
      const pending = (PARSE_USDT(40) * 2500n) / 10000n;
      await expect(affiliate.connect(bob).claim())
        .to.emit(affiliate, "Claimed")
        .withArgs(bob.address, pending);
    });

    it("nothing to claim reverts", async () => {
      const { affiliate, carol } = await deployAffiliateStack();
      await expect(
        affiliate.connect(carol).claim()
      ).to.be.revertedWithCustomError(affiliate, "NothingToClaim");
    });

    it("below minClaim reverts", async () => {
      const { affiliate, bob } = await setupWithPending(PARSE_USDT(2)); // 25% = 0.5 USDT
      await expect(
        affiliate.connect(bob).claim()
      ).to.be.revertedWithCustomError(affiliate, "BelowMinClaim");
    });

    it("non-referrer claim reverts (pending == 0)", async () => {
      const { affiliate, dave } = await setupWithPending(PARSE_USDT(40));
      await expect(
        affiliate.connect(dave).claim()
      ).to.be.revertedWithCustomError(affiliate, "NothingToClaim");
    });
  });

  describe("rescue", () => {
    it("owner can rescue non-USDT tokens", async () => {
      const { affiliate, owner, alice } = await deployAffiliateStack();
      // Send some extra token (reuse MockUSDT to mint into a stray ERC20)
      const MockUSDT = await ethers.getContractFactory("MockUSDT");
      const stray = await MockUSDT.deploy();
      await stray.mint(await affiliate.getAddress(), PARSE_USDT(50));

      await expect(
        affiliate
          .connect(owner)
          .rescue(await stray.getAddress(), alice.address, PARSE_USDT(50))
      )
        .to.emit(affiliate, "Rescued")
        .withArgs(await stray.getAddress(), alice.address, PARSE_USDT(50));
      expect(await stray.balanceOf(alice.address)).to.equal(PARSE_USDT(50));
    });

    it("owner can rescue USDT ONLY above totalPending (free surplus)", async () => {
      const { affiliate, usdt, owner, reporter, alice, bob } =
        await deployAffiliateStack();
      await affiliate.connect(owner).setAuthorized(reporter.address, true);
      await fundReporter(usdt, reporter, affiliate, PARSE_USDT(1000));
      // create pending 25 USDT
      await affiliate
        .connect(reporter)
        .report(alice.address, bob.address, PARSE_USDT(100));

      // Donate 5 USDT extra to contract
      await usdt.mint(await affiliate.getAddress(), PARSE_USDT(5));
      await affiliate
        .connect(owner)
        .rescue(await usdt.getAddress(), alice.address, PARSE_USDT(5));
      expect(await usdt.balanceOf(alice.address)).to.equal(PARSE_USDT(5));

      // Cannot rescue pending (would underpay)
      await expect(
        affiliate
          .connect(owner)
          .rescue(await usdt.getAddress(), alice.address, PARSE_USDT(1))
      ).to.be.revertedWithCustomError(affiliate, "WouldUnderpayAffiliates");
    });

    it("rescue to zero address reverts", async () => {
      const { affiliate, owner, usdt } = await deployAffiliateStack();
      await expect(
        affiliate
          .connect(owner)
          .rescue(await usdt.getAddress(), ethers.ZeroAddress, 0n)
      ).to.be.revertedWithCustomError(affiliate, "ZeroAddress");
    });

    it("non-owner cannot rescue", async () => {
      const { affiliate, alice, usdt } = await deployAffiliateStack();
      await expect(
        affiliate
          .connect(alice)
          .rescue(await usdt.getAddress(), alice.address, 0n)
      ).to.be.revertedWithCustomError(affiliate, "OwnableUnauthorizedAccount");
    });
  });

  describe("setShareBps / setMinClaim", () => {
    it("setShareBps enforces 10000 cap", async () => {
      const { affiliate, owner } = await deployAffiliateStack();
      await affiliate.connect(owner).setShareBps(5000);
      expect(await affiliate.shareBps()).to.equal(5000n);
      await expect(
        affiliate.connect(owner).setShareBps(10_001)
      ).to.be.revertedWithCustomError(affiliate, "InvalidShare");
    });

    it("setShareBps non-owner reverts", async () => {
      const { affiliate, alice } = await deployAffiliateStack();
      await expect(
        affiliate.connect(alice).setShareBps(1000)
      ).to.be.revertedWithCustomError(affiliate, "OwnableUnauthorizedAccount");
    });

    it("setMinClaim updates the floor", async () => {
      const { affiliate, owner } = await deployAffiliateStack();
      await affiliate.connect(owner).setMinClaim(PARSE_USDT(5));
      expect(await affiliate.minClaim()).to.equal(PARSE_USDT(5));
    });
  });

  describe("buy-with-referral flow (integration proxy for LaunchInstance)", () => {
    it("A's sticky ref is B; subsequent reports with C/0 keep B crediting", async () => {
      const { affiliate, usdt, owner, reporter, alice, bob, carol } =
        await deployAffiliateStack();
      await affiliate.connect(owner).setAuthorized(reporter.address, true);
      await fundReporter(usdt, reporter, affiliate, PARSE_USDT(1000));

      // A buys with ref=B → B bound
      await affiliate
        .connect(reporter)
        .report(alice.address, bob.address, PARSE_USDT(8));
      // A buys with ref=C → C ignored, B still credits
      await affiliate
        .connect(reporter)
        .report(alice.address, carol.address, PARSE_USDT(8));
      // A buys with ref=0 → B still credits
      await affiliate
        .connect(reporter)
        .report(alice.address, ethers.ZeroAddress, PARSE_USDT(8));

      const b = await affiliate.stats(bob.address);
      expect(b.pending).to.equal(PARSE_USDT(6)); // 25% * 24 USDT
      expect(b.actionCount).to.equal(3n);
      const c = await affiliate.stats(carol.address);
      expect(c.pending).to.equal(0n);
    });

    it("B claims and receives accumulated USDT", async () => {
      const { affiliate, usdt, owner, reporter, alice, bob } =
        await deployAffiliateStack();
      await affiliate.connect(owner).setAuthorized(reporter.address, true);
      await fundReporter(usdt, reporter, affiliate, PARSE_USDT(1000));
      for (let i = 0; i < 3; i++) {
        await affiliate
          .connect(reporter)
          .report(alice.address, bob.address, PARSE_USDT(8));
      }
      const pending = PARSE_USDT(6); // 25% * 24 USDT
      const before = await usdt.balanceOf(bob.address);
      await affiliate.connect(bob).claim();
      expect((await usdt.balanceOf(bob.address)) - before).to.equal(pending);
    });
  });

  describe("getStats view", () => {
    it("returns lifetime, claimed, and counters", async () => {
      const { affiliate, usdt, owner, reporter, alice, bob } =
        await deployAffiliateStack();
      await affiliate.connect(owner).setAuthorized(reporter.address, true);
      await fundReporter(usdt, reporter, affiliate, PARSE_USDT(1000));
      await affiliate
        .connect(reporter)
        .report(alice.address, bob.address, PARSE_USDT(40));
      const [pending, totalEarned, totalClaimed, referred, actions] =
        await affiliate.getStats(bob.address);
      expect(pending).to.equal(PARSE_USDT(10));
      expect(totalEarned).to.equal(PARSE_USDT(10));
      expect(totalClaimed).to.equal(0n);
      expect(referred).to.equal(1n);
      expect(actions).to.equal(1n);

      await affiliate.connect(bob).claim();
      const [p2, e2, c2] = await affiliate.getStats(bob.address);
      expect(p2).to.equal(0n);
      expect(e2).to.equal(PARSE_USDT(10));
      expect(c2).to.equal(PARSE_USDT(10));
    });
  });
});
