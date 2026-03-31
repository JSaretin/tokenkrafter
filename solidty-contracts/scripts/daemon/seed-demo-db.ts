/**
 * TokenKrafter — Pure Database Demo Seeder
 *
 * Populates Supabase with realistic demo data WITHOUT touching the blockchain.
 * Perfect for video demos and marketing content.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... npx ts-node scripts/daemon/seed-demo-db.ts
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... npx ts-node scripts/daemon/seed-demo-db.ts --chain 56
 *
 * Options:
 *   --chain <id>   Chain ID to seed (default: 56 for BSC)
 *   --reset        Clear existing data before seeding
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ Set SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const CHAIN_ID = parseInt(process.argv.find((_, i, a) => a[i - 1] === "--chain") || "56");
const RESET = process.argv.includes("--reset");

// ── Helpers ──

function randomAddr(): string {
  const hex = "0123456789abcdef";
  let addr = "0x";
  for (let i = 0; i < 40; i++) addr += hex[Math.floor(Math.random() * 16)];
  return addr;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min: number, max: number, decimals = 2): number {
  return parseFloat((Math.random() * (max - min) + min).toFixed(decimals));
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0];
}

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3600_000).toISOString();
}

// ── Token Data ──

const TOKEN_NAMES = [
  { name: "Naija Token", symbol: "NAIJA", desc: "The people's token — by Nigerians, for Nigerians. Community-driven, transparent, and built for the culture." },
  { name: "Lagos City", symbol: "LAGOS", desc: "Powering the city that never sleeps. Trade, earn, and build in the heart of Africa's biggest economy." },
  { name: "Hustle Token", symbol: "HUSTLE", desc: "For the grinders. Every transaction fuels the hustle. Passive income through smart tokenomics." },
  { name: "Afro Digital", symbol: "AFRO", desc: "Africa's digital future starts here. Cross-border payments, DeFi yields, and community governance." },
  { name: "Jollof Coin", symbol: "JOLLOF", desc: "As hot as the debate — Nigerian jollof wins. Stake and earn spicy yields." },
  { name: "Eko Bridge", symbol: "EKO", desc: "Connecting communities across the bridge. Cross-chain liquidity and yield aggregation." },
  { name: "Abuja Capital", symbol: "ABUJA", desc: "The seat of power, tokenized. Governance token for decentralized community decisions." },
  { name: "Owambe Token", symbol: "OWAMBE", desc: "Celebrate life. Earn with every party. Event ticketing and rewards on-chain." },
  { name: "Danfo Ride", symbol: "DANFO", desc: "Yellow bus energy — always moving forward. Transport and logistics payment network." },
  { name: "Suya Stake", symbol: "SUYA", desc: "Spicy returns, well seasoned gains. Auto-compounding staking protocol." },
  { name: "Aso Rock", symbol: "ASO", desc: "Presidential-grade tokenomics. Multi-sig treasury with community voting." },
  { name: "Nollywood", symbol: "NOLLY", desc: "Lights, camera, blockchain action. Film financing and streaming rewards." },
  { name: "Palm Wine", symbol: "PALM", desc: "Sweet as the first tap. Compound your gains with auto-harvest vaults." },
  { name: "Ankara Print", symbol: "ANKARA", desc: "Bold patterns, bolder returns. NFT-backed fashion marketplace." },
  { name: "Pidgin Pay", symbol: "PIDGIN", desc: "Wetin you dey wait for? Invest now! Peer-to-peer payment network." },
  { name: "Naira Bridge", symbol: "NBRIDGE", desc: "Bridge between crypto and Naira. On/off ramp with instant settlement." },
  { name: "Market Woman", symbol: "MARKET", desc: "The backbone of Nigeria, on-chain. Micro-lending for small businesses." },
  { name: "Gidi Gang", symbol: "GIDI", desc: "Lagos life, tokenized for the culture. Social token with creator rewards." },
  { name: "Pepper Soup", symbol: "PEPPER", desc: "Hot investments with extra heat. High-yield DeFi strategies." },
  { name: "Motherland", symbol: "MAMA", desc: "For the love of home. Build. Earn. Return. Diaspora remittance network." },
  { name: "Afrobeats", symbol: "BEATS", desc: "Ride the rhythm of African music on-chain. Music NFTs and artist royalties." },
  { name: "Amala Token", symbol: "AMALA", desc: "Thick gains, no cap. Yield farming with guaranteed floor price." },
  { name: "Third Mainland", symbol: "3RD", desc: "The longest bridge to financial freedom. Long-term staking rewards." },
  { name: "Agege Bread", symbol: "AGEGE", desc: "Daily bread. Daily gains. Automated dollar-cost averaging protocol." },
  { name: "Wahala Token", symbol: "WAHALA", desc: "No wahala — just passive income. Set it and forget it staking." },
  { name: "Oga Token", symbol: "OGA", desc: "Be your own boss. Every transaction, you earn. Revenue sharing protocol." },
  { name: "Chop Life", symbol: "CHOP", desc: "Life is short. Chop your gains. Instant yield harvesting." },
  { name: "Area Boys", symbol: "AREA", desc: "Own your territory. Stake and earn. Location-based rewards." },
  { name: "Bukka Finance", symbol: "BUKKA", desc: "Fast food. Fast returns. Flash loan arbitrage yield." },
  { name: "Shayo Token", symbol: "SHAYO", desc: "Cheers to your financial freedom. Social trading platform." },
  { name: "Baba Ijebu", symbol: "BABA", desc: "Luck meets blockchain. Prediction markets and lottery pools." },
  { name: "Keke Finance", symbol: "KEKE", desc: "Three wheels, triple returns. Micro-mobility payment token." },
  { name: "Garri Token", symbol: "GARRI", desc: "The staple of every portfolio. Stable yields in any market." },
  { name: "Oyinbo Money", symbol: "OYINBO", desc: "Global money, local heart. Multi-currency DeFi protocol." },
  { name: "Sapa Shield", symbol: "SAPA", desc: "Never go broke again. Insurance and savings protocol." },
];

const CURVE_TYPES = [0, 1, 2, 3]; // Linear, Sqrt, Quadratic, Exponential
const STATES = { PENDING: 0, ACTIVE: 1, GRADUATED: 2, REFUNDING: 3 };

// Creator wallets (fake but consistent)
const CREATORS = Array.from({ length: 15 }, () => randomAddr());

// ── Main Seeder ──

async function main() {
  console.log(`\n🌱 TokenKrafter Database Seeder`);
  console.log(`   Chain ID: ${CHAIN_ID}`);
  console.log(`   Supabase: ${SUPABASE_URL.slice(0, 30)}...`);

  if (RESET) {
    console.log("\n🗑️  Resetting existing data...");
    await supabase.from("recent_transactions").delete().eq("chain_id", CHAIN_ID);
    await supabase.from("launch_transactions").delete().eq("chain_id", CHAIN_ID);
    await supabase.from("badges").delete().eq("chain_id", CHAIN_ID);
    await supabase.from("launches").delete().eq("chain_id", CHAIN_ID);
    await supabase.from("created_tokens").delete().eq("chain_id", CHAIN_ID);
    await supabase.from("platform_stats").delete().eq("chain_id", CHAIN_ID);
    console.log("   Done");
  }

  // ── 1. Seed created tokens ──
  console.log("\n📦 Seeding tokens...");

  const shuffled = [...TOKEN_NAMES].sort(() => Math.random() - 0.5);
  const tokenCount = Math.min(30, shuffled.length);
  const tokens: { address: string; name: string; symbol: string; isPartner: boolean; isTaxable: boolean; isMintable: boolean; typeKey: number }[] = [];

  for (let i = 0; i < tokenCount; i++) {
    const t = shuffled[i];
    const isPartner = i < tokenCount * 0.4; // 40% partner
    const isTaxable = Math.random() > 0.35;
    const isMintable = Math.random() > 0.7;
    const typeKey = (isPartner ? 4 : 0) | (isTaxable ? 2 : 0) | (isMintable ? 1 : 0);
    const addr = randomAddr();

    const feeByType: Record<number, number> = { 0: 10, 1: 20, 2: 25, 3: 35, 4: 15, 5: 25, 6: 30, 7: 40 };

    tokens.push({ address: addr, name: t.name, symbol: t.symbol, isPartner, isTaxable, isMintable, typeKey });

    await supabase.from("created_tokens").upsert({
      address: addr,
      chain_id: CHAIN_ID,
      creator: pick(CREATORS),
      name: t.name,
      symbol: t.symbol,
      total_supply: (BigInt(randomInt(1_000_000, 1_000_000_000)) * 10n ** 18n).toString(),
      decimals: 18,
      is_taxable: isTaxable,
      is_mintable: isMintable,
      is_partner: isPartner,
      type_key: typeKey,
      creation_fee_usdt: feeByType[typeKey] || 10,
      tx_hash: randomAddr() + randomAddr().slice(2),
    }, { onConflict: "address,chain_id" });
  }

  console.log(`   ${tokens.length} tokens created`);

  // ── 2. Seed launches ──
  console.log("\n🚀 Seeding launches...");

  const launchTokens = tokens.slice(0, Math.min(18, tokens.length));
  const launches: { address: string; tokenSymbol: string; state: number; hardCap: number; raised: number; isPartner: boolean }[] = [];

  for (let i = 0; i < launchTokens.length; i++) {
    const t = launchTokens[i];
    const launchAddr = randomAddr();
    const curveType = pick(CURVE_TYPES);
    const softCap = randomInt(5000, 80000);
    const hardCap = softCap + randomInt(50000, 500000);
    const durationDays = pick([7, 14, 21, 30]);

    // Distribute states: 40% active, 30% graduated, 15% upcoming (scheduled), 15% pending
    let state: number;
    let raised: number;
    let startTimestamp = 0;

    if (i < launchTokens.length * 0.4) {
      // Active with varying progress
      state = STATES.ACTIVE;
      const progressPct = randomFloat(5, 85);
      raised = Math.floor(hardCap * progressPct / 100);
    } else if (i < launchTokens.length * 0.7) {
      // Graduated
      state = STATES.GRADUATED;
      raised = hardCap;
    } else if (i < launchTokens.length * 0.85) {
      // Upcoming (scheduled future start)
      state = STATES.ACTIVE;
      raised = 0;
      startTimestamp = Math.floor(Date.now() / 1000) + randomInt(3600 * 2, 3600 * 72);
    } else {
      // Pending (waiting for deposit)
      state = STATES.PENDING;
      raised = 0;
    }

    const tmpl = shuffled.find(s => s.symbol === t.symbol) || shuffled[0];

    const tokensForCurve = BigInt(randomInt(500_000, 50_000_000)) * 10n ** 18n;
    const price = raised > 0 ? Math.floor((raised / Number(tokensForCurve / 10n ** 18n)) * 1e6) : randomInt(100, 50000); // price in 6 dec

    launches.push({ address: launchAddr, tokenSymbol: t.symbol, state, hardCap, raised, isPartner: t.isPartner });

    await supabase.from("launches").upsert({
      address: launchAddr,
      chain_id: CHAIN_ID,
      token_address: t.address,
      creator: pick(CREATORS),
      curve_type: curveType,
      state,
      soft_cap: (BigInt(softCap) * 10n ** 6n).toString(),
      hard_cap: (BigInt(hardCap) * 10n ** 6n).toString(),
      total_base_raised: (BigInt(raised) * 10n ** 6n).toString(),
      tokens_sold: (tokensForCurve * BigInt(Math.min(100, Math.floor(raised / hardCap * 100))) / 100n).toString(),
      tokens_for_curve: tokensForCurve.toString(),
      tokens_for_lp: (tokensForCurve * 30n / 100n).toString(),
      creator_allocation_bps: pick([0, 100, 200, 300]),
      current_price: String(price),
      deadline: Math.floor(Date.now() / 1000) + durationDays * 86400,
      start_timestamp: startTimestamp,
      total_tokens_required: (tokensForCurve * 100n / 70n).toString(),
      total_tokens_deposited: state >= 1 ? (tokensForCurve * 100n / 70n).toString() : "0",
      token_name: t.name,
      token_symbol: t.symbol,
      token_decimals: 18,
      usdt_decimals: 6,
      is_partner: t.isPartner,
      description: tmpl.desc,
      website: `https://${t.symbol.toLowerCase()}.finance`,
      twitter: `@${t.symbol.toLowerCase()}_token`,
      telegram: `t.me/${t.symbol.toLowerCase()}community`,
    }, { onConflict: "address,chain_id" });

    // Add badges
    const badgesToAdd: string[] = ["lp_burned"];
    if (t.isMintable) badgesToAdd.push("mintable");
    if (t.isTaxable) badgesToAdd.push("taxable");
    if (t.isPartner) badgesToAdd.push("partner");
    if (Math.random() > 0.7) badgesToAdd.push("renounced");

    for (const badge of badgesToAdd) {
      await supabase.from("badges").upsert({
        launch_address: launchAddr,
        chain_id: CHAIN_ID,
        badge_type: badge,
        granted_by: "system",
      }, { onConflict: "launch_address,chain_id,badge_type" });
    }
  }

  const activeLaunches = launches.filter(l => l.state === 1 && l.raised > 0);
  const graduated = launches.filter(l => l.state === 2);
  const upcoming = launches.filter(l => l.state === 1 && l.raised === 0);
  console.log(`   ${launches.length} launches (${activeLaunches.length} active, ${graduated.length} graduated, ${upcoming.length} upcoming)`);

  // ── 3. Seed platform stats (30 days, trending up) ──
  console.log("\n📊 Seeding 30 days of platform stats...");

  // Seed 90 days of stats — shows a mature platform with steady growth
  for (let d = 0; d <= 90; d++) {
    const date = daysAgo(d);
    // Growth curve: early days moderate, recent days high activity
    const age = 90 - d; // 0 = oldest, 90 = today
    const mult = 1.5 + (age / 90) * 3.5; // 1.5 → 5.0

    // Weekday boost (Mon-Fri = more activity)
    const dayOfWeek = new Date(date).getDay();
    const weekdayBoost = (dayOfWeek >= 1 && dayOfWeek <= 5) ? 1.3 : 0.8;

    const tokensCreated = Math.floor(randomInt(5, 18) * mult * weekdayBoost);
    const partnerCreated = Math.floor(tokensCreated * randomFloat(0.35, 0.55));
    const launchesCreated = Math.floor(randomInt(3, 10) * mult * weekdayBoost);
    const launchesGraduated = Math.floor(randomFloat(1, 5) * mult * weekdayBoost);

    await supabase.from("platform_stats").upsert({
      chain_id: CHAIN_ID,
      stat_date: date,
      tokens_created: tokensCreated,
      partner_tokens_created: partnerCreated,
      creation_fees_usdt: tokensCreated * randomFloat(18, 32),
      launches_created: launchesCreated,
      launches_graduated: launchesGraduated,
      total_raised_usdt: randomFloat(8000, 45000) * mult,
      launch_fees_usdt: launchesCreated * randomFloat(15, 40),
      tax_revenue_usdt: randomFloat(1500, 8000) * mult,
    }, { onConflict: "chain_id,stat_date" });
  }

  console.log("   90 days of stats seeded (shows 3 months of growth)");

  // ── 4. Seed recent transactions (social proof ticker) ──
  console.log("\n📢 Seeding recent transactions...");

  const activeLaunchAddrs = launches.filter(l => l.state === 1 || l.state === 2);

  for (let i = 0; i < 150; i++) {
    const launch = pick(activeLaunchAddrs);
    const buyUsd = randomInt(25, 8000);
    const tokensReceived = buyUsd * randomInt(500, 100000);

    await supabase.from("recent_transactions").insert({
      chain_id: CHAIN_ID,
      launch_address: launch.address,
      token_symbol: launch.tokenSymbol,
      token_name: TOKEN_NAMES.find(t => t.symbol === launch.tokenSymbol)?.name || launch.tokenSymbol,
      buyer: randomAddr(),
      tokens_amount: (BigInt(tokensReceived) * 10n ** 18n).toString(),
      base_amount: (BigInt(buyUsd) * 10n ** 6n).toString(),
      base_symbol: "USDT",
      base_decimals: 6,
      token_decimals: 18,
      tx_hash: "0x" + Array.from({ length: 64 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join(""),
      created_at: hoursAgo(Math.random() * 72),
    });
  }

  console.log("   150 recent transactions seeded");

  // ── 5. Update visitors ──
  console.log("\n👥 Setting visitor counts...");

  const hour = new Date().getUTCHours() + 1; // WAT
  const isPeak = hour >= 10 && hour <= 20;
  const total = isPeak ? randomInt(2800, 5500) : randomInt(800, 2200);
  const browsing = Math.floor(total * randomFloat(0.4, 0.5));
  const creating = Math.floor(total * randomFloat(0.2, 0.3));
  const investing = total - browsing - creating;

  await supabase.from("site_visitors").update({
    total_visitors: total,
    browsing,
    creating,
    investing,
    updated_at: new Date().toISOString(),
  }).eq("id", 1);

  console.log(`   Visitors: ${total} (${browsing} browsing, ${creating} creating, ${investing} investing)`);

  // ── Summary ──
  const totalRaised = launches.reduce((s, l) => s + l.raised, 0);

  console.log("\n" + "═".repeat(55));
  console.log("  ✅ DEMO DATA SEEDED — PLATFORM LOOKS ESTABLISHED");
  console.log("═".repeat(55));
  console.log(`   Tokens:         ${tokens.length} (${tokens.filter(t => t.isPartner).length} partner)`);
  console.log(`   Launches:       ${launches.length}`);
  console.log(`     Active:       ${activeLaunches.length}`);
  console.log(`     Graduated:    ${graduated.length} (success stories)`);
  console.log(`     Upcoming:     ${upcoming.length} (scheduled)`);
  console.log(`   Total Raised:   $${totalRaised.toLocaleString()}`);
  console.log(`   Daily Stats:    90 days (3 months of history)`);
  console.log(`   Transactions:   150 recent buys`);
  console.log(`   Visitors:       ${total} online now`);
  console.log("");
  console.log("   💡 Admin dashboard will show 90 days of growth charts");
  console.log("   💡 Homepage will show active launches with real progress");
  console.log("   💡 Transaction ticker will show constant buying activity");
  console.log("═".repeat(55));
  console.log("\n📹 Ready for video! They'll think they're late to the party.\n");
}

main().catch(console.error);
