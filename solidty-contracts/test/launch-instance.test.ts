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
        0, // startTimestamp = now
        opts.lockDuration ?? 0,
        PARSE_USDT(1) // minBuyUsdt = 1 USDT
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
        s.launch.connect(s.bob).buy(
          [await s.usdt.getAddress(), await s.usdt.getAddress()],
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
        .buy(
          [await s.usdt.getAddress(), await s.usdt.getAddress()],
          PARSE_USDT(50),
          0,
          0
        );

      const tokensOwned = await s.token.balanceOf(s.bob.address);
      expect(tokensOwned).to.be.gt(0n);

      // Fast-forward past deadline without hitting soft cap
      await time.increase(DURATION_DAYS * 24 * 3600 + 1);
      await s.launch.resolveState();
      expect(await s.launch.state()).to.equal(3); // Refunding

      // Bob approves and refunds — this transfers his tokens BACK to the
      // launch (to address is launch, which is excludedFromLimits, so the
      // pool-lock gate passes). Full refund = returning the entire
      // tokensBought amount.
      await s.token
        .connect(s.bob)
        .approve(await s.launch.getAddress(), tokensOwned);
      const usdtBefore = await s.usdt.balanceOf(s.bob.address);
      const basePaid = await s.launch.basePaid(s.bob.address); // net after 1% buy fee
      await s.launch.connect(s.bob).refund(tokensOwned);

      // Got back exactly what he paid net of the buy fee
      expect(await s.usdt.balanceOf(s.bob.address)).to.equal(usdtBefore + basePaid);
      expect(await s.token.balanceOf(s.bob.address)).to.equal(0n);
    });
  });

  describe("partial refund + creatorWithdrawAvailable", () => {
    async function refundingLaunch() {
      const s = await setup();
      const { token, launch, launchAddress } = await createTokenWithLaunch(s);
      const requiredTokens = await launch.totalTokensRequired();
      await token.connect(s.alice).setExcludedFromLimits(launchAddress, true);
      await token.connect(s.alice).setAuthorizedLauncher(launchAddress, true);
      await token.connect(s.alice).approve(launchAddress, requiredTokens);
      await launch.connect(s.alice).depositTokens(requiredTokens);

      // Bob buys a small amount, then deadline passes → Refunding
      await s.usdt.mint(s.bob.address, PARSE_USDT(50));
      await s.usdt.connect(s.bob).approve(launchAddress, PARSE_USDT(50));
      await launch
        .connect(s.bob)
        .buy(
          [await s.usdt.getAddress(), await s.usdt.getAddress()],
          PARSE_USDT(50),
          0,
          0
        );

      await time.increase(DURATION_DAYS * 24 * 3600 + 1);
      await launch.resolveState();
      return { ...s, token, launch, launchAddress };
    }

    it("partial refund returns pro-rata USDT and leaves residual entitlement", async () => {
      const s = await refundingLaunch();
      const owned = await s.token.balanceOf(s.bob.address);
      const half = owned / 2n;

      const paidBefore = await s.launch.basePaid(s.bob.address);
      await s.token
        .connect(s.bob)
        .approve(await s.launch.getAddress(), half);
      const usdtBefore = await s.usdt.balanceOf(s.bob.address);

      await s.launch.connect(s.bob).refund(half);

      // Half the tokens returned → half the USDT entitlement (± rounding)
      const usdtAfter = await s.usdt.balanceOf(s.bob.address);
      const received = usdtAfter - usdtBefore;
      const expected = (paidBefore * half) / owned;
      expect(received).to.equal(expected);

      // Bob still has entitlement to the other half
      expect(await s.launch.basePaid(s.bob.address)).to.equal(paidBefore - expected);
      expect(await s.launch.tokensBought(s.bob.address)).to.equal(owned - half);
    });

    it("refund with tokensToReturn > bought reverts", async () => {
      const s = await refundingLaunch();
      const bought = await s.launch.tokensBought(s.bob.address);
      await s.token
        .connect(s.bob)
        .approve(await s.launch.getAddress(), bought + 1n);
      await expect(
        s.launch.connect(s.bob).refund(bought + 1n)
      ).to.be.revertedWithCustomError(s.launch, "ZeroAmount");
    });

    it("refund(0) reverts", async () => {
      const s = await refundingLaunch();
      await expect(
        s.launch.connect(s.bob).refund(0n)
      ).to.be.revertedWithCustomError(s.launch, "ZeroAmount");
    });

    it("creatorWithdrawAvailable drains the full contract balance", async () => {
      const s = await refundingLaunch();

      // Refunds are USDT-out / tokens-in, so the contract never holds a
      // "reserve" for un-refunded buyers. Every token in the balance is
      // free to withdraw.
      const launchBal = await s.token.balanceOf(await s.launch.getAddress());
      expect(launchBal).to.be.gt(0n);

      const creatorBefore = await s.token.balanceOf(s.alice.address);
      await s.launch.connect(s.alice).creatorWithdrawAvailable();
      const creatorAfter = await s.token.balanceOf(s.alice.address);

      expect(creatorAfter - creatorBefore).to.equal(launchBal);

      // Contract fully drained
      expect(
        await s.token.balanceOf(await s.launch.getAddress())
      ).to.equal(0n);
    });

    it("creatorWithdrawAvailable after buyer refunds: picks up returned tokens", async () => {
      const s = await refundingLaunch();

      const creatorStart = await s.token.balanceOf(s.alice.address);
      const deposited = await s.launch.totalTokensRequired();
      const bought = await s.launch.tokensBought(s.bob.address);

      // First reclaim: drains everything the curve didn't sell (= deposited - bought)
      await s.launch.connect(s.alice).creatorWithdrawAvailable();
      expect(
        await s.token.balanceOf(s.alice.address) - creatorStart
      ).to.equal(deposited - bought);

      // Bob refunds fully — his tokens land back in the contract
      await s.token
        .connect(s.bob)
        .approve(await s.launch.getAddress(), bought);
      await s.launch.connect(s.bob).refund(bought);

      // Second reclaim picks up Bob's returned tokens
      await s.launch.connect(s.alice).creatorWithdrawAvailable();

      // Across both calls, creator recovered the entire deposit
      expect(
        await s.token.balanceOf(s.alice.address) - creatorStart
      ).to.equal(deposited);

      // Contract drained
      expect(
        await s.token.balanceOf(await s.launch.getAddress())
      ).to.equal(0n);
    });

    it("creatorWithdrawAvailable reverts when nothing available", async () => {
      const s = await refundingLaunch();
      // First drain all the free tokens
      await s.launch.connect(s.alice).creatorWithdrawAvailable();
      // Second call: balance - tokensSold = 0 → revert
      await expect(
        s.launch.connect(s.alice).creatorWithdrawAvailable()
      ).to.be.revertedWithCustomError(s.launch, "NoTokens");
    });

    it("creatorWithdrawAvailable reverts outside Refunding state", async () => {
      const s = await setup();
      const { token, launch, launchAddress } = await createTokenWithLaunch(s);
      const req = await launch.totalTokensRequired();
      await token.connect(s.alice).setExcludedFromLimits(launchAddress, true);
      await token.connect(s.alice).setAuthorizedLauncher(launchAddress, true);
      await token.connect(s.alice).approve(launchAddress, req);
      await launch.connect(s.alice).depositTokens(req);
      // state is Active, not Refunding
      await expect(
        launch.connect(s.alice).creatorWithdrawAvailable()
      ).to.be.revertedWithCustomError(launch, "NotRefunding");
    });

    it("only creator can call creatorWithdrawAvailable", async () => {
      const s = await refundingLaunch();
      await expect(
        s.launch.connect(s.bob).creatorWithdrawAvailable()
      ).to.be.revertedWithCustomError(s.launch, "NotCreator");
    });
  });

  describe("sweepStrandedUsdt", () => {
    it("reverts before 90 days have passed", async () => {
      const s = await setup();
      const { token, launch, launchAddress } = await createTokenWithLaunch(s);
      const req = await launch.totalTokensRequired();
      await token.connect(s.alice).setExcludedFromLimits(launchAddress, true);
      await token.connect(s.alice).setAuthorizedLauncher(launchAddress, true);
      await token.connect(s.alice).approve(launchAddress, req);
      await launch.connect(s.alice).depositTokens(req);

      await time.increase(DURATION_DAYS * 24 * 3600 + 1);
      await launch.resolveState();

      await expect(
        launch.connect(s.platform).sweepStrandedUsdt()
      ).to.be.revertedWithCustomError(launch, "StrandedSweepTooEarly");
    });

    it("creator cannot sweep stranded USDT (platform-only)", async () => {
      const s = await setup();
      const { token, launch, launchAddress } = await createTokenWithLaunch(s);
      const req = await launch.totalTokensRequired();
      await token.connect(s.alice).setExcludedFromLimits(launchAddress, true);
      await token.connect(s.alice).setAuthorizedLauncher(launchAddress, true);
      await token.connect(s.alice).approve(launchAddress, req);
      await launch.connect(s.alice).depositTokens(req);

      await time.increase(DURATION_DAYS * 24 * 3600 + 1);
      await launch.resolveState();
      await time.increase(90 * 24 * 3600 + 1);

      await expect(launch.connect(s.alice).sweepStrandedUsdt()).to.be.reverted;
    });

    it("after STRANDED_SWEEP_DELAY, stranded USDT can be swept to platform wallet", async () => {
      const s = await setup();
      const { token, launch, launchAddress } = await createTokenWithLaunch(s);
      const req = await launch.totalTokensRequired();
      await token.connect(s.alice).setExcludedFromLimits(launchAddress, true);
      await token.connect(s.alice).setAuthorizedLauncher(launchAddress, true);
      await token.connect(s.alice).approve(launchAddress, req);
      await launch.connect(s.alice).depositTokens(req);

      // Bob buys some, deadline passes, refunds enabled
      await s.usdt.mint(s.bob.address, PARSE_USDT(30));
      await s.usdt.connect(s.bob).approve(launchAddress, PARSE_USDT(30));
      await launch
        .connect(s.bob)
        .buy(
          [await s.usdt.getAddress(), await s.usdt.getAddress()],
          PARSE_USDT(30),
          0,
          0
        );
      await time.increase(DURATION_DAYS * 24 * 3600 + 1);
      await launch.resolveState();

      // Bob never refunds — wait the full sweep delay (5 years)
      const delay = await launch.STRANDED_SWEEP_DELAY();
      await time.increase(Number(delay) + 1);

      const platformBefore = await s.usdt.balanceOf(s.platform.address);
      await launch.connect(s.platform).sweepStrandedUsdt();
      const platformAfter = await s.usdt.balanceOf(s.platform.address);
      expect(platformAfter).to.be.gt(platformBefore);
    });
  });

  describe("buy path validation", () => {
    async function activeLaunchSimple() {
      const s = await setup();
      const { token, launch, launchAddress } = await createTokenWithLaunch(s);
      const req = await launch.totalTokensRequired();
      await token.connect(s.alice).setExcludedFromLimits(launchAddress, true);
      await token.connect(s.alice).setAuthorizedLauncher(launchAddress, true);
      await token.connect(s.alice).approve(launchAddress, req);
      await launch.connect(s.alice).depositTokens(req);
      return { ...s, token, launch, launchAddress };
    }

    it("reverts if path length < 2", async () => {
      const s = await activeLaunchSimple();
      await expect(
        s.launch
          .connect(s.bob)
          .buy([await s.usdt.getAddress()], PARSE_USDT(10), 0, 0)
      ).to.be.revertedWithCustomError(s.launch, "InvalidPath");
    });

    it("reverts if path doesn't end at USDT", async () => {
      const s = await activeLaunchSimple();
      await expect(
        s.launch
          .connect(s.bob)
          .buy(
            [await s.usdt.getAddress(), await s.weth.getAddress()],
            PARSE_USDT(10),
            0,
            0
          )
      ).to.be.revertedWithCustomError(s.launch, "PathMustEndAtUsdt");
    });

    it("native buy: path[0]=address(0) + msg.value matches amountIn", async () => {
      const s = await activeLaunchSimple();
      const ethIn = ethers.parseEther("0.1");
      await expect(
        s.launch
          .connect(s.bob)
          ["buy(address[],uint256,uint256,uint256)"](
            [ethers.ZeroAddress, await s.usdt.getAddress()],
            ethIn,
            0,
            0,
            { value: ethIn }
          )
      ).to.not.be.reverted;
      expect(await s.token.balanceOf(s.bob.address)).to.be.gt(0n);
    });

    it("native buy reverts if msg.value != amountIn", async () => {
      const s = await activeLaunchSimple();
      await expect(
        s.launch
          .connect(s.bob)
          ["buy(address[],uint256,uint256,uint256)"](
            [ethers.ZeroAddress, await s.usdt.getAddress()],
            ethers.parseEther("0.1"),
            0,
            0,
            { value: ethers.parseEther("0.05") }
          )
      ).to.be.revertedWithCustomError(s.launch, "SendNativeCoin");
    });

    it("reverts with BelowMinBuy when buy is under the configured floor", async () => {
      const s = await activeLaunchSimple();
      // minBuyUsdt is PARSE_USDT(1). A buy of 0.5 USDT should revert.
      await s.usdt.mint(s.bob.address, PARSE_USDT(1));
      await s.usdt
        .connect(s.bob)
        .approve(await s.launch.getAddress(), PARSE_USDT(1));
      await expect(
        s.launch
          .connect(s.bob)
          .buy(
            [await s.usdt.getAddress(), await s.usdt.getAddress()],
            PARSE_USDT(1) / 2n,
            0,
            0
          )
      ).to.be.revertedWithCustomError(s.launch, "BelowMinBuy");
    });

    it("ERC20 buy reverts if msg.value != 0", async () => {
      const s = await activeLaunchSimple();
      await s.usdt.mint(s.bob.address, PARSE_USDT(10));
      await s.usdt
        .connect(s.bob)
        .approve(await s.launch.getAddress(), PARSE_USDT(10));
      await expect(
        s.launch
          .connect(s.bob)
          ["buy(address[],uint256,uint256,uint256)"](
            [await s.usdt.getAddress(), await s.usdt.getAddress()],
            PARSE_USDT(10),
            0,
            0,
            { value: ethers.parseEther("0.01") }
          )
      ).to.be.revertedWithCustomError(s.launch, "SendNativeCoin");
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
        0,
        300, // 5-minute anti-snipe window
        PARSE_USDT(1) // minBuyUsdt
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
            .buy([usdtAddr, usdtAddr], PARSE_USDT(10), 0, 0);
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

  // ═══════════════════════════════════════════════════════════════
  // Emergency pause — per-launch + global kill switch
  // ═══════════════════════════════════════════════════════════════
  describe("emergency pause", () => {
    async function activeLaunch() {
      const s = await setup();
      const { token, launch, launchAddress } = await createTokenWithLaunch(s);
      const req = await launch.totalTokensRequired();
      await token.connect(s.alice).setExcludedFromLimits(launchAddress, true);
      await token.connect(s.alice).setAuthorizedLauncher(launchAddress, true);
      await token.connect(s.alice).approve(launchAddress, req);
      await launch.connect(s.alice).depositTokens(req);
      return { ...s, token, launch, launchAddress };
    }

    async function buyUsdt(s: any, buyer: any, amount: bigint) {
      await s.usdt.mint(buyer.address, amount);
      await s.usdt.connect(buyer).approve(await s.launch.getAddress(), amount);
      const u = await s.usdt.getAddress();
      return s.launch
        .connect(buyer)
        ["buy(address[],uint256,uint256,uint256)"]([u, u], amount, 0, 0);
    }

    describe("setPaused (launch-level)", () => {
      it("only factory can call setPaused", async () => {
        const s = await activeLaunch();
        await expect(
          s.launch.connect(s.alice).setPaused(true)
        ).to.be.revertedWithCustomError(s.launch, "OnlyFactory");
        await expect(
          s.launch.connect(s.bob).setPaused(true)
        ).to.be.revertedWithCustomError(s.launch, "OnlyFactory");
      });

      it("flips the paused flag and emits PausedChanged", async () => {
        const s = await activeLaunch();
        expect(await s.launch.paused()).to.equal(false);
        await expect(
          s.launchpadFactory.connect(s.owner).pauseLaunch(
            await s.launch.getAddress(),
            true
          )
        )
          .to.emit(s.launch, "PausedChanged")
          .withArgs(true);
        expect(await s.launch.paused()).to.equal(true);

        // Unpause path
        await s.launchpadFactory.connect(s.owner).pauseLaunch(
          await s.launch.getAddress(),
          false
        );
        expect(await s.launch.paused()).to.equal(false);
      });
    });

    describe("buy blocked when paused", () => {
      it("buy reverts with LaunchPaused on paused launch", async () => {
        const s = await activeLaunch();
        await s.launchpadFactory.connect(s.owner).pauseLaunch(
          await s.launch.getAddress(),
          true
        );

        await s.usdt.mint(s.bob.address, PARSE_USDT(10));
        await s.usdt
          .connect(s.bob)
          .approve(await s.launch.getAddress(), PARSE_USDT(10));
        const u = await s.usdt.getAddress();
        await expect(
          s.launch
            .connect(s.bob)
            ["buy(address[],uint256,uint256,uint256)"](
              [u, u],
              PARSE_USDT(10),
              0,
              0
            )
        ).to.be.revertedWithCustomError(s.launch, "LaunchPaused");
      });

      it("buy reverts with LaunchPaused when factory globalPause is on", async () => {
        const s = await activeLaunch();
        await s.launchpadFactory.connect(s.owner).setGlobalPause(true);

        await s.usdt.mint(s.bob.address, PARSE_USDT(10));
        await s.usdt
          .connect(s.bob)
          .approve(await s.launch.getAddress(), PARSE_USDT(10));
        const u = await s.usdt.getAddress();
        await expect(
          s.launch
            .connect(s.bob)
            ["buy(address[],uint256,uint256,uint256)"](
              [u, u],
              PARSE_USDT(10),
              0,
              0
            )
        ).to.be.revertedWithCustomError(s.launch, "LaunchPaused");
      });

      it("resumes buys after unpausing", async () => {
        const s = await activeLaunch();
        await s.launchpadFactory.connect(s.owner).pauseLaunch(
          await s.launch.getAddress(),
          true
        );
        await s.launchpadFactory.connect(s.owner).pauseLaunch(
          await s.launch.getAddress(),
          false
        );

        // Buy should now succeed
        await expect(buyUsdt(s, s.bob, PARSE_USDT(10))).to.not.be.reverted;
        expect(await s.token.balanceOf(s.bob.address)).to.be.gt(0n);
      });

      it("resumes buys after unsetting globalPause", async () => {
        const s = await activeLaunch();
        await s.launchpadFactory.connect(s.owner).setGlobalPause(true);
        await s.launchpadFactory.connect(s.owner).setGlobalPause(false);

        await expect(buyUsdt(s, s.bob, PARSE_USDT(10))).to.not.be.reverted;
      });
    });

    describe("graduate blocked when paused", () => {
      it("manual graduate() reverts with LaunchPaused on paused launch", async () => {
        const s = await activeLaunch();
        await buyUsdt(s, s.bob, PARSE_USDT(120)); // softCap=$100, hit it

        await s.launchpadFactory.connect(s.owner).pauseLaunch(
          await s.launch.getAddress(),
          true
        );

        await expect(
          s.launch.connect(s.alice).graduate()
        ).to.be.revertedWithCustomError(s.launch, "LaunchPaused");
      });

      it("manual graduate() reverts when globalPause is on", async () => {
        const s = await activeLaunch();
        await buyUsdt(s, s.bob, PARSE_USDT(120));

        await s.launchpadFactory.connect(s.owner).setGlobalPause(true);

        await expect(
          s.launch.connect(s.alice).graduate()
        ).to.be.revertedWithCustomError(s.launch, "LaunchPaused");
      });
    });

    describe("emergency refund during pause", () => {
      it("buyers can refund while launch is paused in Active state", async () => {
        const s = await activeLaunch();
        // Bob buys $50
        await buyUsdt(s, s.bob, PARSE_USDT(50));
        const bobTokens = await s.token.balanceOf(s.bob.address);
        const bobPaidBefore = await s.launch.basePaid(s.bob.address);
        expect(bobTokens).to.be.gt(0n);
        expect(bobPaidBefore).to.be.gt(0n);

        // Admin pauses
        await s.launchpadFactory.connect(s.owner).pauseLaunch(
          await s.launch.getAddress(),
          true
        );
        expect(await s.launch.state()).to.equal(1); // still Active

        // Bob can now refund even though state is Active
        await s.token
          .connect(s.bob)
          .approve(await s.launch.getAddress(), bobTokens);
        const usdtBefore = await s.usdt.balanceOf(s.bob.address);
        await expect(s.launch.connect(s.bob).refund(bobTokens)).to.emit(
          s.launch,
          "Refunded"
        );
        const usdtAfter = await s.usdt.balanceOf(s.bob.address);

        // Bob got his basePaid back
        expect(usdtAfter - usdtBefore).to.equal(bobPaidBefore);
        expect(await s.launch.basePaid(s.bob.address)).to.equal(0n);
      });

      it("partial refund works during emergency pause", async () => {
        const s = await activeLaunch();
        await buyUsdt(s, s.bob, PARSE_USDT(50));
        const bobTokens = await s.token.balanceOf(s.bob.address);

        await s.launchpadFactory.connect(s.owner).pauseLaunch(
          await s.launch.getAddress(),
          true
        );

        const half = bobTokens / 2n;
        await s.token
          .connect(s.bob)
          .approve(await s.launch.getAddress(), bobTokens);
        await s.launch.connect(s.bob).refund(half);

        // Half still held by buyer
        expect(await s.token.balanceOf(s.bob.address)).to.equal(bobTokens - half);
        // basePaid reduced by ~half
        expect(await s.launch.basePaid(s.bob.address)).to.be.gt(0n);
      });

      it("refund reverts NotRefunding when not paused and in Active state", async () => {
        const s = await activeLaunch();
        await buyUsdt(s, s.bob, PARSE_USDT(50));
        const bobTokens = await s.token.balanceOf(s.bob.address);

        // No pause, launch is Active
        await s.token
          .connect(s.bob)
          .approve(await s.launch.getAddress(), bobTokens);
        await expect(
          s.launch.connect(s.bob).refund(bobTokens)
        ).to.be.revertedWithCustomError(s.launch, "NotRefunding");
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Factory-level kill switches
  // ═══════════════════════════════════════════════════════════════
  describe("factory kill switches", () => {
    async function activeLaunch() {
      const s = await setup();
      const { token, launch, launchAddress } = await createTokenWithLaunch(s);
      const req = await launch.totalTokensRequired();
      await token.connect(s.alice).setExcludedFromLimits(launchAddress, true);
      await token.connect(s.alice).setAuthorizedLauncher(launchAddress, true);
      await token.connect(s.alice).approve(launchAddress, req);
      await launch.connect(s.alice).depositTokens(req);
      return { ...s, token, launch, launchAddress };
    }

    describe("pauseLaunch", () => {
      it("only owner can call pauseLaunch", async () => {
        const s = await activeLaunch();
        await expect(
          s.launchpadFactory
            .connect(s.alice)
            .pauseLaunch(await s.launch.getAddress(), true)
        ).to.be.revertedWithCustomError(
          s.launchpadFactory,
          "OwnableUnauthorizedAccount"
        );
      });

      it("reverts on zero address", async () => {
        const s = await activeLaunch();
        await expect(
          s.launchpadFactory
            .connect(s.owner)
            .pauseLaunch(ethers.ZeroAddress, true)
        ).to.be.revertedWithCustomError(s.launchpadFactory, "InvalidToken");
      });

      it("emits LaunchPaused", async () => {
        const s = await activeLaunch();
        const la = await s.launch.getAddress();
        await expect(
          s.launchpadFactory.connect(s.owner).pauseLaunch(la, true)
        )
          .to.emit(s.launchpadFactory, "LaunchPaused")
          .withArgs(la, true);
      });
    });

    describe("pauseLaunches (paginated)", () => {
      it("only owner can call pauseLaunches", async () => {
        const s = await activeLaunch();
        await expect(
          s.launchpadFactory.connect(s.alice).pauseLaunches(0, 10, true)
        ).to.be.revertedWithCustomError(
          s.launchpadFactory,
          "OwnableUnauthorizedAccount"
        );
      });

      it("pauses a range of launches", async () => {
        const s = await setup();
        // Create 3 launches for different creators
        const launchAddrs: string[] = [];
        const creators = [s.alice, s.bob, s.carol];
        for (const c of creators) {
          const { token, launch, launchAddress } = await createTokenWithLaunch(
            s,
            c
          );
          const req = await launch.totalTokensRequired();
          await token.connect(c).setExcludedFromLimits(launchAddress, true);
          await token.connect(c).setAuthorizedLauncher(launchAddress, true);
          await token.connect(c).approve(launchAddress, req);
          await launch.connect(c).depositTokens(req);
          launchAddrs.push(launchAddress);
        }

        // Pause all 3
        await s.launchpadFactory.connect(s.owner).pauseLaunches(0, 3, true);

        for (const addr of launchAddrs) {
          const l = await ethers.getContractAt("LaunchInstance", addr);
          expect(await l.paused()).to.equal(true);
        }
      });

      it("handles offset > total gracefully (no-op)", async () => {
        const s = await activeLaunch();
        // offset=5 when only 1 launch exists should not revert
        await s.launchpadFactory.connect(s.owner).pauseLaunches(5, 10, true);
        expect(await s.launch.paused()).to.equal(false);
      });

      it("caps end at launches.length", async () => {
        const s = await activeLaunch();
        // limit=100 when only 1 launch exists should just pause the 1
        await s.launchpadFactory.connect(s.owner).pauseLaunches(0, 100, true);
        expect(await s.launch.paused()).to.equal(true);
      });

      it("emits LaunchesPaused with actual range", async () => {
        const s = await setup();
        const creators = [s.alice, s.bob];
        for (const c of creators) {
          const { token, launch, launchAddress } = await createTokenWithLaunch(
            s,
            c
          );
          const req = await launch.totalTokensRequired();
          await token.connect(c).setExcludedFromLimits(launchAddress, true);
          await token.connect(c).setAuthorizedLauncher(launchAddress, true);
          await token.connect(c).approve(launchAddress, req);
          await launch.connect(c).depositTokens(req);
        }

        await expect(
          s.launchpadFactory.connect(s.owner).pauseLaunches(0, 10, true)
        )
          .to.emit(s.launchpadFactory, "LaunchesPaused")
          .withArgs(0, 2, true); // end capped at 2 (launches.length)
      });
    });

    describe("setGlobalPause", () => {
      it("only owner can call setGlobalPause", async () => {
        const s = await activeLaunch();
        await expect(
          s.launchpadFactory.connect(s.alice).setGlobalPause(true)
        ).to.be.revertedWithCustomError(
          s.launchpadFactory,
          "OwnableUnauthorizedAccount"
        );
      });

      it("flips globalPause and emits event", async () => {
        const s = await activeLaunch();
        expect(await s.launchpadFactory.globalPause()).to.equal(false);

        await expect(
          s.launchpadFactory.connect(s.owner).setGlobalPause(true)
        )
          .to.emit(s.launchpadFactory, "GlobalPauseChanged")
          .withArgs(true);

        expect(await s.launchpadFactory.globalPause()).to.equal(true);
      });

      it("globalPause affects all launches instantly", async () => {
        const s = await setup();
        // Create 2 launches
        const launches: any[] = [];
        for (const c of [s.alice, s.bob]) {
          const { token, launch, launchAddress } = await createTokenWithLaunch(
            s,
            c
          );
          const req = await launch.totalTokensRequired();
          await token.connect(c).setExcludedFromLimits(launchAddress, true);
          await token.connect(c).setAuthorizedLauncher(launchAddress, true);
          await token.connect(c).approve(launchAddress, req);
          await launch.connect(c).depositTokens(req);
          launches.push(launch);
        }

        // Global pause
        await s.launchpadFactory.connect(s.owner).setGlobalPause(true);

        // Both launches should reject buys
        const u = await s.usdt.getAddress();
        for (const l of launches) {
          await s.usdt.mint(s.carol.address, PARSE_USDT(10));
          await s.usdt
            .connect(s.carol)
            .approve(await l.getAddress(), PARSE_USDT(10));
          await expect(
            l.connect(s.carol)["buy(address[],uint256,uint256,uint256)"](
              [u, u],
              PARSE_USDT(10),
              0,
              0
            )
          ).to.be.revertedWithCustomError(l, "LaunchPaused");
        }
      });

      it("refund still works during globalPause", async () => {
        const s = await activeLaunch();
        await s.usdt.mint(s.bob.address, PARSE_USDT(50));
        await s.usdt
          .connect(s.bob)
          .approve(await s.launch.getAddress(), PARSE_USDT(50));
        const u = await s.usdt.getAddress();
        await s.launch
          .connect(s.bob)
          ["buy(address[],uint256,uint256,uint256)"](
            [u, u],
            PARSE_USDT(50),
            0,
            0
          );

        const bobTokens = await s.token.balanceOf(s.bob.address);

        // Owner pauses ALL launches
        await s.launchpadFactory.connect(s.owner).setGlobalPause(true);

        // Admin ALSO pauses this launch directly (user-exit requires paused flag on launch)
        await s.launchpadFactory.connect(s.owner).pauseLaunch(
          await s.launch.getAddress(),
          true
        );

        await s.token
          .connect(s.bob)
          .approve(await s.launch.getAddress(), bobTokens);
        await expect(s.launch.connect(s.bob).refund(bobTokens)).to.emit(
          s.launch,
          "Refunded"
        );
      });
    });
  });
});
