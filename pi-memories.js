// One media element at a time keeps the Pi's memory use bounded.
export function createMemories({host,caption,message,onControls}){
  let active=false,muted=true,list=[],pending=null,m=0,i=0,serial=0,timer,watchdog,audio=null,element=null,loading=false;
  function stopMedia(){clearTimeout(timer);clearTimeout(watchdog);serial++;if(element?.tagName==='VIDEO'){element.pause();element.removeAttribute('src');element.load();}host.replaceChildren();element=null;}
  function stopAudio(){if(audio){audio.pause();audio.removeAttribute('src');audio.load();audio=null;}}
  function sound(){if(element?.tagName==='VIDEO')element.muted=muted||!!audio;if(audio){audio.muted=muted;audio.play().catch(()=>{});}}
  function next(){if(!active||!list.length)return;i++;if(i>=list[m].media.length){i=0;m=(m+1)%list.length;stopAudio();if(pending&&m===0){list=pending;pending=null;}}show();}
  function show(){
    stopMedia();if(!active||!list.length)return;
    const token=serial,r=list[m],a=r.media[i];caption(r.title,`${m+1}/${list.length} · ${i+1}/${r.media.length}`);message('Loading memory…');onControls(true);
    if(!audio&&r.soundtrack){audio=new Audio(r.soundtrack);audio.loop=true;}sound();
    element=document.createElement(a.type==='image'?'img':'video');const el=element;host.replaceChildren(el);
    const valid=()=>active&&token===serial;
    const fail=()=>{if(valid()){clearTimeout(watchdog);message('Memory unavailable · skipping');timer=setTimeout(next,2500);}};
    el.onerror=fail;watchdog=setTimeout(fail,60000);
    if(a.type==='image'){el.alt=r.title;el.onload=()=>{if(valid()){clearTimeout(watchdog);message('');timer=setTimeout(next,5000);}};}
    else{el.playsInline=true;el.controls=true;el.setAttribute('controlslist','nofullscreen');el.preload='auto';el.muted=muted||!!audio;el.onended=()=>{if(valid())next();};el.onplaying=()=>{if(valid()){clearTimeout(watchdog);message('');}};el.onwaiting=()=>{if(valid()){clearTimeout(watchdog);watchdog=setTimeout(fail,60000);}};el.onloadeddata=()=>{if(valid())el.play().catch(()=>{clearTimeout(watchdog);message('Tap the video to play');});};}
    el.src=a.src;
  }
  async function load(){if(loading)return;loading=true;try{const r=await fetch('/api/display-memories',{cache:'no-store',signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error();const d=await r.json();if(!Array.isArray(d.memories))throw Error();if(!d.memories.length){list=[];pending=null;stopMedia();stopAudio();if(active){caption('Memories','');message('No published memories yet');onControls(false);}return;}if(!list.length){list=d.memories;m=0;i=0;if(active)show();}else pending=d.memories;}catch{if(active&&!list.length){message('Memories unavailable · retrying shortly');onControls(false);}}finally{loading=false;}}
  return {start(){active=true;host.hidden=false;caption('Memories','');message('Loading memories…');onControls(!!list.length);if(list.length)show();load();},stop(){active=false;stopMedia();stopAudio();host.hidden=true;},next,setMuted(value){muted=value;sound();},refresh(){if(active)load();}};
}
