export function aqiCategory(value){
  const bands=[[50,'Good','#009966','#ffffff'],[100,'Moderate','#ffde33','#000000'],[150,'Unhealthy for sensitive groups','#ff9933','#000000'],[200,'Unhealthy','#cc0033','#ffffff'],[300,'Very unhealthy','#660099','#ffffff'],[Infinity,'Hazardous','#7e0023','#ffffff']];
  const [,label,background,color]=bands.find(([limit])=>value<=limit);return {label,background,color};
}
export function parseSouthAqi(html){
  const marker='setWidgetAqiGraphModel(',start=html.indexOf(marker);
  if(start<0)throw Error('AQI data missing');
  let begin=html.indexOf('{',start+marker.length),depth=0,string=false,escape=false,end=-1;
  for(let i=begin;i<html.length;i++){
    const c=html[i];if(string){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')string=false;}
    else if(c==='"')string=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0){end=i+1;break;}
  }
  const d=JSON.parse(html.slice(begin,end));
  if(d.city?.idx!==1663||d.city?.id!=='Singapore/South'||!Number.isInteger(d.aqi)||d.aqi<0||d.aqi>1000)throw Error('Invalid South AQI');
  const t=d.time?.utc,observedAt=t?.s&&t?.tz?new Date(t.s.replace(' ','T')+t.tz).toISOString():null;
  if(!observedAt)throw Error('AQI time missing');
  return {value:d.aqi,...aqiCategory(d.aqi),observedAt,station:'South, Singapore',source:'https://aqicn.org/city/singapore/south/',attribution:'NEA via WAQI'};
}
export default async function handler(req,res){
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  try{const response=await fetch('https://aqicn.org/city/singapore/south/',{signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error();const data=parseSouthAqi(await response.text());res.setHeader('Cache-Control','public, s-maxage=300, stale-while-revalidate=60');return res.status(200).json(data);}
  catch{res.setHeader('Cache-Control','no-store');return res.status(502).json({error:'South AQI unavailable'});}
}
