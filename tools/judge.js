#!/usr/bin/env node
/**
 * Git Master CLI.
 *   node tools/judge.js list
 *   node tools/judge.js accept <taskId> [reason]
 *   node tools/judge.js reject <taskId> <reason>
 * Env: PIECEWORK_URL (default http://localhost:4020), GIT_MASTER_KEY (default: read data/gitmaster.key)
 */
import { readFileSync } from 'node:fs';

const url = (process.env.PIECEWORK_URL || 'http://localhost:4020').replace(/\/$/, '');
let key = process.env.GIT_MASTER_KEY;
if (!key) {
  try { key = readFileSync(new URL('../data/gitmaster.key', import.meta.url), 'utf8').trim(); } catch { /* fall through */ }
}
if (!key) { console.error('set GIT_MASTER_KEY or run the server once to create data/gitmaster.key'); process.exit(2); }

const [command, id, ...rest] = process.argv.slice(2);
const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

async function call(method, path, body) {
  const response = await fetch(url + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { console.error(`${response.status}: ${data.error || response.statusText}`); process.exit(1); }
  return data;
}

if (command === 'list' || !command) {
  const items = await call('GET', '/v1/review');
  if (!items.length) { console.log('nothing awaiting judgment'); process.exit(0); }
  for (const a of items) {
    console.log(`#${a.id}  ${a.title}  [${a.repo}]  ${a.bounty} sats  round ${a.rounds + 1}`);
    console.log(`    worker ${a.worker}${a.worker_github ? ` (@${a.worker_github})` : ''}  submitted ${a.submitted_at}`);
    console.log(`    ${a.pr_url}${a.pr_state ? `  (${a.pr_state}${a.pr_merged ? ', merged' : ''})` : ''}`);
    console.log(`    ---\n    ${a.body.split('\n').join('\n    ')}\n`);
  }
} else if (command === 'accept' || command === 'reject') {
  if (!id) { console.error('task id required'); process.exit(2); }
  const reason = rest.join(' ') || null;
  if (command === 'reject' && !reason) { console.error('a reason is required to reject'); process.exit(2); }
  const result = await call('POST', `/v1/tasks/${id}/judge`, { verdict: command, reason });
  if (command === 'accept') console.log(`accepted #${id}: paid ${result.net} sats (gross ${result.gross}, fee ${result.fee})`);
  else console.log(`rejected #${id}: task is now ${result.status}${result.status === 'open' ? `, bounty ${result.bounty}` : ''}, round ${result.rounds}`);
} else {
  console.error('usage: judge.js list | accept <taskId> [reason] | reject <taskId> <reason>');
  process.exit(2);
}
