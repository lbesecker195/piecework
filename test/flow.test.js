import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, q } from '../src/db.js';
import { createApp } from '../src/app.js';
import { dispatch, sweepTimeouts } from '../src/dispatch.js';
import { autoReleaseDeferred } from '../src/ledger.js';
import { tx } from '../src/util.js';
import { config } from '../src/config.js';

const GM = 'gm-test-key';
const OWNER = 'owner-test-key';
const cfg = { ...config, testMode: true, gitMasterKey: GM, ownerKey: OWNER, ssaUid: 'acct_test', telemetryMinGapMs: 0, minStake: 100, minBounty: 10, faucetSats: 10000, turnaroundMin: 10, maxWorkersPerOperator: 1 };
const REPO = 'https://github.com/octo/demo';

async function start() {
  const db = openDb(':memory:');
  const pings = [];
  const analytics = { enabled: true, ping: (event, params) => { pings.push({ event, ...params }); return true; } };
  const app = createApp({ db, cfg, analytics });
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
  const integrate = async (R, repo_url = REPO) => {
    const req = await api('POST', '/v1/projects', { repo_url, description: 'A demo CLI; 5 tasks at ~1000 sats' }, R.api_key);
    if (req.status === 201) await api('POST', `/v1/admin/projects/${req.data.id}/approve`, { reason: 'looks real' }, GM);
  };
  const post = async (R, bounty, max_bounty) => {
    await integrate(R);
    return (await api('POST', '/v1/tasks', { repo_url: REPO, title: 'Add a flag', body: 'Add --dry-run to the CLI', bounty, max_bounty }, R.api_key)).data;
  };
  const expireActive = () => db.prepare("UPDATE assignments SET expires_at = ? WHERE status = 'active'").run(new Date(Date.now() - 1000).toISOString());
  return { db, api, account, fund, post, integrate, expireActive, pings, close: () => new Promise((r) => server.close(r)) };
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
  assert.equal((await s.api('GET', '/admin')).status, 403);
  assert.equal((await s.api('GET', '/review', null, GM)).status, 302);
  assert.match((await s.api('GET', '/admin', null, GM)).data, /Git Master/);
  assert.match((await s.api('GET', '/admin', null, OWNER)).data, /Owner/);
  assert.equal((await s.api('GET', '/feed')).status, 200);
  assert.match((await s.api('GET', '/feed.xml')).data, /<rss/);
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

test('projects must be approved before tasks; only the owner posts', async (t) => {
  const s = await start(); t.after(s.close);
  const R = await s.account('requester', 'ada');
  const R2 = await s.account('requester', 'bob');
  await s.fund(R); await s.fund(R2);
  const blocked = await s.api('POST', '/v1/tasks', { repo_url: REPO, title: 'x', body: 'y', bounty: 500 }, R.api_key);
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.error, /not an approved project/);
  const req = await s.api('POST', '/v1/projects', { repo_url: REPO, description: 'demo' }, R.api_key);
  assert.equal(req.status, 201);
  assert.equal(req.data.status, 'pending');
  assert.equal((await s.api('POST', '/v1/projects', { repo_url: REPO, description: 'dup' }, R2.api_key)).status, 409);
  assert.equal((await s.api('POST', '/v1/tasks', { repo_url: REPO, title: 'x', body: 'y', bounty: 500 }, R.api_key)).status, 400);
  assert.equal((await s.api('GET', '/v1/admin/projects', null, GM)).data.length, 1);
  assert.equal((await s.api('POST', `/v1/admin/projects/${req.data.id}/approve`, { reason: 'real repo' }, R.api_key)).status, 403);
  const approved = await s.api('POST', `/v1/admin/projects/${req.data.id}/approve`, { reason: 'real repo' }, GM);
  assert.equal(approved.data.status, 'approved');
  assert.equal((await s.api('POST', `/v1/admin/projects/${req.data.id}/approve`, null, GM)).status, 409);
  assert.equal((await s.api('POST', '/v1/tasks', { repo_url: REPO, title: 'x', body: 'y', bounty: 500 }, R2.api_key)).status, 403);
  assert.equal((await s.api('POST', '/v1/tasks', { repo_url: REPO, title: 'x', body: 'y', bounty: 500 }, R.api_key)).status, 201);
  const listed = (await s.api('GET', '/v1/projects')).data;
  assert.deepEqual([listed.length, listed[0].repo, listed[0].live_tasks], [1, 'octo/demo', 1]);
  assert.equal((await s.api('GET', '/projects')).status, 200);
  assert.match((await s.api('GET', '/admin', null, GM)).data, /awaiting a yes/);
});

test('payments queue: Git Master proposes, only the Owner approves; feed records it', async (t) => {
  const s = await start(); t.after(s.close);
  const R = await s.account('requester', 'ada');
  const W = await s.account('worker', 'omega', 'op-w');
  await s.fund(W);
  assert.equal((await s.api('POST', '/v1/me/settings', { payout_address: 'not-an-address' }, W.api_key)).status, 400);
  assert.equal((await s.api('POST', '/v1/me/settings', { payout_address: 'omega@getalby.com' }, W.api_key)).data.payout_address, 'omega@getalby.com');
  const withdrawal = await s.api('POST', '/v1/withdraw', { sats: 3000 }, W.api_key);
  assert.deepEqual([withdrawal.status, withdrawal.data.balance], [200, 7000]);

  assert.deepEqual((await s.api('GET', '/v1/admin/whoami', null, GM)).data, { role: 'gitmaster' });
  assert.deepEqual((await s.api('GET', '/v1/admin/whoami', null, OWNER)).data, { role: 'owner' });
  const pending = (await s.api('GET', '/v1/admin/withdrawals', null, GM)).data;
  assert.deepEqual([pending.length, pending[0].sats, pending[0].payout_address, pending[0].payment_id], [1, 3000, 'omega@getalby.com', null]);

  const queued = await s.api('POST', '/v1/admin/payments', { kind: 'payout', withdrawal_id: pending[0].id }, GM);
  assert.deepEqual([queued.status, queued.data.status, queued.data.proposed_by, queued.data.address], [201, 'queued', 'gitmaster', 'omega@getalby.com']);
  assert.equal((await s.api('POST', '/v1/admin/payments', { kind: 'payout', withdrawal_id: pending[0].id }, GM)).status, 409);
  assert.equal((await s.api('POST', `/v1/admin/payments/${queued.data.id}/approve`, { ref: 'x' }, GM)).status, 403);
  assert.equal((await s.api('POST', `/v1/admin/payments/${queued.data.id}/approve`, { ref: 'x' }, W.api_key)).status, 403);
  const approved = await s.api('POST', `/v1/admin/payments/${queued.data.id}/approve`, { ref: 'lnbc-hash-123' }, OWNER);
  assert.deepEqual([approved.status, approved.data.status, approved.data.decided_by, approved.data.ref], [200, 'approved', 'owner', 'lnbc-hash-123']);
  assert.equal((await s.api('GET', '/v1/admin/withdrawals', null, GM)).data.length, 0);
  const ledger = (await s.api('GET', '/v1/ledger', null, W.api_key)).data;
  assert.match(ledger.find((l) => l.kind === 'withdrawal').memo, /^paid .*lnbc-hash-123/);

  // A credit: proposed by the Git Master, landed by the Owner.
  const credit = await s.api('POST', '/v1/admin/payments', { kind: 'credit', account: 'ada', sats: 5000, memo: 'invoice 42' }, GM);
  assert.equal(credit.status, 201);
  assert.equal((await s.api('GET', '/v1/me', null, R.api_key)).data.balance, 0);
  await s.api('POST', `/v1/admin/payments/${credit.data.id}/approve`, { ref: 'settled' }, OWNER);
  assert.equal((await s.api('GET', '/v1/me', null, R.api_key)).data.balance, 5000);

  // A rejected payout returns the sats.
  await s.api('POST', '/v1/withdraw', { sats: 1000 }, W.api_key);
  const second = (await s.api('GET', '/v1/admin/withdrawals', null, GM)).data[0];
  const q2 = (await s.api('POST', '/v1/admin/payments', { kind: 'payout', withdrawal_id: second.id }, GM)).data;
  const rejected = await s.api('POST', `/v1/admin/payments/${q2.id}/reject`, { reason: 'address bounced' }, OWNER);
  assert.equal(rejected.data.status, 'rejected');
  assert.equal((await s.api('GET', '/v1/me', null, W.api_key)).data.balance, 7000);
  assert.equal((await s.api('GET', '/v1/admin/payments?status=queued', null, GM)).data.length, 0);
  assert.equal((await s.api('GET', '/v1/admin/payments?status=approved', null, GM)).data.length, 2);

  const kinds = (await s.api('GET', '/v1/feed')).data.map((e) => e.kind);
  for (const kind of ['payout', 'deposit']) assert.ok(kinds.includes(kind), `feed has ${kind}`);
  assert.match((await s.api('GET', '/admin', null, OWNER)).data, /Payment history/);
});

test('the feed narrates the task lifecycle', async (t) => {
  const s = await start(); t.after(s.close);
  const R = await s.account('requester', 'ada');
  const A = await s.account('worker', 'alpha', 'op-a');
  await s.fund(R); await s.fund(A);
  await s.api('POST', '/v1/queue/join', { stake: 100 }, A.api_key);
  const task = await s.post(R, 1000);
  dispatch(s.db, cfg, () => 0.99);
  const cur = (await s.api('GET', '/v1/assignments/current', null, A.api_key)).data;
  await s.api('POST', cur.submit.url, { pr_url: `${REPO}/pull/9` }, A.api_key);
  await s.api('POST', `/v1/tasks/${task.id}/judge`, { verdict: 'accept', reason: 'good' }, GM);
  const kinds = (await s.api('GET', '/v1/feed')).data.map((e) => e.kind).reverse();
  assert.deepEqual(kinds, ['queue_joined', 'project_requested', 'project_approved', 'task_posted', 'assigned', 'submitted', 'accepted']);
  assert.match((await s.api('GET', '/')).data, /Live feed/);
});

test('telemetry: vocabulary, rate gap, reporting flag, judge-first ordering, analytics forwarding', async (t) => {
  const s = await start(); t.after(s.close);
  const R = await s.account('requester', 'ada');
  const A = await s.account('worker', 'alpha', 'op-a');
  const B = await s.account('worker', 'beta', 'op-b');
  for (const acc of [R, A, B]) await s.fund(acc);
  await s.api('POST', '/v1/queue/join', { stake: 100 }, A.api_key);
  await s.api('POST', '/v1/queue/join', { stake: 100 }, B.api_key);
  const t1 = await s.post(R, 1000);
  const t2 = await s.post(R, 1000);
  dispatch(s.db, cfg, () => 0.99);                       // t1 -> A, t2 -> B
  assert.equal((await s.api('GET', '/v1/telemetry/events')).data.reporting_threshold, 2);
  assert.equal((await s.api('POST', '/v1/telemetry', { event: 'dancing' }, A.api_key)).status, 400);
  assert.equal((await s.api('POST', '/v1/telemetry', { event: 'started' }, R.api_key)).status, 403);
  const first = await s.api('POST', '/v1/telemetry', { event: 'started', note: 'cloning   octo/demo' }, A.api_key);
  assert.deepEqual([first.status, first.data.reporting, first.data.events_on_assignment], [201, false, 1]);
  const second = await s.api('POST', '/v1/telemetry', { event: 'pr_opened' }, A.api_key);
  assert.deepEqual([second.status, second.data.reporting], [201, true]);
  // A telemetry event cannot be posted against someone else's assignment.
  const bAssignment = (await s.api('GET', '/v1/assignments/current', null, B.api_key)).data;
  assert.equal((await s.api('POST', '/v1/telemetry', { event: 'started', assignment_id: bAssignment.id }, A.api_key)).status, 404);
  // B (silent) submits first; A (reporting) submits second; A is judged first.
  await s.api('POST', bAssignment.submit.url, { pr_url: `${REPO}/pull/2` }, B.api_key);
  const aAssignment = (await s.api('GET', '/v1/me', null, A.api_key)).data.assignment;
  await s.api('POST', aAssignment.submit.url, { pr_url: `${REPO}/pull/1` }, A.api_key);
  const review = (await s.api('GET', '/v1/review', null, GM)).data;
  assert.deepEqual(review.map((r) => [r.worker, Boolean(r.reporting)]), [['alpha', true], ['beta', false]]);
  const task = (await s.api('GET', `/v1/tasks/${t1.id}`)).data;
  assert.deepEqual(task.assignments[0].telemetry.map((e) => e.event), ['started', 'pr_opened']);
  assert.equal(task.assignments[0].telemetry[0].note, 'cloning octo/demo');
  assert.ok((await s.api('GET', '/')).data.includes('📡'));
  // Analytics saw the feed events and the worker telemetry, with ids only.
  const events = s.pings.map((p) => p.event);
  for (const e of ['task_posted', 'assigned', 'worker_started', 'worker_pr_opened', 'submitted']) assert.ok(events.includes(e), `pinged ${e}`);
  const workerPing = s.pings.find((p) => p.event === 'worker_started');
  assert.equal(workerPing.project, 'piecework-workers');
  assert.equal(workerPing.sid, `assignment-${aAssignment.id}`);
  assert.ok(!JSON.stringify(s.pings).includes(A.api_key));
  assert.ok(!JSON.stringify(s.pings).includes('alpha'));
  // Tracker tag on public pages, never on admin or account pages.
  assert.match((await s.api('GET', '/')).data, /wa\.js" data-site="acct_test" data-forms="false"/);
  assert.doesNotMatch((await s.api('GET', '/admin', null, GM)).data, /wa\.js/);
  assert.match((await s.api('GET', '/llms.txt')).data, /seriouslysimpleanalytics/i);
});

test('telemetry rate gap is enforced', async (t) => {
  const s0 = await start(); t.after(s0.close);
  // Rebuild with a real gap for this test only.
  const gapped = { ...cfg, telemetryMinGapMs: 60_000 };
  const db = openDb(':memory:');
  const app = createApp({ db, cfg: gapped, analytics: { enabled: false, ping: () => false } });
  const server = await new Promise((resolve) => { const srv = app.listen(0, '127.0.0.1', () => resolve(srv)); });
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, key) => {
    const headers = { 'Content-Type': 'application/json' }; if (key) headers.Authorization = `Bearer ${key}`;
    const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json().catch(() => null), retry: res.headers.get('retry-after') };
  };
  const R = (await call('POST', '/v1/accounts', { kind: 'requester', name: 'ada' })).data;
  const W = (await call('POST', '/v1/accounts', { kind: 'worker', name: 'worker-w', operator: 'op' })).data;
  await call('POST', '/v1/faucet', null, R.api_key); await call('POST', '/v1/faucet', null, W.api_key);
  await call('POST', '/v1/queue/join', { stake: 100 }, W.api_key);
  const proj = (await call('POST', '/v1/projects', { repo_url: REPO, description: 'd' }, R.api_key)).data;
  await call('POST', `/v1/admin/projects/${proj.id}/approve`, {}, GM);
  await call('POST', '/v1/tasks', { repo_url: REPO, title: 'x', body: 'y', bounty: 500 }, R.api_key);
  dispatch(db, gapped, () => 0.99);
  assert.equal((await call('POST', '/v1/telemetry', { event: 'started' }, W.api_key)).status, 201);
  const limited = await call('POST', '/v1/telemetry', { event: 'pr_opened' }, W.api_key);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.retry) >= 1);
});

test('house accounts are labelled', async (t) => {
  const s = await start(); t.after(s.close);
  const H = await s.account('worker', 'house-1', 'lbesecker195');
  await s.fund(H);
  await s.api('POST', '/v1/queue/join', { stake: 100 }, H.api_key);
  assert.equal((await s.api('POST', '/v1/admin/accounts/house-1/house', { house: 1 }, H.api_key)).status, 403);
  const flagged = await s.api('POST', '/v1/admin/accounts/house-1/house', { house: 1 }, GM);
  assert.deepEqual([flagged.status, flagged.data.house], [200, 1]);
  assert.match((await s.api('GET', '/')).data, /operated by the platform/);
  assert.equal((await s.api('POST', '/v1/admin/accounts/nobody/house', { house: 1 }, GM)).status, 404);
});
