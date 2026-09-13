#!/usr/bin/env node
/**
 * Reference worker loop. Registers (or reuses WORKER_KEY), gets test sats, stakes, joins the
 * queue, arms today's jump, then long-polls for assignments. When one arrives it prints the
 * task and waits for whoever is driving (a human, or an agent piping stdin) to paste a PR URL.
 *
 *   PIECEWORK_URL=http://localhost:4020 WORKER_NAME=night-shift node tools/worker-example.js
 */
import { createInterface } from 'node:readline/promises';

const url = (process.env.PIECEWORK_URL || 'http://localhost:4020').replace(/\/$/, '');
const rl = createInterface({ input: process.stdin, output: process.stdout });

async function api(method, path, body, key) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  const response = await fetch(url + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${data.error || response.statusText}`);
  return data;
}

let key = process.env.WORKER_KEY;
if (!key) {
  const name = process.env.WORKER_NAME || `worker-${Math.random().toString(36).slice(2, 7)}`;
  const account = await api('POST', '/v1/accounts', { kind: 'worker', name, github: process.env.WORKER_GITHUB });
  key = account.api_key;
  console.log(`registered as ${account.name}; WORKER_KEY=${key}`);
}
const me = await api('GET', '/v1/me', null, key);
const info = await api('GET', '/v1');
if (info.mode === 'test' && me.balance < info.min_stake) await api('POST', '/v1/faucet', null, key);
if (!me.in_queue) {
  await api('POST', '/v1/queue/join', { stake: Number(process.env.STAKE || info.min_stake) }, key);
  console.log(`joined the queue with ${process.env.STAKE || info.min_stake} sats staked`);
}
try { await api('POST', '/v1/queue/jump', null, key); console.log('queue jump armed for today'); } catch (error) { console.log(error.message); }

for (;;) {
  const assignment = me.assignment || (await api('GET', '/v1/assignments/current?wait=25', null, key));
  me.assignment = null;
  if (!assignment) { process.stdout.write('.'); continue; }
  console.log(`\n\n=== ASSIGNMENT ${assignment.id} via ${assignment.via} · ${assignment.seconds_left}s on the clock ===`);
  console.log(`${assignment.task.repo_url} · ${assignment.task.bounty} sats\n${assignment.task.title}\n\n${assignment.task.body}\n`);
  const answer = (await rl.question('Paste the PR URL, or type "decline": ')).trim();
  try {
    if (answer.toLowerCase() === 'decline') { await api('POST', assignment.decline.url, null, key); console.log('declined'); }
    else { await api('POST', assignment.submit.url, { pr_url: answer }, key); console.log('submitted; the Git Master will judge'); }
  } catch (error) {
    console.error(error.message);
  }
}
