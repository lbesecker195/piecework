import { q } from './db.js';
import { refundEscrow, slash, unstake } from './ledger.js';
import { HttpError, nowIso, today, tx } from './util.js';
import { parsePr } from './github.js';

const nextQueuePos = (db) => db.prepare('SELECT COALESCE(MAX(queue_pos), 0) AS m FROM accounts').get().m + 1;

/**
 * Hand every open task to a worker. For each task: if any queue-jump tokens are armed
 * today, flip a coin (jumpChance); heads goes to a random armed worker and consumes the
 * token. Otherwise the head of the round-robin queue takes it. Either way the chosen
 * worker rotates to the tail and gets `turnaroundMin` minutes.
 */
export function dispatch(db, cfg, rng = Math.random, now = new Date()) {
  const assigned = [];
  const tasks = db.prepare("SELECT * FROM tasks WHERE status = 'open' ORDER BY id").all();
  for (const task of tasks) {
    const busy = new Set(db.prepare("SELECT worker_id FROM assignments WHERE status = 'active'").all().map((r) => r.worker_id));
    const free = (rows) => rows.filter((w) => !busy.has(w.id));
    let worker = null;
    let via = 'roundrobin';
    const armed = free(db.prepare("SELECT * FROM accounts WHERE kind = 'worker' AND in_queue = 1 AND jump_armed_on = ? ORDER BY id").all(today()));
    if (armed.length > 0 && rng() < cfg.jumpChance) {
      worker = armed[Math.floor(rng() * armed.length)];
      via = 'jump';
    }
    if (!worker) {
      worker = free(db.prepare("SELECT * FROM accounts WHERE kind = 'worker' AND in_queue = 1 ORDER BY queue_pos").all())[0] || null;
    }
    if (!worker) break;
    const expires = new Date(now.getTime() + cfg.turnaroundMin * 60_000);
    tx(db, () => {
      if (via === 'jump') db.prepare('UPDATE accounts SET jump_armed_on = NULL WHERE id = ?').run(worker.id);
      db.prepare('UPDATE accounts SET queue_pos = ? WHERE id = ?').run(nextQueuePos(db), worker.id);
      db.prepare(
        "INSERT INTO assignments (task_id, worker_id, via, status, assigned_at, expires_at) VALUES (?, ?, ?, 'active', ?, ?)",
      ).run(task.id, worker.id, via, now.toISOString(), expires.toISOString());
      db.prepare("UPDATE tasks SET status = 'assigned', updated_at = ? WHERE id = ?").run(now.toISOString(), task.id);
    });
    busy.add(worker.id);
    assigned.push({ task: task.id, worker: worker.id, via });
  }
  return assigned;
}

/** A failed round: escalate the bounty toward max_bounty, or fail the task and refund. */
export function failRound(db, cfg, task, reason) {
  const rounds = task.rounds + 1;
  if (rounds >= cfg.maxRounds) {
    refundEscrow(db, task, `task failed after ${rounds} rounds`);
    db.prepare("UPDATE tasks SET status = 'failed', rounds = ?, updated_at = ? WHERE id = ?").run(rounds, nowIso(), task.id);
    return { status: 'failed', bounty: task.bounty, rounds };
  }
  const bounty = Math.min(task.max_bounty, Math.ceil(task.bounty * (1 + cfg.escalationPct / 100)));
  db.prepare("UPDATE tasks SET status = 'open', bounty = ?, rounds = ?, updated_at = ? WHERE id = ?").run(bounty, rounds, nowIso(), task.id);
  return { status: 'open', bounty, rounds, reason };
}

/** Expire overdue assignments: strike the worker, escalate the task. */
export function sweepTimeouts(db, cfg, now = new Date()) {
  const overdue = db.prepare("SELECT * FROM assignments WHERE status = 'active' AND expires_at < ?").all(now.toISOString());
  const results = [];
  for (const assignment of overdue) {
    tx(db, () => {
      db.prepare("UPDATE assignments SET status = 'timeout', judged_at = ?, verdict_reason = 'clock ran out' WHERE id = ?").run(now.toISOString(), assignment.id);
      const worker = q.account(db, assignment.worker_id);
      const strikes = worker.strikes + 1;
      db.prepare('UPDATE accounts SET strikes = ? WHERE id = ?').run(strikes, worker.id);
      if (strikes >= cfg.maxStrikes) {
        const slashed = slash(db, cfg, { ...worker, strikes });
        const refreshed = q.account(db, worker.id);
        unstake(db, refreshed);
        db.prepare('UPDATE accounts SET in_queue = 0, strikes = 0, jump_armed_on = NULL WHERE id = ?').run(worker.id);
        results.push({ assignment: assignment.id, worker: worker.id, ejected: true, slashed });
      } else {
        results.push({ assignment: assignment.id, worker: worker.id, strikes });
      }
      failRound(db, cfg, q.task(db, assignment.task_id), 'timeout');
    });
  }
  return results;
}

export function submit(db, assignment, prUrl, now = new Date()) {
  if (assignment.status !== 'active') throw new HttpError(409, `assignment is ${assignment.status}`);
  if (new Date(assignment.expires_at) < now) throw new HttpError(409, 'the clock ran out; this assignment has expired');
  const task = q.task(db, assignment.task_id);
  const parsed = parsePr(prUrl);
  if (!parsed) throw new HttpError(400, 'pr_url must look like https://github.com/owner/repo/pull/123');
  if (parsed.repo.toLowerCase() !== task.repo.toLowerCase()) {
    throw new HttpError(400, `pr_url must be a pull request against ${task.repo}`);
  }
  tx(db, () => {
    db.prepare("UPDATE assignments SET status = 'submitted', pr_url = ?, submitted_at = ? WHERE id = ?").run(prUrl.trim(), now.toISOString(), assignment.id);
    db.prepare("UPDATE tasks SET status = 'submitted', updated_at = ? WHERE id = ?").run(now.toISOString(), task.id);
  });
}

export function decline(db, assignment, now = new Date()) {
  if (assignment.status !== 'active') throw new HttpError(409, `assignment is ${assignment.status}`);
  tx(db, () => {
    db.prepare("UPDATE assignments SET status = 'declined', judged_at = ? WHERE id = ?").run(now.toISOString(), assignment.id);
    db.prepare("UPDATE tasks SET status = 'open', updated_at = ? WHERE id = ?").run(now.toISOString(), assignment.task_id);
  });
}

/** The Git Master's verdict. Accept pays; reject escalates. */
export function judge(db, cfg, task, verdict, reason, payoutFn, now = new Date()) {
  if (task.status !== 'submitted') throw new HttpError(409, `task is ${task.status}, not awaiting judgment`);
  const assignment = q.latestAssignmentForTask(db, task.id);
  if (!assignment || assignment.status !== 'submitted') throw new HttpError(409, 'no submitted assignment to judge');
  if (verdict === 'accept') {
    return tx(db, () => {
      const result = payoutFn(task, assignment.worker_id);
      db.prepare("UPDATE assignments SET status = 'accepted', judged_at = ?, verdict_reason = ? WHERE id = ?").run(now.toISOString(), reason || null, assignment.id);
      return { verdict, ...result };
    });
  }
  if (verdict === 'reject') {
    return tx(db, () => {
      db.prepare("UPDATE assignments SET status = 'rejected', judged_at = ?, verdict_reason = ? WHERE id = ?").run(now.toISOString(), reason || null, assignment.id);
      return { verdict, ...failRound(db, cfg, task, reason) };
    });
  }
  throw new HttpError(400, "verdict must be 'accept' or 'reject'");
}
