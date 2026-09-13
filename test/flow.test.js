import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, q } from '../src/db.js';
import { createApp } from '../src/app.js';
import { dispatch, sweepTimeouts } from '../src/dispatch.js';
import { autoReleaseDeferred } from '../src/ledger.js';
import { tx } from '../src/util.js';
import { config } from '../src/config.js';

const GM = 'gm-test-key';
const cfg = { ...config, testMode: true, gitMasterKey: GM, minStake: 100, minBounty: 10, faucetSats: 10000, turnaroundMin: 10, maxWorkersPerOperator: 1 };
const REPO = 'https://github.com/octo/demo';

async function start() {
  const db = openDb(':memory:');
  const app = createApp({ db, cfg });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, body, key) => {
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;
    const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const text = await res.text();
    let data = text;
    try { data = text ? JSON.parse(text) : null; } catch { /* html */ }
    return { status: res.status, data, headers: res.headers };
  };
  const account = async (kind, name, operator) => (await api('POST', '/v1/accounts', { kind, name, operator })).data;
  const fund = (acc) => api('POST', '/v1/faucet', null, acc.api_key);
  const post = async (R, bounty, max_bounty) => (await api('POST', '/v1/tasks', { repo_url: REPO, title: 'Add a flag', body: 'Add --dry-run to the CLI', bounty, max_bounty }, R.api_key)).data;
  const expireActive = () => db.prepare("UPDATE assignments SET expires_at = ? WHERE status = 'active'").run(new Date(Date.now() - 1000).toISOString());
  return { db, api, account, fund, post, expireActive, close: () => new Promise((r) => server.close(r)) };
}

test('happy path: post, round-robin dispatch, submit, accept, payout minus fee, escrow refund', async (t) => {
  const s = await start(); t.after(s.close);
  const R = await s.account('requester', 'ada');
  const A = await s.account('worker', 'alpha', 'op-a');
  const B = await s.account('worker', 'beta', 'op-b');
  for (const acc of [R, A, B]) assert.equal((await s.fund(acc)).status, 200);
  assert.equal((await s.api('POST', '/v1/queue/join', { stake: 500 }, A.api_key)).status, 200);
  assert.equal((await s.api('POST', '/v1/queue/join', { stake: 500 }, B.api_key)).status, 200);

  const task = await s.post(R, 1000);
  assert.equal(task.max_bounty, 3000);
  assert.equal(task.escrow, 3000);
  assert.equal((await s.api('GET', '/v1/me', null, R.api_key)).data.balance, 7000);
  assert.equal((await s.api('GET', '/v1/assignments/current', null, A.api_key)).status, 204);

  assert.deepEqual(dispatch(s.db, cfg, () => 0.99), [{ task: task.id, worker: A.id, via: 'roundrobin' }]);
  const current = await s.api('GET', '/v1/assignments/current', null, A.api_key);
  assert.equal(current.status, 200);
  assert.equal(current.data.task.id, task.id);
  assert.ok(current.data.seconds_left > 590);
  assert.equal((await s.api('GET', '/v1/assignments/current', null, B.api_key)).status, 204);

  assert.equal((await s.api('POST', current.data.submit.url, { pr_url: 'https://github.com/other/repo/pull/1' }, A.api_key)).status, 400);
  assert.equal((await s.api('POST', current.data.submit.url, { pr_url: `${REPO}/pull/7` }, B.api_key)).status, 404);
  const submitted = await s.api('POST', current.data.submit.url, { pr_url: `${REPO}/pull/7` }, A.api_key);
  assert.equal(submitted.status, 200);
  assert.equal(submitted.data.task.status, 'submitted');

  assert.equal((await s.api('GET', '/v1/review', null, A.api_key)).status, 403);
  const review = await s.api('GET', '/v1/review', null, GM);
  assert.equal(review.data.length, 1);
  assert.equal(review.data[0].worker, 'alpha');

  const verdict = await s.api('POST', `/v1/tasks/${task.id}/judge`, { verdict: 'accept', reason: 'does the job' }, GM);
  assert.equal(verdict.status, 200);
  assert.deepEqual([verdict.data.gross, verdict.data.fee, verdict.data.net], [1000, 50, 950]);
  assert.equal(verdict.data.task.status, 'paid');
  const meA = (await s.api('GET', '/v1/me', null, A.api_key)).data;
  assert.equal(meA.balance, 10000 - 500 + 950);
  assert.equal(meA.completed, 1);
  assert.equal(meA.earned, 950);
  assert.equal((await s.api('GET', '/v1/me', null, R.api_key)).data.balance, 9000);
  assert.equal(q.account(s.db, 1).balance, 50);
  const stats = (await s.api('GET', '/v1/stats')).data;
  assert.deepEqual([stats.paid, stats.fees, stats.escrow, stats.paid_tasks], [950, 50, 0, 1]);
  assert.equal((await s.api('POST', `/v1/tasks/${task.id}/judge`, { verdict: 'accept' }, GM)).status, 409);
});

test('rotation, decline, reject escalates, timeout strikes, jump lottery', async (t) => {
  const s = await start(); t.after(s.close);
  const R = await s.account('requester', 'ada');
  const A = await s.account('worker', 'alpha', 'op-a');
  const B = await s.account('worker', 'beta', 'op-b');
  for (const acc of [R, A, B]) await s.fund(acc);
  await s.api('POST', '/v1/queue/join', { stake: 500 }, A.api_key);
  await s.api('POST', '/v1/queue/join', { stake: 500 }, B.api_key);
  let task = await s.post(R, 1000, 5000);

  assert.deepEqual(dispatch(s.db, cfg, () => 0.99), [{ task: task.id, worker: A.id, via: 'roundrobin' }]);
  const a1 = (await s.api('GET', '/v1/assignments/current', null, A.api_key)).data;
  assert.equal((await s.api('POST', a1.decline.url, null, A.api_key)).status, 200);
  task = (await s.api('GET', `/v1/tasks/${task.id}`)).data;
  assert.deepEqual([task.status, task.bounty, task.rounds], ['open', 1000, 0]);

  assert.deepEqual(dispatch(s.db, cfg, () => 0.99), [{ task: task.id, worker: B.id, via: 'roundrobin' }]);
  const b1 = (await s.api('GET', '/v1/assignments/current', null, B.api_key)).data;
  await s.api('POST', b1.submit.url, { pr_url: `${REPO}/pull/1` }, B.api_key);
  const rejected = await s.api('POST', `/v1/tasks/${task.id}/judge`, { verdict: 'reject', reason: 'missing the flag' }, GM);
  assert.equal(rejected.status, 200);
  task = (await s.api('GET', `/v1/tasks/${task.id}`)).data;
  assert.deepEqual([task.status, task.bounty, task.rounds], ['open', 1250, 1]);
  assert.equal(task.assignments.at(-1).verdict_reason, 'missing the flag');

  assert.deepEqual(dispatch(s.db, cfg, () => 0.99), [{ task: task.id, worker: A.id, via: 'roundrobin' }]);
  s.expireActive();
  const swept = sweepTimeouts(s.db, cfg);
  assert.equal(swept.length, 1);
  assert.equal(swept[0].strikes, 1);
  task = (await s.api('GET', `/v1/tasks/${task.id}`)).data;
  assert.deepEqual([task.status, task.bounty, task.rounds], ['open', 1563, 2]);

  // Queue is now B, A. A arms a jump; heads on the coin sends the contract to A anyway.
  assert.equal((await s.api('POST', '/v1/queue/jump', null, A.api_key)).status, 200);
  assert.equal((await s.api('POST', '/v1/queue/jump', null, A.api_key)).status, 409);
  const rolls = [0.1, 0.0];
  assert.deepEqual(dispatch(s.db, cfg, () => (rolls.length ? rolls.shift() : 0.99)), [{ task: task.id, worker: A.id, via: 'jump' }]);
  assert.equal(q.account(s.db, A.id).jump_armed_on, null);
  const queue = (await s.api('GET', '/v1/queue')).data;
  assert.deepEqual(queue.map((w) => [w.name, w.busy]), [['beta', false], ['alpha', true]]);
});

test('one queue seat per operator, cancel refunds, three timeouts eject and slash', async (t) => {
  const s = await start(); t.after(s.close);
  const R = await s.account('requester', 'ada');
  const C = await s.account('worker', 'gamma', 'op-c');
  const C2 = await s.account('worker', 'gamma-2', 'op-c');
  for (const acc of [R, C, C2]) await s.fund(acc);
  assert.equal((await s.api('POST', '/v1/accounts', { kind: 'worker', name: 'no-operator' })).status, 400);
  assert.equal((await s.api('POST', '/v1/queue/join', { stake: 1000 }, C.api_key)).status, 200);
  const blocked = await s.api('POST', '/v1/queue/join', { stake: 1000 }, C2.api_key);
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /op-c/);

  const cancelled = await s.post(R, 500);
  assert.equal((await s.api('GET', '/v1/me', null, R.api_key)).data.balance, 8500);
  assert.equal((await s.api('POST', `/v1/tasks/${cancelled.id}/cancel`, null, R.api_key)).data.status, 'cancelled');
  assert.equal((await s.api('GET', '/v1/me', null, R.api_key)).data.balance, 10000);

  const task = await s.post(R, 1000, 9000);
  const bounties = [];
  for (let round = 1; round <= 3; round += 1) {
    assert.deepEqual(dispatch(s.db, cfg, () => 0.99), [{ task: task.id, worker: C.id, via: 'roundrobin' }]);
    s.expireActive();
    const [result] = sweepTimeouts(s.db, cfg);
    bounties.push(q.task(s.db, task.id).bounty);
    if (round < 3) assert.equal(result.strikes, round);
    else assert.deepEqual([result.ejected, result.slashed], [true, 100]);
  }
  assert.deepEqual(bounties, [1250, 1563, 1954]);
  const c = (await s.api('GET', '/v1/me', null, C.api_key)).data;
  assert.deepEqual([c.in_queue, c.stake, c.balance, c.strikes], [0, 0, 9900, 0]);
  assert.equal(q.account(s.db, 1).balance, 100);
  assert.deepEqual(dispatch(s.db, cfg, () => 0.99), []);
});

test('pages and edges', async (t) => {
  const s = await start(); t.after(s.close);
  const board = await s.api('GET', '/');
  assert.equal(board.status, 200);
  assert.match(board.data, /Piecework/);
  assert.match(board.data, /test sats/);
  assert.equal((await s.api('GET', '/agents.md')).status, 200);
  assert.equal((await s.api('GET', '/review')).status, 403);
  assert.equal((await s.api('GET', '/review', null, GM)).status, 200);
  assert.equal((await s.api('GET', '/v1/tasks/999')).status, 404);
  assert.equal((await s.api('GET', '/nope')).status, 404);
  const info = (await s.api('GET', '/v1')).data;
  assert.equal(info.mode, 'test');
  assert.equal(info.max_workers_per_operator, 1);
});

test('a worker can defer half of each payout', async (t) => {
  const s = await start(); t.after(s.close);
  const R = await s.account('requester', 'ada');
  const D = await s.account('worker', 'delta', 'op-d');
  await s.fund(R); await s.fund(D);
  await s.api('POST', '/v1/queue/join', { stake: 100 }, D.api_key);
  assert.equal((await s.api('POST', '/v1/me/settings', { defer_pct: 30 }, D.api_key)).status, 400);
  assert.equal((await s.api('POST', '/v1/me/settings', { defer_pct: 50 }, D.api_key)).status, 200);
  const task = await s.post(R, 1000);
  dispatch(s.db, cfg, () => 0.99);
  const current = (await s.api('GET', '/v1/assignments/current', null, D.api_key)).data;
  await s.api('POST', current.submit.url, { pr_url: `${REPO}/pull/3` }, D.api_key);
  const verdict = (await s.api('POST', `/v1/tasks/${task.id}/judge`, { verdict: 'accept' }, GM)).data;
  assert.deepEqual([verdict.net, verdict.deferred], [950, 475]);
  const me = (await s.api('GET', '/v1/me', null, D.api_key)).data;
  assert.deepEqual([me.balance, me.deferred, me.earned], [10000 - 100 + 475, 475, 950]);
  const kinds = (await s.api('GET', '/v1/ledger', null, D.api_key)).data.map((l) => l.kind);
  assert.ok(kinds.includes('payout_deferred'));

  // Nothing has matured yet.
  assert.equal(me.deferred_releasable, 0);
  assert.deepEqual((await s.api('POST', '/v1/deferred/release', null, D.api_key)).data.released, 0);
  // Backdate the lot 31 days: it matures and can be released on request.
  s.db.prepare('UPDATE deferrals SET created_at = ? WHERE account_id = ?').run(new Date(Date.now() - 31 * 86_400_000).toISOString(), D.id);
  assert.equal((await s.api('GET', '/v1/me', null, D.api_key)).data.deferred_releasable, 475);
  const released = (await s.api('POST', '/v1/deferred/release', null, D.api_key)).data;
  assert.deepEqual([released.released, released.lots, released.balance, released.deferred], [475, 1, 10000 - 100 + 950, 0]);
  // A second lot left alone for over a year is released automatically.
  const task2 = await s.post(R, 1000);
  dispatch(s.db, cfg, () => 0.99);
  const cur2 = (await s.api('GET', '/v1/assignments/current', null, D.api_key)).data;
  await s.api('POST', cur2.submit.url, { pr_url: `${REPO}/pull/4` }, D.api_key);
  await s.api('POST', `/v1/tasks/${task2.id}/judge`, { verdict: 'accept' }, GM);
  assert.deepEqual(tx(s.db, () => autoReleaseDeferred(s.db, cfg)), []);
  s.db.prepare('UPDATE deferrals SET created_at = ? WHERE released_at IS NULL').run(new Date(Date.now() - 366 * 86_400_000).toISOString());
  assert.deepEqual(tx(s.db, () => autoReleaseDeferred(s.db, cfg)), [{ account: D.id, released: 475, lots: 1 }]);
  assert.equal((await s.api('GET', '/v1/me', null, D.api_key)).data.deferred, 0);
});
