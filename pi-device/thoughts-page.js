let busy=false;
window.addEventListener('message',event=>{
  if(event.source!==parent||event.origin!=='https://pi.marktan.ai'||event.data?.type!=='pi-thought-request')return;
  const id=event.data.id;
  const reply=result=>parent.postMessage({type:'pi-thought-result',id,...result},event.origin);
  if(busy){reply({error:'Local writer is busy'});return;}
  busy=true;
  chrome.runtime.sendNativeMessage('ai.marktan.thoughts',{type:'thought'},result=>{
    const error=chrome.runtime.lastError;
    console.info('Thoughts native result:',error?.message||'success');
    reply(error?{error:'Writer connection: '+error.message}:result);busy=false;
  });
});
