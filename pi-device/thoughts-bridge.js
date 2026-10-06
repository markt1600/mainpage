// Runs only on this dashboard. It exposes one fixed, local prose endpoint.
window.addEventListener('message',event=>{
  if(event.source!==window || event.origin!=='https://pi.marktan.ai' || event.data?.type!=='pi-thought-request')return;
  const id=event.data.id;
  if(typeof id!=='string'||id.length>64)return;
  chrome.runtime.sendMessage({type:'pi-thought'},result=>{
    const error=chrome.runtime.lastError;
    window.postMessage({type:'pi-thought-result',id,...(error?{error:'Local writer unavailable'}:result)},location.origin);
  });
});
