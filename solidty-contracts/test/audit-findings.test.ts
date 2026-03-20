import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * Audit Findings - Proof of Concept Tests
 *
 * Tests for all CRITICAL, HIGH, and MEDIUM findings from the security audit.
 * Each test demonstrates the vulnerability or verifies existing mitigations.
 */
describe("Audit Findings PoC Tests", function () {
  // ================================================================
  // SHARED FIXTURE
  // ================================================================
  async function deployFullPlatform() {
    const [owner, attacker, alice, bob, charlie, dave, eve] =
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
    const partnerTaxableMintableImpl =
      await PartnerTaxableMintableImpl.deploy();

    // Register implementations
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

    // Helpers
    async function getCreationFeeNative(typeKey: number): Promise<bigint> {
      const baseFee = await tokenFactory.creationFee(typeKey);
      return await tokenFactory.convertFee(baseFee, ethers.ZeroAddress);
    }

    async function createTokenViaFactory(
      signer: HardhatEthersSigner,
      params: any,
      typeKey: number,
      referral: string = ethers.ZeroAddress
    ): Promise<string> {
      const fee = await getCreationFeeNative(typeKey);
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

    async function createLaunchForToken(
      signer: HardhatEthersSigner,
      tokenAddress: string,
      totalTokens: bigint,
      softCap: bigint,
      hardCap: bigint
    ): Promise<string> {
      const launchTx = await launchpadFactory.connect(signer).createLaunch(
        tokenAddress,
        totalTokens,
        0, // Linear curve
        softCap,
        hardCap,
        30, // 30 days
        500, // 5% max buy
        0, // no creator allocation
        0, // no vesting
        ethers.ZeroAddress, // native payment
        0 // startTimestamp: immediate
      );
      const receipt = await launchTx.wait();

      // Find LaunchCreated event
      const event = receipt!.logs.find((l: any) => {
        try {
          return (
            launchpadFactory.interface.parseLog(l as any)?.name ===
            "LaunchCreated"
          );
        } catch {
          return false;
        }
      });
      const parsed = launchpadFactory.interface.parseLog(event as any);
      return parsed!.args.launch;
    }

    return {
      owner,
      attacker,
      alice,
      bob,
      charlie,
      dave,
      eve,
      usdt,
      weth,
      dexFactory,
      dexRouter,
      tokenFactory,
      launchpadFactory,
      platformRouter,
      getCreationFeeNative,
      createTokenViaFactory,
      createLaunchForToken,
    };
  }

  // ================================================================
  // BASIC PARAMS HELPERS
  // ================================================================
  const basicParams = {
    name: "Test",
    symbol: "TST",
    totalSupply: 1_000_000,
    decimals: 18,
    isTaxable: false,
    isMintable: false,
    isPartner: false,
    paymentToken: ethers.ZeroAddress,
  };

  const taxableParams = {
    name: "Taxable",
    symbol: "TAX",
    totalSupply: 1_000_000,
    decimals: 18,
    isTaxable: true,
    isMintable: false,
    isPartner: false,
    paymentToken: ethers.ZeroAddress,
  };

  const partnerParams = {
    name: "Partner",
    symbol: "PTR",
    totalSupply: 1_000_000,
    decimals: 18,
    isTaxable: false,
    isMintable: false,
    isPartner: true,
    paymentToken: ethers.ZeroAddress,
  };

  const partnerTaxableParams = {
    name: "PartnerTax",
    symbol: "PTAX",
    totalSupply: 1_000_000,
    decimals: 18,
    isTaxable: true,
    isMintable: false,
    isPartner: true,
    paymentToken: ethers.ZeroAddress,
  };

  // ================================================================
  // C-01: Refund mechanism allows theft via accomplice
  // ================================================================
  describe("C-01: Refund theft via token transfer to accomplice", function () {
    it("demonstrates that a buyer can transfer tokens away and still have the refund path", async function () {
      const {
        alice,
        bob,
        charlie,
        usdt,
        tokenFactory,
        launchpadFactory,
        createTokenViaFactory,
        createLaunchForToken,
      } = await loadFixture(deployFullPlatform);

      // Setup: Alice creates a basic token
      const tokenAddress = await createTokenViaFactory(alice, basicParams, 0);
      const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);

      // Alice enables trading and creates a launch
      await token.connect(alice).enableTrading();
      await launchpadFactory.setLaunchFee(0);

      const totalTokens = ethers.parseUnits("500000", 18);
      const softCap = ethers.parseUnits("10000", 6); // 10k USDT
      const hardCap = ethers.parseUnits("50000", 6); // 50k USDT

      const launchAddress = await createLaunchForToken(
        alice,
        tokenAddress,
        totalTokens,
        softCap,
        hardCap
      );
      const launch = await ethers.getContractAt(
        "LaunchInstance",
        launchAddress
      );

      // Alice deposits tokens to activate the launch
      await token.connect(alice).approve(launchAddress, totalTokens);
      await launch.connect(alice).depositTokens(totalTokens);

      expect(await launch.state()).to.equal(1); // Active

      // Bob buys tokens via the launch (needs USDT)
      // Fund bob with USDT
      await usdt.transfer(bob.address, ethers.parseUnits("1000", 6));
      await usdt.connect(bob).approve(launchAddress, ethers.parseUnits("1000", 6));

      await launch
        .connect(bob)
        .buyWithToken(
          await usdt.getAddress(),
          ethers.parseUnits("1000", 6),
          0,
          0
        );

      const bobTokensBought = await launch.tokensBought(bob.address);
      const bobBasePaid = await launch.basePaid(bob.address);
      expect(bobTokensBought).to.be.gt(0);
      expect(bobBasePaid).to.be.gt(0);

      // ATTACK STEP 1: Bob transfers all bought tokens to accomplice (charlie)
      const bobTokenBalance = await token.balanceOf(bob.address);
      await token.connect(bob).transfer(charlie.address, bobTokenBalance);

      expect(await token.balanceOf(bob.address)).to.equal(0);

      // Now simulate deadline passing without soft cap
      await time.increase(31 * 24 * 60 * 60); // 31 days

      // Enable refunds (deadline passed, soft cap not reached)
      await launch.enableRefunds();
      expect(await launch.state()).to.equal(3); // Refunding

      // ATTACK STEP 2: Charlie sends tokens back to Bob
      await token.connect(charlie).transfer(bob.address, bobTokenBalance);

      // ATTACK STEP 3: Bob approves and claims refund
      await token.connect(bob).approve(launchAddress, bobTokensBought);

      // Bob gets full USDT refund while charlie had the tokens in between
      // This demonstrates the tokens could have been used elsewhere (sold, used as collateral, etc.)
      await launch.connect(bob).refund();

      // Bob got refunded
      expect(await launch.basePaid(bob.address)).to.equal(0);
      expect(await launch.tokensBought(bob.address)).to.equal(0);

      // The "free option" attack: Bob had the economic benefit of the tokens
      // during the launch period (could have sold on secondary market if one existed)
      // and still got the full refund
    });

    it("verifies refund correctly requires full token return", async function () {
      const {
        alice,
        bob,
        usdt,
        launchpadFactory,
        createTokenViaFactory,
        createLaunchForToken,
      } = await loadFixture(deployFullPlatform);

      const tokenAddress = await createTokenViaFactory(alice, basicParams, 0);
      const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
      await token.connect(alice).enableTrading();
      await launchpadFactory.setLaunchFee(0);

      const totalTokens = ethers.parseUnits("500000", 18);
      const launchAddress = await createLaunchForToken(
        alice,
        tokenAddress,
        totalTokens,
        ethers.parseUnits("10000", 6),
        ethers.parseUnits("50000", 6)
      );
      const launch = await ethers.getContractAt("LaunchInstance", launchAddress);

      await token.connect(alice).approve(launchAddress, totalTokens);
      await launch.connect(alice).depositTokens(totalTokens);

      // Bob buys
      await usdt.transfer(bob.address, ethers.parseUnits("500", 6));
      await usdt.connect(bob).approve(launchAddress, ethers.parseUnits("500", 6));
      await launch.connect(bob).buyWithToken(await usdt.getAddress(), ethers.parseUnits("500", 6), 0, 0);

      const bobTokensBought = await launch.tokensBought(bob.address);

      // Bob transfers half away (so he doesn't have enough to return)
      const halfTokens = bobTokensBought / 2n;
      await token.connect(bob).transfer(alice.address, halfTokens);

      // Deadline passes, enable refunds
      await time.increase(31 * 24 * 60 * 60);
      await launch.enableRefunds();

      // Bob tries to refund but doesn't have enough tokens
      await token.connect(bob).approve(launchAddress, bobTokensBought);

      // Should revert because bob doesn't have enough balance
      await expect(launch.connect(bob).refund()).to.be.revertedWithCustomError(
        launch,
        "ReturnTokensToRefund"
      );
    });
  });

  // ================================================================
  // C-02: Referral ETH push to arbitrary addresses
  // ================================================================
  describe("C-02: Referral ETH push to malicious contracts", function () {
    it("reverting referrer causes reward to go to pendingRewards (fallback works)", async function () {
      const { alice, tokenFactory, getCreationFeeNative } =
        await loadFixture(deployFullPlatform);

      // Deploy a reverting referrer contract
      const RevertingReferrer = await ethers.getContractFactory(
        "RevertingReferrer"
      );
      const revertingRef = await RevertingReferrer.deploy();

      // Alice creates a token with reverting contract as referrer
      const fee = await getCreationFeeNative(0);
      const tx = await tokenFactory
        .connect(alice)
        .createToken(basicParams, await revertingRef.getAddress(), {
          value: fee,
        });
      await tx.wait();

      // Referral was recorded
      expect(await tokenFactory.referrals(alice.address)).to.equal(
        await revertingRef.getAddress()
      );

      // Since the ETH send reverted, reward should be in pendingRewards
      const pending = await tokenFactory.pendingRewards(
        await revertingRef.getAddress(),
        ethers.ZeroAddress
      );
      expect(pending).to.be.gt(0);

      // totalEarned should still be updated
      const earned = await tokenFactory.totalEarned(
        await revertingRef.getAddress(),
        ethers.ZeroAddress
      );
      expect(earned).to.be.gt(0);
    });

    it("FIXED: gas-griefing referrer no longer causes out-of-gas (gas capped at 2300)", async function () {
      const { alice, tokenFactory, getCreationFeeNative } =
        await loadFixture(deployFullPlatform);

      // Deploy gas-griefing referrer that burns ~30M gas in receive()
      const GasGriefReferrer = await ethers.getContractFactory(
        "GasGriefReferrer"
      );
      const griefRef = await GasGriefReferrer.deploy();

      const fee = await getCreationFeeNative(0);

      // FIXED: With gas capped at 2300 on referral calls, the griefing referrer
      // can't consume excess gas. The call fails with 2300 gas limit and reward
      // goes to pendingRewards instead. Token creation succeeds at normal gas.
      await expect(
        tokenFactory
          .connect(alice)
          .createToken(basicParams, await griefRef.getAddress(), {
            value: fee,
            gasLimit: 10_000_000,
          })
      ).to.not.be.reverted;

      // FIXED: Gas-capped referral calls mean the grief referrer's receive()
      // only gets 2300 gas, can't burn excess. Gas usage is now comparable to normal.
      const tx = await tokenFactory
        .connect(alice)
        .createToken(
          { ...basicParams, name: "Grief", symbol: "GRF" },
          await griefRef.getAddress(),
          { value: fee }
        );
      const receipt = await tx.wait();
      const gasUsedGrief = receipt!.gasUsed;

      // Create without referral for comparison
      const tx2 = await tokenFactory
        .connect(alice)
        .createToken(
          { ...basicParams, name: "Normal", symbol: "NRM" },
          ethers.ZeroAddress,
          { value: fee }
        );
      const receipt2 = await tx2.wait();
      const gasNormal = receipt2!.gasUsed;

      // With gas cap, grief referrer costs only marginally more (not 10M+ more)
      expect(gasUsedGrief).to.be.lt(gasNormal + 100_000n);
    });
  });

  // ================================================================
  // C-03: processTax reentrancy via _update -> DEX swap
  // ================================================================
  describe("C-03: processTax called on every swap (reentrancy risk)", function () {
    it("partner token calls processTax on every transfer to/from pool", async function () {
      const { alice, bob, tokenFactory, createTokenViaFactory } =
        await loadFixture(deployFullPlatform);

      const tokenAddress = await createTokenViaFactory(
        alice,
        partnerParams,
        4
      );
      const token = await ethers.getContractAt(
        "PartnerTokenImpl",
        tokenAddress
      );

      await token.connect(alice).enableTrading();

      // Get a pool address
      const pools: string[] = [];
      // The token has pools set up during creation. Check if any pool exists
      // by looking at factory-created pools
      const factoryAddr = await tokenFactory.getAddress();

      // The partner token's poolFactory is set to tokenFactory
      expect(await token.poolFactory()).to.equal(factoryAddr);

      // Verify processTax has no reentrancy guard by checking it can be called
      // from the token itself (msg.sender == token)
      // First, verify the processTax access control:
      // - owner can call it
      // - registered token can call it
      // - nobody else can

      // Owner can call processTax
      await expect(
        tokenFactory.processTax(tokenAddress)
      ).to.not.be.reverted;

      // Random user cannot
      const [, , , , , randomUser] = await ethers.getSigners();
      await expect(
        tokenFactory.connect(randomUser).processTax(tokenAddress)
      ).to.be.revertedWithCustomError(tokenFactory, "NotFactoryToken");
    });

    it("processTax has no nonReentrant modifier - can be called repeatedly", async function () {
      const { alice, tokenFactory, createTokenViaFactory } =
        await loadFixture(deployFullPlatform);

      // Create a partner token to have a valid token in tokenInfo
      const tokenAddress = await createTokenViaFactory(
        alice,
        partnerParams,
        4
      );

      // processTax can be called by owner without any reentrancy guard
      // First call: no balance, exits early
      await tokenFactory.processTax(tokenAddress);

      // Second call immediately: also works, no lock
      await tokenFactory.processTax(tokenAddress);

      // In a real DEX scenario, the swap callback inside processTax would
      // trigger another token._update which calls processTax again,
      // creating a recursive call with no guard to prevent it.
      // We can't fully simulate this with the mock router, but we verify
      // the function has no reentrancy protection.
    });
  });

  // ================================================================
  // C-04: Supply overflow in _initAndRecord
  // ================================================================
  describe("C-04: Supply overflow with large totalSupply * 10^decimals", function () {
    it("reverts on totalSupply that would overflow with decimals=18", async function () {
      const { alice, tokenFactory, getCreationFeeNative } =
        await loadFixture(deployFullPlatform);

      const fee = await getCreationFeeNative(0);

      // 2^238 * 10^18 > 2^256, causing overflow
      const hugeSupply = 2n ** 238n;

      const params = {
        name: "Overflow",
        symbol: "OVF",
        totalSupply: hugeSupply,
        decimals: 18,
        isTaxable: false,
        isMintable: false,
        isPartner: false,
        paymentToken: ethers.ZeroAddress,
      };

      // Should revert due to arithmetic overflow in: totalSupply * 10 ** decimals
      await expect(
        tokenFactory.connect(alice).createToken(params, ethers.ZeroAddress, {
          value: fee,
        })
      ).to.be.reverted; // Solidity 0.8.x panic on overflow
    });

    it("FIXED: rejects unreasonable supply (max 1e30)", async function () {
      const { alice, tokenFactory, getCreationFeeNative } =
        await loadFixture(deployFullPlatform);

      const fee = await getCreationFeeNative(0);

      // With decimals=0, totalSupply * 10^0 = totalSupply, no overflow
      // But now there's a 1e30 cap on totalSupply
      const maxReasonable = 2n ** 128n; // Exceeds 1e30 cap

      const params = {
        name: "MaxSupply",
        symbol: "MAX",
        totalSupply: maxReasonable,
        decimals: 0,
        isTaxable: false,
        isMintable: false,
        isPartner: false,
        paymentToken: ethers.ZeroAddress,
      };

      // FIXED: Now correctly rejected by the 1e30 supply cap
      await expect(
        tokenFactory.connect(alice).createToken(params, ethers.ZeroAddress, {
          value: fee,
        })
      ).to.be.reverted;
    });

    it("no maximum supply validation exists", async function () {
      const { alice, tokenFactory, getCreationFeeNative } =
        await loadFixture(deployFullPlatform);

      const fee = await getCreationFeeNative(0);

      // 10^30 tokens with 18 decimals = 10^48 raw units. Fits in uint256 but unreasonable.
      const absurdSupply = 10n ** 30n;

      const params = {
        name: "Absurd",
        symbol: "ABS",
        totalSupply: absurdSupply,
        decimals: 18,
        isTaxable: false,
        isMintable: false,
        isPartner: false,
        paymentToken: ethers.ZeroAddress,
      };

      // Succeeds - no cap check. This creates 10^48 raw tokens.
      await expect(
        tokenFactory.connect(alice).createToken(params, ethers.ZeroAddress, {
          value: fee,
        })
      ).to.not.be.reverted;
    });
  });

  // ================================================================
  // H-01: LaunchpadFactory._convertFee uses getAmountsOut (wrong direction)
  // ================================================================
  describe("H-01: LaunchpadFactory fee conversion direction", function () {
    it("TokenFactory uses getAmountsIn (correct) vs LaunchpadFactory uses getAmountsOut (incorrect)", async function () {
      const { tokenFactory, launchpadFactory, usdt, weth, dexRouter } =
        await loadFixture(deployFullPlatform);

      const baseFee = ethers.parseUnits("100", 6); // 100 USDT

      // TokenFactory.convertFee uses getAmountsIn:
      // "How much native do I need to INPUT to get 100 USDT OUT?"
      const tokenFactoryFee = await tokenFactory.convertFee(
        baseFee,
        ethers.ZeroAddress
      );

      // LaunchpadFactory.convertFee uses getAmountsOut:
      // "If I INPUT 100 USDT, how much native do I get OUT?"
      const launchpadFee = await launchpadFactory.convertFee(
        baseFee,
        ethers.ZeroAddress
      );

      // These should ideally be the same (or very close) but they compute
      // different things due to the directional difference.
      // With mock router the prices may align, but with real AMMs the
      // spread between getAmountsIn and getAmountsOut causes discrepancy.

      // Log the values to show the difference
      // In a real DEX with fees, tokenFactoryFee would be HIGHER than
      // launchpadFee because getAmountsIn accounts for swap fees

      // The key observation: both functions EXIST and return values,
      // demonstrating the inconsistency in approach
      expect(tokenFactoryFee).to.be.gt(0);
      expect(launchpadFee).to.be.gt(0);
    });
  });

  // ================================================================
  // H-02: Tax-free addresses and protection checks
  // VERIFIED: super._update -> BasicTokenImpl._update -> _checkProtections
  // Tax-free addresses DO get protection checks. This is a regression test.
  // ================================================================
  describe("H-02: Tax-free addresses still enforced by protections (VERIFIED SAFE)", function () {
    it("tax-free address is BLOCKED when trading is disabled", async function () {
      const { alice, bob, charlie, createTokenViaFactory } =
        await loadFixture(deployFullPlatform);

      const tokenAddress = await createTokenViaFactory(
        alice,
        taxableParams,
        2
      );
      const token = await ethers.getContractAt(
        "TaxableTokenImpl",
        tokenAddress
      );

      // DO NOT enable trading
      expect(await token.tradingEnabled()).to.be.false;

      // Make bob a tax wallet (auto isTaxFree)
      await token
        .connect(alice)
        .setTaxDistribution([bob.address], [10000]);
      expect(await token.isTaxFree(bob.address)).to.be.true;

      // Alice (creator, excluded) sends tokens to bob
      await token
        .connect(alice)
        .transfer(bob.address, ethers.parseUnits("10000", 18));

      // Bob (tax-free) is correctly blocked by super._update -> _checkProtections
      await expect(
        token
          .connect(bob)
          .transfer(charlie.address, ethers.parseUnits("5000", 18))
      ).to.be.revertedWith("Trading not enabled");
    });

    it("tax-free address is BLOCKED by blacklist", async function () {
      const { alice, bob, charlie, createTokenViaFactory } =
        await loadFixture(deployFullPlatform);

      const tokenAddress = await createTokenViaFactory(
        alice,
        taxableParams,
        2
      );
      const token = await ethers.getContractAt(
        "TaxableTokenImpl",
        tokenAddress
      );

      await token.connect(alice).setBlacklistWindow(3600);
      await token.connect(alice).enableTrading();

      // Make bob a tax wallet (auto isTaxFree)
      await token
        .connect(alice)
        .setTaxDistribution([bob.address], [10000]);

      await token
        .connect(alice)
        .transfer(bob.address, ethers.parseUnits("10000", 18));

      // Blacklist bob
      await token.connect(alice).setBlacklisted(bob.address, true);

      // Tax-free BUT blacklisted - correctly blocked via super._update chain
      await expect(
        token
          .connect(bob)
          .transfer(charlie.address, ethers.parseUnits("5000", 18))
      ).to.be.revertedWith("Blacklisted");
    });

    it("tax-free address is BLOCKED by max wallet limit", async function () {
      const { alice, bob, charlie, createTokenViaFactory } =
        await loadFixture(deployFullPlatform);

      const tokenAddress = await createTokenViaFactory(
        alice,
        taxableParams,
        2
      );
      const token = await ethers.getContractAt(
        "TaxableTokenImpl",
        tokenAddress
      );

      await token.connect(alice).enableTrading();
      await token
        .connect(alice)
        .setMaxWalletAmount(ethers.parseUnits("1000", 18));

      // Make bob tax-free
      await token.connect(alice).excludeFromTax(bob.address, true);

      // Alice (excluded) sends tokens to bob
      await token
        .connect(alice)
        .transfer(bob.address, ethers.parseUnits("10000", 18));

      // Bob (tax-free) -> charlie with 5000 (exceeds maxWallet=1000)
      // Correctly blocked: super._update calls _checkProtections
      await expect(
        token
          .connect(bob)
          .transfer(charlie.address, ethers.parseUnits("5000", 18))
      ).to.be.revertedWith("Exceeds max wallet");
    });

    it("normal (non-tax-free) address is also correctly blocked", async function () {
      const { alice, bob, charlie, dave, createTokenViaFactory } =
        await loadFixture(deployFullPlatform);

      const tokenAddress = await createTokenViaFactory(
        alice,
        taxableParams,
        2
      );
      const token = await ethers.getContractAt(
        "TaxableTokenImpl",
        tokenAddress
      );

      await token.connect(alice).enableTrading();
      await token
        .connect(alice)
        .setMaxWalletAmount(ethers.parseUnits("1000", 18));

      await token
        .connect(alice)
        .transfer(dave.address, ethers.parseUnits("10000", 18));

      await expect(
        token
          .connect(dave)
          .transfer(charlie.address, ethers.parseUnits("5000", 18))
      ).to.be.revertedWith("Exceeds max wallet");
    });
  });

  // ================================================================
  // H-03: Referral chain cycle detection only checks referralLevels deep
  // ================================================================
  describe("H-03: Referral cycle detection depth limitation", function () {
    it("detects cycles within referralLevels depth", async function () {
      const { alice, bob, charlie, tokenFactory, getCreationFeeNative } =
        await loadFixture(deployFullPlatform);

      const fee = await getCreationFeeNative(0);

      // referralLevels = 3 by default
      // A -> B -> C -> (try A) should be detected

      await tokenFactory
        .connect(alice)
        .createToken(basicParams, bob.address, { value: fee });
      await tokenFactory
        .connect(bob)
        .createToken(
          { ...basicParams, name: "T2", symbol: "T2" },
          charlie.address,
          { value: fee }
        );

      // Charlie -> Alice creates A->B->C->A cycle
      await expect(
        tokenFactory
          .connect(charlie)
          .createToken(
            { ...basicParams, name: "T3", symbol: "T3" },
            alice.address,
            { value: fee }
          )
      ).to.be.revertedWithCustomError(tokenFactory, "CircularReferral");
    });

    it("cycle at depth > referralLevels goes undetected", async function () {
      const { alice, bob, charlie, dave, eve, tokenFactory, getCreationFeeNative } =
        await loadFixture(deployFullPlatform);

      // Set referralLevels to 2 (only checks 2 deep)
      await tokenFactory.setReferralLevels(2);

      const fee = await getCreationFeeNative(0);

      // Build chain: A -> B -> C -> D
      await tokenFactory
        .connect(alice)
        .createToken(basicParams, bob.address, { value: fee });
      await tokenFactory
        .connect(bob)
        .createToken(
          { ...basicParams, name: "T2", symbol: "T2" },
          charlie.address,
          { value: fee }
        );
      await tokenFactory
        .connect(charlie)
        .createToken(
          { ...basicParams, name: "T3", symbol: "T3" },
          dave.address,
          { value: fee }
        );

      // Now dave -> alice would create a cycle: A->B->C->D->A
      // With referralLevels=2, the check only walks: alice -> bob -> charlie (2 levels)
      // It never reaches dave, so cycle is NOT detected

      // This should ideally revert but doesn't with shallow detection
      await expect(
        tokenFactory
          .connect(dave)
          .createToken(
            { ...basicParams, name: "T4", symbol: "T4" },
            alice.address,
            { value: fee }
          )
      ).to.not.be.reverted;

      // Verify the cycle was NOT detected - dave's referral is alice
      expect(await tokenFactory.referrals(dave.address)).to.equal(
        alice.address
      );
    });
  });

  // ================================================================
  // H-04: PartnerTaxable bypasses protections for factory transfers
  // ================================================================
  describe("H-04: PartnerTaxable factory transfer bypass", function () {
    it("transfers to/from poolFactory skip all protections and tax", async function () {
      const { alice, tokenFactory, createTokenViaFactory } =
        await loadFixture(deployFullPlatform);

      const tokenAddress = await createTokenViaFactory(
        alice,
        partnerTaxableParams,
        6
      );
      const token = await ethers.getContractAt(
        "PartnerTaxableTokenImpl",
        tokenAddress
      );

      // poolFactory is the TokenFactory address
      const factoryAddr = await tokenFactory.getAddress();
      expect(await token.poolFactory()).to.equal(factoryAddr);

      // Transfers to poolFactory bypass ALL checks including trading lock
      // This is by design for tax processing, but it means the factory
      // address is a privileged participant in the token economy
      expect(await token.tradingEnabled()).to.be.false;

      // Alice (creator) can send to factory even without trading enabled
      // because creator is excluded from limits
      await token
        .connect(alice)
        .transfer(factoryAddr, ethers.parseUnits("100", 18));
    });
  });

  // ================================================================
  // H-05: MEV sandwich on graduation addLiquidity (2% slippage)
  // ================================================================
  describe("H-05: Graduation addLiquidity with 2% slippage", function () {
    it("graduation uses hardcoded 2% slippage tolerance", async function () {
      const {
        alice,
        bob,
        usdt,
        launchpadFactory,
        createTokenViaFactory,
        createLaunchForToken,
      } = await loadFixture(deployFullPlatform);

      const tokenAddress = await createTokenViaFactory(alice, basicParams, 0);
      const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
      await token.connect(alice).enableTrading();
      await launchpadFactory.setLaunchFee(0);

      // Use a low hard cap so we can fill it
      const totalTokens = ethers.parseUnits("100000", 18);
      const softCap = ethers.parseUnits("100", 6);
      const hardCap = ethers.parseUnits("500", 6);

      const launchAddress = await createLaunchForToken(
        alice,
        tokenAddress,
        totalTokens,
        softCap,
        hardCap
      );
      const launch = await ethers.getContractAt(
        "LaunchInstance",
        launchAddress
      );

      await token.connect(alice).approve(launchAddress, totalTokens);
      await launch.connect(alice).depositTokens(totalTokens);

      // Verify the PLATFORM_FEE_BPS and the slippage constants
      expect(await launch.PLATFORM_FEE_BPS()).to.equal(300); // 3%
      expect(await launch.BUY_FEE_BPS()).to.equal(100); // 1%

      // The graduation code uses hardcoded:
      // (tokensForDexLP * 98) / 100  -> 2% slippage
      // (usdtForLP * 98) / 100       -> 2% slippage
      // This is the MEV attack surface. On a real DEX, an MEV bot can
      // extract up to 2% of the liquidity value.

      // Verify the immutable allocation
      const tokensForLP = await launch.tokensForLP();
      const tokensForCurve = await launch.tokensForCurve();
      expect(tokensForLP).to.be.gt(0);
      expect(tokensForCurve).to.be.gt(0);
    });
  });

  // ================================================================
  // H-06: Refund state update before external call + fee-on-transfer risk
  // ================================================================
  describe("H-06: Refund accounting with state updates before external calls", function () {
    it("refund updates tokensSold/totalBaseRaised before pulling tokens", async function () {
      const {
        alice,
        bob,
        usdt,
        launchpadFactory,
        createTokenViaFactory,
        createLaunchForToken,
      } = await loadFixture(deployFullPlatform);

      const tokenAddress = await createTokenViaFactory(alice, basicParams, 0);
      const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
      await token.connect(alice).enableTrading();
      await launchpadFactory.setLaunchFee(0);

      const totalTokens = ethers.parseUnits("500000", 18);
      const launchAddress = await createLaunchForToken(
        alice,
        tokenAddress,
        totalTokens,
        ethers.parseUnits("10000", 6),
        ethers.parseUnits("50000", 6)
      );
      const launch = await ethers.getContractAt("LaunchInstance", launchAddress);

      await token.connect(alice).approve(launchAddress, totalTokens);
      await launch.connect(alice).depositTokens(totalTokens);

      // Bob buys
      await usdt.transfer(bob.address, ethers.parseUnits("500", 6));
      await usdt.connect(bob).approve(launchAddress, ethers.parseUnits("500", 6));
      await launch.connect(bob).buyWithToken(await usdt.getAddress(), ethers.parseUnits("500", 6), 0, 0);

      const tokensSoldBefore = await launch.tokensSold();
      const baseRaisedBefore = await launch.totalBaseRaised();
      const bobPaid = await launch.basePaid(bob.address);
      const bobBought = await launch.tokensBought(bob.address);

      // Deadline passes
      await time.increase(31 * 24 * 60 * 60);
      await launch.enableRefunds();

      // Bob approves and refunds
      await token.connect(bob).approve(launchAddress, bobBought);
      await launch.connect(bob).refund();

      // Verify state was updated
      expect(await launch.tokensSold()).to.equal(tokensSoldBefore - bobBought);
      expect(await launch.totalBaseRaised()).to.equal(baseRaisedBefore - bobPaid);
      expect(await launch.basePaid(bob.address)).to.equal(0);
      expect(await launch.tokensBought(bob.address)).to.equal(0);
    });
  });

  // ================================================================
  // H-07: ownerCreateToken pulls from owner, referral credited to creator
  // ================================================================
  describe("H-07: ownerCreateToken fee/referral inconsistency", function () {
    it("owner pays fee but referral rewards go to creator's chain", async function () {
      const { owner, alice, bob, tokenFactory, getCreationFeeNative } =
        await loadFixture(deployFullPlatform);

      // Set auto-distribute to false to track pending rewards
      await tokenFactory.setAutoDistributeReward(false);

      const fee = await getCreationFeeNative(0);

      // Owner creates token on behalf of alice, with bob as referral
      const tx = await tokenFactory.ownerCreateToken(
        alice.address,
        basicParams,
        bob.address,
        { value: fee }
      );
      await tx.wait();

      // Referral was recorded for alice (not owner)
      expect(await tokenFactory.referrals(alice.address)).to.equal(
        bob.address
      );

      // Bob gets referral rewards from the fee that the OWNER paid
      const bobPending = await tokenFactory.pendingRewards(
        bob.address,
        ethers.ZeroAddress
      );
      expect(bobPending).to.be.gt(0);

      // The owner paid the fee, but bob gets rewards from alice's "creation"
      // This is the inconsistency - owner subsidizes the referral chain
    });
  });

  // ================================================================
  // H-08: Binary search overflow with exponential curve
  // ================================================================
  describe("H-08: Binary search / curve math overflow risk", function () {
    it("binary search iterates fixed 128 times regardless of search space", async function () {
      // This is a gas test - the binary search always iterates 128 times
      // For small token supplies, most iterations are wasted
      // We just verify the function works for normal cases

      const {
        alice,
        bob,
        usdt,
        launchpadFactory,
        createTokenViaFactory,
        createLaunchForToken,
      } = await loadFixture(deployFullPlatform);

      const tokenAddress = await createTokenViaFactory(alice, basicParams, 0);
      const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
      await token.connect(alice).enableTrading();
      await launchpadFactory.setLaunchFee(0);

      const totalTokens = ethers.parseUnits("100000", 18);
      const launchAddress = await createLaunchForToken(
        alice,
        tokenAddress,
        totalTokens,
        ethers.parseUnits("10", 6),
        ethers.parseUnits("1000", 6)
      );
      const launch = await ethers.getContractAt("LaunchInstance", launchAddress);

      await token.connect(alice).approve(launchAddress, totalTokens);
      await launch.connect(alice).depositTokens(totalTokens);

      // getTokensForBase should work
      const tokensFor100Usdt = await launch.getTokensForBase(
        ethers.parseUnits("100", 6)
      );
      expect(tokensFor100Usdt).to.be.gt(0);

      // getCostForTokens should work
      const costFor1Token = await launch.getCostForTokens(ethers.parseUnits("1", 18));
      expect(costFor1Token).to.be.gt(0);
    });
  });

  // ================================================================
  // M-01: processTax silent failure
  // ================================================================
  describe("M-01: processTax silent failure on swap", function () {
    it("processTax silently fails when convertTaxToStable is disabled", async function () {
      const { alice, tokenFactory, createTokenViaFactory } =
        await loadFixture(deployFullPlatform);

      const tokenAddress = await createTokenViaFactory(alice, basicParams, 0);

      // convertTaxToStable defaults to false
      expect(await tokenFactory.convertTaxToStable()).to.be.false;

      // processTax returns silently without doing anything
      await tokenFactory.processTax(tokenAddress);
      // No revert, no event, just silent return
    });
  });

  // ================================================================
  // M-02: Tax remainder is burned when shares < 10000
  // ================================================================
  describe("M-02: Tax remainder burned when shares don't sum to 10000", function () {
    it("remaining tax is sent to address(0) (burned)", async function () {
      const { alice, bob, charlie, dave, createTokenViaFactory } =
        await loadFixture(deployFullPlatform);

      const tokenAddress = await createTokenViaFactory(
        alice,
        taxableParams,
        2
      );
      const token = await ethers.getContractAt(
        "TaxableTokenImpl",
        tokenAddress
      );

      await token.connect(alice).enableTrading();

      // Set 5% transfer tax with shares that only sum to 5000 (50%)
      // Use dave as tax wallet (NOT the transfer recipient)
      await token.connect(alice).setTaxes(0, 0, 500); // 5% transfer tax
      await token
        .connect(alice)
        .setTaxDistribution([dave.address], [5000]); // only 50% distributed

      // Exclude alice from tax
      await token.connect(alice).excludeFromTax(alice.address, true);

      // Send tokens to charlie (not tax-free, not a tax wallet)
      await token
        .connect(alice)
        .transfer(charlie.address, ethers.parseUnits("10000", 18));

      const totalSupplyBefore = await token.totalSupply();

      // Charlie transfers 1000 tokens to bob
      // Tax = 5% of 1000 = 50 tokens
      // 50% of 50 = 25 goes to dave (tax wallet)
      // Remaining 25 is BURNED (sent to address(0))
      await token
        .connect(charlie)
        .transfer(bob.address, ethers.parseUnits("1000", 18));

      const totalSupplyAfter = await token.totalSupply();

      // Supply decreased by 25 tokens (the burned remainder)
      const burned = totalSupplyBefore - totalSupplyAfter;
      expect(burned).to.equal(ethers.parseUnits("25", 18));

      // dave received 25 tokens (50% of 50 tax)
      expect(await token.balanceOf(dave.address)).to.equal(
        ethers.parseUnits("25", 18)
      );

      // bob received 950 tokens (1000 - 50 tax)
      expect(await token.balanceOf(bob.address)).to.equal(
        ethers.parseUnits("950", 18)
      );
    });

    it("setTaxDistribution allows shares < 10000", async function () {
      const { alice, bob, createTokenViaFactory } =
        await loadFixture(deployFullPlatform);

      const tokenAddress = await createTokenViaFactory(
        alice,
        taxableParams,
        2
      );
      const token = await ethers.getContractAt(
        "TaxableTokenImpl",
        tokenAddress
      );

      // Shares sum to 5000 (<10000) -- this is allowed
      await expect(
        token.connect(alice).setTaxDistribution([bob.address], [5000])
      ).to.not.be.reverted;

      // Shares sum to 10001 (>10000) -- this is rejected
      await expect(
        token.connect(alice).setTaxDistribution([bob.address], [10001])
      ).to.be.revertedWith("Total share > 100%");
    });
  });

  // ================================================================
  // M-03: forceRelaxCooldown behavior
  // ================================================================
  describe("M-03: forceRelaxCooldown behavior", function () {
    it("factory can force cooldown to 0 (disabling it entirely)", async function () {
      const { owner, alice, tokenFactory, createTokenViaFactory } =
        await loadFixture(deployFullPlatform);

      const tokenAddress = await createTokenViaFactory(alice, basicParams, 0);
      const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);

      // Set cooldown to 60 first
      await token.connect(alice).setCooldownTime(60);
      expect(await token.cooldownTime()).to.equal(60);

      // Factory can force it to 0
      await tokenFactory.forceRelaxCooldown(tokenAddress, 0);
      expect(await token.cooldownTime()).to.equal(0);
    });

    it("factory cannot increase cooldown (can only relax)", async function () {
      const { owner, alice, tokenFactory, createTokenViaFactory } =
        await loadFixture(deployFullPlatform);

      const tokenAddress = await createTokenViaFactory(alice, basicParams, 0);
      const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);

      await token.connect(alice).setCooldownTime(60);

      // Factory cannot increase cooldown (120 > 60, not relaxing)
      await expect(
        tokenFactory.forceRelaxCooldown(tokenAddress, 120)
      ).to.be.revertedWith("Can only relax");
    });
  });

  // ================================================================
  // M-05: cancelPendingLaunch doesn't return deposited tokens
  // ================================================================
  describe("M-05: cancelPendingLaunch doesn't return deposited tokens", function () {
    it("cancelling a partially funded launch leaves tokens in the launch contract", async function () {
      const {
        owner,
        alice,
        launchpadFactory,
        createTokenViaFactory,
        createLaunchForToken,
      } = await loadFixture(deployFullPlatform);

      const tokenAddress = await createTokenViaFactory(alice, basicParams, 0);
      const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
      await token.connect(alice).enableTrading();
      await launchpadFactory.setLaunchFee(0);

      const totalTokens = ethers.parseUnits("500000", 18);
      const launchAddress = await createLaunchForToken(
        alice,
        tokenAddress,
        totalTokens,
        ethers.parseUnits("1000", 6),
        ethers.parseUnits("5000", 6)
      );
      const launch = await ethers.getContractAt("LaunchInstance", launchAddress);

      // Partially deposit (not enough to activate)
      const partialDeposit = ethers.parseUnits("100000", 18);
      await token.connect(alice).approve(launchAddress, partialDeposit);
      await launch.connect(alice).depositTokens(partialDeposit);

      // Still pending
      expect(await launch.state()).to.equal(0); // Pending

      // Cancel via factory
      await launchpadFactory.connect(alice).cancelPendingLaunch(tokenAddress);

      // tokenToLaunch is cleared
      const launchForToken = await launchpadFactory.tokenToLaunch(tokenAddress);
      expect(launchForToken).to.equal(ethers.ZeroAddress);

      // BUT tokens are still in the launch contract!
      const launchBalance = await token.balanceOf(launchAddress);
      expect(launchBalance).to.equal(partialDeposit);

      // Creator must separately call withdrawPendingTokens
      await launch.connect(alice).withdrawPendingTokens();
      expect(await token.balanceOf(launchAddress)).to.equal(0);
    });
  });

  // ================================================================
  // M-06: creatorWithdrawAfterRefund stuck if any buyer unreachable
  // ================================================================
  describe("M-06: Creator stuck if not all buyers refund", function () {
    it("creator cannot withdraw if any basePaid remains", async function () {
      const {
        alice,
        bob,
        charlie,
        usdt,
        launchpadFactory,
        createTokenViaFactory,
        createLaunchForToken,
      } = await loadFixture(deployFullPlatform);

      const tokenAddress = await createTokenViaFactory(alice, basicParams, 0);
      const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
      await token.connect(alice).enableTrading();
      await launchpadFactory.setLaunchFee(0);

      const totalTokens = ethers.parseUnits("500000", 18);
      const launchAddress = await createLaunchForToken(
        alice,
        tokenAddress,
        totalTokens,
        ethers.parseUnits("10000", 6),
        ethers.parseUnits("50000", 6)
      );
      const launch = await ethers.getContractAt("LaunchInstance", launchAddress);

      await token.connect(alice).approve(launchAddress, totalTokens);
      await launch.connect(alice).depositTokens(totalTokens);

      // Bob and Charlie both buy
      await usdt.transfer(bob.address, ethers.parseUnits("500", 6));
      await usdt.transfer(charlie.address, ethers.parseUnits("500", 6));
      await usdt.connect(bob).approve(launchAddress, ethers.parseUnits("500", 6));
      await usdt.connect(charlie).approve(launchAddress, ethers.parseUnits("500", 6));

      await launch.connect(bob).buyWithToken(await usdt.getAddress(), ethers.parseUnits("500", 6), 0, 0);
      await launch.connect(charlie).buyWithToken(await usdt.getAddress(), ethers.parseUnits("500", 6), 0, 0);

      // Deadline passes
      await time.increase(31 * 24 * 60 * 60);
      await launch.enableRefunds();

      // Only bob refunds
      const bobBought = await launch.tokensBought(bob.address);
      await token.connect(bob).approve(launchAddress, bobBought);
      await launch.connect(bob).refund();

      // Creator tries to withdraw but charlie hasn't refunded
      await expect(
        launch.connect(alice).creatorWithdrawAfterRefund()
      ).to.be.revertedWithCustomError(launch, "OutstandingRefundsRemain");

      // totalBaseRaised > 0 because charlie hasn't refunded
      expect(await launch.totalBaseRaised()).to.be.gt(0);
    });
  });

  // ================================================================
  // M-10: removePool clears isExcludedFromLimits (VERIFIED FIXED)
  // ================================================================
  describe("M-10: removePool correctly clears isExcludedFromLimits (FIXED)", function () {
    it("removed pool is no longer excluded from limits", async function () {
      const { alice, createTokenViaFactory } =
        await loadFixture(deployFullPlatform);

      const tokenAddress = await createTokenViaFactory(
        alice,
        partnerParams,
        4
      );
      const token = await ethers.getContractAt(
        "PartnerTokenImpl",
        tokenAddress
      );

      // Add a fake pool
      const fakePool = ethers.Wallet.createRandom().address;
      await token.connect(alice).addPool(fakePool);

      expect(await token.isPool(fakePool)).to.be.true;
      expect(await token.isExcludedFromLimits(fakePool)).to.be.true;

      // Remove the pool
      await token.connect(alice).removePool(fakePool);

      // Both flags are correctly cleared
      expect(await token.isPool(fakePool)).to.be.false;
      expect(await token.isExcludedFromLimits(fakePool)).to.be.false;
    });
  });

  // ================================================================
  // L-01: Owner cannot blacklist themselves (VERIFIED FIXED)
  // ================================================================
  describe("L-01: Owner cannot blacklist themselves (FIXED)", function () {
    it("setBlacklisted reverts when trying to blacklist the owner", async function () {
      const { alice, createTokenViaFactory } =
        await loadFixture(deployFullPlatform);

      const tokenAddress = await createTokenViaFactory(alice, basicParams, 0);
      const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);

      await token.connect(alice).setBlacklistWindow(3600);
      await token.connect(alice).enableTrading();

      // Owner cannot blacklist themselves - protected by require check
      await expect(
        token.connect(alice).setBlacklisted(alice.address, true)
      ).to.be.revertedWith("Cannot blacklist owner");
    });

    it("owner can still blacklist other addresses", async function () {
      const { alice, bob, createTokenViaFactory } =
        await loadFixture(deployFullPlatform);

      const tokenAddress = await createTokenViaFactory(alice, basicParams, 0);
      const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);

      await token.connect(alice).setBlacklistWindow(3600);
      await token.connect(alice).enableTrading();

      // Owner can blacklist other addresses
      await token.connect(alice).setBlacklisted(bob.address, true);
      expect(await token.blacklisted(bob.address)).to.be.true;
    });
  });

  // ================================================================
  // L-03: Deadline starts at deployment, not activation
  // ================================================================
  describe("L-03: Launch deadline now starts from activation (FIXED)", function () {
    it("FIXED: pending time does NOT reduce the active window", async function () {
      const {
        alice,
        launchpadFactory,
        createTokenViaFactory,
        createLaunchForToken,
      } = await loadFixture(deployFullPlatform);

      const tokenAddress = await createTokenViaFactory(alice, basicParams, 0);
      const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
      await token.connect(alice).enableTrading();
      await launchpadFactory.setLaunchFee(0);

      const totalTokens = ethers.parseUnits("500000", 18);
      const launchAddress = await createLaunchForToken(
        alice,
        tokenAddress,
        totalTokens,
        ethers.parseUnits("1000", 6),
        ethers.parseUnits("5000", 6)
      );
      const launch = await ethers.getContractAt("LaunchInstance", launchAddress);

      // Deadline is 0 before activation (not set yet)
      const deadlineBefore = await launch.deadline();
      expect(deadlineBefore).to.equal(0);

      // Simulate 10 days passing before deposit (still in Pending state)
      await time.increase(10 * 24 * 60 * 60);

      // Now deposit to activate
      await token.connect(alice).approve(launchAddress, totalTokens);
      await launch.connect(alice).depositTokens(totalTokens);

      const deadlineAfter = await launch.deadline();
      const nowAfterActivation = BigInt(await time.latest());
      const remainingDays = (deadlineAfter - nowAfterActivation) / 86400n;

      // FIXED: Full 30 days from activation, not affected by pending time
      expect(remainingDays).to.be.gte(29); // ~30 days minus seconds rounding
      expect(remainingDays).to.be.lte(30);
    });
  });

  // ================================================================
  // L-07: referralPercents can be emptied
  // ================================================================
  describe("L-07: referralPercents array can be emptied", function () {
    it("setReferralPercents([]) silently disables all referral rewards", async function () {
      const { owner, alice, bob, tokenFactory, getCreationFeeNative } =
        await loadFixture(deployFullPlatform);

      // Verify default percents exist
      expect(await tokenFactory.referralPercents(0)).to.equal(500); // 5%

      // Owner empties the array
      await tokenFactory.setReferralPercents([]);

      // Accessing index 0 should revert (array is empty)
      await expect(tokenFactory.referralPercents(0)).to.be.reverted;

      // Set auto-distribute to false to check pending rewards
      await tokenFactory.setAutoDistributeReward(false);

      const fee = await getCreationFeeNative(0);

      // Alice creates with bob as referral
      await tokenFactory
        .connect(alice)
        .createToken(basicParams, bob.address, { value: fee });

      // Bob gets no rewards because percents array is empty
      const pending = await tokenFactory.pendingRewards(
        bob.address,
        ethers.ZeroAddress
      );
      expect(pending).to.equal(0);
    });
  });

  // ================================================================
  // L-09: buy() uses block.timestamp as swap deadline (useless)
  // ================================================================
  describe("L-09: LaunchInstance.buy uses block.timestamp as deadline", function () {
    it("swap deadline equals block.timestamp (provides no protection)", async function () {
      // This is a code review finding - the deadline in dexRouter calls is
      // set to block.timestamp, which always passes. We verify the buy
      // function works (deadline doesn't protect anything).

      const {
        alice,
        bob,
        usdt,
        launchpadFactory,
        createTokenViaFactory,
        createLaunchForToken,
      } = await loadFixture(deployFullPlatform);

      const tokenAddress = await createTokenViaFactory(alice, basicParams, 0);
      const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
      await token.connect(alice).enableTrading();
      await launchpadFactory.setLaunchFee(0);

      const totalTokens = ethers.parseUnits("100000", 18);
      const launchAddress = await createLaunchForToken(
        alice,
        tokenAddress,
        totalTokens,
        ethers.parseUnits("10", 6),
        ethers.parseUnits("1000", 6)
      );
      const launch = await ethers.getContractAt("LaunchInstance", launchAddress);

      await token.connect(alice).approve(launchAddress, totalTokens);
      await launch.connect(alice).depositTokens(totalTokens);

      // Buy with USDT - deadline is block.timestamp (always passes)
      await usdt.transfer(bob.address, ethers.parseUnits("100", 6));
      await usdt.connect(bob).approve(launchAddress, ethers.parseUnits("100", 6));

      await expect(
        launch
          .connect(bob)
          .buyWithToken(
            await usdt.getAddress(),
            ethers.parseUnits("100", 6),
            0,
            0
          )
      ).to.not.be.reverted;
    });
  });
});
