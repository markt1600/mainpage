import assert from 'node:assert/strict';
import {createWebcams,webcams} from '../pi-webcams.js';
let id=0, shown;
const timers=new Map();
const cycle=createWebcams({play:cam=>shown=cam,
  schedule:(fn,delay)=>{assert.equal(delay,120000);timers.set(++id,fn);return id;},
  cancel:id=>timers.delete(id)});
cycle.start();assert.equal(shown,webcams[0]);
for(let i=1;i<=webcams.length;i++){
  const [id,fn]=timers.entries().next().value;timers.delete(id);fn();
  assert.equal(shown,webcams[i%webcams.length]);assert.equal(timers.size,1);
}
cycle.stop();assert.equal(timers.size,0);
const previous=shown;cycle.next();assert.equal(shown,previous);
cycle.start();assert.equal(shown,webcams[1]);
cycle.next();assert.equal(timers.size,1);assert.equal(shown,webcams[2%webcams.length]);
console.log('Webcam timing, wraparound, manual next and cleanup passed');
