import { expect } from "chai";
import { ethers } from "hardhat";
import {
  deployTokenStack,
  deployLaunchStack,
  createToken,
  PARSE_USDT,
} from "./helpers/fixtures";

const LINEAR = 0;
const SOFT_CAP = PARSE_USDT(100);
const HARD_CAP = PARSE_USDT(1_000);

describe("LaunchpadFactory", () => {
  async function setup() {
    const stack = await deployTokenStack();
    const launchStack = await deployLaunchStack(stack);
    return { ...stack, ...launchStack };
  }

  async function callCreateLaunch(
    s: Awaited<ReturnType<typeof setup>>,
    caller: any,
    tokenAddress: string
  ) {
    return s.launchpadFactory
      .connect(caller)
      .createLaunch(
        tokenAddress,
        ethers.parseUnits("1000000", 18),
        LINEAR,
        SOFT_CAP,
        HARD_CAP,
        7,
        500,
        0,
        0,
        ethers.ZeroAddress,
        0,
        0,
        PARSE_USDT(1) // minBuyUsdt
      );
  }

  describe("anyone can create a launch for any token", () => {
    it("non-owner can create a launch for someone else's token", async () => {
      const s = await setup();
      const { tokenAddress } = await createToken(s, s.alice, {
        supply: 10_000_000n,
      });
      // Bob creates the launch even though alice owns the token
      await expect(callCreateLaunch(s, s.bob, tokenAddress)).to.not.be.reverted;
      const launch = await s.launchpadFactory.tokenToLaunch(tokenAddress);
      expect(launch).to.not.equal(ethers.ZeroAddress);
      // Creator of the LAUNCH is bob (not alice the token owner)
      const launchContract = await ethers.getContractAt(
        "LaunchInstance",
        launch
      );
      expect(await launchContract.creator()).to.equal(s.bob.address);
    });

    it("cannot create a second launch while the first is still Pending", async () => {
      const s = await setup();
      const { tokenAddress } = await createToken(s, s.alice, {
        supply: 10_000_000n,
      });
      await callCreateLaunch(s, s.alice, tokenAddress);
      await expect(
        callCreateLaunch(s, s.bob, tokenAddress)
      ).to.be.revertedWithCustomError(
        s.launchpadFactory,
        "TokenAlreadyHasLaunch"
      );
    });
  });

  describe("cancelPendingLaunch authorization", () => {
    it("launch creator can cancel their own pending launch", async () => {
      const s = await setup();
      const { tokenAddress } = await createToken(s, s.alice, {
        supply: 10_000_000n,
      });
      await callCreateLaunch(s, s.bob, tokenAddress);

      await expect(
        s.launchpadFactory.connect(s.bob).cancelPendingLaunch(tokenAddress)
      ).to.not.be.reverted;
      expect(await s.launchpadFactory.tokenToLaunch(tokenAddress)).to.equal(
        ethers.ZeroAddress
      );
    });

    it("platform owner can cancel any pending launch", async () => {
      const s = await setup();
      const { tokenAddress } = await createToken(s, s.alice, {
        supply: 10_000_000n,
      });
      await callCreateLaunch(s, s.bob, tokenAddress);

      await expect(
        s.launchpadFactory.connect(s.owner).cancelPendingLaunch(tokenAddress)
      ).to.not.be.reverted;
    });

    it("token owner who didn't create the launch cannot cancel", async () => {
      const s = await setup();
      const { tokenAddress } = await createToken(s, s.alice, {
        supply: 10_000_000n,
      });
      // Bob creates the launch; alice is the token owner but not launch creator
      await callCreateLaunch(s, s.bob, tokenAddress);
      await expect(
        s.launchpadFactory.connect(s.alice).cancelPendingLaunch(tokenAddress)
      ).to.be.revertedWithCustomError(s.launchpadFactory, "NotLaunchCreator");
    });

    it("random stranger cannot cancel", async () => {
      const s = await setup();
      const { tokenAddress } = await createToken(s, s.alice, {
        supply: 10_000_000n,
      });
      await callCreateLaunch(s, s.bob, tokenAddress);
      await expect(
        s.launchpadFactory.connect(s.carol).cancelPendingLaunch(tokenAddress)
      ).to.be.revertedWithCustomError(s.launchpadFactory, "NotLaunchCreator");
    });

    it("cannot cancel a non-pending launch", async () => {
      const s = await setup();
      // No launch exists for this token
      const { tokenAddress } = await createToken(s, s.alice, {
        supply: 10_000_000n,
      });
      await expect(
        s.launchpadFactory.connect(s.alice).cancelPendingLaunch(tokenAddress)
      ).to.be.revertedWithCustomError(s.launchpadFactory, "InvalidToken");
    });
  });

  describe("parameter validation", () => {
    it("rejects zero tokens", async () => {
      const s = await setup();
      const { tokenAddress } = await createToken(s, s.alice, {
        supply: 10_000_000n,
      });
      await expect(
        s.launchpadFactory
          .connect(s.alice)
          .createLaunch(
            tokenAddress,
            0,
            LINEAR,
            SOFT_CAP,
            HARD_CAP,
            7,
            500,
            0,
            0,
            ethers.ZeroAddress,
            0,
            0,
            PARSE_USDT(1)
          )
      ).to.be.revertedWithCustomError(s.launchpadFactory, "ZeroTokens");
    });

    it("rejects lockDurationAfterListing > 24 hours", async () => {
      const s = await setup();
      const { tokenAddress } = await createToken(s, s.alice, {
        supply: 10_000_000n,
      });
      // LaunchInstance.initialize caps this at 24h via InvalidDuration
      await expect(
        s.launchpadFactory
          .connect(s.alice)
          .createLaunch(
            tokenAddress,
            ethers.parseUnits("1000000", 18),
            LINEAR,
            SOFT_CAP,
            HARD_CAP,
            7,
            500,
            0,
            0,
            ethers.ZeroAddress,
            0,
            25 * 3600,
            PARSE_USDT(1)
          )
      ).to.be.reverted;
    });

    it("rejects minBuyUsdt == 0", async () => {
      const s = await setup();
      const { tokenAddress } = await createToken(s, s.alice, {
        supply: 10_000_000n,
      });
      await expect(
        s.launchpadFactory
          .connect(s.alice)
          .createLaunch(
            tokenAddress,
            ethers.parseUnits("1000000", 18),
            LINEAR,
            SOFT_CAP,
            HARD_CAP,
            7,
            500,
            0,
            0,
            ethers.ZeroAddress,
            0,
            0,
            0
          )
      ).to.be.reverted;
    });

    it("rejects minBuyUsdt > softCap", async () => {
      const s = await setup();
      const { tokenAddress } = await createToken(s, s.alice, {
        supply: 10_000_000n,
      });
      await expect(
        s.launchpadFactory
          .connect(s.alice)
          .createLaunch(
            tokenAddress,
            ethers.parseUnits("1000000", 18),
            LINEAR,
            SOFT_CAP,
            HARD_CAP,
            7,
            500,
            0,
            0,
            ethers.ZeroAddress,
            0,
            0,
            SOFT_CAP + 1n
          )
      ).to.be.reverted;
    });
  });
});
