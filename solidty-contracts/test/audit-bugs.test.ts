import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Audit Bug Regression Tests
 *
 * These tests verify that three critical/high bugs found during audit are NOW FIXED:
 *   C-1: PartnerTaxableTokenImpl._update bypasses ALL BasicTokenImpl protections — FIXED
 *   C-2: TaxableTokenImpl cooldown + tax causes all taxed transfers to revert — FIXED
 *   H-1: PlatformRouter.createTokenAndLaunch reverts for partner-only tokens — FIXED
 */
describe("Audit Bug Regression Tests", function () {
  async function deployFullPlatform() {
    const [owner, attacker, alice, bob, charlie] = await ethers.getSigners();

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

    // Register implementations (type key: partner=4, taxable=2, mintable=1)
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

    // Helpers
    async function getCreationFeeNative(typeKey: number): Promise<bigint> {
      const baseFee = await tokenFactory.creationFee(typeKey);
      return await tokenFactory.convertFee(baseFee, ethers.ZeroAddress);
    }

    async function createTokenViaFactory(
      signer: any,
      params: any,
      typeKey: number
    ): Promise<string> {
      const fee = await getCreationFeeNative(typeKey);
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

    return {
      owner,
      attacker,
      alice,
      bob,
      charlie,
      usdt,
      weth,
      dexFactory,
      dexRouter,
      tokenFactory,
      launchpadFactory,
      platformRouter,
      getCreationFeeNative,
      createTokenViaFactory,
    };
  }

  // ==========================================================================
  // C-1: PartnerTaxableTokenImpl._update bypasses ALL BasicTokenImpl protections
  //
  // Root cause: _update calls ERC20Upgradeable._update() directly instead of
  // super._update(), skipping BasicTokenImpl's trading, blacklist, maxWallet,
  // maxTransaction, and cooldown checks entirely.
  //
  // Affected types: PartnerTaxableTokenImpl (6), PartnerTaxableMintableTokenImpl (7)
  // ==========================================================================
  describe("C-1: PartnerTaxableTokenImpl now enforces all protections (FIXED)", function () {
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

    it("FIXED: blocks transfer when trading is NOT enabled", async function () {
      const { alice, bob, charlie, createTokenViaFactory } =
        await loadFixture(deployFullPlatform);

      const tokenAddress = await createTokenViaFactory(alice, partnerTaxableParams, 6);
      const token = await ethers.getContractAt("PartnerTaxableTokenImpl", tokenAddress);

      // Trading is NOT enabled
      expect(await token.tradingEnabled()).to.be.false;

      // Alice (creator, excluded from limits) sends tokens to bob
      await token.connect(alice).transfer(bob.address, ethers.parseUnits("10000", 18));

      // Bob (regular user) transfers to charlie — now correctly blocked
      await expect(
        token.connect(bob).transfer(charlie.address, ethers.parseUnits("1000", 18))
      ).to.be.revertedWith("Trading not enabled");
    });

    it("FIXED: blocks blacklisted address from transferring", async function () {
      const { alice, bob, charlie, createTokenViaFactory } =
        await loadFixture(deployFullPlatform);

      const tokenAddress = await createTokenViaFactory(alice, partnerTaxableParams, 6);
      const token = await ethers.getContractAt("PartnerTaxableTokenImpl", tokenAddress);

      // Set up blacklist window BEFORE enabling trading (required by contract)
      await token.connect(alice).setBlacklistWindow(3600);
      await token.connect(alice).enableTrading();

      // Send tokens to bob
      await token.connect(alice).transfer(bob.address, ethers.parseUnits("10000", 18));

      // Blacklist bob (within the blacklist window)
      await token.connect(alice).setBlacklisted(bob.address, true);
      expect(await token.blacklisted(bob.address)).to.be.true;

      // Bob (BLACKLISTED) transfers to charlie — now correctly blocked
      await expect(
        token.connect(bob).transfer(charlie.address, ethers.parseUnits("1000", 18))
      ).to.be.revertedWith("Blacklisted");
    });

    it("FIXED: blocks transfer exceeding maxWalletAmount", async function () {
      const { alice, bob, charlie, createTokenViaFactory } =
        await loadFixture(deployFullPlatform);

      const tokenAddress = await createTokenViaFactory(alice, partnerTaxableParams, 6);
      const token = await ethers.getContractAt("PartnerTaxableTokenImpl", tokenAddress);

      await token.connect(alice).enableTrading();

      // Set maxWallet to 5000 tokens
      const maxWallet = ethers.parseUnits("5000", 18);
      await token.connect(alice).setMaxWalletAmount(maxWallet);

      // Alice (excluded) sends 10000 to bob — limit checks skipped for excluded sender
      await token.connect(alice).transfer(bob.address, ethers.parseUnits("10000", 18));

      // Bob sends 6000 to charlie (charlie would hold 6000 > maxWallet of 5000) — now correctly blocked
      await expect(
        token.connect(bob).transfer(charlie.address, ethers.parseUnits("6000", 18))
      ).to.be.revertedWith("Exceeds max wallet");
    });

    it("FIXED: blocks transfer exceeding maxTransactionAmount", async function () {
      const { alice, bob, charlie, createTokenViaFactory } =
        await loadFixture(deployFullPlatform);

      const tokenAddress = await createTokenViaFactory(alice, partnerTaxableParams, 6);
      const token = await ethers.getContractAt("PartnerTaxableTokenImpl", tokenAddress);

      await token.connect(alice).enableTrading();

      // Set maxTransaction to 1000 tokens
      const maxTx = ethers.parseUnits("1000", 18);
      await token.connect(alice).setMaxTransactionAmount(maxTx);

      // Alice (excluded) sends 5000 to bob
      await token.connect(alice).transfer(bob.address, ethers.parseUnits("5000", 18));

      // Bob sends 2000 tokens (exceeds maxTx of 1000) — now correctly blocked
      await expect(
        token.connect(bob).transfer(charlie.address, ethers.parseUnits("2000", 18))
      ).to.be.revertedWith("Exceeds max transaction");
    });

    it("COMPARISON: BasicTokenImpl correctly enforces all protections", async function () {
      const { alice, bob, charlie, createTokenViaFactory } =
        await loadFixture(deployFullPlatform);

      // Create a basic token (type 0) — same test scenario
      const tokenAddress = await createTokenViaFactory(
        alice,
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
        0
      );
      const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);

      // DO NOT enable trading
      await token.connect(alice).transfer(bob.address, ethers.parseUnits("10000", 18));

      // Bob -> charlie: correctly blocked
      await expect(
        token.connect(bob).transfer(charlie.address, ethers.parseUnits("1000", 18))
      ).to.be.revertedWith("Trading not enabled");

      // Now enable trading and test maxWallet
      await token.connect(alice).enableTrading();
      await token.connect(alice).setMaxWalletAmount(ethers.parseUnits("5000", 18));

      // Bob -> charlie with 6000: correctly blocked
      await expect(
        token.connect(bob).transfer(charlie.address, ethers.parseUnits("6000", 18))
      ).to.be.revertedWith("Exceeds max wallet");

      // Test maxTransaction
      await token.connect(alice).setMaxTransactionAmount(ethers.parseUnits("1000", 18));

      await expect(
        token.connect(bob).transfer(charlie.address, ethers.parseUnits("2000", 18))
      ).to.be.revertedWith("Exceeds max transaction");
    });
  });

  // ==========================================================================
  // C-2: TaxableTokenImpl — cooldown is incompatible with tax
  //
  // Root cause: TaxableTokenImpl._update splits one transfer into multiple
  // super._update() calls (one per tax wallet + the main transfer). Each call
  // goes through BasicTokenImpl._update which enforces cooldown. The first
  // sub-transfer sets lastTransferTime[from], and the second sub-transfer
  // immediately fails the cooldown check because no time has elapsed.
  //
  // Affected types: TaxableTokenImpl (2), TaxableMintableTokenImpl (3)
  // ==========================================================================
  describe("C-2: TaxableTokenImpl cooldown + tax now works correctly (FIXED)", function () {
    it("FIXED: taxed transfer succeeds when cooldown is active", async function () {
      const { alice, bob, charlie, attacker, createTokenViaFactory } =
        await loadFixture(deployFullPlatform);

      // Create taxable token (type 2)
      const tokenAddress = await createTokenViaFactory(
        alice,
        {
          name: "Taxed",
          symbol: "TAX",
          totalSupply: 1000000,
          decimals: 18,
          isTaxable: true,
          isMintable: false,
          isPartner: false,
          paymentToken: ethers.ZeroAddress,
        },
        2
      );
      const token = await ethers.getContractAt("TaxableTokenImpl", tokenAddress);

      // Set cooldown BEFORE enabling trading (can only relax after trading)
      await token.connect(alice).setCooldownTime(60);
      await token.connect(alice).enableTrading();

      // Set 1% transfer tax going to attacker's address as the tax wallet
      await token.connect(alice).setTaxes(0, 0, 100); // 1% transfer tax
      await token.connect(alice).setTaxDistribution(
        [attacker.address], // tax wallet
        [10000] // 100% of tax goes here
      );

      // Exclude alice from tax so alice->bob is a clean transfer
      await token.connect(alice).excludeFromTax(alice.address, true);

      // Alice (excluded from limits AND tax) sends tokens to bob — no issues
      await token.connect(alice).transfer(bob.address, ethers.parseUnits("10000", 18));

      // Bob (regular user) sends 1000 tokens to charlie
      // _checkProtections is called once, then sub-transfers use ERC20Upgradeable._update
      // so cooldown is only checked once — transfer succeeds
      await expect(
        token.connect(bob).transfer(charlie.address, ethers.parseUnits("1000", 18))
      ).to.not.be.reverted;

      // Charlie received 990 tokens (1000 - 1% tax)
      expect(await token.balanceOf(charlie.address)).to.equal(
        ethers.parseUnits("990", 18)
      );
      // Tax wallet received 10 tokens
      expect(await token.balanceOf(attacker.address)).to.equal(
        ethers.parseUnits("10", 18)
      );
    });

    it("FIXED: also works with multiple tax wallets + cooldown", async function () {
      const { owner, alice, bob, charlie, attacker, createTokenViaFactory } =
        await loadFixture(deployFullPlatform);

      const tokenAddress = await createTokenViaFactory(
        alice,
        {
          name: "Taxed2",
          symbol: "TX2",
          totalSupply: 1000000,
          decimals: 18,
          isTaxable: true,
          isMintable: false,
          isPartner: false,
          paymentToken: ethers.ZeroAddress,
        },
        2
      );
      const token = await ethers.getContractAt("TaxableTokenImpl", tokenAddress);

      // Set cooldown BEFORE enabling trading (can only relax after trading)
      await token.connect(alice).setCooldownTime(30);
      await token.connect(alice).enableTrading();

      // 2% transfer tax split between two wallets
      await token.connect(alice).setTaxes(0, 0, 200);
      await token.connect(alice).setTaxDistribution(
        [attacker.address, owner.address], // two tax wallets
        [5000, 5000] // 50/50 split
      );

      // Exclude alice from tax so alice->bob is a clean transfer
      await token.connect(alice).excludeFromTax(alice.address, true);

      await token.connect(alice).transfer(bob.address, ethers.parseUnits("10000", 18));

      // Now works — _checkProtections called once, sub-transfers bypass cooldown
      await expect(
        token.connect(bob).transfer(charlie.address, ethers.parseUnits("1000", 18))
      ).to.not.be.reverted;

      // Charlie received 980 tokens (1000 - 2% tax)
      expect(await token.balanceOf(charlie.address)).to.equal(
        ethers.parseUnits("980", 18)
      );
    });

    it("COMPARISON: same token works fine without cooldown", async function () {
      const { alice, bob, charlie, attacker, createTokenViaFactory } =
        await loadFixture(deployFullPlatform);

      const tokenAddress = await createTokenViaFactory(
        alice,
        {
          name: "Taxed",
          symbol: "TAX",
          totalSupply: 1000000,
          decimals: 18,
          isTaxable: true,
          isMintable: false,
          isPartner: false,
          paymentToken: ethers.ZeroAddress,
        },
        2
      );
      const token = await ethers.getContractAt("TaxableTokenImpl", tokenAddress);

      await token.connect(alice).enableTrading();
      await token.connect(alice).setTaxes(0, 0, 100);
      await token.connect(alice).setTaxDistribution([attacker.address], [10000]);
      // Exclude alice from tax so alice->bob transfer is clean
      await token.connect(alice).excludeFromTax(alice.address, true);
      // NO cooldown set — default is 0

      await token.connect(alice).transfer(bob.address, ethers.parseUnits("10000", 18));

      // Without cooldown, the taxed transfer works correctly
      await expect(
        token.connect(bob).transfer(charlie.address, ethers.parseUnits("1000", 18))
      ).to.not.be.reverted;

      // Charlie received 990 tokens (1000 - 1% tax)
      expect(await token.balanceOf(charlie.address)).to.equal(
        ethers.parseUnits("990", 18)
      );
      // Tax wallet received 10 tokens (only from bob->charlie, alice was excluded)
      expect(await token.balanceOf(attacker.address)).to.equal(
        ethers.parseUnits("10", 18)
      );
    });
  });

  // ==========================================================================
  // H-1: PlatformRouter._configureProtections reverts for partner-only tokens
  //
  // Root cause: The condition `if (isTaxable || isPartner)` calls
  // ITaxableToken(tokenAddress).excludeFromTax(), but PartnerTokenImpl and
  // PartnerMintableTokenImpl do NOT implement excludeFromTax (only
  // TaxableTokenImpl does). The external call hits a non-existent function
  // selector and reverts.
  //
  // Affected types via router: PartnerTokenImpl (4), PartnerMintableTokenImpl (5)
  // ==========================================================================
  describe("H-1: PlatformRouter now works for partner-only tokens (FIXED)", function () {
    it("FIXED: createTokenAndLaunch succeeds for partner-only token (type 4)", async function () {
      const { platformRouter, alice, getCreationFeeNative, launchpadFactory } =
        await loadFixture(deployFullPlatform);

      await launchpadFactory.setLaunchFee(0);
      const fee = await getCreationFeeNative(4); // partner = type 4

      // Router now only calls excludeFromTax when isTaxable is true,
      // so partner-only tokens (which don't have excludeFromTax) work correctly
      await expect(
        platformRouter.connect(alice).createTokenAndLaunch(
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
          {
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
        )
      ).to.not.be.reverted;
    });

    it("FIXED: also succeeds for partner+mintable token (type 5)", async function () {
      const { platformRouter, alice, getCreationFeeNative, launchpadFactory } =
        await loadFixture(deployFullPlatform);

      await launchpadFactory.setLaunchFee(0);
      const fee = await getCreationFeeNative(5); // partner+mintable = type 5

      await expect(
        platformRouter.connect(alice).createTokenAndLaunch(
          {
            name: "PartnerMint",
            symbol: "PMT",
            totalSupply: 1000000,
            decimals: 18,
            isTaxable: false,
            isMintable: true,
            isPartner: true,
            paymentToken: ethers.ZeroAddress,
          },
          {
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
        )
      ).to.not.be.reverted;
    });

    it("COMPARISON: taxable token via router works correctly", async function () {
      const { platformRouter, alice, getCreationFeeNative, launchpadFactory } =
        await loadFixture(deployFullPlatform);

      await launchpadFactory.setLaunchFee(0);
      const fee = await getCreationFeeNative(2); // taxable = type 2

      // TaxableTokenImpl HAS excludeFromTax => succeeds
      await expect(
        platformRouter.connect(alice).createTokenAndLaunch(
          {
            name: "Taxable",
            symbol: "TAX",
            totalSupply: 1000000,
            decimals: 18,
            isTaxable: true,
            isMintable: false,
            isPartner: false,
            paymentToken: ethers.ZeroAddress,
          },
          {
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
          },
          { maxWalletAmount: 0, maxTransactionAmount: 0, cooldownSeconds: 0 },
          {
            buyTaxBps: 300,
            sellTaxBps: 300,
            transferTaxBps: 0,
            taxWallets: [alice.address],
            taxSharesBps: [10000],
          },
          ethers.ZeroAddress,
          { value: fee + ethers.parseEther("2") }
        )
      ).to.not.be.reverted;
    });

    it("COMPARISON: partner+taxable token via router works correctly", async function () {
      const { platformRouter, alice, getCreationFeeNative, launchpadFactory } =
        await loadFixture(deployFullPlatform);

      await launchpadFactory.setLaunchFee(0);
      const fee = await getCreationFeeNative(6); // partner+taxable = type 6

      // PartnerTaxableTokenImpl inherits TaxableTokenImpl which HAS excludeFromTax
      await expect(
        platformRouter.connect(alice).createTokenAndLaunch(
          {
            name: "PartnerTax",
            symbol: "PTAX",
            totalSupply: 1000000,
            decimals: 18,
            isTaxable: true,
            isMintable: false,
            isPartner: true,
            paymentToken: ethers.ZeroAddress,
          },
          {
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
          },
          { maxWalletAmount: 0, maxTransactionAmount: 0, cooldownSeconds: 0 },
          {
            buyTaxBps: 300,
            sellTaxBps: 300,
            transferTaxBps: 0,
            taxWallets: [alice.address],
            taxSharesBps: [10000],
          },
          ethers.ZeroAddress,
          { value: fee + ethers.parseEther("2") }
        )
      ).to.not.be.reverted;
    });
  });
});
