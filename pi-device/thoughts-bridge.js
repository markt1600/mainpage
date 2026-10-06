let frame, ready;
window.addEventListener('message',async event=>{
  if(event.source!==window||event.origin!==location.origin||event.data?.type!=='pi-thought-request')return;
  if(typeof event.data.id!=='string'||event.data.id.length>64)return;
  if(!frame){
    frame=document.createElement('iframe');frame.hidden=true;
    ready=new Promise(resolve=>frame.onload=resolve);
    frame.src=chrome.runtime.getURL('thoughts-page.html');
    document.documentElement.append(frame);
  }
  await ready;
  frame.contentWindow.postMessage(event.data,new URL(frame.src).origin);
});
window.addEventListener('message',event=>{
  if(!frame||event.source!==frame.contentWindow||event.origin!==new URL(frame.src).origin||event.data?.type!=='pi-thought-result')return;
  console.info('Thoughts result:',event.data.error||'success');
  window.postMessage(event.data,location.origin);
});
