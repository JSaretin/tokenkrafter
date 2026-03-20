import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

describe("Launchpad Tests", function () {
  async function deployFullPlatform() {
    const [owner, alice, bob, charlie, dave] = await ethers.getSigners();

    // Deploy mocks
    const MockUSDT = await ethers.getContractFactory("MockUSDT");
    const usdt = await MockUSDT.deploy();

    const MockWETH = await ethers.getContractFactory("MockWETH");
    const weth = await MockWETH.deploy();

    const MockFactory = await ethers.getContractFactory("MockUniswapV2Factory");
    const dexFactory = await MockFactory.deploy();

    const MockRouter = await ethers.getContractFactory("MockUniswapV2Router");
    const dexRouter = await MockRouter.deploy(
      await weth.getAddress(),
      await dexFactory.getAddress()
    );

    // Set mock prices: 1 WETH = 2000 USDT
    const ethPrice = BigInt(2000) * BigInt(1e6);
    await dexRouter.setMockPrice(await weth.getAddress(), await usdt.getAddress(), ethPrice);
    const reversePrice = (BigInt(1e18) * BigInt(1e18)) / ethPrice;
    await dexRouter.setMockPrice(await usdt.getAddress(), await weth.getAddress(), reversePrice);

    // Fund router with USDT for swaps
    await usdt.transfer(await dexRouter.getAddress(), BigInt(100_000_000) * BigInt(1e6));

    // Deploy TokenFactory
    const TokenFactory = await ethers.getContractFactory(
      "contracts/TokenFactory.sol:TokenFactory"
    );
    const tokenFactory = await TokenFactory.deploy(
      await usdt.getAddress(),
      await dexRouter.getAddress()
    );

    // Deploy all token implementations
    const BasicImpl = await ethers.getContractFactory("BasicTokenImpl");
    const basicImpl = await BasicImpl.deploy();
    const MintableImpl = await ethers.getContractFactory("MintableTokenImpl");
    const mintableImpl = await MintableImpl.deploy();
    const TaxableImpl = await ethers.getContractFactory("TaxableTokenImpl");
    const taxableImpl = await TaxableImpl.deploy();
    const TaxableMintableImpl = await ethers.getContractFactory("TaxableMintableTokenImpl");
    const taxableMintableImpl = await TaxableMintableImpl.deploy();
    const PartnerImpl = await ethers.getContractFactory("PartnerTokenImpl");
    const partnerImpl = await PartnerImpl.deploy();
    const PartnerMintableImpl = await ethers.getContractFactory("PartnerMintableTokenImpl");
    const partnerMintableImpl = await PartnerMintableImpl.deploy();
    const PartnerTaxableImpl = await ethers.getContractFactory("PartnerTaxableTokenImpl");
    const partnerTaxableImpl = await PartnerTaxableImpl.deploy();
    const PartnerTaxableMintableImpl = await ethers.getContractFactory(
      "PartnerTaxableMintableTokenImpl"
    );
    const partnerTaxableMintableImpl = await PartnerTaxableMintableImpl.deploy();

    // Register implementations
    await tokenFactory.setImplementation(0, await basicImpl.getAddress());
    await tokenFactory.setImplementation(1, await mintableImpl.getAddress());
    await tokenFactory.setImplementation(2, await taxableImpl.getAddress());
    await tokenFactory.setImplementation(3, await taxableMintableImpl.getAddress());
    await tokenFactory.setImplementation(4, await partnerImpl.getAddress());
    await tokenFactory.setImplementation(5, await partnerMintableImpl.getAddress());
    await tokenFactory.setImplementation(6, await partnerTaxableImpl.getAddress());
    await tokenFactory.setImplementation(7, await partnerTaxableMintableImpl.getAddress());

    // Deploy BondingCurve library + LaunchpadFactory
    const BondingCurve = await ethers.getContractFactory("BondingCurve");
    const bondingCurve = await BondingCurve.deploy();

    const LaunchpadFactory = await ethers.getContractFactory("LaunchpadFactory", {
      libraries: { BondingCurve: await bondingCurve.getAddress() },
    });
    const launchpadFactory = await LaunchpadFactory.deploy(
      owner.address,
      await dexRouter.getAddress(),
      await usdt.getAddress()
    );

    // Deploy PlatformRouter
    const PlatformRouter = await ethers.getContractFactory("PlatformRouter");
    const platformRouter = await PlatformRouter.deploy(
      await tokenFactory.getAddress(),
      await launchpadFactory.getAddress()
    );

    // Authorize router on both factories
    await tokenFactory.setAuthorizedRouter(await platformRouter.getAddress());
    await launchpadFactory.setAuthorizedRouter(await platformRouter.getAddress());

    // Helper: get native fee for a token type
    async function getCreationFeeNative(typeKey: number): Promise<bigint> {
      const baseFee = await tokenFactory.creationFee(typeKey);
      return await tokenFactory.convertFee(baseFee, ethers.ZeroAddress);
    }

    // Helper: create a basic token (type 0) via TokenFactory directly
    async function createBasicToken(
      signer: any,
      name = "TestToken",
      symbol = "TT",
      totalSupply = 1_000_000
    ): Promise<string> {
      const params = {
        name,
        symbol,
        totalSupply,
        decimals: 18,
        isTaxable: false,
        isMintable: false,
        isPartner: false,
        paymentToken: ethers.ZeroAddress,
      };
      const fee = await getCreationFeeNative(0);
      const tx = await tokenFactory
        .connect(signer)
        .createToken(params, ethers.ZeroAddress, { value: fee });
      const receipt = await tx.wait();
      const event = receipt!.logs.find((l: any) => {
        try {
          return tokenFactory.interface.parseLog(l as any)?.name === "TokenCreated";
        } catch {
          return false;
        }
      });
      const parsed = tokenFactory.interface.parseLog(event as any);
      return parsed!.args.tokenAddress;
    }

    // Helper: create a launch for a token and deposit tokens to activate it
    async function createAndActivateLaunch(
      creator: any,
      tokenAddress: string,
      opts: {
        softCap?: bigint;
        hardCap?: bigint;
        durationDays?: number;
        maxBuyBps?: number;
        creatorAllocationBps?: number;
        vestingDays?: number;
        tokensForLaunch?: bigint;
      } = {}
    ): Promise<string> {
      const softCap = opts.softCap ?? BigInt(100) * BigInt(1e6);
      const hardCap = opts.hardCap ?? BigInt(500) * BigInt(1e6);
      const durationDays = opts.durationDays ?? 30;
      const maxBuyBps = opts.maxBuyBps ?? 100;
      const creatorAllocationBps = opts.creatorAllocationBps ?? 0;
      const vestingDays = opts.vestingDays ?? 0;
      const tokensForLaunch = opts.tokensForLaunch ?? ethers.parseUnits("700000", 18);

      const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
      await token.connect(creator).enableTrading();

      const tx = await launchpadFactory.connect(creator).createLaunch(
        tokenAddress,
        tokensForLaunch,
        0, // CurveType.Linear
        softCap,
        hardCap,
        durationDays,
        maxBuyBps,
        creatorAllocationBps,
        vestingDays,
        ethers.ZeroAddress,
        0 // startTimestamp: immediate
      );
      const receipt = await tx.wait();
      const event = receipt!.logs.find((l: any) => {
        try {
          return launchpadFactory.interface.parseLog(l as any)?.name === "LaunchCreated";
        } catch {
          return false;
        }
      });
      const parsed = launchpadFactory.interface.parseLog(event as any);
      const launchAddress = parsed!.args.launch;

      // Approve and deposit tokens to activate
      await token.connect(creator).approve(launchAddress, tokensForLaunch);
      const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);
      await launchInstance.connect(creator).depositTokens(tokensForLaunch);

      return launchAddress;
    }

    return {
      owner,
      alice,
      bob,
      charlie,
      dave,
      usdt,
      weth,
      dexFactory,
      dexRouter,
      tokenFactory,
      launchpadFactory,
      platformRouter,
      bondingCurve,
      getCreationFeeNative,
      createBasicToken,
      createAndActivateLaunch,
    };
  }

  // ================================================================
  // LaunchpadFactory Tests
  // ================================================================

  describe("LaunchpadFactory", function () {
    // -- createLaunch --

    describe("createLaunch", function () {
      it("creates a launch with default curve params", async function () {
        const { alice, launchpadFactory, createBasicToken } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        await token.connect(alice).enableTrading();

        const tx = await launchpadFactory.connect(alice).createLaunch(
          tokenAddress,
          ethers.parseUnits("700000", 18),
          0, // Linear
          BigInt(100) * BigInt(1e6),
          BigInt(500) * BigInt(1e6),
          30,
          100,
          0,
          0,
          ethers.ZeroAddress,
          0
        );

        const receipt = await tx.wait();
        const event = receipt!.logs.find((l: any) => {
          try {
            return launchpadFactory.interface.parseLog(l as any)?.name === "LaunchCreated";
          } catch {
            return false;
          }
        });
        expect(event).to.not.be.undefined;

        const parsed = launchpadFactory.interface.parseLog(event as any);
        expect(parsed!.args.token).to.equal(tokenAddress);
        expect(parsed!.args.creator).to.equal(alice.address);

        expect(await launchpadFactory.totalLaunches()).to.equal(1);
      });

      it("reverts when caller is not the token owner", async function () {
        const { alice, bob, launchpadFactory, createBasicToken } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        await token.connect(alice).enableTrading();

        await expect(
          launchpadFactory.connect(bob).createLaunch(
            tokenAddress,
            ethers.parseUnits("700000", 18),
            0,
            BigInt(100) * BigInt(1e6),
            BigInt(500) * BigInt(1e6),
            30,
            100,
            0,
            0,
            ethers.ZeroAddress,
            0
          )
        ).to.be.revertedWithCustomError(launchpadFactory, "NotTokenOwner");
      });

      it("reverts when token already has a launch", async function () {
        const { alice, launchpadFactory, createBasicToken } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        await token.connect(alice).enableTrading();

        await launchpadFactory.connect(alice).createLaunch(
          tokenAddress,
          ethers.parseUnits("700000", 18),
          0,
          BigInt(100) * BigInt(1e6),
          BigInt(500) * BigInt(1e6),
          30,
          100,
          0,
          0,
          ethers.ZeroAddress,
          0
        );

        await expect(
          launchpadFactory.connect(alice).createLaunch(
            tokenAddress,
            ethers.parseUnits("700000", 18),
            0,
            BigInt(100) * BigInt(1e6),
            BigInt(500) * BigInt(1e6),
            30,
            100,
            0,
            0,
            ethers.ZeroAddress,
            0
          )
        ).to.be.revertedWithCustomError(launchpadFactory, "TokenAlreadyHasLaunch");
      });

      it("collects launch fee when set (native payment)", async function () {
        const { alice, launchpadFactory, createBasicToken } =
          await loadFixture(deployFullPlatform);

        // Set a launch fee of 10 USDT
        await launchpadFactory.setLaunchFee(BigInt(10) * BigInt(1e6));

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        await token.connect(alice).enableTrading();

        // getLaunchFee for native should return the amount in ETH
        const feeInNative = await launchpadFactory.getLaunchFee(ethers.ZeroAddress);
        expect(feeInNative).to.be.gt(0);

        await expect(
          launchpadFactory.connect(alice).createLaunch(
            tokenAddress,
            ethers.parseUnits("700000", 18),
            0,
            BigInt(100) * BigInt(1e6),
            BigInt(500) * BigInt(1e6),
            30,
            100,
            0,
            0,
            ethers.ZeroAddress,
            0,
            { value: feeInNative }
          )
        ).to.not.be.reverted;
      });

      it("reverts with insufficient native payment for launch fee", async function () {
        const { alice, launchpadFactory, createBasicToken } =
          await loadFixture(deployFullPlatform);

        await launchpadFactory.setLaunchFee(BigInt(10) * BigInt(1e6));

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        await token.connect(alice).enableTrading();

        await expect(
          launchpadFactory.connect(alice).createLaunch(
            tokenAddress,
            ethers.parseUnits("700000", 18),
            0,
            BigInt(100) * BigInt(1e6),
            BigInt(500) * BigInt(1e6),
            30,
            100,
            0,
            0,
            ethers.ZeroAddress,
            0,
            { value: 0 }
          )
        ).to.be.revertedWithCustomError(launchpadFactory, "InsufficientNativePayment");
      });
    });

    // -- createLaunchCustomCurve --

    describe("createLaunchCustomCurve", function () {
      it("creates a launch with custom curve params", async function () {
        const { alice, launchpadFactory, createBasicToken } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        await token.connect(alice).enableTrading();

        const tx = await launchpadFactory.connect(alice).createLaunchCustomCurve(
          tokenAddress,
          ethers.parseUnits("700000", 18),
          0, // Linear
          BigInt(2e9),  // custom slope
          BigInt(2e12), // custom intercept
          BigInt(100) * BigInt(1e6),
          BigInt(500) * BigInt(1e6),
          30,
          100,
          0,
          0,
          ethers.ZeroAddress,
          0
        );

        const receipt = await tx.wait();
        const event = receipt!.logs.find((l: any) => {
          try {
            return launchpadFactory.interface.parseLog(l as any)?.name === "LaunchCreated";
          } catch {
            return false;
          }
        });
        expect(event).to.not.be.undefined;

        const parsed = launchpadFactory.interface.parseLog(event as any);
        const launchAddress = parsed!.args.launch;
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        expect(await launchInstance.curveParam1()).to.equal(BigInt(2e9));
        expect(await launchInstance.curveParam2()).to.equal(BigInt(2e12));
      });
    });

    // -- routerCreateLaunch --

    describe("routerCreateLaunch", function () {
      it("reverts when called by non-router", async function () {
        const { alice, bob, launchpadFactory, createBasicToken } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);

        await expect(
          launchpadFactory.connect(bob).routerCreateLaunch(
            alice.address,
            tokenAddress,
            ethers.parseUnits("700000", 18),
            0,
            BigInt(100) * BigInt(1e6),
            BigInt(500) * BigInt(1e6),
            30,
            100,
            0,
            0,
            ethers.ZeroAddress,
            0
          )
        ).to.be.revertedWithCustomError(launchpadFactory, "OnlyAuthorizedRouter");
      });

      it("succeeds when called by authorized router (via createTokenAndLaunch)", async function () {
        const { alice, platformRouter, launchpadFactory, getCreationFeeNative } =
          await loadFixture(deployFullPlatform);

        const fee = await getCreationFeeNative(0);

        const tx = await platformRouter.connect(alice).createTokenAndLaunch(
          {
            name: "RouterToken",
            symbol: "RTK",
            totalSupply: 1_000_000,
            decimals: 18,
            isTaxable: false,
            isMintable: false,
            isPartner: false,
            paymentToken: ethers.ZeroAddress,
          },
          {
            tokensForLaunch: ethers.parseUnits("700000", 18),
            curveType: 0,
            softCap: BigInt(100) * BigInt(1e6),
            hardCap: BigInt(500) * BigInt(1e6),
            durationDays: 30,
            maxBuyBps: 100,
            creatorAllocationBps: 0,
            vestingDays: 0,
            launchPaymentToken: ethers.ZeroAddress,
            startTimestamp: 0,
          },
          { maxWalletAmount: 0, maxTransactionAmount: 0, cooldownSeconds: 0 },
          {
            buyTaxBps: 0,
            sellTaxBps: 0,
            transferTaxBps: 0,
            taxWallets: [],
            taxSharesBps: [],
          },
          ethers.ZeroAddress,
          { value: fee + ethers.parseEther("2") }
        );

        expect(await launchpadFactory.totalLaunches()).to.equal(1);
      });
    });

    // -- notifyDeposit --

    describe("notifyDeposit", function () {
      it("reverts when called by non-router", async function () {
        const { alice, bob, launchpadFactory, createBasicToken } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        await token.connect(alice).enableTrading();

        const tx = await launchpadFactory.connect(alice).createLaunch(
          tokenAddress,
          ethers.parseUnits("700000", 18),
          0,
          BigInt(100) * BigInt(1e6),
          BigInt(500) * BigInt(1e6),
          30,
          100,
          0,
          0,
          ethers.ZeroAddress,
          0
        );
        const receipt = await tx.wait();
        const event = receipt!.logs.find((l: any) => {
          try {
            return launchpadFactory.interface.parseLog(l as any)?.name === "LaunchCreated";
          } catch {
            return false;
          }
        });
        const launchAddress = launchpadFactory.interface.parseLog(event as any)!.args.launch;

        await expect(
          launchpadFactory.connect(bob).notifyDeposit(launchAddress, 1000)
        ).to.be.revertedWithCustomError(launchpadFactory, "OnlyAuthorizedRouter");
      });
    });

    // -- clearTokenLaunch --

    describe("clearTokenLaunch", function () {
      it("reverts when called by non-launch address", async function () {
        const { alice, bob, launchpadFactory, createBasicToken } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        await token.connect(alice).enableTrading();

        await launchpadFactory.connect(alice).createLaunch(
          tokenAddress,
          ethers.parseUnits("700000", 18),
          0,
          BigInt(100) * BigInt(1e6),
          BigInt(500) * BigInt(1e6),
          30,
          100,
          0,
          0,
          ethers.ZeroAddress,
          0
        );

        await expect(
          launchpadFactory.connect(bob).clearTokenLaunch(tokenAddress)
        ).to.be.revertedWithCustomError(launchpadFactory, "OnlyLaunch");
      });
    });

    // -- recordGraduation --

    describe("recordGraduation", function () {
      it("reverts when called by non-launch address", async function () {
        const { alice, bob, launchpadFactory, createBasicToken } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        await token.connect(alice).enableTrading();

        const tx = await launchpadFactory.connect(alice).createLaunch(
          tokenAddress,
          ethers.parseUnits("700000", 18),
          0,
          BigInt(100) * BigInt(1e6),
          BigInt(500) * BigInt(1e6),
          30,
          100,
          0,
          0,
          ethers.ZeroAddress,
          0
        );
        const receipt = await tx.wait();
        const event = receipt!.logs.find((l: any) => {
          try {
            return launchpadFactory.interface.parseLog(l as any)?.name === "LaunchCreated";
          } catch {
            return false;
          }
        });
        const launchAddress = launchpadFactory.interface.parseLog(event as any)!.args.launch;

        await expect(
          launchpadFactory.connect(bob).recordGraduation(launchAddress)
        ).to.be.revertedWithCustomError(launchpadFactory, "OnlyLaunch");
      });
    });

    // -- View functions --

    describe("View functions", function () {
      it("totalLaunches returns correct count", async function () {
        const { alice, launchpadFactory, createBasicToken } =
          await loadFixture(deployFullPlatform);

        expect(await launchpadFactory.totalLaunches()).to.equal(0);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        await token.connect(alice).enableTrading();

        await launchpadFactory.connect(alice).createLaunch(
          tokenAddress,
          ethers.parseUnits("700000", 18),
          0,
          BigInt(100) * BigInt(1e6),
          BigInt(500) * BigInt(1e6),
          30,
          100,
          0,
          0,
          ethers.ZeroAddress,
          0
        );

        expect(await launchpadFactory.totalLaunches()).to.equal(1);
      });

      it("getCreatorLaunches returns launches for a creator", async function () {
        const { alice, launchpadFactory, createBasicToken } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        await token.connect(alice).enableTrading();

        await launchpadFactory.connect(alice).createLaunch(
          tokenAddress,
          ethers.parseUnits("700000", 18),
          0,
          BigInt(100) * BigInt(1e6),
          BigInt(500) * BigInt(1e6),
          30,
          100,
          0,
          0,
          ethers.ZeroAddress,
          0
        );

        const launches = await launchpadFactory.getCreatorLaunches(alice.address);
        expect(launches.length).to.equal(1);
      });

      it("getSupportedPaymentTokens returns default tokens", async function () {
        const { launchpadFactory } = await loadFixture(deployFullPlatform);

        const tokens = await launchpadFactory.getSupportedPaymentTokens();
        expect(tokens.length).to.be.gte(1);
        expect(tokens).to.include(ethers.ZeroAddress);
      });

      it("getLaunchFee returns correct fee", async function () {
        const { launchpadFactory, usdt } = await loadFixture(deployFullPlatform);

        // Default fee is 0
        expect(await launchpadFactory.getLaunchFee(ethers.ZeroAddress)).to.equal(0);

        await launchpadFactory.setLaunchFee(BigInt(10) * BigInt(1e6));

        // Fee in USDT
        expect(await launchpadFactory.getLaunchFee(await usdt.getAddress())).to.equal(
          BigInt(10) * BigInt(1e6)
        );

        // Fee in native (ETH equivalent)
        const nativeFee = await launchpadFactory.getLaunchFee(ethers.ZeroAddress);
        expect(nativeFee).to.be.gt(0);
      });

      it("convertFee returns correct conversion", async function () {
        const { launchpadFactory, usdt } = await loadFixture(deployFullPlatform);

        const usdtAmount = BigInt(100) * BigInt(1e6);

        // Converting USDT to native
        const nativeEquivalent = await launchpadFactory.convertFee(usdtAmount, ethers.ZeroAddress);
        expect(nativeEquivalent).to.be.gt(0);

        // Converting USDT to USDT (identity)
        const usdtEquivalent = await launchpadFactory.convertFee(
          usdtAmount,
          await usdt.getAddress()
        );
        expect(usdtEquivalent).to.equal(usdtAmount);
      });
    });

    // -- Admin functions --

    describe("Admin functions", function () {
      it("setPlatformWallet updates wallet", async function () {
        const { owner, alice, launchpadFactory } = await loadFixture(deployFullPlatform);

        await launchpadFactory.connect(owner).setPlatformWallet(alice.address);
        expect(await launchpadFactory.platformWallet()).to.equal(alice.address);
      });

      it("setPlatformWallet reverts for zero address", async function () {
        const { owner, launchpadFactory } = await loadFixture(deployFullPlatform);

        await expect(
          launchpadFactory.connect(owner).setPlatformWallet(ethers.ZeroAddress)
        ).to.be.revertedWithCustomError(launchpadFactory, "InvalidAddress");
      });

      it("setPlatformWallet reverts for non-owner", async function () {
        const { alice, launchpadFactory } = await loadFixture(deployFullPlatform);

        await expect(
          launchpadFactory.connect(alice).setPlatformWallet(alice.address)
        ).to.be.revertedWithCustomError(launchpadFactory, "OwnableUnauthorizedAccount");
      });

      it("setDexRouter updates router", async function () {
        const { owner, alice, launchpadFactory } = await loadFixture(deployFullPlatform);

        await launchpadFactory.connect(owner).setDexRouter(alice.address);
        expect(await launchpadFactory.dexRouter()).to.equal(alice.address);
      });

      it("setDexRouter reverts for zero address", async function () {
        const { owner, launchpadFactory } = await loadFixture(deployFullPlatform);

        await expect(
          launchpadFactory.connect(owner).setDexRouter(ethers.ZeroAddress)
        ).to.be.revertedWithCustomError(launchpadFactory, "InvalidAddress");
      });

      it("setUsdt updates USDT address", async function () {
        const { owner, alice, launchpadFactory } = await loadFixture(deployFullPlatform);

        await launchpadFactory.connect(owner).setUsdt(alice.address);
        expect(await launchpadFactory.usdt()).to.equal(alice.address);
      });

      it("setUsdt reverts for zero address", async function () {
        const { owner, launchpadFactory } = await loadFixture(deployFullPlatform);

        await expect(
          launchpadFactory.connect(owner).setUsdt(ethers.ZeroAddress)
        ).to.be.revertedWithCustomError(launchpadFactory, "InvalidUsdt");
      });

      it("setLaunchFee updates fee", async function () {
        const { owner, launchpadFactory } = await loadFixture(deployFullPlatform);

        await launchpadFactory.connect(owner).setLaunchFee(BigInt(50) * BigInt(1e6));
        expect(await launchpadFactory.launchFee()).to.equal(BigInt(50) * BigInt(1e6));
      });

      it("setCurveDefaults updates defaults", async function () {
        const { owner, launchpadFactory } = await loadFixture(deployFullPlatform);

        const newDefaults = {
          linearSlope: BigInt(2e9),
          linearIntercept: BigInt(2e12),
          sqrtCoefficient: BigInt(2e14),
          quadraticCoefficient: BigInt(2e6),
          expBase: BigInt(2e12),
          expKFactor: BigInt(2e12),
        };

        await launchpadFactory.connect(owner).setCurveDefaults(newDefaults);
        const updated = await launchpadFactory.curveDefaults();
        expect(updated.linearSlope).to.equal(BigInt(2e9));
        expect(updated.linearIntercept).to.equal(BigInt(2e12));
      });

      it("addPaymentToken adds a new token", async function () {
        const { owner, alice, launchpadFactory } = await loadFixture(deployFullPlatform);

        await launchpadFactory.connect(owner).addPaymentToken(alice.address);
        expect(await launchpadFactory.isPaymentSupported(alice.address)).to.be.true;
        const tokens = await launchpadFactory.getSupportedPaymentTokens();
        expect(tokens).to.include(alice.address);
      });

      it("addPaymentToken reverts for already supported", async function () {
        const { owner, launchpadFactory } = await loadFixture(deployFullPlatform);

        await expect(
          launchpadFactory.connect(owner).addPaymentToken(ethers.ZeroAddress)
        ).to.be.revertedWithCustomError(launchpadFactory, "AlreadySupported");
      });

      it("removePaymentToken removes a token", async function () {
        const { owner, alice, launchpadFactory } = await loadFixture(deployFullPlatform);

        await launchpadFactory.connect(owner).addPaymentToken(alice.address);
        await launchpadFactory.connect(owner).removePaymentToken(alice.address);
        expect(await launchpadFactory.isPaymentSupported(alice.address)).to.be.false;
      });

      it("removePaymentToken reverts for unsupported token", async function () {
        const { owner, alice, launchpadFactory } = await loadFixture(deployFullPlatform);

        await expect(
          launchpadFactory.connect(owner).removePaymentToken(alice.address)
        ).to.be.revertedWithCustomError(launchpadFactory, "NotSupported");
      });

      it("setAuthorizedRouter updates router", async function () {
        const { owner, alice, launchpadFactory } = await loadFixture(deployFullPlatform);

        await launchpadFactory.connect(owner).setAuthorizedRouter(alice.address);
        expect(await launchpadFactory.authorizedRouter()).to.equal(alice.address);
      });

      it("cancelPendingLaunch clears mapping for pending launch", async function () {
        const { alice, launchpadFactory, createBasicToken } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        await token.connect(alice).enableTrading();

        await launchpadFactory.connect(alice).createLaunch(
          tokenAddress,
          ethers.parseUnits("700000", 18),
          0,
          BigInt(100) * BigInt(1e6),
          BigInt(500) * BigInt(1e6),
          30,
          100,
          0,
          0,
          ethers.ZeroAddress,
          0
        );

        // Token owner can cancel
        await launchpadFactory.connect(alice).cancelPendingLaunch(tokenAddress);
        expect(await launchpadFactory.tokenToLaunch(tokenAddress)).to.equal(ethers.ZeroAddress);
      });

      it("cancelPendingLaunch allows factory owner to cancel", async function () {
        const { owner, alice, launchpadFactory, createBasicToken } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        await token.connect(alice).enableTrading();

        await launchpadFactory.connect(alice).createLaunch(
          tokenAddress,
          ethers.parseUnits("700000", 18),
          0,
          BigInt(100) * BigInt(1e6),
          BigInt(500) * BigInt(1e6),
          30,
          100,
          0,
          0,
          ethers.ZeroAddress,
          0
        );

        // Factory owner can cancel
        await launchpadFactory.connect(owner).cancelPendingLaunch(tokenAddress);
        expect(await launchpadFactory.tokenToLaunch(tokenAddress)).to.equal(ethers.ZeroAddress);
      });

      it("cancelPendingLaunch reverts for non-owner non-token-owner", async function () {
        const { alice, bob, launchpadFactory, createBasicToken } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        await token.connect(alice).enableTrading();

        await launchpadFactory.connect(alice).createLaunch(
          tokenAddress,
          ethers.parseUnits("700000", 18),
          0,
          BigInt(100) * BigInt(1e6),
          BigInt(500) * BigInt(1e6),
          30,
          100,
          0,
          0,
          ethers.ZeroAddress,
          0
        );

        await expect(
          launchpadFactory.connect(bob).cancelPendingLaunch(tokenAddress)
        ).to.be.revertedWithCustomError(launchpadFactory, "NotTokenOwner");
      });

      it("withdrawFees withdraws native fees", async function () {
        const { owner, launchpadFactory } = await loadFixture(deployFullPlatform);

        // Send some ETH to factory
        await owner.sendTransaction({
          to: await launchpadFactory.getAddress(),
          value: ethers.parseEther("1"),
        });

        const balBefore = await ethers.provider.getBalance(owner.address);
        await launchpadFactory.connect(owner).withdrawFees(ethers.ZeroAddress);
        const balAfter = await ethers.provider.getBalance(owner.address);

        // Balance should have increased (minus gas)
        expect(balAfter).to.be.gt(balBefore - ethers.parseEther("0.01"));
      });

      it("withdrawFees withdraws ERC20 fees", async function () {
        const { owner, usdt, launchpadFactory } = await loadFixture(deployFullPlatform);

        // Send some USDT to factory
        await usdt.transfer(await launchpadFactory.getAddress(), BigInt(1000) * BigInt(1e6));

        const balBefore = await usdt.balanceOf(owner.address);
        await launchpadFactory.connect(owner).withdrawFees(await usdt.getAddress());
        const balAfter = await usdt.balanceOf(owner.address);

        expect(balAfter - balBefore).to.equal(BigInt(1000) * BigInt(1e6));
      });

      it("withdrawFees reverts with no balance", async function () {
        const { owner, launchpadFactory } = await loadFixture(deployFullPlatform);

        await expect(
          launchpadFactory.connect(owner).withdrawFees(ethers.ZeroAddress)
        ).to.be.revertedWithCustomError(launchpadFactory, "NoBalance");
      });
    });
  });

  // ================================================================
  // LaunchInstance Tests
  // ================================================================

  describe("LaunchInstance", function () {
    // -- depositTokens --

    describe("depositTokens", function () {
      it("allows creator to deposit and auto-activates", async function () {
        const { alice, launchpadFactory, createBasicToken } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        await token.connect(alice).enableTrading();

        const tokensForLaunch = ethers.parseUnits("700000", 18);

        const tx = await launchpadFactory.connect(alice).createLaunch(
          tokenAddress,
          tokensForLaunch,
          0,
          BigInt(100) * BigInt(1e6),
          BigInt(500) * BigInt(1e6),
          30,
          100,
          0,
          0,
          ethers.ZeroAddress,
          0
        );
        const receipt = await tx.wait();
        const event = receipt!.logs.find((l: any) => {
          try {
            return launchpadFactory.interface.parseLog(l as any)?.name === "LaunchCreated";
          } catch {
            return false;
          }
        });
        const launchAddress = launchpadFactory.interface.parseLog(event as any)!.args.launch;
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        expect(await launchInstance.state()).to.equal(0); // Pending

        await token.connect(alice).approve(launchAddress, tokensForLaunch);
        await launchInstance.connect(alice).depositTokens(tokensForLaunch);

        expect(await launchInstance.state()).to.equal(1); // Active
        expect(await launchInstance.totalTokensDeposited()).to.equal(tokensForLaunch);
      });

      it("reverts when called by non-creator", async function () {
        const { alice, bob, launchpadFactory, createBasicToken } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        await token.connect(alice).enableTrading();

        const tx = await launchpadFactory.connect(alice).createLaunch(
          tokenAddress,
          ethers.parseUnits("700000", 18),
          0,
          BigInt(100) * BigInt(1e6),
          BigInt(500) * BigInt(1e6),
          30,
          100,
          0,
          0,
          ethers.ZeroAddress,
          0
        );
        const receipt = await tx.wait();
        const event = receipt!.logs.find((l: any) => {
          try {
            return launchpadFactory.interface.parseLog(l as any)?.name === "LaunchCreated";
          } catch {
            return false;
          }
        });
        const launchAddress = launchpadFactory.interface.parseLog(event as any)!.args.launch;
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        await expect(
          launchInstance.connect(bob).depositTokens(1000)
        ).to.be.revertedWithCustomError(launchInstance, "NotCreator");
      });

      it("reverts when state is not pending", async function () {
        const { alice, launchpadFactory, createBasicToken, createAndActivateLaunch } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const launchAddress = await createAndActivateLaunch(alice, tokenAddress);
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        await expect(
          launchInstance.connect(alice).depositTokens(1000)
        ).to.be.revertedWithCustomError(launchInstance, "NotPending");
      });

      it("reverts with zero amount", async function () {
        const { alice, launchpadFactory, createBasicToken } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        await token.connect(alice).enableTrading();

        const tx = await launchpadFactory.connect(alice).createLaunch(
          tokenAddress,
          ethers.parseUnits("700000", 18),
          0,
          BigInt(100) * BigInt(1e6),
          BigInt(500) * BigInt(1e6),
          30,
          100,
          0,
          0,
          ethers.ZeroAddress,
          0
        );
        const receipt = await tx.wait();
        const event = receipt!.logs.find((l: any) => {
          try {
            return launchpadFactory.interface.parseLog(l as any)?.name === "LaunchCreated";
          } catch {
            return false;
          }
        });
        const launchAddress = launchpadFactory.interface.parseLog(event as any)!.args.launch;
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        await expect(
          launchInstance.connect(alice).depositTokens(0)
        ).to.be.revertedWithCustomError(launchInstance, "ZeroAmount");
      });
    });

    // -- notifyDeposit --

    describe("notifyDeposit", function () {
      it("reverts when called by non-factory", async function () {
        const { alice, bob, launchpadFactory, createBasicToken } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        await token.connect(alice).enableTrading();

        const tx = await launchpadFactory.connect(alice).createLaunch(
          tokenAddress,
          ethers.parseUnits("700000", 18),
          0,
          BigInt(100) * BigInt(1e6),
          BigInt(500) * BigInt(1e6),
          30,
          100,
          0,
          0,
          ethers.ZeroAddress,
          0
        );
        const receipt = await tx.wait();
        const event = receipt!.logs.find((l: any) => {
          try {
            return launchpadFactory.interface.parseLog(l as any)?.name === "LaunchCreated";
          } catch {
            return false;
          }
        });
        const launchAddress = launchpadFactory.interface.parseLog(event as any)!.args.launch;
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        await expect(
          launchInstance.connect(bob).notifyDeposit(1000)
        ).to.be.revertedWithCustomError(launchInstance, "OnlyFactory");
      });
    });

    // -- withdrawPendingTokens --

    describe("withdrawPendingTokens", function () {
      it("allows creator to withdraw when pending", async function () {
        const { alice, launchpadFactory, createBasicToken } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        await token.connect(alice).enableTrading();

        const tokensForLaunch = ethers.parseUnits("700000", 18);

        const tx = await launchpadFactory.connect(alice).createLaunch(
          tokenAddress,
          tokensForLaunch,
          0,
          BigInt(100) * BigInt(1e6),
          BigInt(500) * BigInt(1e6),
          30,
          100,
          0,
          0,
          ethers.ZeroAddress,
          0
        );
        const receipt = await tx.wait();
        const event = receipt!.logs.find((l: any) => {
          try {
            return launchpadFactory.interface.parseLog(l as any)?.name === "LaunchCreated";
          } catch {
            return false;
          }
        });
        const launchAddress = launchpadFactory.interface.parseLog(event as any)!.args.launch;
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        // Deposit partial amount (not enough to activate)
        const partialAmount = ethers.parseUnits("100000", 18);
        await token.connect(alice).approve(launchAddress, partialAmount);
        await launchInstance.connect(alice).depositTokens(partialAmount);

        expect(await launchInstance.state()).to.equal(0); // Still pending

        const balBefore = await token.balanceOf(alice.address);
        await launchInstance.connect(alice).withdrawPendingTokens();
        const balAfter = await token.balanceOf(alice.address);

        expect(balAfter - balBefore).to.equal(partialAmount);
        expect(await launchInstance.totalTokensDeposited()).to.equal(0);
      });

      it("reverts when nothing deposited", async function () {
        const { alice, launchpadFactory, createBasicToken } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        await token.connect(alice).enableTrading();

        const tx = await launchpadFactory.connect(alice).createLaunch(
          tokenAddress,
          ethers.parseUnits("700000", 18),
          0,
          BigInt(100) * BigInt(1e6),
          BigInt(500) * BigInt(1e6),
          30,
          100,
          0,
          0,
          ethers.ZeroAddress,
          0
        );
        const receipt = await tx.wait();
        const event = receipt!.logs.find((l: any) => {
          try {
            return launchpadFactory.interface.parseLog(l as any)?.name === "LaunchCreated";
          } catch {
            return false;
          }
        });
        const launchAddress = launchpadFactory.interface.parseLog(event as any)!.args.launch;
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        await expect(
          launchInstance.connect(alice).withdrawPendingTokens()
        ).to.be.revertedWithCustomError(launchInstance, "NothingDeposited");
      });

      it("reverts when not pending (active)", async function () {
        const { alice, createBasicToken, createAndActivateLaunch } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const launchAddress = await createAndActivateLaunch(alice, tokenAddress);
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        await expect(
          launchInstance.connect(alice).withdrawPendingTokens()
        ).to.be.revertedWithCustomError(launchInstance, "NotPending");
      });

      it("reverts when called by non-creator", async function () {
        const { alice, bob, launchpadFactory, createBasicToken } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        await token.connect(alice).enableTrading();

        const tx = await launchpadFactory.connect(alice).createLaunch(
          tokenAddress,
          ethers.parseUnits("700000", 18),
          0,
          BigInt(100) * BigInt(1e6),
          BigInt(500) * BigInt(1e6),
          30,
          100,
          0,
          0,
          ethers.ZeroAddress,
          0
        );
        const receipt = await tx.wait();
        const event = receipt!.logs.find((l: any) => {
          try {
            return launchpadFactory.interface.parseLog(l as any)?.name === "LaunchCreated";
          } catch {
            return false;
          }
        });
        const launchAddress = launchpadFactory.interface.parseLog(event as any)!.args.launch;
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        await expect(
          launchInstance.connect(bob).withdrawPendingTokens()
        ).to.be.revertedWithCustomError(launchInstance, "NotCreator");
      });
    });

    // -- buy --

    describe("buy", function () {
      it("buys tokens successfully with native coin", async function () {
        const { alice, bob, createBasicToken, createAndActivateLaunch } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        const launchAddress = await createAndActivateLaunch(alice, tokenAddress);
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        // Exclude launch from limits so tokens can transfer
        await token.connect(alice).setExcludedFromLimits(launchAddress, true);

        const buyAmount = ethers.parseEther("0.1"); // 0.1 ETH = ~200 USDT

        await launchInstance.connect(bob).buy(0, 0, { value: buyAmount });

        const bobTokens = await launchInstance.tokensBought(bob.address);
        expect(bobTokens).to.be.gt(0);
        expect(await launchInstance.tokensSold()).to.be.gt(0);
        expect(await launchInstance.totalBaseRaised()).to.be.gt(0);
      });

      it("reverts when launch is expired", async function () {
        const { alice, bob, createBasicToken, createAndActivateLaunch } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        const launchAddress = await createAndActivateLaunch(alice, tokenAddress);
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        await token.connect(alice).setExcludedFromLimits(launchAddress, true);

        // Advance time past deadline
        await time.increase(31 * 24 * 60 * 60);

        await expect(
          launchInstance.connect(bob).buy(0, 0, { value: ethers.parseEther("0.1") })
        ).to.be.revertedWithCustomError(launchInstance, "LaunchExpired");
      });

      it("reverts when exceeding max buy per wallet", async function () {
        const { alice, bob, usdt, launchpadFactory, createBasicToken } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        await token.connect(alice).enableTrading();

        // Use custom curve with intercept that makes tokens cost ~1 USDT each
        // linearCost(supply, amount, slope, intercept):
        //   term2 = intercept * amount / 1e18
        // For intercept = 1e6, cost for 1 token (1e18 units) = 1e6 * 1e18 / 1e18 = 1e6 = 1 USDT
        const tokensForLaunch = ethers.parseUnits("700000", 18);
        const tx = await launchpadFactory.connect(alice).createLaunchCustomCurve(
          tokenAddress,
          tokensForLaunch,
          0, // Linear
          BigInt(0),    // zero slope (constant price)
          BigInt(1e6),  // 1 USDT per token
          BigInt(10) * BigInt(1e6),      // soft cap 10 USDT
          BigInt(500000) * BigInt(1e6),  // very high hard cap
          30,
          100, // maxBuyBps = 1% of curve tokens
          0,
          0,
          ethers.ZeroAddress,
          0
        );
        const receipt = await tx.wait();
        const event = receipt!.logs.find((l: any) => {
          try {
            return launchpadFactory.interface.parseLog(l as any)?.name === "LaunchCreated";
          } catch {
            return false;
          }
        });
        const launchAddress = launchpadFactory.interface.parseLog(event as any)!.args.launch;
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        // Deposit tokens to activate
        await token.connect(alice).approve(launchAddress, tokensForLaunch);
        await launchInstance.connect(alice).depositTokens(tokensForLaunch);
        expect(await launchInstance.state()).to.equal(1);

        await token.connect(alice).setExcludedFromLimits(launchAddress, true);

        const maxBuy = await launchInstance.maxBuyPerWallet();
        // maxBuy = (700000 * 0.7 * 100) / 10000 = 4900 tokens
        // Cost for maxBuy+1 tokens = ~4901 USDT (plus 1% fee = ~4951 USDT)
        const costForExceeding = await launchInstance.getCostForTokens(maxBuy + BigInt(1e18));
        const usdtNeeded = (costForExceeding * BigInt(10200)) / BigInt(9900);

        // Mint USDT for bob (the deployer minted 1B, we need ~5000)
        await usdt.transfer(bob.address, usdtNeeded + BigInt(1e6));
        const usdtAddr = await usdt.getAddress();
        await usdt.connect(bob).approve(launchAddress, usdtNeeded + BigInt(1e6));

        // This single buy attempts to get maxBuy+1 tokens -> ExceedsMaxBuy
        await expect(
          launchInstance.connect(bob).buyWithToken(usdtAddr, usdtNeeded, 0, 0)
        ).to.be.revertedWithCustomError(launchInstance, "ExceedsMaxBuy");
      });

      it("reverts when not active", async function () {
        const { alice, bob, launchpadFactory, createBasicToken } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        await token.connect(alice).enableTrading();

        const tx = await launchpadFactory.connect(alice).createLaunch(
          tokenAddress,
          ethers.parseUnits("700000", 18),
          0,
          BigInt(100) * BigInt(1e6),
          BigInt(500) * BigInt(1e6),
          30,
          100,
          0,
          0,
          ethers.ZeroAddress,
          0
        );
        const receipt = await tx.wait();
        const event = receipt!.logs.find((l: any) => {
          try {
            return launchpadFactory.interface.parseLog(l as any)?.name === "LaunchCreated";
          } catch {
            return false;
          }
        });
        const launchAddress = launchpadFactory.interface.parseLog(event as any)!.args.launch;
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        // Still pending, not active
        await expect(
          launchInstance.connect(bob).buy(0, 0, { value: ethers.parseEther("0.1") })
        ).to.be.revertedWithCustomError(launchInstance, "NotActive");
      });

      it("reverts with zero value", async function () {
        const { alice, bob, createBasicToken, createAndActivateLaunch } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const launchAddress = await createAndActivateLaunch(alice, tokenAddress);
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        await expect(
          launchInstance.connect(bob).buy(0, 0, { value: 0 })
        ).to.be.revertedWithCustomError(launchInstance, "SendNativeCoin");
      });

      it("auto-graduates when hard cap is reached", async function () {
        const { alice, bob, charlie, dave, usdt, createBasicToken, createAndActivateLaunch } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        const launchAddress = await createAndActivateLaunch(alice, tokenAddress, {
          softCap: BigInt(50) * BigInt(1e6),
          hardCap: BigInt(200) * BigInt(1e6),
          maxBuyBps: 500, // 5% of curve tokens per wallet
        });
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        await token.connect(alice).setExcludedFromLimits(launchAddress, true);

        // Fund USDT to the launch instance for graduation (addLiquidity needs USDT)
        // The USDT is held by the launch from buys. The mock router's addLiquidity
        // will pull tokens from the launch instance, but for the USDT side, the launch
        // holds USDT from buy conversions.

        // Buy enough to hit the hard cap ($200)
        // 0.1 ETH = 200 USDT at our mock price
        // Buy from multiple accounts to stay under maxBuy
        const buyValue = ethers.parseEther("0.03"); // ~60 USDT each
        await launchInstance.connect(bob).buy(0, 0, { value: buyValue });
        await launchInstance.connect(charlie).buy(0, 0, { value: buyValue });
        await launchInstance.connect(dave).buy(0, 0, { value: buyValue });

        // Final push to hard cap
        await launchInstance.connect(alice).buy(0, 0, { value: ethers.parseEther("0.05") });

        // Should have auto-graduated
        expect(await launchInstance.state()).to.equal(2); // Graduated
      });
    });

    // -- buyWithToken --

    describe("buyWithToken", function () {
      it("buys tokens with USDT", async function () {
        const { alice, bob, usdt, createBasicToken, createAndActivateLaunch } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        const launchAddress = await createAndActivateLaunch(alice, tokenAddress);
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        await token.connect(alice).setExcludedFromLimits(launchAddress, true);

        // Give bob some USDT
        const usdtAddr = await usdt.getAddress();
        await usdt.transfer(bob.address, BigInt(1000) * BigInt(1e6));
        await usdt.connect(bob).approve(launchAddress, BigInt(100) * BigInt(1e6));

        await launchInstance
          .connect(bob)
          .buyWithToken(usdtAddr, BigInt(100) * BigInt(1e6), 0, 0);

        const bobTokens = await launchInstance.tokensBought(bob.address);
        expect(bobTokens).to.be.gt(0);
      });

      it("reverts with zero amount", async function () {
        const { alice, bob, usdt, createBasicToken, createAndActivateLaunch } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const launchAddress = await createAndActivateLaunch(alice, tokenAddress);
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        await expect(
          launchInstance
            .connect(bob)
            .buyWithToken(await usdt.getAddress(), 0, 0, 0)
        ).to.be.revertedWithCustomError(launchInstance, "ZeroAmount");
      });

      it("reverts when expired", async function () {
        const { alice, bob, usdt, createBasicToken, createAndActivateLaunch } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const launchAddress = await createAndActivateLaunch(alice, tokenAddress);
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        await usdt.transfer(bob.address, BigInt(1000) * BigInt(1e6));
        await usdt.connect(bob).approve(launchAddress, BigInt(100) * BigInt(1e6));

        await time.increase(31 * 24 * 60 * 60);

        await expect(
          launchInstance
            .connect(bob)
            .buyWithToken(await usdt.getAddress(), BigInt(100) * BigInt(1e6), 0, 0)
        ).to.be.revertedWithCustomError(launchInstance, "LaunchExpired");
      });
    });

    // -- graduate --

    describe("graduate", function () {
      it("reverts when soft cap not reached", async function () {
        const { alice, bob, createBasicToken, createAndActivateLaunch } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        const launchAddress = await createAndActivateLaunch(alice, tokenAddress, {
          softCap: BigInt(100) * BigInt(1e6),
          hardCap: BigInt(500) * BigInt(1e6),
        });
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        await token.connect(alice).setExcludedFromLimits(launchAddress, true);

        // Buy a small amount (not enough for soft cap)
        await launchInstance.connect(bob).buy(0, 0, { value: ethers.parseEther("0.01") });

        await expect(
          launchInstance.connect(alice).graduate()
        ).to.be.revertedWithCustomError(launchInstance, "SoftCapNotReached");
      });

      it("only creator can graduate early when soft cap met", async function () {
        const { alice, bob, charlie, createBasicToken, createAndActivateLaunch } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        const launchAddress = await createAndActivateLaunch(alice, tokenAddress, {
          softCap: BigInt(50) * BigInt(1e6),
          hardCap: BigInt(500) * BigInt(1e6),
          maxBuyBps: 500,
        });
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        await token.connect(alice).setExcludedFromLimits(launchAddress, true);

        // Buy enough to pass soft cap but not hard cap
        await launchInstance.connect(bob).buy(0, 0, { value: ethers.parseEther("0.05") }); // ~100 USDT

        // Non-creator cannot graduate early
        await expect(
          launchInstance.connect(charlie).graduate()
        ).to.be.revertedWithCustomError(launchInstance, "OnlyCreatorCanGraduateEarly");

        // Creator can graduate early
        await launchInstance.connect(alice).graduate();
        expect(await launchInstance.state()).to.equal(2); // Graduated
      });

      it("anyone can graduate after deadline if soft cap met", async function () {
        const { alice, bob, charlie, createBasicToken, createAndActivateLaunch } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        const launchAddress = await createAndActivateLaunch(alice, tokenAddress, {
          softCap: BigInt(50) * BigInt(1e6),
          hardCap: BigInt(500) * BigInt(1e6),
          maxBuyBps: 500,
        });
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        await token.connect(alice).setExcludedFromLimits(launchAddress, true);

        // Buy enough to pass soft cap
        await launchInstance.connect(bob).buy(0, 0, { value: ethers.parseEther("0.05") });

        // Advance past deadline
        await time.increase(31 * 24 * 60 * 60);

        // Anyone can graduate after deadline
        await launchInstance.connect(charlie).graduate();
        expect(await launchInstance.state()).to.equal(2); // Graduated
      });
    });

    // -- enableRefunds --

    describe("enableRefunds", function () {
      it("enables refunds after deadline without soft cap", async function () {
        const { alice, bob, createBasicToken, createAndActivateLaunch } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        const launchAddress = await createAndActivateLaunch(alice, tokenAddress, {
          softCap: BigInt(100) * BigInt(1e6),
          hardCap: BigInt(500) * BigInt(1e6),
        });
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        await token.connect(alice).setExcludedFromLimits(launchAddress, true);

        // Buy a small amount (not enough for soft cap)
        await launchInstance.connect(bob).buy(0, 0, { value: ethers.parseEther("0.01") });

        // Advance past deadline
        await time.increase(31 * 24 * 60 * 60);

        await launchInstance.enableRefunds();
        expect(await launchInstance.state()).to.equal(3); // Refunding
      });

      it("reverts when not active", async function () {
        const { alice, launchpadFactory, createBasicToken } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        await token.connect(alice).enableTrading();

        const tx = await launchpadFactory.connect(alice).createLaunch(
          tokenAddress,
          ethers.parseUnits("700000", 18),
          0,
          BigInt(100) * BigInt(1e6),
          BigInt(500) * BigInt(1e6),
          30,
          100,
          0,
          0,
          ethers.ZeroAddress,
          0
        );
        const receipt = await tx.wait();
        const event = receipt!.logs.find((l: any) => {
          try {
            return launchpadFactory.interface.parseLog(l as any)?.name === "LaunchCreated";
          } catch {
            return false;
          }
        });
        const launchAddress = launchpadFactory.interface.parseLog(event as any)!.args.launch;
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        // Still pending
        await expect(
          launchInstance.enableRefunds()
        ).to.be.revertedWithCustomError(launchInstance, "NotActive");
      });

      it("reverts before deadline", async function () {
        const { alice, bob, createBasicToken, createAndActivateLaunch } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        const launchAddress = await createAndActivateLaunch(alice, tokenAddress);
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        await token.connect(alice).setExcludedFromLimits(launchAddress, true);
        await launchInstance.connect(bob).buy(0, 0, { value: ethers.parseEther("0.01") });

        await expect(
          launchInstance.enableRefunds()
        ).to.be.revertedWithCustomError(launchInstance, "DeadlineNotReached");
      });

      it("reverts when soft cap already reached", async function () {
        const { alice, bob, createBasicToken, createAndActivateLaunch } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        const launchAddress = await createAndActivateLaunch(alice, tokenAddress, {
          softCap: BigInt(50) * BigInt(1e6),
          hardCap: BigInt(500) * BigInt(1e6),
          maxBuyBps: 500,
        });
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        await token.connect(alice).setExcludedFromLimits(launchAddress, true);

        // Buy enough to pass soft cap
        await launchInstance.connect(bob).buy(0, 0, { value: ethers.parseEther("0.05") });

        await time.increase(31 * 24 * 60 * 60);

        await expect(
          launchInstance.enableRefunds()
        ).to.be.revertedWithCustomError(launchInstance, "SoftCapAlreadyReached");
      });
    });

    // -- refund --

    describe("refund", function () {
      it("refunds buyer successfully after returning tokens", async function () {
        const { alice, bob, usdt, createBasicToken, createAndActivateLaunch } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        const launchAddress = await createAndActivateLaunch(alice, tokenAddress, {
          softCap: BigInt(100) * BigInt(1e6),
          hardCap: BigInt(500) * BigInt(1e6),
        });
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        await token.connect(alice).setExcludedFromLimits(launchAddress, true);

        // Bob buys
        await launchInstance.connect(bob).buy(0, 0, { value: ethers.parseEther("0.01") });

        const bobTokensBought = await launchInstance.tokensBought(bob.address);
        const bobBasePaid = await launchInstance.basePaid(bob.address);
        expect(bobTokensBought).to.be.gt(0);
        expect(bobBasePaid).to.be.gt(0);

        // Advance past deadline
        await time.increase(31 * 24 * 60 * 60);

        // Enable refunds
        await launchInstance.enableRefunds();

        // Bob needs to approve tokens return
        await token.connect(bob).approve(launchAddress, bobTokensBought);

        const bobUsdtBefore = await usdt.balanceOf(bob.address);
        await launchInstance.connect(bob).refund();
        const bobUsdtAfter = await usdt.balanceOf(bob.address);

        expect(bobUsdtAfter - bobUsdtBefore).to.equal(bobBasePaid);
        expect(await launchInstance.basePaid(bob.address)).to.equal(0);
        expect(await launchInstance.tokensBought(bob.address)).to.equal(0);
      });

      it("reverts when not in refunding state", async function () {
        const { alice, bob, createBasicToken, createAndActivateLaunch } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        const launchAddress = await createAndActivateLaunch(alice, tokenAddress);
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        await token.connect(alice).setExcludedFromLimits(launchAddress, true);
        await launchInstance.connect(bob).buy(0, 0, { value: ethers.parseEther("0.01") });

        await expect(
          launchInstance.connect(bob).refund()
        ).to.be.revertedWithCustomError(launchInstance, "NotRefunding");
      });

      it("reverts when nothing to refund", async function () {
        const { alice, bob, charlie, createBasicToken, createAndActivateLaunch } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        const launchAddress = await createAndActivateLaunch(alice, tokenAddress, {
          softCap: BigInt(100) * BigInt(1e6),
          hardCap: BigInt(500) * BigInt(1e6),
        });
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        await token.connect(alice).setExcludedFromLimits(launchAddress, true);
        await launchInstance.connect(bob).buy(0, 0, { value: ethers.parseEther("0.01") });

        await time.increase(31 * 24 * 60 * 60);
        await launchInstance.enableRefunds();

        // Charlie never bought
        await expect(
          launchInstance.connect(charlie).refund()
        ).to.be.revertedWithCustomError(launchInstance, "NothingToRefund");
      });

      it("reverts when buyer has not returned tokens", async function () {
        const { alice, bob, createBasicToken, createAndActivateLaunch } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        const launchAddress = await createAndActivateLaunch(alice, tokenAddress, {
          softCap: BigInt(100) * BigInt(1e6),
          hardCap: BigInt(500) * BigInt(1e6),
        });
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        await token.connect(alice).setExcludedFromLimits(launchAddress, true);
        await launchInstance.connect(bob).buy(0, 0, { value: ethers.parseEther("0.01") });

        await time.increase(31 * 24 * 60 * 60);
        await launchInstance.enableRefunds();

        // Bob does NOT approve tokens - should fail
        await expect(
          launchInstance.connect(bob).refund()
        ).to.be.revertedWithCustomError(launchInstance, "ReturnTokensToRefund");
      });
    });

    // -- creatorWithdrawAfterRefund --

    describe("creatorWithdrawAfterRefund", function () {
      it("allows creator to withdraw after all refunds processed", async function () {
        const { alice, bob, createBasicToken, createAndActivateLaunch } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        const launchAddress = await createAndActivateLaunch(alice, tokenAddress, {
          softCap: BigInt(100) * BigInt(1e6),
          hardCap: BigInt(500) * BigInt(1e6),
        });
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        await token.connect(alice).setExcludedFromLimits(launchAddress, true);

        // Bob buys
        await launchInstance.connect(bob).buy(0, 0, { value: ethers.parseEther("0.01") });
        const bobTokensBought = await launchInstance.tokensBought(bob.address);

        // Advance past deadline
        await time.increase(31 * 24 * 60 * 60);

        // Enable refunds
        await launchInstance.enableRefunds();

        // Bob refunds
        await token.connect(bob).approve(launchAddress, bobTokensBought);
        await launchInstance.connect(bob).refund();

        // Now all refunds processed, creator withdraws
        const balBefore = await token.balanceOf(alice.address);
        await launchInstance.connect(alice).creatorWithdrawAfterRefund();
        const balAfter = await token.balanceOf(alice.address);

        expect(balAfter).to.be.gt(balBefore);
      });

      it("reverts when outstanding refunds remain", async function () {
        const { alice, bob, createBasicToken, createAndActivateLaunch } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        const launchAddress = await createAndActivateLaunch(alice, tokenAddress, {
          softCap: BigInt(100) * BigInt(1e6),
          hardCap: BigInt(500) * BigInt(1e6),
        });
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        await token.connect(alice).setExcludedFromLimits(launchAddress, true);

        // Bob buys
        await launchInstance.connect(bob).buy(0, 0, { value: ethers.parseEther("0.01") });

        // Advance past deadline, enable refunds
        await time.increase(31 * 24 * 60 * 60);
        await launchInstance.enableRefunds();

        // Bob has NOT refunded yet
        await expect(
          launchInstance.connect(alice).creatorWithdrawAfterRefund()
        ).to.be.revertedWithCustomError(launchInstance, "OutstandingRefundsRemain");
      });

      it("reverts when not in refunding state", async function () {
        const { alice, createBasicToken, createAndActivateLaunch } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const launchAddress = await createAndActivateLaunch(alice, tokenAddress);
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        await expect(
          launchInstance.connect(alice).creatorWithdrawAfterRefund()
        ).to.be.revertedWithCustomError(launchInstance, "NotRefunding");
      });

      it("reverts when called by non-creator", async function () {
        const { alice, bob, createBasicToken, createAndActivateLaunch } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        const launchAddress = await createAndActivateLaunch(alice, tokenAddress, {
          softCap: BigInt(100) * BigInt(1e6),
          hardCap: BigInt(500) * BigInt(1e6),
        });
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        await token.connect(alice).setExcludedFromLimits(launchAddress, true);
        await launchInstance.connect(bob).buy(0, 0, { value: ethers.parseEther("0.01") });

        const bobTokens = await launchInstance.tokensBought(bob.address);

        await time.increase(31 * 24 * 60 * 60);
        await launchInstance.enableRefunds();

        await token.connect(bob).approve(launchAddress, bobTokens);
        await launchInstance.connect(bob).refund();

        await expect(
          launchInstance.connect(bob).creatorWithdrawAfterRefund()
        ).to.be.revertedWithCustomError(launchInstance, "NotCreator");
      });
    });

    // -- claimCreatorTokens (vesting) --

    describe("claimCreatorTokens", function () {
      it("reverts when not graduated", async function () {
        const { alice, createBasicToken, createAndActivateLaunch } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const launchAddress = await createAndActivateLaunch(alice, tokenAddress, {
          creatorAllocationBps: 500,
          vestingDays: 30,
        });
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        await expect(
          launchInstance.connect(alice).claimCreatorTokens()
        ).to.be.revertedWithCustomError(launchInstance, "NotGraduated");
      });

      it("reverts when cliff not reached", async function () {
        const { alice, bob, createBasicToken, createAndActivateLaunch } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        const launchAddress = await createAndActivateLaunch(alice, tokenAddress, {
          softCap: BigInt(50) * BigInt(1e6),
          hardCap: BigInt(500) * BigInt(1e6),
          maxBuyBps: 500,
          creatorAllocationBps: 500,
          vestingDays: 30,
        });
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        await token.connect(alice).setExcludedFromLimits(launchAddress, true);

        // Buy to pass soft cap
        await launchInstance.connect(bob).buy(0, 0, { value: ethers.parseEther("0.05") });

        // Graduate
        await launchInstance.connect(alice).graduate();
        expect(await launchInstance.state()).to.equal(2);

        // Immediately try to claim (cliff = 7 days)
        await expect(
          launchInstance.connect(alice).claimCreatorTokens()
        ).to.be.revertedWithCustomError(launchInstance, "CliffNotReached");
      });

      it("allows partial and full vesting claims", async function () {
        const { alice, bob, createBasicToken, createAndActivateLaunch } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        const launchAddress = await createAndActivateLaunch(alice, tokenAddress, {
          softCap: BigInt(50) * BigInt(1e6),
          hardCap: BigInt(500) * BigInt(1e6),
          maxBuyBps: 500,
          creatorAllocationBps: 500, // 5%
          vestingDays: 30,
        });
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        await token.connect(alice).setExcludedFromLimits(launchAddress, true);

        // Buy to pass soft cap
        await launchInstance.connect(bob).buy(0, 0, { value: ethers.parseEther("0.05") });

        // Graduate
        await launchInstance.connect(alice).graduate();

        const creatorTotal = await launchInstance.creatorTotalTokens();
        expect(creatorTotal).to.be.gt(0);

        // Pass cliff (7 days) + half of vesting (15 days) = 22 days
        await time.increase(22 * 24 * 60 * 60);

        // Partial claim
        const aliceBalBefore = await token.balanceOf(alice.address);
        await launchInstance.connect(alice).claimCreatorTokens();
        const aliceBalAfter = await token.balanceOf(alice.address);

        const claimed = aliceBalAfter - aliceBalBefore;
        expect(claimed).to.be.gt(0);
        // Should be roughly half of total (15/30 days into vesting)
        expect(claimed).to.be.lt(creatorTotal);

        // Advance to end of vesting (another 15+ days)
        await time.increase(16 * 24 * 60 * 60);

        // Full claim
        const aliceBalBefore2 = await token.balanceOf(alice.address);
        await launchInstance.connect(alice).claimCreatorTokens();
        const aliceBalAfter2 = await token.balanceOf(alice.address);

        const totalClaimed = await launchInstance.creatorClaimed();
        expect(totalClaimed).to.equal(creatorTotal);
      });

      it("reverts when no allocation", async function () {
        const { alice, bob, createBasicToken, createAndActivateLaunch } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        // No creator allocation
        const launchAddress = await createAndActivateLaunch(alice, tokenAddress, {
          softCap: BigInt(50) * BigInt(1e6),
          hardCap: BigInt(500) * BigInt(1e6),
          maxBuyBps: 500,
          creatorAllocationBps: 0,
          vestingDays: 0,
        });
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        await token.connect(alice).setExcludedFromLimits(launchAddress, true);

        // Buy to pass soft cap and graduate
        await launchInstance.connect(bob).buy(0, 0, { value: ethers.parseEther("0.05") });
        await launchInstance.connect(alice).graduate();

        await expect(
          launchInstance.connect(alice).claimCreatorTokens()
        ).to.be.revertedWithCustomError(launchInstance, "NoAllocation");
      });

      it("reverts when nothing to claim (already fully claimed)", async function () {
        const { alice, bob, createBasicToken, createAndActivateLaunch } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        const launchAddress = await createAndActivateLaunch(alice, tokenAddress, {
          softCap: BigInt(50) * BigInt(1e6),
          hardCap: BigInt(500) * BigInt(1e6),
          maxBuyBps: 500,
          creatorAllocationBps: 500,
          vestingDays: 30,
        });
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        await token.connect(alice).setExcludedFromLimits(launchAddress, true);

        await launchInstance.connect(bob).buy(0, 0, { value: ethers.parseEther("0.05") });
        await launchInstance.connect(alice).graduate();

        // Pass entire vesting period
        await time.increase(38 * 24 * 60 * 60); // cliff (7) + vesting (30) + 1

        await launchInstance.connect(alice).claimCreatorTokens();

        // Try claiming again
        await expect(
          launchInstance.connect(alice).claimCreatorTokens()
        ).to.be.revertedWithCustomError(launchInstance, "NothingToClaim");
      });
    });

    // -- View functions --

    describe("View functions", function () {
      it("getCurrentPrice returns price after activation", async function () {
        const { alice, createBasicToken, createAndActivateLaunch } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const launchAddress = await createAndActivateLaunch(alice, tokenAddress);
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        const price = await launchInstance.getCurrentPrice();
        expect(price).to.be.gt(0);
      });

      it("getCostForTokens returns cost", async function () {
        const { alice, createBasicToken, createAndActivateLaunch } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const launchAddress = await createAndActivateLaunch(alice, tokenAddress);
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        const cost = await launchInstance.getCostForTokens(ethers.parseUnits("1000", 18));
        expect(cost).to.be.gt(0);
      });

      it("getTokensForBase returns tokens", async function () {
        const { alice, createBasicToken, createAndActivateLaunch } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const launchAddress = await createAndActivateLaunch(alice, tokenAddress);
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        const tokens = await launchInstance.getTokensForBase(BigInt(100) * BigInt(1e6));
        expect(tokens).to.be.gt(0);
      });

      it("previewBuy returns correct preview", async function () {
        const { alice, createBasicToken, createAndActivateLaunch } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const launchAddress = await createAndActivateLaunch(alice, tokenAddress);
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        const [tokensOut, fee, priceImpact] = await launchInstance.previewBuy(
          BigInt(100) * BigInt(1e6)
        );
        expect(tokensOut).to.be.gt(0);
        expect(fee).to.be.gt(0); // 1% buy fee
      });

      it("previewBuy returns zeros when not active", async function () {
        const { alice, launchpadFactory, createBasicToken } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        await token.connect(alice).enableTrading();

        const tx = await launchpadFactory.connect(alice).createLaunch(
          tokenAddress,
          ethers.parseUnits("700000", 18),
          0,
          BigInt(100) * BigInt(1e6),
          BigInt(500) * BigInt(1e6),
          30,
          100,
          0,
          0,
          ethers.ZeroAddress,
          0
        );
        const receipt = await tx.wait();
        const event = receipt!.logs.find((l: any) => {
          try {
            return launchpadFactory.interface.parseLog(l as any)?.name === "LaunchCreated";
          } catch {
            return false;
          }
        });
        const launchAddress = launchpadFactory.interface.parseLog(event as any)!.args.launch;
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        const [tokensOut, fee, priceImpact] = await launchInstance.previewBuy(
          BigInt(100) * BigInt(1e6)
        );
        expect(tokensOut).to.equal(0);
        expect(fee).to.equal(0);
        expect(priceImpact).to.equal(0);
      });

      it("progressBps returns correct progress", async function () {
        const { alice, bob, createBasicToken, createAndActivateLaunch } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        const launchAddress = await createAndActivateLaunch(alice, tokenAddress, {
          softCap: BigInt(100) * BigInt(1e6),
          hardCap: BigInt(500) * BigInt(1e6),
        });
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        await token.connect(alice).setExcludedFromLimits(launchAddress, true);

        // Initially zero
        const [softBps0, hardBps0] = await launchInstance.progressBps();
        expect(softBps0).to.equal(0);
        expect(hardBps0).to.equal(0);

        // Buy some
        await launchInstance.connect(bob).buy(0, 0, { value: ethers.parseEther("0.01") });

        const [softBps1, hardBps1] = await launchInstance.progressBps();
        expect(softBps1).to.be.gt(0);
        expect(hardBps1).to.be.gt(0);
        expect(softBps1).to.be.gte(hardBps1); // soft cap is smaller
      });

      it("vestingInfo returns correct info before and after graduation", async function () {
        const { alice, bob, createBasicToken, createAndActivateLaunch } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        const launchAddress = await createAndActivateLaunch(alice, tokenAddress, {
          softCap: BigInt(50) * BigInt(1e6),
          hardCap: BigInt(500) * BigInt(1e6),
          maxBuyBps: 500,
          creatorAllocationBps: 500,
          vestingDays: 30,
        });
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        await token.connect(alice).setExcludedFromLimits(launchAddress, true);

        // Before graduation
        const [total0, claimed0, claimable0, nextClaim0] = await launchInstance.vestingInfo();
        expect(total0).to.be.gt(0);
        expect(claimed0).to.equal(0);
        expect(claimable0).to.equal(0);

        // Graduate
        await launchInstance.connect(bob).buy(0, 0, { value: ethers.parseEther("0.05") });
        await launchInstance.connect(alice).graduate();

        // Before cliff
        const [total1, claimed1, claimable1, nextClaim1] = await launchInstance.vestingInfo();
        expect(total1).to.be.gt(0);
        expect(claimable1).to.equal(0);
        expect(nextClaim1).to.be.gt(0); // next claim timestamp

        // After cliff + partial vesting
        await time.increase(22 * 24 * 60 * 60);
        const [total2, claimed2, claimable2, nextClaim2] = await launchInstance.vestingInfo();
        expect(claimable2).to.be.gt(0);
        expect(claimable2).to.be.lt(total2);
      });

      it("getLaunchInfo returns correct data", async function () {
        const { alice, createBasicToken, createAndActivateLaunch } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const launchAddress = await createAndActivateLaunch(alice, tokenAddress, {
          softCap: BigInt(100) * BigInt(1e6),
          hardCap: BigInt(500) * BigInt(1e6),
        });
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        const info = await launchInstance.getLaunchInfo();
        expect(info.token_).to.equal(tokenAddress);
        expect(info.creator_).to.equal(alice.address);
        expect(info.state_).to.equal(1); // Active
        expect(info.softCap_).to.equal(BigInt(100) * BigInt(1e6));
        expect(info.hardCap_).to.equal(BigInt(500) * BigInt(1e6));
        expect(info.currentPrice_).to.be.gt(0);
      });
    });

    // -- recoverETH --

    describe("recoverETH", function () {
      it("allows creator to recover ETH", async function () {
        const { alice, bob, createBasicToken, createAndActivateLaunch } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const launchAddress = await createAndActivateLaunch(alice, tokenAddress);
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        // Send ETH directly to launch
        await bob.sendTransaction({
          to: launchAddress,
          value: ethers.parseEther("1"),
        });

        const balBefore = await ethers.provider.getBalance(alice.address);
        await launchInstance.connect(alice).recoverETH();
        const balAfter = await ethers.provider.getBalance(alice.address);

        // Should have received ~1 ETH minus gas
        expect(balAfter - balBefore).to.be.gt(ethers.parseEther("0.99"));
      });

      it("reverts when no ETH to recover", async function () {
        const { alice, createBasicToken, createAndActivateLaunch } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const launchAddress = await createAndActivateLaunch(alice, tokenAddress);
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        await expect(
          launchInstance.connect(alice).recoverETH()
        ).to.be.revertedWithCustomError(launchInstance, "NoETH");
      });

      it("reverts when called by non-creator", async function () {
        const { alice, bob, createBasicToken, createAndActivateLaunch } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const launchAddress = await createAndActivateLaunch(alice, tokenAddress);
        const launchInstance = await ethers.getContractAt("LaunchInstance", launchAddress);

        await bob.sendTransaction({
          to: launchAddress,
          value: ethers.parseEther("1"),
        });

        await expect(
          launchInstance.connect(bob).recoverETH()
        ).to.be.revertedWithCustomError(launchInstance, "NotCreator");
      });
    });

    // -- Constructor validation --

    describe("Constructor validation", function () {
      it("reverts with invalid duration (too short)", async function () {
        const { alice, launchpadFactory, createBasicToken } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        await token.connect(alice).enableTrading();

        await expect(
          launchpadFactory.connect(alice).createLaunch(
            tokenAddress,
            ethers.parseUnits("700000", 18),
            0,
            BigInt(100) * BigInt(1e6),
            BigInt(500) * BigInt(1e6),
            5, // less than 7
            100,
            0,
            0,
            ethers.ZeroAddress,
            0
          )
        ).to.be.reverted;
      });

      it("reverts with invalid duration (too long)", async function () {
        const { alice, launchpadFactory, createBasicToken } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        await token.connect(alice).enableTrading();

        await expect(
          launchpadFactory.connect(alice).createLaunch(
            tokenAddress,
            ethers.parseUnits("700000", 18),
            0,
            BigInt(100) * BigInt(1e6),
            BigInt(500) * BigInt(1e6),
            91, // more than 90
            100,
            0,
            0,
            ethers.ZeroAddress,
            0
          )
        ).to.be.reverted;
      });

      it("reverts with invalid caps (softCap > hardCap)", async function () {
        const { alice, launchpadFactory, createBasicToken } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        await token.connect(alice).enableTrading();

        await expect(
          launchpadFactory.connect(alice).createLaunch(
            tokenAddress,
            ethers.parseUnits("700000", 18),
            0,
            BigInt(500) * BigInt(1e6), // soft > hard
            BigInt(100) * BigInt(1e6),
            30,
            100,
            0,
            0,
            ethers.ZeroAddress,
            0
          )
        ).to.be.reverted;
      });

      it("reverts with zero softCap", async function () {
        const { alice, launchpadFactory, createBasicToken } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        await token.connect(alice).enableTrading();

        await expect(
          launchpadFactory.connect(alice).createLaunch(
            tokenAddress,
            ethers.parseUnits("700000", 18),
            0,
            0, // zero soft cap
            BigInt(500) * BigInt(1e6),
            30,
            100,
            0,
            0,
            ethers.ZeroAddress,
            0
          )
        ).to.be.reverted;
      });

      it("reverts with invalid maxBuyBps (too low)", async function () {
        const { alice, launchpadFactory, createBasicToken } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        await token.connect(alice).enableTrading();

        await expect(
          launchpadFactory.connect(alice).createLaunch(
            tokenAddress,
            ethers.parseUnits("700000", 18),
            0,
            BigInt(100) * BigInt(1e6),
            BigInt(500) * BigInt(1e6),
            30,
            10, // less than 50
            0,
            0,
            ethers.ZeroAddress,
            0
          )
        ).to.be.reverted;
      });

      it("reverts with invalid maxBuyBps (too high)", async function () {
        const { alice, launchpadFactory, createBasicToken } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        await token.connect(alice).enableTrading();

        await expect(
          launchpadFactory.connect(alice).createLaunch(
            tokenAddress,
            ethers.parseUnits("700000", 18),
            0,
            BigInt(100) * BigInt(1e6),
            BigInt(500) * BigInt(1e6),
            30,
            600, // more than 500
            0,
            0,
            ethers.ZeroAddress,
            0
          )
        ).to.be.reverted;
      });

      it("reverts with creatorAllocationBps too high", async function () {
        const { alice, launchpadFactory, createBasicToken } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        await token.connect(alice).enableTrading();

        await expect(
          launchpadFactory.connect(alice).createLaunch(
            tokenAddress,
            ethers.parseUnits("700000", 18),
            0,
            BigInt(100) * BigInt(1e6),
            BigInt(500) * BigInt(1e6),
            30,
            100,
            600, // more than 500
            30,
            ethers.ZeroAddress,
            0
          )
        ).to.be.reverted;
      });

      it("reverts with invalid vesting days", async function () {
        const { alice, launchpadFactory, createBasicToken } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        await token.connect(alice).enableTrading();

        await expect(
          launchpadFactory.connect(alice).createLaunch(
            tokenAddress,
            ethers.parseUnits("700000", 18),
            0,
            BigInt(100) * BigInt(1e6),
            BigInt(500) * BigInt(1e6),
            30,
            100,
            500,
            45, // not 0, 30, 60, or 90
            ethers.ZeroAddress,
            0
          )
        ).to.be.reverted;
      });

      it("reverts with creator alloc but no vesting", async function () {
        const { alice, launchpadFactory, createBasicToken } =
          await loadFixture(deployFullPlatform);

        const tokenAddress = await createBasicToken(alice);
        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        await token.connect(alice).enableTrading();

        await expect(
          launchpadFactory.connect(alice).createLaunch(
            tokenAddress,
            ethers.parseUnits("700000", 18),
            0,
            BigInt(100) * BigInt(1e6),
            BigInt(500) * BigInt(1e6),
            30,
            100,
            500, // allocation > 0
            0,   // vesting = 0
            ethers.ZeroAddress,
            0
          )
        ).to.be.reverted;
      });
    });
  });
});
