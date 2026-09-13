import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('platform', 'requester', 'worker')),
  name TEXT NOT NULL UNIQUE,
  key_hash TEXT UNIQUE,
  github TEXT,
  operator TEXT,
  payout_address TEXT,
  balance INTEGER NOT NULL DEFAULT 0,
  stake INTEGER NOT NULL DEFAULT 0,
  in_queue INTEGER NOT NULL DEFAULT 0,
  queue_pos INTEGER,
  jump_armed_on TEXT,
  jump_used_on TEXT,
  strikes INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  earned INTEGER NOT NULL DEFAULT 0,
  defer_pct INTEGER NOT NULL DEFAULT 0,
  deferred INTEGER NOT NULL DEFAULT 0,
  telemetry_count INTEGER NOT NULL DEFAULT 0,
  house INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  requester_id INTEGER NOT NULL REFERENCES accounts(id),
  repo TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  bounty INTEGER NOT NULL,
  max_bounty INTEGER NOT NULL,
  escrow INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'assigned', 'submitted', 'paid', 'cancelled', 'failed')),
  rounds INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  worker_id INTEGER NOT NULL REFERENCES accounts(id),
  via TEXT NOT NULL CHECK (via IN ('roundrobin', 'jump')),
  status TEXT NOT NULL CHECK (status IN ('active', 'submitted', 'accepted', 'rejected', 'timeout', 'declined')),
  assigned_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  pr_url TEXT,
  pr_state TEXT,
  pr_merged INTEGER,
  submitted_at TEXT,
  judged_at TEXT,
  verdict_reason TEXT,
  telemetry INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  delta INTEGER NOT NULL,
  kind TEXT NOT NULL,
  task_id INTEGER,
  memo TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  requester_id INTEGER NOT NULL REFERENCES accounts(id),
  repo TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'declined')),
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  decided_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  task_id INTEGER,
  project_id INTEGER,
  account_id INTEGER,
  sats INTEGER,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('payout', 'credit')),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  sats INTEGER NOT NULL,
  address TEXT,
  memo TEXT,
  ledger_id INTEGER,
  status TEXT NOT NULL CHECK (status IN ('queued', 'approved', 'rejected')),
  proposed_by TEXT NOT NULL,
  decided_by TEXT,
  ref TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  decided_at TEXT
);
CREATE TABLE IF NOT EXISTS telemetry (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  assignment_id INTEGER NOT NULL REFERENCES assignments(id),
  event TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_telemetry_assignment ON telemetry(assignment_id);
CREATE TABLE IF NOT EXISTS deferrals (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  task_id INTEGER,
  sats INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  released_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_deferrals_open ON deferrals(account_id, released_at);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_assign_status ON assignments(status);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger(account_id);
INSERT OR IGNORE INTO accounts (id, kind, name) VALUES (1, 'platform', 'platform');
`;

export const PLATFORM_ID = 1;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Columns added after the first release. Each is applied once to databases created earlier.
const MIGRATIONS = [
  ['accounts', 'operator', 'ALTER TABLE accounts ADD COLUMN operator TEXT'],
  ['accounts', 'defer_pct', 'ALTER TABLE accounts ADD COLUMN defer_pct INTEGER NOT NULL DEFAULT 0'],
  ['accounts', 'deferred', 'ALTER TABLE accounts ADD COLUMN deferred INTEGER NOT NULL DEFAULT 0'],
  ['accounts', 'telemetry_count', 'ALTER TABLE accounts ADD COLUMN telemetry_count INTEGER NOT NULL DEFAULT 0'],
  ['assignments', 'telemetry', 'ALTER TABLE assignments ADD COLUMN telemetry INTEGER NOT NULL DEFAULT 0'],
  ['accounts', 'house', 'ALTER TABLE accounts ADD COLUMN house INTEGER NOT NULL DEFAULT 0'],
];

function migrate(db) {
  for (const [table, column, ddl] of MIGRATIONS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!columns.includes(column)) db.exec(ddl);
  }
}

export const q = {
  account: (db, id) => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id),
  accountByHash: (db, hash) => db.prepare('SELECT * FROM accounts WHERE key_hash = ?').get(hash),
  task: (db, id) => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id),
  assignment: (db, id) => db.prepare('SELECT * FROM assignments WHERE id = ?').get(id),
  activeAssignmentFor: (db, workerId) =>
    db.prepare("SELECT * FROM assignments WHERE worker_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1").get(workerId),
  project: (db, id) => db.prepare('SELECT * FROM projects WHERE id = ?').get(id),
  projectByRepo: (db, repo) => db.prepare('SELECT * FROM projects WHERE lower(repo) = lower(?)').get(repo),
  latestAssignmentForTask: (db, taskId) =>
    db.prepare('SELECT * FROM assignments WHERE task_id = ? ORDER BY id DESC LIMIT 1').get(taskId),
};

export function publicAccount(row) {
  if (!row) return null;
  const { key_hash: _hash, ...rest } = row;
  return rest;
}
