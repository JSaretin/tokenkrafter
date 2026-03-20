import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("TokenFactory", function () {
  // ================================================================
  // SHARED FIXTURE
  // ================================================================
  async function deployFixture() {
    const [owner, alice, bob, charlie, dave, eve, nonOwner] =
      await ethers.getSigners();

    // Deploy mocks
    const MockUSDT = await ethers.getContractFactory("MockUSDT");
    const usdt = await MockUSDT.deploy();

    const MockWETH = await ethers.getContractFactory("MockWETH");
    const weth = await MockWETH.deploy();

    const MockFactory = await ethers.getContractFactory(
      "MockUniswapV2Factory"
    );
    const dexFactory = await MockFactory.deploy();

    const MockRouter = await ethers.getContractFactory("MockUniswapV2Router");
    const dexRouter = await MockRouter.deploy(
      await weth.getAddress(),
      await dexFactory.getAddress()
    );

    // Set mock prices: 1 WETH = 2000 USDT (6 decimals)
    const ethPrice = BigInt(2000) * BigInt(1e6);
    await dexRouter.setMockPrice(
      await weth.getAddress(),
      await usdt.getAddress(),
      ethPrice
    );
    // reverse: 1e18 USDT units → WETH
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

    // Deploy all 8 token implementations
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
    const partnerTaxableMintableImpl =
      await PartnerTaxableMintableImpl.deploy();

    // Register all 8 implementations
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
      { libraries: { BondingCurve: await bondingCurve.getAddress() } }
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

    // Authorize router
    await tokenFactory.setAuthorizedRouter(
      await platformRouter.getAddress()
    );
    await launchpadFactory.setAuthorizedRouter(
      await platformRouter.getAddress()
    );

    // ── Helper functions ──

    /** Returns the native (ETH) fee for a given type key */
    async function getCreationFeeNative(typeKey: number): Promise<bigint> {
      const baseFee = await tokenFactory.creationFee(typeKey);
      return await tokenFactory.convertFee(baseFee, ethers.ZeroAddress);
    }

    /** Returns the USDT fee for a given type key */
    async function getCreationFeeUsdt(typeKey: number): Promise<bigint> {
      return await tokenFactory.creationFee(typeKey);
    }

    /** Default basic token params paying with native */
    function basicParams(paymentToken: string = ethers.ZeroAddress) {
      return {
        name: "TestToken",
        symbol: "TT",
        totalSupply: 1_000_000n,
        decimals: 18,
        isTaxable: false,
        isMintable: false,
        isPartner: false,
        paymentToken,
      };
    }

    /** Creates a token and returns its address from the event */
    async function createTokenAndGetAddress(
      signer: HardhatEthersSigner,
      params: any,
      referral: string = ethers.ZeroAddress,
      value?: bigint
    ): Promise<string> {
      const typeKey =
        (params.isPartner ? 4 : 0) |
        (params.isTaxable ? 2 : 0) |
        (params.isMintable ? 1 : 0);
      const fee = value ?? (await getCreationFeeNative(typeKey));
      const tx = await tokenFactory
        .connect(signer)
        .createToken(params, referral, { value: fee });
      const receipt = await tx.wait();
      const event = receipt!.logs.find((l: any) => {
        try {
          return (
            tokenFactory.interface.parseLog(l as any)?.name === "TokenCreated"
          );
        } catch {
          return false;
        }
      });
      const parsed = tokenFactory.interface.parseLog(event as any);
      return parsed!.args.tokenAddress;
    }

    return {
      owner,
      alice,
      bob,
      charlie,
      dave,
      eve,
      nonOwner,
      usdt,
      weth,
      dexFactory,
      dexRouter,
      tokenFactory,
      launchpadFactory,
      platformRouter,
      basicImpl,
      mintableImpl,
      taxableImpl,
      taxableMintableImpl,
      partnerImpl,
      partnerMintableImpl,
      partnerTaxableImpl,
      partnerTaxableMintableImpl,
      getCreationFeeNative,
      getCreationFeeUsdt,
      basicParams,
      createTokenAndGetAddress,
    };
  }

  // ================================================================
  // TOKEN CREATION - createToken
  // ================================================================
  describe("createToken", function () {
    it("should create a basic token with native payment and emit TokenCreated", async function () {
      const { tokenFactory, alice, basicParams, getCreationFeeNative } =
        await loadFixture(deployFixture);

      const params = basicParams();
      const fee = await getCreationFeeNative(0);

      const tx = await tokenFactory
        .connect(alice)
        .createToken(params, ethers.ZeroAddress, { value: fee });
      const receipt = await tx.wait();

      // Check event
      const event = receipt!.logs.find((l: any) => {
        try {
          return (
            tokenFactory.interface.parseLog(l as any)?.name === "TokenCreated"
          );
        } catch {
          return false;
        }
      });
      expect(event).to.not.be.undefined;
      const parsed = tokenFactory.interface.parseLog(event as any);
      expect(parsed!.args.creator).to.equal(alice.address);
      expect(parsed!.args.tokenType).to.equal(0);
      expect(parsed!.args.name).to.equal("TestToken");
      expect(parsed!.args.symbol).to.equal("TT");
      expect(parsed!.args.totalSupply).to.equal(1_000_000n);
      expect(parsed!.args.decimals).to.equal(18);
    });

    it("should charge creation fee and hold it in the factory", async function () {
      const { tokenFactory, alice, basicParams, getCreationFeeNative } =
        await loadFixture(deployFixture);

      const params = basicParams();
      const fee = await getCreationFeeNative(0);
      const factoryAddr = await tokenFactory.getAddress();

      const balBefore = await ethers.provider.getBalance(factoryAddr);
      await tokenFactory
        .connect(alice)
        .createToken(params, ethers.ZeroAddress, { value: fee });
      const balAfter = await ethers.provider.getBalance(factoryAddr);

      expect(balAfter - balBefore).to.equal(fee);
    });

    it("should record token in createdTokens and update stats", async function () {
      const {
        tokenFactory,
        alice,
        basicParams,
        createTokenAndGetAddress,
      } = await loadFixture(deployFixture);

      const params = basicParams();
      const tokenAddr = await createTokenAndGetAddress(alice, params);

      const createdTokens = await tokenFactory.getCreatedTokens(alice.address);
      expect(createdTokens).to.include(tokenAddr);
      expect(await tokenFactory.totalTokensCreated()).to.equal(1n);
      expect(await tokenFactory.tokensCreatedByType(0)).to.equal(1n);
    });

    it("should mint total supply to the creator", async function () {
      const { alice, basicParams, createTokenAndGetAddress } =
        await loadFixture(deployFixture);

      const params = basicParams();
      const tokenAddr = await createTokenAndGetAddress(alice, params);

      const token = await ethers.getContractAt("BasicTokenImpl", tokenAddr);
      const expectedSupply = 1_000_000n * 10n ** 18n;
      expect(await token.balanceOf(alice.address)).to.equal(expectedSupply);
    });

    it("should create a token paying with USDT", async function () {
      const {
        tokenFactory,
        alice,
        usdt,
        owner,
        getCreationFeeUsdt,
      } = await loadFixture(deployFixture);

      const usdtAddr = await usdt.getAddress();
      const params = {
        name: "UsdtToken",
        symbol: "UT",
        totalSupply: 500_000n,
        decimals: 18,
        isTaxable: false,
        isMintable: false,
        isPartner: false,
        paymentToken: usdtAddr,
      };

      const fee = await getCreationFeeUsdt(0);

      // Give alice USDT and approve
      await usdt.transfer(alice.address, fee);
      await usdt.connect(alice).approve(await tokenFactory.getAddress(), fee);

      const tx = await tokenFactory
        .connect(alice)
        .createToken(params, ethers.ZeroAddress);
      const receipt = await tx.wait();

      const event = receipt!.logs.find((l: any) => {
        try {
          return (
            tokenFactory.interface.parseLog(l as any)?.name === "TokenCreated"
          );
        } catch {
          return false;
        }
      });
      expect(event).to.not.be.undefined;
    });

    it("should refund excess native payment", async function () {
      const { tokenFactory, alice, basicParams, getCreationFeeNative } =
        await loadFixture(deployFixture);

      const params = basicParams();
      const fee = await getCreationFeeNative(0);
      const excess = ethers.parseEther("1");
      const sent = fee + excess;

      const balBefore = await ethers.provider.getBalance(alice.address);
      const tx = await tokenFactory
        .connect(alice)
        .createToken(params, ethers.ZeroAddress, { value: sent });
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
      const balAfter = await ethers.provider.getBalance(alice.address);

      // alice should have paid fee + gas, not fee + excess + gas
      const spent = balBefore - balAfter;
      expect(spent).to.equal(fee + gasUsed);
    });

    it("should revert with empty name", async function () {
      const { tokenFactory, alice, getCreationFeeNative } =
        await loadFixture(deployFixture);

      const params = {
        name: "",
        symbol: "TT",
        totalSupply: 1_000_000n,
        decimals: 18,
        isTaxable: false,
        isMintable: false,
        isPartner: false,
        paymentToken: ethers.ZeroAddress,
      };
      const fee = await getCreationFeeNative(0);

      await expect(
        tokenFactory
          .connect(alice)
          .createToken(params, ethers.ZeroAddress, { value: fee })
      ).to.be.revertedWithCustomError(tokenFactory, "InvalidParams");
    });

    it("should revert with empty symbol", async function () {
      const { tokenFactory, alice, getCreationFeeNative } =
        await loadFixture(deployFixture);

      const params = {
        name: "TestToken",
        symbol: "",
        totalSupply: 1_000_000n,
        decimals: 18,
        isTaxable: false,
        isMintable: false,
        isPartner: false,
        paymentToken: ethers.ZeroAddress,
      };
      const fee = await getCreationFeeNative(0);

      await expect(
        tokenFactory
          .connect(alice)
          .createToken(params, ethers.ZeroAddress, { value: fee })
      ).to.be.revertedWithCustomError(tokenFactory, "InvalidParams");
    });

    it("should revert with 0 totalSupply", async function () {
      const { tokenFactory, alice, getCreationFeeNative } =
        await loadFixture(deployFixture);

      const params = {
        name: "TestToken",
        symbol: "TT",
        totalSupply: 0n,
        decimals: 18,
        isTaxable: false,
        isMintable: false,
        isPartner: false,
        paymentToken: ethers.ZeroAddress,
      };
      const fee = await getCreationFeeNative(0);

      await expect(
        tokenFactory
          .connect(alice)
          .createToken(params, ethers.ZeroAddress, { value: fee })
      ).to.be.revertedWithCustomError(tokenFactory, "InvalidParams");
    });

    it("should revert with totalSupply > 1e30", async function () {
      const { tokenFactory, alice, getCreationFeeNative } =
        await loadFixture(deployFixture);

      const params = {
        name: "TestToken",
        symbol: "TT",
        totalSupply: 10n ** 30n + 1n,
        decimals: 18,
        isTaxable: false,
        isMintable: false,
        isPartner: false,
        paymentToken: ethers.ZeroAddress,
      };
      const fee = await getCreationFeeNative(0);

      await expect(
        tokenFactory
          .connect(alice)
          .createToken(params, ethers.ZeroAddress, { value: fee })
      ).to.be.revertedWithCustomError(tokenFactory, "InvalidParams");
    });

    it("should revert with decimals > 18", async function () {
      const { tokenFactory, alice, getCreationFeeNative } =
        await loadFixture(deployFixture);

      const params = {
        name: "TestToken",
        symbol: "TT",
        totalSupply: 1_000_000n,
        decimals: 19,
        isTaxable: false,
        isMintable: false,
        isPartner: false,
        paymentToken: ethers.ZeroAddress,
      };
      const fee = await getCreationFeeNative(0);

      await expect(
        tokenFactory
          .connect(alice)
          .createToken(params, ethers.ZeroAddress, { value: fee })
      ).to.be.revertedWithCustomError(tokenFactory, "InvalidParams");
    });

    it("should revert when implementation not set", async function () {
      const { tokenFactory, alice, usdt, dexRouter, getCreationFeeNative } =
        await loadFixture(deployFixture);

      // Deploy a fresh factory without implementations
      const TokenFactory = await ethers.getContractFactory(
        "contracts/TokenFactory.sol:TokenFactory"
      );
      const freshFactory = await TokenFactory.deploy(
        await usdt.getAddress(),
        await dexRouter.getAddress()
      );

      const params = {
        name: "TestToken",
        symbol: "TT",
        totalSupply: 1_000_000n,
        decimals: 18,
        isTaxable: false,
        isMintable: false,
        isPartner: false,
        paymentToken: ethers.ZeroAddress,
      };

      // Convert fee using the fresh factory (which has same fee schedule)
      const baseFee = await freshFactory.creationFee(0);
      const fee = await freshFactory.convertFee(baseFee, ethers.ZeroAddress);

      await expect(
        freshFactory
          .connect(alice)
          .createToken(params, ethers.ZeroAddress, { value: fee })
      ).to.be.revertedWithCustomError(freshFactory, "ImplementationNotSet");
    });

    it("should revert with unsupported payment token", async function () {
      const { tokenFactory, alice, getCreationFeeNative } =
        await loadFixture(deployFixture);

      // Use a random address as payment token
      const params = {
        name: "TestToken",
        symbol: "TT",
        totalSupply: 1_000_000n,
        decimals: 18,
        isTaxable: false,
        isMintable: false,
        isPartner: false,
        paymentToken: "0x0000000000000000000000000000000000000001",
      };

      await expect(
        tokenFactory
          .connect(alice)
          .createToken(params, ethers.ZeroAddress, { value: ethers.parseEther("1") })
      ).to.be.revertedWithCustomError(tokenFactory, "UnsupportedPaymentToken");
    });

    it("should revert with insufficient native payment", async function () {
      const { tokenFactory, alice, getCreationFeeNative } =
        await loadFixture(deployFixture);

      const params = {
        name: "TestToken",
        symbol: "TT",
        totalSupply: 1_000_000n,
        decimals: 18,
        isTaxable: false,
        isMintable: false,
        isPartner: false,
        paymentToken: ethers.ZeroAddress,
      };

      // Send 0 value — less than fee
      await expect(
        tokenFactory
          .connect(alice)
          .createToken(params, ethers.ZeroAddress, { value: 0n })
      ).to.be.revertedWithCustomError(tokenFactory, "InsufficientPayment");
    });

    it("should create all 8 token types", async function () {
      const { tokenFactory, alice, getCreationFeeNative } =
        await loadFixture(deployFixture);

      const combos = [
        { isTaxable: false, isMintable: false, isPartner: false }, // 0
        { isTaxable: false, isMintable: true, isPartner: false },  // 1
        { isTaxable: true, isMintable: false, isPartner: false },  // 2
        { isTaxable: true, isMintable: true, isPartner: false },   // 3
        { isTaxable: false, isMintable: false, isPartner: true },  // 4
        { isTaxable: false, isMintable: true, isPartner: true },   // 5
        { isTaxable: true, isMintable: false, isPartner: true },   // 6
        { isTaxable: true, isMintable: true, isPartner: true },    // 7
      ];

      for (let i = 0; i < combos.length; i++) {
        const combo = combos[i];
        const typeKey =
          (combo.isPartner ? 4 : 0) |
          (combo.isTaxable ? 2 : 0) |
          (combo.isMintable ? 1 : 0);
        const fee = await getCreationFeeNative(typeKey);

        const params = {
          name: `Token${i}`,
          symbol: `T${i}`,
          totalSupply: 1_000_000n,
          decimals: 18,
          ...combo,
          paymentToken: ethers.ZeroAddress,
        };

        await expect(
          tokenFactory
            .connect(alice)
            .createToken(params, ethers.ZeroAddress, { value: fee })
        ).to.not.be.reverted;
      }

      expect(await tokenFactory.totalTokensCreated()).to.equal(8n);
    });
  });

  // ================================================================
  // TOKEN CREATION - ownerCreateToken
  // ================================================================
  describe("ownerCreateToken", function () {
    it("should create a token on behalf of another address", async function () {
      const {
        tokenFactory,
        owner,
        alice,
        basicParams,
        getCreationFeeNative,
      } = await loadFixture(deployFixture);

      const params = basicParams();
      const fee = await getCreationFeeNative(0);

      const tx = await tokenFactory
        .connect(owner)
        .ownerCreateToken(alice.address, params, ethers.ZeroAddress, {
          value: fee,
        });
      const receipt = await tx.wait();

      const event = receipt!.logs.find((l: any) => {
        try {
          return (
            tokenFactory.interface.parseLog(l as any)?.name === "TokenCreated"
          );
        } catch {
          return false;
        }
      });
      const parsed = tokenFactory.interface.parseLog(event as any);
      expect(parsed!.args.creator).to.equal(alice.address);

      // Token supply goes to alice (the creator)
      const tokenAddr = parsed!.args.tokenAddress;
      const token = await ethers.getContractAt("BasicTokenImpl", tokenAddr);
      const expectedSupply = 1_000_000n * 10n ** 18n;
      expect(await token.balanceOf(alice.address)).to.equal(expectedSupply);

      // Recorded under alice
      const created = await tokenFactory.getCreatedTokens(alice.address);
      expect(created).to.include(tokenAddr);
    });

    it("should revert when called by non-owner", async function () {
      const { tokenFactory, alice, bob, basicParams, getCreationFeeNative } =
        await loadFixture(deployFixture);

      const params = basicParams();
      const fee = await getCreationFeeNative(0);

      await expect(
        tokenFactory
          .connect(alice)
          .ownerCreateToken(bob.address, params, ethers.ZeroAddress, {
            value: fee,
          })
      ).to.be.revertedWithCustomError(tokenFactory, "OwnableUnauthorizedAccount");
    });

    it("should revert with zero creator address", async function () {
      const { tokenFactory, owner, basicParams, getCreationFeeNative } =
        await loadFixture(deployFixture);

      const params = basicParams();
      const fee = await getCreationFeeNative(0);

      await expect(
        tokenFactory
          .connect(owner)
          .ownerCreateToken(ethers.ZeroAddress, params, ethers.ZeroAddress, {
            value: fee,
          })
      ).to.be.revertedWithCustomError(tokenFactory, "InvalidAddress");
    });
  });

  // ================================================================
  // TOKEN CREATION - routerCreateToken
  // ================================================================
  describe("routerCreateToken", function () {
    it("should revert when called by non-router", async function () {
      const { tokenFactory, alice, basicParams, getCreationFeeNative } =
        await loadFixture(deployFixture);

      const params = basicParams();
      const fee = await getCreationFeeNative(0);

      await expect(
        tokenFactory
          .connect(alice)
          .routerCreateToken(alice.address, params, ethers.ZeroAddress, {
            value: fee,
          })
      ).to.be.revertedWithCustomError(tokenFactory, "NotAuthorizedRouter");
    });

    it("should mint tokens to factory then transfer to router", async function () {
      const {
        tokenFactory,
        platformRouter,
        alice,
        usdt,
        getCreationFeeNative,
        launchpadFactory,
        dexRouter,
      } = await loadFixture(deployFixture);

      // We need to call via the platformRouter. To test routerCreateToken specifically,
      // we set alice as the authorized router and call directly.
      await tokenFactory.setAuthorizedRouter(alice.address);

      const params = {
        name: "RouterToken",
        symbol: "RT",
        totalSupply: 1_000_000n,
        decimals: 18,
        isTaxable: false,
        isMintable: false,
        isPartner: false,
        paymentToken: ethers.ZeroAddress,
      };

      const fee = await getCreationFeeNative(0);

      const tx = await tokenFactory
        .connect(alice)
        .routerCreateToken(alice.address, params, ethers.ZeroAddress, {
          value: fee,
        });
      const receipt = await tx.wait();

      const event = receipt!.logs.find((l: any) => {
        try {
          return (
            tokenFactory.interface.parseLog(l as any)?.name === "TokenCreated"
          );
        } catch {
          return false;
        }
      });
      const parsed = tokenFactory.interface.parseLog(event as any);
      const tokenAddr = parsed!.args.tokenAddress;

      // Tokens should be transferred to the router (alice in this case)
      const token = await ethers.getContractAt("BasicTokenImpl", tokenAddr);
      const expectedSupply = 1_000_000n * 10n ** 18n;
      expect(await token.balanceOf(alice.address)).to.equal(expectedSupply);

      // Factory should have 0 balance
      expect(
        await token.balanceOf(await tokenFactory.getAddress())
      ).to.equal(0n);
    });

    it("should transfer ownership to the router", async function () {
      const { tokenFactory, alice, getCreationFeeNative } =
        await loadFixture(deployFixture);

      await tokenFactory.setAuthorizedRouter(alice.address);

      const params = {
        name: "RouterToken",
        symbol: "RT",
        totalSupply: 1_000_000n,
        decimals: 18,
        isTaxable: false,
        isMintable: false,
        isPartner: false,
        paymentToken: ethers.ZeroAddress,
      };

      const fee = await getCreationFeeNative(0);

      const tx = await tokenFactory
        .connect(alice)
        .routerCreateToken(alice.address, params, ethers.ZeroAddress, {
          value: fee,
        });
      const receipt = await tx.wait();

      const event = receipt!.logs.find((l: any) => {
        try {
          return (
            tokenFactory.interface.parseLog(l as any)?.name === "TokenCreated"
          );
        } catch {
          return false;
        }
      });
      const parsed = tokenFactory.interface.parseLog(event as any);
      const tokenAddr = parsed!.args.tokenAddress;

      const token = await ethers.getContractAt("BasicTokenImpl", tokenAddr);
      // Ownership transferred to the router (alice)
      expect(await token.owner()).to.equal(alice.address);
    });
  });

  // ================================================================
  // TAX PROCESSING - processTax
  // ================================================================
  describe("processTax", function () {
    it("should revert when called by non-owner on non-factory token", async function () {
      const { tokenFactory, alice } = await loadFixture(deployFixture);

      // alice is not the owner, and the address is not a factory token calling itself
      await expect(
        tokenFactory
          .connect(alice)
          .processTax("0x0000000000000000000000000000000000000001")
      ).to.be.revertedWithCustomError(tokenFactory, "NotFactoryToken");
    });

    it("should not revert when owner calls on non-factory token (owner bypass)", async function () {
      const { tokenFactory, owner, usdt } = await loadFixture(deployFixture);

      // Owner can call processTax on any address — the check only blocks non-owners.
      // convertTaxToStable is false so it returns early (no-op).
      await expect(
        tokenFactory
          .connect(owner)
          .processTax("0x0000000000000000000000000000000000000001")
      ).to.not.be.reverted;
    });

    it("should be a no-op when convertTaxToStable is false", async function () {
      const {
        tokenFactory,
        owner,
        alice,
        createTokenAndGetAddress,
        basicParams,
      } = await loadFixture(deployFixture);

      const params = basicParams();
      const tokenAddr = await createTokenAndGetAddress(alice, params);

      // convertTaxToStable defaults to false
      expect(await tokenFactory.convertTaxToStable()).to.equal(false);

      // Should not revert, just no-op
      await expect(
        tokenFactory.connect(owner).processTax(tokenAddr)
      ).to.not.be.reverted;
    });

    it("should be a no-op when token is USDT (owner can call on any address)", async function () {
      const { tokenFactory, owner, usdt } = await loadFixture(deployFixture);

      // Enable convert
      await tokenFactory.setConvertTaxToStable(true);

      // Owner bypasses the factory-token check. When token == usdt, the function
      // returns early (no-op) after the usdt check.
      await expect(
        tokenFactory.connect(owner).processTax(await usdt.getAddress())
      ).to.not.be.reverted;
    });

    it("should be a no-op when factory holds 0 balance of the token", async function () {
      const {
        tokenFactory,
        owner,
        alice,
        createTokenAndGetAddress,
        basicParams,
      } = await loadFixture(deployFixture);

      await tokenFactory.setConvertTaxToStable(true);

      const params = basicParams();
      const tokenAddr = await createTokenAndGetAddress(alice, params);

      // Factory holds 0 of this token (all minted to alice)
      await expect(
        tokenFactory.connect(owner).processTax(tokenAddr)
      ).to.not.be.reverted;
    });

    it("should revert when called by unauthorized address", async function () {
      const {
        tokenFactory,
        alice,
        bob,
        createTokenAndGetAddress,
        basicParams,
      } = await loadFixture(deployFixture);

      const params = basicParams();
      const tokenAddr = await createTokenAndGetAddress(alice, params);

      // bob is neither owner nor the token itself
      await expect(
        tokenFactory.connect(bob).processTax(tokenAddr)
      ).to.be.revertedWithCustomError(tokenFactory, "NotFactoryToken");
    });
  });

  // ================================================================
  // REFERRAL SYSTEM - claimReward
  // ================================================================
  describe("claimReward", function () {
    it("should revert when no rewards pending", async function () {
      const { tokenFactory, alice } = await loadFixture(deployFixture);

      await expect(
        tokenFactory.connect(alice).claimReward(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(tokenFactory, "NoRewards");
    });

    it("should claim pending native rewards when autoDistribute is off", async function () {
      const {
        tokenFactory,
        alice,
        bob,
        charlie,
        basicParams,
        getCreationFeeNative,
      } = await loadFixture(deployFixture);

      // Disable auto-distribute so rewards accumulate
      await tokenFactory.setAutoDistributeReward(false);

      const params = basicParams();
      const fee = await getCreationFeeNative(0);

      // bob creates token with alice as referral
      await tokenFactory
        .connect(bob)
        .createToken(params, alice.address, { value: fee });

      // alice should have pending rewards
      const pending = await tokenFactory.pendingRewards(
        alice.address,
        ethers.ZeroAddress
      );
      expect(pending).to.be.gt(0n);

      // Claim
      const balBefore = await ethers.provider.getBalance(alice.address);
      const tx = await tokenFactory
        .connect(alice)
        .claimReward(ethers.ZeroAddress);
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
      const balAfter = await ethers.provider.getBalance(alice.address);

      expect(balAfter - balBefore + gasUsed).to.equal(pending);

      // Pending should be 0 after claim
      expect(
        await tokenFactory.pendingRewards(alice.address, ethers.ZeroAddress)
      ).to.equal(0n);
    });

    it("should claim pending ERC20 rewards when autoDistribute is off", async function () {
      const {
        tokenFactory,
        owner,
        alice,
        bob,
        usdt,
        getCreationFeeUsdt,
      } = await loadFixture(deployFixture);

      await tokenFactory.setAutoDistributeReward(false);

      const usdtAddr = await usdt.getAddress();
      const params = {
        name: "TestToken",
        symbol: "TT",
        totalSupply: 1_000_000n,
        decimals: 18,
        isTaxable: false,
        isMintable: false,
        isPartner: false,
        paymentToken: usdtAddr,
      };

      const fee = await getCreationFeeUsdt(0);

      // Give bob USDT and approve
      await usdt.transfer(bob.address, fee);
      await usdt.connect(bob).approve(await tokenFactory.getAddress(), fee);

      // bob creates token with alice as referral
      await tokenFactory
        .connect(bob)
        .createToken(params, alice.address);

      // alice should have pending USDT rewards
      const pending = await tokenFactory.pendingRewards(
        alice.address,
        usdtAddr
      );
      expect(pending).to.be.gt(0n);

      const usdtBalBefore = await usdt.balanceOf(alice.address);
      await tokenFactory.connect(alice).claimReward(usdtAddr);
      const usdtBalAfter = await usdt.balanceOf(alice.address);

      expect(usdtBalAfter - usdtBalBefore).to.equal(pending);
    });

    it("should emit ReferralRewardClaimed event", async function () {
      const {
        tokenFactory,
        alice,
        bob,
        basicParams,
        getCreationFeeNative,
      } = await loadFixture(deployFixture);

      await tokenFactory.setAutoDistributeReward(false);

      const params = basicParams();
      const fee = await getCreationFeeNative(0);

      await tokenFactory
        .connect(bob)
        .createToken(params, alice.address, { value: fee });

      const pending = await tokenFactory.pendingRewards(
        alice.address,
        ethers.ZeroAddress
      );

      await expect(
        tokenFactory.connect(alice).claimReward(ethers.ZeroAddress)
      )
        .to.emit(tokenFactory, "ReferralRewardClaimed")
        .withArgs(alice.address, ethers.ZeroAddress, pending);
    });
  });

  // ================================================================
  // REFERRAL SYSTEM - recording & circular detection
  // ================================================================
  describe("Referral recording and circular detection", function () {
    it("should record referral relationship on first token creation", async function () {
      const {
        tokenFactory,
        alice,
        bob,
        basicParams,
        getCreationFeeNative,
      } = await loadFixture(deployFixture);

      const params = basicParams();
      const fee = await getCreationFeeNative(0);

      await tokenFactory
        .connect(bob)
        .createToken(params, alice.address, { value: fee });

      expect(await tokenFactory.referrals(bob.address)).to.equal(
        alice.address
      );
      expect(await tokenFactory.totalReferred(alice.address)).to.equal(1n);
    });

    it("should not overwrite existing referral", async function () {
      const {
        tokenFactory,
        alice,
        bob,
        charlie,
        basicParams,
        getCreationFeeNative,
      } = await loadFixture(deployFixture);

      const params = basicParams();
      const fee = await getCreationFeeNative(0);

      // First creation with alice as referral
      await tokenFactory
        .connect(bob)
        .createToken(params, alice.address, { value: fee });

      expect(await tokenFactory.referrals(bob.address)).to.equal(
        alice.address
      );

      // Second creation with charlie as referral — should keep alice
      const params2 = {
        ...params,
        name: "Token2",
        symbol: "T2",
      };
      await tokenFactory
        .connect(bob)
        .createToken(params2, charlie.address, { value: fee });

      expect(await tokenFactory.referrals(bob.address)).to.equal(
        alice.address
      );
    });

    it("should detect circular referral and revert", async function () {
      const {
        tokenFactory,
        alice,
        bob,
        basicParams,
        getCreationFeeNative,
      } = await loadFixture(deployFixture);

      const params = basicParams();
      const fee = await getCreationFeeNative(0);

      // alice creates with bob as referral
      await tokenFactory
        .connect(alice)
        .createToken(params, bob.address, { value: fee });

      // bob tries to create with alice as referral — circular
      const params2 = {
        ...params,
        name: "Token2",
        symbol: "T2",
      };
      await expect(
        tokenFactory
          .connect(bob)
          .createToken(params2, alice.address, { value: fee })
      ).to.be.revertedWithCustomError(tokenFactory, "CircularReferral");
    });

    it("should distribute multi-level referral rewards", async function () {
      const {
        tokenFactory,
        alice,
        bob,
        charlie,
        dave,
        basicParams,
        getCreationFeeNative,
      } = await loadFixture(deployFixture);

      const params = basicParams();
      const fee = await getCreationFeeNative(0);

      // Build referral chain: alice <- bob <- charlie <- dave
      // alice creates (no referral)
      await tokenFactory
        .connect(alice)
        .createToken(params, ethers.ZeroAddress, { value: fee });

      // bob creates with alice as referral
      const params2 = { ...params, name: "T2", symbol: "T2" };
      await tokenFactory
        .connect(bob)
        .createToken(params2, alice.address, { value: fee });

      // charlie creates with bob as referral
      const params3 = { ...params, name: "T3", symbol: "T3" };
      await tokenFactory
        .connect(charlie)
        .createToken(params3, bob.address, { value: fee });

      // dave creates with charlie as referral — triggers 3-level rewards
      const params4 = { ...params, name: "T4", symbol: "T4" };
      const balAliceBefore = await ethers.provider.getBalance(alice.address);
      const balBobBefore = await ethers.provider.getBalance(bob.address);
      const balCharlieBefore = await ethers.provider.getBalance(
        charlie.address
      );

      await tokenFactory
        .connect(dave)
        .createToken(params4, charlie.address, { value: fee });

      // Level 0 (5%): charlie, Level 1 (3%): bob, Level 2 (2%): alice
      const reward0 = (fee * 500n) / 10000n;
      const reward1 = (fee * 300n) / 10000n;
      const reward2 = (fee * 200n) / 10000n;

      const balCharlieAfter = await ethers.provider.getBalance(
        charlie.address
      );
      const balBobAfter = await ethers.provider.getBalance(bob.address);
      const balAliceAfter = await ethers.provider.getBalance(alice.address);

      // autoDistributeReward is on by default, so rewards sent immediately
      expect(balCharlieAfter - balCharlieBefore).to.equal(reward0);
      expect(balBobAfter - balBobBefore).to.equal(reward1);
      expect(balAliceAfter - balAliceBefore).to.equal(reward2);
    });

    it("should ignore self-referral", async function () {
      const {
        tokenFactory,
        alice,
        basicParams,
        getCreationFeeNative,
      } = await loadFixture(deployFixture);

      const params = basicParams();
      const fee = await getCreationFeeNative(0);

      // alice refers herself — should be ignored (no revert)
      await expect(
        tokenFactory
          .connect(alice)
          .createToken(params, alice.address, { value: fee })
      ).to.not.be.reverted;

      expect(await tokenFactory.referrals(alice.address)).to.equal(
        ethers.ZeroAddress
      );
    });
  });

  // ================================================================
  // VIEW FUNCTIONS
  // ================================================================
  describe("View functions", function () {
    describe("getCreatedTokens", function () {
      it("should return empty array for creator with no tokens", async function () {
        const { tokenFactory, alice } = await loadFixture(deployFixture);
        const tokens = await tokenFactory.getCreatedTokens(alice.address);
        expect(tokens.length).to.equal(0);
      });

      it("should return all tokens created by a creator", async function () {
        const {
          tokenFactory,
          alice,
          basicParams,
          createTokenAndGetAddress,
        } = await loadFixture(deployFixture);

        const params = basicParams();
        const addr1 = await createTokenAndGetAddress(alice, params);

        const params2 = { ...params, name: "Token2", symbol: "T2" };
        const addr2 = await createTokenAndGetAddress(alice, params2);

        const tokens = await tokenFactory.getCreatedTokens(alice.address);
        expect(tokens.length).to.equal(2);
        expect(tokens).to.include(addr1);
        expect(tokens).to.include(addr2);
      });
    });

    describe("getSupportedPaymentTokens", function () {
      it("should return USDT and native by default", async function () {
        const { tokenFactory, usdt } = await loadFixture(deployFixture);
        const tokens = await tokenFactory.getSupportedPaymentTokens();
        expect(tokens.length).to.equal(2);
        expect(tokens).to.include(await usdt.getAddress());
        expect(tokens).to.include(ethers.ZeroAddress);
      });
    });

    describe("convertFee", function () {
      it("should return the USDT amount directly for USDT payment", async function () {
        const { tokenFactory, usdt } = await loadFixture(deployFixture);
        const usdtAddr = await usdt.getAddress();
        const result = await tokenFactory.convertFee(
          10_000_000n,
          usdtAddr
        );
        expect(result).to.equal(10_000_000n);
      });

      it("should convert USDT fee to native equivalent", async function () {
        const { tokenFactory } = await loadFixture(deployFixture);
        // 10 USDT = 10_000_000 (6 dec), ETH price 2000 USDT
        // 10 USDT / 2000 USDT/ETH = 0.005 ETH = 5e15 wei
        const result = await tokenFactory.convertFee(
          10_000_000n,
          ethers.ZeroAddress
        );
        expect(result).to.equal(5_000_000_000_000_000n); // 5e15
      });

      it("should return 0 for zero amount", async function () {
        const { tokenFactory } = await loadFixture(deployFixture);
        const result = await tokenFactory.convertFee(0n, ethers.ZeroAddress);
        expect(result).to.equal(0n);
      });
    });

    describe("predictTokenAddress", function () {
      it("should predict the correct address for next token", async function () {
        const {
          tokenFactory,
          alice,
          basicParams,
          getCreationFeeNative,
        } = await loadFixture(deployFixture);

        const predicted = await tokenFactory.predictTokenAddress(
          alice.address,
          false,
          false,
          false
        );

        const params = basicParams();
        const fee = await getCreationFeeNative(0);
        const tx = await tokenFactory
          .connect(alice)
          .createToken(params, ethers.ZeroAddress, { value: fee });
        const receipt = await tx.wait();

        const event = receipt!.logs.find((l: any) => {
          try {
            return (
              tokenFactory.interface.parseLog(l as any)?.name ===
              "TokenCreated"
            );
          } catch {
            return false;
          }
        });
        const parsed = tokenFactory.interface.parseLog(event as any);
        expect(parsed!.args.tokenAddress).to.equal(predicted);
      });

      it("should revert when implementation not set", async function () {
        const { usdt, dexRouter } = await loadFixture(deployFixture);

        const TokenFactory = await ethers.getContractFactory(
          "contracts/TokenFactory.sol:TokenFactory"
        );
        const freshFactory = await TokenFactory.deploy(
          await usdt.getAddress(),
          await dexRouter.getAddress()
        );

        await expect(
          freshFactory.predictTokenAddress(
            ethers.ZeroAddress,
            false,
            false,
            false
          )
        ).to.be.revertedWithCustomError(freshFactory, "ImplementationNotSet");
      });
    });
  });

  // ================================================================
  // ADMIN FUNCTIONS
  // ================================================================
  describe("Admin functions", function () {
    describe("setImplementation", function () {
      it("should set implementation for valid type", async function () {
        const { tokenFactory, basicImpl } = await loadFixture(deployFixture);
        const implAddr = await basicImpl.getAddress();

        await expect(tokenFactory.setImplementation(0, implAddr))
          .to.emit(tokenFactory, "ImplementationUpdated")
          .withArgs(0, implAddr);

        expect(await tokenFactory.implementations(0)).to.equal(implAddr);
      });

      it("should revert for type > 7", async function () {
        const { tokenFactory, basicImpl } = await loadFixture(deployFixture);
        await expect(
          tokenFactory.setImplementation(8, await basicImpl.getAddress())
        ).to.be.revertedWithCustomError(tokenFactory, "InvalidTokenType");
      });

      it("should revert for zero address implementation", async function () {
        const { tokenFactory } = await loadFixture(deployFixture);
        await expect(
          tokenFactory.setImplementation(0, ethers.ZeroAddress)
        ).to.be.revertedWithCustomError(tokenFactory, "InvalidAddress");
      });

      it("should revert when called by non-owner", async function () {
        const { tokenFactory, alice, basicImpl } =
          await loadFixture(deployFixture);
        await expect(
          tokenFactory
            .connect(alice)
            .setImplementation(0, await basicImpl.getAddress())
        ).to.be.revertedWithCustomError(tokenFactory, "OwnableUnauthorizedAccount");
      });
    });

    describe("setCreationFee", function () {
      it("should update fee for valid type", async function () {
        const { tokenFactory } = await loadFixture(deployFixture);
        await tokenFactory.setCreationFee(0, 50_000_000n);
        expect(await tokenFactory.creationFee(0)).to.equal(50_000_000n);
      });

      it("should revert for type > 7", async function () {
        const { tokenFactory } = await loadFixture(deployFixture);
        await expect(
          tokenFactory.setCreationFee(8, 50_000_000n)
        ).to.be.revertedWithCustomError(tokenFactory, "InvalidTokenType");
      });

      it("should revert when called by non-owner", async function () {
        const { tokenFactory, alice } = await loadFixture(deployFixture);
        await expect(
          tokenFactory.connect(alice).setCreationFee(0, 50_000_000n)
        ).to.be.revertedWithCustomError(tokenFactory, "OwnableUnauthorizedAccount");
      });
    });

    describe("setConvertTaxToStable", function () {
      it("should toggle and emit event", async function () {
        const { tokenFactory } = await loadFixture(deployFixture);

        await expect(tokenFactory.setConvertTaxToStable(true))
          .to.emit(tokenFactory, "ConvertTaxToStableUpdated")
          .withArgs(true);
        expect(await tokenFactory.convertTaxToStable()).to.equal(true);

        await expect(tokenFactory.setConvertTaxToStable(false))
          .to.emit(tokenFactory, "ConvertTaxToStableUpdated")
          .withArgs(false);
        expect(await tokenFactory.convertTaxToStable()).to.equal(false);
      });

      it("should revert when called by non-owner", async function () {
        const { tokenFactory, alice } = await loadFixture(deployFixture);
        await expect(
          tokenFactory.connect(alice).setConvertTaxToStable(true)
        ).to.be.revertedWithCustomError(tokenFactory, "OwnableUnauthorizedAccount");
      });
    });

    describe("setTaxSlippage", function () {
      it("should set valid slippage", async function () {
        const { tokenFactory } = await loadFixture(deployFixture);
        await tokenFactory.setTaxSlippage(1000);
        expect(await tokenFactory.taxSlippageBps()).to.equal(1000n);
      });

      it("should allow max 5000", async function () {
        const { tokenFactory } = await loadFixture(deployFixture);
        await tokenFactory.setTaxSlippage(5000);
        expect(await tokenFactory.taxSlippageBps()).to.equal(5000n);
      });

      it("should revert if > 5000", async function () {
        const { tokenFactory } = await loadFixture(deployFixture);
        await expect(
          tokenFactory.setTaxSlippage(5001)
        ).to.be.revertedWithCustomError(tokenFactory, "TotalExceedsMax");
      });

      it("should revert when called by non-owner", async function () {
        const { tokenFactory, alice } = await loadFixture(deployFixture);
        await expect(
          tokenFactory.connect(alice).setTaxSlippage(1000)
        ).to.be.revertedWithCustomError(tokenFactory, "OwnableUnauthorizedAccount");
      });
    });

    describe("setDexRouter", function () {
      it("should update dex router", async function () {
        const { tokenFactory, alice } = await loadFixture(deployFixture);
        await tokenFactory.setDexRouter(alice.address);
        expect(await tokenFactory.dexRouter()).to.equal(alice.address);
      });

      it("should revert for zero address", async function () {
        const { tokenFactory } = await loadFixture(deployFixture);
        await expect(
          tokenFactory.setDexRouter(ethers.ZeroAddress)
        ).to.be.revertedWithCustomError(tokenFactory, "InvalidAddress");
      });

      it("should revert when called by non-owner", async function () {
        const { tokenFactory, alice } = await loadFixture(deployFixture);
        await expect(
          tokenFactory.connect(alice).setDexRouter(alice.address)
        ).to.be.revertedWithCustomError(tokenFactory, "OwnableUnauthorizedAccount");
      });
    });

    describe("setUsdt", function () {
      it("should update USDT address", async function () {
        const { tokenFactory, alice } = await loadFixture(deployFixture);
        await tokenFactory.setUsdt(alice.address);
        expect(await tokenFactory.usdt()).to.equal(alice.address);
      });

      it("should revert for zero address", async function () {
        const { tokenFactory } = await loadFixture(deployFixture);
        await expect(
          tokenFactory.setUsdt(ethers.ZeroAddress)
        ).to.be.revertedWithCustomError(tokenFactory, "InvalidAddress");
      });

      it("should revert when called by non-owner", async function () {
        const { tokenFactory, alice } = await loadFixture(deployFixture);
        await expect(
          tokenFactory.connect(alice).setUsdt(alice.address)
        ).to.be.revertedWithCustomError(tokenFactory, "OwnableUnauthorizedAccount");
      });
    });

    describe("addPaymentToken", function () {
      it("should add a new payment token", async function () {
        const { tokenFactory, weth } = await loadFixture(deployFixture);
        const wethAddr = await weth.getAddress();

        await expect(tokenFactory.addPaymentToken(wethAddr))
          .to.emit(tokenFactory, "PaymentTokenAdded")
          .withArgs(wethAddr);

        expect(await tokenFactory.isPaymentSupported(wethAddr)).to.equal(
          true
        );
        const tokens = await tokenFactory.getSupportedPaymentTokens();
        expect(tokens).to.include(wethAddr);
      });

      it("should revert if already supported", async function () {
        const { tokenFactory, usdt } = await loadFixture(deployFixture);
        await expect(
          tokenFactory.addPaymentToken(await usdt.getAddress())
        ).to.be.revertedWithCustomError(tokenFactory, "AlreadySupported");
      });

      it("should revert when called by non-owner", async function () {
        const { tokenFactory, alice, weth } =
          await loadFixture(deployFixture);
        await expect(
          tokenFactory
            .connect(alice)
            .addPaymentToken(await weth.getAddress())
        ).to.be.revertedWithCustomError(tokenFactory, "OwnableUnauthorizedAccount");
      });
    });

    describe("removePaymentToken", function () {
      it("should remove a supported payment token", async function () {
        const { tokenFactory, usdt } = await loadFixture(deployFixture);
        const usdtAddr = await usdt.getAddress();

        await expect(tokenFactory.removePaymentToken(usdtAddr))
          .to.emit(tokenFactory, "PaymentTokenRemoved")
          .withArgs(usdtAddr);

        expect(await tokenFactory.isPaymentSupported(usdtAddr)).to.equal(
          false
        );
        const tokens = await tokenFactory.getSupportedPaymentTokens();
        expect(tokens).to.not.include(usdtAddr);
      });

      it("should revert if not supported", async function () {
        const { tokenFactory, weth } = await loadFixture(deployFixture);
        await expect(
          tokenFactory.removePaymentToken(await weth.getAddress())
        ).to.be.revertedWithCustomError(tokenFactory, "NotSupported");
      });

      it("should revert when called by non-owner", async function () {
        const { tokenFactory, alice, usdt } =
          await loadFixture(deployFixture);
        await expect(
          tokenFactory
            .connect(alice)
            .removePaymentToken(await usdt.getAddress())
        ).to.be.revertedWithCustomError(tokenFactory, "OwnableUnauthorizedAccount");
      });
    });

    describe("setReferralLevels", function () {
      it("should set referral levels up to 10", async function () {
        const { tokenFactory } = await loadFixture(deployFixture);
        await tokenFactory.setReferralLevels(5);
        expect(await tokenFactory.referralLevels()).to.equal(5);

        await tokenFactory.setReferralLevels(10);
        expect(await tokenFactory.referralLevels()).to.equal(10);
      });

      it("should revert if > 10", async function () {
        const { tokenFactory } = await loadFixture(deployFixture);
        await expect(
          tokenFactory.setReferralLevels(11)
        ).to.be.revertedWithCustomError(tokenFactory, "MaxLevelsExceeded");
      });

      it("should revert when called by non-owner", async function () {
        const { tokenFactory, alice } = await loadFixture(deployFixture);
        await expect(
          tokenFactory.connect(alice).setReferralLevels(5)
        ).to.be.revertedWithCustomError(tokenFactory, "OwnableUnauthorizedAccount");
      });
    });

    describe("setReferralPercents", function () {
      it("should set referral percents", async function () {
        const { tokenFactory } = await loadFixture(deployFixture);
        await tokenFactory.setReferralPercents([1000, 500, 250]);
        expect(await tokenFactory.referralPercents(0)).to.equal(1000n);
        expect(await tokenFactory.referralPercents(1)).to.equal(500n);
        expect(await tokenFactory.referralPercents(2)).to.equal(250n);
      });

      it("should allow total up to 5000", async function () {
        const { tokenFactory } = await loadFixture(deployFixture);
        await tokenFactory.setReferralPercents([5000]);
        expect(await tokenFactory.referralPercents(0)).to.equal(5000n);
      });

      it("should revert if total > 5000", async function () {
        const { tokenFactory } = await loadFixture(deployFixture);
        await expect(
          tokenFactory.setReferralPercents([3000, 2001])
        ).to.be.revertedWithCustomError(tokenFactory, "TotalExceedsMax");
      });

      it("should revert when called by non-owner", async function () {
        const { tokenFactory, alice } = await loadFixture(deployFixture);
        await expect(
          tokenFactory.connect(alice).setReferralPercents([500])
        ).to.be.revertedWithCustomError(tokenFactory, "OwnableUnauthorizedAccount");
      });
    });

    describe("setAutoDistributeReward", function () {
      it("should toggle auto distribute", async function () {
        const { tokenFactory } = await loadFixture(deployFixture);
        expect(await tokenFactory.autoDistributeReward()).to.equal(true);

        await tokenFactory.setAutoDistributeReward(false);
        expect(await tokenFactory.autoDistributeReward()).to.equal(false);

        await tokenFactory.setAutoDistributeReward(true);
        expect(await tokenFactory.autoDistributeReward()).to.equal(true);
      });

      it("should revert when called by non-owner", async function () {
        const { tokenFactory, alice } = await loadFixture(deployFixture);
        await expect(
          tokenFactory.connect(alice).setAutoDistributeReward(false)
        ).to.be.revertedWithCustomError(tokenFactory, "OwnableUnauthorizedAccount");
      });
    });

    describe("withdrawFees", function () {
      it("should withdraw native fees respecting reserved rewards", async function () {
        const {
          tokenFactory,
          owner,
          alice,
          bob,
          basicParams,
          getCreationFeeNative,
        } = await loadFixture(deployFixture);

        // Disable auto-distribute so rewards accumulate as pending
        await tokenFactory.setAutoDistributeReward(false);

        const params = basicParams();
        const fee = await getCreationFeeNative(0);

        // bob creates with alice as referral
        await tokenFactory
          .connect(bob)
          .createToken(params, alice.address, { value: fee });

        const reserved = await tokenFactory.totalPendingRewards(
          ethers.ZeroAddress
        );
        expect(reserved).to.be.gt(0n);

        const factoryBal = await ethers.provider.getBalance(
          await tokenFactory.getAddress()
        );
        const withdrawable = factoryBal - reserved;

        const ownerBalBefore = await ethers.provider.getBalance(owner.address);
        const tx = await tokenFactory.withdrawFees(ethers.ZeroAddress);
        const receipt = await tx.wait();
        const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
        const ownerBalAfter = await ethers.provider.getBalance(owner.address);

        expect(ownerBalAfter - ownerBalBefore + gasUsed).to.equal(
          withdrawable
        );
      });

      it("should withdraw ERC20 fees", async function () {
        const {
          tokenFactory,
          owner,
          alice,
          bob,
          usdt,
          getCreationFeeUsdt,
        } = await loadFixture(deployFixture);

        const usdtAddr = await usdt.getAddress();
        const params = {
          name: "TestToken",
          symbol: "TT",
          totalSupply: 1_000_000n,
          decimals: 18,
          isTaxable: false,
          isMintable: false,
          isPartner: false,
          paymentToken: usdtAddr,
        };

        const fee = await getCreationFeeUsdt(0);
        await usdt.transfer(bob.address, fee);
        await usdt
          .connect(bob)
          .approve(await tokenFactory.getAddress(), fee);

        await tokenFactory
          .connect(bob)
          .createToken(params, ethers.ZeroAddress);

        const ownerUsdtBefore = await usdt.balanceOf(owner.address);
        await tokenFactory.withdrawFees(usdtAddr);
        const ownerUsdtAfter = await usdt.balanceOf(owner.address);

        expect(ownerUsdtAfter - ownerUsdtBefore).to.equal(fee);
      });

      it("should revert with NoBalance when nothing to withdraw", async function () {
        const { tokenFactory } = await loadFixture(deployFixture);

        await expect(
          tokenFactory.withdrawFees(ethers.ZeroAddress)
        ).to.be.revertedWithCustomError(tokenFactory, "NoBalance");
      });

      it("should revert when called by non-owner", async function () {
        const { tokenFactory, alice } = await loadFixture(deployFixture);
        await expect(
          tokenFactory.connect(alice).withdrawFees(ethers.ZeroAddress)
        ).to.be.revertedWithCustomError(tokenFactory, "OwnableUnauthorizedAccount");
      });
    });

    describe("setAuthorizedRouter", function () {
      it("should set authorized router", async function () {
        const { tokenFactory, alice } = await loadFixture(deployFixture);
        await tokenFactory.setAuthorizedRouter(alice.address);
        expect(await tokenFactory.authorizedRouter()).to.equal(alice.address);
      });

      it("should allow setting to zero address (disabling)", async function () {
        const { tokenFactory } = await loadFixture(deployFixture);
        await tokenFactory.setAuthorizedRouter(ethers.ZeroAddress);
        expect(await tokenFactory.authorizedRouter()).to.equal(
          ethers.ZeroAddress
        );
      });

      it("should revert when called by non-owner", async function () {
        const { tokenFactory, alice } = await loadFixture(deployFixture);
        await expect(
          tokenFactory.connect(alice).setAuthorizedRouter(alice.address)
        ).to.be.revertedWithCustomError(tokenFactory, "OwnableUnauthorizedAccount");
      });
    });
  });

  // ================================================================
  // FACTORY OVERRIDE FUNCTIONS
  // ================================================================
  describe("Factory override functions", function () {
    /** Helper: create a basic token and return its address */
    async function createBasicToken(fixture: any): Promise<string> {
      const { alice, basicParams, createTokenAndGetAddress } = fixture;
      return createTokenAndGetAddress(alice, basicParams());
    }

    describe("forceUnblacklist", function () {
      it("should unblacklist an account on a factory token", async function () {
        const fixture = await loadFixture(deployFixture);
        const { tokenFactory, owner, alice, bob } = fixture;

        const tokenAddr = await createBasicToken(fixture);
        const token = await ethers.getContractAt(
          "BasicTokenImpl",
          tokenAddr
        );

        // alice (token owner) sets up blacklist window and blacklists bob
        await token.connect(alice).setBlacklistWindow(3600);
        await token.connect(alice).enableTrading();
        await token.connect(alice).setBlacklisted(bob.address, true);

        expect(await token.blacklisted(bob.address)).to.equal(true);

        // Factory owner force-unblacklists
        await tokenFactory.forceUnblacklist(tokenAddr, bob.address);
        expect(await token.blacklisted(bob.address)).to.equal(false);
      });

      it("should revert for non-factory token", async function () {
        const { tokenFactory, alice } = await loadFixture(deployFixture);
        await expect(
          tokenFactory.forceUnblacklist(
            "0x0000000000000000000000000000000000000001",
            alice.address
          )
        ).to.be.revertedWithCustomError(tokenFactory, "NotFactoryToken");
      });

      it("should revert when called by non-owner", async function () {
        const fixture = await loadFixture(deployFixture);
        const { tokenFactory, alice, bob } = fixture;
        const tokenAddr = await createBasicToken(fixture);

        await expect(
          tokenFactory
            .connect(alice)
            .forceUnblacklist(tokenAddr, bob.address)
        ).to.be.revertedWithCustomError(tokenFactory, "OwnableUnauthorizedAccount");
      });
    });

    describe("forceRelaxMaxWallet", function () {
      it("should relax max wallet on a factory token", async function () {
        const fixture = await loadFixture(deployFixture);
        const { tokenFactory, owner, alice } = fixture;

        const tokenAddr = await createBasicToken(fixture);
        const token = await ethers.getContractAt(
          "BasicTokenImpl",
          tokenAddr
        );

        // alice sets maxWallet
        await token.connect(alice).setMaxWalletAmount(1000n);
        expect(await token.maxWalletAmount()).to.equal(1000n);

        // Factory owner relaxes it
        await tokenFactory.forceRelaxMaxWallet(tokenAddr, 5000n);
        expect(await token.maxWalletAmount()).to.equal(5000n);
      });

      it("should allow disabling (setting to 0)", async function () {
        const fixture = await loadFixture(deployFixture);
        const { tokenFactory, alice } = fixture;

        const tokenAddr = await createBasicToken(fixture);
        const token = await ethers.getContractAt(
          "BasicTokenImpl",
          tokenAddr
        );

        await token.connect(alice).setMaxWalletAmount(1000n);
        await tokenFactory.forceRelaxMaxWallet(tokenAddr, 0n);
        expect(await token.maxWalletAmount()).to.equal(0n);
      });

      it("should revert for non-factory token", async function () {
        const { tokenFactory } = await loadFixture(deployFixture);
        await expect(
          tokenFactory.forceRelaxMaxWallet(
            "0x0000000000000000000000000000000000000001",
            5000n
          )
        ).to.be.revertedWithCustomError(tokenFactory, "NotFactoryToken");
      });

      it("should revert when called by non-owner", async function () {
        const fixture = await loadFixture(deployFixture);
        const { tokenFactory, alice } = fixture;
        const tokenAddr = await createBasicToken(fixture);

        await expect(
          tokenFactory
            .connect(alice)
            .forceRelaxMaxWallet(tokenAddr, 5000n)
        ).to.be.revertedWithCustomError(tokenFactory, "OwnableUnauthorizedAccount");
      });
    });

    describe("forceRelaxMaxTransaction", function () {
      it("should relax max transaction on a factory token", async function () {
        const fixture = await loadFixture(deployFixture);
        const { tokenFactory, owner, alice } = fixture;

        const tokenAddr = await createBasicToken(fixture);
        const token = await ethers.getContractAt(
          "BasicTokenImpl",
          tokenAddr
        );

        await token.connect(alice).setMaxTransactionAmount(500n);
        expect(await token.maxTransactionAmount()).to.equal(500n);

        await tokenFactory.forceRelaxMaxTransaction(tokenAddr, 2000n);
        expect(await token.maxTransactionAmount()).to.equal(2000n);
      });

      it("should allow disabling (setting to 0)", async function () {
        const fixture = await loadFixture(deployFixture);
        const { tokenFactory, alice } = fixture;

        const tokenAddr = await createBasicToken(fixture);
        const token = await ethers.getContractAt(
          "BasicTokenImpl",
          tokenAddr
        );

        await token.connect(alice).setMaxTransactionAmount(500n);
        await tokenFactory.forceRelaxMaxTransaction(tokenAddr, 0n);
        expect(await token.maxTransactionAmount()).to.equal(0n);
      });

      it("should revert for non-factory token", async function () {
        const { tokenFactory } = await loadFixture(deployFixture);
        await expect(
          tokenFactory.forceRelaxMaxTransaction(
            "0x0000000000000000000000000000000000000001",
            2000n
          )
        ).to.be.revertedWithCustomError(tokenFactory, "NotFactoryToken");
      });

      it("should revert when called by non-owner", async function () {
        const fixture = await loadFixture(deployFixture);
        const { tokenFactory, alice } = fixture;
        const tokenAddr = await createBasicToken(fixture);

        await expect(
          tokenFactory
            .connect(alice)
            .forceRelaxMaxTransaction(tokenAddr, 2000n)
        ).to.be.revertedWithCustomError(tokenFactory, "OwnableUnauthorizedAccount");
      });
    });

    describe("forceRelaxCooldown", function () {
      it("should relax cooldown on a factory token", async function () {
        const fixture = await loadFixture(deployFixture);
        const { tokenFactory, owner, alice } = fixture;

        const tokenAddr = await createBasicToken(fixture);
        const token = await ethers.getContractAt(
          "BasicTokenImpl",
          tokenAddr
        );

        await token.connect(alice).setCooldownTime(60);
        expect(await token.cooldownTime()).to.equal(60n);

        // Force relax to a shorter cooldown
        await tokenFactory.forceRelaxCooldown(tokenAddr, 30);
        expect(await token.cooldownTime()).to.equal(30n);
      });

      it("should allow disabling (setting to 0)", async function () {
        const fixture = await loadFixture(deployFixture);
        const { tokenFactory, alice } = fixture;

        const tokenAddr = await createBasicToken(fixture);
        const token = await ethers.getContractAt(
          "BasicTokenImpl",
          tokenAddr
        );

        await token.connect(alice).setCooldownTime(60);
        await tokenFactory.forceRelaxCooldown(tokenAddr, 0);
        expect(await token.cooldownTime()).to.equal(0n);
      });

      it("should revert for non-factory token", async function () {
        const { tokenFactory } = await loadFixture(deployFixture);
        await expect(
          tokenFactory.forceRelaxCooldown(
            "0x0000000000000000000000000000000000000001",
            30
          )
        ).to.be.revertedWithCustomError(tokenFactory, "NotFactoryToken");
      });

      it("should revert when called by non-owner", async function () {
        const fixture = await loadFixture(deployFixture);
        const { tokenFactory, alice } = fixture;
        const tokenAddr = await createBasicToken(fixture);

        await expect(
          tokenFactory.connect(alice).forceRelaxCooldown(tokenAddr, 30)
        ).to.be.revertedWithCustomError(tokenFactory, "OwnableUnauthorizedAccount");
      });
    });

    describe("forceDisableBlacklist", function () {
      it("should disable blacklist on a factory token", async function () {
        const fixture = await loadFixture(deployFixture);
        const { tokenFactory, owner, alice } = fixture;

        const tokenAddr = await createBasicToken(fixture);
        const token = await ethers.getContractAt(
          "BasicTokenImpl",
          tokenAddr
        );

        await token.connect(alice).setBlacklistWindow(3600);
        expect(await token.blacklistWindow()).to.equal(3600n);

        await tokenFactory.forceDisableBlacklist(tokenAddr);
        expect(await token.blacklistWindow()).to.equal(0n);
      });

      it("should revert for non-factory token", async function () {
        const { tokenFactory } = await loadFixture(deployFixture);
        await expect(
          tokenFactory.forceDisableBlacklist(
            "0x0000000000000000000000000000000000000001"
          )
        ).to.be.revertedWithCustomError(tokenFactory, "NotFactoryToken");
      });

      it("should revert when called by non-owner", async function () {
        const fixture = await loadFixture(deployFixture);
        const { tokenFactory, alice } = fixture;
        const tokenAddr = await createBasicToken(fixture);

        await expect(
          tokenFactory.connect(alice).forceDisableBlacklist(tokenAddr)
        ).to.be.revertedWithCustomError(tokenFactory, "OwnableUnauthorizedAccount");
      });
    });
  });
});
