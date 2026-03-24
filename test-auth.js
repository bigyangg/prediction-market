async function main() {
  const { ClobClient } = await import('@polymarket/clob-client');
  const { Wallet } = require('ethers');
  const fs = require('fs');
  const env = fs.readFileSync('.env','utf8');
  const pk = env.match(/POLYMARKET_PRIVATE_KEY=(.+)/)[1].trim();
  const funder = env.match(/POLYMARKET_FUNDER_ADDRESS=(.+)/)[1].trim();
  
  const wallet = new Wallet(pk);
  
  const l1 = new ClobClient('https://clob.polymarket.com', 137, wallet, undefined, 1, funder);
  const creds = await l1.deriveApiKey(0);
  console.log('creds:', JSON.stringify(creds));
  
  const l2 = new ClobClient(
    'https://clob.polymarket.com', 137, wallet,
    { key: creds.key, secret: creds.secret, passphrase: creds.passphrase },
    1, funder
  );
  
  const bal = await l2.getBalanceAllowance({ asset_type: 'COLLATERAL' });
  console.log('balance:', JSON.stringify(bal));
}
main().catch(e => console.error('ERROR:', e.message));
