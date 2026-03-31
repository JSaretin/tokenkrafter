/**
 * Visitor Counter Updater
 * Run every 30-60 seconds via cron or setInterval
 * Updates the site_visitors table with realistic fluctuating numbers
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... npx ts-node scripts/daemon/update-visitors.ts
 *   Or as a Vercel Edge Function / Supabase Edge Function
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function updateVisitors() {
  // Nigerian business hours (WAT = UTC+1)
  const hour = new Date().getUTCHours() + 1;
  const isNight = hour < 6 || hour > 23;
  const isPeak = hour >= 10 && hour <= 20;
  const isMorning = hour >= 6 && hour < 10;
  const isEvening = hour > 20 && hour <= 23;

  // Base visitor count by time of day
  let base: number;
  if (isNight) base = 150 + Math.floor(Math.random() * 100);
  else if (isMorning) base = 400 + Math.floor(Math.random() * 200);
  else if (isPeak) base = 700 + Math.floor(Math.random() * 500);
  else if (isEvening) base = 500 + Math.floor(Math.random() * 300);
  else base = 300 + Math.floor(Math.random() * 200);

  // Small fluctuation from previous (±5-15%)
  const { data: prev } = await supabase
    .from("site_visitors")
    .select("total_visitors")
    .limit(1)
    .single();

  if (prev && prev.total_visitors > 0) {
    const prevTotal = prev.total_visitors;
    const drift = Math.floor(prevTotal * (Math.random() * 0.10 - 0.05)); // ±5%
    base = Math.max(100, Math.floor((base + prevTotal + drift) / 2)); // Smoothed
  }

  const total = base;
  const browsing = Math.floor(total * (0.40 + Math.random() * 0.10));
  const creating = Math.floor(total * (0.20 + Math.random() * 0.10));
  const investing = total - browsing - creating;

  const { error } = await supabase
    .from("site_visitors")
    .update({
      total_visitors: total,
      browsing,
      creating,
      investing,
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);

  if (error) {
    console.error("Failed to update visitors:", error.message);
  } else {
    console.log(`Visitors: ${total} (${browsing}B/${creating}C/${investing}I) at ${new Date().toLocaleTimeString()}`);
  }
}

// Run once or loop
const LOOP = process.argv.includes("--loop");
const INTERVAL = parseInt(process.env.UPDATE_INTERVAL || "45") * 1000; // 45s default

if (LOOP) {
  console.log(`Visitor updater running (every ${INTERVAL / 1000}s)...`);
  setInterval(updateVisitors, INTERVAL);
  updateVisitors(); // Run immediately
} else {
  updateVisitors().then(() => process.exit(0));
}
