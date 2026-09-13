/** The public feed. Every state change worth watching is one row, and one analytics ping. */
import { noAnalytics } from './analytics.js';

let analytics = noAnalytics;
export function setAnalytics(instance) { analytics = instance || noAnalytics; }

export function emit(db, kind, { task_id = null, project_id = null, account_id = null, sats = null, message, via = null }) {
  db.prepare('INSERT INTO events (kind, task_id, project_id, account_id, sats, message) VALUES (?, ?, ?, ?, ?, ?)')
    .run(kind, task_id, project_id, account_id, sats, message);
  // Ids and amounts only: the message text carries account names and stays on our side.
  analytics.ping(kind, { sid: task_id ? `task-${task_id}` : undefined, task: task_id, project_ref: project_id, sats, via });
}

export function recent(db, limit = 100) {
  return db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit);
}
