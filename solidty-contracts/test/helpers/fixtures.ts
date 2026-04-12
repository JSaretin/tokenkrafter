import { ethers } from "hardhat";

/**
 * Shared test fixtures. Each function returns a fully-wired deployment
 * of one subsystem so test files can pick the minimum surface they need.
 */

export const PARSE_USDT = (n: number | bigint) => ethers.parseUnits(String(n), 6);
export const PARSE_ETH = (n: number | bigint | string) => ethers.parseEther(String(n));

/**
 * Deploy MockUSDT + MockWETH + MockUniswapV2Factory + MockUniswapV2Router,
 * with a 1 WETH = 600 USDT price set both directions (realistic BNB price).
 */
export async function deployDex() {
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

  const wethPrice = 600n * 10n ** 6n; // 1 WETH = 600 USDT
  await dexRouter.setMockPrice(
    await weth.getAddress(),
    await usdt.getAddress(),
    wethPrice
  );
  await dexRouter.setMockPrice(
    await usdt.getAddress(),
    await weth.getAddress(),
    (10n ** 18n * 10n ** 18n) / wethPrice
  );

  // Fund router with USDT for swaps performed by LaunchInstance.buy()
  await usdt.mint(
    await dexRouter.getAddress(),
    100_000_000n * 10n ** 6n
  );

  return { usdt, weth, dexFactory, dexRouter };
}

/**
 * Deploy all 8 token implementations and wire them into a fresh TokenFactory.
 */
export async function deployTokenStack() {
  const [owner, platform, alice, bob, carol, dave] = await ethers.getSigners();
  const dex = await deployDex();

  const TokenFactory = await ethers.getContractFactory("TokenFactory");
  const tokenFactory = await TokenFactory.deploy(
    await dex.usdt.getAddress(),
    await dex.dexRouter.getAddress(),
    platform.address
  );

  // Deploy every implementation variant and wire into the factory
  const impls: Record<string, any> = {};
  const names = [
    "BasicTokenImpl",
    "MintableTokenImpl",
    "TaxableTokenImpl",
    "TaxableMintableTokenImpl",
    "PartnerTokenImpl",
    "PartnerMintableTokenImpl",
    "PartnerTaxableTokenImpl",
    "PartnerTaxableMintableTokenImpl",
  ];
  for (let i = 0; i < names.length; i++) {
    const F = await ethers.getContractFactory(names[i]);
    const impl = await F.deploy();
    impls[names[i]] = impl;
    await tokenFactory.setImplementation(i, await impl.getAddress());
  }

  return {
    owner,
    platform,
    alice,
    bob,
    carol,
    dave,
    ...dex,
    tokenFactory,
    impls,
  };
}

/**
 * Deploy BondingCurve library + LaunchInstance implementation + LaunchpadFactory,
 * on top of an existing token stack.
 */
export async function deployLaunchStack(
  stack: Awaited<ReturnType<typeof deployTokenStack>>
) {
  const BondingCurve = await ethers.getContractFactory("BondingCurve");
  const bondingCurve = await BondingCurve.deploy();

  const LaunchInstance = await ethers.getContractFactory("LaunchInstance", {
    libraries: { BondingCurve: await bondingCurve.getAddress() },
  });
  const launchImpl = await LaunchInstance.deploy();

  const LaunchpadFactory = await ethers.getContractFactory("LaunchpadFactory");
  const launchpadFactory = await LaunchpadFactory.deploy(
    stack.platform.address,
    await stack.dexRouter.getAddress(),
    await stack.usdt.getAddress(),
    await launchImpl.getAddress()
  );

  return { bondingCurve, launchImpl, launchpadFactory, LaunchInstance };
}

/**
 * Create a token via the factory. Returns the token address and a typed
 * instance. `typeKey` is the 0..7 bitfield (mintable=1, taxable=2, partner=4).
 */
export async function createToken(
  stack: Awaited<ReturnType<typeof deployTokenStack>>,
  creator: any,
  opts: {
    name?: string;
    symbol?: string;
    supply?: bigint;
    decimals?: number;
    isTaxable?: boolean;
    isMintable?: boolean;
    isPartner?: boolean;
    bases?: string[];
  } = {}
) {
  const p = {
    name: opts.name ?? "Test Token",
    symbol: opts.symbol ?? "TEST",
    totalSupply: opts.supply ?? 1_000_000n,
    decimals: opts.decimals ?? 18,
    isTaxable: opts.isTaxable ?? false,
    isMintable: opts.isMintable ?? false,
    isPartner: opts.isPartner ?? false,
    bases:
      opts.bases ?? [
        await stack.weth.getAddress(),
        await stack.usdt.getAddress(),
      ],
  };

  // Pay the creation fee in USDT. Factory is USDT-only now.
  const typeKey =
    (p.isPartner ? 4 : 0) | (p.isTaxable ? 2 : 0) | (p.isMintable ? 1 : 0);
  const fee = await stack.tokenFactory.creationFee(typeKey);
  await stack.usdt.mint(creator.address, fee);
  await stack.usdt
    .connect(creator)
    .approve(await stack.tokenFactory.getAddress(), fee);

  const tx = await stack.tokenFactory
    .connect(creator)
    .createToken(p, ethers.ZeroAddress);
  const receipt = await tx.wait();
  const log = receipt!.logs.find(
    (l: any) => l.fragment?.name === "TokenCreated"
  );
  const tokenAddress = log!.args.tokenAddress;

  // Pick the right ABI based on variant
  const implName =
    p.isPartner && p.isTaxable && p.isMintable
      ? "PartnerTaxableMintableTokenImpl"
      : p.isPartner && p.isTaxable
      ? "PartnerTaxableTokenImpl"
      : p.isPartner && p.isMintable
      ? "PartnerMintableTokenImpl"
      : p.isPartner
      ? "PartnerTokenImpl"
      : p.isTaxable && p.isMintable
      ? "TaxableMintableTokenImpl"
      : p.isTaxable
      ? "TaxableTokenImpl"
      : p.isMintable
      ? "MintableTokenImpl"
      : "BasicTokenImpl";
  const token = await ethers.getContractAt(implName, tokenAddress);

  return { token, tokenAddress, typeKey };
}
