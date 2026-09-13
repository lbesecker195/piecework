/** The public feed. Every state change worth watching is one row. */

export function emit(db, kind, { task_id = null, project_id = null, account_id = null, sats = null, message }) {
  db.prepare('INSERT INTO events (kind, task_id, project_id, account_id, sats, message) VALUES (?, ?, ?, ?, ?, ?)')
    .run(kind, task_id, project_id, account_id, sats, message);
}

export function recent(db, limit = 100) {
  return db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit);
}
