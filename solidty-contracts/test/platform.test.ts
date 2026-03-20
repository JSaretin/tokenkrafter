import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Comprehensive tests for PlatformRouter and PlatformLens contracts.
 *
 * Tests every public/external function of both contracts including
 * success paths, revert cases, event emissions, and edge cases.
 */
describe("PlatformRouter & PlatformLens", function () {
  async function deployFullPlatform() {
    const [owner, alice, bob, charlie, referrer] = await ethers.getSigners();

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
    await dexRouter.setMockPrice(
      await weth.getAddress(),
      await usdt.getAddress(),
      ethPrice
    );
    const reversePrice = (BigInt(1e18) * BigInt(1e18)) / ethPrice;
    await dexRouter.setMockPrice(
      await usdt.getAddress(),
      await weth.getAddress(),
      reversePrice
    );

    // Fund router with USDT for swaps
    await usdt.transfer(
      await dexRouter.getAddress(),
      BigInt(100_000_000) * BigInt(1e6)
    );

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
    const TaxableMintableImpl = await ethers.getContractFactory(
      "TaxableMintableTokenImpl"
    );
    const taxableMintableImpl = await TaxableMintableImpl.deploy();
    const PartnerImpl = await ethers.getContractFactory("PartnerTokenImpl");
    const partnerImpl = await PartnerImpl.deploy();
    const PartnerMintableImpl = await ethers.getContractFactory(
      "PartnerMintableTokenImpl"
    );
    const partnerMintableImpl = await PartnerMintableImpl.deploy();
    const PartnerTaxableImpl = await ethers.getContractFactory(
      "PartnerTaxableTokenImpl"
    );
    const partnerTaxableImpl = await PartnerTaxableImpl.deploy();
    const PartnerTaxableMintableImpl = await ethers.getContractFactory(
      "PartnerTaxableMintableTokenImpl"
    );
    const partnerTaxableMintableImpl = await PartnerTaxableMintableImpl.deploy();

    // Register implementations (type key: partner=4, taxable=2, mintable=1)
    await tokenFactory.setImplementation(0, await basicImpl.getAddress());
    await tokenFactory.setImplementation(1, await mintableImpl.getAddress());
    await tokenFactory.setImplementation(2, await taxableImpl.getAddress());
    await tokenFactory.setImplementation(
      3,
      await taxableMintableImpl.getAddress()
    );
    await tokenFactory.setImplementation(4, await partnerImpl.getAddress());
    await tokenFactory.setImplementation(
      5,
      await partnerMintableImpl.getAddress()
    );
    await tokenFactory.setImplementation(
      6,
      await partnerTaxableImpl.getAddress()
    );
    await tokenFactory.setImplementation(
      7,
      await partnerTaxableMintableImpl.getAddress()
    );

    // Deploy BondingCurve library + LaunchpadFactory
    const BondingCurve = await ethers.getContractFactory("BondingCurve");
    const bondingCurve = await BondingCurve.deploy();

    const LaunchpadFactory = await ethers.getContractFactory(
      "LaunchpadFactory",
      {
        libraries: { BondingCurve: await bondingCurve.getAddress() },
      }
    );
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

    // Deploy PlatformLens
    const PlatformLens = await ethers.getContractFactory("PlatformLens");
    const platformLens = await PlatformLens.deploy(
      await tokenFactory.getAddress(),
      await launchpadFactory.getAddress()
    );

    // Authorize router on both factories
    await tokenFactory.setAuthorizedRouter(await platformRouter.getAddress());
    await launchpadFactory.setAuthorizedRouter(
      await platformRouter.getAddress()
    );

    // Set launch fee to 0 by default for simplicity
    await launchpadFactory.setLaunchFee(0);

    // Helper: get creation fee in native for a type key
    async function getCreationFeeNative(typeKey: number): Promise<bigint> {
      const baseFee = await tokenFactory.creationFee(typeKey);
      return await tokenFactory.convertFee(baseFee, ethers.ZeroAddress);
    }

    // Standard params used across tests
    const basicParams = {
      name: "Basic",
      symbol: "BAS",
      totalSupply: 1000000,
      decimals: 18,
      isTaxable: false,
      isMintable: false,
      isPartner: false,
      paymentToken: ethers.ZeroAddress,
    };

    const defaultLaunchParams = {
      tokensForLaunch: ethers.parseUnits("700000", 18),
      curveType: 0,
      softCap: ethers.parseUnits("100", 6),
      hardCap: ethers.parseUnits("500", 6),
      durationDays: 30,
      maxBuyBps: 100,
      creatorAllocationBps: 0,
      vestingDays: 0,
      launchPaymentToken: ethers.ZeroAddress,
      startTimestamp: 0,
    };

    const zeroProtection = {
      maxWalletAmount: 0,
      maxTransactionAmount: 0,
      cooldownSeconds: 0,
    };

    const zeroTax = {
      buyTaxBps: 0,
      sellTaxBps: 0,
      transferTaxBps: 0,
      taxWallets: [] as string[],
      taxSharesBps: [] as number[],
    };

    return {
      owner,
      alice,
      bob,
      charlie,
      referrer,
      usdt,
      weth,
      dexFactory,
      dexRouter,
      tokenFactory,
      launchpadFactory,
      platformRouter,
      platformLens,
      getCreationFeeNative,
      basicParams,
      defaultLaunchParams,
      zeroProtection,
      zeroTax,
    };
  }

  // =========================================================================
  // PlatformRouter Tests
  // =========================================================================
  describe("PlatformRouter", function () {
    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------
    describe("Constructor", function () {
      it("stores tokenFactory immutable", async function () {
        const { platformRouter, tokenFactory } =
          await loadFixture(deployFullPlatform);
        expect(await platformRouter.tokenFactory()).to.equal(
          await tokenFactory.getAddress()
        );
      });

      it("stores launchpadFactory immutable", async function () {
        const { platformRouter, launchpadFactory } =
          await loadFixture(deployFullPlatform);
        expect(await platformRouter.launchpadFactory()).to.equal(
          await launchpadFactory.getAddress()
        );
      });

      it("reverts with ZeroAddress when tokenFactory is zero", async function () {
        const { launchpadFactory } = await loadFixture(deployFullPlatform);
        const PlatformRouter =
          await ethers.getContractFactory("PlatformRouter");
        await expect(
          PlatformRouter.deploy(
            ethers.ZeroAddress,
            await launchpadFactory.getAddress()
          )
        ).to.be.revertedWithCustomError(PlatformRouter, "ZeroAddress");
      });

      it("reverts with ZeroAddress when launchpadFactory is zero", async function () {
        const { tokenFactory } = await loadFixture(deployFullPlatform);
        const PlatformRouter =
          await ethers.getContractFactory("PlatformRouter");
        await expect(
          PlatformRouter.deploy(
            await tokenFactory.getAddress(),
            ethers.ZeroAddress
          )
        ).to.be.revertedWithCustomError(PlatformRouter, "ZeroAddress");
      });

      it("reverts with ZeroAddress when both addresses are zero", async function () {
        const PlatformRouter =
          await ethers.getContractFactory("PlatformRouter");
        await expect(
          PlatformRouter.deploy(ethers.ZeroAddress, ethers.ZeroAddress)
        ).to.be.revertedWithCustomError(PlatformRouter, "ZeroAddress");
      });
    });

    // -----------------------------------------------------------------------
    // createTokenAndLaunch - Basic token (type 0)
    // -----------------------------------------------------------------------
    describe("createTokenAndLaunch - Basic token (type 0)", function () {
      it("creates a basic token and launch successfully", async function () {
        const {
          platformRouter,
          alice,
          getCreationFeeNative,
          basicParams,
          defaultLaunchParams,
          zeroProtection,
          zeroTax,
        } = await loadFixture(deployFullPlatform);

        const fee = await getCreationFeeNative(0);
        const tx = await platformRouter
          .connect(alice)
          .createTokenAndLaunch(
            basicParams,
            defaultLaunchParams,
            zeroProtection,
            zeroTax,
            ethers.ZeroAddress,
            { value: fee + ethers.parseEther("2") }
          );

        const receipt = await tx.wait();
        expect(receipt!.status).to.equal(1);
      });

      it("emits TokenCreatedAndLaunched event", async function () {
        const {
          platformRouter,
          alice,
          getCreationFeeNative,
          basicParams,
          defaultLaunchParams,
          zeroProtection,
          zeroTax,
        } = await loadFixture(deployFullPlatform);

        const fee = await getCreationFeeNative(0);
        await expect(
          platformRouter
            .connect(alice)
            .createTokenAndLaunch(
              basicParams,
              defaultLaunchParams,
              zeroProtection,
              zeroTax,
              ethers.ZeroAddress,
              { value: fee + ethers.parseEther("2") }
            )
        ).to.emit(platformRouter, "TokenCreatedAndLaunched");
      });

      it("transfers remaining tokens to creator", async function () {
        const {
          platformRouter,
          alice,
          getCreationFeeNative,
          basicParams,
          defaultLaunchParams,
          zeroProtection,
          zeroTax,
        } = await loadFixture(deployFullPlatform);

        const fee = await getCreationFeeNative(0);
        const tx = await platformRouter
          .connect(alice)
          .createTokenAndLaunch(
            basicParams,
            defaultLaunchParams,
            zeroProtection,
            zeroTax,
            ethers.ZeroAddress,
            { value: fee + ethers.parseEther("2") }
          );

        const receipt = await tx.wait();
        // Find the TokenCreatedAndLaunched event to get token address
        const event = receipt!.logs.find((l: any) => {
          try {
            return (
              platformRouter.interface.parseLog(l as any)?.name ===
              "TokenCreatedAndLaunched"
            );
          } catch {
            return false;
          }
        });
        const parsed = platformRouter.interface.parseLog(event as any);
        const tokenAddress = parsed!.args.token;

        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        const totalSupply = ethers.parseUnits("1000000", 18);
        const tokensForLaunch = ethers.parseUnits("700000", 18);
        const remaining = totalSupply - tokensForLaunch;

        expect(await token.balanceOf(alice.address)).to.equal(remaining);
      });

      it("transfers token ownership to creator", async function () {
        const {
          platformRouter,
          alice,
          getCreationFeeNative,
          basicParams,
          defaultLaunchParams,
          zeroProtection,
          zeroTax,
        } = await loadFixture(deployFullPlatform);

        const fee = await getCreationFeeNative(0);
        const tx = await platformRouter
          .connect(alice)
          .createTokenAndLaunch(
            basicParams,
            defaultLaunchParams,
            zeroProtection,
            zeroTax,
            ethers.ZeroAddress,
            { value: fee + ethers.parseEther("2") }
          );

        const receipt = await tx.wait();
        const event = receipt!.logs.find((l: any) => {
          try {
            return (
              platformRouter.interface.parseLog(l as any)?.name ===
              "TokenCreatedAndLaunched"
            );
          } catch {
            return false;
          }
        });
        const parsed = platformRouter.interface.parseLog(event as any);
        const tokenAddress = parsed!.args.token;

        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        expect(await token.owner()).to.equal(alice.address);
      });

      it("refunds excess native to creator", async function () {
        const {
          platformRouter,
          alice,
          getCreationFeeNative,
          basicParams,
          defaultLaunchParams,
          zeroProtection,
          zeroTax,
        } = await loadFixture(deployFullPlatform);

        const fee = await getCreationFeeNative(0);
        const excess = ethers.parseEther("5");

        await platformRouter
          .connect(alice)
          .createTokenAndLaunch(
            basicParams,
            defaultLaunchParams,
            zeroProtection,
            zeroTax,
            ethers.ZeroAddress,
            { value: fee + excess }
          );

        // The router should have 0 balance (all excess refunded)
        const routerBalance = await ethers.provider.getBalance(
          await platformRouter.getAddress()
        );
        expect(routerBalance).to.equal(0n);
      });
    });

    // -----------------------------------------------------------------------
    // createTokenAndLaunch - Taxable token (type 2)
    // -----------------------------------------------------------------------
    describe("createTokenAndLaunch - Taxable token (type 2)", function () {
      it("creates taxable token with tax params", async function () {
        const {
          platformRouter,
          alice,
          getCreationFeeNative,
          defaultLaunchParams,
          zeroProtection,
        } = await loadFixture(deployFullPlatform);

        const taxableParams = {
          name: "Taxable",
          symbol: "TAX",
          totalSupply: 1000000,
          decimals: 18,
          isTaxable: true,
          isMintable: false,
          isPartner: false,
          paymentToken: ethers.ZeroAddress,
        };

        const taxParams = {
          buyTaxBps: 300,
          sellTaxBps: 300,
          transferTaxBps: 0,
          taxWallets: [alice.address],
          taxSharesBps: [10000],
        };

        const fee = await getCreationFeeNative(2);
        const tx = await platformRouter
          .connect(alice)
          .createTokenAndLaunch(
            taxableParams,
            defaultLaunchParams,
            zeroProtection,
            taxParams,
            ethers.ZeroAddress,
            { value: fee + ethers.parseEther("2") }
          );

        const receipt = await tx.wait();
        const event = receipt!.logs.find((l: any) => {
          try {
            return (
              platformRouter.interface.parseLog(l as any)?.name ===
              "TokenCreatedAndLaunched"
            );
          } catch {
            return false;
          }
        });
        const parsed = platformRouter.interface.parseLog(event as any);
        const tokenAddress = parsed!.args.token;

        const token = await ethers.getContractAt(
          "TaxableTokenImpl",
          tokenAddress
        );
        expect(await token.buyTaxBps()).to.equal(300);
        expect(await token.sellTaxBps()).to.equal(300);
      });
    });

    // -----------------------------------------------------------------------
    // createTokenAndLaunch - Partner token (type 4)
    // -----------------------------------------------------------------------
    describe("createTokenAndLaunch - Partner token (type 4)", function () {
      it("creates partner token successfully", async function () {
        const {
          platformRouter,
          alice,
          getCreationFeeNative,
          defaultLaunchParams,
          zeroProtection,
          zeroTax,
        } = await loadFixture(deployFullPlatform);

        const partnerParams = {
          name: "Partner",
          symbol: "PTR",
          totalSupply: 1000000,
          decimals: 18,
          isTaxable: false,
          isMintable: false,
          isPartner: true,
          paymentToken: ethers.ZeroAddress,
        };

        const fee = await getCreationFeeNative(4);
        await expect(
          platformRouter
            .connect(alice)
            .createTokenAndLaunch(
              partnerParams,
              defaultLaunchParams,
              zeroProtection,
              zeroTax,
              ethers.ZeroAddress,
              { value: fee + ethers.parseEther("2") }
            )
        ).to.not.be.reverted;
      });
    });

    // -----------------------------------------------------------------------
    // createTokenAndLaunch - Partner+Taxable token (type 6)
    // -----------------------------------------------------------------------
    describe("createTokenAndLaunch - Partner+Taxable token (type 6)", function () {
      it("creates partner+taxable token with taxes", async function () {
        const {
          platformRouter,
          alice,
          getCreationFeeNative,
          defaultLaunchParams,
          zeroProtection,
        } = await loadFixture(deployFullPlatform);

        const partnerTaxableParams = {
          name: "PartnerTax",
          symbol: "PTAX",
          totalSupply: 1000000,
          decimals: 18,
          isTaxable: true,
          isMintable: false,
          isPartner: true,
          paymentToken: ethers.ZeroAddress,
        };

        const taxParams = {
          buyTaxBps: 300,
          sellTaxBps: 300,
          transferTaxBps: 0,
          taxWallets: [alice.address],
          taxSharesBps: [10000],
        };

        const fee = await getCreationFeeNative(6);
        const tx = await platformRouter
          .connect(alice)
          .createTokenAndLaunch(
            partnerTaxableParams,
            defaultLaunchParams,
            zeroProtection,
            taxParams,
            ethers.ZeroAddress,
            { value: fee + ethers.parseEther("2") }
          );

        const receipt = await tx.wait();
        const event = receipt!.logs.find((l: any) => {
          try {
            return (
              platformRouter.interface.parseLog(l as any)?.name ===
              "TokenCreatedAndLaunched"
            );
          } catch {
            return false;
          }
        });
        const parsed = platformRouter.interface.parseLog(event as any);
        const tokenAddress = parsed!.args.token;

        const token = await ethers.getContractAt(
          "PartnerTaxableTokenImpl",
          tokenAddress
        );
        expect(await token.buyTaxBps()).to.equal(300);
        expect(await token.sellTaxBps()).to.equal(300);
        expect(await token.owner()).to.equal(alice.address);
      });
    });

    // -----------------------------------------------------------------------
    // createTokenAndLaunch - With protection params
    // -----------------------------------------------------------------------
    describe("createTokenAndLaunch - With protection params", function () {
      it("applies maxWallet, maxTx, and cooldown protections", async function () {
        const {
          platformRouter,
          alice,
          getCreationFeeNative,
          basicParams,
          defaultLaunchParams,
          zeroTax,
        } = await loadFixture(deployFullPlatform);

        const protection = {
          maxWalletAmount: ethers.parseUnits("50000", 18),
          maxTransactionAmount: ethers.parseUnits("10000", 18),
          cooldownSeconds: 60,
        };

        const fee = await getCreationFeeNative(0);
        const tx = await platformRouter
          .connect(alice)
          .createTokenAndLaunch(
            basicParams,
            defaultLaunchParams,
            protection,
            zeroTax,
            ethers.ZeroAddress,
            { value: fee + ethers.parseEther("2") }
          );

        const receipt = await tx.wait();
        const event = receipt!.logs.find((l: any) => {
          try {
            return (
              platformRouter.interface.parseLog(l as any)?.name ===
              "TokenCreatedAndLaunched"
            );
          } catch {
            return false;
          }
        });
        const parsed = platformRouter.interface.parseLog(event as any);
        const tokenAddress = parsed!.args.token;

        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        expect(await token.maxWalletAmount()).to.equal(
          ethers.parseUnits("50000", 18)
        );
        expect(await token.maxTransactionAmount()).to.equal(
          ethers.parseUnits("10000", 18)
        );
        expect(await token.cooldownTime()).to.equal(60);
        expect(await token.tradingEnabled()).to.be.true;
      });

      it("excludes creator from limits", async function () {
        const {
          platformRouter,
          alice,
          getCreationFeeNative,
          basicParams,
          defaultLaunchParams,
          zeroTax,
          zeroProtection,
        } = await loadFixture(deployFullPlatform);

        const fee = await getCreationFeeNative(0);
        const tx = await platformRouter
          .connect(alice)
          .createTokenAndLaunch(
            basicParams,
            defaultLaunchParams,
            zeroProtection,
            zeroTax,
            ethers.ZeroAddress,
            { value: fee + ethers.parseEther("2") }
          );

        const receipt = await tx.wait();
        const event = receipt!.logs.find((l: any) => {
          try {
            return (
              platformRouter.interface.parseLog(l as any)?.name ===
              "TokenCreatedAndLaunched"
            );
          } catch {
            return false;
          }
        });
        const parsed = platformRouter.interface.parseLog(event as any);
        const tokenAddress = parsed!.args.token;

        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        expect(await token.isExcludedFromLimits(alice.address)).to.be.true;
      });

      it("excludes launch contract from limits", async function () {
        const {
          platformRouter,
          alice,
          getCreationFeeNative,
          basicParams,
          defaultLaunchParams,
          zeroTax,
          zeroProtection,
        } = await loadFixture(deployFullPlatform);

        const fee = await getCreationFeeNative(0);
        const tx = await platformRouter
          .connect(alice)
          .createTokenAndLaunch(
            basicParams,
            defaultLaunchParams,
            zeroProtection,
            zeroTax,
            ethers.ZeroAddress,
            { value: fee + ethers.parseEther("2") }
          );

        const receipt = await tx.wait();
        const event = receipt!.logs.find((l: any) => {
          try {
            return (
              platformRouter.interface.parseLog(l as any)?.name ===
              "TokenCreatedAndLaunched"
            );
          } catch {
            return false;
          }
        });
        const parsed = platformRouter.interface.parseLog(event as any);
        const launchAddress = parsed!.args.launch;
        const tokenAddress = parsed!.args.token;

        const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
        expect(await token.isExcludedFromLimits(launchAddress)).to.be.true;
      });
    });

    // -----------------------------------------------------------------------
    // createTokenAndLaunch - With native payment for fees
    // -----------------------------------------------------------------------
    describe("createTokenAndLaunch - Native payment", function () {
      it("works with native payment for creation fee", async function () {
        const {
          platformRouter,
          alice,
          getCreationFeeNative,
          basicParams,
          defaultLaunchParams,
          zeroProtection,
          zeroTax,
        } = await loadFixture(deployFullPlatform);

        const fee = await getCreationFeeNative(0);
        await expect(
          platformRouter
            .connect(alice)
            .createTokenAndLaunch(
              basicParams,
              defaultLaunchParams,
              zeroProtection,
              zeroTax,
              ethers.ZeroAddress,
              { value: fee + ethers.parseEther("1") }
            )
        ).to.not.be.reverted;
      });

      it("works when launch fee is also set and paid natively", async function () {
        const {
          platformRouter,
          alice,
          getCreationFeeNative,
          launchpadFactory,
          basicParams,
          defaultLaunchParams,
          zeroProtection,
          zeroTax,
        } = await loadFixture(deployFullPlatform);

        // Set launch fee to 50 USDT
        await launchpadFactory.setLaunchFee(BigInt(50) * BigInt(1e6));

        const fee = await getCreationFeeNative(0);
        // Need extra native to cover both creation fee and launch fee
        await expect(
          platformRouter
            .connect(alice)
            .createTokenAndLaunch(
              basicParams,
              defaultLaunchParams,
              zeroProtection,
              zeroTax,
              ethers.ZeroAddress,
              { value: fee + ethers.parseEther("5") }
            )
        ).to.not.be.reverted;
      });
    });

    // -----------------------------------------------------------------------
    // createTokenAndLaunch - Revert: TokensForLaunchExceedsSupply
    // -----------------------------------------------------------------------
    describe("createTokenAndLaunch - Revert cases", function () {
      it("reverts with TokensForLaunchExceedsSupply when tokensForLaunch exceeds supply", async function () {
        const {
          platformRouter,
          alice,
          getCreationFeeNative,
          basicParams,
          zeroProtection,
          zeroTax,
        } = await loadFixture(deployFullPlatform);

        const totalSupply = ethers.parseUnits("1000000", 18);
        const excessiveLaunchParams = {
          tokensForLaunch: totalSupply + 1n, // exceeds supply
          curveType: 0,
          softCap: ethers.parseUnits("100", 6),
          hardCap: ethers.parseUnits("500", 6),
          durationDays: 30,
          maxBuyBps: 100,
          creatorAllocationBps: 0,
          vestingDays: 0,
          launchPaymentToken: ethers.ZeroAddress,
          startTimestamp: 0,
        };

        const fee = await getCreationFeeNative(0);
        await expect(
          platformRouter
            .connect(alice)
            .createTokenAndLaunch(
              basicParams,
              excessiveLaunchParams,
              zeroProtection,
              zeroTax,
              ethers.ZeroAddress,
              { value: fee + ethers.parseEther("2") }
            )
        ).to.be.revertedWithCustomError(
          platformRouter,
          "TokensForLaunchExceedsSupply"
        );
      });
    });

    // -----------------------------------------------------------------------
    // createTokenAndLaunch - Launch tokens deposited correctly
    // -----------------------------------------------------------------------
    describe("createTokenAndLaunch - Launch token deposit", function () {
      it("deposits tokensForLaunch to the launch instance", async function () {
        const {
          platformRouter,
          alice,
          getCreationFeeNative,
          basicParams,
          defaultLaunchParams,
          zeroProtection,
          zeroTax,
        } = await loadFixture(deployFullPlatform);

        const fee = await getCreationFeeNative(0);
        const tx = await platformRouter
          .connect(alice)
          .createTokenAndLaunch(
            basicParams,
            defaultLaunchParams,
            zeroProtection,
            zeroTax,
            ethers.ZeroAddress,
            { value: fee + ethers.parseEther("2") }
          );

        const receipt = await tx.wait();
        const event = receipt!.logs.find((l: any) => {
          try {
            return (
              platformRouter.interface.parseLog(l as any)?.name ===
              "TokenCreatedAndLaunched"
            );
          } catch {
            return false;
          }
        });
        const parsed = platformRouter.interface.parseLog(event as any);
        const tokenAddress = parsed!.args.token;
        const launchAddress = parsed!.args.launch;

        const token = await ethers.getContractAt(
          "IERC20",
          tokenAddress
        );
        expect(await token.balanceOf(launchAddress)).to.equal(
          defaultLaunchParams.tokensForLaunch
        );
      });

      it("launch activates after deposit (state is Active)", async function () {
        const {
          platformRouter,
          alice,
          getCreationFeeNative,
          basicParams,
          defaultLaunchParams,
          zeroProtection,
          zeroTax,
        } = await loadFixture(deployFullPlatform);

        const fee = await getCreationFeeNative(0);
        const tx = await platformRouter
          .connect(alice)
          .createTokenAndLaunch(
            basicParams,
            defaultLaunchParams,
            zeroProtection,
            zeroTax,
            ethers.ZeroAddress,
            { value: fee + ethers.parseEther("2") }
          );

        const receipt = await tx.wait();
        const event = receipt!.logs.find((l: any) => {
          try {
            return (
              platformRouter.interface.parseLog(l as any)?.name ===
              "TokenCreatedAndLaunched"
            );
          } catch {
            return false;
          }
        });
        const parsed = platformRouter.interface.parseLog(event as any);
        const launchAddress = parsed!.args.launch;

        const launch = await ethers.getContractAt(
          "LaunchInstance",
          launchAddress
        );
        // Active = 1
        expect(await launch.state()).to.equal(1);
      });
    });

    // -----------------------------------------------------------------------
    // createTokenAndLaunch - With referral
    // -----------------------------------------------------------------------
    describe("createTokenAndLaunch - With referral", function () {
      it("records referral when referral address is provided", async function () {
        const {
          platformRouter,
          alice,
          referrer,
          tokenFactory,
          getCreationFeeNative,
          basicParams,
          defaultLaunchParams,
          zeroProtection,
          zeroTax,
        } = await loadFixture(deployFullPlatform);

        const fee = await getCreationFeeNative(0);
        await platformRouter
          .connect(alice)
          .createTokenAndLaunch(
            basicParams,
            defaultLaunchParams,
            zeroProtection,
            zeroTax,
            referrer.address,
            { value: fee + ethers.parseEther("2") }
          );

        expect(await tokenFactory.referrals(alice.address)).to.equal(
          referrer.address
        );
        expect(await tokenFactory.totalReferred(referrer.address)).to.equal(1);
      });
    });

    // -----------------------------------------------------------------------
    // createTokenAndLaunch - Taxable launch excludes launch from tax
    // -----------------------------------------------------------------------
    describe("createTokenAndLaunch - Tax exclusions", function () {
      it("excludes launch contract from tax for taxable tokens", async function () {
        const {
          platformRouter,
          alice,
          getCreationFeeNative,
          defaultLaunchParams,
          zeroProtection,
        } = await loadFixture(deployFullPlatform);

        const taxableParams = {
          name: "Taxable",
          symbol: "TAX",
          totalSupply: 1000000,
          decimals: 18,
          isTaxable: true,
          isMintable: false,
          isPartner: false,
          paymentToken: ethers.ZeroAddress,
        };

        const taxParams = {
          buyTaxBps: 300,
          sellTaxBps: 300,
          transferTaxBps: 0,
          taxWallets: [alice.address],
          taxSharesBps: [10000],
        };

        const fee = await getCreationFeeNative(2);
        const tx = await platformRouter
          .connect(alice)
          .createTokenAndLaunch(
            taxableParams,
            defaultLaunchParams,
            zeroProtection,
            taxParams,
            ethers.ZeroAddress,
            { value: fee + ethers.parseEther("2") }
          );

        const receipt = await tx.wait();
        const event = receipt!.logs.find((l: any) => {
          try {
            return (
              platformRouter.interface.parseLog(l as any)?.name ===
              "TokenCreatedAndLaunched"
            );
          } catch {
            return false;
          }
        });
        const parsed = platformRouter.interface.parseLog(event as any);
        const tokenAddress = parsed!.args.token;
        const launchAddress = parsed!.args.launch;

        const token = await ethers.getContractAt(
          "TaxableTokenImpl",
          tokenAddress
        );
        expect(await token.isTaxFree(launchAddress)).to.be.true;
      });
    });

    // -----------------------------------------------------------------------
    // createTokenAndLaunch - Router balance is 0 after call
    // -----------------------------------------------------------------------
    describe("createTokenAndLaunch - Router cleanup", function () {
      it("router has 0 native balance after call", async function () {
        const {
          platformRouter,
          alice,
          getCreationFeeNative,
          basicParams,
          defaultLaunchParams,
          zeroProtection,
          zeroTax,
        } = await loadFixture(deployFullPlatform);

        const fee = await getCreationFeeNative(0);
        await platformRouter
          .connect(alice)
          .createTokenAndLaunch(
            basicParams,
            defaultLaunchParams,
            zeroProtection,
            zeroTax,
            ethers.ZeroAddress,
            { value: fee + ethers.parseEther("5") }
          );

        const routerBalance = await ethers.provider.getBalance(
          await platformRouter.getAddress()
        );
        expect(routerBalance).to.equal(0n);
      });

      it("router has 0 token balance after call", async function () {
        const {
          platformRouter,
          alice,
          getCreationFeeNative,
          basicParams,
          defaultLaunchParams,
          zeroProtection,
          zeroTax,
        } = await loadFixture(deployFullPlatform);

        const fee = await getCreationFeeNative(0);
        const tx = await platformRouter
          .connect(alice)
          .createTokenAndLaunch(
            basicParams,
            defaultLaunchParams,
            zeroProtection,
            zeroTax,
            ethers.ZeroAddress,
            { value: fee + ethers.parseEther("2") }
          );

        const receipt = await tx.wait();
        const event = receipt!.logs.find((l: any) => {
          try {
            return (
              platformRouter.interface.parseLog(l as any)?.name ===
              "TokenCreatedAndLaunched"
            );
          } catch {
            return false;
          }
        });
        const parsed = platformRouter.interface.parseLog(event as any);
        const tokenAddress = parsed!.args.token;

        const token = await ethers.getContractAt("IERC20", tokenAddress);
        expect(
          await token.balanceOf(await platformRouter.getAddress())
        ).to.equal(0n);
      });
    });

    // -----------------------------------------------------------------------
    // createTokenAndLaunch - All tokensForLaunch scenario (no remaining)
    // -----------------------------------------------------------------------
    describe("createTokenAndLaunch - Full supply launch", function () {
      it("creator receives 0 when all tokens go to launch", async function () {
        const {
          platformRouter,
          alice,
          getCreationFeeNative,
          zeroProtection,
          zeroTax,
        } = await loadFixture(deployFullPlatform);

        const fullLaunchParams = {
          name: "FullLaunch",
          symbol: "FULL",
          totalSupply: 1000000,
          decimals: 18,
          isTaxable: false,
          isMintable: false,
          isPartner: false,
          paymentToken: ethers.ZeroAddress,
        };

        const launchParams = {
          tokensForLaunch: ethers.parseUnits("1000000", 18), // all tokens
          curveType: 0,
          softCap: ethers.parseUnits("100", 6),
          hardCap: ethers.parseUnits("500", 6),
          durationDays: 30,
          maxBuyBps: 100,
          creatorAllocationBps: 0,
          vestingDays: 0,
          launchPaymentToken: ethers.ZeroAddress,
          startTimestamp: 0,
        };

        const fee = await getCreationFeeNative(0);
        const tx = await platformRouter
          .connect(alice)
          .createTokenAndLaunch(
            fullLaunchParams,
            launchParams,
            zeroProtection,
            zeroTax,
            ethers.ZeroAddress,
            { value: fee + ethers.parseEther("2") }
          );

        const receipt = await tx.wait();
        const event = receipt!.logs.find((l: any) => {
          try {
            return (
              platformRouter.interface.parseLog(l as any)?.name ===
              "TokenCreatedAndLaunched"
            );
          } catch {
            return false;
          }
        });
        const parsed = platformRouter.interface.parseLog(event as any);
        const tokenAddress = parsed!.args.token;

        const token = await ethers.getContractAt("IERC20", tokenAddress);
        expect(await token.balanceOf(alice.address)).to.equal(0n);
      });
    });

    // -----------------------------------------------------------------------
    // createTokenAndLaunch - Event args verification
    // -----------------------------------------------------------------------
    describe("createTokenAndLaunch - Event args", function () {
      it("event has correct creator, token, and launch addresses", async function () {
        const {
          platformRouter,
          alice,
          getCreationFeeNative,
          basicParams,
          defaultLaunchParams,
          zeroProtection,
          zeroTax,
          launchpadFactory,
        } = await loadFixture(deployFullPlatform);

        const fee = await getCreationFeeNative(0);
        const tx = await platformRouter
          .connect(alice)
          .createTokenAndLaunch(
            basicParams,
            defaultLaunchParams,
            zeroProtection,
            zeroTax,
            ethers.ZeroAddress,
            { value: fee + ethers.parseEther("2") }
          );

        const receipt = await tx.wait();
        const event = receipt!.logs.find((l: any) => {
          try {
            return (
              platformRouter.interface.parseLog(l as any)?.name ===
              "TokenCreatedAndLaunched"
            );
          } catch {
            return false;
          }
        });
        const parsed = platformRouter.interface.parseLog(event as any);

        expect(parsed!.args.creator).to.equal(alice.address);
        // Token and launch addresses should be non-zero
        expect(parsed!.args.token).to.not.equal(ethers.ZeroAddress);
        expect(parsed!.args.launch).to.not.equal(ethers.ZeroAddress);

        // Verify launch is registered in factory
        const totalLaunches = await launchpadFactory.totalLaunches();
        expect(totalLaunches).to.equal(1);
      });
    });
  });

  // =========================================================================
  // PlatformLens Tests
  // =========================================================================
  describe("PlatformLens", function () {
    // Helper: creates a token+launch via router and returns addresses
    async function createTokenAndLaunchHelper(fixture: any) {
      const {
        platformRouter,
        alice,
        getCreationFeeNative,
        basicParams,
        defaultLaunchParams,
        zeroProtection,
        zeroTax,
      } = fixture;

      const fee = await getCreationFeeNative(0);
      const tx = await platformRouter
        .connect(alice)
        .createTokenAndLaunch(
          basicParams,
          defaultLaunchParams,
          zeroProtection,
          zeroTax,
          ethers.ZeroAddress,
          { value: fee + ethers.parseEther("2") }
        );

      const receipt = await tx.wait();
      const event = receipt!.logs.find((l: any) => {
        try {
          return (
            platformRouter.interface.parseLog(l as any)?.name ===
            "TokenCreatedAndLaunched"
          );
        } catch {
          return false;
        }
      });
      const parsed = platformRouter.interface.parseLog(event as any);
      return {
        tokenAddress: parsed!.args.token,
        launchAddress: parsed!.args.launch,
      };
    }

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------
    describe("Constructor", function () {
      it("stores tokenFactory immutable", async function () {
        const { platformLens, tokenFactory } =
          await loadFixture(deployFullPlatform);
        expect(await platformLens.tokenFactory()).to.equal(
          await tokenFactory.getAddress()
        );
      });

      it("stores launchpadFactory immutable", async function () {
        const { platformLens, launchpadFactory } =
          await loadFixture(deployFullPlatform);
        expect(await platformLens.launchpadFactory()).to.equal(
          await launchpadFactory.getAddress()
        );
      });
    });

    // -----------------------------------------------------------------------
    // getTokenStats
    // -----------------------------------------------------------------------
    describe("getTokenStats", function () {
      it("returns 0 total and all zeros when no tokens created", async function () {
        const { platformLens } = await loadFixture(deployFullPlatform);
        const [total, byType] = await platformLens.getTokenStats();
        expect(total).to.equal(0);
        for (let i = 0; i < 8; i++) {
          expect(byType[i]).to.equal(0);
        }
      });

      it("returns correct total and per-type breakdown after creating tokens", async function () {
        const fixture = await loadFixture(deployFullPlatform);
        const { platformLens } = fixture;

        // Create one basic token via router
        await createTokenAndLaunchHelper(fixture);

        const [total, byType] = await platformLens.getTokenStats();
        expect(total).to.equal(1);
        expect(byType[0]).to.equal(1); // basic = type 0
      });

      it("tracks multiple token types", async function () {
        const fixture = await loadFixture(deployFullPlatform);
        const {
          platformRouter,
          platformLens,
          alice,
          bob,
          getCreationFeeNative,
          defaultLaunchParams,
          zeroProtection,
          zeroTax,
        } = fixture;

        // Create basic token (type 0)
        const fee0 = await getCreationFeeNative(0);
        await platformRouter.connect(alice).createTokenAndLaunch(
          {
            name: "Basic",
            symbol: "BAS",
            totalSupply: 1000000,
            decimals: 18,
            isTaxable: false,
            isMintable: false,
            isPartner: false,
            paymentToken: ethers.ZeroAddress,
          },
          defaultLaunchParams,
          zeroProtection,
          zeroTax,
          ethers.ZeroAddress,
          { value: fee0 + ethers.parseEther("2") }
        );

        // Create partner token (type 4)
        const fee4 = await getCreationFeeNative(4);
        await platformRouter.connect(bob).createTokenAndLaunch(
          {
            name: "Partner",
            symbol: "PTR",
            totalSupply: 1000000,
            decimals: 18,
            isTaxable: false,
            isMintable: false,
            isPartner: true,
            paymentToken: ethers.ZeroAddress,
          },
          defaultLaunchParams,
          zeroProtection,
          zeroTax,
          ethers.ZeroAddress,
          { value: fee4 + ethers.parseEther("2") }
        );

        const [total, byType] = await platformLens.getTokenStats();
        expect(total).to.equal(2);
        expect(byType[0]).to.equal(1); // basic
        expect(byType[4]).to.equal(1); // partner
      });
    });

    // -----------------------------------------------------------------------
    // getCreationFee
    // -----------------------------------------------------------------------
    describe("getCreationFee", function () {
      it("returns fees in all supported payment tokens for basic", async function () {
        const { platformLens } = await loadFixture(deployFullPlatform);
        const [tokens, fees] = await platformLens.getCreationFee(
          false,
          false,
          false
        );
        // Should have USDT and native (address(0)) as supported tokens
        expect(tokens.length).to.be.greaterThanOrEqual(2);
        expect(fees.length).to.equal(tokens.length);
        // All fees should be > 0 (basic fee is 10 USDT)
        for (let i = 0; i < fees.length; i++) {
          expect(fees[i]).to.be.greaterThan(0);
        }
      });

      it("returns higher fee for taxable tokens", async function () {
        const { platformLens, usdt } = await loadFixture(deployFullPlatform);
        const [, basicFees] = await platformLens.getCreationFee(
          false,
          false,
          false
        );
        const [, taxFees] = await platformLens.getCreationFee(
          true,
          false,
          false
        );

        // Find USDT index to compare directly
        const [tokens] = await platformLens.getCreationFee(false, false, false);
        const usdtAddr = await usdt.getAddress();
        let usdtIdx = -1;
        for (let i = 0; i < tokens.length; i++) {
          if (tokens[i] === usdtAddr) {
            usdtIdx = i;
            break;
          }
        }
        if (usdtIdx >= 0) {
          expect(taxFees[usdtIdx]).to.be.greaterThan(basicFees[usdtIdx]);
        }
      });

      it("returns correct type-specific fees for partner+taxable+mintable", async function () {
        const { platformLens, tokenFactory } =
          await loadFixture(deployFullPlatform);
        const [tokens, fees] = await platformLens.getCreationFee(
          true,
          true,
          true
        );
        // type key 7 = partner+taxable+mintable
        const baseFee = await tokenFactory.creationFee(7);
        // The USDT fee should match baseFee
        const usdtAddr = await tokenFactory.usdt();
        for (let i = 0; i < tokens.length; i++) {
          if (tokens[i] === usdtAddr) {
            expect(fees[i]).to.equal(baseFee);
          }
        }
      });
    });

    // -----------------------------------------------------------------------
    // getLaunchFee
    // -----------------------------------------------------------------------
    describe("getLaunchFee", function () {
      it("returns 0 when launch fee is 0", async function () {
        const { platformLens } = await loadFixture(deployFullPlatform);
        // Launch fee was set to 0 in fixture
        const fee = await platformLens.getLaunchFee(ethers.ZeroAddress);
        expect(fee).to.equal(0);
      });

      it("returns launch fee in specified payment token when fee is set", async function () {
        const { platformLens, launchpadFactory, usdt } =
          await loadFixture(deployFullPlatform);

        // Set launch fee to 50 USDT
        await launchpadFactory.setLaunchFee(BigInt(50) * BigInt(1e6));

        const feeInUsdt = await platformLens.getLaunchFee(
          await usdt.getAddress()
        );
        expect(feeInUsdt).to.equal(BigInt(50) * BigInt(1e6));

        // Also check native
        const feeInNative = await platformLens.getLaunchFee(ethers.ZeroAddress);
        expect(feeInNative).to.be.greaterThan(0);
      });
    });

    // -----------------------------------------------------------------------
    // getActiveLaunches
    // -----------------------------------------------------------------------
    describe("getActiveLaunches", function () {
      it("returns empty when no launches", async function () {
        const { platformLens } = await loadFixture(deployFullPlatform);
        const [result, total] = await platformLens.getActiveLaunches(0, 10);
        expect(result.length).to.equal(0);
        expect(total).to.equal(0);
      });

      it("returns active launches after creating one", async function () {
        const fixture = await loadFixture(deployFullPlatform);
        const { platformLens } = fixture;

        const { launchAddress } = await createTokenAndLaunchHelper(fixture);

        const [result, total] = await platformLens.getActiveLaunches(0, 10);
        expect(total).to.equal(1);
        expect(result.length).to.equal(1);
        expect(result[0]).to.equal(launchAddress);
      });

      it("returns empty when offset >= total", async function () {
        const fixture = await loadFixture(deployFullPlatform);
        const { platformLens } = fixture;

        await createTokenAndLaunchHelper(fixture);

        const [result, total] = await platformLens.getActiveLaunches(10, 10);
        expect(result.length).to.equal(0);
        expect(total).to.equal(1); // total still reports the real count
      });

      it("paginates correctly with multiple launches", async function () {
        const fixture = await loadFixture(deployFullPlatform);
        const {
          platformRouter,
          platformLens,
          alice,
          bob,
          charlie,
          getCreationFeeNative,
          defaultLaunchParams,
          zeroProtection,
          zeroTax,
        } = fixture;

        // Create 3 launches with different users
        const signers = [alice, bob, charlie];
        const launchAddresses: string[] = [];

        for (let i = 0; i < 3; i++) {
          const fee = await getCreationFeeNative(0);
          const tx = await platformRouter
            .connect(signers[i])
            .createTokenAndLaunch(
              {
                name: `Token${i}`,
                symbol: `TK${i}`,
                totalSupply: 1000000,
                decimals: 18,
                isTaxable: false,
                isMintable: false,
                isPartner: false,
                paymentToken: ethers.ZeroAddress,
              },
              defaultLaunchParams,
              zeroProtection,
              zeroTax,
              ethers.ZeroAddress,
              { value: fee + ethers.parseEther("2") }
            );
          const receipt = await tx.wait();
          const event = receipt!.logs.find((l: any) => {
            try {
              return (
                platformRouter.interface.parseLog(l as any)?.name ===
                "TokenCreatedAndLaunched"
              );
            } catch {
              return false;
            }
          });
          const parsed = platformRouter.interface.parseLog(event as any);
          launchAddresses.push(parsed!.args.launch);
        }

        // Page 1: offset=0, limit=2
        const [page1, total1] = await platformLens.getActiveLaunches(0, 2);
        expect(total1).to.equal(3);
        expect(page1.length).to.equal(2);

        // Page 2: offset=2, limit=2
        const [page2, total2] = await platformLens.getActiveLaunches(2, 2);
        expect(total2).to.equal(3);
        expect(page2.length).to.equal(1);
      });
    });

    // -----------------------------------------------------------------------
    // getTokenDailyStats
    // -----------------------------------------------------------------------
    describe("getTokenDailyStats", function () {
      it("returns stats for a valid day range", async function () {
        const fixture = await loadFixture(deployFullPlatform);
        const { platformLens } = fixture;

        await createTokenAndLaunchHelper(fixture);

        const currentDay = BigInt(
          Math.floor(Date.now() / 1000 / 86400)
        );
        const stats = await platformLens.getTokenDailyStats(
          currentDay,
          currentDay
        );
        expect(stats.length).to.equal(1);
        expect(stats[0].totalTokens).to.equal(1);
      });

      it("reverts when toDay < fromDay (invalid range)", async function () {
        const { platformLens } = await loadFixture(deployFullPlatform);
        await expect(
          platformLens.getTokenDailyStats(100, 50)
        ).to.be.revertedWith("invalid range");
      });

      it("reverts when range exceeds 365 days", async function () {
        const { platformLens } = await loadFixture(deployFullPlatform);
        await expect(
          platformLens.getTokenDailyStats(0, 366)
        ).to.be.revertedWith("max 365 days");
      });

      it("returns empty stats for days with no activity", async function () {
        const { platformLens } = await loadFixture(deployFullPlatform);
        const stats = await platformLens.getTokenDailyStats(1, 3);
        expect(stats.length).to.equal(3);
        for (const s of stats) {
          expect(s.totalTokens).to.equal(0);
        }
      });
    });

    // -----------------------------------------------------------------------
    // getLaunchDailyStats
    // -----------------------------------------------------------------------
    describe("getLaunchDailyStats", function () {
      it("returns launch stats for a valid day range", async function () {
        const fixture = await loadFixture(deployFullPlatform);
        const { platformLens } = fixture;

        await createTokenAndLaunchHelper(fixture);

        const currentDay = BigInt(
          Math.floor(Date.now() / 1000 / 86400)
        );
        const stats = await platformLens.getLaunchDailyStats(
          currentDay,
          currentDay
        );
        expect(stats.length).to.equal(1);
        expect(stats[0].created).to.equal(1);
      });

      it("reverts when toDay < fromDay", async function () {
        const { platformLens } = await loadFixture(deployFullPlatform);
        await expect(
          platformLens.getLaunchDailyStats(100, 50)
        ).to.be.revertedWith("invalid range");
      });

      it("reverts when range exceeds 365 days", async function () {
        const { platformLens } = await loadFixture(deployFullPlatform);
        await expect(
          platformLens.getLaunchDailyStats(0, 366)
        ).to.be.revertedWith("max 365 days");
      });
    });

    // -----------------------------------------------------------------------
    // getReferralStats
    // -----------------------------------------------------------------------
    describe("getReferralStats", function () {
      it("returns referral data for a referrer", async function () {
        const fixture = await loadFixture(deployFullPlatform);
        const {
          platformRouter,
          platformLens,
          alice,
          referrer,
          usdt,
          getCreationFeeNative,
          defaultLaunchParams,
          zeroProtection,
          zeroTax,
        } = fixture;

        // Create token with referral
        const fee = await getCreationFeeNative(0);
        await platformRouter.connect(alice).createTokenAndLaunch(
          {
            name: "Ref",
            symbol: "REF",
            totalSupply: 1000000,
            decimals: 18,
            isTaxable: false,
            isMintable: false,
            isPartner: false,
            paymentToken: ethers.ZeroAddress,
          },
          defaultLaunchParams,
          zeroProtection,
          zeroTax,
          referrer.address,
          { value: fee + ethers.parseEther("2") }
        );

        const paymentTokens = [ethers.ZeroAddress, await usdt.getAddress()];
        const [referred, earned, pending] =
          await platformLens.getReferralStats(referrer.address, paymentTokens);

        expect(referred).to.equal(1);
        expect(earned.length).to.equal(2);
        expect(pending.length).to.equal(2);
      });

      it("returns zeros for address with no referrals", async function () {
        const { platformLens, alice, usdt } =
          await loadFixture(deployFullPlatform);
        const [referred, earned, pending] =
          await platformLens.getReferralStats(alice.address, [
            await usdt.getAddress(),
          ]);
        expect(referred).to.equal(0);
        expect(earned[0]).to.equal(0);
        expect(pending[0]).to.equal(0);
      });
    });

    // -----------------------------------------------------------------------
    // getReferralChain
    // -----------------------------------------------------------------------
    describe("getReferralChain", function () {
      it("returns empty chain for user with no referrer", async function () {
        const { platformLens, alice } = await loadFixture(deployFullPlatform);
        const chain = await platformLens.getReferralChain(alice.address);
        expect(chain.length).to.equal(0);
      });

      it("walks referral chain correctly", async function () {
        const fixture = await loadFixture(deployFullPlatform);
        const {
          platformRouter,
          platformLens,
          alice,
          bob,
          charlie,
          referrer,
          getCreationFeeNative,
          defaultLaunchParams,
          zeroProtection,
          zeroTax,
        } = fixture;

        // referrer -> bob -> alice chain
        // First: bob creates with referrer as referral
        const fee0 = await getCreationFeeNative(0);
        await platformRouter.connect(bob).createTokenAndLaunch(
          {
            name: "BobToken",
            symbol: "BOB",
            totalSupply: 1000000,
            decimals: 18,
            isTaxable: false,
            isMintable: false,
            isPartner: false,
            paymentToken: ethers.ZeroAddress,
          },
          defaultLaunchParams,
          zeroProtection,
          zeroTax,
          referrer.address,
          { value: fee0 + ethers.parseEther("2") }
        );

        // Then: alice creates with bob as referral
        await platformRouter.connect(alice).createTokenAndLaunch(
          {
            name: "AliceToken",
            symbol: "ALI",
            totalSupply: 1000000,
            decimals: 18,
            isTaxable: false,
            isMintable: false,
            isPartner: false,
            paymentToken: ethers.ZeroAddress,
          },
          defaultLaunchParams,
          zeroProtection,
          zeroTax,
          bob.address,
          { value: fee0 + ethers.parseEther("2") }
        );

        const chain = await platformLens.getReferralChain(alice.address);
        expect(chain.length).to.equal(2);
        expect(chain[0]).to.equal(bob.address);
        expect(chain[1]).to.equal(referrer.address);
      });
    });

    // -----------------------------------------------------------------------
    // getReferralPercents
    // -----------------------------------------------------------------------
    describe("getReferralPercents", function () {
      it("returns all referral level percentages", async function () {
        const { platformLens } = await loadFixture(deployFullPlatform);
        const percents = await platformLens.getReferralPercents();
        // Default: 3 levels [500, 300, 200]
        expect(percents.length).to.equal(3);
        expect(percents[0]).to.equal(500);
        expect(percents[1]).to.equal(300);
        expect(percents[2]).to.equal(200);
      });
    });

    // -----------------------------------------------------------------------
    // getPlatformStats
    // -----------------------------------------------------------------------
    describe("getPlatformStats", function () {
      it("returns zeros when platform is fresh", async function () {
        const { platformLens } = await loadFixture(deployFullPlatform);
        const [totalTokens, totalLaunches, totalTokenFeeUsdt, totalLaunchFeeUsdt] =
          await platformLens.getPlatformStats();
        expect(totalTokens).to.equal(0);
        expect(totalLaunches).to.equal(0);
        expect(totalTokenFeeUsdt).to.equal(0);
        expect(totalLaunchFeeUsdt).to.equal(0);
      });

      it("returns aggregate stats after activity", async function () {
        const fixture = await loadFixture(deployFullPlatform);
        const { platformLens } = fixture;

        // Create one token+launch
        await createTokenAndLaunchHelper(fixture);

        const [totalTokens, totalLaunches, totalTokenFeeUsdt, totalLaunchFeeUsdt] =
          await platformLens.getPlatformStats();
        expect(totalTokens).to.equal(1);
        expect(totalLaunches).to.equal(1);
        // Fee should be > 0 since basic token costs 10 USDT
        expect(totalTokenFeeUsdt).to.be.greaterThan(0);
        // Launch fee was 0
        expect(totalLaunchFeeUsdt).to.equal(0);
      });

      it("reflects multiple tokens and launches", async function () {
        const fixture = await loadFixture(deployFullPlatform);
        const {
          platformRouter,
          platformLens,
          alice,
          bob,
          getCreationFeeNative,
          defaultLaunchParams,
          zeroProtection,
          zeroTax,
        } = fixture;

        // Create 2 tokens with different users
        for (const [i, signer] of [alice, bob].entries()) {
          const fee = await getCreationFeeNative(0);
          await platformRouter.connect(signer).createTokenAndLaunch(
            {
              name: `Token${i}`,
              symbol: `T${i}`,
              totalSupply: 1000000,
              decimals: 18,
              isTaxable: false,
              isMintable: false,
              isPartner: false,
              paymentToken: ethers.ZeroAddress,
            },
            defaultLaunchParams,
            zeroProtection,
            zeroTax,
            ethers.ZeroAddress,
            { value: fee + ethers.parseEther("2") }
          );
        }

        const [totalTokens, totalLaunches] =
          await platformLens.getPlatformStats();
        expect(totalTokens).to.equal(2);
        expect(totalLaunches).to.equal(2);
      });
    });
  });
});
