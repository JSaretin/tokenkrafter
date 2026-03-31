import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("TradeRouter", function () {
  let owner: any, admin: any, alice: any, bob: any;
  let usdt: any, tokenA: any, router: any, dexRouter: any, weth: any, factory: any;
  let tradeRouter: any;

  const USDT_DECIMALS = 6;
  const parseUsdt = (n: number) => ethers.parseUnits(String(n), USDT_DECIMALS);

  beforeEach(async function () {
    [owner, admin, alice, bob] = await ethers.getSigners();

    // Deploy mock USDT (6 decimals)
    usdt = await (await ethers.getContractFactory("MockUSDT")).deploy();

    // Deploy mock token (18 decimals) — reuse MockUSDT18
    tokenA = await (await ethers.getContractFactory("MockUSDT18")).deploy();

    // Deploy mock DEX
    weth = await (await ethers.getContractFactory("MockWETH")).deploy();
    factory = await (await ethers.getContractFactory("MockUniswapV2Factory")).deploy();
    dexRouter = await (await ethers.getContractFactory("MockUniswapV2Router")).deploy(
      await weth.getAddress(),
      await factory.getAddress()
    );

    // Set price: 1 TKNA (1e18) = 1 USDT (1e6)
    await dexRouter.setMockPrice(
      await tokenA.getAddress(),
      await usdt.getAddress(),
      parseUsdt(1) // 1e18 tokenA → 1e6 USDT
    );
    // Reverse: 1 USDT → 1 TKNA
    await dexRouter.setMockPrice(
      await usdt.getAddress(),
      await tokenA.getAddress(),
      ethers.parseUnits("1", 18) // 1e6 USDT → 1e18 TKNA
    );

    // Deploy TradeRouter
    const TradeRouter = await ethers.getContractFactory("TradeRouter");
    tradeRouter = await TradeRouter.deploy(
      await dexRouter.getAddress(),
      await usdt.getAddress(),
      owner.address
    );

    // Add admin
    await tradeRouter.addAdmin(admin.address);

    // Fund users with USDT and tokenA
    await usdt.mint(alice.address, parseUsdt(100_000));
    await usdt.mint(bob.address, parseUsdt(100_000));
    await tokenA.mint(alice.address, ethers.parseUnits("100000", 18));
    await tokenA.mint(bob.address, ethers.parseUnits("100000", 18));

    // Fund dexRouter with tokens for swaps
    await usdt.mint(await dexRouter.getAddress(), parseUsdt(10_000_000));
    await tokenA.mint(await dexRouter.getAddress(), ethers.parseUnits("10000000", 18));
  });

  describe("Configuration", function () {
    it("should initialize with correct defaults", async function () {
      expect(await tradeRouter.feeBps()).to.equal(10); // 0.1%
      expect(await tradeRouter.payoutTimeout()).to.equal(300); // 5 min
      expect(await tradeRouter.platformWallet()).to.equal(owner.address);
      expect(await tradeRouter.isAdmin(owner.address)).to.be.true;
      expect(await tradeRouter.isAdmin(admin.address)).to.be.true;
    });

    it("should allow owner to update fee", async function () {
      await tradeRouter.setFeeBps(50); // 0.5%
      expect(await tradeRouter.feeBps()).to.equal(50);
    });

    it("should reject fee above MAX_FEE_BPS", async function () {
      await expect(tradeRouter.setFeeBps(101)).to.be.revertedWithCustomError(
        tradeRouter, "InvalidFee"
      );
    });

    it("should allow owner to update timeout", async function () {
      await tradeRouter.setPayoutTimeout(600); // 10 min
      expect(await tradeRouter.payoutTimeout()).to.equal(600);
    });

    it("should reject timeout below MIN or above MAX", async function () {
      await expect(tradeRouter.setPayoutTimeout(60)).to.be.revertedWithCustomError(
        tradeRouter, "InvalidTimeout"
      );
      await expect(tradeRouter.setPayoutTimeout(100_000)).to.be.revertedWithCustomError(
        tradeRouter, "InvalidTimeout"
      );
    });

    it("should not allow non-owner to change settings", async function () {
      await expect(tradeRouter.connect(alice).setFeeBps(50)).to.be.reverted;
      await expect(tradeRouter.connect(alice).setPayoutTimeout(600)).to.be.reverted;
    });
  });

  describe("Admin management", function () {
    it("should allow owner to add and remove admins", async function () {
      await tradeRouter.addAdmin(alice.address);
      expect(await tradeRouter.isAdmin(alice.address)).to.be.true;

      await tradeRouter.removeAdmin(alice.address);
      expect(await tradeRouter.isAdmin(alice.address)).to.be.false;
    });

    it("should prevent duplicate admin", async function () {
      await expect(tradeRouter.addAdmin(admin.address)).to.be.revertedWithCustomError(
        tradeRouter, "AlreadyAdmin"
      );
    });

    it("should prevent owner from removing self", async function () {
      await expect(tradeRouter.removeAdmin(owner.address)).to.be.revertedWithCustomError(
        tradeRouter, "CannotRemoveSelf"
      );
    });

    it("should list admins", async function () {
      const admins = await tradeRouter.getAdmins();
      expect(admins.length).to.equal(2);
    });
  });

  describe("Deposit (USDT direct)", function () {
    it("should create a withdraw request with correct fee calculation", async function () {
      const amount = parseUsdt(1000); // $1000

      await usdt.connect(alice).approve(await tradeRouter.getAddress(), amount);
      const tx = await tradeRouter.connect(alice).deposit(amount, ethers.id("bank123"));

      const receipt = await tx.wait();
      const req = await tradeRouter.getWithdrawal(0);

      expect(req.user).to.equal(alice.address);
      expect(req.grossAmount).to.equal(amount);
      expect(req.fee).to.equal(parseUsdt(1)); // 0.1% of 1000 = $1
      expect(req.netAmount).to.equal(parseUsdt(999)); // $999
      expect(req.status).to.equal(0); // Pending
    });

    it("should track totalEscrow correctly", async function () {
      const amount = parseUsdt(500);
      await usdt.connect(alice).approve(await tradeRouter.getAddress(), amount);
      await tradeRouter.connect(alice).deposit(amount, ethers.id("bank"));

      expect(await tradeRouter.totalEscrow()).to.equal(amount);
    });

    it("should emit WithdrawRequested event", async function () {
      const amount = parseUsdt(100);
      await usdt.connect(alice).approve(await tradeRouter.getAddress(), amount);

      await expect(tradeRouter.connect(alice).deposit(amount, ethers.id("bank")))
        .to.emit(tradeRouter, "WithdrawRequested");
    });

    it("should reject zero amount", async function () {
      await expect(
        tradeRouter.connect(alice).deposit(0, ethers.id("bank"))
      ).to.be.revertedWithCustomError(tradeRouter, "ZeroAmount");
    });

    it("should preview deposit correctly", async function () {
      const [fee, net] = await tradeRouter.previewDeposit(parseUsdt(1000));
      expect(fee).to.equal(parseUsdt(1));
      expect(net).to.equal(parseUsdt(999));
    });
  });

  describe("Confirm (admin)", function () {
    beforeEach(async function () {
      const amount = parseUsdt(1000);
      await usdt.connect(alice).approve(await tradeRouter.getAddress(), amount);
      await tradeRouter.connect(alice).deposit(amount, ethers.id("bank"));
    });

    it("should allow admin to confirm", async function () {
      await tradeRouter.connect(admin).confirm(0);
      const req = await tradeRouter.getWithdrawal(0);
      expect(req.status).to.equal(1); // Confirmed
    });

    it("should move fee to platform earnings on confirm", async function () {
      await tradeRouter.connect(admin).confirm(0);
      const earnings = await tradeRouter.platformEarnings(await usdt.getAddress());
      expect(earnings).to.equal(parseUsdt(1)); // 0.1% of $1000
    });

    it("should reduce totalEscrow on confirm", async function () {
      await tradeRouter.connect(admin).confirm(0);
      expect(await tradeRouter.totalEscrow()).to.equal(0);
    });

    it("should allow owner to confirm", async function () {
      await tradeRouter.connect(owner).confirm(0);
      const req = await tradeRouter.getWithdrawal(0);
      expect(req.status).to.equal(1);
    });

    it("should reject non-admin confirm", async function () {
      await expect(
        tradeRouter.connect(alice).confirm(0)
      ).to.be.revertedWithCustomError(tradeRouter, "NotAdmin");
    });

    it("should reject confirming non-pending request", async function () {
      await tradeRouter.connect(admin).confirm(0);
      await expect(
        tradeRouter.connect(admin).confirm(0)
      ).to.be.revertedWithCustomError(tradeRouter, "NotPending");
    });

    it("should allow batch confirm", async function () {
      // Create second deposit
      const amount = parseUsdt(500);
      await usdt.connect(bob).approve(await tradeRouter.getAddress(), amount);
      await tradeRouter.connect(bob).deposit(amount, ethers.id("bank2"));

      const tx = await tradeRouter.connect(admin).confirmBatch([0, 1]);

      expect((await tradeRouter.getWithdrawal(0)).status).to.equal(1);
      expect((await tradeRouter.getWithdrawal(1)).status).to.equal(1);
      expect(await tradeRouter.totalEscrow()).to.equal(0);
    });

    it("batch confirm skips invalid/expired entries instead of reverting (FIX #3)", async function () {
      // Create 3 deposits
      const amount = parseUsdt(300);
      await usdt.connect(alice).approve(await tradeRouter.getAddress(), amount);
      await tradeRouter.connect(alice).deposit(parseUsdt(100), ethers.id("b1"));
      await tradeRouter.connect(alice).deposit(parseUsdt(100), ethers.id("b2"));
      await tradeRouter.connect(alice).deposit(parseUsdt(100), ethers.id("b3"));

      // Confirm #1 individually first
      await tradeRouter.connect(admin).confirm(1);

      // Batch with: valid(0), already confirmed(1), out of range(999), valid(2)
      await tradeRouter.connect(admin).confirmBatch([0, 1, 999, 2]);

      expect((await tradeRouter.getWithdrawal(0)).status).to.equal(1); // confirmed
      expect((await tradeRouter.getWithdrawal(1)).status).to.equal(1); // was already confirmed, skipped
      expect((await tradeRouter.getWithdrawal(2)).status).to.equal(1); // confirmed
    });
  });

  describe("Cancel (user)", function () {
    beforeEach(async function () {
      const amount = parseUsdt(1000);
      await usdt.connect(alice).approve(await tradeRouter.getAddress(), amount);
      await tradeRouter.connect(alice).deposit(amount, ethers.id("bank"));
    });

    it("should reject cancel before timeout", async function () {
      await expect(
        tradeRouter.connect(alice).cancel(0)
      ).to.be.revertedWithCustomError(tradeRouter, "TimeoutNotReached");
    });

    it("should allow cancel after timeout", async function () {
      await time.increase(301); // > 5 min

      const balBefore = await usdt.balanceOf(alice.address);
      await tradeRouter.connect(alice).cancel(0);
      const balAfter = await usdt.balanceOf(alice.address);

      // Gets back FULL gross amount (no fee deducted on cancel)
      expect(balAfter - balBefore).to.equal(parseUsdt(1000));
    });

    it("should update status and totalEscrow on cancel", async function () {
      await time.increase(301);
      await tradeRouter.connect(alice).cancel(0);

      const req = await tradeRouter.getWithdrawal(0);
      expect(req.status).to.equal(2); // Cancelled
      expect(await tradeRouter.totalEscrow()).to.equal(0);
    });

    it("should reject cancel by non-owner of request", async function () {
      await time.increase(301);
      await expect(
        tradeRouter.connect(bob).cancel(0)
      ).to.be.revertedWithCustomError(tradeRouter, "NotRequestOwner");
    });

    it("should reject cancel of already confirmed request", async function () {
      await tradeRouter.connect(admin).confirm(0);
      await time.increase(301);
      await expect(
        tradeRouter.connect(alice).cancel(0)
      ).to.be.revertedWithCustomError(tradeRouter, "NotPending");
    });
  });

  describe("Platform fee withdrawal", function () {
    it("should allow owner to withdraw accumulated fees", async function () {
      // Deposit and confirm to accumulate fees
      const amount = parseUsdt(10000);
      await usdt.connect(alice).approve(await tradeRouter.getAddress(), amount);
      await tradeRouter.connect(alice).deposit(amount, ethers.id("bank"));
      await tradeRouter.connect(admin).confirm(0);

      const earnings = await tradeRouter.platformEarnings(await usdt.getAddress());
      expect(earnings).to.equal(parseUsdt(10)); // 0.1% of $10K

      const balBefore = await usdt.balanceOf(owner.address);
      await tradeRouter.withdrawFees(await usdt.getAddress());
      const balAfter = await usdt.balanceOf(owner.address);

      expect(balAfter - balBefore).to.equal(parseUsdt(10));
      expect(await tradeRouter.platformEarnings(await usdt.getAddress())).to.equal(0);
    });

    it("should reject withdrawing more than earnings (never touch escrow)", async function () {
      // Deposit but don't confirm — funds are in escrow
      const amount = parseUsdt(10000);
      await usdt.connect(alice).approve(await tradeRouter.getAddress(), amount);
      await tradeRouter.connect(alice).deposit(amount, ethers.id("bank"));

      // No earnings yet (not confirmed)
      await expect(
        tradeRouter.withdrawFees(await usdt.getAddress())
      ).to.be.revertedWithCustomError(tradeRouter, "InsufficientEarnings");
    });
  });

  describe("View functions", function () {
    it("should return pending withdrawals for admin", async function () {
      // Create 3 deposits
      for (const user of [alice, bob, alice]) {
        await usdt.connect(user).approve(await tradeRouter.getAddress(), parseUsdt(100));
        await tradeRouter.connect(user).deposit(parseUsdt(100), ethers.id("bank"));
      }

      // Confirm one
      await tradeRouter.connect(admin).confirm(1);

      const [pending, total] = await tradeRouter.getPendingWithdrawals(0, 10);
      expect(total).to.equal(2); // 3 - 1 confirmed = 2 pending
      expect(pending.length).to.equal(2);
    });

    it("should return user withdrawal history", async function () {
      await usdt.connect(alice).approve(await tradeRouter.getAddress(), parseUsdt(300));
      await tradeRouter.connect(alice).deposit(parseUsdt(100), ethers.id("b1"));
      await tradeRouter.connect(alice).deposit(parseUsdt(200), ethers.id("b2"));

      await usdt.connect(bob).approve(await tradeRouter.getAddress(), parseUsdt(100));
      await tradeRouter.connect(bob).deposit(parseUsdt(100), ethers.id("b3"));

      const [aliceReqs, aliceTotal] = await tradeRouter.getUserWithdrawals(alice.address, 0, 10);
      expect(aliceTotal).to.equal(2);
      expect(aliceReqs.length).to.equal(2);

      const [bobReqs, bobTotal] = await tradeRouter.getUserWithdrawals(bob.address, 0, 10);
      expect(bobTotal).to.equal(1);
    });

    it("should return total withdrawals count", async function () {
      await usdt.connect(alice).approve(await tradeRouter.getAddress(), parseUsdt(100));
      await tradeRouter.connect(alice).deposit(parseUsdt(100), ethers.id("bank"));
      expect(await tradeRouter.totalWithdrawals()).to.equal(1);
    });
  });

  describe("Edge cases", function () {
    it("should handle multiple deposits from same user", async function () {
      await usdt.connect(alice).approve(await tradeRouter.getAddress(), parseUsdt(3000));

      await tradeRouter.connect(alice).deposit(parseUsdt(1000), ethers.id("b1"));
      await tradeRouter.connect(alice).deposit(parseUsdt(2000), ethers.id("b2"));

      expect(await tradeRouter.totalEscrow()).to.equal(parseUsdt(3000));
      expect(await tradeRouter.totalWithdrawals()).to.equal(2);
    });

    it("should handle confirm then new deposit correctly", async function () {
      await usdt.connect(alice).approve(await tradeRouter.getAddress(), parseUsdt(2000));

      await tradeRouter.connect(alice).deposit(parseUsdt(1000), ethers.id("b1"));
      await tradeRouter.connect(admin).confirm(0);

      await tradeRouter.connect(alice).deposit(parseUsdt(1000), ethers.id("b2"));

      expect(await tradeRouter.totalEscrow()).to.equal(parseUsdt(1000)); // only second
      expect(await tradeRouter.platformEarnings(await usdt.getAddress())).to.equal(parseUsdt(1)); // from first
    });

    it("admin CANNOT confirm after timeout (FIX #3: prevents race condition)", async function () {
      await usdt.connect(alice).approve(await tradeRouter.getAddress(), parseUsdt(1000));
      await tradeRouter.connect(alice).deposit(parseUsdt(1000), ethers.id("bank"));

      await time.increase(301);

      // Admin tries to confirm after timeout — should revert
      await expect(
        tradeRouter.connect(admin).confirm(0)
      ).to.be.revertedWithCustomError(tradeRouter, "TimeoutReached");
    });

    it("pendingCount tracks correctly through lifecycle", async function () {
      await usdt.connect(alice).approve(await tradeRouter.getAddress(), parseUsdt(3000));

      await tradeRouter.connect(alice).deposit(parseUsdt(1000), ethers.id("b1"));
      expect(await tradeRouter.pendingCount()).to.equal(1);

      await tradeRouter.connect(alice).deposit(parseUsdt(1000), ethers.id("b2"));
      expect(await tradeRouter.pendingCount()).to.equal(2);

      await tradeRouter.connect(admin).confirm(0);
      expect(await tradeRouter.pendingCount()).to.equal(1);

      await tradeRouter.connect(alice).deposit(parseUsdt(1000), ethers.id("b3"));
      expect(await tradeRouter.pendingCount()).to.equal(2);

      await time.increase(301);
      await tradeRouter.connect(alice).cancel(1);
      expect(await tradeRouter.pendingCount()).to.equal(1);
    });

    it("setPlatformWallet rejects zero address (FIX #6)", async function () {
      await expect(
        tradeRouter.setPlatformWallet(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(tradeRouter, "ZeroAddress");
    });

    it("pause blocks deposits and swaps (FIX #7)", async function () {
      await tradeRouter.pause();

      await usdt.connect(alice).approve(await tradeRouter.getAddress(), parseUsdt(1000));
      await expect(
        tradeRouter.connect(alice).deposit(parseUsdt(1000), ethers.id("bank"))
      ).to.be.revertedWithCustomError(tradeRouter, "EnforcedPause");

      // Unpause restores functionality
      await tradeRouter.unpause();
      await tradeRouter.connect(alice).deposit(parseUsdt(1000), ethers.id("bank"));
      expect(await tradeRouter.totalWithdrawals()).to.equal(1);
    });

    it("cancel still works when paused (user safety)", async function () {
      await usdt.connect(alice).approve(await tradeRouter.getAddress(), parseUsdt(1000));
      await tradeRouter.connect(alice).deposit(parseUsdt(1000), ethers.id("bank"));

      await tradeRouter.pause();
      await time.increase(301);

      // User can still cancel even when paused
      await tradeRouter.connect(alice).cancel(0);
      expect((await tradeRouter.getWithdrawal(0)).status).to.equal(2);
    });

    it("user cannot cancel after admin confirms (even with timeout)", async function () {
      await usdt.connect(alice).approve(await tradeRouter.getAddress(), parseUsdt(1000));
      await tradeRouter.connect(alice).deposit(parseUsdt(1000), ethers.id("bank"));

      await tradeRouter.connect(admin).confirm(0);
      await time.increase(301);

      await expect(
        tradeRouter.connect(alice).cancel(0)
      ).to.be.revertedWithCustomError(tradeRouter, "NotPending");
    });
  });
});
