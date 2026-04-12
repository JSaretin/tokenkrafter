require('dotenv').config();
const { ethers } = require('ethers');
(async () => {
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) { console.log('NO_KEY'); return; }
  const p = new ethers.JsonRpcProvider('https://bsc-dataseed.binance.org/');
  const w = new ethers.Wallet(pk, p);
  const bal = await p.getBalance(w.address);
  const block = await p.getBlockNumber();
  console.log('deployer:', w.address);
  console.log('balance :', ethers.formatEther(bal), 'BNB');
  console.log('block   :', block);
  console.log('platform_wallet env:', process.env.PLATFORM_WALLET || '(defaults to deployer)');
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
