export function singaporeParts(now = new Date()) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone:'Asia/Singapore', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).formatToParts(now).map(p => [p.type,p.value]));
}
export function happyDayText(now = new Date()) {
  const p=singaporeParts(now), y=+p.year, m=+p.month, d=+p.day;
  const anniversary=m<4 || (m===4 && d<4) ? y-1 : y;
  if(anniversary<2023) return 'Happy Day';
  return `Happy Day ${(anniversary-2023)*365}.${Math.round((Date.UTC(y,m-1,d)-Date.UTC(anniversary,3,4))/86400000)+1}`;
}
export function shouldDim(mode, now = new Date()) {
  const p=singaporeParts(now), minutes=+p.hour*60 + +p.minute;
  return mode==='dim' || (mode==='auto' && (minutes>=1290 || minutes<450));
}
// Same -3/+7 day window and ordering as the homepage, pinned to Singapore
// calendar dates for this always-on display, including year boundaries.
export function birthdaysInWindow(birthdays, now = new Date()) {
  const p=singaporeParts(now), y=+p.year, today=Date.UTC(y,+p.month-1,+p.day), out=[];
  for(const b of birthdays){
    if(!b?.name || !Number.isInteger(b.month) || !Number.isInteger(b.day) || b.month<1 || b.month>12 || b.day<1 || b.day>31)continue;
    for(const year of [y-1,y,y+1]){
      const date=Date.UTC(year,b.month-1,b.day),delta=Math.round((date-today)/86400000);
      if(delta>=-3 && delta<=7){out.push({...b,delta,date});break;}
    }
  }
  return out.sort((a,b)=>a.delta-b.delta);
}
export function whenLabel(delta){
  return delta===0?'today':delta===1?'tomorrow':delta===-1?'yesterday':delta>1?`in ${delta} days`:`${-delta} days ago`;
}

if(typeof document !== 'undefined') {
  const $=id=>document.getElementById(id);
  const read=key=>{ try{return JSON.parse(localStorage.getItem(key));}catch{return null;} };
  const save=(key,value)=>{try{localStorage.setItem(key,JSON.stringify(value));}catch{}};
  let mode=read('pi-brightness') || 'auto';
  if(!['auto','dim','full'].includes(mode)) mode='auto';
  const shortTime=value=>value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Singapore',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(value)) : 'Time unavailable';
  function tick(){
    const now=new Date();
    $('happy').textContent=happyDayText(now);
    $('clock').textContent=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Singapore',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(now);
    $('date').textContent=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Singapore',weekday:'short',day:'numeric',month:'short'}).format(now)+' · SGT';
    document.body.classList.toggle('dim',shouldDim(mode,now));
    document.querySelectorAll('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mode===mode)));
  }
  document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{mode=b.dataset.mode;save('pi-brightness',mode);tick();});
  tick();setInterval(tick,10000);
  const number=value=>Number.isFinite(value)?value.toLocaleString('en-SG',{minimumFractionDigits:2,maximumFractionDigits:2}):'—';
  function renderChange(id,change,pct){
    const el=$(id+'Change');
    const available=Number.isFinite(change)&&Number.isFinite(pct);
    const direction=available && Math.abs(change)>=0.005 ? (change>0?'up':'down') : 'flat';
    el.className='change '+direction;
    el.textContent=available?`${direction==='up'?'▲ +':direction==='down'?'▼ −':'— '}${number(Math.abs(change))}\n${pct>0?'+':''}${pct.toFixed(2)}% · 24h`:'24h unavailable';
    el.setAttribute('aria-label',available?`24-hour change ${change.toFixed(2)}, ${pct.toFixed(2)} percent`:'24-hour change unavailable');
  }
  let last=read('pi-data');
  function render(data,offline=false){
    const q=data.quotes || {};
    for(const [id,symbol] of [['fx','SGDJPY=X'],['ares','ARES'],['vwra','VWRA.L'],['btc','BTC-USD']]){
      $(id).textContent=number(q[symbol]?.price);
      $(id+'Time').textContent=Number.isFinite(q[symbol]?.price)?shortTime(q[symbol]?.quotedAt):'Quote unavailable';
      renderChange(id,q[symbol]?.change24h,q[symbol]?.pct24h);
    }
    $('gold').textContent=Number.isFinite(data.goldHalfOzSgd)?'S$'+number(data.goldHalfOzSgd):'—';
    $('goldTime').textContent='Futures · '+shortTime(q['GC=F']?.quotedAt);
    renderChange('gold',data.goldChange24h,data.goldPct24h);
    const w=data.weather;
    $('temperature').textContent=Number.isFinite(w?.current)?Math.round(w.current)+'°':'—°';
    $('condition').textContent=w?.condition || 'Weather unavailable';
    $('weatherDetails').textContent=Number.isFinite(w?.rainChance)?'Rain '+w.rainChance+'%':'';
    $('weatherTime').textContent='Weather · '+shortTime(data.fetchedAt);
    const age=Date.now()-Date.parse(data.fetchedAt);
    const partial=!w || ['SGDJPY=X','ARES','VWRA.L','GC=F','SGD=X','BTC-USD'].some(s=>!Number.isFinite(q[s]?.price));
    $('status').textContent=offline || age>900000 ? 'Saved data · reconnecting' : partial ? 'Some data unavailable' : 'Quotes may be delayed';
  }
  if(last)render(last,true);
  async function loadData(){
    try{
      const r=await fetch('/api/display',{signal:AbortSignal.timeout(25000)});
      if(!r.ok)throw new Error('Feed unavailable');
      const d=await r.json();if(!d.quotes || !d.fetchedAt)throw new Error('Invalid feed');
      last=d;save('pi-data',d);render(d);
    }catch{if(last)render(last,true);else $('status').textContent='Data unavailable · retrying';}
  }
  loadData();setInterval(loadData,300000);window.addEventListener('online',loadData);

  let birthdays=[], rotation=0, birthdayDevice=false;
  const ownerToken=()=>{try{return localStorage.getItem('ownerSession');}catch{return null;}};
  function rotateNotice(){
    const token=ownerToken();
    if(!birthdayDevice && (!token || Number(token.split('.')[1])<Date.now()))birthdays=[];
    const list=birthdaysInWindow(birthdays);
    const show=list.length>0 && rotation%2===1;
    document.querySelector('.weather').hidden=show;
    $('birthday').hidden=!show;
    if(show){const b=list[Math.floor(rotation/2)%list.length];$('birthdayName').textContent=b.delta===0?`Happy birthday, ${b.name}!`:b.name+"’s birthday";
      $('birthdayWhen').textContent=new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',timeZone:'UTC'}).format(new Date(b.date))+' · '+whenLabel(b.delta);}
    else{$('birthdayName').textContent='';$('birthdayWhen').textContent='';}
    rotation++;
  }
  async function loadBirthdays(){
    // The Pi's local extension adds its device credential to this one URL.
    // Ordinary browsers remain unauthenticated and may use owner login below.
    try{
      const r=await fetch('/api/display-birthdays',{cache:'no-store',signal:AbortSignal.timeout(15000)});
      if(r.ok){const d=await r.json();if(!Array.isArray(d.birthdays))throw new Error();birthdayDevice=true;birthdays=d.birthdays;$('birthdayLogin').hidden=true;return;}
    }catch{}
    birthdayDevice=false;
    const token=ownerToken();
    if(!token){birthdays=[];$('birthdayLogin').hidden=false;rotation=0;rotateNotice();return;}
    try{
      const r=await fetch('/api/private-events',{cache:'no-store',headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(15000)});
      if(!r.ok)throw new Error();
      const d=await r.json();
      birthdays=ownerToken()===token && Array.isArray(d.birthdays)?d.birthdays:[];
      $('birthdayLogin').hidden=true;
    }catch{birthdays=[];$('birthdayLogin').hidden=false;rotation=0;rotateNotice();}
  }
  loadBirthdays();setInterval(loadBirthdays,300000);setInterval(rotateNotice,10000);
  window.addEventListener('storage',e=>{if(e.key==='ownerSession' || e.key===null){if(!birthdayDevice)birthdays=[];rotation=0;rotateNotice();loadBirthdays();}});

  let videos=[], pendingVideos=null, player=null, ready=false, index=0, errors=0, skipTimer;
  function captionsOff(target=player){
    try{target?.unloadModule?.('captions');}catch{}
  }
  function message(text){$('videoMessage').textContent=text;$('videoMessage').hidden=!text;}
  function caption(){const v=videos[index];$('videoTitle').textContent=v?.title || '@markt1600';$('videoCount').textContent=videos.length?`${index+1} / ${videos.length}`:'';}
  function play(){if(!ready || !videos.length)return;caption();message('');player.loadVideoById(videos[index].id);}
  function advance(){
    clearTimeout(skipTimer);
    if(pendingVideos){videos=pendingVideos;pendingVideos=null;index=0;errors=0;}else index=(index+1)%Math.max(1,videos.length);
    play();
  }
  function bootPlayer(){
    if(player || !videos.length || !window.YT?.Player)return;
    player=new window.YT.Player('player',{width:640,height:360,videoId:videos[0].id,
      playerVars:{autoplay:1,playsinline:1,controls:1,rel:0,cc_load_policy:0,origin:location.origin},
      events:{onReady:e=>{ready=true;e.target.mute();captionsOff(e.target);$('sound').disabled=false;$('next').disabled=false;caption();e.target.playVideo();},
        onApiChange:e=>captionsOff(e.target),
        onStateChange:e=>{if(e.data===1){errors=0;message('');caption();captionsOff(e.target);}if(e.data===0)advance();},
        onAutoplayBlocked:()=>message('Tap the video to start playback'),
        onError:()=>{errors++;if(errors>=videos.length){message('Videos unavailable · retrying shortly');skipTimer=setTimeout(()=>{errors=0;advance();},60000);}else skipTimer=setTimeout(advance,1500);}
      }});
  }
  $('next').onclick=advance;
  $('sound').onclick=()=>{if(!ready)return;if(player.isMuted()){player.unMute();$('sound').textContent='Sound on';}else{player.mute();$('sound').textContent='Sound off';}};
  async function loadVideos(){
    try{
      const r=await fetch('/api/videos',{signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error();
      const d=await r.json();const next=d.videos?.filter(v=>/^[A-Za-z0-9_-]{11}$/.test(v.id)).slice(0,5);if(!next?.length)throw new Error();
      if(!videos.length){videos=next;index=0;bootPlayer();}
      else if(next.map(v=>v.id).join()!==videos.map(v=>v.id).join())pendingVideos=next;
    }catch{if(!videos.length)message('YouTube unavailable · retrying shortly');}
  }
  window.onYouTubeIframeAPIReady=bootPlayer;
  function loadPlayerApi(){if(window.YT?.Player){bootPlayer();return;}document.getElementById('youtube-api')?.remove();const s=document.createElement('script');s.id='youtube-api';s.src='https://www.youtube.com/iframe_api';s.onerror=()=>message('YouTube unavailable · retrying shortly');document.head.append(s);}
  loadPlayerApi();loadVideos();setInterval(loadVideos,900000);
  setInterval(()=>{if(!window.YT?.Player)loadPlayerApi();if(!videos.length)loadVideos();},60000);
}
