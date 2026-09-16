import { createHmac } from 'node:crypto';

const OWNER = 'markh.tan@gmail.com';
const COOKIE = '__Secure-mt_camera';
const MAX_AGE = 7 * 86400;

// Only called after a FULL owner session or Google's verified owner identity.
// Never upgrade the existing magazine-only cookie into camera access.
export function setCameraCookie(res, ownerSessionExpiresAt = Infinity) {
  const secret = process.env.SECURITY_SSO_SECRET;
  if (!secret || secret.length < 32) return;
  const exp = Math.min(Date.now() + MAX_AGE * 1000, ownerSessionExpiresAt);
  const payload = `${Buffer.from(`camera:${OWNER}`).toString('base64url')}.${exp}`;
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  res.setHeader('Set-Cookie', `${COOKIE}=${payload}.${signature}; Domain=marktan.ai; Path=/; Max-Age=${Math.max(0, Math.floor((exp - Date.now()) / 1000))}; Secure; HttpOnly; SameSite=Lax`);
}

export function clearCameraCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Domain=marktan.ai; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`);
}
