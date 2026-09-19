const DAY=86400000;
const dateValue=value=>{
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return NaN;
 const n=Date.parse(value+'T00:00:00Z');return Number.isFinite(n)&&new Date(n).toISOString().slice(0,10)===value?n:NaN;
};
export function upcomingEvents(events,now=new Date()){
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Singapore',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).map(p=>[p.type,p.value]));
 const from=Date.UTC(+parts.year,+parts.month-1,+parts.day),to=from+2*DAY,out=[];
 const iso=n=>new Date(n).toISOString().slice(0,10);
 for(const e of events){
  if(!e?.act)continue;const base=dateValue(e.date);if(!Number.isFinite(base))continue;
  const end=dateValue(e.endDate),duration=Number.isFinite(end)?Math.max(0,end-base):0;
  const push=start=>{if(start<base||start>to||start+duration<from)return;out.push({title:String(e.act).slice(0,120),date:iso(start),endDate:iso(start+duration),time:/^([01]?\d|2[0-3]):[0-5]\d$/.test(e.time||'')?e.time:null,venue:String(e.venue||'').slice(0,120)});};
  if(e.repeat==='weekly'){
   let start=base+Math.max(0,Math.ceil((from-duration-base)/(7*DAY)))*7*DAY;
   for(;start<=to;start+=7*DAY)push(start);
  }else if(e.repeat==='monthly'||e.repeat==='yearly'){
   const b=new Date(base),first=new Date(Math.max(base,from-duration)),last=new Date(to),monthly=e.repeat==='monthly';
   const lo=monthly?first.getUTCFullYear()*12+first.getUTCMonth():first.getUTCFullYear(),hi=monthly?last.getUTCFullYear()*12+last.getUTCMonth():last.getUTCFullYear();
   for(let i=lo;i<=hi;i++){const start=monthly?Date.UTC(Math.floor(i/12),i%12,b.getUTCDate()):Date.UTC(i,b.getUTCMonth(),b.getUTCDate());if(new Date(start).getUTCDate()===b.getUTCDate())push(start);}
  }else push(base);
 }
 return out.sort((a,b)=>a.date.localeCompare(b.date)||(a.time||'').localeCompare(b.time||''));
}
