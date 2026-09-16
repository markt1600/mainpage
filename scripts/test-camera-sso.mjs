import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import handler from '../api/login.js';
import { mintSession, sessionKey, OWNER_EMAIL, SPECIALS_SCOPE } from '../api/_session.js';

process.env.SESSION_SECRET = 'test-dashboard-secret';
process.env.SECURITY_SSO_SECRET = 'test-camera-secret-with-at-least-32-characters';
process.env.GOOGLE_CLIENT_ID = 'test-client';
const key = sessionKey();
async function request(body, method = 'POST', origin = 'https://marktan.ai') {
  const response = { headers: {}, setHeader(k,v) { this.headers[k] = v; }, status(n) { this.code = n; return this; }, json(v) { this.body = v; }, end() {} };
  await handler({ headers: { origin }, body, method }, response);
  return response;
}
const owner = await request({ session: mintSession(OWNER_EMAIL, key) });
assert.equal(owner.code, 200);
const cookie = owner.headers['Set-Cookie'];
assert.match(cookie, /Secure; HttpOnly; SameSite=Lax/);
assert.match(cookie, /Domain=marktan.ai/);
const token = cookie.split(';')[0].split('=')[1];
const [scope, exp, signature] = token.split('.');
assert.equal(Buffer.from(scope,'base64url').toString(), `camera:${OWNER_EMAIL}`);
assert.ok(Number(exp) > Date.now());
assert.equal(signature, createHmac('sha256', process.env.SECURITY_SSO_SECRET).update(`${scope}.${exp}`).digest('base64url'));
const scoped = await request({ session: mintSession(SPECIALS_SCOPE, key) });
assert.equal(scoped.headers['Set-Cookie'], undefined);
const invalid = await request({ session: 'invalid' });
assert.equal(invalid.code, 401);
assert.equal(invalid.headers['Set-Cookie'], undefined);
assert.equal((await request({}, 'DELETE', 'https://attacker.example')).code, 403);
assert.match((await request({}, 'DELETE')).headers['Set-Cookie'], /Max-Age=0/);
console.log('Camera SSO: owner cookie, signature, limited-scope rejection and logout checks pass.');
