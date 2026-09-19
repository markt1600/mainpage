import {parseAqiModel,aqiCategory} from './display-aqi.js';
export function mapReadings(html){
 const data=parseAqiModel(html);
 const stations=(data.nearest_v2||[]).filter(s=>/Singapore/i.test(s.name||'')&&Array.isArray(s.g)&&s.g.length===2&&s.g.every(Number.isFinite)&&/^\d+$/.test(String(s.aqi))).map(s=>({id:s.x,name:s.name.replace(/, Singapore$/,''),lat:s.g[0],lng:s.g[1],value:Number(s.aqi),observedAt:s.t,...aqiCategory(Number(s.aqi))}));
 if(!stations.length)throw Error('No Singapore readings');return stations;
}
export default async function handler(req,res){
 if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
 try{const r=await fetch('https://aqicn.org/city/singapore/central/',{signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error();const stations=mapReadings(await r.text());res.setHeader('Cache-Control','public, s-maxage=300, stale-while-revalidate=60');res.status(200).json({stations});}
 catch{res.setHeader('Cache-Control','no-store');res.status(502).json({error:'Singapore AQI unavailable'});}
}
