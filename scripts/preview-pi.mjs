// Local preview using the same serverless handlers; no private endpoints.
import http from 'node:http';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import display from '../api/display.js';
import videos from '../api/videos.js';
const root=fileURLToPath(new URL('../',import.meta.url));
http.createServer(async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  res.status=n=>{res.statusCode=n;return res;};res.json=d=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(d));};
  try{
    if(path==='/api/display')return await display(req,res);
    if(path==='/api/videos')return await videos(req,res);
    const files={'/pi':'pi.html','/pi.html':'pi.html','/pi.css':'pi.css','/pi.js':'pi.js'};
    if(!files[path]){res.statusCode=404;res.end('Not found');return;}
    res.setHeader('Content-Type',path.endsWith('.css')?'text/css':path.endsWith('.js')?'text/javascript':'text/html');
    res.end(await fs.readFile(root+files[path]));
  }catch{res.status(503).json({error:'Temporarily unavailable'});}
}).listen(8899,'127.0.0.1',()=>console.log('Pi preview: http://127.0.0.1:8899/pi'));
