import { readBirthdays } from './_birthstore.js';
import { isBirthdayDevice, birthdayNotices } from './_birthday-device.js';
import { readStore } from './private-events.js';
import { upcomingEvents } from './_display-events.js';
import { readFile } from 'node:fs/promises';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }
  // Do not accept query-string tokens, cookies, or an asserted hostname.
  const token = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers?.authorization || '')?.[1];
  if (!isBirthdayDevice(token)) return res.status(401).json({ error: 'unauthorized' });
  const ghToken = (process.env.GITHUB_TOKEN || '').trim();
  if (!ghToken) return res.status(503).json({ error: 'birthdays unavailable' });
  try {
    const [{ list },{ events },publicText] = await Promise.all([readBirthdays(ghToken),readStore(ghToken),readFile(new URL('../data/events.json',import.meta.url),'utf8')]);
    const shared=JSON.parse(publicText).filter(e=>e&&e.show!=='public');
    return res.status(200).json({ birthdays: birthdayNotices(list), events:upcomingEvents([...shared,...events]), fetchedAt: new Date().toISOString() });
  } catch {
    return res.status(503).json({ error: 'birthdays unavailable' });
  }
}
