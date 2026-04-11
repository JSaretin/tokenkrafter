import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
  deployTokenStack,
  deployLaunchStack,
  createToken,
  PARSE_USDT,
} from "./helpers/fixtures";

// Curve params: Linear
const LINEAR = 0;
const SOFT_CAP = PARSE_USDT(100);
const HARD_CAP = PARSE_USDT(1_000);
const DURATION_DAYS = 7;
const MAX_BUY_BPS = 500; // 5%
const CREATOR_ALLOC = 0;
const VESTING = 0;

describe("LaunchInstance", () => {
  async function setup() {
    const stack = await deployTokenStack();
    const launchStack = await deployLaunchStack(stack);
    return { ...stack, ...launchStack };
  }

  /**
   * Helper: create a token, a launch for it, configure all exemptions, and
   * return (token, launch). Launch is Pending, fully set up, ready to deposit.
   */
  async function createTokenWithLaunch(
    s: Awaited<ReturnType<typeof setup>>,
    creator = s.alice,
    opts: { lockDuration?: number; tokensForLaunch?: bigint } = {}
  ) {
    const { token, tokenAddress } = await createToken(s, creator, {
      supply: 10_000_000n,
    });

    // Pay launch fee (default is 0 so this is a no-op)
    const tx = await s.launchpadFactory
      .connect(creator)
      .createLaunch(
        tokenAddress,
        opts.tokensForLaunch ?? ethers.parseUnits("1000000", 18),
        LINEAR,
        SOFT_CAP,
        HARD_CAP,
        DURATION_DAYS,
        MAX_BUY_BPS,
        CREATOR_ALLOC,
        VESTING,
        ethers.ZeroAddress, // paymentToken = native
        0, // startTimestamp = now
        opts.lockDuration ?? 0
      );
    const receipt = await tx.wait();
    const log = receipt!.logs.find(
      (l: any) => l.fragment?.name === "LaunchCreated"
    );
    const launchAddress = log!.args[0];
    const launch = await ethers.getContractAt("LaunchInstance", launchAddress);

    return { token, tokenAddress, launch, launchAddress };
  }

  describe("preflight reason codes", () => {
    it("NOT_FUNDED before any deposit", async () => {
      const s = await setup();
      const { launch } = await createTokenWithLaunch(s);
      const [ready, reason] = await launch.preflight();
      expect(ready).to.equal(false);
      expect(reason).to.equal("NOT_FUNDED");
    });

    it("NOT_EXCLUDED_FROM_LIMITS after full deposit if launch isn't exempt", async () => {
      const s = await setup();
      const { token, launch, launchAddress } = await createTokenWithLaunch(s);
      const requiredTokens = await launch.totalTokensRequired();

      await token
        .connect(s.alice)
        .approve(launchAddress, requiredTokens);
      await launch.connect(s.alice).depositTokens(requiredTokens);

      const [ready, reason] = await launch.preflight();
      expect(ready).to.equal(false);
      expect(reason).to.equal("NOT_EXCLUDED_FROM_LIMITS");
    });

    it("NOT_AUTHORIZED_LAUNCHER once exempt but not authorized", async () => {
      const s = await setup();
      const { token, launch, launchAddress } = await createTokenWithLaunch(s);
      const requiredTokens = await launch.totalTokensRequired();

      await token.connect(s.alice).setExcludedFromLimits(launchAddress, true);
      await token.connect(s.alice).approve(launchAddress, requiredTokens);
      await launch.connect(s.alice).depositTokens(requiredTokens);

      const [ready, reason] = await launch.preflight();
      expect(ready).to.equal(false);
      expect(reason).to.equal("NOT_AUTHORIZED_LAUNCHER");
    });

    it("ready when everything is in place — auto-activates via deposit", async () => {
      const s = await setup();
      const { token, launch, launchAddress } = await createTokenWithLaunch(s);
      const requiredTokens = await launch.totalTokensRequired();

      // Set up all prerequisites BEFORE depositing so auto-activate fires
      await token.connect(s.alice).setExcludedFromLimits(launchAddress, true);
      await token.connect(s.alice).setAuthorizedLauncher(launchAddress, true);

      await token.connect(s.alice).approve(launchAddress, requiredTokens);
      await launch.connect(s.alice).depositTokens(requiredTokens);

      // Auto-activated
      expect(await launch.state()).to.equal(1); // Active
    });
  });

  describe("activate() manual gate", () => {
    it("reverts when preflight fails", async () => {
      const s = await setup();
      const { launch } = await createTokenWithLaunch(s);
      await expect(
        launch.connect(s.alice).activate()
      ).to.be.revertedWith("Preflight failed");
    });

    it("works once preflight passes (e.g. authorization added after deposit)", async () => {
      const s = await setup();
      const { token, launch, launchAddress } = await createTokenWithLaunch(s);
      const requiredTokens = await launch.totalTokensRequired();

      // Deposit first (launch is not exempt yet — stays Pending)
      await token.connect(s.alice).approve(launchAddress, requiredTokens);
      // But approve alone isn't enough; we also need to fund. The fixture's
      // supply lives on alice. depositTokens runs and preflight fails, but
      // the deposit still records.
      // To exercise the manual activate path, we need to deposit before
      // setting exemptions. depositTokens will call _tryActivate which no-ops,
      // so the tokens are still in the launch and state stays Pending.
      await token.connect(s.alice).setExcludedFromLimits(launchAddress, true);
      // Don't authorize yet
      await launch.connect(s.alice).depositTokens(requiredTokens);
      expect(await launch.state()).to.equal(0); // Pending

      // Now add authorization and manually activate
      await token.connect(s.alice).setAuthorizedLauncher(launchAddress, true);
      await launch.connect(s.alice).activate();
      expect(await launch.state()).to.equal(1); // Active
    });

    it("only creator can call activate()", async () => {
      const s = await setup();
      const { token, launch, launchAddress } = await createTokenWithLaunch(s);
      const requiredTokens = await launch.totalTokensRequired();
      await token.connect(s.alice).setExcludedFromLimits(launchAddress, true);
      await token.connect(s.alice).setAuthorizedLauncher(launchAddress, true);
      await token.connect(s.alice).approve(launchAddress, requiredTokens);
      await launch.connect(s.alice).depositTokens(requiredTokens);

      // Bob cannot activate
      await expect(launch.connect(s.bob).activate()).to.be.reverted;
    });
  });

  describe("withdrawPendingTokens recovery path", () => {
    it("creator can recover deposited tokens while launch is Pending", async () => {
      const s = await setup();
      const { token, launch, launchAddress } = await createTokenWithLaunch(s);
      const requiredTokens = await launch.totalTokensRequired();

      const balBefore = await token.balanceOf(s.alice.address);
      await token.connect(s.alice).approve(launchAddress, requiredTokens);
      await launch.connect(s.alice).depositTokens(requiredTokens);

      // Token owner never grants exemptions; creator withdraws and tries again
      await launch.connect(s.alice).withdrawPendingTokens();
      expect(await token.balanceOf(s.alice.address)).to.equal(balBefore);
    });

    it("non-creator cannot withdraw", async () => {
      const s = await setup();
      const { token, launch, launchAddress } = await createTokenWithLaunch(s);
      const requiredTokens = await launch.totalTokensRequired();
      await token.connect(s.alice).approve(launchAddress, requiredTokens);
      await launch.connect(s.alice).depositTokens(requiredTokens);
      await expect(launch.connect(s.bob).withdrawPendingTokens()).to.be
        .reverted;
    });
  });

  describe("buy + refund during curve phase", () => {
    async function activeLaunch() {
      const s = await setup();
      const { token, launch, launchAddress } = await createTokenWithLaunch(s);
      const requiredTokens = await launch.totalTokensRequired();
      await token.connect(s.alice).setExcludedFromLimits(launchAddress, true);
      await token.connect(s.alice).setAuthorizedLauncher(launchAddress, true);
      await token.connect(s.alice).approve(launchAddress, requiredTokens);
      await launch.connect(s.alice).depositTokens(requiredTokens);
      return { ...s, token, launch, launchAddress };
    }

    it("buyers can buy with USDT during curve", async () => {
      const s = await activeLaunch();
      // Mint USDT to bob
      await s.usdt.mint(s.bob.address, PARSE_USDT(100));
      await s.usdt
        .connect(s.bob)
        .approve(await s.launch.getAddress(), PARSE_USDT(50));

      await expect(
        s.launch.connect(s.bob).buyWithToken(
          await s.usdt.getAddress(),
          PARSE_USDT(50),
          0,
          0
        )
      ).to.not.be.reverted;

      expect(await s.token.balanceOf(s.bob.address)).to.be.gt(0n);
    });

    it("refund path: buyer returns tokens to launch during Refunding", async () => {
      const s = await activeLaunch();
      // Bob buys a small amount (below soft cap)
      await s.usdt.mint(s.bob.address, PARSE_USDT(100));
      await s.usdt
        .connect(s.bob)
        .approve(await s.launch.getAddress(), PARSE_USDT(50));
      await s.launch
        .connect(s.bob)
        .buyWithToken(await s.usdt.getAddress(), PARSE_USDT(50), 0, 0);

      const tokensOwned = await s.token.balanceOf(s.bob.address);
      expect(tokensOwned).to.be.gt(0n);

      // Fast-forward past deadline without hitting soft cap
      await time.increase(DURATION_DAYS * 24 * 3600 + 1);
      await s.launch.enableRefunds();
      expect(await s.launch.state()).to.equal(3); // Refunding

      // Bob approves and refunds — this transfers his tokens BACK to the
      // launch (to address is launch, which is excludedFromLimits, so the
      // pool-lock gate passes).
      await s.token
        .connect(s.bob)
        .approve(await s.launch.getAddress(), tokensOwned);
      const usdtBefore = await s.usdt.balanceOf(s.bob.address);
      const basePaid = await s.launch.basePaid(s.bob.address); // net after 1% buy fee
      await s.launch.connect(s.bob).refund();

      // Got back exactly what he paid net of the buy fee
      expect(await s.usdt.balanceOf(s.bob.address)).to.equal(usdtBefore + basePaid);
      expect(await s.token.balanceOf(s.bob.address)).to.equal(0n);
    });
  });

  describe("graduation atomically enables trading", () => {
    async function activeLaunchForGrad() {
      const stack = await deployTokenStack();
      const launchStack = await deployLaunchStack(stack);
      const s = { ...stack, ...launchStack };

      const { token, tokenAddress } = await createToken(s, s.alice, {
        supply: 10_000_000n,
      });
      // Per-wallet max buy is always 0.5%..5% of hardCap. Pick caps so we can
      // fill the hard cap across hardhat's 30 signers with manageable math.
      // hardCap = 200 USDT, maxBuyBps = 500 → maxBuyPerWallet = 10 USDT.
      const tx = await s.launchpadFactory.connect(s.alice).createLaunch(
        tokenAddress,
        ethers.parseUnits("1000000", 18),
        LINEAR,
        PARSE_USDT(100), // soft cap
        PARSE_USDT(200), // hard cap
        DURATION_DAYS,
        MAX_BUY_BPS, // 500 = 5% per wallet → 10 USDT max
        CREATOR_ALLOC,
        VESTING,
        ethers.ZeroAddress,
        0,
        300 // 5-minute anti-snipe window
      );
      const receipt = await tx.wait();
      const log = receipt!.logs.find(
        (l: any) => l.fragment?.name === "LaunchCreated"
      );
      const launchAddress = log!.args[0];
      const launch = await ethers.getContractAt("LaunchInstance", launchAddress);
      const requiredTokens = await launch.totalTokensRequired();

      await token.connect(s.alice).setExcludedFromLimits(launchAddress, true);
      await token.connect(s.alice).setAuthorizedLauncher(launchAddress, true);
      await token.connect(s.alice).approve(launchAddress, requiredTokens);
      await launch.connect(s.alice).depositTokens(requiredTokens);

      return { ...s, token, tokenAddress, launch, launchAddress };
    }

    it("_graduate sets tradingStartTime = now + lockDurationAfterListing", async () => {
      const s = await activeLaunchForGrad();

      // Fill the hard cap across 25 buyers at 10 USDT each = 250 USDT net.
      // With 1% buy fee, net to curve = 247.5, safely over hardCap of 200.
      const signers = (await ethers.getSigners()).slice(6, 6 + 25);
      const launchAddr = await s.launch.getAddress();
      const usdtAddr = await s.usdt.getAddress();
      for (const buyer of signers) {
        await s.usdt.mint(buyer.address, PARSE_USDT(20));
        await s.usdt.connect(buyer).approve(launchAddr, PARSE_USDT(20));
        try {
          await s.launch
            .connect(buyer)
            .buyWithToken(usdtAddr, PARSE_USDT(10), 0, 0);
        } catch {
          // Graduation happened mid-loop; stop buying
          break;
        }
        if ((await s.launch.state()) === 2n) break;
      }

      expect(await s.launch.state()).to.equal(2); // Graduated

      // Trading should be scheduled 5 minutes out
      const tradingStart = await s.token.tradingStartTime();
      const latest = await time.latest();
      expect(tradingStart).to.be.closeTo(BigInt(latest) + 300n, 10n);
    });
  });
});
