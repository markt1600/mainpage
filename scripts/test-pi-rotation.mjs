import assert from 'node:assert/strict';
import {createRotation} from '../pi-rotation.js';
let source='youtube', enabled, id=0;
const timers=new Map();
const rotation=createRotation({current:()=>source, select:value=>source=value, changed:value=>enabled=value,
  schedule:(callback,delay)=>{assert.equal(delay,300000);timers.set(++id,callback);return id;},
  cancel:id=>timers.delete(id)});
const advance=()=>{const [id,callback]=timers.entries().next().value;timers.delete(id);callback();};
rotation.setEnabled(true);
assert.equal(source,'youtube');
for(const expected of ['memories','game','cna','aqi','youtube']){advance();assert.equal(source,expected);assert.equal(timers.size,1);}
rotation.manual('youtube'); // Even tapping the current mode cancels rotation.
assert.equal(enabled,false);assert.equal(timers.size,0);
rotation.toggle();assert.equal(enabled,true);assert.equal(timers.size,1);
rotation.toggle();assert.equal(enabled,false);assert.equal(timers.size,0);
rotation.manual('aqi');rotation.setEnabled(true);advance();assert.equal(source,'youtube');
console.log('Pi mode rotation tests passed');
