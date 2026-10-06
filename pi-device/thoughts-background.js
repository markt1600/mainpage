let thoughtBusy=false;
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(message?.type!=='pi-thought'||!sender.url?.startsWith('https://pi.marktan.ai/'))return;
  if(thoughtBusy){reply({error:'Local writer is busy'});return;}
  thoughtBusy=true;
  (async()=>{
    const get=async path=>{const r=await fetch('http://127.0.0.1:8092/'+path,{signal:AbortSignal.timeout(5000)});return r.json();};
    let result=await get('thought');
    for(let i=0;result.pending&&i<58;i++){
      await new Promise(resolve=>setTimeout(resolve,2000));
      result=await get('result');
    }
    reply(result.pending?{error:'The writer needs a little longer'}:result);
  })().catch(()=>reply({error:'Local writer unavailable'})).finally(()=>thoughtBusy=false);
  return true;
});
