const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const cf = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

function setDateAndClocks(){
  const now = new Date();
  $('dateLine').textContent = now.toLocaleDateString('en-SG', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  const fmt = (tz) => new Intl.DateTimeFormat('en-SG', { hour:'2-digit', minute:'2-digit', hour12:false, timeZone: tz }).format(new Date());
  $('sgTime').textContent = fmt('Asia/Singapore');
  $('tokyoTime').textContent = fmt('Asia/Tokyo');
  $('vancouverTime').textContent = fmt('America/Vancouver');
}
setDateAndClocks(); setInterval(setDateAndClocks, 30000);

const ideas = [
  'Check whether there is a small Tokyo festival or popup near Daikanyama this weekend.',
  'Pick one useful thing to improve on choose.marktan.ai today.',
  'Take one photo with deliberate reflections, shadows, or warm evening light.',
  'Look for one surprising AI tool worth testing locally on your workstation.',
  'Save one idea for a father-daughter activity that is not shopping or eating.'
];
const photo = ['Shoot reflections in glass or puddles.', 'Photograph a familiar object like it belongs in a luxury catalogue.', 'Use only one focal length today.', 'Capture a candid family detail, not a posed portrait.', 'Find symmetry in an ordinary street scene.'];
const tils = ['Honey never really spoils when stored properly.', 'Tokyo has hundreds of tiny neighbourhood festivals each year.', 'Gold is quoted globally by troy ounce, not the everyday ounce.', 'A dachshund was originally bred to hunt badgers.', 'The S&P 500 is market-cap weighted, not equally weighted.'];
const projects = ['Add a new story category.', 'Sketch a new dashboard tile.', 'Write one better onboarding sentence.', 'Make one page load faster.', 'Turn one recurring question into a tiny tool.'];
const pick = (arr) => arr[Math.floor(Date.now()/86400000) % arr.length];
$('dailyIdea').textContent = pick(ideas); $('photoPrompt').textContent = pick(photo); $('tilPrompt').textContent = pick(tils); $('projectPrompt').textContent = pick(projects);

async function weather(city, lat, lon, ids){
  try{
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,precipitation,weather_code&daily=precipitation_probability_max&timezone=auto`;
    const r = await fetch(url); const data = await r.json();
    const temp = Math.round(data.current.temperature_2m);
    const humidity = data.current.relative_humidity_2m;
    const rain = data.daily.precipitation_probability_max?.[0] ?? 0;
    $(ids.temp).textContent = `${temp}°C`;
    $(ids.desc).textContent = describeWeather(data.current.weather_code);
    $(ids.rain).textContent = `Rain ${rain}%`;
    $(ids.humidity).textContent = `Humidity ${humidity}%`;
  }catch(e){ $(ids.desc).textContent = `${city} weather unavailable`; }
}
function describeWeather(code){
  if([0].includes(code)) return 'Clear sky';
  if([1,2,3].includes(code)) return 'Partly cloudy';
  if([45,48].includes(code)) return 'Foggy';
  if([51,53,55,61,63,65,80,81,82].includes(code)) return 'Rain possible';
  if([95,96,99].includes(code)) return 'Thunderstorms possible';
  return 'Forecast updating';
}
weather('Singapore',1.3521,103.8198,{temp:'sgWeatherTemp',desc:'sgWeatherDesc',rain:'sgRain',humidity:'sgHumidity'});
weather('Tokyo',35.6495,139.7034,{temp:'tokyoWeatherTemp',desc:'tokyoWeatherDesc',rain:'tokyoRain',humidity:'tokyoHumidity'});

const markets = [
  {sym:'VWRA.L', price:'m-vwra', change:'c-vwra', currency:'USD'},
  {sym:'BTC-USD', price:'m-btc', change:'c-btc', currency:'USD'},
  {sym:'GC=F', price:'m-gold', change:'c-gold', currency:'USD'},
  {sym:'^GSPC', price:'m-spx', change:'c-spx', currency:'USD'}
];
async function loadMarket(m){
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(m.sym)}?range=2d&interval=1d`;
  try{
    const r = await fetch(url); const j = await r.json();
    const result = j.chart.result[0];
    const meta = result.meta; const price = meta.regularMarketPrice;
    const prev = meta.chartPreviousClose || result.indicators.quote[0].close[0];
    const diff = price - prev; const pct = diff / prev * 100;
    $(m.price).textContent = m.sym === '^GSPC' ? nf.format(price) : cf.format(price);
    const node = $(m.change); node.textContent = `${diff>=0?'+':''}${diff.toFixed(2)} (${diff>=0?'+':''}${pct.toFixed(2)}%)`;
    node.className = diff >= 0 ? 'up' : 'down';
  }catch(e){ $(m.change).textContent = 'Quote unavailable'; }
}
markets.forEach(loadMarket);

const curated = {
  tokyoList:['Local festivals in Shibuya, Ebisu, Nakameguro, and Daikanyama','New cafés, listening bars, and small gallery shows','Weekend family-friendly popups or shopping streets'],
  techList:['Major AI model releases and tools worth testing','Sony, Hasselblad, DJI, and camera firmware/product news','Useful home automation or local-AI workflows'],
  travelList:['Premium travel ideas from Singapore and Tokyo','Luxury watch, whisky, wine, and Hermès-adjacent releases','Cruise or Japan travel alerts worth knowing']
};
for(const [id, items] of Object.entries(curated)){ $(id).innerHTML = items.map(x=>`<li>${x}</li>`).join(''); }

async function loadNews(){
  const fallback = [
    ['AI news', 'https://news.google.com/search?q=AI%20model%20release%20OR%20OpenAI%20OR%20Anthropic%20when:1d&hl=en-SG&gl=SG&ceid=SG:en'],
    ['Singapore business', 'https://news.google.com/search?q=Singapore%20business%20property%20when:1d&hl=en-SG&gl=SG&ceid=SG:en'],
    ['Tokyo events', 'https://news.google.com/search?q=Tokyo%20festival%20popup%20Daikanyama%20Shibuya%20when:7d&hl=en-SG&gl=SG&ceid=SG:en'],
    ['Luxury travel', 'https://news.google.com/search?q=luxury%20travel%20watches%20Hermes%20whisky%20when:7d&hl=en-SG&gl=SG&ceid=SG:en']
  ];
  $('newsFeed').innerHTML = fallback.map(([title,url])=>`<a class="feed-item" href="${url}" target="_blank" rel="noopener"><strong>${title}</strong><small>Open current Google News results</small></a>`).join('');
}
loadNews();
