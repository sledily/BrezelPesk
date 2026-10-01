import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { RoomError } from './rooms.js';

export class AdminAuth {
  constructor(password) {
    if (password && password.length < 20) throw new Error('Administrator password must have at least 20 characters');
    this.salt = randomBytes(16);
    this.verifier = password ? scryptSync(password, this.salt, 32) : null;
    this.sessions = new Map(); this.attempts = new Map();
  }
  login(password, remote = 'unknown') {
    const now = Date.now(), attempts = (this.attempts.get(remote) ?? []).filter(t => now-t < 60000);
    if (attempts.length >= 5) throw new RoomError('RATE_LIMIT', 'Please wait before trying again', 429);
    attempts.push(now); this.attempts.set(remote, attempts);
    for (const [key, times] of this.attempts) if (now-times.at(-1) > 60000) this.attempts.delete(key);
    if (!this.verifier || typeof password !== 'string' || password.length > 1024
      || !timingSafeEqual(scryptSync(password, this.salt, 32), this.verifier)) {
      throw new RoomError('ADMIN_DENIED','Administrator login failed',403);
    }
    const token = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
    for (const [key, session] of this.sessions) if (session.expires <= now) this.sessions.delete(key);
    this.sessions.set(token, { csrf, expires: now + 3600000 }); return { token, csrf };
  }
  check(request) {
    const token = /(?:^|;\s*)dendarv_admin=([A-Za-z0-9_-]+)/.exec(request.headers.cookie ?? '')?.[1];
    const session = this.sessions.get(token);
    if (!session || session.expires <= Date.now()) throw new RoomError('ADMIN_REQUIRED','Administrator login required',403);
    if (request.method !== 'GET' && request.headers['x-admin-csrf'] !== session.csrf) throw new RoomError('CSRF_REQUIRED','Refresh the administrator session',403);
    return session;
  }
}
