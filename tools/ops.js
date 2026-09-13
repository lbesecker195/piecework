#!/usr/bin/env node
/**
 * Operator console for the Git Master. Read-only unless you pass a verb.
 *
 *   ops.js status                          board stats + everything waiting on you
 *   ops.js review                          pull requests awaiting judgment (task text + PR URL)
 *   ops.js accept <taskId> [reason]        pay the worker, refund unused escrow
 *   ops.js reject <taskId> <reason>        escalate and reopen
 *   ops.js projects                        integration requests awaiting a yes
 *   ops.js approve <projectId> [reason]    "yes, this project is in"
 *   ops.js decline <projectId> <reason>
 *   ops.js payouts                         withdrawals pending manual payment (the batch to send)
 *   ops.js paid <withdrawalId> [ref]       mark one paid after you sent it
 *   ops.js credit <account> <sats> [memo]  credit a deposit you have confirmed received
 *
 * Env: PIECEWORK_URL (default http://localhost:4020), GIT_MASTER_KEY (default: data/gitmaster.key)
 */
import { readFileSync } from 'node:fs';

const url = (process.env.PIECEWORK_URL || 'http://localhost:4020').replace(/\/$/, '');
let key = process.env.GIT_MASTER_KEY;
if (!key) {
  try { key = readFileSync(new URL('../data/gitmaster.key', import.meta.url), 'utf8').trim(); } catch { /* fall through */ }
}
if (!key) { console.error('set GIT_MASTER_KEY or run the server once to create data/gitmaster.key'); process.exit(2); }

const [command = 'status', id, ...rest] = process.argv.slice(2);
const tail = rest.join(' ') || null;
const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

async function call(method, path, body) {
  const response = await fetch(url + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { console.error(`${response.status}: ${data.error || response.statusText}`); process.exit(1); }
  return data;
}
const need = (value, what) => { if (!value) { console.error(`${what} required`); process.exit(2); } };
const indent = (text) => `    ${String(text).split('\n').join('\n    ')}`;

const commands = {
  async status() {
    const [stats, review, projects, withdrawals] = await Promise.all([
      call('GET', '/v1/stats'), call('GET', '/v1/review'), call('GET', '/v1/admin/projects?status=pending'), call('GET', '/v1/admin/withdrawals'),
    ]);
    const pending = withdrawals.filter((w) => String(w.memo || '').startsWith('pending'));
    console.log(`open ${stats.open} · in progress ${stats.active} · awaiting judgment ${stats.awaiting} · paid tasks ${stats.paid_tasks}`);
    console.log(`escrow ${stats.escrow} · paid out ${stats.paid} · fees ${stats.fees} · workers ${stats.workers} (${stats.queued} queued) · requesters ${stats.requesters}`);
    console.log(`\nwaiting on you: ${review.length} PR(s) to judge · ${projects.length} project(s) to approve · ${pending.length} payout(s) to send`);
  },
  async review() {
    const items = await call('GET', '/v1/review');
    if (!items.length) return console.log('nothing awaiting judgment');
    for (const a of items) {
      console.log(`#${a.id}  ${a.title}  [${a.repo}]  ${a.bounty} sats  round ${a.rounds + 1}`);
      console.log(`    worker ${a.worker}${a.worker_github ? ` (@${a.worker_github})` : ''}  submitted ${a.submitted_at}`);
      console.log(`    ${a.pr_url}${a.pr_state ? `  (${a.pr_state}${a.pr_merged ? ', merged' : ''})` : ''}`);
      console.log(`    ---\n${indent(a.body)}\n`);
    }
  },
  async accept() {
    need(id, 'task id');
    const r = await call('POST', `/v1/tasks/${id}/judge`, { verdict: 'accept', reason: tail });
    console.log(`accepted #${id}: paid ${r.net} sats (gross ${r.gross}, fee ${r.fee}${r.deferred ? `, ${r.deferred} deferred` : ''})`);
  },
  async reject() {
    need(id, 'task id'); need(tail, 'a reason');
    const r = await call('POST', `/v1/tasks/${id}/judge`, { verdict: 'reject', reason: tail });
    console.log(`rejected #${id}: task is now ${r.status}${r.status === 'open' ? `, bounty ${r.bounty}` : ''}, round ${r.rounds}`);
  },
  async projects() {
    const items = await call('GET', '/v1/admin/projects?status=pending');
    if (!items.length) return console.log('no integration requests');
    for (const p of items) console.log(`P${p.id}  ${p.repo_url}  requested by ${p.requester} ${p.created_at}\n${indent(p.description)}\n`);
  },
  async approve() { need(id, 'project id'); const p = await call('POST', `/v1/admin/projects/${id}/approve`, { reason: tail }); console.log(`approved P${p.id} ${p.repo} — ${p.requester} may now post tasks`); },
  async decline() { need(id, 'project id'); need(tail, 'a reason'); const p = await call('POST', `/v1/admin/projects/${id}/decline`, { reason: tail }); console.log(`declined P${p.id} ${p.repo}: ${p.reason}`); },
  async payouts() {
    const items = (await call('GET', '/v1/admin/withdrawals')).filter((w) => String(w.memo || '').startsWith('pending'));
    if (!items.length) return console.log('no payouts pending');
    let total = 0;
    console.log('id\tsats\tlightning address\taccount\trequested');
    for (const w of items) { total += w.sats; console.log(`${w.id}\t${w.sats}\t${w.payout_address || '(none set)'}\t${w.name}\t${w.created_at}`); }
    console.log(`\n${items.length} payout(s), ${total} sats total. Send them from your wallet, then: ops.js paid <id> [payment hash]`);
  },
  async paid() { need(id, 'withdrawal id'); const r = await call('POST', `/v1/admin/withdrawals/${id}/paid`, { ref: tail }); console.log(`withdrawal ${r.id} (${r.sats} sats) marked: ${r.memo}`); },
  async credit() {
    need(id, 'account name'); const [sats, ...memo] = rest; need(sats, 'sats');
    const a = await call('POST', '/v1/admin/credit', { account: id, sats: Number(sats), memo: memo.join(' ') || null });
    console.log(`credited ${sats} sats to ${a.name}; balance now ${a.balance}`);
  },
};

if (!commands[command]) { console.error(`unknown command ${command}\n`); console.error(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].split('\n').slice(2).join('\n')); process.exit(2); }
await commands[command]();
