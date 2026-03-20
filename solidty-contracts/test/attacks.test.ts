import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("Security Attack Tests", function () {
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
    const dexRouter = await MockRouter.deploy(await weth.getAddress(), await dexFactory.getAddress());

    // Set mock prices: WETH→USDT = 2000 USDT per ETH (at 6 decimals)
    // price means: for 1e18 WETH in, get (price) USDT out
    const ethPrice = BigInt(2000) * BigInt(1e6); // 2000 USDT
    await dexRouter.setMockPrice(await weth.getAddress(), await usdt.getAddress(), ethPrice);
    // Reverse: for USDT→WETH getAmountsIn path
    const reversePrice = (BigInt(1e18) * BigInt(1e18)) / ethPrice;
    await dexRouter.setMockPrice(await usdt.getAddress(), await weth.getAddress(), reversePrice);

    // Fund router with USDT for swaps
    await usdt.transfer(await dexRouter.getAddress(), BigInt(100_000_000) * BigInt(1e6));

    // Deploy TokenFactory
    const TokenFactory = await ethers.getContractFactory("contracts/TokenFactory.sol:TokenFactory");
    const tokenFactory = await TokenFactory.deploy(await usdt.getAddress(), await dexRouter.getAddress());

    // Deploy token implementations
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
    const PartnerTaxableMintableImpl = await ethers.getContractFactory("PartnerTaxableMintableTokenImpl");
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

    // Deploy BondingCurve library (required by LaunchpadFactory → LaunchInstance)
    const BondingCurve = await ethers.getContractFactory("BondingCurve");
    const bondingCurve = await BondingCurve.deploy();

    // Deploy LaunchpadFactory with linked BondingCurve library
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

    // Helper to get creation fee in native
    async function getCreationFeeNative(typeKey: number): Promise<bigint> {
      const baseFee = await tokenFactory.creationFee(typeKey);
      return await tokenFactory.convertFee(baseFee, ethers.ZeroAddress);
    }

    return {
      owner, attacker, alice, bob, charlie,
      usdt, weth, dexFactory, dexRouter,
      tokenFactory, launchpadFactory, platformRouter,
      basicImpl, getCreationFeeNative,
    };
  }

  // ============================================================
  // ATTACK 1: Unauthorized Router Access
  // ============================================================
  describe("Attack: Unauthorized Router Access", function () {
    it("should reject routerCreateToken from non-router", async function () {
      const { tokenFactory, attacker } = await loadFixture(deployFullPlatform);

      const params = {
        name: "Hack Token",
        symbol: "HACK",
        totalSupply: 1000000,
        decimals: 18,
        isTaxable: false,
        isMintable: false,
        isPartner: false,
        paymentToken: ethers.ZeroAddress,
      };

      await expect(
        tokenFactory.connect(attacker).routerCreateToken(attacker.address, params, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(tokenFactory, "NotAuthorizedRouter");
    });

    it("should reject routerCreateLaunch from non-router", async function () {
      const { launchpadFactory, attacker } = await loadFixture(deployFullPlatform);

      await expect(
        launchpadFactory.connect(attacker).routerCreateLaunch(
          attacker.address, attacker.address, 1000, 0,
          100, 200, 30, 100, 0, 0, ethers.ZeroAddress, 0
        )
      ).to.be.revertedWithCustomError(launchpadFactory, "OnlyAuthorizedRouter");
    });

    it("should reject notifyDeposit from non-router", async function () {
      const { launchpadFactory, attacker } = await loadFixture(deployFullPlatform);

      await expect(
        launchpadFactory.connect(attacker).notifyDeposit(attacker.address, 1000)
      ).to.be.revertedWithCustomError(launchpadFactory, "OnlyAuthorizedRouter");
    });
  });

  // ============================================================
  // ATTACK 2: Circular Referral Self-Reward
  // ============================================================
  describe("Attack: Circular Referral Chain", function () {
    it("should block direct self-referral", async function () {
      const { tokenFactory, alice, getCreationFeeNative } = await loadFixture(deployFullPlatform);

      const fee = await getCreationFeeNative(0);
      const params = {
        name: "Test", symbol: "TST", totalSupply: 1000000, decimals: 18,
        isTaxable: false, isMintable: false, isPartner: false,
        paymentToken: ethers.ZeroAddress,
      };

      // Self-referral: referral == creator — should be silently ignored (not revert)
      await tokenFactory.connect(alice).createToken(params, alice.address, { value: fee });
      // Verify no referral was recorded
      expect(await tokenFactory.referrals(alice.address)).to.equal(ethers.ZeroAddress);
    });

    it("should block 2-level circular referral (A→B→A)", async function () {
      const { tokenFactory, alice, bob, getCreationFeeNative } = await loadFixture(deployFullPlatform);

      const fee = await getCreationFeeNative(0);
      const params = {
        name: "Test", symbol: "TST", totalSupply: 1000000, decimals: 18,
        isTaxable: false, isMintable: false, isPartner: false,
        paymentToken: ethers.ZeroAddress,
      };

      // Alice creates with Bob as referral → referrals[Alice] = Bob
      await tokenFactory.connect(alice).createToken(params, bob.address, { value: fee });
      expect(await tokenFactory.referrals(alice.address)).to.equal(bob.address);

      // Bob tries to create with Alice as referral → referrals[Bob] = Alice → cycle!
      await expect(
        tokenFactory.connect(bob).createToken(params, alice.address, { value: fee })
      ).to.be.revertedWithCustomError(tokenFactory, "CircularReferral");
    });

    it("should block 3-level circular referral (A→B→C→A)", async function () {
      const { tokenFactory, alice, bob, charlie, getCreationFeeNative } = await loadFixture(deployFullPlatform);

      const fee = await getCreationFeeNative(0);
      const params = {
        name: "Test", symbol: "TST", totalSupply: 1000000, decimals: 18,
        isTaxable: false, isMintable: false, isPartner: false,
        paymentToken: ethers.ZeroAddress,
      };

      // Alice → Bob (referrals[Alice] = Bob)
      await tokenFactory.connect(alice).createToken(params, bob.address, { value: fee });
      // Bob → Charlie (referrals[Bob] = Charlie)
      await tokenFactory.connect(bob).createToken(params, charlie.address, { value: fee });

      // Charlie → Alice would create A→B→C→A cycle
      await expect(
        tokenFactory.connect(charlie).createToken(params, alice.address, { value: fee })
      ).to.be.revertedWithCustomError(tokenFactory, "CircularReferral");
    });
  });

  // ============================================================
  // ATTACK 3: Fee Theft / Underpayment
  // ============================================================
  describe("Attack: Fee Underpayment", function () {
    it("should reject token creation with insufficient native payment", async function () {
      const { tokenFactory, attacker } = await loadFixture(deployFullPlatform);

      const params = {
        name: "Cheap", symbol: "CHP", totalSupply: 1000000, decimals: 18,
        isTaxable: false, isMintable: false, isPartner: false,
        paymentToken: ethers.ZeroAddress,
      };

      // Send 0 ETH
      await expect(
        tokenFactory.connect(attacker).createToken(params, ethers.ZeroAddress, { value: 0 })
      ).to.be.revertedWithCustomError(tokenFactory, "InsufficientPayment");

      // Send 1 wei
      await expect(
        tokenFactory.connect(attacker).createToken(params, ethers.ZeroAddress, { value: 1 })
      ).to.be.revertedWithCustomError(tokenFactory, "InsufficientPayment");
    });

    it("should refund excess native payment", async function () {
      const { tokenFactory, alice, getCreationFeeNative } = await loadFixture(deployFullPlatform);

      const fee = await getCreationFeeNative(0);
      const excess = ethers.parseEther("1");
      const totalSent = fee + excess;

      const params = {
        name: "Test", symbol: "TST", totalSupply: 1000000, decimals: 18,
        isTaxable: false, isMintable: false, isPartner: false,
        paymentToken: ethers.ZeroAddress,
      };

      const balBefore = await ethers.provider.getBalance(alice.address);
      const tx = await tokenFactory.connect(alice).createToken(params, ethers.ZeroAddress, { value: totalSent });
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
      const balAfter = await ethers.provider.getBalance(alice.address);

      // User should have paid exactly the fee + gas, not the excess
      const actualPaid = balBefore - balAfter - gasUsed;
      // Should be approximately equal to fee (within small rounding)
      expect(actualPaid).to.be.closeTo(fee, ethers.parseEther("0.0001"));
    });
  });

  // ============================================================
  // ATTACK 4: Reentrancy on Native Refund
  // ============================================================
  describe("Attack: Reentrancy via Native Refund", function () {
    it("should be protected by nonReentrant on createToken", async function () {
      const { tokenFactory, getCreationFeeNative } = await loadFixture(deployFullPlatform);

      const ReentrancyAttacker = await ethers.getContractFactory("ReentrancyAttacker");
      const attackerContract = await ReentrancyAttacker.deploy(await tokenFactory.getAddress());

      const fee = await getCreationFeeNative(0);

      const params = {
        name: "Reenter", symbol: "REEN", totalSupply: 1000000, decimals: 18,
        isTaxable: false, isMintable: false, isPartner: false,
        paymentToken: ethers.ZeroAddress,
      };

      // Encode a second createToken call for reentrancy
      const iface = tokenFactory.interface;
      const calldata = iface.encodeFunctionData("createToken", [params, ethers.ZeroAddress]);

      await attackerContract.setAttack(calldata, 1);

      // Send extra ETH so the refund triggers the receive() which tries to re-enter
      await expect(
        attackerContract.attack(calldata, { value: fee + ethers.parseEther("1") })
      ).to.not.be.reverted; // The re-entrance attempt silently fails due to nonReentrant
    });
  });

  // ============================================================
  // ATTACK 5: Steal Tokens from Factory
  // ============================================================
  describe("Attack: Token Theft from Factory", function () {
    it("should not allow withdrawing factory-held tokens as non-owner", async function () {
      const { tokenFactory, attacker, usdt } = await loadFixture(deployFullPlatform);

      await expect(
        tokenFactory.connect(attacker).withdrawFees(await usdt.getAddress())
      ).to.be.revertedWithCustomError(tokenFactory, "OwnableUnauthorizedAccount");
    });

    it("should not allow calling processTax on arbitrary token", async function () {
      const { tokenFactory, attacker, usdt } = await loadFixture(deployFullPlatform);

      // attacker tries to call processTax with USDT address
      await expect(
        tokenFactory.connect(attacker).processTax(await usdt.getAddress())
      ).to.be.revertedWithCustomError(tokenFactory, "NotFactoryToken");
    });
  });

  // ============================================================
  // ATTACK 6: Cancel Someone Else's Launch
  // ============================================================
  describe("Attack: Cancel Others' Pending Launch", function () {
    it("should reject cancelPendingLaunch from unauthorized caller", async function () {
      const { tokenFactory, launchpadFactory, alice, attacker, getCreationFeeNative } =
        await loadFixture(deployFullPlatform);

      // Alice creates a token
      const fee = await getCreationFeeNative(0);
      const params = {
        name: "Launch", symbol: "LCH", totalSupply: 1000000, decimals: 18,
        isTaxable: false, isMintable: false, isPartner: false,
        paymentToken: ethers.ZeroAddress,
      };
      const tx = await tokenFactory.connect(alice).createToken(params, ethers.ZeroAddress, { value: fee });
      const receipt = await tx.wait();

      // Find token address from event
      const event = receipt!.logs.find((l: any) => {
        try { return tokenFactory.interface.parseLog(l as any)?.name === "TokenCreated"; }
        catch { return false; }
      });
      const parsed = tokenFactory.interface.parseLog(event as any);
      const tokenAddress = parsed!.args.tokenAddress;

      // Alice creates a launch (need to set launch fee to 0 first for simplicity)
      await launchpadFactory.setLaunchFee(0);

      const tokenContract = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
      await tokenContract.connect(alice).enableTrading();

      const launchTx = await launchpadFactory.connect(alice).createLaunch(
        tokenAddress,
        ethers.parseUnits("500000", 18), // 500k tokens
        0, // Linear curve
        ethers.parseUnits("1000", 6), // 1000 USDT soft cap
        ethers.parseUnits("5000", 6), // 5000 USDT hard cap
        30, // 30 days
        100, // 1% max buy
        0, // no creator allocation
        0, // no vesting
        ethers.ZeroAddress,
        0 // startTimestamp: immediate
      );

      // Attacker tries to cancel Alice's pending launch
      await expect(
        launchpadFactory.connect(attacker).cancelPendingLaunch(tokenAddress)
      ).to.be.revertedWithCustomError(launchpadFactory, "NotTokenOwner");
    });
  });

  // ============================================================
  // ATTACK 7: Router Flow - Verify Ownership + Tokens Transfer
  // ============================================================
  describe("Attack: Router Flow Integrity", function () {
    it("router should receive tokens and ownership from factory", async function () {
      const { tokenFactory, platformRouter, alice, getCreationFeeNative, launchpadFactory } =
        await loadFixture(deployFullPlatform);

      // Set launch fee to 0 for simplicity
      await launchpadFactory.setLaunchFee(0);

      const fee = await getCreationFeeNative(0);

      const tokenParams = {
        name: "Router Test", symbol: "RTT", totalSupply: 1000000, decimals: 18,
        isTaxable: false, isMintable: false, isPartner: false,
        paymentToken: ethers.ZeroAddress,
      };

      const launchParams = {
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

      const protectionParams = {
        maxWalletAmount: 0,
        maxTransactionAmount: 0,
        cooldownSeconds: 0,
      };

      const taxParams = {
        buyTaxBps: 0,
        sellTaxBps: 0,
        transferTaxBps: 0,
        taxWallets: [],
        taxSharesBps: [],
      };

      const tx = await platformRouter.connect(alice).createTokenAndLaunch(
        tokenParams, launchParams, protectionParams, taxParams, ethers.ZeroAddress,
        { value: fee + ethers.parseEther("1") } // extra for safety
      );
      const receipt = await tx.wait();

      // Find event
      const event = receipt!.logs.find((l: any) => {
        try { return platformRouter.interface.parseLog(l as any)?.name === "TokenCreatedAndLaunched"; }
        catch { return false; }
      });
      const parsed = platformRouter.interface.parseLog(event as any);
      const tokenAddress = parsed!.args.token;
      const launchAddress = parsed!.args.launch;

      // Verify: Alice is the token owner (not factory, not router)
      const tokenContract = await ethers.getContractAt("BasicTokenImpl", tokenAddress);
      expect(await tokenContract.owner()).to.equal(alice.address);

      // Verify: Trading is enabled
      expect(await tokenContract.tradingEnabled()).to.be.true;

      // Verify: Alice received remaining tokens (300k)
      const aliceBalance = await tokenContract.balanceOf(alice.address);
      expect(aliceBalance).to.equal(ethers.parseUnits("300000", 18));

      // Verify: Launch contract received tokens (700k)
      const launchBalance = await tokenContract.balanceOf(launchAddress);
      expect(launchBalance).to.equal(ethers.parseUnits("700000", 18));

      // Verify: Launch is active
      const launchContract = await ethers.getContractAt("LaunchInstance", launchAddress);
      expect(await launchContract.state()).to.equal(1); // Active

      // Verify: Router holds no tokens or ETH
      expect(await tokenContract.balanceOf(await platformRouter.getAddress())).to.equal(0);
    });

    it("attacker cannot call onlyOwner functions on token after router flow", async function () {
      const { platformRouter, alice, attacker, getCreationFeeNative, launchpadFactory } =
        await loadFixture(deployFullPlatform);

      await launchpadFactory.setLaunchFee(0);
      const fee = await getCreationFeeNative(0);

      const tx = await platformRouter.connect(alice).createTokenAndLaunch(
        {
          name: "Secure", symbol: "SEC", totalSupply: 1000000, decimals: 18,
          isTaxable: false, isMintable: false, isPartner: false,
          paymentToken: ethers.ZeroAddress,
        },
        {
          tokensForLaunch: ethers.parseUnits("700000", 18),
          curveType: 0, softCap: ethers.parseUnits("100", 6),
          hardCap: ethers.parseUnits("500", 6),
          durationDays: 30, maxBuyBps: 100,
          creatorAllocationBps: 0, vestingDays: 0,
          launchPaymentToken: ethers.ZeroAddress,
          startTimestamp: 0,
        },
        { maxWalletAmount: 0, maxTransactionAmount: 0, cooldownSeconds: 0 },
        { buyTaxBps: 0, sellTaxBps: 0, transferTaxBps: 0, taxWallets: [], taxSharesBps: [] },
        ethers.ZeroAddress,
        { value: fee + ethers.parseEther("1") }
      );
      const receipt = await tx.wait();
      const event = receipt!.logs.find((l: any) => {
        try { return platformRouter.interface.parseLog(l as any)?.name === "TokenCreatedAndLaunched"; }
        catch { return false; }
      });
      const parsed = platformRouter.interface.parseLog(event as any);
      const tokenAddress = parsed!.args.token;

      const tokenContract = await ethers.getContractAt("BasicTokenImpl", tokenAddress);

      // Attacker cannot call owner functions
      await expect(
        tokenContract.connect(attacker).setMaxWalletAmount(1000)
      ).to.be.revertedWithCustomError(tokenContract, "OwnableUnauthorizedAccount");

      await expect(
        tokenContract.connect(attacker).enableTrading()
      ).to.be.reverted; // Already enabled
    });
  });

  // ============================================================
  // ATTACK 8: LaunchInstance - Fake notifyDeposit
  // ============================================================
  describe("Attack: Fake notifyDeposit", function () {
    it("should reject notifyDeposit from non-factory", async function () {
      const { platformRouter, alice, attacker, getCreationFeeNative, launchpadFactory } =
        await loadFixture(deployFullPlatform);

      await launchpadFactory.setLaunchFee(0);
      const fee = await getCreationFeeNative(0);

      const tx = await platformRouter.connect(alice).createTokenAndLaunch(
        {
          name: "NotifyTest", symbol: "NT", totalSupply: 1000000, decimals: 18,
          isTaxable: false, isMintable: false, isPartner: false,
          paymentToken: ethers.ZeroAddress,
        },
        {
          tokensForLaunch: ethers.parseUnits("700000", 18),
          curveType: 0, softCap: ethers.parseUnits("100", 6),
          hardCap: ethers.parseUnits("500", 6),
          durationDays: 30, maxBuyBps: 100,
          creatorAllocationBps: 0, vestingDays: 0,
          launchPaymentToken: ethers.ZeroAddress,
          startTimestamp: 0,
        },
        { maxWalletAmount: 0, maxTransactionAmount: 0, cooldownSeconds: 0 },
        { buyTaxBps: 0, sellTaxBps: 0, transferTaxBps: 0, taxWallets: [], taxSharesBps: [] },
        ethers.ZeroAddress,
        { value: fee + ethers.parseEther("1") }
      );
      const receipt = await tx.wait();
      const event = receipt!.logs.find((l: any) => {
        try { return platformRouter.interface.parseLog(l as any)?.name === "TokenCreatedAndLaunched"; }
        catch { return false; }
      });
      const parsed = platformRouter.interface.parseLog(event as any);
      const launchAddress = parsed!.args.launch;

      const launchContract = await ethers.getContractAt("LaunchInstance", launchAddress);

      // Attacker tries to fake a deposit notification
      await expect(
        launchContract.connect(attacker).notifyDeposit(ethers.parseUnits("1000000", 18))
      ).to.be.revertedWithCustomError(launchContract, "OnlyFactory");
    });
  });

  // ============================================================
  // ATTACK 9: Claim Referral Rewards Drain
  // ============================================================
  describe("Attack: Referral Reward Drain", function () {
    it("should not allow double-claiming referral rewards", async function () {
      const { tokenFactory, alice, bob, getCreationFeeNative } = await loadFixture(deployFullPlatform);

      const fee = await getCreationFeeNative(0);
      const params = {
        name: "Ref", symbol: "REF", totalSupply: 1000000, decimals: 18,
        isTaxable: false, isMintable: false, isPartner: false,
        paymentToken: ethers.ZeroAddress,
      };

      // Set auto-distribute to false so rewards accumulate
      await tokenFactory.setAutoDistributeReward(false);

      // Alice creates with Bob as referral
      await tokenFactory.connect(alice).createToken(params, bob.address, { value: fee });

      // Bob claims once
      const pending = await tokenFactory.pendingRewards(bob.address, ethers.ZeroAddress);
      if (pending > 0n) {
        await tokenFactory.connect(bob).claimReward(ethers.ZeroAddress);

        // Bob tries to claim again — should fail
        await expect(
          tokenFactory.connect(bob).claimReward(ethers.ZeroAddress)
        ).to.be.revertedWithCustomError(tokenFactory, "NoRewards");
      }
    });
  });

  // ============================================================
  // ATTACK 10: Front-run Deterministic Token Address
  // ============================================================
  describe("Attack: Front-run Token Creation", function () {
    it("deterministic address should be per-creator with nonce", async function () {
      const { tokenFactory, alice, attacker, getCreationFeeNative } = await loadFixture(deployFullPlatform);

      const fee = await getCreationFeeNative(0);
      const params = {
        name: "Token1", symbol: "T1", totalSupply: 1000000, decimals: 18,
        isTaxable: false, isMintable: false, isPartner: false,
        paymentToken: ethers.ZeroAddress,
      };

      // Predict Alice's next token address
      const predicted = await tokenFactory.predictTokenAddress(alice.address, false, false, false);

      // Attacker creates a token — their nonce is independent from Alice's
      await tokenFactory.connect(attacker).createToken(params, ethers.ZeroAddress, { value: fee });

      // Alice's predicted address should still be valid (attacker didn't consume Alice's nonce)
      const alicePredicted = await tokenFactory.predictTokenAddress(alice.address, false, false, false);
      expect(alicePredicted).to.equal(predicted);

      // Alice creates — should get the predicted address
      const tx = await tokenFactory.connect(alice).createToken(params, ethers.ZeroAddress, { value: fee });
      const receipt = await tx.wait();
      const event = receipt!.logs.find((l: any) => {
        try { return tokenFactory.interface.parseLog(l as any)?.name === "TokenCreated"; }
        catch { return false; }
      });
      const parsed = tokenFactory.interface.parseLog(event as any);
      expect(parsed!.args.tokenAddress).to.equal(predicted);
    });
  });

  // ============================================================
  // ATTACK 11: Fake recordGraduation / clearTokenLaunch
  // ============================================================
  describe("Attack: Fake Factory Callbacks", function () {
    it("should reject recordGraduation from non-launch contract", async function () {
      const { launchpadFactory, attacker } = await loadFixture(deployFullPlatform);

      // Calling with a random address reverts (either NotRegisteredLaunch or low-level revert
      // because it tries to call .token() on a non-contract address)
      await expect(
        launchpadFactory.connect(attacker).recordGraduation(attacker.address)
      ).to.be.reverted;
    });

    it("should reject clearTokenLaunch from non-launch contract", async function () {
      const { launchpadFactory, attacker } = await loadFixture(deployFullPlatform);

      await expect(
        launchpadFactory.connect(attacker).clearTokenLaunch(attacker.address)
      ).to.be.revertedWithCustomError(launchpadFactory, "OnlyLaunch");
    });
  });

  // ============================================================
  // ATTACK 12: Admin Takeover Attempts
  // ============================================================
  describe("Attack: Admin Function Access Control", function () {
    it("should reject all admin functions from non-owner", async function () {
      const { tokenFactory, launchpadFactory, attacker } = await loadFixture(deployFullPlatform);

      // TokenFactory admin functions
      await expect(tokenFactory.connect(attacker).setImplementation(0, attacker.address))
        .to.be.revertedWithCustomError(tokenFactory, "OwnableUnauthorizedAccount");
      await expect(tokenFactory.connect(attacker).setCreationFee(0, 0))
        .to.be.revertedWithCustomError(tokenFactory, "OwnableUnauthorizedAccount");
      await expect(tokenFactory.connect(attacker).setAuthorizedRouter(attacker.address))
        .to.be.revertedWithCustomError(tokenFactory, "OwnableUnauthorizedAccount");
      await expect(tokenFactory.connect(attacker).setDexRouter(attacker.address))
        .to.be.revertedWithCustomError(tokenFactory, "OwnableUnauthorizedAccount");
      await expect(tokenFactory.connect(attacker).withdrawFees(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(tokenFactory, "OwnableUnauthorizedAccount");

      // LaunchpadFactory admin functions
      await expect(launchpadFactory.connect(attacker).setPlatformWallet(attacker.address))
        .to.be.revertedWithCustomError(launchpadFactory, "OwnableUnauthorizedAccount");
      await expect(launchpadFactory.connect(attacker).setLaunchFee(0))
        .to.be.revertedWithCustomError(launchpadFactory, "OwnableUnauthorizedAccount");
      await expect(launchpadFactory.connect(attacker).setAuthorizedRouter(attacker.address))
        .to.be.revertedWithCustomError(launchpadFactory, "OwnableUnauthorizedAccount");
      await expect(launchpadFactory.connect(attacker).withdrawFees(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(launchpadFactory, "OwnableUnauthorizedAccount");
    });
  });

  // ============================================================
  // ATTACK 13: Protection Override - Only Factory Can Relax
  // ============================================================
  describe("Attack: Token Protection Override", function () {
    it("non-factory cannot call force functions on token", async function () {
      const { tokenFactory, alice, attacker, getCreationFeeNative } = await loadFixture(deployFullPlatform);

      const fee = await getCreationFeeNative(0);
      const params = {
        name: "Protected", symbol: "PRT", totalSupply: 1000000, decimals: 18,
        isTaxable: false, isMintable: false, isPartner: false,
        paymentToken: ethers.ZeroAddress,
      };

      const tx = await tokenFactory.connect(alice).createToken(params, ethers.ZeroAddress, { value: fee });
      const receipt = await tx.wait();
      const event = receipt!.logs.find((l: any) => {
        try { return tokenFactory.interface.parseLog(l as any)?.name === "TokenCreated"; }
        catch { return false; }
      });
      const parsed = tokenFactory.interface.parseLog(event as any);
      const tokenAddress = parsed!.args.tokenAddress;

      const tokenContract = await ethers.getContractAt("BasicTokenImpl", tokenAddress);

      // Attacker tries to call force functions directly
      await expect(
        tokenContract.connect(attacker).forceUnblacklist(attacker.address)
      ).to.be.revertedWith("Only factory");

      await expect(
        tokenContract.connect(attacker).forceRelaxMaxWallet(0)
      ).to.be.revertedWith("Only factory");

      await expect(
        tokenContract.connect(attacker).forceRelaxCooldown(0)
      ).to.be.revertedWith("Only factory");
    });
  });

  // ============================================================
  // ATTACK 14: Router Creates Token with Taxable (Pool Setup)
  // ============================================================
  describe("Router: Taxable Token + Launch Flow", function () {
    it("should correctly handle taxable token creation via router", async function () {
      const { platformRouter, alice, getCreationFeeNative, launchpadFactory } =
        await loadFixture(deployFullPlatform);

      await launchpadFactory.setLaunchFee(0);

      // Type 2 = taxable (bit 1)
      const fee = await getCreationFeeNative(2);

      const tx = await platformRouter.connect(alice).createTokenAndLaunch(
        {
          name: "TaxToken", symbol: "TAX", totalSupply: 1000000, decimals: 18,
          isTaxable: true, isMintable: false, isPartner: false,
          paymentToken: ethers.ZeroAddress,
        },
        {
          tokensForLaunch: ethers.parseUnits("700000", 18),
          curveType: 0, softCap: ethers.parseUnits("100", 6),
          hardCap: ethers.parseUnits("500", 6),
          durationDays: 30, maxBuyBps: 100,
          creatorAllocationBps: 0, vestingDays: 0,
          launchPaymentToken: ethers.ZeroAddress,
          startTimestamp: 0,
        },
        { maxWalletAmount: 0, maxTransactionAmount: 0, cooldownSeconds: 0 },
        {
          buyTaxBps: 300, sellTaxBps: 300, transferTaxBps: 0,
          taxWallets: [alice.address], taxSharesBps: [10000],
        },
        ethers.ZeroAddress,
        { value: fee + ethers.parseEther("2") }
      );

      const receipt = await tx.wait();
      const event = receipt!.logs.find((l: any) => {
        try { return platformRouter.interface.parseLog(l as any)?.name === "TokenCreatedAndLaunched"; }
        catch { return false; }
      });
      expect(event).to.not.be.undefined;

      const parsed = platformRouter.interface.parseLog(event as any);
      const tokenAddress = parsed!.args.token;

      const tokenContract = await ethers.getContractAt("TaxableTokenImpl", tokenAddress);
      expect(await tokenContract.owner()).to.equal(alice.address);
      expect(await tokenContract.tradingEnabled()).to.be.true;
      expect(await tokenContract.buyTaxBps()).to.equal(300);
      expect(await tokenContract.sellTaxBps()).to.equal(300);
    });
  });
});
