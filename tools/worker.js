#!/usr/bin/env node
/**
 * Worker-side CLI, used by the house worker (deploy/worker-pass.sh) and handy for any agent.
 *
 *   worker.js register <name> <operator>   create a worker account; prints WORKER_KEY=... once
 *   worker.js me                            account + current assignment
 *   worker.js join [stake]                  sit in the queue
 *   worker.js ensure-joined                 join if not seated and the balance covers the stake; never fails
 *   worker.js current                       print the active assignment as JSON; exit 3 if none
 *   worker.js telemetry <event> [note]      started · repo_cloned · tests_passed · tests_failed · pr_opened · blocked · declining · finished
 *   worker.js submit <pr_url>
 *   worker.js decline
 *   worker.js defer <0|50>                  route half of every payout to the deferred balance
 *
 * Env: PIECEWORK_URL (default http://localhost:4020), WORKER_KEY
 */
const url = (process.env.PIECEWORK_URL || 'http://localhost:4020').replace(/\/$/, '');
const key = process.env.WORKER_KEY;
const [command = 'me', a1, ...rest] = process.argv.slice(2);

async function call(method, path, body, auth = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) { if (!key) { console.error('WORKER_KEY is not set'); process.exit(2); } headers.Authorization = `Bearer ${key}`; }
  let response;
  try { response = await fetch(url + path, { method, headers, body: body ? JSON.stringify(body) : undefined }); }
  catch (error) { console.error(`cannot reach ${url}: ${error.cause?.code || error.message}`); process.exit(4); }
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { console.error(`${response.status}: ${data.error || response.statusText}`); process.exit(1); }
  return data;
}

const commands = {
  async register() {
    if (!a1 || !rest[0]) { console.error('usage: register <name> <operator-github-handle>'); process.exit(2); }
    const acc = await call('POST', '/v1/accounts', { kind: 'worker', name: a1, operator: rest[0], github: rest[1] || rest[0] }, false);
    console.log(`WORKER_KEY=${acc.api_key}`);
  },
  async me() { console.log(JSON.stringify(await call('GET', '/v1/me'), null, 2)); },
  async join() { const info = await call('GET', '/v1', null, false); const r = await call('POST', '/v1/queue/join', { stake: Number(a1 || info.min_stake) }); console.log(`in queue with ${r.stake} sats staked`); },
  async 'ensure-joined'() {
    const me = await call('GET', '/v1/me');
    if (me.in_queue) { console.log('seated'); return; }
    const info = await call('GET', '/v1', null, false);
    if (me.balance < info.min_stake) { console.log(`not seated: balance ${me.balance} < stake ${info.min_stake}`); return; }
    const r = await fetch(url + '/v1/queue/join', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ stake: info.min_stake }) });
    console.log(r.ok ? `joined with ${info.min_stake} sats staked` : `join refused: ${(await r.json().catch(() => ({}))).error || r.status}`);
  },
  async current() {
    const me = await call('GET', '/v1/me');
    if (!me.assignment) { process.exit(3); }
    console.log(JSON.stringify(me.assignment, null, 2));
  },
  async telemetry() { if (!a1) { console.error('event required'); process.exit(2); } const r = await call('POST', '/v1/telemetry', { event: a1, note: rest.join(' ') || undefined }); console.log(`${r.recorded} · ${r.reporting ? 'reporting' : 'not yet reporting'}`); },
  async submit() {
    if (!a1) { console.error('pr_url required'); process.exit(2); }
    const me = await call('GET', '/v1/me'); if (!me.assignment) { console.error('no active assignment'); process.exit(3); }
    const r = await call('POST', me.assignment.submit.url, { pr_url: a1 }); console.log(`submitted; task #${r.task.id} is ${r.task.status}`);
  },
  async decline() { const me = await call('GET', '/v1/me'); if (!me.assignment) { console.error('no active assignment'); process.exit(3); } await call('POST', me.assignment.decline.url); console.log('declined'); },
  async defer() { const r = await call('POST', '/v1/me/settings', { defer_pct: Number(a1) }); console.log(`defer_pct=${r.defer_pct}`); },
};
if (!commands[command]) { console.error('unknown command'); process.exit(2); }
await commands[command]();
