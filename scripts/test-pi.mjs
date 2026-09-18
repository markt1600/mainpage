import assert from 'node:assert/strict';
import { happyDayText, shouldDim, birthdaysInWindow, whenLabel } from '../pi.js';
import { parseChannel, parseFeed } from '../api/videos.js';
import display from '../api/display.js';
import { getQuote } from '../api/dashboard.js';

for (const [time, dim] of [['2026-09-18T13:29:59Z',false],['2026-09-18T13:30:00Z',true],['2026-09-18T23:29:59Z',true],['2026-09-18T23:30:00Z',false]]) {
  assert.equal(shouldDim('auto',new Date(time)),dim,time);
  assert.equal(shouldDim('dim',new Date(time)),true);
  assert.equal(shouldDim('full',new Date(time)),false);
}
assert.equal(happyDayText(new Date('2026-04-03T16:00:00Z')),'Happy Day 1095.1');
assert.equal(happyDayText(new Date('2026-04-03T15:59:59Z')),'Happy Day 730.365');
assert.equal(happyDayText(new Date('2024-02-29T16:00:00Z')),'Happy Day 0.333');
assert.deepEqual(birthdaysInWindow([{name:'Past',month:12,day:29},{name:'Today',month:1,day:1},{name:'Future',month:1,day:8},{name:'Outside',month:1,day:9}],new Date('2026-12-31T16:00:00Z')).map(b=>b.delta),[-3,0,7]);
assert.equal(whenLabel(0),'today');assert.equal(whenLabel(-3),'3 days ago');
const feed='<feed>'+Array.from({length:7},(_,i)=>`<entry><yt:videoId>abcdefghij${i}</yt:videoId><title>A &amp; B</title><published>2026-09-${10+i}T00:00:00Z</published></entry>`).join('')+'</feed>';
assert.equal(parseFeed(feed).length,5);
assert.equal(parseFeed(feed)[0].id,'abcdefghij6');
assert.equal(parseFeed(feed)[0].title,'A & B');
const channel={contents:{twoColumnBrowseResultsRenderer:{tabs:[{tabRenderer:{selected:true,content:{items:[{videoRenderer:{videoId:'abcdefghijk',title:{runs:[{text:'Example'}]}}}]}}}]}}};
assert.equal(parseChannel('var ytInitialData = '+JSON.stringify(channel)+';</script>')[0].title,'Example');
const escaped=JSON.stringify(channel).replace(/./g,c=>'\\x'+c.charCodeAt(0).toString(16).padStart(2,'0'));
assert.equal(parseChannel("ytInitialData = '"+escaped+"';</script>")[0].id,'abcdefghijk');
channel.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.items=[{lockupViewModel:{contentType:'LOCKUP_CONTENT_TYPE_VIDEO',contentId:'12345678901',metadata:{lockupMetadataViewModel:{title:{content:'Modern upload'}}}}}];
assert.equal(parseChannel('var ytInitialData = '+JSON.stringify(channel)+';</script>')[0].title,'Modern upload');

const realFetch=globalThis.fetch;
let failAres=false;
let closedMarket=false, noBaseline=false;
globalThis.fetch=async url=>{
  if(String(url).includes('finance')){
    const symbol=decodeURIComponent(String(url).split('/').pop().split('?')[0]);
    if(symbol==='ARES' && failAres)throw new Error('Provider down');
    const prices={'ARES':100,'VWRA.L':150,'GC=F':3000,'SGD=X':1.3,'SGDJPY=X':115,'BTC-USD':100000};
    const baselines={'ARES':90,'VWRA.L':160,'GC=F':2700,'SGD=X':1.2,'SGDJPY=X':114,'BTC-USD':95000};
    const now=Math.floor(Date.now()/1000), target=now-86400;
    return {ok:true,json:async()=>({chart:{result:[{meta:{regularMarketPrice:prices[symbol],regularMarketTime:closedMarket?target-3600:now,currency:'USD',previousClose:1},timestamp:noBaseline?[target+300]:[target-300,target+300],indicators:{quote:[{close:noBaseline?[999]:[baselines[symbol],999]}]}}]}})};
  }
  return {ok:true,json:async()=>({current:{temperature_2m:30,weather_code:3},daily:{}})};
};
try{
  let payload;
  const res={setHeader(){},status(){return this;},json(d){payload=d;}};
  await display({},res);
  assert.equal(payload.goldHalfOzSgd,1950);
  assert.equal(payload.quotes['VWRA.L'].price,150);
  assert.equal(payload.weather.current,30);
  assert.equal(payload.quotes.ARES.change24h,10);
  assert.equal(payload.quotes['VWRA.L'].change24h,-10);
  assert.equal(payload.quotes['BTC-USD'].change24h,5000);
  assert.equal(payload.goldChange24h,330);
  assert.ok(Math.abs(payload.goldPct24h-330/1620*100)<1e-9);
  assert.ok(payload.quotes.ARES.quotedAt);
  failAres=true;await display({},res);
  assert.equal(payload.quotes.ARES,null);
  assert.equal(payload.goldHalfOzSgd,1950);
  failAres=false;closedMarket=true;
  assert.equal((await getQuote({symbol:'ARES',rolling24h:true})).change24h,0);
  closedMarket=false;noBaseline=true;
  assert.equal((await getQuote({symbol:'ARES',rolling24h:true})).change24h,null);
}finally{globalThis.fetch=realFetch;}
console.log('Pi checks passed: SGT dim schedule, overrides, anniversary/leap day, feeds, conversion, partial failure.');
