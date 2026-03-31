/**
 * TokenKrafter Continuous Demo Daemon
 *
 * Runs forever with concurrent, randomized activity:
 * - Creates tokens at random intervals
 * - Launches bonding curves for unlaunched tokens
 * - Simulates buys on active launches
 * - Updates visitor counts
 * - Syncs on-chain data to Supabase
 *
 * All tasks run concurrently with independent random timers.
 *
 * Usage:
 *   DEMO_SPEED=fast npx hardhat run scripts/daemon/demo-data.ts --network localhost
 *
 * Speeds:
 *   fast   — buy 5-15s, token 30-90s, launch 60-180s, visitors 10-30s
 *   normal — buy 30-120s, token 2-10min, launch 5-15min, visitors 30-90s
 *   slow   — buy 60-300s, token 10-30min, launch 15-45min, visitors 60-180s
 */

import { ethers } from "hardhat";
import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";

// ── Load .env ──
const envPath = path.resolve(__dirname, "../../../.env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const DEMO_SPEED = process.env.DEMO_SPEED || "normal";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Token templates ──
const TOKENS = [
  { name: "Naija Token", symbol: "NAIJA", desc: "The people's token — by Nigerians, for Nigerians" },
  { name: "Lagos City", symbol: "LAGOS", desc: "Powering the city that never sleeps" },
  { name: "Hustle Token", symbol: "HUSTLE", desc: "For the grinders. Every transaction fuels the hustle." },
  { name: "Afro Digital", symbol: "AFRO", desc: "Africa's digital future starts here" },
  { name: "Jollof Coin", symbol: "JOLLOF", desc: "As hot as the debate — Nigerian jollof wins" },
  { name: "Eko Bridge", symbol: "EKO", desc: "Connecting communities across the bridge" },
  { name: "Abuja Capital", symbol: "ABUJA", desc: "The seat of power, tokenized" },
  { name: "Owambe Token", symbol: "OWAMBE", desc: "Celebrate life. Earn with every party." },
  { name: "Danfo Ride", symbol: "DANFO", desc: "Yellow bus energy — always moving forward" },
  { name: "Suya Stake", symbol: "SUYA", desc: "Spicy returns, well seasoned gains" },
  { name: "Aso Rock", symbol: "ASO", desc: "Presidential-grade tokenomics" },
  { name: "Nollywood", symbol: "NOLLY", desc: "Lights, camera, blockchain action" },
  { name: "Palm Wine", symbol: "PALM", desc: "Sweet as the first tap. Compound your gains." },
  { name: "Ankara Print", symbol: "ANKARA", desc: "Bold patterns, bolder returns" },
  { name: "Pidgin Pay", symbol: "PIDGIN", desc: "Wetin you dey wait for? Invest now!" },
  { name: "Naira Bridge", symbol: "NBRIDGE", desc: "Bridge between crypto and Naira" },
  { name: "Market Woman", symbol: "MARKET", desc: "The backbone of Nigeria, on-chain" },
  { name: "Gidi Gang", symbol: "GIDI", desc: "Lagos life, tokenized for the culture" },
  { name: "Pepper Soup", symbol: "PEPPER", desc: "Hot investments with extra heat" },
  { name: "Motherland", symbol: "MAMA", desc: "For the love of home. Build. Earn. Return." },
  { name: "Afrobeats", symbol: "BEATS", desc: "Ride the rhythm of African music on-chain" },
  { name: "Amala Token", symbol: "AMALA", desc: "Thick gains, no cap" },
  { name: "Third Mainland", symbol: "3RD", desc: "The longest bridge to financial freedom" },
  { name: "Agege Bread", symbol: "AGEGE", desc: "Daily bread. Daily gains." },
  { name: "Wahala Token", symbol: "WAHALA", desc: "No wahala — just passive income" },
  { name: "Oga Token", symbol: "OGA", desc: "Be your own boss. Every transaction, you earn." },
  { name: "Chop Life", symbol: "CHOP", desc: "Life is short. Chop your gains." },
  { name: "Area Boys", symbol: "AREA", desc: "Own your territory. Stake and earn." },
  { name: "Bukka Finance", symbol: "BUKKA", desc: "Fast food. Fast returns." },
  { name: "Shayo Token", symbol: "SHAYO", desc: "Cheers to your financial freedom" },
];

const SOCIALS = {
  websites: ["https://naijatoken.io", "https://lagoscity.finance", "https://hustle.ng", "https://afrodigital.xyz", "https://jollofcoin.com"],
  twitters: ["@naijatoken", "@lagoscity_fi", "@hustleng", "@afrodigital", "@jollofcoin"],
  telegrams: ["t.me/naijatoken", "t.me/lagoscity", "t.me/hustletoken", "t.me/afrodigital", "t.me/jollofcoin"],
};

const TYPE_LABELS = ["Basic", "Mintable", "Taxable", "Taxable+Mintable", "Partner", "Partner+Mintable", "Partner+Taxable", "Partner+Tax+Mint"];

// ── Speed configs (min-max seconds) ──
const SPEEDS: Record<string, { buy: [number, number]; token: [number, number]; launch: [number, number]; visitors: [number, number]; sync: [number, number]; stats: [number, number] }> = {
  fast:   { buy: [5, 15],     token: [30, 90],    launch: [60, 180],   visitors: [10, 30],  sync: [30, 60],   stats: [60, 120] },
  normal: { buy: [30, 120],   token: [120, 600],  launch: [300, 900],  visitors: [30, 90],  sync: [60, 180],  stats: [300, 600] },
  slow:   { buy: [60, 300],   token: [600, 1800], launch: [900, 2700], visitors: [60, 180], sync: [120, 360], stats: [600, 1200] },
};

// ── Helpers ──
const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const randInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
const randDelay = (range: [number, number]) => new Promise(r => setTimeout(r, randInt(range[0], range[1]) * 1000));
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
const ts = () => new Date().toLocaleTimeString();

// Track state
const state = {
  tokensCreated: [] as string[],    // token addresses without launches
  launchedTokens: new Set<string>(), // token addresses that have launches
  activeLaunches: [] as string[],    // launch addresses
  totalBuys: 0,
  totalTokens: 0,
  totalLaunches: 0,
  running: true,
};

async function main() {
  const [deployer, ...signers] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const speeds = SPEEDS[DEMO_SPEED] || SPEEDS.normal;
  const buyers = signers.slice(0, Math.min(8, signers.length));

  // Load deployments
  let deployments: any;
  try {
    const file = chainId === 31337 ? "localhost" : chainId === 56 ? "bsc" : "unknown";
    deployments = require(`../../deployments/${file}.json`);
  } catch {
    console.error("❌ No deployment file found");
    return;
  }

  const tokenFactory = await ethers.getContractAt("TokenFactory", deployments.TokenFactory);
  const launchpadFactory = await ethers.getContractAt("LaunchpadFactory", deployments.LaunchpadFactory);
  const usdt = deployments.MockUSDT ? await ethers.getContractAt("MockUSDT", deployments.MockUSDT) : null;

  // Test Supabase
  const { error: dbErr } = await supabase.from("launches").select("id").limit(1);

  console.log(`
╔══════════════════════════════════════════════════╗
║       TokenKrafter Continuous Demo Daemon        ║
╚══════════════════════════════════════════════════╝
  Network:    ${network.name} (${chainId})
  Deployer:   ${deployer.address}
  Speed:      ${DEMO_SPEED}
  Buyers:     ${buyers.length} wallets
  Supabase:   ${dbErr ? '❌ ' + dbErr.message : '✅ connected'}
  Factory:    ${deployments.TokenFactory}
  Launchpad:  ${deployments.LaunchpadFactory}

  Press Ctrl+C to stop
`);

  // Load existing active launches from DB
  const { data: existingLaunches } = await supabase
    .from("launches")
    .select("address")
    .eq("chain_id", chainId)
    .eq("state", 1);
  if (existingLaunches) {
    state.activeLaunches = existingLaunches.map(l => l.address);
    console.log(`  Loaded ${state.activeLaunches.length} existing active launches\n`);
  }

  // Seed initial stats if empty
  await seedHistoricalStats(chainId);

  // ── Concurrent task runners ──
  const tasks = [
    taskLoop("🪙  Token",    speeds.token,    () => createRandomToken(deployer, tokenFactory, usdt, chainId)),
    taskLoop("🚀 Launch",    speeds.launch,   () => createRandomLaunch(deployer, launchpadFactory, usdt, chainId)),
    taskLoop("💰 Buy",       speeds.buy,      () => simulateRandomBuy(buyers, deployer, usdt, chainId)),
    taskLoop("👥 Visitors",  speeds.visitors,  () => updateVisitors()),
    taskLoop("🔄 Sync",      speeds.sync,     () => syncLaunches(chainId)),
    taskLoop("📊 Stats",     speeds.stats,    () => updateDailyStats(chainId)),
  ];

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n\n🛑 Shutting down daemon...");
    state.running = false;
  });

  await Promise.all(tasks);
  console.log("\n✅ Daemon stopped.");
}

async function taskLoop(label: string, range: [number, number], fn: () => Promise<void>) {
  // Initial random delay so tasks don't all start at once
  await delay(randInt(1000, 5000));

  while (state.running) {
    try {
      await fn();
    } catch (err: any) {
      console.log(`  ${label} ⚠️  ${err.reason || err.shortMessage || err.message?.slice(0, 60) || 'unknown error'}`);
    }
    await randDelay(range);
  }
}

// ── Task: Create a random token ──
async function createRandomToken(
  deployer: any, tokenFactory: any, usdt: any, chainId: number
) {
  const template = pick(TOKENS);
  // Add random suffix to make unique
  const suffix = randInt(10, 9999);
  const symbol = template.symbol.length <= 5 ? template.symbol + suffix : template.symbol.slice(0, 4) + suffix;
  const name = template.name + " " + suffix;

  const isPartner = Math.random() > 0.5;
  const isTaxable = Math.random() > 0.4;
  const isMintable = Math.random() > 0.7;
  const typeKey = (isPartner ? 4 : 0) | (isTaxable ? 2 : 0) | (isMintable ? 1 : 0);

  const supply = ethers.parseUnits(String(randInt(1_000_000, 1_000_000_000)), 18);

  const feeUsdt = await tokenFactory.creationFee(typeKey);
  if (usdt && feeUsdt > 0n) {
    await (await usdt.approve(tokenFactory.target, feeUsdt)).wait();
  }

  const tx = await tokenFactory.createToken(
    { name, symbol, totalSupply: supply, decimals: 18, isTaxable, isMintable, isPartner, paymentToken: usdt ? usdt.target : ethers.ZeroAddress },
    ethers.ZeroAddress,
    { value: usdt ? 0n : await tokenFactory.convertFee(feeUsdt, ethers.ZeroAddress).catch(() => 0n) }
  );
  const receipt = await tx.wait();

  const event = receipt?.logs.find((l: any) => {
    try { return tokenFactory.interface.parseLog({ topics: l.topics as string[], data: l.data })?.name === "TokenCreated"; } catch { return false; }
  });
  const tokenAddr = event ? tokenFactory.interface.parseLog({ topics: event.topics as string[], data: event.data })?.args?.[1] : null;

  if (tokenAddr) {
    state.tokensCreated.push(tokenAddr);
    state.totalTokens++;

    // Save to DB
    await supabase.from("created_tokens").upsert({
      address: tokenAddr.toLowerCase(), chain_id: chainId, creator: deployer.address.toLowerCase(),
      name, symbol, total_supply: supply.toString(), decimals: 18,
      is_taxable: isTaxable, is_mintable: isMintable, is_partner: isPartner,
      type_key: typeKey, creation_fee_usdt: Number(ethers.formatUnits(feeUsdt, 6))
    }, { onConflict: "address,chain_id" });

    console.log(`  [${ts()}] 🪙  Created ${symbol} (${TYPE_LABELS[typeKey]}) → ${tokenAddr.slice(0, 10)}...`);
  }
}

// ── Task: Create a launch for an unlaunched token ──
async function createRandomLaunch(
  deployer: any, launchpadFactory: any, usdt: any, chainId: number
) {
  if (state.tokensCreated.length === 0) return; // no tokens to launch

  // Pick a random unlaunched token
  const tokenAddr = pick(state.tokensCreated);
  if (state.launchedTokens.has(tokenAddr)) return;

  const curveType = randInt(0, 3);
  const softCap = ethers.parseUnits(String(randInt(100, 5000)), 6);
  const hardCap = ethers.parseUnits(String(randInt(5000, 500000)), 6);
  const durationDays = pick([7, 14, 21, 30]);

  // Get token balance
  const token = await ethers.getContractAt("IERC20", tokenAddr);
  const balance = await token.balanceOf(deployer.address);
  if (balance === 0n) return;

  const tokensForLaunch = (balance * BigInt(randInt(50, 90))) / 100n;

  // Approve tokens for factory
  await (await token.approve(launchpadFactory.target, tokensForLaunch)).wait();

  const tx = await launchpadFactory.createLaunch(
    tokenAddr, tokensForLaunch, curveType, softCap, hardCap,
    durationDays, 200, 0, 0, usdt ? usdt.target : ethers.ZeroAddress, 0
  );
  const receipt = await tx.wait();

  const event = receipt?.logs.find((l: any) => {
    try { return launchpadFactory.interface.parseLog({ topics: l.topics as string[], data: l.data })?.name === "LaunchCreated"; } catch { return false; }
  });
  const launchAddr = event ? launchpadFactory.interface.parseLog({ topics: event.topics as string[], data: event.data })?.args?.[0] : null;

  if (launchAddr) {
    // Deposit tokens
    const instance = await ethers.getContractAt("LaunchInstance", launchAddr);
    await (await token.approve(launchAddr, tokensForLaunch)).wait();
    await (await instance.depositTokens(tokensForLaunch)).wait();

    // Enable trading if needed
    try {
      const tc = new ethers.Contract(tokenAddr, ["function enableTrading() external", "function tradingEnabled() view returns (bool)"], deployer);
      if (!(await tc.tradingEnabled().catch(() => true))) await (await tc.enableTrading()).wait();
    } catch {}

    state.launchedTokens.add(tokenAddr);
    state.tokensCreated = state.tokensCreated.filter(t => t !== tokenAddr);
    state.activeLaunches.push(launchAddr.toLowerCase());
    state.totalLaunches++;

    // Get token metadata
    let tokenName = "Unknown", tokenSymbol = "???";
    try {
      const tc = new ethers.Contract(tokenAddr, ["function name() view returns (string)", "function symbol() view returns (string)"], deployer);
      tokenName = await tc.name();
      tokenSymbol = await tc.symbol();
    } catch {}

    // Save to Supabase
    const tmpl = pick(TOKENS);
    await supabase.from("launches").upsert({
      address: launchAddr.toLowerCase(), chain_id: chainId,
      token_address: tokenAddr.toLowerCase(), creator: deployer.address.toLowerCase(),
      curve_type: curveType, state: 1,
      soft_cap: softCap.toString(), hard_cap: hardCap.toString(),
      total_base_raised: "0", tokens_sold: "0",
      tokens_for_curve: tokensForLaunch.toString(),
      token_name: tokenName, token_symbol: tokenSymbol,
      token_decimals: 18, usdt_decimals: 6,
      description: tmpl.desc,
      website: pick(SOCIALS.websites), twitter: pick(SOCIALS.twitters), telegram: pick(SOCIALS.telegrams),
    }, { onConflict: "address,chain_id" });

    console.log(`  [${ts()}] 🚀 Launched ${tokenSymbol} → ${launchAddr.slice(0, 10)}... (curve=${curveType}, HC=$${ethers.formatUnits(hardCap, 6)})`);
  }
}

// ── Task: Simulate a random buy ──
async function simulateRandomBuy(
  buyers: any[], deployer: any, usdt: any, chainId: number
) {
  if (state.activeLaunches.length === 0 || !usdt) return;

  const launchAddr = pick(state.activeLaunches);
  const buyer = pick(buyers);
  const buyAmountUsd = randInt(5, 500);
  const buyAmount = ethers.parseUnits(String(buyAmountUsd), 6);

  // Mint USDT to buyer
  if (usdt.mint) {
    await (await (usdt as any).connect(deployer).mint(buyer.address, buyAmount)).wait();
  }

  // Approve and buy
  await (await usdt.connect(buyer).approve(launchAddr, buyAmount)).wait();
  const instance = await ethers.getContractAt("LaunchInstance", launchAddr);
  const tx = await instance.connect(buyer).buyWithToken(usdt.target, buyAmount, 0, 0);
  const receipt = await tx.wait();

  state.totalBuys++;

  // Parse TokenBought event for exact amounts
  let tokensReceived = "0";
  let tokenSymbol = "???";
  try {
    const buyEvent = receipt?.logs.find((l: any) => {
      try { return instance.interface.parseLog({ topics: l.topics as string[], data: l.data })?.name === "TokenBought"; } catch { return false; }
    });
    if (buyEvent) {
      const parsed = instance.interface.parseLog({ topics: buyEvent.topics as string[], data: buyEvent.data });
      tokensReceived = parsed?.args?.tokenAmount?.toString() || "0";
    }
  } catch {}

  // Get token symbol for the transaction record
  try {
    const tokenAddr = await instance.token();
    const tc = new ethers.Contract(tokenAddr, ["function symbol() view returns (string)", "function name() view returns (string)"], deployer);
    tokenSymbol = await tc.symbol();
    const tokenName = await tc.name().catch(() => tokenSymbol);

    const txHash = receipt?.hash || `0x${Math.random().toString(16).slice(2)}`;

    // Insert into recent_transactions (triggers Supabase Realtime for global feed)
    await supabase.from("recent_transactions").insert({
      chain_id: chainId,
      launch_address: launchAddr,
      token_symbol: tokenSymbol,
      token_name: tokenName,
      buyer: buyer.address.toLowerCase(),
      tokens_amount: tokensReceived,
      base_amount: buyAmount.toString(),
      base_symbol: "USDT",
      base_decimals: 6,
      token_decimals: 18,
      tx_hash: txHash,
    });

    // Insert into launch_transactions (per-launch activity feed)
    await supabase.from("launch_transactions").insert({
      launch_address: launchAddr,
      chain_id: chainId,
      buyer: buyer.address.toLowerCase(),
      base_amount: buyAmount.toString(),
      tokens_received: tokensReceived,
      tx_hash: txHash,
    });
  } catch {}

  console.log(`  [${ts()}] 💰 ${buyer.address.slice(0, 8)}... bought $${buyAmountUsd} of ${tokenSymbol} on ${launchAddr.slice(0, 10)}...`);

  // Check if launch graduated (state changed)
  try {
    const newState = await instance.state();
    if (Number(newState) !== 1) {
      state.activeLaunches = state.activeLaunches.filter(a => a !== launchAddr);
      console.log(`  [${ts()}] 🎓 ${launchAddr.slice(0, 10)}... graduated!`);
    }
  } catch {}
}

// ── Task: Update visitor counts ──
async function updateVisitors() {
  const { data } = await supabase.from("site_visitors").select("*").limit(1).single();
  if (!data) return;

  const delta = randInt(-3, 8); // slightly positive bias
  const newTotal = Math.max(100, (data.total_visitors || 0) + delta);
  const browsing = Math.max(10, Math.floor(newTotal * (0.4 + Math.random() * 0.15)));
  const creating = Math.max(2, Math.floor(newTotal * (0.15 + Math.random() * 0.1)));
  const investing = Math.max(1, newTotal - browsing - creating);

  await supabase.from("site_visitors").update({
    total_visitors: newTotal, browsing, creating, investing
  }).eq("id", data.id);
}

// ── Task: Sync on-chain data to DB ──
async function syncLaunches(chainId: number) {
  try {
    // Use the app's sync endpoint if available
    const res = await fetch("http://localhost:5173/api/launches/sync", { method: "POST" }).catch(() => null);
    if (res?.ok) {
      const result = await res.json();
      if (result.synced > 0) console.log(`  [${ts()}] 🔄 Synced ${result.synced} launches`);
    }
  } catch {}
}

// ── Task: Update daily platform stats ──
async function updateDailyStats(chainId: number) {
  const today = new Date().toISOString().slice(0, 10);

  // Get today's actual counts from DB
  const { data: launches } = await supabase.from("launches").select("state, total_base_raised").eq("chain_id", chainId);
  const { data: tokens } = await supabase.from("created_tokens").select("is_partner").eq("chain_id", chainId);

  const totalTokens = tokens?.length || 0;
  const partnerTokens = tokens?.filter(t => t.is_partner).length || 0;
  const totalLaunches = launches?.length || 0;
  const graduated = launches?.filter(l => l.state === 2).length || 0;
  const totalRaised = launches?.reduce((s, l) => s + Number(l.total_base_raised || 0) / 1e6, 0) || 0;

  // Random fees (simulate platform revenue)
  const creationFees = totalTokens * randInt(8, 25);
  const launchFees = totalLaunches * randInt(0, 5);
  const taxRevenue = randInt(10, 200);

  await supabase.from("platform_stats").upsert({
    chain_id: chainId, stat_date: today,
    tokens_created: totalTokens, partner_tokens_created: partnerTokens,
    creation_fees_usdt: creationFees, launches_created: totalLaunches,
    launches_graduated: graduated, total_raised_usdt: totalRaised,
    launch_fees_usdt: launchFees, tax_revenue_usdt: taxRevenue,
  }, { onConflict: "chain_id,stat_date" });
}

// ── Seed historical stats (run once on startup) ──
async function seedHistoricalStats(chainId: number) {
  const { data: existing } = await supabase
    .from("platform_stats")
    .select("stat_date")
    .eq("chain_id", chainId)
    .order("stat_date", { ascending: false })
    .limit(1);

  // Only seed if less than 7 days of history
  const latestDate = existing?.[0]?.stat_date;
  const daysSinceLast = latestDate ? Math.floor((Date.now() - new Date(latestDate).getTime()) / 86400000) : 999;
  if (daysSinceLast < 2) return;

  console.log("  📊 Seeding historical stats...");
  const now = new Date();
  const rows = [];

  for (let d = 90; d >= 1; d--) {
    const date = new Date(now.getTime() - d * 86400000);
    const dateStr = date.toISOString().slice(0, 10);
    const age = 90 - d; // days from start

    // Simulate organic growth
    const growth = 1 + age * 0.03;
    const tokensCreated = Math.floor(randInt(1, 4) * growth);
    const partnerTokens = Math.floor(tokensCreated * (0.3 + Math.random() * 0.3));
    const launchesCreated = Math.floor(randInt(0, 3) * growth);
    const graduated = Math.floor(launchesCreated * (0.2 + Math.random() * 0.3));

    rows.push({
      chain_id: chainId, stat_date: dateStr,
      tokens_created: tokensCreated,
      partner_tokens_created: partnerTokens,
      creation_fees_usdt: tokensCreated * randInt(10, 30),
      launches_created: launchesCreated,
      launches_graduated: graduated,
      total_raised_usdt: launchesCreated * randInt(500, 5000),
      launch_fees_usdt: launchesCreated * randInt(0, 10),
      tax_revenue_usdt: randInt(5, 100) * growth,
    });
  }

  await supabase.from("platform_stats").upsert(rows, { onConflict: "chain_id,stat_date" });
  console.log(`  📊 Seeded ${rows.length} days of historical stats\n`);
}

main().catch(console.error);
