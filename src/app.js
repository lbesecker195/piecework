import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join as joinPath } from 'node:path';
import express from 'express';
import { PLATFORM_ID, publicAccount, q } from './db.js';
import { accountFromRequest, adminRole, cookie, requireAccount, requireGitMaster, requireOwner } from './auth.js';
import { emit, recent, setAnalytics } from './events.js';
import { createAnalytics } from './analytics.js';
import { approvePayment, listPayments, pendingWithdrawals, queueCredit, queuePayout, rejectPayment } from './payments.js';
import { lockEscrow, move, payout, refundEscrow, releasableDeferred, releaseDeferred, stake, unstake } from './ledger.js';
import { decline, dispatch, judge, submit } from './dispatch.js';
import { parseRepo } from './github.js';
import { HttpError, hashKey, newKey, nowIso, positiveInt, requireString, secondsLeft, today, tx } from './util.js';
import * as views from './views.js';

const ROOT = joinPath(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TELEMETRY_EVENTS = ['started', 'repo_cloned', 'tests_passed', 'tests_failed', 'pr_opened', 'blocked', 'declining', 'finished'];
const REPORTING_THRESHOLD = 2;

export function createApp({ db, cfg, rng = Math.random, analytics = null }) {
  const app = express();
  const stats_ = analytics || createAnalytics(cfg);
  setAnalytics(stats_);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));

  const auth = (kind) => requireAccount(db, kind);
  const gm = requireGitMaster(cfg);
  const owner = requireOwner(cfg);
  const ctxFor = (req) => ({
    viewer: publicAccount(accountFromRequest(db, req)),
    role: adminRole(cfg, req),
    gitMaster: adminRole(cfg, req) !== null,
    turnaroundMin: cfg.turnaroundMin,
    feePct: cfg.feeBps / 100,
    minBounty: cfg.minBounty,
    analytics: cfg.ssaUid ? { url: cfg.ssaUrl, uid: cfg.ssaUid } : null,
  });

  const adminAction = (roles, fn) => (req, res) => {
    const role = adminRole(cfg, req);
    if (!role || !roles.includes(role)) throw new HttpError(403, `${roles.join(' or ')} key required`);
    fn(req, role);
    res.redirect('/admin');
  };

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

  function requestProject(account, body) {
    const repo = parseRepo(body.repo_url);
    if (!repo) throw new HttpError(400, 'repo_url must be a public GitHub repository URL like https://github.com/owner/name');
    const description = requireString(body.description, 'description', { max: 4000 });
    const existing = q.projectByRepo(db, repo);
    if (existing && existing.status !== 'declined') throw new HttpError(409, `${repo} is already ${existing.status}`);
    if (existing) db.prepare('DELETE FROM projects WHERE id = ?').run(existing.id);
    const info = db.prepare("INSERT INTO projects (requester_id, repo, description, status) VALUES (?, ?, ?, 'pending')").run(account.id, repo, description);
    emit(db, 'project_requested', { project_id: Number(info.lastInsertRowid), account_id: account.id, message: `${account.name} asked to integrate ${repo}` });
    return q.project(db, Number(info.lastInsertRowid));
  }

  function decideProject(project, decision, reason) {
    if (!['approve', 'decline'].includes(decision)) throw new HttpError(400, "decision must be 'approve' or 'decline'");
    if (project.status !== 'pending') throw new HttpError(409, `project is already ${project.status}`);
    db.prepare('UPDATE projects SET status = ?, reason = ?, decided_at = ? WHERE id = ?')
      .run(decision === 'approve' ? 'approved' : 'declined', reason || null, nowIso(), project.id);
    emit(db, decision === 'approve' ? 'project_approved' : 'project_declined', { project_id: project.id,
      message: decision === 'approve' ? `🟢 ${project.repo} is in. The Git Master said yes${reason ? `: ${reason}` : ''}` : `${project.repo} was declined${reason ? `: ${reason}` : ''}` });
    return q.project(db, project.id);
  }

  function projectView(project) {
    const totals = db.prepare("SELECT COUNT(*) AS tasks, SUM(status IN ('open','assigned','submitted')) AS live, COALESCE(SUM(CASE WHEN status = 'paid' THEN bounty END), 0) AS paid FROM tasks WHERE repo = ?").get(project.repo);
    return { ...project, repo_url: `https://github.com/${project.repo}`, requester: nameOf(project.requester_id), tasks: totals.tasks, live_tasks: totals.live || 0, sats_paid: totals.paid };
  }

  function createTask(account, body) {
    const repo = parseRepo(body.repo_url);
    if (!repo) throw new HttpError(400, 'repo_url must be a public GitHub repository URL like https://github.com/owner/name');
    const project = q.projectByRepo(db, repo);
    if (!project || project.status !== 'approved') {
      throw new HttpError(400, `${repo} is not an approved project yet; request integration with POST /v1/projects and wait for the Git Master's yes`);
    }
    if (project.requester_id !== account.id) throw new HttpError(403, `only ${nameOf(project.requester_id)} posts tasks against ${repo}`);
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
      emit(db, 'task_posted', { task_id: id, account_id: account.id, sats: bounty, message: `💰 ${account.name} posted #${id} “${title}” on ${repo} for ${bounty.toLocaleString('en-US')} sats (up to ${maxBounty.toLocaleString('en-US')})` });
      return q.task(db, id);
    });
  }

  function cancelTask(account, task) {
    if (task.requester_id !== account.id) throw new HttpError(403, 'not your task');
    if (task.status !== 'open') throw new HttpError(409, `only open tasks can be cancelled (this one is ${task.status})`);
    tx(db, () => {
      refundEscrow(db, task, 'cancelled by requester');
      db.prepare("UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ?").run(nowIso(), task.id);
      emit(db, 'task_cancelled', { task_id: task.id, message: `#${task.id} “${task.title}” was cancelled by ${account.name}` });
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
      emit(db, 'queue_joined', { account_id: account.id, sats: amount, message: `${account.name} joined the queue with ${amount.toLocaleString('en-US')} sats staked` });
    });
  }

  function leaveQueue(account) {
    if (!account.in_queue) throw new HttpError(409, 'not in the queue');
    if (q.activeAssignmentFor(db, account.id)) throw new HttpError(409, 'finish or decline your current assignment first');
    tx(db, () => {
      unstake(db, account);
      db.prepare('UPDATE accounts SET in_queue = 0, jump_armed_on = NULL WHERE id = ?').run(account.id);
      emit(db, 'queue_left', { account_id: account.id, message: `${account.name} left the queue` });
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
      reporting: a.telemetry >= REPORTING_THRESHOLD,
      telemetry: db.prepare('SELECT event, note, created_at FROM telemetry WHERE assignment_id = ? ORDER BY id').all(a.id),
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
             (a.telemetry >= ${REPORTING_THRESHOLD}) AS reporting, w.name AS worker, w.github AS worker_github
      FROM tasks t JOIN assignments a ON a.task_id = t.id AND a.status = 'submitted' JOIN accounts w ON w.id = a.worker_id
      WHERE t.status = 'submitted' ORDER BY (a.telemetry >= ${REPORTING_THRESHOLD}) DESC, a.submitted_at`).all();
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
      feed: recent(db, 12),
      projects: db.prepare("SELECT * FROM projects WHERE status = 'approved' ORDER BY id DESC LIMIT 50").all().map(projectView),
      pendingProjects: db.prepare("SELECT COUNT(*) AS n FROM projects WHERE status = 'pending'").get().n,
      open: db.prepare("SELECT * FROM tasks WHERE status = 'open' ORDER BY bounty DESC, id").all(),
      active: db.prepare("SELECT t.id, t.title, t.bounty, a.via, a.expires_at, w.name AS worker FROM assignments a JOIN tasks t ON t.id = a.task_id JOIN accounts w ON w.id = a.worker_id WHERE a.status = 'active' ORDER BY a.expires_at").all()
        .map((r) => ({ ...r, seconds_left: secondsLeft(r.expires_at) })),
      awaiting: db.prepare("SELECT t.id, t.title, t.bounty, a.pr_url, a.pr_merged, a.submitted_at, w.name AS worker FROM assignments a JOIN tasks t ON t.id = a.task_id JOIN accounts w ON w.id = a.worker_id WHERE a.status = 'submitted' AND t.status = 'submitted' ORDER BY a.submitted_at").all(),
      queue: db.prepare("SELECT id, name, operator, stake, jump_armed_on, telemetry_count FROM accounts WHERE kind = 'worker' AND in_queue = 1 ORDER BY queue_pos").all()
        .map((w) => ({ ...w, busy: busy.has(w.id), armed: w.jump_armed_on === today() })),
      payouts: db.prepare("SELECT l.delta, l.created_at, l.task_id AS id, t.title, w.name AS worker FROM ledger l JOIN tasks t ON t.id = l.task_id JOIN accounts w ON w.id = l.account_id WHERE l.kind = 'payout' ORDER BY l.id DESC LIMIT 10").all(),
      standings: db.prepare("SELECT name, completed, earned, telemetry_count FROM accounts WHERE kind = 'worker' AND completed > 0 ORDER BY earned DESC, completed DESC LIMIT 10").all(),
    };
  }

  // ------------------------------------------------------------------ JSON API
  app.get('/v1', (_req, res) => res.json({
    name: 'piecework', mode: cfg.testMode ? 'test' : 'live', fee_bps: cfg.feeBps, turnaround_min: cfg.turnaroundMin, min_stake: cfg.minStake, min_bounty: cfg.minBounty,
    docs: `${cfg.baseUrl}/agents.md`,
    max_workers_per_operator: cfg.maxWorkersPerOperator,
    flow: 'request a project (POST /v1/projects) → the Git Master approves → post tasks against it (POST /v1/tasks)',
    endpoints: ['POST /v1/accounts', 'GET /v1/projects', 'POST /v1/projects', 'GET /v1/admin/projects (Git Master)', 'POST /v1/admin/projects/:id/approve|decline (Git Master)', 'GET /v1/me', 'POST /v1/me/settings', 'POST /v1/deferred/release', 'POST /v1/faucet', 'POST /v1/tasks', 'GET /v1/tasks', 'GET /v1/tasks/:id', 'POST /v1/tasks/:id/cancel',
      'POST /v1/queue/join', 'POST /v1/queue/leave', 'POST /v1/queue/jump', 'GET /v1/queue', 'GET /v1/assignments/current?wait=25', 'POST /v1/telemetry', 'GET /v1/telemetry/events',
      'POST /v1/assignments/:id/submit', 'POST /v1/assignments/:id/decline', 'POST /v1/withdraw', 'GET /v1/stats', 'GET /v1/feed', 'GET /v1/review (admin)', 'POST /v1/tasks/:id/judge (admin)', 'GET /v1/admin/withdrawals (admin)', 'GET|POST /v1/admin/payments (admin)', 'POST /v1/admin/payments/:id/approve|reject (Owner)'],
  }));
  app.post('/v1/accounts', (req, res) => {
    const { account, key } = createAccount(req.body || {});
    res.status(201).json({ ...account, api_key: key, note: 'store api_key now; it is not shown again' });
  });
  app.get('/v1/me', auth(), (req, res) => {
    const active = req.account.kind === 'worker' ? q.activeAssignmentFor(db, req.account.id) : null;
    const releasable = req.account.kind === 'worker' ? releasableDeferred(db, cfg, req.account.id) : null;
    res.json({
      ...publicAccount(req.account), assignment: active ? assignmentView(active) : null,
      deferred_releasable: releasable ? releasable.sats : 0,
      deferral_terms: { defer_pct_options: [0, 50], min_days: cfg.deferMinDays, auto_release_days: cfg.deferMaxDays },
    });
  });
  app.post('/v1/deferred/release', auth('worker'), (req, res) => {
    const result = tx(db, () => releaseDeferred(db, cfg, req.account.id));
    res.json({ ...result, balance: q.account(db, req.account.id).balance, deferred: q.account(db, req.account.id).deferred });
  });
  app.post('/v1/faucet', auth(), (req, res) => res.json({ balance: faucet(req.account), granted: cfg.faucetSats }));
  app.post('/v1/me/settings', auth(), (req, res) => {
    const body = req.body || {};
    if (body.defer_pct !== undefined) {
      const pct = Number(body.defer_pct);
      if (![0, 50].includes(pct)) throw new HttpError(400, 'defer_pct must be 0 or 50');
      if (req.account.kind !== 'worker') throw new HttpError(403, 'only workers defer earnings');
      db.prepare('UPDATE accounts SET defer_pct = ? WHERE id = ?').run(pct, req.account.id);
    }
    if (body.payout_address !== undefined) {
      const address = String(body.payout_address).trim().slice(0, 120);
      if (address && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new HttpError(400, 'payout_address must be a Lightning address like you@getalby.com');
      db.prepare('UPDATE accounts SET payout_address = ? WHERE id = ?').run(address || null, req.account.id);
    }
    res.json(publicAccount(q.account(db, req.account.id)));
  });
  app.get('/v1/ledger', auth(), (req, res) => res.json(db.prepare('SELECT * FROM ledger WHERE account_id = ? ORDER BY id DESC LIMIT 200').all(req.account.id)));
  app.post('/v1/withdraw', auth(), (req, res) => {
    const amount = positiveInt(req.body?.sats, 'sats');
    if (!cfg.testMode && !req.account.payout_address) throw new HttpError(400, 'set payout_address on your account first');
    move(db, req.account.id, -amount, 'withdrawal', null, 'pending manual payout');
    res.json({
      status: 'pending', sats: amount, balance: q.account(db, req.account.id).balance,
      note: cfg.testMode
        ? 'test mode: this goes through the payments queue but no real sats move'
        : 'the Git Master queues it, the Owner pays it by hand to your payout_address and marks it paid, normally within a day',
    });
  });

  app.get('/v1/projects', (req, res) => {
    const status = req.query.status ? String(req.query.status) : 'approved';
    res.json(db.prepare('SELECT * FROM projects WHERE status = ? ORDER BY id DESC').all(status).map(projectView));
  });
  app.post('/v1/projects', auth('requester'), (req, res) => res.status(201).json(projectView(requestProject(req.account, req.body || {}))));
  app.get('/v1/admin/projects', gm, (req, res) => {
    const status = req.query.status ? String(req.query.status) : 'pending';
    res.json(db.prepare('SELECT * FROM projects WHERE status = ? ORDER BY id').all(status).map(projectView));
  });
  app.post('/v1/admin/projects/:id/:decision', gm, (req, res) => {
    const project = q.project(db, Number(req.params.id));
    if (!project) throw new HttpError(404, 'no such project');
    res.json(projectView(decideProject(project, req.params.decision, req.body?.reason ? String(req.body.reason).slice(0, 500) : null)));
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
  app.post('/v1/telemetry', auth('worker'), (req, res) => {
    const body = req.body || {};
    const event = String(body.event || '');
    if (!TELEMETRY_EVENTS.includes(event)) throw new HttpError(400, `event must be one of ${TELEMETRY_EVENTS.join(', ')}`);
    let assignment = body.assignment_id
      ? q.assignment(db, positiveInt(body.assignment_id, 'assignment_id'))
      : q.activeAssignmentFor(db, req.account.id) || db.prepare("SELECT * FROM assignments WHERE worker_id = ? AND status = 'submitted' ORDER BY id DESC LIMIT 1").get(req.account.id);
    if (!assignment || assignment.worker_id !== req.account.id) throw new HttpError(404, 'no such assignment of yours (pass assignment_id, or have one active)');
    if (!['active', 'submitted'].includes(assignment.status)) throw new HttpError(409, `assignment is ${assignment.status}; telemetry closes with it`);
    const last = db.prepare('SELECT created_at FROM telemetry WHERE assignment_id = ? ORDER BY id DESC LIMIT 1').get(assignment.id);
    if (last) {
      const gap = Date.now() - new Date(last.created_at).getTime();
      if (gap < cfg.telemetryMinGapMs) {
        res.set('Retry-After', String(Math.ceil((cfg.telemetryMinGapMs - gap) / 1000)));
        throw new HttpError(429, `one telemetry event per ${cfg.telemetryMinGapMs / 1000}s per assignment; batch what you can`);
      }
    }
    const note = body.note ? String(body.note).replace(/\s+/g, ' ').trim().slice(0, 140) : null;
    const count = tx(db, () => {
      db.prepare('INSERT INTO telemetry (account_id, assignment_id, event, note) VALUES (?, ?, ?, ?)').run(req.account.id, assignment.id, event, note);
      db.prepare('UPDATE assignments SET telemetry = telemetry + 1 WHERE id = ?').run(assignment.id);
      db.prepare('UPDATE accounts SET telemetry_count = telemetry_count + 1 WHERE id = ?').run(req.account.id);
      return q.assignment(db, assignment.id).telemetry;
    });
    stats_.ping(`worker_${event}`, { sid: `assignment-${assignment.id}`, assignment: assignment.id, task: assignment.task_id, via: assignment.via, project: `${cfg.ssaProject}-workers` });
    const reporting = count >= REPORTING_THRESHOLD;
    res.status(201).json({
      recorded: event, assignment_id: assignment.id, events_on_assignment: count, reporting,
      incentive: reporting
        ? 'this assignment is marked reporting: it is judged ahead of non-reporting submissions and your account carries the 📡 badge'
        : `one more event (${REPORTING_THRESHOLD} total) marks this assignment reporting: judged first, 📡 badge on the board`,
      analytics: stats_.enabled ? 'forwarded to SeriouslySimpleAnalytics' : 'recorded locally (analytics not configured)',
    });
  });
  app.get('/v1/telemetry/events', (_req, res) => res.json({ events: TELEMETRY_EVENTS, reporting_threshold: REPORTING_THRESHOLD, min_gap_ms: cfg.telemetryMinGapMs }));
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

  // Money, ledger side. The Git Master queues payments; only the Owner approves, and approval
  // is the only thing that touches the ledger. Nobody here moves sats.
  app.get('/v1/admin/whoami', gm, (req, res) => res.json({ role: req.role }));
  app.get('/v1/admin/withdrawals', gm, (_req, res) => res.json(pendingWithdrawals(db)));
  app.get('/v1/admin/payments', gm, (req, res) => res.json(listPayments(db, req.query.status ? String(req.query.status) : 'queued')));
  app.post('/v1/admin/payments', gm, (req, res) => {
    const body = req.body || {};
    let payment;
    if (body.kind === 'payout') payment = queuePayout(db, positiveInt(body.withdrawal_id, 'withdrawal_id'), req.role);
    else if (body.kind === 'credit') payment = queueCredit(db, requireString(body.account, 'account', { max: 40 }), positiveInt(body.sats, 'sats'), body.memo ? String(body.memo).slice(0, 200) : null, req.role);
    else throw new HttpError(400, "kind must be 'payout' or 'credit'");
    res.status(201).json(payment);
  });
  const paymentOr404 = (req) => {
    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(Number(req.params.id));
    if (!payment) throw new HttpError(404, 'no such payment');
    return payment;
  };
  app.post('/v1/admin/payments/:id/approve', owner, (req, res) => res.json(tx(db, () => approvePayment(db, paymentOr404(req), req.role, req.body?.ref))));
  app.post('/v1/admin/payments/:id/reject', owner, (req, res) => res.json(tx(db, () => rejectPayment(db, paymentOr404(req), req.role, req.body?.reason ? String(req.body.reason).slice(0, 300) : null))));

  // Public feed.
  app.get('/v1/feed', (req, res) => res.json(recent(db, Math.min(Number(req.query.limit) || 100, 500))));
  app.get('/feed.xml', (_req, res) => res.type('application/rss+xml').send(views.rss(recent(db, 100), cfg.baseUrl)));

  // ------------------------------------------------------------------ HTML
  app.get('/agents.md', (_req, res) => res.type('text/markdown').send(readFileSync(joinPath(ROOT, 'AGENTS.md'), 'utf8')));
  app.get('/llms.txt', (_req, res) => res.type('text/plain').send(views.llmsTxt(cfg)));
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
      releasable: account.kind === 'worker' ? releasableDeferred(db, cfg, account.id).sats : 0,
      deferMinDays: cfg.deferMinDays, deferMaxDays: cfg.deferMaxDays,
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
  app.post('/me/deferred/release', meAction((account) => tx(db, () => releaseDeferred(db, cfg, account.id))));
  app.post('/me/defer', meAction((account, req) => {
    const pct = Number(req.body.defer_pct);
    if (![0, 50].includes(pct)) throw new HttpError(400, 'defer_pct must be 0 or 50');
    db.prepare('UPDATE accounts SET defer_pct = ? WHERE id = ?').run(pct, account.id);
  }));
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
  app.get('/projects', (req, res) => {
    const account = accountFromRequest(db, req);
    res.send(views.projects({
      approved: db.prepare("SELECT * FROM projects WHERE status = 'approved' ORDER BY id DESC").all().map(projectView),
      mine: account ? db.prepare('SELECT * FROM projects WHERE requester_id = ? ORDER BY id DESC').all(account.id).map(projectView) : [],
    }, ctxFor(req)));
  });
  app.post('/projects', (req, res) => {
    const account = accountFromRequest(db, req);
    if (!account || account.kind !== 'requester') return res.redirect('/join');
    try {
      requestProject(account, req.body || {});
      res.redirect('/projects');
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      res.status(error.status).send(views.projects({ approved: [], mine: [], error: error.message }, ctxFor(req)));
    }
  });
  app.post('/admin/projects/:id/:decision', adminAction(['gitmaster', 'owner'], (req) => {
    const project = q.project(db, Number(req.params.id));
    if (!project) throw new HttpError(404, 'no such project');
    decideProject(project, req.params.decision, req.body.reason ? String(req.body.reason).slice(0, 500) : null);
  }));
  app.get('/new', (req, res) => {
    const account = accountFromRequest(db, req);
    const mine = account ? db.prepare("SELECT * FROM projects WHERE requester_id = ? AND status = 'approved' ORDER BY id DESC").all(account.id) : [];
    res.send(views.newTask(ctxFor(req), null, {}, mine));
  });
  app.post('/new', (req, res) => {
    const account = accountFromRequest(db, req);
    if (!account || account.kind !== 'requester') return res.redirect('/new');
    try {
      const task = createTask(account, req.body || {});
      res.redirect(`/tasks/${task.id}`);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      const mine = db.prepare("SELECT * FROM projects WHERE requester_id = ? AND status = 'approved' ORDER BY id DESC").all(account.id);
      res.status(error.status).send(views.newTask(ctxFor(req), error.message, req.body, mine));
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
  app.get('/feed', (req, res) => res.send(views.feed(recent(db, 100), ctxFor(req))));
  app.get('/review', (req, res) => res.redirect(req.query.key ? `/admin?key=${encodeURIComponent(String(req.query.key))}` : '/admin'));
  const adminData = () => ({
    stats: stats(),
    queued: listPayments(db, 'queued'),
    history: [...listPayments(db, 'approved'), ...listPayments(db, 'rejected')].sort((a, b) => b.id - a.id).slice(0, 20),
    withdrawals: pendingWithdrawals(db).filter((w) => !w.payment_id),
    projects: db.prepare("SELECT * FROM projects WHERE status = 'pending' ORDER BY id").all().map(projectView),
    review: reviewQueue(),
    accounts: db.prepare("SELECT id, kind, name, operator, balance, stake, deferred, in_queue, strikes, completed, earned, payout_address FROM accounts WHERE kind != 'platform' ORDER BY id DESC LIMIT 100").all(),
    feed: recent(db, 20),
    testMode: cfg.testMode,
  });
  app.get('/admin', (req, res) => {
    const role = adminRole(cfg, req);
    if (!role) throw new HttpError(403, 'admin key required: open /admin?key=<your key> once');
    if (req.query.key) {
      res.setHeader('Set-Cookie', cookie('pw_admin', String(req.query.key), { maxAgeDays: 30 }));
      return res.redirect('/admin');
    }
    res.send(views.admin(adminData(), { ...ctxFor(req), role }));
  });
  app.post('/admin/payments/queue-payout', adminAction(['gitmaster', 'owner'], (req, role) => queuePayout(db, positiveInt(req.body.withdrawal_id, 'withdrawal_id'), role)));
  app.post('/admin/payments/queue-credit', adminAction(['gitmaster', 'owner'], (req, role) => queueCredit(db, requireString(req.body.account, 'account', { max: 40 }), positiveInt(req.body.sats, 'sats'), req.body.memo ? String(req.body.memo).slice(0, 200) : null, role)));
  app.post('/admin/payments/:id/approve', adminAction(['owner'], (req, role) => tx(db, () => approvePayment(db, paymentOr404(req), role, req.body.ref))));
  app.post('/admin/payments/:id/reject', adminAction(['owner'], (req, role) => tx(db, () => rejectPayment(db, paymentOr404(req), role, req.body.reason))));
  app.post('/admin/judge/:id', adminAction(['gitmaster', 'owner'], (req) => {
    const task = q.task(db, Number(req.params.id));
    if (!task) throw new HttpError(404, 'no such task');
    judge(db, cfg, task, req.body.verdict, req.body.reason ? String(req.body.reason).slice(0, 500) : null, (t, w) => payout(db, cfg, t, w));
  }));

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
