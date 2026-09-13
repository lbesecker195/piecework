import { q } from './db.js';
import { HttpError, hashKey, safeEqual } from './util.js';

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0) out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

export function bearer(req) {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

export function accountFromRequest(db, req) {
  const key = bearer(req) || parseCookies(req.get('cookie')).pw_key;
  if (!key) return null;
  return q.accountByHash(db, hashKey(key)) || null;
}

export const requireAccount = (db, kind = null) => (req, _res, next) => {
  const account = accountFromRequest(db, req);
  if (!account) return next(new HttpError(401, 'provide your API key as `Authorization: Bearer <key>`'));
  if (kind && account.kind !== kind) return next(new HttpError(403, `this endpoint is for ${kind} accounts`));
  req.account = account;
  next();
};

export function isGitMaster(cfg, req) {
  const key = bearer(req) || parseCookies(req.get('cookie')).pw_gm || req.query.key;
  return Boolean(key && cfg.gitMasterKey && safeEqual(key, cfg.gitMasterKey));
}

export const requireGitMaster = (cfg) => (req, _res, next) => {
  if (!isGitMaster(cfg, req)) return next(new HttpError(403, 'Git Master key required'));
  next();
};

export const cookie = (name, value, { maxAgeDays = 365 } = {}) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeDays * 86400}`;
