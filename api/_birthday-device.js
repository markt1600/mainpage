import { createHash, timingSafeEqual } from 'node:crypto';

// High-entropy credentials are generated on the device. Only SHA-256
// verifiers live here. Remove a verifier and deploy to revoke a device.
const DEVICE_HASHES = [
  'b0f62777698301c7b9bbe0f87f0851d726a3879cfdbadb0aa755dec926237371', // Pi display
];

export function isBirthdayDevice(token, hashes = DEVICE_HASHES) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{64}$/.test(token)) return false;
  const digest = createHash('sha256').update(token).digest();
  return hashes.some(hash => /^[a-f0-9]{64}$/.test(hash) && timingSafeEqual(digest, Buffer.from(hash, 'hex')));
}

export function birthdayNotices(list, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).map(p => [p.type, p.value]));
  const year = +parts.year, today = Date.UTC(year, +parts.month - 1, +parts.day);
  const out = [];
  for (const b of list) {
    if (!b?.name || !Number.isInteger(b.month) || !Number.isInteger(b.day) || b.month < 1 || b.month > 12 || b.day < 1 || b.day > 31) continue;
    for (const y of [year - 1, year, year + 1]) {
      const delta = Math.round((Date.UTC(y, b.month - 1, b.day) - today) / 86400000);
      if (delta >= -3 && delta <= 7) {
        // Deliberately omit birth year, notes, and any other stored fields.
        out.push({ name: String(b.name).slice(0, 120), month: b.month, day: b.day, delta });
        break;
      }
    }
  }
  return out.sort((a, b) => a.delta - b.delta);
}
