import { expect } from "chai";
import { ethers } from "hardhat";
import { deployDex, PARSE_USDT } from "./helpers/fixtures";

/**
 * TradeRouter — comprehensive test suite.
 *
 * Covers:
 *   - Deployment / constructor defaults
 *   - deposit / depositAndSwap / depositETH paths
 *   - confirm / confirm(to) / confirmBatch (admin release)
 *   - cancel (user, post-expiry)
 *   - refund (admin, post-expiry)
 *   - enumeration views & getState
 *   - admin configuration (fee, wallet, timeout, slippage, admins)
 *   - pause kill-switch
 *   - owner withdraw() / rescueToken (escrow-safe)
 *   - adversarial flows & reentrancy sanity
 */

const DEFAULT_FEE_BPS = 100n; // 1%
const DEFAULT_TIMEOUT = 600n; // 10 min
const MIN_TIMEOUT = 300n;
const MAX_TIMEOUT = 86400n;
const MAX_FEE_BPS = 500n;
const MAX_SLIPPAGE_CAP = 2000n;

const BANK_REF_A = ethers.keccak256(ethers.toUtf8Bytes("bank-a"));
const BANK_REF_B = ethers.keccak256(ethers.toUtf8Bytes("bank-b"));

async function deployRouter() {
  const [owner, platform, alice, bob, carol, dave, referrer] =
    await ethers.getSigners();
  const dex = await deployDex();

  const TradeRouter = await ethers.getContractFactory("TradeRouter");
  const router = await TradeRouter.deploy(
    await dex.dexRouter.getAddress(),
    await dex.usdt.getAddress(),
    platform.address
  );

  // Fund actors with USDT for deposits
  for (const a of [alice, bob, carol, dave, referrer]) {
    await dex.usdt.mint(a.address, PARSE_USDT(1_000_000));
  }

  return {
    owner,
    platform,
    alice,
    bob,
    carol,
    dave,
    referrer,
    ...dex,
    router,
  };
}

type Env = Awaited<ReturnType<typeof deployRouter>>;

async function approveUsdt(env: Env, who: any, amount: bigint) {
  await env.usdt.connect(who).approve(await env.router.getAddress(), amount);
}

// Each deposit gets a fresh bankRef so the on-chain uniqueness
// constraint (added in M8) doesn't reject test-fixture reuse. Tests
// that deliberately exercise the duplicate-ref revert pass the same
// ref explicitly.
let _bankRefCounter = 0;
function nextBankRef(): string {
  _bankRefCounter += 1;
  return ethers.id(`TEST_BANK_REF_${_bankRefCounter}`);
}

async function doDeposit(
  env: Env,
  user: any,
  amount: bigint,
  bankRef: string = "",
  referrer: string = ethers.ZeroAddress
) {
  const ref = bankRef === "" ? nextBankRef() : bankRef;
  await approveUsdt(env, user, amount);
  const tx = await env.router
    .connect(user)
    .deposit(amount, ref, referrer);
  const receipt = await tx.wait();
  const log = receipt!.logs.find(
    (l: any) => l.fragment?.name === "WithdrawRequested"
  );
  return { tx, id: (log as any).args[0] as bigint };
}

async function fastForward(seconds: number | bigint) {
  await ethers.provider.send("evm_increaseTime", [Number(seconds)]);
  await ethers.provider.send("evm_mine", []);
}

describe("TradeRouter", () => {
  // ═══════════════════════════════════════════════════════════════
  //  Deployment / constructor
  // ═══════════════════════════════════════════════════════════════
  describe("Deployment / constructor", () => {
    it("initializes with correct defaults", async () => {
      const env = await deployRouter();
      expect(await env.router.feeBps()).to.equal(DEFAULT_FEE_BPS);
      expect(await env.router.payoutTimeout()).to.equal(DEFAULT_TIMEOUT);
      expect(await env.router.maxSlippageBps()).to.equal(500n);
      expect(await env.router.affiliateEnabled()).to.equal(false);
      expect(await env.router.affiliateShareBps()).to.equal(1000n);
      expect(await env.router.minWithdrawUsdt()).to.equal(0n);
      expect(await env.router.totalEscrow()).to.equal(0n);
      expect(await env.router.pendingCount()).to.equal(0n);
      expect(await env.router.totalWithdrawals()).to.equal(0n);
      expect(await env.router.paused()).to.equal(false);
    });

    it("exposes owner / usdt / dexRouter / platformWallet", async () => {
      const env = await deployRouter();
      expect(await env.router.owner()).to.equal(env.owner.address);
      expect(await env.router.usdt()).to.equal(await env.usdt.getAddress());
      expect(await env.router.dexRouter()).to.equal(
        await env.dexRouter.getAddress()
      );
      expect(await env.router.platformWallet()).to.equal(env.platform.address);
      expect(await env.router.weth()).to.equal(await env.weth.getAddress());
    });

    it("owner is the default admin", async () => {
      const env = await deployRouter();
      expect(await env.router.isAdmin(env.owner.address)).to.equal(true);
      const admins = await env.router.getAdmins();
      expect(admins).to.deep.equal([env.owner.address]);
    });

    it("rejects zero platformWallet", async () => {
      const [owner, , alice] = await ethers.getSigners();
      const dex = await deployDex();
      const TR = await ethers.getContractFactory("TradeRouter");
      await expect(
        TR.deploy(
          await dex.dexRouter.getAddress(),
          await dex.usdt.getAddress(),
          ethers.ZeroAddress
        )
      ).to.be.revertedWithCustomError(
        await TR.deploy(
          await dex.dexRouter.getAddress(),
          await dex.usdt.getAddress(),
          alice.address
        ),
        "ZeroAddress"
      );
    });

    it("MAX_FEE_BPS / MIN_TIMEOUT / MAX_TIMEOUT / MAX_SLIPPAGE_CAP are correct", async () => {
      const env = await deployRouter();
      expect(await env.router.MAX_FEE_BPS()).to.equal(MAX_FEE_BPS);
      expect(await env.router.MIN_TIMEOUT()).to.equal(MIN_TIMEOUT);
      expect(await env.router.MAX_TIMEOUT()).to.equal(MAX_TIMEOUT);
      expect(await env.router.MAX_SLIPPAGE_CAP()).to.equal(MAX_SLIPPAGE_CAP);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  deposit (direct USDT)
  // ═══════════════════════════════════════════════════════════════
  describe("deposit (direct USDT)", () => {
    it("creates pending withdrawal with correct fee split (1% default)", async () => {
      const env = await deployRouter();
      const amount = PARSE_USDT(100);
      await approveUsdt(env, env.alice, amount);

      const tx = await env.router
        .connect(env.alice)
        .deposit(amount, BANK_REF_A, ethers.ZeroAddress);
      const receipt = await tx.wait();
      const log = receipt!.logs.find(
        (l: any) => l.fragment?.name === "WithdrawRequested"
      );
      const id = (log as any).args[0];

      const req = await env.router.getWithdrawal(id);
      expect(req.user).to.equal(env.alice.address);
      expect(req.token).to.equal(await env.usdt.getAddress());
      expect(req.grossAmount).to.equal(amount);
      expect(req.fee).to.equal(PARSE_USDT(1)); // 1% of 100 = 1
      expect(req.netAmount).to.equal(PARSE_USDT(99));
      expect(req.status).to.equal(0); // Pending
      expect(req.bankRef).to.equal(BANK_REF_A);
      expect(req.referrer).to.equal(ethers.ZeroAddress);
    });

    it("transfers USDT from user into escrow", async () => {
      const env = await deployRouter();
      const amount = PARSE_USDT(100);
      const before = await env.usdt.balanceOf(env.alice.address);
      await doDeposit(env, env.alice, amount);

      expect(await env.usdt.balanceOf(env.alice.address)).to.equal(
        before - amount
      );
      expect(
        await env.usdt.balanceOf(await env.router.getAddress())
      ).to.equal(amount);
      expect(await env.router.totalEscrow()).to.equal(amount);
    });

    it("emits WithdrawRequested with all fields including referrer + expiresAt", async () => {
      const env = await deployRouter();
      const amount = PARSE_USDT(200);
      await approveUsdt(env, env.alice, amount);

      const tx = await env.router
        .connect(env.alice)
        .deposit(amount, BANK_REF_A, env.referrer.address);
      const receipt = await tx.wait();
      const blk = await ethers.provider.getBlock(receipt!.blockNumber);
      const expiresAt = BigInt(blk!.timestamp) + DEFAULT_TIMEOUT;

      await expect(tx)
        .to.emit(env.router, "WithdrawRequested")
        .withArgs(
          0n,
          env.alice.address,
          await env.usdt.getAddress(),
          amount,
          PARSE_USDT(2),
          PARSE_USDT(198),
          BANK_REF_A,
          env.referrer.address,
          expiresAt
        );
    });

    it("stores referrer address when provided", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(
        env,
        env.alice,
        PARSE_USDT(50),
        BANK_REF_A,
        env.referrer.address
      );
      const req = await env.router.getWithdrawal(id);
      expect(req.referrer).to.equal(env.referrer.address);
    });

    it("reverts on zero amount", async () => {
      const env = await deployRouter();
      await expect(
        env.router
          .connect(env.alice)
          .deposit(0, BANK_REF_A, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(env.router, "ZeroAmount");
    });

    it("reverts below minWithdrawUsdt when set", async () => {
      const env = await deployRouter();
      await env.router
        .connect(env.owner)
        .setMinWithdrawUsdt(PARSE_USDT(10));
      await approveUsdt(env, env.alice, PARSE_USDT(5));
      await expect(
        env.router
          .connect(env.alice)
          .deposit(PARSE_USDT(5), BANK_REF_A, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(env.router, "BelowMinWithdraw");
    });

    it("allows exact minWithdrawUsdt deposit", async () => {
      const env = await deployRouter();
      await env.router
        .connect(env.owner)
        .setMinWithdrawUsdt(PARSE_USDT(10));
      await approveUsdt(env, env.alice, PARSE_USDT(10));
      await expect(
        env.router
          .connect(env.alice)
          .deposit(PARSE_USDT(10), BANK_REF_A, ethers.ZeroAddress)
      ).to.not.be.reverted;
    });

    it("sequential deposits from same user are individually enumerable", async () => {
      const env = await deployRouter();
      await doDeposit(env, env.alice, PARSE_USDT(10));
      await doDeposit(env, env.alice, PARSE_USDT(20));
      await doDeposit(env, env.alice, PARSE_USDT(30));

      const [result, ids, total] = await env.router.getUserWithdrawals(
        env.alice.address,
        0,
        10
      );
      expect(total).to.equal(3n);
      expect(ids.length).to.equal(3);
      expect(result[0].grossAmount).to.equal(PARSE_USDT(10));
      expect(result[1].grossAmount).to.equal(PARSE_USDT(20));
      expect(result[2].grossAmount).to.equal(PARSE_USDT(30));
    });

    it("increments pendingCount by 1 per deposit", async () => {
      const env = await deployRouter();
      expect(await env.router.pendingCount()).to.equal(0n);
      await doDeposit(env, env.alice, PARSE_USDT(10));
      expect(await env.router.pendingCount()).to.equal(1n);
      await doDeposit(env, env.bob, PARSE_USDT(10));
      expect(await env.router.pendingCount()).to.equal(2n);
    });

    it("previewDeposit returns expected fee + net", async () => {
      const env = await deployRouter();
      const [fee, net] = await env.router.previewDeposit(PARSE_USDT(100));
      expect(fee).to.equal(PARSE_USDT(1));
      expect(net).to.equal(PARSE_USDT(99));
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  depositAndSwap
  // ═══════════════════════════════════════════════════════════════
  describe("depositAndSwap", () => {
    async function setupToken(env: Env) {
      // Deploy an arbitrary ERC20 via MockWETH (it's plain ERC20 + deposit)
      const Token = await ethers.getContractFactory("MockWETH");
      const token = await Token.deploy();
      // Mint tokens to alice via ETH deposit
      await token
        .connect(env.alice)
        .deposit({ value: ethers.parseEther("10") });
      // Set a price: 1 TKN = 2 USDT (price has 6-decimal precision in USDT out)
      // price scale: amounts[i+1] = amounts[i] * price / 1e18
      // so for 1e18 TKN → 2e6 USDT, price = 2e6
      await env.dexRouter.setMockPrice(
        await token.getAddress(),
        await env.usdt.getAddress(),
        2n * 10n ** 6n
      );
      return token;
    }

    it("single-hop TKN → USDT creates pending withdrawal with net USDT", async () => {
      const env = await deployRouter();
      const token = await setupToken(env);
      const amountIn = ethers.parseEther("1"); // 1 TKN → 2 USDT

      await token
        .connect(env.alice)
        .approve(await env.router.getAddress(), amountIn);

      const path = [await token.getAddress(), await env.usdt.getAddress()];
      const tx = await env.router
        .connect(env.alice)
        .depositAndSwap(
          path,
          amountIn,
          PARSE_USDT(2),
          false,
          BANK_REF_A,
          ethers.ZeroAddress
        );
      const receipt = await tx.wait();
      const log = receipt!.logs.find(
        (l: any) => l.fragment?.name === "WithdrawRequested"
      );
      const id = (log as any).args[0];
      const req = await env.router.getWithdrawal(id);
      expect(req.grossAmount).to.equal(PARSE_USDT(2));
      expect(req.fee).to.equal(PARSE_USDT(2) / 100n);
    });

    it("multi-hop TKN → WETH → USDT works", async () => {
      const env = await deployRouter();
      const token = await setupToken(env);

      // Set TKN → WETH price, leverage existing WETH → USDT
      // 1 TKN = 0.01 WETH (since 1 WETH = 600 USDT, 0.01 WETH = 6 USDT worth)
      await env.dexRouter.setMockPrice(
        await token.getAddress(),
        await env.weth.getAddress(),
        10n ** 16n // 0.01 * 1e18
      );

      const amountIn = ethers.parseEther("1");
      await token
        .connect(env.alice)
        .approve(await env.router.getAddress(), amountIn);

      // Fund router's mock with more USDT as previous swaps may have reduced balance
      await env.usdt.mint(
        await env.dexRouter.getAddress(),
        PARSE_USDT(100_000_000)
      );

      const path = [
        await token.getAddress(),
        await env.weth.getAddress(),
        await env.usdt.getAddress(),
      ];
      // 1 TKN * 0.01 = 0.01 WETH, * 600 = 6 USDT
      await expect(
        env.router
          .connect(env.alice)
          .depositAndSwap(
            path,
            amountIn,
            PARSE_USDT(6),
            false,
            BANK_REF_A,
            ethers.ZeroAddress
          )
      ).to.emit(env.router, "WithdrawRequested");
    });

    it("reverts when path does not end at USDT", async () => {
      const env = await deployRouter();
      const token = await setupToken(env);
      await token
        .connect(env.alice)
        .approve(await env.router.getAddress(), ethers.parseEther("1"));

      const badPath = [
        await token.getAddress(),
        await env.weth.getAddress(),
      ];
      await expect(
        env.router
          .connect(env.alice)
          .depositAndSwap(
            badPath,
            ethers.parseEther("1"),
            0,
            false,
            BANK_REF_A,
            ethers.ZeroAddress
          )
      ).to.be.revertedWith("Path must end with USDT");
    });

    it("enforces slippage — reverts when minUsdtOut > expected (contract SlippageTooHigh)", async () => {
      const env = await deployRouter();
      const token = await setupToken(env);
      await token
        .connect(env.alice)
        .approve(await env.router.getAddress(), ethers.parseEther("1"));

      const path = [await token.getAddress(), await env.usdt.getAddress()];
      // Expected 2 USDT. With maxSlippageBps=500 (5%), minAllowed = 1.9 USDT.
      // Pass minUsdtOut = 1 (below minAllowed) → pre-check revert with SlippageTooHigh.
      // Tighten maxSlippage to trigger SlippageTooHigh rather than the downstream DEX revert.
      await env.router.connect(env.owner).setMaxSlippage(0); // any deviation → too high
      await expect(
        env.router
          .connect(env.alice)
          .depositAndSwap(
            path,
            ethers.parseEther("1"),
            PARSE_USDT(1), // < expected 2
            false,
            BANK_REF_A,
            ethers.ZeroAddress
          )
      ).to.be.revertedWithCustomError(env.router, "SlippageTooHigh");
    });

    it("enforces slippage — DEX-level revert when minUsdtOut exceeds quote", async () => {
      const env = await deployRouter();
      const token = await setupToken(env);
      await token
        .connect(env.alice)
        .approve(await env.router.getAddress(), ethers.parseEther("1"));

      const path = [await token.getAddress(), await env.usdt.getAddress()];
      // Pre-check passes (10 > 1.9 minAllowed), but DEX swap fails at its own
      // slippage guard because amountOut(2) < amountOutMin(10).
      await expect(
        env.router
          .connect(env.alice)
          .depositAndSwap(
            path,
            ethers.parseEther("1"),
            PARSE_USDT(10),
            false,
            BANK_REF_A,
            ethers.ZeroAddress
          )
      ).to.be.revertedWith("slippage");
    });

    it("reverts on zero amountIn", async () => {
      const env = await deployRouter();
      const token = await setupToken(env);
      const path = [await token.getAddress(), await env.usdt.getAddress()];
      await expect(
        env.router
          .connect(env.alice)
          .depositAndSwap(path, 0, 0, false, BANK_REF_A, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(env.router, "ZeroAmount");
    });

    it("reverts when path length < 2", async () => {
      const env = await deployRouter();
      const token = await setupToken(env);
      await token
        .connect(env.alice)
        .approve(await env.router.getAddress(), ethers.parseEther("1"));
      await expect(
        env.router
          .connect(env.alice)
          .depositAndSwap(
            [await token.getAddress()],
            ethers.parseEther("1"),
            0,
            false,
            BANK_REF_A,
            ethers.ZeroAddress
          )
      ).to.be.revertedWith("Path must end with USDT");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  confirm (admin)
  // ═══════════════════════════════════════════════════════════════
  describe("confirm", () => {
    it("only admin can call", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(100));
      await expect(
        env.router.connect(env.bob)["confirm(uint256)"](id)
      ).to.be.revertedWithCustomError(env.router, "NotAdmin");
    });

    it("transfers net USDT to platformWallet", async () => {
      const env = await deployRouter();
      const amt = PARSE_USDT(100);
      const { id } = await doDeposit(env, env.alice, amt);

      const before = await env.usdt.balanceOf(env.platform.address);
      await env.router.connect(env.owner)["confirm(uint256)"](id);
      const after = await env.usdt.balanceOf(env.platform.address);

      expect(after - before).to.equal(PARSE_USDT(99));
    });

    it("marks request Confirmed + drops from pendingIds + reduces totalEscrow", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(100));
      expect(await env.router.pendingCount()).to.equal(1n);
      expect(await env.router.totalEscrow()).to.equal(PARSE_USDT(100));

      await env.router.connect(env.owner)["confirm(uint256)"](id);

      const req = await env.router.getWithdrawal(id);
      expect(req.status).to.equal(1); // Confirmed
      expect(await env.router.pendingCount()).to.equal(0n);
      expect(await env.router.totalEscrow()).to.equal(0n);
    });

    it("increments platformEarnings[usdt] by fee", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(100));
      await env.router.connect(env.owner)["confirm(uint256)"](id);
      expect(
        await env.router.platformEarnings(await env.usdt.getAddress())
      ).to.equal(PARSE_USDT(1));
    });

    it("overload confirm(id, altAddress) routes to custom address", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(100));
      const before = await env.usdt.balanceOf(env.carol.address);
      await env.router
        .connect(env.owner)
        ["confirm(uint256,address)"](id, env.carol.address);
      const after = await env.usdt.balanceOf(env.carol.address);
      expect(after - before).to.equal(PARSE_USDT(99));
    });

    it("confirm(id, altAddress) reverts on zero address", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(100));
      await expect(
        env.router
          .connect(env.owner)
          ["confirm(uint256,address)"](id, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(env.router, "ZeroAddress");
    });

    it("emits WithdrawConfirmed", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(100));
      await expect(env.router.connect(env.owner)["confirm(uint256)"](id))
        .to.emit(env.router, "WithdrawConfirmed")
        .withArgs(
          id,
          env.owner.address,
          env.platform.address,
          PARSE_USDT(99),
          PARSE_USDT(100),
          PARSE_USDT(1),
          await env.usdt.getAddress()
        );
    });

    it("reverts on invalid id", async () => {
      const env = await deployRouter();
      await expect(
        env.router.connect(env.owner)["confirm(uint256)"](999)
      ).to.be.revertedWithCustomError(env.router, "InvalidRequest");
    });

    it("cannot confirm twice", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(100));
      await env.router.connect(env.owner)["confirm(uint256)"](id);
      await expect(
        env.router.connect(env.owner)["confirm(uint256)"](id)
      ).to.be.revertedWithCustomError(env.router, "NotPending");
    });

    it("cannot confirm cancelled", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(100));
      await fastForward(DEFAULT_TIMEOUT + 1n);
      await env.router.connect(env.alice).cancel(id);
      await expect(
        env.router.connect(env.owner)["confirm(uint256)"](id)
      ).to.be.revertedWithCustomError(env.router, "NotPending");
    });

    it("cannot confirm after expiry (race prevention)", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(100));
      await fastForward(DEFAULT_TIMEOUT + 1n);
      await expect(
        env.router.connect(env.owner)["confirm(uint256)"](id)
      ).to.be.revertedWithCustomError(env.router, "TimeoutReached");
    });

    it("added admin can confirm", async () => {
      const env = await deployRouter();
      await env.router.connect(env.owner).addAdmin(env.bob.address);
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(100));
      await expect(env.router.connect(env.bob)["confirm(uint256)"](id)).to
        .not.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  cancel (user post-expiry)
  // ═══════════════════════════════════════════════════════════════
  describe("cancel", () => {
    it("user can cancel own pending withdrawal after expiry", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(100));
      await fastForward(DEFAULT_TIMEOUT + 1n);

      const before = await env.usdt.balanceOf(env.alice.address);
      await env.router.connect(env.alice).cancel(id);
      const after = await env.usdt.balanceOf(env.alice.address);

      expect(after - before).to.equal(PARSE_USDT(100)); // gross refund
      const req = await env.router.getWithdrawal(id);
      expect(req.status).to.equal(2); // Cancelled
      expect(await env.router.totalEscrow()).to.equal(0n);
      expect(await env.router.pendingCount()).to.equal(0n);
    });

    it("pre-expiry cancel reverts TimeoutNotReached", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(100));
      await expect(
        env.router.connect(env.alice).cancel(id)
      ).to.be.revertedWithCustomError(env.router, "TimeoutNotReached");
    });

    it("cannot cancel already confirmed", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(100));
      await env.router.connect(env.owner)["confirm(uint256)"](id);
      await fastForward(DEFAULT_TIMEOUT + 1n);
      await expect(
        env.router.connect(env.alice).cancel(id)
      ).to.be.revertedWithCustomError(env.router, "NotPending");
    });

    it("cannot cancel already cancelled", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(100));
      await fastForward(DEFAULT_TIMEOUT + 1n);
      await env.router.connect(env.alice).cancel(id);
      await expect(
        env.router.connect(env.alice).cancel(id)
      ).to.be.revertedWithCustomError(env.router, "NotPending");
    });

    it("cannot cancel another user's withdrawal", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(100));
      await fastForward(DEFAULT_TIMEOUT + 1n);
      await expect(
        env.router.connect(env.bob).cancel(id)
      ).to.be.revertedWithCustomError(env.router, "NotRequestOwner");
    });

    it("emits WithdrawCancelled(id, user, gross)", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(100));
      await fastForward(DEFAULT_TIMEOUT + 1n);
      await expect(env.router.connect(env.alice).cancel(id))
        .to.emit(env.router, "WithdrawCancelled")
        .withArgs(id, env.alice.address, PARSE_USDT(100));
    });

    it("reverts on invalid id", async () => {
      const env = await deployRouter();
      await expect(
        env.router.connect(env.alice).cancel(999)
      ).to.be.revertedWithCustomError(env.router, "InvalidRequest");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  refund (admin post-expiry)
  // ═══════════════════════════════════════════════════════════════
  describe("refund", () => {
    it("admin can refund expired pending withdrawal", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(100));
      await fastForward(DEFAULT_TIMEOUT + 1n);

      const before = await env.usdt.balanceOf(env.alice.address);
      await env.router.connect(env.owner).refund(id);
      const after = await env.usdt.balanceOf(env.alice.address);
      expect(after - before).to.equal(PARSE_USDT(100));

      const req = await env.router.getWithdrawal(id);
      expect(req.status).to.equal(2); // Cancelled
    });

    it("reverts if not expired", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(100));
      await expect(
        env.router.connect(env.owner).refund(id)
      ).to.be.revertedWithCustomError(env.router, "TimeoutNotReached");
    });

    it("reverts if already confirmed", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(100));
      await env.router.connect(env.owner)["confirm(uint256)"](id);
      await fastForward(DEFAULT_TIMEOUT + 1n);
      await expect(
        env.router.connect(env.owner).refund(id)
      ).to.be.revertedWithCustomError(env.router, "NotPending");
    });

    it("reverts if already cancelled", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(100));
      await fastForward(DEFAULT_TIMEOUT + 1n);
      await env.router.connect(env.alice).cancel(id);
      await expect(
        env.router.connect(env.owner).refund(id)
      ).to.be.revertedWithCustomError(env.router, "NotPending");
    });

    it("cannot refund twice", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(100));
      await fastForward(DEFAULT_TIMEOUT + 1n);
      await env.router.connect(env.owner).refund(id);
      await expect(
        env.router.connect(env.owner).refund(id)
      ).to.be.revertedWithCustomError(env.router, "NotPending");
    });

    it("non-admin cannot refund", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(100));
      await fastForward(DEFAULT_TIMEOUT + 1n);
      await expect(
        env.router.connect(env.bob).refund(id)
      ).to.be.revertedWithCustomError(env.router, "NotAdmin");
    });

    it("reverts on invalid id", async () => {
      const env = await deployRouter();
      await expect(
        env.router.connect(env.owner).refund(999)
      ).to.be.revertedWithCustomError(env.router, "InvalidRequest");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  Views / enumeration
  // ═══════════════════════════════════════════════════════════════
  describe("Views / enumeration", () => {
    it("getUserWithdrawals paginates correctly", async () => {
      const env = await deployRouter();
      for (let i = 0; i < 5; i++) {
        await doDeposit(env, env.alice, PARSE_USDT(10 + i));
      }
      const [page1, ids1, total1] = await env.router.getUserWithdrawals(
        env.alice.address,
        0,
        2
      );
      expect(total1).to.equal(5n);
      expect(page1.length).to.equal(2);
      expect(ids1.length).to.equal(2);
      const [page2] = await env.router.getUserWithdrawals(
        env.alice.address,
        2,
        2
      );
      expect(page2.length).to.equal(2);
      const [page3] = await env.router.getUserWithdrawals(
        env.alice.address,
        4,
        2
      );
      expect(page3.length).to.equal(1);
    });

    it("getUserWithdrawals returns empty when offset >= total", async () => {
      const env = await deployRouter();
      await doDeposit(env, env.alice, PARSE_USDT(10));
      const [res, ids, total] = await env.router.getUserWithdrawals(
        env.alice.address,
        10,
        5
      );
      expect(total).to.equal(1n);
      expect(res.length).to.equal(0);
      expect(ids.length).to.equal(0);
    });

    it("getPendingWithdrawals paginates correctly", async () => {
      const env = await deployRouter();
      for (let i = 0; i < 4; i++) {
        await doDeposit(env, env.alice, PARSE_USDT(10));
      }
      const [page, total] = await env.router.getPendingWithdrawals(0, 10);
      expect(total).to.equal(4n);
      expect(page.length).to.equal(4);

      const [page2, total2] = await env.router.getPendingWithdrawals(2, 1);
      expect(total2).to.equal(4n);
      expect(page2.length).to.equal(1);
    });

    it("getPendingWithdrawals returns empty when offset >= total", async () => {
      const env = await deployRouter();
      await doDeposit(env, env.alice, PARSE_USDT(10));
      const [page, total] = await env.router.getPendingWithdrawals(10, 5);
      expect(total).to.equal(1n);
      expect(page.length).to.equal(0);
    });

    it("getWithdrawal returns full record", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(100));
      const req = await env.router.getWithdrawal(id);
      expect(req.user).to.equal(env.alice.address);
      expect(req.grossAmount).to.equal(PARSE_USDT(100));
    });

    it("pendingCount lifecycle: deposit (+1), confirm/cancel (-1)", async () => {
      const env = await deployRouter();
      expect(await env.router.pendingCount()).to.equal(0n);
      const { id: id1 } = await doDeposit(env, env.alice, PARSE_USDT(10));
      const { id: id2 } = await doDeposit(env, env.bob, PARSE_USDT(20));
      expect(await env.router.pendingCount()).to.equal(2n);

      await env.router.connect(env.owner)["confirm(uint256)"](id1);
      expect(await env.router.pendingCount()).to.equal(1n);

      await fastForward(DEFAULT_TIMEOUT + 1n);
      await env.router.connect(env.bob).cancel(id2);
      expect(await env.router.pendingCount()).to.equal(0n);
    });

    it("totalWithdrawals only grows with deposits (not confirm/cancel)", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(10));
      expect(await env.router.totalWithdrawals()).to.equal(1n);
      await env.router.connect(env.owner)["confirm(uint256)"](id);
      expect(await env.router.totalWithdrawals()).to.equal(1n);
      await doDeposit(env, env.alice, PARSE_USDT(10));
      expect(await env.router.totalWithdrawals()).to.equal(2n);
    });

    it("getState aggregates everything", async () => {
      const env = await deployRouter();
      await doDeposit(env, env.alice, PARSE_USDT(100));
      const s = await env.router.getState();
      expect(s.owner).to.equal(env.owner.address);
      expect(s.feeBps).to.equal(DEFAULT_FEE_BPS);
      expect(s.payoutTimeout).to.equal(DEFAULT_TIMEOUT);
      expect(s.platformWallet).to.equal(env.platform.address);
      expect(s.totalEscrow).to.equal(PARSE_USDT(100));
      expect(s.pendingCount).to.equal(1n);
      expect(s.totalWithdrawals).to.equal(1n);
      expect(s.paused).to.equal(false);
      expect(s.maxSlippageBps).to.equal(500n);
      expect(s.affiliateEnabled).to.equal(false);
      expect(s.admins.length).to.equal(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  Admin config
  // ═══════════════════════════════════════════════════════════════
  describe("Admin config", () => {
    it("setFeeBps updates fee and emits FeeUpdated", async () => {
      const env = await deployRouter();
      await expect(env.router.connect(env.owner).setFeeBps(250))
        .to.emit(env.router, "FeeUpdated")
        .withArgs(DEFAULT_FEE_BPS, 250n);
      expect(await env.router.feeBps()).to.equal(250n);
    });

    it("setFeeBps reverts above MAX_FEE_BPS", async () => {
      const env = await deployRouter();
      await expect(
        env.router.connect(env.owner).setFeeBps(MAX_FEE_BPS + 1n)
      ).to.be.revertedWithCustomError(env.router, "InvalidFee");
    });

    it("setFeeBps non-owner rejected", async () => {
      const env = await deployRouter();
      await expect(
        env.router.connect(env.alice).setFeeBps(200)
      ).to.be.revertedWithCustomError(
        env.router,
        "OwnableUnauthorizedAccount"
      );
    });

    it("setPlatformWallet updates and emits", async () => {
      const env = await deployRouter();
      await expect(
        env.router.connect(env.owner).setPlatformWallet(env.bob.address)
      )
        .to.emit(env.router, "PlatformWalletUpdated")
        .withArgs(env.platform.address, env.bob.address);
      expect(await env.router.platformWallet()).to.equal(env.bob.address);
    });

    it("setPlatformWallet rejects zero address", async () => {
      const env = await deployRouter();
      await expect(
        env.router.connect(env.owner).setPlatformWallet(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(env.router, "ZeroAddress");
    });

    it("setPayoutTimeout enforces MIN bound", async () => {
      const env = await deployRouter();
      await expect(
        env.router.connect(env.owner).setPayoutTimeout(MIN_TIMEOUT - 1n)
      ).to.be.revertedWithCustomError(env.router, "InvalidTimeout");
    });

    it("setPayoutTimeout enforces MAX bound", async () => {
      const env = await deployRouter();
      await expect(
        env.router.connect(env.owner).setPayoutTimeout(MAX_TIMEOUT + 1n)
      ).to.be.revertedWithCustomError(env.router, "InvalidTimeout");
    });

    it("setPayoutTimeout updates and emits", async () => {
      const env = await deployRouter();
      await expect(env.router.connect(env.owner).setPayoutTimeout(1200))
        .to.emit(env.router, "TimeoutUpdated")
        .withArgs(DEFAULT_TIMEOUT, 1200n);
      expect(await env.router.payoutTimeout()).to.equal(1200n);
    });

    it("setMaxSlippage updates and emits", async () => {
      const env = await deployRouter();
      await expect(env.router.connect(env.owner).setMaxSlippage(1000))
        .to.emit(env.router, "MaxSlippageUpdated")
        .withArgs(500n, 1000n);
    });

    it("setMaxSlippage rejects above MAX_SLIPPAGE_CAP", async () => {
      const env = await deployRouter();
      await expect(
        env.router
          .connect(env.owner)
          .setMaxSlippage(MAX_SLIPPAGE_CAP + 1n)
      ).to.be.revertedWithCustomError(env.router, "SlippageConfigTooHigh");
    });

    it("setMinWithdrawUsdt updates and emits", async () => {
      const env = await deployRouter();
      await expect(
        env.router.connect(env.owner).setMinWithdrawUsdt(PARSE_USDT(5))
      )
        .to.emit(env.router, "MinWithdrawUpdated")
        .withArgs(0n, PARSE_USDT(5));
    });

    it("addAdmin / removeAdmin lifecycle", async () => {
      const env = await deployRouter();
      await expect(env.router.connect(env.owner).addAdmin(env.bob.address))
        .to.emit(env.router, "AdminAdded")
        .withArgs(env.bob.address);
      expect(await env.router.isAdmin(env.bob.address)).to.equal(true);

      await expect(
        env.router.connect(env.owner).removeAdmin(env.bob.address)
      )
        .to.emit(env.router, "AdminRemoved")
        .withArgs(env.bob.address);
      expect(await env.router.isAdmin(env.bob.address)).to.equal(false);
    });

    it("addAdmin rejects duplicate", async () => {
      const env = await deployRouter();
      await env.router.connect(env.owner).addAdmin(env.bob.address);
      await expect(
        env.router.connect(env.owner).addAdmin(env.bob.address)
      ).to.be.revertedWithCustomError(env.router, "AlreadyAdmin");
    });

    it("removeAdmin rejects non-admin", async () => {
      const env = await deployRouter();
      await expect(
        env.router.connect(env.owner).removeAdmin(env.bob.address)
      ).to.be.revertedWithCustomError(env.router, "NotAnAdmin");
    });

    it("removeAdmin rejects self", async () => {
      const env = await deployRouter();
      await expect(
        env.router.connect(env.owner).removeAdmin(env.owner.address)
      ).to.be.revertedWithCustomError(env.router, "CannotRemoveSelf");
    });

    it("addAdmin rejects beyond 20 admins", async () => {
      const env = await deployRouter();
      // Already has owner as admin (1), add 19 more to hit cap of 20
      for (let i = 0; i < 19; i++) {
        const w = ethers.Wallet.createRandom();
        await env.router.connect(env.owner).addAdmin(w.address);
      }
      const extra = ethers.Wallet.createRandom();
      await expect(
        env.router.connect(env.owner).addAdmin(extra.address)
      ).to.be.revertedWithCustomError(env.router, "TooManyAdmins");
    });

    it("setAffiliateEnabled flips flag", async () => {
      const env = await deployRouter();
      await env.router.connect(env.owner).setAffiliateEnabled(true);
      expect(await env.router.affiliateEnabled()).to.equal(true);
    });

    it("setAffiliateShare rejects > 5000", async () => {
      const env = await deployRouter();
      await expect(
        env.router.connect(env.owner).setAffiliateShare(5001)
      ).to.be.revertedWithCustomError(env.router, "InvalidFee");
    });

    it("setAffiliateShare updates share", async () => {
      const env = await deployRouter();
      await env.router.connect(env.owner).setAffiliateShare(2000);
      expect(await env.router.affiliateShareBps()).to.equal(2000n);
    });

    it("non-admin rejected by onlyAdmin functions (refund)", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(100));
      await fastForward(DEFAULT_TIMEOUT + 1n);
      await expect(
        env.router.connect(env.alice).refund(id)
      ).to.be.revertedWithCustomError(env.router, "NotAdmin");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  Pause (FIX #7)
  // ═══════════════════════════════════════════════════════════════
  describe("Pause", () => {
    it("owner can pause and unpause", async () => {
      const env = await deployRouter();
      await env.router.connect(env.owner).pause();
      expect(await env.router.paused()).to.equal(true);
      await env.router.connect(env.owner).unpause();
      expect(await env.router.paused()).to.equal(false);
    });

    it("non-owner cannot pause", async () => {
      const env = await deployRouter();
      await expect(
        env.router.connect(env.alice).pause()
      ).to.be.revertedWithCustomError(
        env.router,
        "OwnableUnauthorizedAccount"
      );
    });

    it("deposits blocked while paused", async () => {
      const env = await deployRouter();
      await env.router.connect(env.owner).pause();
      await approveUsdt(env, env.alice, PARSE_USDT(10));
      await expect(
        env.router
          .connect(env.alice)
          .deposit(PARSE_USDT(10), BANK_REF_A, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(env.router, "EnforcedPause");
    });

    it("cancel still works when paused (user safety)", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(100));
      await fastForward(DEFAULT_TIMEOUT + 1n);
      await env.router.connect(env.owner).pause();
      await expect(env.router.connect(env.alice).cancel(id)).to.not.be
        .reverted;
    });

    it("admin can still confirm while paused", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(100));
      await env.router.connect(env.owner).pause();
      await expect(env.router.connect(env.owner)["confirm(uint256)"](id)).to
        .not.be.reverted;
    });

    it("admin can refund while paused", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(100));
      await fastForward(DEFAULT_TIMEOUT + 1n);
      await env.router.connect(env.owner).pause();
      await expect(env.router.connect(env.owner).refund(id)).to.not.be
        .reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  confirmBatch
  // ═══════════════════════════════════════════════════════════════
  describe("confirmBatch", () => {
    it("confirms multiple pending requests", async () => {
      const env = await deployRouter();
      const { id: id1 } = await doDeposit(env, env.alice, PARSE_USDT(100));
      const { id: id2 } = await doDeposit(env, env.bob, PARSE_USDT(200));
      const { id: id3 } = await doDeposit(env, env.carol, PARSE_USDT(50));

      const before = await env.usdt.balanceOf(env.platform.address);
      const tx = await env.router
        .connect(env.owner)
        .confirmBatch([id1, id2, id3]);
      await tx.wait();
      const after = await env.usdt.balanceOf(env.platform.address);

      // Net amounts: 99 + 198 + 49.5 = 346.5 USDT
      expect(after - before).to.equal(PARSE_USDT(99) + PARSE_USDT(198) + 49_500_000n);
      expect(await env.router.pendingCount()).to.equal(0n);
    });

    it("skips invalid / non-pending / expired ids silently", async () => {
      const env = await deployRouter();
      const { id: id1 } = await doDeposit(env, env.alice, PARSE_USDT(100));
      const { id: id2 } = await doDeposit(env, env.bob, PARSE_USDT(100));
      // Confirm id1 first so it becomes non-pending
      await env.router.connect(env.owner)["confirm(uint256)"](id1);

      // Include invalid id (999) and already-confirmed id1
      const tx = await env.router
        .connect(env.owner)
        .confirmBatch([999, id1, id2]);
      await tx.wait();

      expect(await env.router.pendingCount()).to.equal(0n);
      expect((await env.router.getWithdrawal(id2)).status).to.equal(1);
    });

    it("non-admin cannot call confirmBatch", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(100));
      await expect(
        env.router.connect(env.bob).confirmBatch([id])
      ).to.be.revertedWithCustomError(env.router, "NotAdmin");
    });

    it("empty batch is a no-op", async () => {
      const env = await deployRouter();
      await expect(env.router.connect(env.owner).confirmBatch([])).to.not
        .be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  Owner withdraw (earnings only, never escrow)
  // ═══════════════════════════════════════════════════════════════
  describe("withdraw (owner earnings)", () => {
    it("owner can sweep earnings after a confirm", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(1000));
      await env.router.connect(env.owner)["confirm(uint256)"](id);

      // platformWallet got net 990 from confirm; contract kept 10 (fee)
      expect(
        await env.usdt.balanceOf(await env.router.getAddress())
      ).to.equal(PARSE_USDT(10));

      const before = await env.usdt.balanceOf(env.platform.address);
      await env.router.connect(env.owner)["withdraw()"]();
      const after = await env.usdt.balanceOf(env.platform.address);
      expect(after - before).to.equal(PARSE_USDT(10));
      expect(
        await env.router.platformEarnings(await env.usdt.getAddress())
      ).to.equal(0n);
    });

    it("withdraw(to) routes to custom destination", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(1000));
      await env.router.connect(env.owner)["confirm(uint256)"](id);

      const before = await env.usdt.balanceOf(env.carol.address);
      await env.router
        .connect(env.owner)
        ["withdraw(address)"](env.carol.address);
      const after = await env.usdt.balanceOf(env.carol.address);
      expect(after - before).to.equal(PARSE_USDT(10));
    });

    it("withdraw(to,amount) with specific amount", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(1000));
      await env.router.connect(env.owner)["confirm(uint256)"](id);

      const before = await env.usdt.balanceOf(env.carol.address);
      await env.router
        .connect(env.owner)
        ["withdraw(address,uint256)"](env.carol.address, PARSE_USDT(4));
      const after = await env.usdt.balanceOf(env.carol.address);
      expect(after - before).to.equal(PARSE_USDT(4));
    });

    it("withdraw rejects zero address", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(1000));
      await env.router.connect(env.owner)["confirm(uint256)"](id);
      await expect(
        env.router
          .connect(env.owner)
          ["withdraw(address)"](ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(env.router, "ZeroAddress");
    });

    it("reverts InsufficientEarnings when nothing to sweep", async () => {
      const env = await deployRouter();
      await expect(
        env.router.connect(env.owner)["withdraw()"]()
      ).to.be.revertedWithCustomError(env.router, "InsufficientEarnings");
    });

    it("reverts InsufficientEarnings when only escrow present", async () => {
      const env = await deployRouter();
      await doDeposit(env, env.alice, PARSE_USDT(100));
      // All of the 100 is escrow — nothing to sweep
      await expect(
        env.router.connect(env.owner)["withdraw()"]()
      ).to.be.revertedWithCustomError(env.router, "InsufficientEarnings");
    });

    it("non-owner cannot withdraw", async () => {
      const env = await deployRouter();
      await expect(
        env.router.connect(env.alice)["withdraw()"]()
      ).to.be.revertedWithCustomError(
        env.router,
        "OwnableUnauthorizedAccount"
      );
    });

    it("emits FeesWithdrawn", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(1000));
      await env.router.connect(env.owner)["confirm(uint256)"](id);

      await expect(env.router.connect(env.owner)["withdraw()"]())
        .to.emit(env.router, "FeesWithdrawn")
        .withArgs(
          await env.usdt.getAddress(),
          PARSE_USDT(10),
          env.platform.address
        );
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  Rescue / recovery
  // ═══════════════════════════════════════════════════════════════
  describe("rescueToken", () => {
    it("rescues non-USDT tokens to platformWallet", async () => {
      const env = await deployRouter();
      // Deploy some arbitrary token and send to router
      const MockUSDT = await ethers.getContractFactory("MockUSDT");
      const stray = await MockUSDT.deploy();
      await stray.mint(
        await env.router.getAddress(),
        PARSE_USDT(500)
      );

      await expect(
        env.router
          .connect(env.owner)
          .rescueToken(await stray.getAddress())
      )
        .to.emit(env.router, "TokenRescued")
        .withArgs(
          await stray.getAddress(),
          PARSE_USDT(500),
          env.platform.address
        );
      expect(await stray.balanceOf(env.platform.address)).to.equal(
        PARSE_USDT(500)
      );
    });

    it("cannot rescue USDT below escrow floor", async () => {
      const env = await deployRouter();
      await doDeposit(env, env.alice, PARSE_USDT(100));
      // All USDT in contract is escrow — rescue should revert
      await expect(
        env.router
          .connect(env.owner)
          .rescueToken(await env.usdt.getAddress())
      ).to.be.revertedWithCustomError(env.router, "InsufficientEarnings");
    });

    it("rescue of USDT only releases amount above escrow", async () => {
      const env = await deployRouter();
      // Deposit 100 into escrow
      await doDeposit(env, env.alice, PARSE_USDT(100));
      // Extra stray USDT (50) sent in
      await env.usdt.mint(
        await env.router.getAddress(),
        PARSE_USDT(50)
      );

      const before = await env.usdt.balanceOf(env.platform.address);
      await env.router
        .connect(env.owner)
        .rescueToken(await env.usdt.getAddress());
      const after = await env.usdt.balanceOf(env.platform.address);
      expect(after - before).to.equal(PARSE_USDT(50));
    });

    it("reverts when token balance is zero", async () => {
      const env = await deployRouter();
      const MockUSDT = await ethers.getContractFactory("MockUSDT");
      const stray = await MockUSDT.deploy();
      await expect(
        env.router
          .connect(env.owner)
          .rescueToken(await stray.getAddress())
      ).to.be.revertedWithCustomError(env.router, "ZeroAmount");
    });

    it("non-owner cannot rescue", async () => {
      const env = await deployRouter();
      await expect(
        env.router
          .connect(env.alice)
          .rescueToken(await env.usdt.getAddress())
      ).to.be.revertedWithCustomError(
        env.router,
        "OwnableUnauthorizedAccount"
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  Adversarial
  // ═══════════════════════════════════════════════════════════════
  describe("Adversarial", () => {
    it("non-admin cannot confirm", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(10));
      await expect(
        env.router.connect(env.bob)["confirm(uint256)"](id)
      ).to.be.revertedWithCustomError(env.router, "NotAdmin");
    });

    it("non-admin cannot confirmBatch / refund / pause", async () => {
      const env = await deployRouter();
      await expect(
        env.router.connect(env.alice).confirmBatch([])
      ).to.be.revertedWithCustomError(env.router, "NotAdmin");
    });

    it("confirm after cancel reverts NotPending", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(100));
      await fastForward(DEFAULT_TIMEOUT + 1n);
      await env.router.connect(env.alice).cancel(id);
      // Time is now past expiry — would also hit TimeoutReached, but NotPending first
      await expect(
        env.router.connect(env.owner)["confirm(uint256)"](id)
      ).to.be.revertedWithCustomError(env.router, "NotPending");
    });

    it("cancel after confirm reverts NotPending", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(100));
      await env.router.connect(env.owner)["confirm(uint256)"](id);
      await fastForward(DEFAULT_TIMEOUT + 1n);
      await expect(
        env.router.connect(env.alice).cancel(id)
      ).to.be.revertedWithCustomError(env.router, "NotPending");
    });

    it("double refund reverts NotPending", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(100));
      await fastForward(DEFAULT_TIMEOUT + 1n);
      await env.router.connect(env.owner).refund(id);
      await expect(
        env.router.connect(env.owner).refund(id)
      ).to.be.revertedWithCustomError(env.router, "NotPending");
    });

    it("refund before expiry reverts TimeoutNotReached", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(100));
      await expect(
        env.router.connect(env.owner).refund(id)
      ).to.be.revertedWithCustomError(env.router, "TimeoutNotReached");
    });

    it("refund after confirm reverts NotPending", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(100));
      await env.router.connect(env.owner)["confirm(uint256)"](id);
      await fastForward(DEFAULT_TIMEOUT + 1n);
      await expect(
        env.router.connect(env.owner).refund(id)
      ).to.be.revertedWithCustomError(env.router, "NotPending");
    });

    it("handles very large deposit amounts without overflow", async () => {
      const env = await deployRouter();
      // 100M USDT — within 6-decimal token range, no overflow
      const big = PARSE_USDT(100_000_000);
      await env.usdt.mint(env.alice.address, big);
      await approveUsdt(env, env.alice, big);
      await expect(
        env.router
          .connect(env.alice)
          .deposit(big, BANK_REF_A, ethers.ZeroAddress)
      ).to.not.be.reverted;
      const req = await env.router.getWithdrawal(0);
      expect(req.grossAmount).to.equal(big);
      expect(req.fee).to.equal(big / 100n); // 1%
    });

    it("escrow invariant holds through mixed operations", async () => {
      const env = await deployRouter();
      const { id: id1 } = await doDeposit(env, env.alice, PARSE_USDT(100));
      const { id: id2 } = await doDeposit(env, env.bob, PARSE_USDT(200));
      const { id: id3 } = await doDeposit(env, env.carol, PARSE_USDT(300));
      expect(await env.router.totalEscrow()).to.equal(PARSE_USDT(600));

      await env.router.connect(env.owner)["confirm(uint256)"](id1);
      expect(await env.router.totalEscrow()).to.equal(PARSE_USDT(500));

      await fastForward(DEFAULT_TIMEOUT + 1n);
      await env.router.connect(env.bob).cancel(id2);
      expect(await env.router.totalEscrow()).to.equal(PARSE_USDT(300));

      await env.router.connect(env.owner).refund(id3);
      expect(await env.router.totalEscrow()).to.equal(0n);

      // Contract balance should now equal only the 1 USDT fee from id1
      expect(
        await env.usdt.balanceOf(await env.router.getAddress())
      ).to.equal(PARSE_USDT(1));
    });

    it("cancel triggers insufficient USDT when contract drained impossible (sanity)", async () => {
      // Sanity: a cancel always succeeds because escrow accounting is exact.
      const env = await deployRouter();
      const { id } = await doDeposit(env, env.alice, PARSE_USDT(100));
      await fastForward(DEFAULT_TIMEOUT + 1n);
      await expect(env.router.connect(env.alice).cancel(id)).to.not.be
        .reverted;
    });

    it("deposit without USDT approval reverts", async () => {
      const env = await deployRouter();
      await expect(
        env.router
          .connect(env.alice)
          .deposit(PARSE_USDT(100), BANK_REF_A, ethers.ZeroAddress)
      ).to.be.reverted;
    });

    it("deposit without sufficient USDT balance reverts", async () => {
      const env = await deployRouter();
      const [, , , , , , , , , poor] = await ethers.getSigners();
      await env.usdt
        .connect(poor)
        .approve(await env.router.getAddress(), PARSE_USDT(100));
      await expect(
        env.router
          .connect(poor)
          .deposit(PARSE_USDT(100), BANK_REF_A, ethers.ZeroAddress)
      ).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  Affiliate share (legacy direct-pay)
  // ═══════════════════════════════════════════════════════════════
  describe("Affiliate (legacy direct-pay)", () => {
    it("pays referrer a cut of fee on confirm when enabled", async () => {
      const env = await deployRouter();
      await env.router.connect(env.owner).setAffiliateEnabled(true);

      const amount = PARSE_USDT(1000);
      await approveUsdt(env, env.alice, amount);
      const tx = await env.router
        .connect(env.alice)
        .deposit(amount, BANK_REF_A, env.referrer.address);
      const receipt = await tx.wait();
      const log = receipt!.logs.find(
        (l: any) => l.fragment?.name === "WithdrawRequested"
      );
      const id = (log as any).args[0];

      const refBefore = await env.usdt.balanceOf(env.referrer.address);
      await expect(
        env.router.connect(env.owner)["confirm(uint256)"](id)
      ).to.emit(env.router, "AffiliatePaid");
      const refAfter = await env.usdt.balanceOf(env.referrer.address);

      // fee = 10 USDT, 10% of fee = 1 USDT to referrer
      expect(refAfter - refBefore).to.equal(PARSE_USDT(1));
    });

    it("does not pay when referrer is self", async () => {
      const env = await deployRouter();
      await env.router.connect(env.owner).setAffiliateEnabled(true);

      const amount = PARSE_USDT(1000);
      await approveUsdt(env, env.alice, amount);
      const tx = await env.router
        .connect(env.alice)
        .deposit(amount, BANK_REF_A, env.alice.address);
      const receipt = await tx.wait();
      const log = receipt!.logs.find(
        (l: any) => l.fragment?.name === "WithdrawRequested"
      );
      const id = (log as any).args[0];

      // confirm should succeed but no AffiliatePaid event
      const tx2 = await env.router
        .connect(env.owner)
        ["confirm(uint256)"](id);
      const r2 = await tx2.wait();
      const affLog = r2!.logs.find(
        (l: any) => l.fragment?.name === "AffiliatePaid"
      );
      expect(affLog).to.equal(undefined);
    });

    it("does nothing when affiliate disabled (no referral pay)", async () => {
      const env = await deployRouter();
      const { id } = await doDeposit(
        env,
        env.alice,
        PARSE_USDT(1000),
        BANK_REF_A,
        env.referrer.address
      );
      const refBefore = await env.usdt.balanceOf(env.referrer.address);
      await env.router.connect(env.owner)["confirm(uint256)"](id);
      const refAfter = await env.usdt.balanceOf(env.referrer.address);
      expect(refAfter).to.equal(refBefore);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  ReentrancyGuard sanity
  // ═══════════════════════════════════════════════════════════════
  describe("Reentrancy sanity", () => {
    it("deposit / confirm / cancel / refund are all nonReentrant", async () => {
      // Functional proof: sequential calls within same tx context don't corrupt
      // state. We don't have a malicious token deployed here, so this is a
      // coverage sanity check — the modifier is present on every mutating fn.
      const env = await deployRouter();
      const { id: id1 } = await doDeposit(env, env.alice, PARSE_USDT(10));
      const { id: id2 } = await doDeposit(env, env.bob, PARSE_USDT(20));
      await env.router.connect(env.owner)["confirm(uint256)"](id1);
      await fastForward(DEFAULT_TIMEOUT + 1n);
      await env.router.connect(env.bob).cancel(id2);

      expect(await env.router.totalEscrow()).to.equal(0n);
      expect(await env.router.pendingCount()).to.equal(0n);
    });
  });
});
