/**
 * The payments queue. The Git Master proposes; the Owner approves. Approval is the only
 * thing that changes the ledger, and only the Owner key can approve. Nobody here moves sats:
 * a payout is marked paid after the Owner has sent it from their own wallet.
 */
import { q } from './db.js';
import { emit } from './events.js';
import { move } from './ledger.js';
import { HttpError, nowIso } from './util.js';

export function pendingWithdrawals(db) {
  return db.prepare(`
    SELECT l.id, l.account_id, a.name, a.payout_address, -l.delta AS sats, l.memo, l.created_at,
           (SELECT p.id FROM payments p WHERE p.ledger_id = l.id AND p.status != 'rejected' ORDER BY p.id DESC LIMIT 1) AS payment_id
    FROM ledger l JOIN accounts a ON a.id = l.account_id
    WHERE l.kind = 'withdrawal' AND l.memo LIKE 'pending%' ORDER BY l.id`).all();
}

export function listPayments(db, status = 'queued') {
  return db.prepare('SELECT p.*, a.name FROM payments p JOIN accounts a ON a.id = p.account_id WHERE p.status = ? ORDER BY p.id DESC LIMIT 200').all(status);
}

export function queuePayout(db, withdrawalId, proposedBy) {
  const row = db.prepare("SELECT * FROM ledger WHERE id = ? AND kind = 'withdrawal'").get(withdrawalId);
  if (!row) throw new HttpError(404, 'no such withdrawal');
  if (!String(row.memo || '').startsWith('pending')) throw new HttpError(409, `withdrawal is already ${row.memo}`);
  const open = db.prepare("SELECT id FROM payments WHERE ledger_id = ? AND status != 'rejected'").get(withdrawalId);
  if (open) throw new HttpError(409, `already queued as payment #${open.id}`);
  const account = q.account(db, row.account_id);
  const info = db.prepare("INSERT INTO payments (kind, account_id, sats, address, memo, ledger_id, status, proposed_by) VALUES ('payout', ?, ?, ?, ?, ?, 'queued', ?)")
    .run(account.id, -row.delta, account.payout_address, `payout to ${account.name}`, row.id, proposedBy);
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(Number(info.lastInsertRowid));
}

export function queueCredit(db, accountName, sats, memo, proposedBy) {
  const account = db.prepare('SELECT * FROM accounts WHERE lower(name) = lower(?)').get(String(accountName));
  if (!account) throw new HttpError(404, 'no such account');
  const info = db.prepare("INSERT INTO payments (kind, account_id, sats, memo, status, proposed_by) VALUES ('credit', ?, ?, ?, 'queued', ?)")
    .run(account.id, sats, memo || `deposit from ${account.name}`, proposedBy);
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(Number(info.lastInsertRowid));
}

/** Owner only. Credit lands on the balance; a payout is recorded as paid. Call inside tx(). */
export function approvePayment(db, payment, decidedBy, ref) {
  if (payment.status !== 'queued') throw new HttpError(409, `payment is already ${payment.status}`);
  const account = q.account(db, payment.account_id);
  if (payment.kind === 'credit') {
    move(db, account.id, payment.sats, 'deposit', null, payment.memo || 'deposit');
    emit(db, 'deposit', { account_id: account.id, sats: payment.sats, message: `${account.name} deposited ${payment.sats.toLocaleString('en-US')} sats` });
  } else {
    const memo = `paid ${nowIso()}${ref ? ` · ${String(ref).slice(0, 120)}` : ''}`;
    db.prepare('UPDATE ledger SET memo = ? WHERE id = ?').run(memo, payment.ledger_id);
    emit(db, 'payout', { account_id: account.id, sats: payment.sats, message: `${payment.sats.toLocaleString('en-US')} sats paid out to ${account.name}` });
  }
  db.prepare("UPDATE payments SET status = 'approved', decided_by = ?, decided_at = ?, ref = ? WHERE id = ?").run(decidedBy, nowIso(), ref || null, payment.id);
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id);
}

/** Owner only. A rejected payout returns the sats to the worker's balance. Call inside tx(). */
export function rejectPayment(db, payment, decidedBy, reason) {
  if (payment.status !== 'queued') throw new HttpError(409, `payment is already ${payment.status}`);
  if (payment.kind === 'payout') {
    move(db, payment.account_id, payment.sats, 'withdrawal_refund', null, `withdrawal returned: ${reason || 'rejected'}`);
    db.prepare('UPDATE ledger SET memo = ? WHERE id = ?').run(`refunded: ${reason || 'rejected'}`, payment.ledger_id);
  }
  db.prepare("UPDATE payments SET status = 'rejected', decided_by = ?, decided_at = ?, ref = ? WHERE id = ?").run(decidedBy, nowIso(), reason || null, payment.id);
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id);
}
