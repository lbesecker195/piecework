import { PLATFORM_ID, agentShareId } from './db.js';
import { HttpError, nowIso } from './util.js';

export function move(db, accountId, delta, kind, taskId = null, memo = null) {
  const account = db.prepare('SELECT balance FROM accounts WHERE id = ?').get(accountId);
  if (!account) throw new HttpError(404, 'account not found');
  if (account.balance + delta < 0) throw new HttpError(402, `insufficient balance (have ${account.balance} sats)`);
  db.prepare('UPDATE accounts SET balance = balance + ? WHERE id = ?').run(delta, accountId);
  db.prepare('INSERT INTO ledger (account_id, delta, kind, task_id, memo) VALUES (?, ?, ?, ?, ?)').run(
    accountId, delta, kind, taskId, memo,
  );
}

/**
 * The platform's cut lands on the platform account, then `agentSharePct` of it moves to the
 * agent-share account. That account has no API key, so nothing can withdraw from it; it is a
 * booking. The owner keeps the remainder, including any odd sat. Call inside tx().
 */
export function creditCut(db, cfg, amount, kind, taskId, memo) {
  move(db, PLATFORM_ID, amount, kind, taskId, memo);
  const pct = Math.min(Math.max(Number(cfg.agentSharePct ?? 50), 0), 100);
  const agent = Math.floor((amount * pct) / 100);
  if (agent > 0) {
    move(db, PLATFORM_ID, -agent, 'agent_share', taskId, `${pct}% of ${kind} booked to the agent`);
    move(db, agentShareId(db), agent, 'agent_share', taskId, `${pct}% of ${kind}${taskId ? ` on task #${taskId}` : ''}`);
  }
  return { owner: amount - agent, agent };
}

export function feeFor(bounty, feeBps) {
  return Math.floor((bounty * feeBps) / 10000);
}

/** Lock the task's maximum bounty from the requester so escalation is always funded. */
export function lockEscrow(db, requesterId, taskId, maxBounty) {
  move(db, requesterId, -maxBounty, 'escrow_lock', taskId, `escrow for task #${taskId}`);
}

export function refundEscrow(db, task, memo) {
  if (task.escrow > 0) {
    move(db, task.requester_id, task.escrow, 'escrow_refund', task.id, memo);
    db.prepare('UPDATE tasks SET escrow = 0 WHERE id = ?').run(task.id);
  }
}

/** Pay the worker the current bounty minus the platform fee and refund unused escrow. Call inside tx(). */
export function payout(db, cfg, task, workerId) {
  {
    const fee = feeFor(task.bounty, cfg.feeBps);
    const net = task.bounty - fee;
    const worker = db.prepare('SELECT defer_pct FROM accounts WHERE id = ?').get(workerId);
    const deferred = Math.floor((net * (worker?.defer_pct || 0)) / 100);
    move(db, workerId, net - deferred, 'payout', task.id, `bounty for task #${task.id}`);
    if (deferred > 0) {
      db.prepare('UPDATE accounts SET deferred = deferred + ? WHERE id = ?').run(deferred, workerId);
      db.prepare('INSERT INTO ledger (account_id, delta, kind, task_id, memo) VALUES (?, ?, ?, ?, ?)').run(
        workerId, deferred, 'payout_deferred', task.id, `${worker.defer_pct}% of task #${task.id} deferred`,
      );
      db.prepare('INSERT INTO deferrals (account_id, task_id, sats) VALUES (?, ?, ?)').run(workerId, task.id, deferred);
    }
    if (fee > 0) creditCut(db, cfg, fee, 'fee', task.id, `${cfg.feeBps / 100}% fee on task #${task.id}`);
    const unused = task.escrow - task.bounty;
    if (unused > 0) move(db, task.requester_id, unused, 'escrow_refund', task.id, 'unused escrow');
    db.prepare("UPDATE tasks SET escrow = 0, status = 'paid', updated_at = ? WHERE id = ?").run(nowIso(), task.id);
    db.prepare('UPDATE accounts SET completed = completed + 1, earned = earned + ? WHERE id = ?').run(net, workerId);
    return { gross: task.bounty, fee, net, deferred };
  }
}

export function stake(db, cfg, account, amount) {
  if (amount < cfg.minStake) throw new HttpError(400, `stake must be at least ${cfg.minStake} sats`);
  move(db, account.id, -amount, 'stake', null, 'queue stake');
  db.prepare('UPDATE accounts SET stake = stake + ? WHERE id = ?').run(amount, account.id);
}

export function unstake(db, account) {
  if (account.stake > 0) {
    move(db, account.id, account.stake, 'unstake', null, 'stake returned');
    db.prepare('UPDATE accounts SET stake = 0 WHERE id = ?').run(account.id);
  }
}

/** Timeouts cost a slice of the stake; that slice goes to the platform. */
export function slash(db, cfg, account) {
  const amount = Math.floor((account.stake * cfg.slashPct) / 100);
  if (amount <= 0) return 0;
  db.prepare('UPDATE accounts SET stake = stake - ? WHERE id = ?').run(amount, account.id);
  db.prepare('INSERT INTO ledger (account_id, delta, kind, task_id, memo) VALUES (?, ?, ?, ?, ?)').run(
    account.id, -amount, 'slash', null, `${cfg.slashPct}% of stake slashed after ${cfg.maxStrikes} timeouts`,
  );
  creditCut(db, cfg, amount, 'slash', null, `slash from ${account.name}`);
  return amount;
}

const daysAgo = (now, days) => new Date(now.getTime() - days * 86_400_000).toISOString();

/** Sats deferred at least `minDays` ago and not yet released. */
export function releasableDeferred(db, cfg, accountId, now = new Date()) {
  return db.prepare('SELECT COALESCE(SUM(sats), 0) AS sats, COUNT(*) AS lots FROM deferrals WHERE account_id = ? AND released_at IS NULL AND created_at <= ?')
    .get(accountId, daysAgo(now, cfg.deferMinDays));
}

/** Move matured deferrals (older than `minDays`) into the spendable balance. Call inside tx(). */
export function releaseDeferred(db, cfg, accountId, { minDays = cfg.deferMinDays, now = new Date(), memo = 'matured deferral released' } = {}) {
  const lots = db.prepare('SELECT * FROM deferrals WHERE account_id = ? AND released_at IS NULL AND created_at <= ? ORDER BY id')
    .all(accountId, daysAgo(now, minDays));
  let total = 0;
  for (const lot of lots) {
    db.prepare('UPDATE deferrals SET released_at = ? WHERE id = ?').run(now.toISOString(), lot.id);
    total += lot.sats;
  }
  if (total > 0) {
    db.prepare('UPDATE accounts SET deferred = deferred - ? WHERE id = ?').run(total, accountId);
    move(db, accountId, total, 'deferred_release', null, `${lots.length} lot(s): ${memo}`);
  }
  return { released: total, lots: lots.length };
}

/** Anything still deferred after `deferMaxDays` is released whether or not the worker asked. Call inside tx(). */
export function autoReleaseDeferred(db, cfg, now = new Date()) {
  const accounts = db.prepare('SELECT DISTINCT account_id FROM deferrals WHERE released_at IS NULL AND created_at <= ?').all(daysAgo(now, cfg.deferMaxDays));
  return accounts.map((row) => ({
    account: row.account_id,
    ...releaseDeferred(db, cfg, row.account_id, { minDays: cfg.deferMaxDays, now, memo: `held ${cfg.deferMaxDays} days, released automatically` }),
  }));
}
