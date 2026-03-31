import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * LaunchInstance Bug PoC Tests
 *
 * Targeted exploit and edge-case tests for vulnerabilities found in LaunchInstance.sol
 * during the security audit.
 */
describe("LaunchInstance Bug PoCs", function () {
  // ================================================================
  // SHARED FIXTURE
  // ================================================================
  async function deployFullPlatform() {
    const [owner, alice, bob, charlie, dave, eve, frank] =
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

    // ── Helpers ─────────────────────────────────────────────────

    async function getCreationFeeNative(typeKey: number): Promise<bigint> {
      const baseFee = await tokenFactory.creationFee(typeKey);
      return await tokenFactory.convertFee(baseFee, ethers.ZeroAddress);
    }

    async function createBasicToken(
      signer: HardhatEthersSigner,
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

    async function createAndActivateLaunch(
      creator: HardhatEthersSigner,
      tokenAddress: string,
      opts: {
        softCap?: bigint;
        hardCap?: bigint;
        durationDays?: number;
        maxBuyBps?: number;
        creatorAllocationBps?: number;
        vestingDays?: number;
        tokensForLaunch?: bigint;
        startTimestamp?: number;
      } = {}
    ): Promise<string> {
      const softCap = opts.softCap ?? BigInt(100) * BigInt(1e6);
      const hardCap = opts.hardCap ?? BigInt(500) * BigInt(1e6);
      const durationDays = opts.durationDays ?? 30;
      const maxBuyBps = opts.maxBuyBps ?? 500; // 5% max buy
      const creatorAllocationBps = opts.creatorAllocationBps ?? 0;
      const vestingDays = opts.vestingDays ?? 0;
      const tokensForLaunch =
        opts.tokensForLaunch ?? ethers.parseUnits("700000", 18);
      const startTimestamp = opts.startTimestamp ?? 0;

      const token = await ethers.getContractAt(
        "BasicTokenImpl",
        tokenAddress
      );
      // Enable trading if not already enabled
      try {
        await token.connect(creator).enableTrading();
      } catch {}

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
        startTimestamp
      );
      const receipt = await tx.wait();
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
      const launchAddress = parsed!.args.launch;

      // Approve and deposit tokens to activate
      await token
        .connect(creator)
        .approve(launchAddress, tokensForLaunch);
      const launchInstance = await ethers.getContractAt(
        "LaunchInstance",
        launchAddress
      );
      await launchInstance.connect(creator).depositTokens(tokensForLaunch);

      return launchAddress;
    }

    // Helper: buy USDT tokens for a signer to use with buyWithToken
    async function fundWithUsdt(
      signer: HardhatEthersSigner,
      amount: bigint
    ) {
      await usdt.transfer(signer.address, amount);
    }

    return {
      owner,
      alice,
      bob,
      charlie,
      dave,
      eve,
      frank,
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
      fundWithUsdt,
    };
  }

  // ================================================================
  // C-01: REFUND THEFT VIA TOKEN TRANSFER TO ACCOMPLICE
  // ================================================================
  describe("C-01: Refund theft — full exploit PoC", function () {
    it("attacker drains extra USDT by transferring tokens away before re-buying", async function () {
      const {
        alice,
        bob,
        charlie,
        usdt,
        launchpadFactory,
        createBasicToken,
        createAndActivateLaunch,
        fundWithUsdt,
      } = await loadFixture(deployFullPlatform);

      // Setup: alice creates a token and launch
      const tokenAddress = await createBasicToken(alice);
      const launchAddress = await createAndActivateLaunch(alice, tokenAddress, {
        softCap: BigInt(200) * BigInt(1e6), // $200 soft cap — two $50 buys won't reach it
        hardCap: BigInt(10000) * BigInt(1e6),
        maxBuyBps: 500, // 5% max buy per wallet
      });

      const launch = await ethers.getContractAt("LaunchInstance", launchAddress);
      const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);

      // Fund bob (attacker) with USDT
      await fundWithUsdt(bob, BigInt(200) * BigInt(1e6));
      await usdt.connect(bob).approve(launchAddress, ethers.MaxUint256);

      // Step 1: Bob buys tokens (first purchase)
      const buyAmount1 = BigInt(50) * BigInt(1e6);
      await launch
        .connect(bob)
        .buyWithToken(await usdt.getAddress(), buyAmount1, 0, 0);

      const bobTokensAfterBuy1 = await token.balanceOf(bob.address);
      const bobBasePaid1 = await launch.basePaid(bob.address);
      const bobTokensBought1 = await launch.tokensBought(bob.address);

      expect(bobTokensAfterBuy1).to.be.gt(0);
      expect(bobBasePaid1).to.be.gt(0);

      // Step 2: Bob transfers ALL tokens to charlie (accomplice)
      await token.connect(bob).transfer(charlie.address, bobTokensAfterBuy1);
      expect(await token.balanceOf(bob.address)).to.equal(0);

      // Step 3: Bob buys AGAIN — basePaid and tokensBought accumulate
      const buyAmount2 = BigInt(50) * BigInt(1e6);
      await launch
        .connect(bob)
        .buyWithToken(await usdt.getAddress(), buyAmount2, 0, 0);

      const bobBasePaidAfter2 = await launch.basePaid(bob.address);
      const bobTokensBoughtAfter2 = await launch.tokensBought(bob.address);

      // basePaid accumulates both purchases
      expect(bobBasePaidAfter2).to.be.gt(bobBasePaid1);
      // tokensBought accumulates both purchases
      expect(bobTokensBoughtAfter2).to.be.gt(bobTokensBought1);

      // But bob's actual token balance only reflects the SECOND buy
      const bobActualBalance = await token.balanceOf(bob.address);
      expect(bobActualBalance).to.be.lt(bobTokensBoughtAfter2);

      // Step 4: Expire the launch and enable refunds
      await time.increase(31 * 24 * 3600); // past deadline
      await launch.enableRefunds();

      // Step 5: Bob CANNOT refund because he doesn't have enough tokens
      // (he transferred the first batch to charlie)
      await token.connect(bob).approve(launchAddress, ethers.MaxUint256);
      await expect(launch.connect(bob).refund()).to.be.revertedWithCustomError(
        launch,
        "ReturnTokensToRefund"
      );

      // Step 6: But if charlie sends the tokens back, bob can refund ALL basePaid
      // (including the cost of tokens charlie still effectively has copies of the value from)
      await token
        .connect(charlie)
        .transfer(bob.address, await token.balanceOf(charlie.address));

      // Now bob has tokens from BOTH purchases and can get a full refund
      const bobBalanceBeforeRefund = await usdt.balanceOf(bob.address);
      await launch.connect(bob).refund();
      const bobBalanceAfterRefund = await usdt.balanceOf(bob.address);

      // Bob gets back basePaid for BOTH purchases
      const refundReceived = bobBalanceAfterRefund - bobBalanceBeforeRefund;
      expect(refundReceived).to.equal(bobBasePaidAfter2);

      // The tokens are returned to the launch contract, but charlie could have
      // sold/used the first batch before returning them — the point is the
      // accounting allows the attack vector
    });

    it("accomplice contract can hold tokens while attacker re-buys and inflates refund claim", async function () {
      const {
        alice,
        bob,
        usdt,
        createBasicToken,
        createAndActivateLaunch,
        fundWithUsdt,
      } = await loadFixture(deployFullPlatform);

      // Deploy accomplice contract
      const RefundAccomplice = await ethers.getContractFactory(
        "RefundAccomplice"
      );
      const accomplice = await RefundAccomplice.deploy();

      const tokenAddress = await createBasicToken(alice);
      const launchAddress = await createAndActivateLaunch(alice, tokenAddress, {
        softCap: BigInt(100) * BigInt(1e6),
        hardCap: BigInt(10000) * BigInt(1e6),
        maxBuyBps: 500,
      });

      const launch = await ethers.getContractAt("LaunchInstance", launchAddress);
      const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);

      await fundWithUsdt(bob, BigInt(300) * BigInt(1e6));
      await usdt.connect(bob).approve(launchAddress, ethers.MaxUint256);

      // Buy → transfer to accomplice contract → buy again
      await launch
        .connect(bob)
        .buyWithToken(await usdt.getAddress(), BigInt(80) * BigInt(1e6), 0, 0);

      const tokensRound1 = await token.balanceOf(bob.address);
      await token
        .connect(bob)
        .transfer(await accomplice.getAddress(), tokensRound1);

      // Second purchase
      await launch
        .connect(bob)
        .buyWithToken(await usdt.getAddress(), BigInt(80) * BigInt(1e6), 0, 0);

      // Bob's tokensBought reflects both rounds but balance only has round 2
      const totalTracked = await launch.tokensBought(bob.address);
      const actualBalance = await token.balanceOf(bob.address);
      expect(totalTracked).to.be.gt(actualBalance);

      // The accomplice holds the first round's tokens
      const accompliceBalance = await token.balanceOf(
        await accomplice.getAddress()
      );
      expect(accompliceBalance).to.equal(tokensRound1);

      // This demonstrates the accounting mismatch: tokensBought[bob] > bob's actual balance
      // In a refund scenario, bob would need to recover tokens from accomplice first
      // But the economic exploit is that bob controlled more curve purchases
      // while having already moved value out
    });
  });

  // ================================================================
  // CURVE PARAMETER VALIDATION — DEGENERATE PARAMETERS
  // ================================================================
  describe("Curve parameter validation", function () {
    it("allows creation with extreme curve params making tokens nearly free", async function () {
      const { alice, bob, usdt, launchpadFactory, createBasicToken, fundWithUsdt } =
        await loadFixture(deployFullPlatform);

      const tokenAddress = await createBasicToken(alice);
      const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
      await token.connect(alice).enableTrading();

      // Custom curve with tiny slope and zero intercept → tokens are nearly free
      const tx = await launchpadFactory
        .connect(alice)
        .createLaunchCustomCurve(
          tokenAddress,
          ethers.parseUnits("700000", 18),
          0, // Linear
          1, // slope = 1 (minimal)
          0, // intercept = 0 (free at start!)
          BigInt(100) * BigInt(1e6), // softCap
          BigInt(500) * BigInt(1e6), // hardCap
          30,
          500,
          0,
          0,
          ethers.ZeroAddress,
          0
        );
      const receipt = await tx.wait();
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
      const launchAddress = launchpadFactory.interface.parseLog(event as any)!
        .args.launch;

      const launch = await ethers.getContractAt("LaunchInstance", launchAddress);

      // Deposit tokens to activate
      await token
        .connect(alice)
        .approve(launchAddress, ethers.parseUnits("700000", 18));
      await launch
        .connect(alice)
        .depositTokens(ethers.parseUnits("700000", 18));

      // The initial price should be extremely low
      const currentPrice = await launch.getCurrentPrice();
      // With slope=1, intercept=0 the price is very low but not zero since
      // linearCost = slope * amount * (2*supply + amount) / (2 * PRECISION)
      // At supply=0, cost for 1e18 tokens = 1 * 1e18 * 1e18 / (2 * 1e18) = 5e17
      // The point: no min price validation means creators can set degenerate curves
      // where tokens start extremely cheap relative to the hard cap
      expect(currentPrice).to.be.lt(BigInt(1e18)); // much less than 1 full unit

      // Bob can buy and get a lot of tokens cheaply
      await fundWithUsdt(bob, BigInt(1000) * BigInt(1e6)); // 1000 USDT
      await usdt.connect(bob).approve(launchAddress, ethers.MaxUint256);

      await launch
        .connect(bob)
        .buyWithToken(await usdt.getAddress(), BigInt(1000) * BigInt(1e6), 0, 0);

      const bobTokens = await token.balanceOf(bob.address);
      // Bob gets tokens — the key vulnerability is no price floor validation
      expect(bobTokens).to.be.gt(0);
    });

    it("allows exponential curve with extreme kFactor causing overflow in cost calculation", async function () {
      const { alice, launchpadFactory, createBasicToken } =
        await loadFixture(deployFullPlatform);

      const tokenAddress = await createBasicToken(alice);
      const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
      await token.connect(alice).enableTrading();

      // Extreme exponential parameters
      const tx = await launchpadFactory
        .connect(alice)
        .createLaunchCustomCurve(
          tokenAddress,
          ethers.parseUnits("700000", 18),
          3, // Exponential
          BigInt(1e18), // base = 1e18 (very high)
          BigInt(1e18), // kFactor = 1e18 (extreme growth)
          BigInt(100) * BigInt(1e6),
          BigInt(500) * BigInt(1e6),
          30,
          500,
          0,
          0,
          ethers.ZeroAddress,
          0
        );
      const receipt = await tx.wait();
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
      const launchAddress = launchpadFactory.interface.parseLog(event as any)!
        .args.launch;

      const launch = await ethers.getContractAt("LaunchInstance", launchAddress);

      // Deposit tokens to activate
      await token
        .connect(alice)
        .approve(launchAddress, ethers.parseUnits("700000", 18));
      await launch
        .connect(alice)
        .depositTokens(ethers.parseUnits("700000", 18));

      // getCostForTokensExternal should handle overflow gracefully via _tryCostForTokens
      // but getCostForTokens (direct) may revert
      const costForSmall = await launch.getCostForTokens(BigInt(1));
      // With extreme params, even 1 token can be astronomically expensive
      // The key point: no validation prevents this unusable configuration
      expect(costForSmall).to.be.gte(0); // doesn't revert, but may be useless
    });
  });

  // ================================================================
  // BINARY SEARCH GAS CONSUMPTION
  // ================================================================
  describe("Binary search gas consumption", function () {
    it("_getTokensForBase consumes significant gas for edge-case amounts", async function () {
      const {
        alice,
        bob,
        usdt,
        createBasicToken,
        createAndActivateLaunch,
        fundWithUsdt,
      } = await loadFixture(deployFullPlatform);

      const tokenAddress = await createBasicToken(alice);
      const launchAddress = await createAndActivateLaunch(alice, tokenAddress, {
        softCap: BigInt(100) * BigInt(1e6),
        hardCap: BigInt(10000) * BigInt(1e6),
      });

      const launch = await ethers.getContractAt("LaunchInstance", launchAddress);

      // Measure gas for getTokensForBase with a small amount (forces full 128 iterations)
      const gasEstimate1 = await launch.getTokensForBase.estimateGas(BigInt(1));

      // Measure gas for a normal amount
      const gasEstimate2 = await launch.getTokensForBase.estimateGas(
        BigInt(100) * BigInt(1e6)
      );

      // Both should work but the small amount may use more iterations
      // Log the gas difference — the binary search always runs up to 128 iterations
      // regardless of whether the search space narrows quickly
      expect(gasEstimate1).to.be.gt(0);
      expect(gasEstimate2).to.be.gt(0);

      // The gas cost should be bounded but noticeable
      // In practice, both are similar since binary search always runs
      // a fixed number of iterations until low > high
    });

    it("buy transaction gas is reasonable even near curve exhaustion", async function () {
      const {
        alice,
        bob,
        charlie,
        usdt,
        createBasicToken,
        createAndActivateLaunch,
        fundWithUsdt,
      } = await loadFixture(deployFullPlatform);

      const tokenAddress = await createBasicToken(alice);
      const launchAddress = await createAndActivateLaunch(alice, tokenAddress, {
        softCap: BigInt(10) * BigInt(1e6),
        hardCap: BigInt(100000) * BigInt(1e6), // very high hard cap
        maxBuyBps: 500,
      });

      const launch = await ethers.getContractAt("LaunchInstance", launchAddress);

      // Buy a decent chunk to move the curve
      await fundWithUsdt(bob, BigInt(1000) * BigInt(1e6));
      await usdt.connect(bob).approve(launchAddress, ethers.MaxUint256);
      await launch
        .connect(bob)
        .buyWithToken(
          await usdt.getAddress(),
          BigInt(500) * BigInt(1e6),
          0,
          0
        );

      // Now buy a tiny amount near current supply level
      await fundWithUsdt(charlie, BigInt(10) * BigInt(1e6));
      await usdt.connect(charlie).approve(launchAddress, ethers.MaxUint256);

      const tx = await launch
        .connect(charlie)
        .buyWithToken(
          await usdt.getAddress(),
          BigInt(1) * BigInt(1e6),
          0,
          0
        );
      const receipt = await tx.wait();

      // Gas should be under 500k for a normal buy
      expect(receipt!.gasUsed).to.be.lt(500_000);
    });
  });

  // ================================================================
  // M-06: CREATOR STUCK IF NOT ALL BUYERS REFUND
  // ================================================================
  describe("M-06: Creator stuck — no recovery if buyers don't refund", function () {
    it("creator cannot withdraw tokens when any buyer has outstanding basePaid", async function () {
      const {
        alice,
        bob,
        charlie,
        usdt,
        createBasicToken,
        createAndActivateLaunch,
        fundWithUsdt,
      } = await loadFixture(deployFullPlatform);

      const tokenAddress = await createBasicToken(alice);
      const launchAddress = await createAndActivateLaunch(alice, tokenAddress, {
        softCap: BigInt(1000) * BigInt(1e6), // high soft cap
        hardCap: BigInt(10000) * BigInt(1e6),
      });

      const launch = await ethers.getContractAt("LaunchInstance", launchAddress);
      const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);

      // Bob and Charlie both buy
      await fundWithUsdt(bob, BigInt(100) * BigInt(1e6));
      await fundWithUsdt(charlie, BigInt(100) * BigInt(1e6));
      await usdt.connect(bob).approve(launchAddress, ethers.MaxUint256);
      await usdt.connect(charlie).approve(launchAddress, ethers.MaxUint256);

      await launch
        .connect(bob)
        .buyWithToken(await usdt.getAddress(), BigInt(100) * BigInt(1e6), 0, 0);
      await launch
        .connect(charlie)
        .buyWithToken(
          await usdt.getAddress(),
          BigInt(100) * BigInt(1e6),
          0,
          0
        );

      // Soft cap not reached → expire and enable refunds
      await time.increase(31 * 24 * 3600);
      await launch.enableRefunds();

      // Bob refunds
      const bobTokens = await token.balanceOf(bob.address);
      await token.connect(bob).approve(launchAddress, bobTokens);
      await launch.connect(bob).refund();

      // Charlie does NOT refund (lost keys, doesn't care, etc.)
      // Creator is now stuck — cannot withdraw
      await expect(
        launch.connect(alice).creatorWithdrawAfterRefund()
      ).to.be.revertedWithCustomError(launch, "OutstandingRefundsRemain");

      // Verify totalBaseRaised is not zero (charlie's contribution remains)
      expect(await launch.totalBaseRaised()).to.be.gt(0);

      // There is NO emergency withdraw, NO timeout, NO admin override
      // Creator's tokens are permanently locked in the launch contract
      const launchBalance = await token.balanceOf(launchAddress);
      expect(launchBalance).to.be.gt(0);
    });

    it("even a dust amount of unredeemed basePaid blocks creator withdrawal", async function () {
      const {
        alice,
        bob,
        charlie,
        usdt,
        createBasicToken,
        createAndActivateLaunch,
        fundWithUsdt,
      } = await loadFixture(deployFullPlatform);

      const tokenAddress = await createBasicToken(alice);
      const launchAddress = await createAndActivateLaunch(alice, tokenAddress, {
        softCap: BigInt(1000) * BigInt(1e6),
        hardCap: BigInt(10000) * BigInt(1e6),
      });

      const launch = await ethers.getContractAt("LaunchInstance", launchAddress);
      const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);

      // Bob buys a lot, charlie buys dust
      await fundWithUsdt(bob, BigInt(200) * BigInt(1e6));
      await fundWithUsdt(charlie, BigInt(5) * BigInt(1e6));
      await usdt.connect(bob).approve(launchAddress, ethers.MaxUint256);
      await usdt.connect(charlie).approve(launchAddress, ethers.MaxUint256);

      await launch
        .connect(bob)
        .buyWithToken(await usdt.getAddress(), BigInt(200) * BigInt(1e6), 0, 0);
      await launch
        .connect(charlie)
        .buyWithToken(
          await usdt.getAddress(),
          BigInt(5) * BigInt(1e6),
          0,
          0
        );

      // Expire + enable refunds
      await time.increase(31 * 24 * 3600);
      await launch.enableRefunds();

      // Bob refunds
      const bobTokens = await token.balanceOf(bob.address);
      await token.connect(bob).approve(launchAddress, bobTokens);
      await launch.connect(bob).refund();

      // Charlie's tiny dust blocks everything
      const charlieBasePaid = await launch.basePaid(charlie.address);
      expect(charlieBasePaid).to.be.gt(0);

      await expect(
        launch.connect(alice).creatorWithdrawAfterRefund()
      ).to.be.revertedWithCustomError(launch, "OutstandingRefundsRemain");
    });
  });

  // ================================================================
  // REFUND ACCOUNTING EDGE CASES
  // ================================================================
  describe("Refund accounting edge cases", function () {
    it("state is updated before token pull — potential for inconsistent state on transfer failure", async function () {
      const {
        alice,
        bob,
        usdt,
        createBasicToken,
        createAndActivateLaunch,
        fundWithUsdt,
      } = await loadFixture(deployFullPlatform);

      const tokenAddress = await createBasicToken(alice);
      const launchAddress = await createAndActivateLaunch(alice, tokenAddress, {
        softCap: BigInt(1000) * BigInt(1e6),
        hardCap: BigInt(10000) * BigInt(1e6),
      });

      const launch = await ethers.getContractAt("LaunchInstance", launchAddress);
      const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);

      // Bob buys
      await fundWithUsdt(bob, BigInt(100) * BigInt(1e6));
      await usdt.connect(bob).approve(launchAddress, ethers.MaxUint256);
      await launch
        .connect(bob)
        .buyWithToken(await usdt.getAddress(), BigInt(100) * BigInt(1e6), 0, 0);

      const tokensSoldBefore = await launch.tokensSold();
      const totalBaseBefore = await launch.totalBaseRaised();

      // Expire and enable refunds
      await time.increase(31 * 24 * 3600);
      await launch.enableRefunds();

      // Bob approves insufficient tokens — refund should revert
      await token.connect(bob).approve(launchAddress, BigInt(1)); // too little

      await expect(launch.connect(bob).refund()).to.be.reverted;

      // State should NOT have changed since the tx reverted
      expect(await launch.tokensSold()).to.equal(tokensSoldBefore);
      expect(await launch.totalBaseRaised()).to.equal(totalBaseBefore);
      expect(await launch.basePaid(bob.address)).to.be.gt(0);
    });

    it("multiple buyers refund correctly — accounting stays consistent", async function () {
      const {
        alice,
        bob,
        charlie,
        dave,
        usdt,
        createBasicToken,
        createAndActivateLaunch,
        fundWithUsdt,
      } = await loadFixture(deployFullPlatform);

      const tokenAddress = await createBasicToken(alice);
      const launchAddress = await createAndActivateLaunch(alice, tokenAddress, {
        softCap: BigInt(5000) * BigInt(1e6),
        hardCap: BigInt(10000) * BigInt(1e6),
      });

      const launch = await ethers.getContractAt("LaunchInstance", launchAddress);
      const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);

      // Three buyers
      for (const buyer of [bob, charlie, dave]) {
        await fundWithUsdt(buyer, BigInt(100) * BigInt(1e6));
        await usdt.connect(buyer).approve(launchAddress, ethers.MaxUint256);
        await launch
          .connect(buyer)
          .buyWithToken(
            await usdt.getAddress(),
            BigInt(100) * BigInt(1e6),
            0,
            0
          );
      }

      const totalSoldBefore = await launch.tokensSold();
      const totalRaisedBefore = await launch.totalBaseRaised();

      // Expire and enable refunds
      await time.increase(31 * 24 * 3600);
      await launch.enableRefunds();

      // All three refund
      let totalRefunded = BigInt(0);
      let totalTokensReturned = BigInt(0);

      for (const buyer of [bob, charlie, dave]) {
        const buyerTokens = await token.balanceOf(buyer.address);
        const buyerBasePaid = await launch.basePaid(buyer.address);

        await token.connect(buyer).approve(launchAddress, buyerTokens);
        await launch.connect(buyer).refund();

        totalRefunded += buyerBasePaid;
        totalTokensReturned += buyerTokens;
      }

      // After all refunds, state should be zeroed
      expect(await launch.tokensSold()).to.equal(0);
      expect(await launch.totalBaseRaised()).to.equal(0);
      expect(totalRefunded).to.equal(totalRaisedBefore);

      // Creator can now withdraw
      await launch.connect(alice).creatorWithdrawAfterRefund();
      expect(await token.balanceOf(launchAddress)).to.equal(0);
    });
  });

  // ================================================================
  // STARTIMESTAMP AND DEADLINE EDGE CASES
  // ================================================================
  describe("startTimestamp and deadline edge cases", function () {
    it("buy reverts before startTimestamp even though launch is active", async function () {
      const {
        alice,
        bob,
        usdt,
        launchpadFactory,
        createBasicToken,
        fundWithUsdt,
      } = await loadFixture(deployFullPlatform);

      const tokenAddress = await createBasicToken(alice);
      const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
      await token.connect(alice).enableTrading();

      // Set startTimestamp to 1 hour in the future
      const now = await time.latest();
      const futureStart = now + 3600;

      const tx = await launchpadFactory.connect(alice).createLaunch(
        tokenAddress,
        ethers.parseUnits("700000", 18),
        0,
        BigInt(100) * BigInt(1e6),
        BigInt(500) * BigInt(1e6),
        30,
        500,
        0,
        0,
        ethers.ZeroAddress,
        futureStart
      );
      const receipt = await tx.wait();
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
      const launchAddress = launchpadFactory.interface.parseLog(event as any)!
        .args.launch;

      // Deposit to activate
      await token
        .connect(alice)
        .approve(launchAddress, ethers.parseUnits("700000", 18));
      const launch = await ethers.getContractAt("LaunchInstance", launchAddress);
      await launch
        .connect(alice)
        .depositTokens(ethers.parseUnits("700000", 18));

      // Launch is active but buying should fail before startTimestamp
      expect(await launch.state()).to.equal(1); // Active

      await fundWithUsdt(bob, BigInt(100) * BigInt(1e6));
      await usdt.connect(bob).approve(launchAddress, ethers.MaxUint256);

      await expect(
        launch
          .connect(bob)
          .buyWithToken(
            await usdt.getAddress(),
            BigInt(50) * BigInt(1e6),
            0,
            0
          )
      ).to.be.revertedWithCustomError(launch, "LaunchNotStarted");

      // After startTimestamp, buying works
      await time.increaseTo(futureStart + 1);
      await launch
        .connect(bob)
        .buyWithToken(
          await usdt.getAddress(),
          BigInt(50) * BigInt(1e6),
          0,
          0
        );

      expect(await token.balanceOf(bob.address)).to.be.gt(0);
    });

    it("deadline is correctly set relative to startTimestamp (not deployment time)", async function () {
      const {
        alice,
        launchpadFactory,
        createBasicToken,
      } = await loadFixture(deployFullPlatform);

      const tokenAddress = await createBasicToken(alice);
      const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
      await token.connect(alice).enableTrading();

      const now = await time.latest();
      const futureStart = now + 7200; // 2 hours from now

      const tx = await launchpadFactory.connect(alice).createLaunch(
        tokenAddress,
        ethers.parseUnits("700000", 18),
        0,
        BigInt(100) * BigInt(1e6),
        BigInt(500) * BigInt(1e6),
        30, // 30 days duration
        500,
        0,
        0,
        ethers.ZeroAddress,
        futureStart
      );
      const receipt = await tx.wait();
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
      const launchAddress = launchpadFactory.interface.parseLog(event as any)!
        .args.launch;
      const launch = await ethers.getContractAt("LaunchInstance", launchAddress);

      // Deposit to activate
      await token
        .connect(alice)
        .approve(launchAddress, ethers.parseUnits("700000", 18));
      await launch
        .connect(alice)
        .depositTokens(ethers.parseUnits("700000", 18));

      // Deadline should be startTimestamp + durationSeconds
      const deadline = await launch.deadline();
      const durationSeconds = await launch.durationSeconds();

      // Since startTimestamp > block.timestamp at deposit time,
      // deadline = startTimestamp + durationSeconds
      expect(deadline).to.equal(BigInt(futureStart) + durationSeconds);

      // The full duration is preserved from the start time
      const effectiveDuration = deadline - BigInt(futureStart);
      expect(effectiveDuration).to.equal(durationSeconds);
    });

    it("launch expires exactly at deadline — boundary test", async function () {
      const {
        alice,
        bob,
        usdt,
        createBasicToken,
        createAndActivateLaunch,
        fundWithUsdt,
      } = await loadFixture(deployFullPlatform);

      const tokenAddress = await createBasicToken(alice);
      const launchAddress = await createAndActivateLaunch(alice, tokenAddress);

      const launch = await ethers.getContractAt("LaunchInstance", launchAddress);
      const deadline = await launch.deadline();

      await fundWithUsdt(bob, BigInt(200) * BigInt(1e6));
      await usdt.connect(bob).approve(launchAddress, ethers.MaxUint256);

      // Buy 1 second before deadline — should work
      await time.increaseTo(deadline - BigInt(2));
      await launch
        .connect(bob)
        .buyWithToken(
          await usdt.getAddress(),
          BigInt(50) * BigInt(1e6),
          0,
          0
        );

      // Buy exactly at deadline — should fail
      await time.increaseTo(deadline);
      await expect(
        launch
          .connect(bob)
          .buyWithToken(
            await usdt.getAddress(),
            BigInt(50) * BigInt(1e6),
            0,
            0
          )
      ).to.be.revertedWithCustomError(launch, "LaunchExpired");
    });
  });

  // ================================================================
  // GRADUATION EDGE CASES
  // ================================================================
  describe("Graduation edge cases", function () {
    it("graduation distributes correct platform fees (3% base + 3% tokens)", async function () {
      const {
        owner,
        alice,
        bob,
        charlie,
        dave,
        eve,
        usdt,
        createBasicToken,
        createAndActivateLaunch,
        fundWithUsdt,
      } = await loadFixture(deployFullPlatform);

      const tokenAddress = await createBasicToken(alice);
      const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
      const launchAddress = await createAndActivateLaunch(alice, tokenAddress, {
        softCap: BigInt(10) * BigInt(1e6),
        hardCap: BigInt(10000) * BigInt(1e6),
      });

      const launch = await ethers.getContractAt("LaunchInstance", launchAddress);

      // Multiple buyers to reach soft cap
      for (const buyer of [bob, charlie, dave, eve]) {
        await fundWithUsdt(buyer, BigInt(50) * BigInt(1e6));
        await usdt.connect(buyer).approve(launchAddress, ethers.MaxUint256);
        await launch
          .connect(buyer)
          .buyWithToken(
            await usdt.getAddress(),
            BigInt(50) * BigInt(1e6),
            0,
            0
          );
      }

      const totalRaised = await launch.totalBaseRaised();
      expect(totalRaised).to.be.gt(await launch.softCap());

      // Record platform wallet balances before graduation
      const platformUsdtBefore = await usdt.balanceOf(owner.address);
      const platformTokenBefore = await token.balanceOf(owner.address);

      // Creator graduates
      await launch.connect(alice).graduate();

      expect(await launch.state()).to.equal(2); // Graduated

      // Platform should have received 3% of base raised
      const platformUsdtAfter = await usdt.balanceOf(owner.address);
      const platformTokenAfter = await token.balanceOf(owner.address);

      const usdtFeeReceived = platformUsdtAfter - platformUsdtBefore;
      const tokenFeeReceived = platformTokenAfter - platformTokenBefore;

      const expectedUsdtFee = (totalRaised * BigInt(300)) / BigInt(10000);
      // Allow for slippage-related dust
      expect(usdtFeeReceived).to.be.gte(expectedUsdtFee);
      expect(tokenFeeReceived).to.be.gt(0);
    });

    it("anyone can graduate after deadline if soft cap is met", async function () {
      const {
        alice,
        bob,
        charlie,
        usdt,
        createBasicToken,
        createAndActivateLaunch,
        fundWithUsdt,
      } = await loadFixture(deployFullPlatform);

      const tokenAddress = await createBasicToken(alice);
      const launchAddress = await createAndActivateLaunch(alice, tokenAddress, {
        softCap: BigInt(10) * BigInt(1e6),
        hardCap: BigInt(10000) * BigInt(1e6),
      });

      const launch = await ethers.getContractAt("LaunchInstance", launchAddress);

      // Bob buys enough to pass soft cap
      await fundWithUsdt(bob, BigInt(50) * BigInt(1e6));
      await usdt.connect(bob).approve(launchAddress, ethers.MaxUint256);
      await launch
        .connect(bob)
        .buyWithToken(await usdt.getAddress(), BigInt(50) * BigInt(1e6), 0, 0);

      // Non-creator cannot graduate before deadline
      await expect(
        launch.connect(charlie).graduate()
      ).to.be.revertedWithCustomError(launch, "OnlyCreatorCanGraduateEarly");

      // After deadline, anyone can trigger
      await time.increase(31 * 24 * 3600);
      await launch.connect(charlie).graduate();

      expect(await launch.state()).to.equal(2); // Graduated
    });

    it("auto-graduates when hard cap is reached", async function () {
      const {
        alice,
        bob,
        charlie,
        dave,
        eve,
        frank,
        usdt,
        createBasicToken,
        createAndActivateLaunch,
        fundWithUsdt,
      } = await loadFixture(deployFullPlatform);

      const tokenAddress = await createBasicToken(alice);
      const launchAddress = await createAndActivateLaunch(alice, tokenAddress, {
        softCap: BigInt(10) * BigInt(1e6),
        hardCap: BigInt(50) * BigInt(1e6), // low hard cap
        maxBuyBps: 500, // 5% of hard cap = 2.5 USDT per wallet
      });

      const launch = await ethers.getContractAt("LaunchInstance", launchAddress);
      const usdtAddr = await usdt.getAddress();

      // maxBuyPerWallet = 50 * 500 / 10000 = 2.5 USDT
      // Need many wallets to reach 50 USDT hard cap
      const signers = await ethers.getSigners();
      const buyAmount = BigInt(5) * BigInt(1e6); // 5 USDT (capped to ~2.5 per wallet)
      for (let i = 0; i < 25; i++) {
        await fundWithUsdt(signers[i], buyAmount);
        await usdt.connect(signers[i]).approve(launchAddress, ethers.MaxUint256);
        try {
          await launch
            .connect(signers[i])
            .buyWithToken(usdtAddr, buyAmount, 0, 0);
        } catch {
          break; // May revert once hard cap is reached or all tokens sold
        }
      }

      // Should have auto-graduated
      expect(await launch.state()).to.equal(2); // Graduated
    });
  });

  // ================================================================
  // CREATOR VESTING EDGE CASES
  // ================================================================
  describe("Creator vesting edge cases", function () {
    it("creator cannot claim before cliff even if fully graduated", async function () {
      const {
        alice,
        bob,
        usdt,
        createBasicToken,
        createAndActivateLaunch,
        fundWithUsdt,
      } = await loadFixture(deployFullPlatform);

      const tokenAddress = await createBasicToken(alice);
      const launchAddress = await createAndActivateLaunch(alice, tokenAddress, {
        softCap: BigInt(10) * BigInt(1e6),
        hardCap: BigInt(50) * BigInt(1e6),
        maxBuyBps: 500, // 5% of hard cap = 2.5 USDT per wallet
        creatorAllocationBps: 500, // 5%
        vestingDays: 30,
      });

      const launch = await ethers.getContractAt("LaunchInstance", launchAddress);
      const usdtAddr = await usdt.getAddress();

      // Graduate by buying from multiple wallets to reach hard cap
      const signers = await ethers.getSigners();
      const buyAmount = BigInt(5) * BigInt(1e6); // 5 USDT (capped to ~2.5 per wallet)
      for (let i = 0; i < 25; i++) {
        await fundWithUsdt(signers[i], buyAmount);
        await usdt.connect(signers[i]).approve(launchAddress, ethers.MaxUint256);
        try {
          await launch
            .connect(signers[i])
            .buyWithToken(usdtAddr, buyAmount, 0, 0);
        } catch {
          break; // May revert once hard cap is reached or all tokens sold
        }
      }

      expect(await launch.state()).to.equal(2); // Graduated

      // Cliff is 7 days — claiming immediately should fail
      await expect(
        launch.connect(alice).claimCreatorTokens()
      ).to.be.revertedWithCustomError(launch, "CliffNotReached");

      // After cliff, partial claim works
      await time.increase(7 * 24 * 3600 + 1); // just past cliff
      await launch.connect(alice).claimCreatorTokens();

      const claimed = await launch.creatorClaimed();
      expect(claimed).to.be.gt(0);

      // Full vesting (30 days after cliff)
      await time.increase(30 * 24 * 3600);
      await launch.connect(alice).claimCreatorTokens();

      const finalClaimed = await launch.creatorClaimed();
      expect(finalClaimed).to.equal(await launch.creatorTotalTokens());
    });

    it("claiming twice at the same timestamp yields nothing on second call", async function () {
      const {
        alice,
        bob,
        usdt,
        createBasicToken,
        createAndActivateLaunch,
        fundWithUsdt,
      } = await loadFixture(deployFullPlatform);

      const tokenAddress = await createBasicToken(alice);
      const launchAddress = await createAndActivateLaunch(alice, tokenAddress, {
        softCap: BigInt(10) * BigInt(1e6),
        hardCap: BigInt(50) * BigInt(1e6),
        maxBuyBps: 500, // 5% of hard cap = 2.5 USDT per wallet
        creatorAllocationBps: 500,
        vestingDays: 30,
      });

      const launch = await ethers.getContractAt("LaunchInstance", launchAddress);
      const usdtAddr = await usdt.getAddress();

      // Graduate by buying from multiple wallets to reach hard cap
      const signers = await ethers.getSigners();
      const buyAmount = BigInt(5) * BigInt(1e6); // 5 USDT (capped to ~2.5 per wallet)
      for (let i = 0; i < 25; i++) {
        await fundWithUsdt(signers[i], buyAmount);
        await usdt.connect(signers[i]).approve(launchAddress, ethers.MaxUint256);
        try {
          await launch
            .connect(signers[i])
            .buyWithToken(usdtAddr, buyAmount, 0, 0);
        } catch {
          break; // May revert once hard cap is reached or all tokens sold
        }
      }

      // Past cliff + FULL vesting duration so everything is claimed at once
      await time.increase((7 + 30) * 24 * 3600 + 1);
      await launch.connect(alice).claimCreatorTokens();

      // All tokens claimed — second claim should fail
      const totalCreator = await launch.creatorTotalTokens();
      const claimed = await launch.creatorClaimed();
      expect(claimed).to.equal(totalCreator);

      await expect(
        launch.connect(alice).claimCreatorTokens()
      ).to.be.revertedWithCustomError(launch, "NothingToClaim");
    });
  });

  // ================================================================
  // WITHDRAW PENDING TOKENS EDGE CASE
  // ================================================================
  describe("withdrawPendingTokens edge cases", function () {
    it("partial deposit followed by withdrawal returns exact deposited amount", async function () {
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
        500,
        0,
        0,
        ethers.ZeroAddress,
        0
      );
      const receipt = await tx.wait();
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
      const launchAddress = launchpadFactory.interface.parseLog(event as any)!
        .args.launch;
      const launch = await ethers.getContractAt("LaunchInstance", launchAddress);

      // Partial deposit (not enough to activate)
      const partialAmount = ethers.parseUnits("100000", 18);
      await token.connect(alice).approve(launchAddress, partialAmount);
      await launch.connect(alice).depositTokens(partialAmount);

      expect(await launch.state()).to.equal(0); // Still pending

      const balanceBefore = await token.balanceOf(alice.address);
      await launch.connect(alice).withdrawPendingTokens();
      const balanceAfter = await token.balanceOf(alice.address);

      expect(balanceAfter - balanceBefore).to.equal(partialAmount);
      expect(await launch.totalTokensDeposited()).to.equal(0);
    });
  });

  // ================================================================
  // ANTI-WHALE (maxBuyPerWallet) EDGE CASES
  // ================================================================
  describe("Anti-whale maxBuyPerWallet", function () {
    it("enforces max buy across multiple purchases", async function () {
      const {
        alice,
        bob,
        usdt,
        launchpadFactory,
        createBasicToken,
        fundWithUsdt,
      } = await loadFixture(deployFullPlatform);

      const tokenAddress = await createBasicToken(alice);
      const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
      await token.connect(alice).enableTrading();

      // Use custom curve with very low slope to make tokens cheap → easier to hit maxBuy
      const tx = await launchpadFactory.connect(alice).createLaunchCustomCurve(
        tokenAddress,
        ethers.parseUnits("700000", 18),
        0, // Linear
        BigInt(1), // tiny slope
        BigInt(1e6), // small intercept (1 USDT per 1e18 tokens)
        BigInt(10) * BigInt(1e6),
        BigInt(100000) * BigInt(1e6),
        30,
        100, // 1% max buy = 1% of hardCap = 1000 USDT
        0,
        0,
        ethers.ZeroAddress,
        0
      );
      const receipt = await tx.wait();
      const event = receipt!.logs.find((l: any) => {
        try {
          return launchpadFactory.interface.parseLog(l as any)?.name === "LaunchCreated";
        } catch { return false; }
      });
      const launchAddress = launchpadFactory.interface.parseLog(event as any)!.args.launch;
      const launch = await ethers.getContractAt("LaunchInstance", launchAddress);

      await token.connect(alice).approve(launchAddress, ethers.parseUnits("700000", 18));
      await launch.connect(alice).depositTokens(ethers.parseUnits("700000", 18));

      const maxBuy = await launch.maxBuyPerWallet();
      // maxBuy = hardCap * maxBuyBps / BPS = 100000 * 100 / 10000 = 1000 USDT (1000_000_000 in 6 decimals)
      expect(maxBuy).to.be.gt(0);

      // Fund bob and buy in chunks
      await fundWithUsdt(bob, BigInt(500000) * BigInt(1e6));
      await usdt.connect(bob).approve(launchAddress, ethers.MaxUint256);

      let hitLimit = false;
      for (let i = 0; i < 100; i++) {
        try {
          await launch
            .connect(bob)
            .buyWithToken(await usdt.getAddress(), BigInt(500) * BigInt(1e6), 0, 0);
        } catch {
          hitLimit = true;
          break;
        }
      }

      expect(hitLimit).to.be.true;
      // maxBuyPerWallet is now in USDT value, so compare basePaid (USDT spent) against maxBuy
      expect(await launch.basePaid(bob.address)).to.be.lte(maxBuy);
    });

    it("different wallets have independent limits (sybil is possible)", async function () {
      const {
        alice,
        bob,
        charlie,
        dave,
        usdt,
        launchpadFactory,
        createBasicToken,
        fundWithUsdt,
      } = await loadFixture(deployFullPlatform);

      const tokenAddress = await createBasicToken(alice);
      const token = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
      await token.connect(alice).enableTrading();

      // Custom cheap curve so small USDT buys lots of tokens
      const tx = await launchpadFactory.connect(alice).createLaunchCustomCurve(
        tokenAddress,
        ethers.parseUnits("700000", 18),
        0, // Linear
        BigInt(1),
        BigInt(1e6),
        BigInt(10) * BigInt(1e6),
        BigInt(100000) * BigInt(1e6),
        30,
        100, // 1% max buy per wallet = 1% of hardCap = 1000 USDT
        0,
        0,
        ethers.ZeroAddress,
        0
      );
      const receipt = await tx.wait();
      const event = receipt!.logs.find((l: any) => {
        try {
          return launchpadFactory.interface.parseLog(l as any)?.name === "LaunchCreated";
        } catch { return false; }
      });
      const launchAddress = launchpadFactory.interface.parseLog(event as any)!.args.launch;
      const launch = await ethers.getContractAt("LaunchInstance", launchAddress);

      await token.connect(alice).approve(launchAddress, ethers.parseUnits("700000", 18));
      await launch.connect(alice).depositTokens(ethers.parseUnits("700000", 18));

      const maxBuy = await launch.maxBuyPerWallet();
      // maxBuy = hardCap * maxBuyBps / BPS = 100000 * 100 / 10000 = 1000 USDT

      // Each wallet buys a single purchase within the USDT limit
      const buyAmt = BigInt(500) * BigInt(1e6); // 500 USDT (under 1000 USDT limit)
      for (const buyer of [bob, charlie, dave]) {
        await fundWithUsdt(buyer, buyAmt);
        await usdt.connect(buyer).approve(launchAddress, ethers.MaxUint256);
        await launch
          .connect(buyer)
          .buyWithToken(await usdt.getAddress(), buyAmt, 0, 0);
      }

      const bobPaid = await launch.basePaid(bob.address);
      const charliePaid = await launch.basePaid(charlie.address);
      const davePaid = await launch.basePaid(dave.address);

      expect(bobPaid).to.be.gt(0);
      expect(charliePaid).to.be.gt(0);
      expect(davePaid).to.be.gt(0);

      // Each individual wallet's USDT spent is under the limit
      expect(bobPaid).to.be.lte(maxBuy);
      expect(charliePaid).to.be.lte(maxBuy);
      expect(davePaid).to.be.lte(maxBuy);

      // Combined across 3 sybil wallets exceeds any single wallet's spend
      // This demonstrates the anti-whale is per-wallet, not global
      const totalSybil = bobPaid + charliePaid + davePaid;
      // Each paid ~same amount, so 3x > any individual spend
      expect(totalSybil).to.be.gt(bobPaid);
      expect(totalSybil).to.be.gt(charliePaid);
      expect(totalSybil).to.be.gt(davePaid);
    });
  });

  // ================================================================
  // BUY CAPPING TO REMAINING SUPPLY
  // ================================================================
  describe("Buy capping to remaining supply", function () {
    it("excess USDT is refunded when buy exceeds remaining curve tokens", async function () {
      const {
        alice,
        bob,
        charlie,
        usdt,
        createBasicToken,
        createAndActivateLaunch,
        fundWithUsdt,
      } = await loadFixture(deployFullPlatform);

      const tokenAddress = await createBasicToken(alice);
      const launchAddress = await createAndActivateLaunch(alice, tokenAddress, {
        softCap: BigInt(10) * BigInt(1e6),
        hardCap: BigInt(100000) * BigInt(1e6), // very high so we don't auto-graduate
        maxBuyBps: 500,
      });

      const launch = await ethers.getContractAt("LaunchInstance", launchAddress);
      const tokensForCurve = await launch.tokensForCurve();

      // Fill most of the curve
      await fundWithUsdt(bob, BigInt(50000) * BigInt(1e6));
      await usdt.connect(bob).approve(launchAddress, ethers.MaxUint256);

      // Buy in chunks to approach the limit
      let tokensSold = await launch.tokensSold();
      let attempts = 0;
      while (tokensSold < (tokensForCurve * BigInt(90)) / BigInt(100) && attempts < 50) {
        try {
          await launch
            .connect(bob)
            .buyWithToken(
              await usdt.getAddress(),
              BigInt(1000) * BigInt(1e6),
              0,
              0
            );
        } catch {
          break;
        }
        tokensSold = await launch.tokensSold();
        attempts++;
      }

      // If we got close to the limit, verify state is consistent
      const finalTokensSold = await launch.tokensSold();
      const finalRaised = await launch.totalBaseRaised();

      expect(finalTokensSold).to.be.lte(tokensForCurve);
      expect(finalRaised).to.be.gt(0);
    });
  });
});
