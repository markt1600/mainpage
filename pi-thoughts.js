export function createThoughts({host}){
  let active=false, timer, typing, pending=null;
  const note=document.createElement('small'), pages=document.createElement('div');
  note.textContent='Local AI prose · a little imagination, not a news report';
  host.append(note,pages);
  function ask(){
    if(!active||pending)return;
    const id=crypto.randomUUID();pending=id;
    note.textContent='The Pi is writing…';
    window.postMessage({type:'pi-thought-request',id},location.origin);
    timer=setTimeout(()=>{pending=null;if(active){note.textContent='Thoughts runs on the Raspberry Pi. Waiting for its local writer…';timer=setTimeout(ask,30000);}},125000);
  }
  window.addEventListener('message',event=>{
    if(event.source!==window||event.origin!==location.origin||event.data?.type!=='pi-thought-result'||event.data.id!==pending)return;
    clearTimeout(timer);pending=null;
    if(!active)return;
    if(typeof event.data.text!=='string'||!event.data.text.trim()){
      note.textContent=event.data.error||'The writer is taking a breath…';timer=setTimeout(ask,20000);return;
    }
    note.textContent='Local AI prose · a little imagination, not a news report';
    const p=document.createElement('p');pages.append(p);
    while(pages.children.length>8)pages.firstElementChild.remove();
    const words=event.data.text.slice(0,2000).split(/\s+/);let i=0;
    typing=setInterval(()=>{
      p.textContent+=(i?' ':'')+words[i++];host.scrollTop=host.scrollHeight;
      if(i>=words.length){clearInterval(typing);timer=setTimeout(ask,10000);}
    },230);
  });
  return {
    start(){active=true;host.hidden=false;ask();},
    stop(){active=false;host.hidden=true;clearTimeout(timer);clearInterval(typing);pending=null;},
    next(){if(!pending){clearTimeout(timer);clearInterval(typing);ask();}}
  };
}
