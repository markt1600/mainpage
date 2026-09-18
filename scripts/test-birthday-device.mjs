import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { isBirthdayDevice, birthdayNotices } from '../api/_birthday-device.js';
import birthdays from '../api/display-birthdays.js';
import privateEvents from '../api/private-events.js';
import networth from '../api/networth.js';
import todos from '../api/todos.js';
import login from '../api/login.js';
import { isOwner, isSpecialsScope, sessionKey } from '../api/_session.js';

process.env.SESSION_SECRET='test-birthday-device-only';
process.env.ADMIN_SECRET='test-admin-secret';
process.env.GOOGLE_CLIENT_ID='test-client';
const token=randomBytes(48).toString('base64url');
const hash=createHash('sha256').update(token).digest('hex');
assert.equal(isBirthdayDevice(token,[hash]),true);
assert.equal(isBirthdayDevice(token,[]),false,'revoked credential');
assert.equal(isBirthdayDevice(token+'x',[hash]),false);
assert.equal(isBirthdayDevice('invalid',[hash]),false);
assert.equal(isOwner(token,sessionKey()),false);
assert.equal(isSpecialsScope(token,sessionKey()),false);
async function request(handler, method='GET', headers={}, body={}, url='/'){
  const res={headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(v){this.body=v;},end(){}};
  await handler({method,headers,body,url},res);return res;
}
assert.equal((await request(birthdays)).code,401);
assert.equal((await request(birthdays,'GET',{host:'pi.marktan.ai'})).code,401);
assert.equal((await request(birthdays,'GET',{}, {}, '/?token='+token)).code,401);
assert.equal((await request(birthdays,'POST',{authorization:'Bearer '+token})).code,405);
for(const handler of [privateEvents,networth,todos]){
  assert.equal((await request(handler,'GET',{authorization:'Bearer '+token})).code,401);
}
assert.equal((await request(login,'POST',{}, {session:token})).code,401);
const notices=birthdayNotices([
  {name:'Recent',month:12,day:29,year:1970,note:'private'},
  {name:'Today',month:1,day:1},
  {name:'Soon',month:1,day:8},
  {name:'Outside',month:1,day:9},
],new Date('2026-12-31T16:00:00Z'));
assert.deepEqual(notices.map(b=>b.delta),[-3,0,7]);
assert.deepEqual(Object.keys(notices[0]).sort(),['day','delta','month','name']);
assert.match((await request(birthdays)).headers['Cache-Control'],/no-store/);
console.log('Birthday device tests passed: verifier, revocation, read-only API, host/query rejection, private-data isolation and minimal date window.');
