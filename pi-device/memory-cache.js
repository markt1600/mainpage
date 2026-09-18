// Local extension resources support native image/video loading and seeking.
// Only the Pi dashboard can request these files. Birthday rules stay separate.
async function refreshCache(){
  try {
    const response=await fetch(chrome.runtime.getURL('memory-index.json'),{cache:'no-store'});
    if(!response.ok)return;
    const assets=await response.json();
    const rules=assets.map((asset,i)=>({id:1000+i,priority:1,
      action:{type:'redirect',redirect:{extensionPath:asset.path}},
      condition:{urlFilter:'|'+asset.url+'|',initiatorDomains:['pi.marktan.ai'],resourceTypes:['image','media','xmlhttprequest'],requestMethods:['get']}}));
    rules.push({id:999,priority:1,action:{type:'redirect',redirect:{extensionPath:'/memory-feed.json'}},condition:{urlFilter:'|https://pi.marktan.ai/api/display-memories|',initiatorDomains:['pi.marktan.ai'],resourceTypes:['xmlhttprequest'],requestMethods:['get']}});
    const old=await chrome.declarativeNetRequest.getDynamicRules();
    if(JSON.stringify(old)!==JSON.stringify(rules))await chrome.declarativeNetRequest.updateDynamicRules({removeRuleIds:old.map(r=>r.id),addRules:rules});
  } catch(error){console.warn('Memory cache refresh deferred',error.message);}
}
chrome.runtime.onStartup.addListener(refreshCache);
chrome.runtime.onInstalled.addListener(refreshCache);
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='memories')refreshCache();});
chrome.alarms.create('memories',{periodInMinutes:1});
refreshCache();
