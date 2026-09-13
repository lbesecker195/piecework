import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const nowIso = () => new Date().toISOString();
export const today = () => new Date().toISOString().slice(0, 10);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export const newKey = (prefix = 'pw') => `${prefix}_${randomBytes(24).toString('hex')}`;
export const hashKey = (key) => createHash('sha256').update(key).digest('hex');

export function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

export function positiveInt(value, name, { min = 1 } = {}) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new HttpError(400, `${name} must be an integer >= ${min}`);
  return n;
}

export function requireString(value, name, { max = 4000 } = {}) {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${name} is required`);
  if (value.length > max) throw new HttpError(400, `${name} is too long (max ${max})`);
  return value.trim();
}

export const secondsLeft = (iso) => Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 1000));
