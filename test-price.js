const axios = require('axios')
async function test() {
  try {
    const r = await axios.get('https://min-api.cryptocompare.com/data/pricemultifull?fsyms=BTC&tsyms=USD', {timeout:4000})
    console.log('CryptoCompare:', r.data.RAW?.BTC?.USD?.PRICE)
  } catch(e) { console.log('CryptoCompare FAIL:', e.message) }
  
  try {
    const r = await axios.get('https://api.coincap.io/v2/assets/bitcoin', {timeout:4000})
    console.log('CoinCap:', r.data.data?.priceUsd)
  } catch(e) { console.log('CoinCap FAIL:', e.message) }
}
test()
