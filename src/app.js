import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join as joinPath } from 'node:path';
import express from 'express';
import { PLATFORM_ID, publicAccount, q } from './db.js';
import { accountFromRequest, cookie, isGitMaster, requireAccount, requireGitMaster } from './auth.js';
import { lockEscrow, move, payout, refundEscrow, stake, unstake } from './ledger.js';
import { decline, dispatch, judge, submit } from './dispatch.js';
import { parseRepo } from './github.js';
import { HttpError, hashKey, newKey, nowIso, positiveInt, requireString, secondsLeft, today, tx } from './util.js';
import * as views from './views.js';

const ROOT = joinPath(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createApp({ db, cfg, rng = Math.random }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));

  const auth = (kind) => requireAccount(db, kind);
  const gm = requireGitMaster(cfg);
  const ctxFor = (req) => ({
    viewer: publicAccount(accountFromRequest(db, req)),
    gitMaster: isGitMaster(cfg, req),
    turnaroundMin: cfg.turnaroundMin,
    feePct: cfg.feeBps / 100,
    minBounty: cfg.minBounty,
  });

  // ------------------------------------------------------------------ domain helpers
  const handle = (value) => (value ? String(value).trim().replace(/^@/, '').toLowerCase().slice(0, 60) : null);

  function createAccount({ kind, name, github, operator, payout_address }) {
    if (!['requester', 'worker'].includes(kind)) throw new HttpError(400, "kind must be 'requester' or 'worker'");
    name = requireString(name, 'name', { max: 40 });
    if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{1,39}$/.test(name)) throw new HttpError(400, 'name: 2-40 letters, digits, spaces, _ . - only');
    if (db.prepare('SELECT 1 FROM accounts WHERE lower(name) = lower(?)').get(name)) throw new HttpError(409, 'that name is taken');
    const op = handle(operator) || handle(github);
    if (kind === 'worker' && !op) throw new HttpError(400, 'operator (GitHub handle of the person or org running this account) is required for workers');
    if (op && !/^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(op)) throw new HttpError(400, 'operator must be a GitHub handle');
    const key = newKey(kind === 'worker' ? 'pww' : 'pwr');
    const info = db.prepare('INSERT INTO accounts (kind, name, key_hash, github, operator, payout_address) VALUES (?, ?, ?, ?, ?, ?)').run(
      kind, name, hashKey(key), handle(github), op, payout_address ? String(payout_address).slice(0, 120) : null,
    );
    return { account: publicAccount(q.account(db, Number(info.lastInsertRowid))), key };
  }

  function faucet(account) {
    if (!cfg.testMode) throw new HttpError(403, 'the faucet is disabled in live mode');
    move(db, account.id, cfg.faucetSats, 'faucet', null, 'test sats');
    return q.account(db, account.id).balance;
  }

  function createTask(account, body) {
    const repo = parseRepo(body.repo_url);
    if (!repo) throw new HttpError(400, 'repo_url must be a public GitHub repository URL like https://github.com/owner/name');
    const title = requireString(body.title, 'title', { max: 120 });
    const text = requireString(body.body, 'body', { max: 20000 });
    const bounty = positiveInt(body.bounty, 'bounty', { min: cfg.minBounty });
    const maxBounty = body.max_bounty === undefined || body.max_bounty === '' || body.max_bounty === null
      ? bounty * 3
      : positiveInt(body.max_bounty, 'max_bounty', { min: bounty });
    return tx(db, () => {
      const info = db.prepare(
        "INSERT INTO tasks (requester_id, repo, title, body, bounty, max_bounty, escrow, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'open')",
      ).run(account.id, repo, title, text, bounty, maxBounty, maxBounty);
      const id = Number(info.lastInsertRowid);
      lockEscrow(db, account.id, id, maxBounty);
      return q.task(db, id);
    });
  }

  function cancelTask(account, task) {
    if (task.requester_id !== account.id) throw new HttpError(403, 'not your task');
    if (task.status !== 'open') throw new HttpError(409, `only open tasks can be cancelled (this one is ${task.status})`);
    tx(db, () => {
      refundEscrow(db, task, 'cancelled by requester');
      db.prepare("UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ?").run(nowIso(), task.id);
    });
  }

  function joinQueue(account, amount) {
    if (account.in_queue) throw new HttpError(409, 'already in the queue');
    if (cfg.maxWorkersPerOperator > 0 && account.operator) {
      const seated = db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE kind = 'worker' AND in_queue = 1 AND operator = ?").get(account.operator).n;
      if (seated >= cfg.maxWorkersPerOperator) {
        throw new HttpError(409, `operator @${account.operator} already holds ${seated} queue seat(s); the limit is ${cfg.maxWorkersPerOperator}`);
      }
    }
    tx(db, () => {
      stake(db, cfg, account, amount);
      const pos = db.prepare('SELECT COALESCE(MAX(queue_pos), 0) AS m FROM accounts').get().m + 1;
      db.prepare('UPDATE accounts SET in_queue = 1, queue_pos = ?, strikes = 0 WHERE id = ?').run(pos, account.id);
    });
  }

  function leaveQueue(account) {
    if (!account.in_queue) throw new HttpError(409, 'not in the queue');
    if (q.activeAssignmentFor(db, account.id)) throw new HttpError(409, 'finish or decline your current assignment first');
    tx(db, () => {
      unstake(db, account);
      db.prepare('UPDATE accounts SET in_queue = 0, jump_armed_on = NULL WHERE id = ?').run(account.id);
    });
  }

  function armJump(account) {
    if (!account.in_queue) throw new HttpError(409, 'join the queue first');
    const used = account.operator
      ? db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE operator = ? AND jump_used_on = ?").get(account.operator, today()).n
      : Number(account.jump_used_on === today());
    if (used > 0) throw new HttpError(409, 'today’s queue jump is already used (one per operator per day)');
    db.prepare('UPDATE accounts SET jump_armed_on = ?, jump_used_on = ? WHERE id = ?').run(today(), today(), account.id);
  }

  const nameOf = (id) => q.account(db, id)?.name || '?';

  function taskView(task) {
    const assignments = db.prepare('SELECT * FROM assignments WHERE task_id = ? ORDER BY id').all(task.id).map((a) => ({
      id: a.id, worker: nameOf(a.worker_id), via: a.via, status: a.status, assigned_at: a.assigned_at, expires_at: a.expires_at,
      seconds_left: a.status === 'active' ? secondsLeft(a.expires_at) : 0, pr_url: a.pr_url, pr_state: a.pr_state,
      pr_merged: Boolean(a.pr_merged), submitted_at: a.submitted_at, judged_at: a.judged_at, verdict_reason: a.verdict_reason,
    }));
    return { ...task, requester: nameOf(task.requester_id), assignments };
  }

  function assignmentView(a) {
    const task = q.task(db, a.task_id);
    return {
      id: a.id, via: a.via, status: a.status, assigned_at: a.assigned_at, expires_at: a.expires_at, seconds_left: secondsLeft(a.expires_at),
      task: { id: task.id, repo: task.repo, repo_url: `https://github.com/${task.repo}`, title: task.title, body: task.body, bounty: task.bounty, requester: nameOf(task.requester_id) },
      submit: { method: 'POST', url: `/v1/assignments/${a.id}/submit`, body: { pr_url: `https://github.com/${task.repo}/pull/<n>` } },
      decline: { method: 'POST', url: `/v1/assignments/${a.id}/decline` },
    };
  }

  function reviewQueue() {
    return db.prepare(`
      SELECT t.id, t.repo, t.title, t.body, t.bounty, t.rounds, a.id AS assignment_id, a.pr_url, a.pr_state, a.pr_merged, a.submitted_at,
             w.name AS worker, w.github AS worker_github
      FROM tasks t JOIN assignments a ON a.task_id = t.id AND a.status = 'submitted' JOIN accounts w ON w.id = a.worker_id
      WHERE t.status = 'submitted' ORDER BY a.submitted_at`).all();
  }

  function stats() {
    return db.prepare(`SELECT
      (SELECT COUNT(*) FROM tasks WHERE status = 'open') AS open,
      (SELECT COUNT(*) FROM tasks WHERE status = 'assigned') AS active,
      (SELECT COUNT(*) FROM tasks WHERE status = 'submitted') AS awaiting,
      (SELECT COUNT(*) FROM tasks WHERE status = 'paid') AS paid_tasks,
      (SELECT COALESCE(SUM(escrow), 0) FROM tasks) AS escrow,
      (SELECT COALESCE(SUM(delta), 0) FROM ledger WHERE kind = 'payout') AS paid,
      (SELECT balance FROM accounts WHERE id = ${PLATFORM_ID}) AS fees,
      (SELECT COUNT(*) FROM accounts WHERE kind = 'worker' AND in_queue = 1) AS queued,
      (SELECT COUNT(*) FROM accounts WHERE kind = 'worker') AS workers,
      (SELECT COUNT(*) FROM accounts WHERE kind = 'requester') AS requesters`).get();
  }

  function boardData() {
    const busy = new Set(db.prepare("SELECT worker_id FROM assignments WHERE status = 'active'").all().map((r) => r.worker_id));
    return {
      stats: stats(),
      testMode: cfg.testMode,
      open: db.prepare("SELECT * FROM tasks WHERE status = 'open' ORDER BY bounty DESC, id").all(),
      active: db.prepare("SELECT t.id, t.title, t.bounty, a.via, a.expires_at, w.name AS worker FROM assignments a JOIN tasks t ON t.id = a.task_id JOIN accounts w ON w.id = a.worker_id WHERE a.status = 'active' ORDER BY a.expires_at").all()
        .map((r) => ({ ...r, seconds_left: secondsLeft(r.expires_at) })),
      awaiting: db.prepare("SELECT t.id, t.title, t.bounty, a.pr_url, a.pr_merged, a.submitted_at, w.name AS worker FROM assignments a JOIN tasks t ON t.id = a.task_id JOIN accounts w ON w.id = a.worker_id WHERE a.status = 'submitted' AND t.status = 'submitted' ORDER BY a.submitted_at").all(),
      queue: db.prepare("SELECT id, name, operator, stake, jump_armed_on FROM accounts WHERE kind = 'worker' AND in_queue = 1 ORDER BY queue_pos").all()
        .map((w) => ({ ...w, busy: busy.has(w.id), armed: w.jump_armed_on === today() })),
      payouts: db.prepare("SELECT l.delta, l.created_at, l.task_id AS id, t.title, w.name AS worker FROM ledger l JOIN tasks t ON t.id = l.task_id JOIN accounts w ON w.id = l.account_id WHERE l.kind = 'payout' ORDER BY l.id DESC LIMIT 10").all(),
      standings: db.prepare("SELECT name, completed, earned FROM accounts WHERE kind = 'worker' AND completed > 0 ORDER BY earned DESC, completed DESC LIMIT 10").all(),
    };
  }

  // ------------------------------------------------------------------ JSON API
  app.get('/v1', (_req, res) => res.json({
    name: 'piecework', mode: cfg.testMode ? 'test' : 'live', fee_bps: cfg.feeBps, turnaround_min: cfg.turnaroundMin, min_stake: cfg.minStake, min_bounty: cfg.minBounty,
    docs: `${cfg.baseUrl}/agents.md`,
    max_workers_per_operator: cfg.maxWorkersPerOperator,
    endpoints: ['POST /v1/accounts', 'GET /v1/me', 'POST /v1/faucet', 'POST /v1/tasks', 'GET /v1/tasks', 'GET /v1/tasks/:id', 'POST /v1/tasks/:id/cancel',
      'POST /v1/queue/join', 'POST /v1/queue/leave', 'POST /v1/queue/jump', 'GET /v1/queue', 'GET /v1/assignments/current?wait=25',
      'POST /v1/assignments/:id/submit', 'POST /v1/assignments/:id/decline', 'POST /v1/withdraw', 'GET /v1/stats', 'GET /v1/review (Git Master)', 'POST /v1/tasks/:id/judge (Git Master)', 'POST /v1/admin/credit (Git Master)', 'GET /v1/admin/withdrawals (Git Master)', 'POST /v1/admin/withdrawals/:id/paid (Git Master)'],
  }));
  app.post('/v1/accounts', (req, res) => {
    const { account, key } = createAccount(req.body || {});
    res.status(201).json({ ...account, api_key: key, note: 'store api_key now; it is not shown again' });
  });
  app.get('/v1/me', auth(), (req, res) => {
    const active = req.account.kind === 'worker' ? q.activeAssignmentFor(db, req.account.id) : null;
    res.json({ ...publicAccount(req.account), assignment: active ? assignmentView(active) : null });
  });
  app.post('/v1/faucet', auth(), (req, res) => res.json({ balance: faucet(req.account), granted: cfg.faucetSats }));
  app.get('/v1/ledger', auth(), (req, res) => res.json(db.prepare('SELECT * FROM ledger WHERE account_id = ? ORDER BY id DESC LIMIT 200').all(req.account.id)));
  app.post('/v1/withdraw', auth(), (req, res) => {
    const amount = positiveInt(req.body?.sats, 'sats');
    if (!cfg.testMode && !req.account.payout_address) throw new HttpError(400, 'set payout_address on your account first');
    const memo = cfg.testMode ? 'test mode: recorded, nothing was paid' : 'pending manual payout';
    move(db, req.account.id, -amount, 'withdrawal', null, memo);
    res.json({
      status: cfg.testMode ? 'recorded' : 'pending', sats: amount, balance: q.account(db, req.account.id).balance,
      note: cfg.testMode ? 'test mode: no real payment was made' : 'the operator pays withdrawals by hand to your payout_address, normally within a day',
    });
  });

  app.post('/v1/tasks', auth('requester'), (req, res) => res.status(201).json(taskView(createTask(req.account, req.body || {}))));
  app.get('/v1/tasks', (req, res) => {
    const status = req.query.status ? String(req.query.status) : null;
    const rows = status ? db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY id DESC LIMIT 200').all(status) : db.prepare('SELECT * FROM tasks ORDER BY id DESC LIMIT 200').all();
    res.json(rows.map(taskView));
  });
  app.get('/v1/tasks/:id', (req, res) => {
    const task = q.task(db, Number(req.params.id));
    if (!task) throw new HttpError(404, 'no such task');
    res.json(taskView(task));
  });
  app.post('/v1/tasks/:id/cancel', auth('requester'), (req, res) => {
    const task = q.task(db, Number(req.params.id));
    if (!task) throw new HttpError(404, 'no such task');
    cancelTask(req.account, task);
    res.json(taskView(q.task(db, task.id)));
  });

  app.get('/v1/queue', (_req, res) => res.json(boardData().queue.map(({ id: _id, ...w }) => w)));
  app.post('/v1/queue/join', auth('worker'), (req, res) => {
    joinQueue(req.account, positiveInt(req.body?.stake ?? cfg.minStake, 'stake'));
    res.json(publicAccount(q.account(db, req.account.id)));
  });
  app.post('/v1/queue/leave', auth('worker'), (req, res) => { leaveQueue(req.account); res.json(publicAccount(q.account(db, req.account.id))); });
  app.post('/v1/queue/jump', auth('worker'), (req, res) => {
    armJump(req.account);
    res.json({ armed_on: today(), chance_per_contract: cfg.jumpChance, note: 'a random armed account wins the flip; your token is consumed only if you win or the day ends' });
  });

  app.get('/v1/assignments/current', auth('worker'), async (req, res) => {
    const wait = Math.min(Math.max(Number(req.query.wait) || 0, 0), 30);
    const deadline = Date.now() + wait * 1000;
    let active = q.activeAssignmentFor(db, req.account.id);
    while (!active && Date.now() < deadline) {
      await sleep(1000);
      active = q.activeAssignmentFor(db, req.account.id);
    }
    if (!active) return res.status(204).end();
    res.json(assignmentView(active));
  });
  const ownAssignment = (req) => {
    const a = q.assignment(db, Number(req.params.id));
    if (!a || a.worker_id !== req.account.id) throw new HttpError(404, 'no such assignment of yours');
    return a;
  };
  app.post('/v1/assignments/:id/submit', auth('worker'), (req, res) => {
    const a = ownAssignment(req);
    submit(db, a, requireString(req.body?.pr_url, 'pr_url', { max: 300 }));
    res.json({ status: 'submitted', task: taskView(q.task(db, a.task_id)), note: 'the Git Master will judge; watch GET /v1/tasks/:id' });
  });
  app.post('/v1/assignments/:id/decline', auth('worker'), (req, res) => {
    const a = ownAssignment(req);
    decline(db, a);
    res.json({ status: 'declined' });
  });

  app.get('/v1/stats', (_req, res) => res.json(stats()));
  app.get('/v1/review', gm, (_req, res) => res.json(reviewQueue()));
  app.post('/v1/tasks/:id/judge', gm, (req, res) => {
    const task = q.task(db, Number(req.params.id));
    if (!task) throw new HttpError(404, 'no such task');
    const reason = req.body?.reason ? String(req.body.reason).slice(0, 500) : null;
    const result = judge(db, cfg, task, req.body?.verdict, reason, (t, w) => payout(db, cfg, t, w));
    res.json({ ...result, task: taskView(q.task(db, task.id)) });
  });
  // Exposed for tests and operators; the server also runs it on a timer.
  app.post('/v1/admin/dispatch', gm, (_req, res) => res.json({ assigned: dispatch(db, cfg, rng) }));

  // Manual money. Live mode runs with no custody software: the operator credits a requester
  // after a Lightning payment lands in the operator's own wallet, and pays withdrawals by hand.
  app.post('/v1/admin/credit', gm, (req, res) => {
    const name = requireString(req.body?.account, 'account', { max: 40 });
    const account = db.prepare('SELECT * FROM accounts WHERE lower(name) = lower(?)').get(name);
    if (!account) throw new HttpError(404, 'no such account');
    const sats = positiveInt(req.body?.sats, 'sats');
    move(db, account.id, sats, 'deposit', null, req.body?.memo ? String(req.body.memo).slice(0, 200) : 'manual deposit');
    res.json(publicAccount(q.account(db, account.id)));
  });
  app.get('/v1/admin/withdrawals', gm, (_req, res) => res.json(db.prepare(
    "SELECT l.id, a.name, a.payout_address, -l.delta AS sats, l.memo, l.created_at FROM ledger l JOIN accounts a ON a.id = l.account_id WHERE l.kind = 'withdrawal' ORDER BY l.id DESC LIMIT 200",
  ).all()));
  app.post('/v1/admin/withdrawals/:id/paid', gm, (req, res) => {
    const row = db.prepare("SELECT * FROM ledger WHERE id = ? AND kind = 'withdrawal'").get(Number(req.params.id));
    if (!row) throw new HttpError(404, 'no such withdrawal');
    const memo = `paid ${nowIso()}${req.body?.ref ? ` · ${String(req.body.ref).slice(0, 120)}` : ''}`;
    db.prepare('UPDATE ledger SET memo = ? WHERE id = ?').run(memo, row.id);
    res.json({ id: row.id, sats: -row.delta, memo });
  });

  // ------------------------------------------------------------------ HTML
  app.get('/agents.md', (_req, res) => res.type('text/markdown').send(readFileSync(joinPath(ROOT, 'AGENTS.md'), 'utf8')));
  app.get('/', (req, res) => res.send(views.board(boardData(), ctxFor(req))));
  app.get('/join', (req, res) => res.send(views.join(ctxFor(req))));
  app.post('/join', (req, res) => {
    try {
      const { account, key } = createAccount(req.body || {});
      res.setHeader('Set-Cookie', cookie('pw_key', key));
      res.send(views.keyShown(account, key, ctxFor(req)));
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      res.status(error.status).send(views.join(ctxFor(req), error.message));
    }
  });
  app.get('/me', (req, res) => {
    const account = accountFromRequest(db, req);
    if (!account) return res.redirect('/join');
    const active = account.kind === 'worker' ? q.activeAssignmentFor(db, account.id) : null;
    res.send(views.me(publicAccount(account), {
      ledger: db.prepare('SELECT * FROM ledger WHERE account_id = ? ORDER BY id DESC LIMIT 50').all(account.id),
      tasks: db.prepare('SELECT * FROM tasks WHERE requester_id = ? ORDER BY id DESC').all(account.id),
      assignment: active ? assignmentView(active) : null,
      testMode: cfg.testMode, minStake: cfg.minStake, faucetSats: cfg.faucetSats,
    }, ctxFor(req)));
  });
  const meAction = (fn) => (req, res) => {
    const account = accountFromRequest(db, req);
    if (!account) return res.redirect('/join');
    fn(account, req);
    res.redirect('/me');
  };
  app.post('/me/faucet', meAction((account) => faucet(account)));
  app.post('/me/queue/join', meAction((account, req) => joinQueue(account, positiveInt(req.body.stake, 'stake'))));
  app.post('/me/queue/leave', meAction((account) => leaveQueue(account)));
  app.post('/me/queue/jump', meAction((account) => armJump(account)));
  app.post('/me/submit', meAction((account, req) => {
    const a = q.activeAssignmentFor(db, account.id);
    if (!a) throw new HttpError(409, 'nothing assigned to you');
    submit(db, a, requireString(req.body.pr_url, 'pr_url', { max: 300 }));
  }));
  app.post('/me/decline', meAction((account) => {
    const a = q.activeAssignmentFor(db, account.id);
    if (!a) throw new HttpError(409, 'nothing assigned to you');
    decline(db, a);
  }));
  app.get('/new', (req, res) => res.send(views.newTask(ctxFor(req))));
  app.post('/new', (req, res) => {
    const account = accountFromRequest(db, req);
    if (!account || account.kind !== 'requester') return res.redirect('/new');
    try {
      const task = createTask(account, req.body || {});
      res.redirect(`/tasks/${task.id}`);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      res.status(error.status).send(views.newTask(ctxFor(req), error.message, req.body));
    }
  });
  app.get('/tasks/:id', (req, res) => {
    const task = q.task(db, Number(req.params.id));
    if (!task) throw new HttpError(404, 'no such task');
    const view = taskView(task);
    res.send(views.task(view, view.assignments, ctxFor(req)));
  });
  app.post('/tasks/:id/cancel', (req, res) => {
    const account = accountFromRequest(db, req);
    const task = q.task(db, Number(req.params.id));
    if (!account) return res.redirect('/join');
    if (!task) throw new HttpError(404, 'no such task');
    cancelTask(account, task);
    res.redirect(`/tasks/${task.id}`);
  });
  app.get('/review', (req, res) => {
    if (!isGitMaster(cfg, req)) throw new HttpError(403, 'Git Master key required: open /review?key=<GIT_MASTER_KEY> once');
    if (req.query.key) {
      res.setHeader('Set-Cookie', cookie('pw_gm', String(req.query.key), { maxAgeDays: 30 }));
      return res.redirect('/review');
    }
    res.send(views.review(reviewQueue(), ctxFor(req)));
  });
  app.post('/review/:id', (req, res) => {
    if (!isGitMaster(cfg, req)) throw new HttpError(403, 'Git Master key required');
    const task = q.task(db, Number(req.params.id));
    if (!task) throw new HttpError(404, 'no such task');
    judge(db, cfg, task, req.body.verdict, req.body.reason ? String(req.body.reason).slice(0, 500) : null, (t, w) => payout(db, cfg, t, w));
    res.redirect('/review');
  });

  // ------------------------------------------------------------------ errors
  app.use((req, _res, next) => next(new HttpError(404, `no route for ${req.method} ${req.path}`)));
  app.use((error, req, res, _next) => {
    const status = error.status || (error.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(error);
    const message = status >= 500 ? 'internal error' : error.message;
    if (req.path.startsWith('/v1') || (req.get('accept') || '').includes('application/json')) return res.status(status).json({ error: message });
    res.status(status).send(views.error(status, message, ctxFor(req)));
  });
  return app;
}
