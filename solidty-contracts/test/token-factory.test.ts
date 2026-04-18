import { expect } from "chai";
import { ethers } from "hardhat";
import {
  deployTokenStack,
  createToken,
  PARSE_USDT,
} from "./helpers/fixtures";

/**
 * TokenFactory test suite.
 *
 * Exercises constructor wiring, implementation registration, creation of all
 * 8 variants via bitfield (mintable=1, taxable=2, partner=4), fee handling,
 * adversarial access control, and edge cases around supply / decimals /
 * USDT approval.
 */
describe("TokenFactory", () => {
  // ─────────────────────────────────────────────────────────────
  // Deployment
  // ─────────────────────────────────────────────────────────────
  describe("Deployment", () => {
    it("wires usdt, dexRouter, and platformWallet from constructor", async () => {
      const s = await deployTokenStack();
      expect(await s.tokenFactory.usdt()).to.equal(await s.usdt.getAddress());
      expect(await s.tokenFactory.dexRouter()).to.equal(
        await s.dexRouter.getAddress()
      );
      expect(await s.tokenFactory.platformWallet()).to.equal(s.platform.address);
    });

    it("sets deployer as owner", async () => {
      const s = await deployTokenStack();
      expect(await s.tokenFactory.owner()).to.equal(s.owner.address);
    });

    it("reverts constructor on zero usdt / router / platform", async () => {
      const TF = await ethers.getContractFactory("TokenFactory");
      const [signer] = await ethers.getSigners();
      await expect(
        TF.deploy(ethers.ZeroAddress, signer.address, signer.address)
      ).to.be.revertedWithCustomError(TF, "InvalidAddress");
      await expect(
        TF.deploy(signer.address, ethers.ZeroAddress, signer.address)
      ).to.be.revertedWithCustomError(TF, "InvalidAddress");
      await expect(
        TF.deploy(signer.address, signer.address, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(TF, "InvalidAddress");
    });

    it("initializes default creation fees per type", async () => {
      const s = await deployTokenStack();
      // Defaults (in USDT, 6 decimals): 5 / 10 / 10 / 15 / 100 / 120 / 120 / 150
      expect(await s.tokenFactory.creationFee(0)).to.equal(PARSE_USDT(5));
      expect(await s.tokenFactory.creationFee(1)).to.equal(PARSE_USDT(10));
      expect(await s.tokenFactory.creationFee(2)).to.equal(PARSE_USDT(10));
      expect(await s.tokenFactory.creationFee(3)).to.equal(PARSE_USDT(15));
      expect(await s.tokenFactory.creationFee(4)).to.equal(PARSE_USDT(100));
      expect(await s.tokenFactory.creationFee(5)).to.equal(PARSE_USDT(120));
      expect(await s.tokenFactory.creationFee(6)).to.equal(PARSE_USDT(120));
      expect(await s.tokenFactory.creationFee(7)).to.equal(PARSE_USDT(150));
    });
  });

  // ─────────────────────────────────────────────────────────────
  // setImplementation
  // ─────────────────────────────────────────────────────────────
  describe("setImplementation", () => {
    it("stores the correct impl per typeKey (0..7)", async () => {
      const s = await deployTokenStack();
      const expected = [
        "BasicTokenImpl",
        "MintableTokenImpl",
        "TaxableTokenImpl",
        "TaxableMintableTokenImpl",
        "PartnerTokenImpl",
        "PartnerMintableTokenImpl",
        "PartnerTaxableTokenImpl",
        "PartnerTaxableMintableTokenImpl",
      ];
      for (let i = 0; i < 8; i++) {
        expect(await s.tokenFactory.implementations(i)).to.equal(
          await s.impls[expected[i]].getAddress()
        );
      }
    });

    it("rejects non-owner callers", async () => {
      const s = await deployTokenStack();
      await expect(
        s.tokenFactory.connect(s.alice).setImplementation(0, s.alice.address)
      ).to.be.revertedWithCustomError(
        s.tokenFactory,
        "OwnableUnauthorizedAccount"
      );
    });

    it("rejects out-of-range typeKey (>7)", async () => {
      const s = await deployTokenStack();
      await expect(
        s.tokenFactory.setImplementation(8, s.alice.address)
      ).to.be.revertedWithCustomError(s.tokenFactory, "InvalidTokenType");
    });

    it("rejects zero implementation address", async () => {
      const s = await deployTokenStack();
      await expect(
        s.tokenFactory.setImplementation(0, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(s.tokenFactory, "InvalidAddress");
    });

    it("emits ImplementationUpdated on change", async () => {
      const s = await deployTokenStack();
      const newImpl = await s.impls["BasicTokenImpl"].getAddress();
      await expect(s.tokenFactory.setImplementation(0, newImpl))
        .to.emit(s.tokenFactory, "ImplementationUpdated")
        .withArgs(0, newImpl);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // createToken — all 8 variants
  // ─────────────────────────────────────────────────────────────
  describe("createToken — all variants", () => {
    const variants: Array<{
      name: string;
      typeKey: number;
      isMintable: boolean;
      isTaxable: boolean;
      isPartner: boolean;
    }> = [
      { name: "Basic", typeKey: 0, isMintable: false, isTaxable: false, isPartner: false },
      { name: "Mintable", typeKey: 1, isMintable: true, isTaxable: false, isPartner: false },
      { name: "Taxable", typeKey: 2, isMintable: false, isTaxable: true, isPartner: false },
      { name: "TaxableMintable", typeKey: 3, isMintable: true, isTaxable: true, isPartner: false },
      { name: "Partner", typeKey: 4, isMintable: false, isTaxable: false, isPartner: true },
      { name: "PartnerMintable", typeKey: 5, isMintable: true, isTaxable: false, isPartner: true },
      { name: "PartnerTaxable", typeKey: 6, isMintable: false, isTaxable: true, isPartner: true },
      { name: "PartnerTaxableMintable", typeKey: 7, isMintable: true, isTaxable: true, isPartner: true },
    ];

    for (const v of variants) {
      it(`creates ${v.name} variant with correct metadata and supply`, async () => {
        const s = await deployTokenStack();
        const { token, tokenAddress, typeKey } = await createToken(s, s.alice, {
          name: `${v.name} Token`,
          symbol: v.name.slice(0, 4).toUpperCase(),
          supply: 1_000_000n,
          decimals: 18,
          isMintable: v.isMintable,
          isTaxable: v.isTaxable,
          isPartner: v.isPartner,
        });
        expect(typeKey).to.equal(v.typeKey);
        expect(await token.name()).to.equal(`${v.name} Token`);
        expect(await token.symbol()).to.equal(v.name.slice(0, 4).toUpperCase());
        expect(await token.decimals()).to.equal(18);
        expect(await token.totalSupply()).to.equal(1_000_000n * 10n ** 18n);
        expect(await token.balanceOf(s.alice.address)).to.equal(
          1_000_000n * 10n ** 18n
        );
        expect(await token.owner()).to.equal(s.alice.address);

        const info = await s.tokenFactory.tokenInfo(tokenAddress);
        expect(info.creator).to.equal(s.alice.address);
        expect(info.isMintable).to.equal(v.isMintable);
        expect(info.isTaxable).to.equal(v.isTaxable);
        expect(info.isPartnership).to.equal(v.isPartner);
      });
    }

    it("emits TokenCreated with correct args", async () => {
      const s = await deployTokenStack();
      const fee = await s.tokenFactory.creationFee(0);
      await s.usdt.mint(s.alice.address, fee);
      await s.usdt
        .connect(s.alice)
        .approve(await s.tokenFactory.getAddress(), fee);
      const params = {
        name: "Event Token",
        symbol: "EVT",
        totalSupply: 1_000n,
        decimals: 18,
        isTaxable: false,
        isMintable: false,
        isPartner: false,
        bases: [
          await s.weth.getAddress(),
          await s.usdt.getAddress(),
        ],
      };
      await expect(
        s.tokenFactory.connect(s.alice).createToken(params, ethers.ZeroAddress)
      ).to.emit(s.tokenFactory, "TokenCreated");
    });

    it("collects creation fee in USDT", async () => {
      const s = await deployTokenStack();
      const fee = await s.tokenFactory.creationFee(0);
      const before = await s.usdt.balanceOf(await s.tokenFactory.getAddress());
      await createToken(s, s.alice, { isMintable: false });
      const after = await s.usdt.balanceOf(await s.tokenFactory.getAddress());
      expect(after - before).to.equal(fee);
    });

    it("deploys EIP-1167 clone (small runtime bytecode)", async () => {
      const s = await deployTokenStack();
      const { tokenAddress } = await createToken(s, s.alice);
      const code = await ethers.provider.getCode(tokenAddress);
      // EIP-1167 minimal proxy: 45-byte runtime (0x2d bytes => 92 hex chars + "0x")
      expect(code.length).to.be.lessThan(200);
      expect(code.length).to.be.greaterThan(80);
    });

    it("increments totalTokensCreated and per-type counters", async () => {
      const s = await deployTokenStack();
      expect(await s.tokenFactory.totalTokensCreated()).to.equal(0);
      await createToken(s, s.alice, { isMintable: false });
      await createToken(s, s.alice, { isMintable: true });
      expect(await s.tokenFactory.totalTokensCreated()).to.equal(2);
      expect(await s.tokenFactory.tokensCreatedByType(0)).to.equal(1);
      expect(await s.tokenFactory.tokensCreatedByType(1)).to.equal(1);
    });

    it("tracks per-creator list", async () => {
      const s = await deployTokenStack();
      await createToken(s, s.alice);
      await createToken(s, s.alice);
      await createToken(s, s.bob);
      const aliceTokens = await s.tokenFactory.getCreatedTokens(s.alice.address);
      const bobTokens = await s.tokenFactory.getCreatedTokens(s.bob.address);
      expect(aliceTokens.length).to.equal(2);
      expect(bobTokens.length).to.equal(1);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // creationFee
  // ─────────────────────────────────────────────────────────────
  describe("creationFee", () => {
    it("setCreationFee updates storage (owner)", async () => {
      const s = await deployTokenStack();
      await s.tokenFactory.setCreationFee(0, PARSE_USDT(25));
      expect(await s.tokenFactory.creationFee(0)).to.equal(PARSE_USDT(25));
    });

    it("setCreationFee rejects non-owner", async () => {
      const s = await deployTokenStack();
      await expect(
        s.tokenFactory.connect(s.alice).setCreationFee(0, 1)
      ).to.be.revertedWithCustomError(
        s.tokenFactory,
        "OwnableUnauthorizedAccount"
      );
    });

    it("setCreationFee rejects out-of-range typeKey", async () => {
      const s = await deployTokenStack();
      await expect(
        s.tokenFactory.setCreationFee(8, 1)
      ).to.be.revertedWithCustomError(s.tokenFactory, "InvalidTokenType");
    });

    it("creating without USDT approval reverts", async () => {
      const s = await deployTokenStack();
      const params = {
        name: "No Approval",
        symbol: "NA",
        totalSupply: 1_000n,
        decimals: 18,
        isTaxable: false,
        isMintable: false,
        isPartner: false,
        bases: [
          await s.weth.getAddress(),
          await s.usdt.getAddress(),
        ],
      };
      // Give balance but not approval
      await s.usdt.mint(s.alice.address, PARSE_USDT(100));
      await expect(
        s.tokenFactory.connect(s.alice).createToken(params, ethers.ZeroAddress)
      ).to.be.reverted;
    });

    it("creating with insufficient USDT approval reverts", async () => {
      const s = await deployTokenStack();
      await s.usdt.mint(s.alice.address, PARSE_USDT(100));
      await s.usdt
        .connect(s.alice)
        .approve(await s.tokenFactory.getAddress(), PARSE_USDT(1)); // too little
      const params = {
        name: "Bad Approve",
        symbol: "BA",
        totalSupply: 1_000n,
        decimals: 18,
        isTaxable: false,
        isMintable: false,
        isPartner: false,
        bases: [await s.weth.getAddress(), await s.usdt.getAddress()],
      };
      await expect(
        s.tokenFactory.connect(s.alice).createToken(params, ethers.ZeroAddress)
      ).to.be.reverted;
    });

    it("zero fee allows creating without approval / balance", async () => {
      const s = await deployTokenStack();
      await s.tokenFactory.setCreationFee(0, 0);
      const params = {
        name: "Free Token",
        symbol: "FREE",
        totalSupply: 1_000n,
        decimals: 18,
        isTaxable: false,
        isMintable: false,
        isPartner: false,
        bases: [await s.weth.getAddress(), await s.usdt.getAddress()],
      };
      // No mint, no approval — still works
      await expect(
        s.tokenFactory.connect(s.alice).createToken(params, ethers.ZeroAddress)
      ).to.emit(s.tokenFactory, "TokenCreated");
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Authorization hooks — tokens expose isAuthorizedLauncher /
  // isExcludedFromLimits / isTaxFree used by the LaunchpadFactory.
  // ─────────────────────────────────────────────────────────────
  describe("Token auth hooks", () => {
    it("isAuthorizedLauncher mapping is wired", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice);
      expect(await token.isAuthorizedLauncher(s.bob.address)).to.equal(false);
      await token.connect(s.alice).setAuthorizedLauncher(s.bob.address, true);
      expect(await token.isAuthorizedLauncher(s.bob.address)).to.equal(true);
    });

    it("isExcludedFromLimits mapping is wired", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice);
      await token.connect(s.alice).setExcludedFromLimits(s.bob.address, true);
      expect(await token.isExcludedFromLimits(s.bob.address)).to.equal(true);
    });

    it("isTaxFree mapping exists on taxable variant and factory is pre-exempt", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice, { isTaxable: true });
      expect(await token.isTaxFree(await s.tokenFactory.getAddress())).to.equal(
        true
      );
    });
  });

  // ─────────────────────────────────────────────────────────────
  // USDT decimals
  // ─────────────────────────────────────────────────────────────
  describe("USDT decimals", () => {
    it("factory uses USDT 6-decimal scale for fees (default mock)", async () => {
      const s = await deployTokenStack();
      // 5 USDT = 5 * 10^6
      expect(await s.tokenFactory.creationFee(0)).to.equal(5n * 10n ** 6n);
    });

    it("factory scales fees correctly when deployed with 18-decimal USDT", async () => {
      const MockUSDT18 = await ethers.getContractFactory("MockUSDT18");
      const usdt18 = await MockUSDT18.deploy();
      const [owner, , platform] = await ethers.getSigners();
      const MockWETH = await ethers.getContractFactory("MockWETH");
      const weth = await MockWETH.deploy();
      const MockFactory = await ethers.getContractFactory(
        "MockUniswapV2Factory"
      );
      const factory = await MockFactory.deploy();
      const MockRouter = await ethers.getContractFactory("MockUniswapV2Router");
      const router = await MockRouter.deploy(
        await weth.getAddress(),
        await factory.getAddress()
      );

      const TF = await ethers.getContractFactory("TokenFactory");
      const tf = await TF.deploy(
        await usdt18.getAddress(),
        await router.getAddress(),
        platform.address
      );
      // 5 USDT in 18-decimal form
      expect(await tf.creationFee(0)).to.equal(5n * 10n ** 18n);
      expect(await tf.creationFee(7)).to.equal(150n * 10n ** 18n);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Adversarial
  // ─────────────────────────────────────────────────────────────
  describe("Adversarial", () => {
    it("non-owner cannot setImplementation", async () => {
      const s = await deployTokenStack();
      await expect(
        s.tokenFactory.connect(s.bob).setImplementation(0, s.bob.address)
      ).to.be.revertedWithCustomError(
        s.tokenFactory,
        "OwnableUnauthorizedAccount"
      );
    });

    it("non-owner cannot setCreationFee", async () => {
      const s = await deployTokenStack();
      await expect(
        s.tokenFactory.connect(s.bob).setCreationFee(0, 1)
      ).to.be.revertedWithCustomError(
        s.tokenFactory,
        "OwnableUnauthorizedAccount"
      );
    });

    it("createToken with implementation unset reverts", async () => {
      const [owner, , platform] = await ethers.getSigners();
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
      const TF = await ethers.getContractFactory("TokenFactory");
      const tf = await TF.deploy(
        await usdt.getAddress(),
        await dexRouter.getAddress(),
        platform.address
      );
      const params = {
        name: "No Impl",
        symbol: "NI",
        totalSupply: 1_000n,
        decimals: 18,
        isTaxable: false,
        isMintable: false,
        isPartner: false,
        bases: [await weth.getAddress(), await usdt.getAddress()],
      };
      await usdt.mint(owner.address, PARSE_USDT(1000));
      await usdt.approve(await tf.getAddress(), PARSE_USDT(1000));
      await expect(
        tf.createToken(params, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(tf, "ImplementationNotSet");
    });

    it("re-init attempts on a clone revert", async () => {
      const s = await deployTokenStack();
      const { token } = await createToken(s, s.alice);
      await expect(
        token.initialize(
          "Hack",
          "HCK",
          1n,
          18,
          s.alice.address,
          await s.tokenFactory.getAddress(),
          await s.dexFactory.getAddress(),
          []
        )
      ).to.be.reverted;
    });

    it("creating with zero supply reverts", async () => {
      const s = await deployTokenStack();
      const params = {
        name: "Zero",
        symbol: "ZRO",
        totalSupply: 0n,
        decimals: 18,
        isTaxable: false,
        isMintable: false,
        isPartner: false,
        bases: [await s.weth.getAddress(), await s.usdt.getAddress()],
      };
      await s.usdt.mint(s.alice.address, PARSE_USDT(100));
      await s.usdt
        .connect(s.alice)
        .approve(await s.tokenFactory.getAddress(), PARSE_USDT(100));
      await expect(
        s.tokenFactory.connect(s.alice).createToken(params, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(s.tokenFactory, "InvalidParams");
    });

    it("creating with extreme supply (> 1e30) reverts", async () => {
      const s = await deployTokenStack();
      const params = {
        name: "Huge",
        symbol: "HUG",
        totalSupply: (1n << 255n), // astronomically large
        decimals: 18,
        isTaxable: false,
        isMintable: false,
        isPartner: false,
        bases: [await s.weth.getAddress(), await s.usdt.getAddress()],
      };
      await s.usdt.mint(s.alice.address, PARSE_USDT(100));
      await s.usdt
        .connect(s.alice)
        .approve(await s.tokenFactory.getAddress(), PARSE_USDT(100));
      await expect(
        s.tokenFactory.connect(s.alice).createToken(params, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(s.tokenFactory, "InvalidParams");
    });

    it("creating with empty name/symbol reverts", async () => {
      const s = await deployTokenStack();
      await s.usdt.mint(s.alice.address, PARSE_USDT(100));
      await s.usdt
        .connect(s.alice)
        .approve(await s.tokenFactory.getAddress(), PARSE_USDT(100));
      const baseParams = {
        totalSupply: 1n,
        decimals: 18,
        isTaxable: false,
        isMintable: false,
        isPartner: false,
        bases: [await s.weth.getAddress(), await s.usdt.getAddress()],
      };
      await expect(
        s.tokenFactory
          .connect(s.alice)
          .createToken(
            { ...baseParams, name: "", symbol: "SYM" },
            ethers.ZeroAddress
          )
      ).to.be.revertedWithCustomError(s.tokenFactory, "InvalidParams");
      await expect(
        s.tokenFactory
          .connect(s.alice)
          .createToken(
            { ...baseParams, name: "NAME", symbol: "" },
            ethers.ZeroAddress
          )
      ).to.be.revertedWithCustomError(s.tokenFactory, "InvalidParams");
    });

    it("creating with decimals > 18 reverts", async () => {
      const s = await deployTokenStack();
      await s.usdt.mint(s.alice.address, PARSE_USDT(100));
      await s.usdt
        .connect(s.alice)
        .approve(await s.tokenFactory.getAddress(), PARSE_USDT(100));
      const params = {
        name: "BadDec",
        symbol: "BD",
        totalSupply: 1n,
        decimals: 19,
        isTaxable: false,
        isMintable: false,
        isPartner: false,
        bases: [await s.weth.getAddress(), await s.usdt.getAddress()],
      };
      await expect(
        s.tokenFactory.connect(s.alice).createToken(params, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(s.tokenFactory, "InvalidParams");
    });

    it("routerCreateToken rejected from non-authorized router", async () => {
      const s = await deployTokenStack();
      const params = {
        name: "Router",
        symbol: "RTR",
        totalSupply: 1_000n,
        decimals: 18,
        isTaxable: false,
        isMintable: false,
        isPartner: false,
        bases: [await s.weth.getAddress(), await s.usdt.getAddress()],
      };
      await expect(
        s.tokenFactory
          .connect(s.alice)
          .routerCreateToken(s.alice.address, params, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(s.tokenFactory, "NotAuthorizedRouter");
    });
  });
});
