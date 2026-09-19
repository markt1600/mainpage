import assert from 'node:assert/strict';
import {upcomingEvents} from '../api/_display-events.js';
const now=new Date('2026-09-18T16:00:00Z');
const out=upcomingEvents([
 {act:'Today',date:'2026-09-19',note:'secret'},
 {act:'Last day',date:'2026-09-21',time:'18:00',venue:'Here'},
 {act:'Outside',date:'2026-09-22'},
 {act:'Ongoing',date:'2026-09-17',endDate:'2026-09-20'},
 {act:'Weekly',date:'2026-09-12',repeat:'weekly'},
 {act:'Monthly',date:'2026-07-20',repeat:'monthly'},
 {act:'Yearly',date:'2020-09-21',repeat:'yearly'},
 {act:'Future series',date:'2027-09-19',repeat:'yearly'},
],now);
assert.deepEqual(out.map(e=>e.title),['Ongoing','Today','Weekly','Monthly','Yearly','Last day']);
assert.deepEqual(Object.keys(out[0]).sort(),['date','endDate','time','title','venue']);
assert.equal(upcomingEvents([{act:'Short month',date:'2026-01-31',repeat:'monthly'}],new Date('2026-02-27T00:00:00Z')).length,0);
assert.equal(upcomingEvents([{act:'Leap',date:'2024-02-29',repeat:'yearly'}],new Date('2025-02-27T00:00:00Z')).length,0);
console.log('Calendar window, SGT midnight, recurrence, ongoing events and minimal data passed.');
