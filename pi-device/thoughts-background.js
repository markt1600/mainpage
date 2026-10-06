let thoughtBusy=false;
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(message?.type!=='pi-thought'||!sender.url?.startsWith('https://pi.marktan.ai/'))return;
  if(thoughtBusy){reply({error:'Local writer is busy'});return;}
  thoughtBusy=true;
  chrome.runtime.sendNativeMessage('ai.marktan.thoughts',{type:'thought'},result=>{
    const error=chrome.runtime.lastError;
    reply(error?{error:'Local writer connection: '+error.message}:result);
    thoughtBusy=false;
  });
  return true;
});

// Verify the native connection once after an extension update.
chrome.runtime.onInstalled.addListener(()=>chrome.runtime.sendNativeMessage('ai.marktan.thoughts',{type:'thought'},()=>{void chrome.runtime.lastError;}));
