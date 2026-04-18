import { expect } from "chai";
import { ethers } from "hardhat";
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

describe("Emergency pause — kill switches", () => {
  async function setup() {
    const stack = await deployTokenStack();
    const launchStack = await deployLaunchStack(stack);
    // Disable launch fee for tests (creators don't pre-mint USDT)
    await launchStack.launchpadFactory
      .connect(stack.owner)
      .setLaunchFee(0);
    return { ...stack, ...launchStack };
  }

  async function createActiveLaunch(s: Awaited<ReturnType<typeof setup>>, creator = s.alice) {
    const { token, tokenAddress } = await createToken(s, creator, { supply: 10_000_000n });
    const tx = await s.launchpadFactory
      .connect(creator)
      .createLaunch(
        tokenAddress,
        ethers.parseUnits("1000000", 18),
        LINEAR,
        SOFT_CAP,
        HARD_CAP,
        DURATION_DAYS,
        MAX_BUY_BPS,
        0, // creatorAllocBps
        0, // vestingDays
        0, // startTimestamp
        0, // lockDuration
        PARSE_USDT(1) // minBuyUsdt
      );
    const receipt = await tx.wait();
    const log = receipt!.logs.find((l: any) => l.fragment?.name === "LaunchCreated");
    const launchAddress = (log as any)!.args[0];
    const launch = await ethers.getContractAt("LaunchInstance", launchAddress);

    // Configure exemptions and deposit
    const req = await launch.totalTokensRequired();
    await token.connect(creator).setExcludedFromLimits(launchAddress, true);
    await token.connect(creator).setAuthorizedLauncher(launchAddress, true);
    await token.connect(creator).approve(launchAddress, req);
    await launch.connect(creator).depositTokens(req);

    return { token, tokenAddress, launch, launchAddress };
  }

  async function buyUsdt(s: any, launch: any, buyer: any, amount: bigint) {
    await s.usdt.mint(buyer.address, amount);
    await s.usdt.connect(buyer).approve(await launch.getAddress(), amount);
    const u = await s.usdt.getAddress();
    return launch
      .connect(buyer)
      ["buy(address[],uint256,uint256,uint256)"]([u, u], amount, 0, 0);
  }

  // ─────────────────────────────────────────────────────────────
  // setPaused (launch-level)
  // ─────────────────────────────────────────────────────────────
  describe("setPaused", () => {
    it("only factory can call setPaused", async () => {
      const s = await setup();
      const { launch } = await createActiveLaunch(s);
      await expect(launch.connect(s.alice).setPaused(true)).to.be.revertedWithCustomError(
        launch,
        "OnlyFactory"
      );
    });

    it("flips the paused flag and emits PausedChanged", async () => {
      const s = await setup();
      const { launch, launchAddress } = await createActiveLaunch(s);
      expect(await launch.paused()).to.equal(false);
      await expect(
        s.launchpadFactory.connect(s.owner).pauseLaunch(launchAddress, true)
      ).to.emit(launch, "PausedChanged").withArgs(true);
      expect(await launch.paused()).to.equal(true);

      await s.launchpadFactory.connect(s.owner).pauseLaunch(launchAddress, false);
      expect(await launch.paused()).to.equal(false);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Buy blocked when paused
  // ─────────────────────────────────────────────────────────────
  describe("buy blocked when paused", () => {
    it("reverts with LaunchPaused on paused launch", async () => {
      const s = await setup();
      const { launch, launchAddress } = await createActiveLaunch(s);
      await s.launchpadFactory.connect(s.owner).pauseLaunch(launchAddress, true);

      await s.usdt.mint(s.bob.address, PARSE_USDT(10));
      await s.usdt.connect(s.bob).approve(launchAddress, PARSE_USDT(10));
      const u = await s.usdt.getAddress();
      await expect(
        launch
          .connect(s.bob)
          ["buy(address[],uint256,uint256,uint256)"]([u, u], PARSE_USDT(10), 0, 0)
      ).to.be.revertedWithCustomError(launch, "LaunchPaused");
    });

    it("reverts with LaunchPaused when factory globalPause is on", async () => {
      const s = await setup();
      const { launch, launchAddress } = await createActiveLaunch(s);
      await s.launchpadFactory.connect(s.owner).setGlobalPause(true);

      await s.usdt.mint(s.bob.address, PARSE_USDT(10));
      await s.usdt.connect(s.bob).approve(launchAddress, PARSE_USDT(10));
      const u = await s.usdt.getAddress();
      await expect(
        launch
          .connect(s.bob)
          ["buy(address[],uint256,uint256,uint256)"]([u, u], PARSE_USDT(10), 0, 0)
      ).to.be.revertedWithCustomError(launch, "LaunchPaused");
    });

    it("resumes buys after unpausing", async () => {
      const s = await setup();
      const { token, launch, launchAddress } = await createActiveLaunch(s);
      await s.launchpadFactory.connect(s.owner).pauseLaunch(launchAddress, true);
      await s.launchpadFactory.connect(s.owner).pauseLaunch(launchAddress, false);

      await expect(buyUsdt(s, launch, s.bob, PARSE_USDT(10))).to.not.be.reverted;
      expect(await token.balanceOf(s.bob.address)).to.be.gt(0n);
    });

    it("resumes buys after unsetting globalPause", async () => {
      const s = await setup();
      const { launch } = await createActiveLaunch(s);
      await s.launchpadFactory.connect(s.owner).setGlobalPause(true);
      await s.launchpadFactory.connect(s.owner).setGlobalPause(false);

      await expect(buyUsdt(s, launch, s.bob, PARSE_USDT(10))).to.not.be.reverted;
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Graduate blocked when paused
  // ─────────────────────────────────────────────────────────────
  describe("graduate blocked when paused", () => {
    it("manual graduate() reverts when paused", async () => {
      const s = await setup();
      const { launch, launchAddress } = await createActiveLaunch(s);
      await buyUsdt(s, launch, s.bob, PARSE_USDT(50));
      await buyUsdt(s, launch, s.carol, PARSE_USDT(50));
      await buyUsdt(s, launch, s.dave, PARSE_USDT(20));

      await s.launchpadFactory.connect(s.owner).pauseLaunch(launchAddress, true);

      await expect(launch.connect(s.alice).graduate()).to.be.revertedWithCustomError(
        launch,
        "LaunchPaused"
      );
    });

    it("manual graduate() reverts when globalPause is on", async () => {
      const s = await setup();
      const { launch } = await createActiveLaunch(s);
      await buyUsdt(s, launch, s.bob, PARSE_USDT(50));
      await buyUsdt(s, launch, s.carol, PARSE_USDT(50));
      await buyUsdt(s, launch, s.dave, PARSE_USDT(20));

      await s.launchpadFactory.connect(s.owner).setGlobalPause(true);

      await expect(launch.connect(s.alice).graduate()).to.be.revertedWithCustomError(
        launch,
        "LaunchPaused"
      );
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Emergency refund during pause
  // ─────────────────────────────────────────────────────────────
  describe("emergency refund during pause", () => {
    it("buyers can refund while launch is paused in Active state", async () => {
      const s = await setup();
      const { token, launch, launchAddress } = await createActiveLaunch(s);

      // Bob buys $50
      await buyUsdt(s, launch, s.bob, PARSE_USDT(50));
      const bobTokens = await token.balanceOf(s.bob.address);
      const paidBefore = await launch.basePaid(s.bob.address);
      expect(bobTokens).to.be.gt(0n);
      expect(paidBefore).to.be.gt(0n);

      // Admin pauses — launch still in Active state
      await s.launchpadFactory.connect(s.owner).pauseLaunch(launchAddress, true);
      expect(await launch.state()).to.equal(1); // Active

      // Bob refunds
      await token.connect(s.bob).approve(launchAddress, bobTokens);
      const usdtBefore = await s.usdt.balanceOf(s.bob.address);
      await expect(launch.connect(s.bob).refund(bobTokens)).to.emit(launch, "Refunded");
      const usdtAfter = await s.usdt.balanceOf(s.bob.address);

      expect(usdtAfter - usdtBefore).to.equal(paidBefore);
      expect(await launch.basePaid(s.bob.address)).to.equal(0n);
    });

    it("partial refund works during emergency pause", async () => {
      const s = await setup();
      const { token, launch, launchAddress } = await createActiveLaunch(s);

      await buyUsdt(s, launch, s.bob, PARSE_USDT(50));
      const bobTokens = await token.balanceOf(s.bob.address);

      await s.launchpadFactory.connect(s.owner).pauseLaunch(launchAddress, true);

      const half = bobTokens / 2n;
      await token.connect(s.bob).approve(launchAddress, bobTokens);
      await launch.connect(s.bob).refund(half);

      expect(await token.balanceOf(s.bob.address)).to.equal(bobTokens - half);
      expect(await launch.basePaid(s.bob.address)).to.be.gt(0n);
    });

    it("refund reverts NotRefunding when not paused and in Active state", async () => {
      const s = await setup();
      const { token, launch, launchAddress } = await createActiveLaunch(s);

      await buyUsdt(s, launch, s.bob, PARSE_USDT(50));
      const bobTokens = await token.balanceOf(s.bob.address);

      await token.connect(s.bob).approve(launchAddress, bobTokens);
      await expect(launch.connect(s.bob).refund(bobTokens)).to.be.revertedWithCustomError(
        launch,
        "NotRefunding"
      );
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Factory kill switches
  // ─────────────────────────────────────────────────────────────
  describe("factory admin", () => {
    it("only owner can call pauseLaunch", async () => {
      const s = await setup();
      const { launchAddress } = await createActiveLaunch(s);
      await expect(
        s.launchpadFactory.connect(s.alice).pauseLaunch(launchAddress, true)
      ).to.be.revertedWithCustomError(s.launchpadFactory, "OwnableUnauthorizedAccount");
    });

    it("pauseLaunch reverts on zero address", async () => {
      const s = await setup();
      await expect(
        s.launchpadFactory.connect(s.owner).pauseLaunch(ethers.ZeroAddress, true)
      ).to.be.revertedWithCustomError(s.launchpadFactory, "InvalidToken");
    });

    it("emits LaunchPaused event from factory", async () => {
      const s = await setup();
      const { launchAddress } = await createActiveLaunch(s);
      await expect(
        s.launchpadFactory.connect(s.owner).pauseLaunch(launchAddress, true)
      ).to.emit(s.launchpadFactory, "LaunchPaused").withArgs(launchAddress, true);
    });

    it("only owner can call pauseLaunches", async () => {
      const s = await setup();
      await expect(
        s.launchpadFactory.connect(s.alice).pauseLaunches(0, 10, true)
      ).to.be.revertedWithCustomError(s.launchpadFactory, "OwnableUnauthorizedAccount");
    });

    it("pauseLaunches pauses a range", async () => {
      const s = await setup();
      const addrs: string[] = [];
      for (const c of [s.alice, s.bob, s.carol]) {
        const { launchAddress } = await createActiveLaunch(s, c);
        addrs.push(launchAddress);
      }

      await s.launchpadFactory.connect(s.owner).pauseLaunches(0, 3, true);

      for (const a of addrs) {
        const l = await ethers.getContractAt("LaunchInstance", a);
        expect(await l.paused()).to.equal(true);
      }
    });

    it("pauseLaunches handles offset > total (no-op)", async () => {
      const s = await setup();
      const { launch } = await createActiveLaunch(s);
      await s.launchpadFactory.connect(s.owner).pauseLaunches(5, 10, true);
      expect(await launch.paused()).to.equal(false);
    });

    it("pauseLaunches caps end at launches.length", async () => {
      const s = await setup();
      const { launch } = await createActiveLaunch(s);
      await s.launchpadFactory.connect(s.owner).pauseLaunches(0, 100, true);
      expect(await launch.paused()).to.equal(true);
    });

    it("pauseLaunches emits LaunchesPaused with actual range", async () => {
      const s = await setup();
      for (const c of [s.alice, s.bob]) {
        await createActiveLaunch(s, c);
      }
      await expect(s.launchpadFactory.connect(s.owner).pauseLaunches(0, 10, true))
        .to.emit(s.launchpadFactory, "LaunchesPaused")
        .withArgs(0, 2, true);
    });

    it("only owner can call setGlobalPause", async () => {
      const s = await setup();
      await expect(
        s.launchpadFactory.connect(s.alice).setGlobalPause(true)
      ).to.be.revertedWithCustomError(s.launchpadFactory, "OwnableUnauthorizedAccount");
    });

    it("setGlobalPause flips state and emits event", async () => {
      const s = await setup();
      expect(await s.launchpadFactory.globalPause()).to.equal(false);
      await expect(s.launchpadFactory.connect(s.owner).setGlobalPause(true))
        .to.emit(s.launchpadFactory, "GlobalPauseChanged")
        .withArgs(true);
      expect(await s.launchpadFactory.globalPause()).to.equal(true);
    });

    it("globalPause blocks buys across all launches instantly", async () => {
      const s = await setup();
      const launches: any[] = [];
      for (const c of [s.alice, s.bob]) {
        const { launch } = await createActiveLaunch(s, c);
        launches.push(launch);
      }

      await s.launchpadFactory.connect(s.owner).setGlobalPause(true);

      const u = await s.usdt.getAddress();
      for (const l of launches) {
        await s.usdt.mint(s.carol.address, PARSE_USDT(10));
        await s.usdt.connect(s.carol).approve(await l.getAddress(), PARSE_USDT(10));
        await expect(
          l.connect(s.carol)["buy(address[],uint256,uint256,uint256)"]([u, u], PARSE_USDT(10), 0, 0)
        ).to.be.revertedWithCustomError(l, "LaunchPaused");
      }
    });
  });
});
