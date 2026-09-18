const ORIGIN='https://athome.marktan.ai';
export function mediaUrl(src){
  try{const u=new URL(src,ORIGIN);return u.origin===ORIGIN&&u.pathname==='/api/memories'&&u.searchParams.get('action')==='media'?u.href:null;}catch{return null;}
}
export function memoryFeed(records){
  if(!Array.isArray(records))throw new Error('Invalid memory feed');
  return records.filter(r=>r.published===true).map(r=>({id:r.id,title:String(r.title||'Memory'),media:(r.media?.length?r.media:[r]).filter(a=>['image','video'].includes(a.type)).map(a=>({type:a.type,src:mediaUrl(a.src)})).filter(a=>a.src),soundtrack:mediaUrl(r.soundtrack?.src)})).filter(r=>r.media.length);
}
export default async function handler(req,res){
  res.setHeader('Cache-Control','private, no-store');
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  try{const r=await fetch(ORIGIN+'/api/memories',{signal:AbortSignal.timeout(25000)});if(!r.ok)throw new Error();return res.status(200).json({memories:memoryFeed(await r.json())});}
  catch{return res.status(502).json({error:'Memories unavailable'});}
}
