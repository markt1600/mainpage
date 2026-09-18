// A small, frequently refreshed view of the homepage's existing providers.
import { getCityWeather, getQuote } from './dashboard.js';

export default async function handler(req, res) {
  const symbols = ['SGDJPY=X', 'ARES', 'VWRA.L', 'GC=F', 'SGD=X'];
  const signal = AbortSignal.timeout(18000);
  const results = await Promise.allSettled([
    getCityWeather({ name: 'Singapore', lat: 1.3521, lon: 103.8198, tz: 'Asia/Singapore' }, signal),
    ...symbols.map(symbol => getQuote({ label: symbol, symbol, note: '', signal })),
  ]);
  const quotes = Object.fromEntries(symbols.map((symbol, i) => [symbol,
    results[i + 1].status === 'fulfilled' ? results[i + 1].value : null]));
  const gold = quotes['GC=F'], fx = quotes['SGD=X'];
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=300');
  res.status(200).json({
    fetchedAt: new Date().toISOString(),
    weather: results[0].status === 'fulfilled' ? results[0].value : null,
    quotes,
    goldHalfOzSgd: Number.isFinite(gold?.price) && Number.isFinite(fx?.price)
      ? gold.price * fx.price * 0.5 : null,
  });
}
