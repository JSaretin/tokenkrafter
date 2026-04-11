import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
  deployTokenStack,
  deployLaunchStack,
  PARSE_USDT,
  PARSE_ETH,
} from "./helpers/fixtures";

// ---------------------------------------------------------------
// PlatformRouter end-to-end: single-tx create-and-list and
// create-and-launch flows, plus the tradingDelay / lockDurationAfterListing
// threading that opens public trading atomically with the DEX seed.
// ---------------------------------------------------------------
describe("PlatformRouter", () => {
  async function setup() {
    const stack = await deployTokenStack();
    const launchStack = await deployLaunchStack(stack);

    // Deploy the router
    const PlatformRouter = await ethers.getContractFactory("PlatformRouter");
    const router = await PlatformRouter.deploy(
      await stack.tokenFactory.getAddress(),
      await launchStack.launchpadFactory.getAddress(),
      await stack.dexRouter.getAddress()
    );

    // Wire the factory to accept the router as its authorized entrypoint
    await stack.tokenFactory.setAuthorizedRouter(await router.getAddress());
    await launchStack.launchpadFactory.setAuthorizedRouter(
      await router.getAddress()
    );

    return { ...stack, ...launchStack, router };
  }

  const p = (isMintable = false, isTaxable = false, isPartner = false) => ({
    name: "Rtest",
    symbol: "RT",
    totalSupply: 1_000_000n,
    decimals: 18,
    isTaxable,
    isMintable,
    isPartner,
    paymentToken: ethers.ZeroAddress, // native
  });

  const emptyProtection = {
    maxWalletAmount: 0n,
    maxTransactionAmount: 0n,
    cooldownSeconds: 0n,
  };
  const emptyTax = {
    buyTaxBps: 0n,
    sellTaxBps: 0n,
    transferTaxBps: 0n,
    taxWallets: [] as string[],
    taxSharesBps: [] as number[],
  };

  // Shared log parser (event signatures for both factories)
  const logParser = new ethers.Interface([
    "event TokenCreated(address indexed creator, address indexed tokenAddress, uint8 tokenType, string name, string symbol, uint256 totalSupply, uint8 decimals)",
    "event LaunchCreated(address indexed launch, address indexed token, address indexed creator, uint8 curveType, uint256 softCap, uint256 hardCap, uint256 totalTokens)",
  ]);
  function findLog(receipt: any, name: string) {
    return receipt.logs
      .map((l: any) => {
        try { return logParser.parseLog(l); } catch { return null; }
      })
      .find((l: any) => l?.name === name);
  }

  describe("createAndList — single-tx create + seed + enable trading", () => {
    it("deploys token, registers pools, schedules trading with delay", async () => {
      const s = await setup();
      const tokenAmountPerPair = ethers.parseUnits("100000", 18);
      const ethAmountPerPair = PARSE_ETH("1");

      const list = {
        bases: [ethers.ZeroAddress], // native pair only
        baseAmounts: [ethAmountPerPair],
        tokenAmounts: [tokenAmountPerPair],
        burnLP: true,
        tradingDelay: 300n, // 5 minutes
      };

      const tx = await s.router
        .connect(s.alice)
        .createAndList(p(), list, emptyProtection, emptyTax, ethers.ZeroAddress, {
          value: ethAmountPerPair + PARSE_ETH("1"), // LP + fee buffer
        });
      const receipt = await tx.wait();

      const tokenLog = findLog(receipt, "TokenCreated");
      const tokenAddress = tokenLog!.args.tokenAddress;
      const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);

      // Trading scheduled 5 minutes out (sentinel replaced with finite value)
      const tradingStart = await token.tradingStartTime();
      const latest = await time.latest();
      expect(tradingStart).to.not.equal(2n ** 256n - 1n);
      expect(tradingStart).to.be.closeTo(BigInt(latest) + 300n, 10n);

      // Both pre-registered pools (WETH + USDT) are marked
      const weth = await s.weth.getAddress();
      const usdt = await s.usdt.getAddress();
      const wethPair = await s.dexFactory.getPair(tokenAddress, weth);
      const usdtPair = await s.dexFactory.getPair(tokenAddress, usdt);
      expect(wethPair).to.not.equal(ethers.ZeroAddress);
      expect(usdtPair).to.not.equal(ethers.ZeroAddress);
      expect(await token.pools(wethPair)).to.equal(true);
      expect(await token.pools(usdtPair)).to.equal(true);

      // Direct-seed path: the WETH pair actually received both sides.
      // This would have silently "passed" under the old router path
      // (mock addLiquidity pulled tokens to itself, not the pair).
      expect(await token.balanceOf(wethPair)).to.equal(tokenAmountPerPair);
      expect(await s.weth.balanceOf(wethPair)).to.equal(ethAmountPerPair);

      // Token ownership returned to the real creator
      expect(await token.owner()).to.equal(s.alice.address);
    });

    it("tradingDelay = 0 opens trading immediately", async () => {
      const s = await setup();
      const tokenAmountPerPair = ethers.parseUnits("100000", 18);
      const ethAmountPerPair = PARSE_ETH("1");

      const list = {
        bases: [ethers.ZeroAddress],
        baseAmounts: [ethAmountPerPair],
        tokenAmounts: [tokenAmountPerPair],
        burnLP: true,
        tradingDelay: 0n,
      };

      const tx = await s.router
        .connect(s.alice)
        .createAndList(p(), list, emptyProtection, emptyTax, ethers.ZeroAddress, {
          value: ethAmountPerPair + PARSE_ETH("1"),
        });
      const receipt = await tx.wait();
      const log = findLog(receipt, "TokenCreated");
      const token = await ethers.getContractAt("BasicTokenImpl", log!.args.tokenAddress);

      const tradingStart = await token.tradingStartTime();
      const latest = await time.latest();
      // "Immediate" means tradingStartTime <= now (so _checkProtections passes)
      expect(tradingStart).to.be.lte(BigInt(latest));
    });

    it("non-creator cannot trade a pool during the lock; can after expiry", async () => {
      const s = await setup();
      const tokenAmountPerPair = ethers.parseUnits("100000", 18);
      const ethAmountPerPair = PARSE_ETH("1");

      const list = {
        bases: [ethers.ZeroAddress],
        baseAmounts: [ethAmountPerPair],
        tokenAmounts: [tokenAmountPerPair],
        burnLP: true,
        tradingDelay: 300n,
      };

      const tx = await s.router
        .connect(s.alice)
        .createAndList(p(), list, emptyProtection, emptyTax, ethers.ZeroAddress, {
          value: ethAmountPerPair + PARSE_ETH("1"),
        });
      const receipt = await tx.wait();
      const log = findLog(receipt, "TokenCreated");
      const tokenAddress = log!.args.tokenAddress;
      const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
      const weth = await s.weth.getAddress();
      const pair = await s.dexFactory.getPair(tokenAddress, weth);

      // Alice is exempt (router set her on createAndList), so to test the
      // gate we need a non-exempt holder. Alice hands tokens to bob.
      await token.connect(s.alice).transfer(s.bob.address, 10_000n);

      // Bob tries to sell into the pool during the lock window — should revert
      await expect(
        token.connect(s.bob).transfer(pair, 1000n)
      ).to.be.revertedWith("Pool locked");

      // Fast-forward past the lock
      await time.increase(301);

      // Now bob can trade
      await expect(token.connect(s.bob).transfer(pair, 1000n)).to.not.be
        .reverted;
    });
  });

  describe("createTokenAndLaunch — atomic curve launch setup", () => {
    it("deploys token, creates launch, authorizes + exempts, deposits, activates", async () => {
      const s = await setup();

      const launchParams = {
        tokensForLaunch: ethers.parseUnits("700000", 18),
        curveType: 0, // Linear
        softCap: PARSE_USDT(100),
        hardCap: PARSE_USDT(1_000),
        durationDays: 7n,
        maxBuyBps: 500n,
        creatorAllocationBps: 0n,
        vestingDays: 0n,
        launchPaymentToken: ethers.ZeroAddress,
        startTimestamp: 0n,
        lockDurationAfterListing: 300n,
        minBuyUsdt: PARSE_USDT(1),
      };

      const tx = await s.router
        .connect(s.alice)
        .createTokenAndLaunch(
          p(),
          launchParams,
          emptyProtection,
          emptyTax,
          ethers.ZeroAddress,
          { value: PARSE_ETH("0.5") }
        );
      const receipt = await tx.wait();

      const tokenLog = findLog(receipt, "TokenCreated");
      const launchLog = findLog(receipt, "LaunchCreated");

      expect(tokenLog).to.not.equal(undefined);
      expect(launchLog).to.not.equal(undefined);

      const tokenAddress = tokenLog!.args.tokenAddress;
      const launchAddress = launchLog!.args[0];
      const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
      const launch = await ethers.getContractAt("LaunchInstance", launchAddress);

      // Launch instance is exempt and authorized
      expect(await token.isExcludedFromLimits(launchAddress)).to.equal(true);
      expect(await token.isAuthorizedLauncher(launchAddress)).to.equal(true);

      // Launch is Active (state = 1) — fully provisioned
      expect(await launch.state()).to.equal(1);

      // Token ownership transferred to alice (the real creator)
      expect(await token.owner()).to.equal(s.alice.address);
    });
  });
});
