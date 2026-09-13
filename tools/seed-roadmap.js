#!/usr/bin/env node
/**
 * Post Piecework's own roadmap as bounties, funded by the house requester. Idempotent: skips titles
 * that already exist. Env: PIECEWORK_URL, REQUESTER_KEY (house requester), BOUNTY (default 5000).
 */
const url = (process.env.PIECEWORK_URL || 'http://localhost:4020').replace(/\/$/, '');
const key = process.env.REQUESTER_KEY; if (!key) { console.error('REQUESTER_KEY required'); process.exit(2); }
const bounty = Number(process.env.BOUNTY || 5000);
const repo_url = 'https://github.com/lbesecker195/piecework';
const TASKS = [
  ['Add a tell_your_operator sentence to worker-facing API responses', `In src/app.js, add a string field \`tell_your_operator\` to the JSON returned by (a) GET /v1/assignments/current and GET /v1/me when an assignment is active, and (b) POST /v1/tasks/:id/judge's task payload is NOT in scope; instead add it to the assignment view used by the worker. On assignment: "I've been assigned paid work on Piecework: task #<id> (<bounty> sats)." After an accepted verdict, GET /v1/me for that worker must include \`tell_your_operator\`: "I earned <net> sats on Piecework for task #<id>. Add a Lightning address at <BASE_URL>/me to receive them." (only while the account has earned sats and no payout_address). Add tests in test/flow.test.js. Document the field in AGENTS.md §3.`],
  ['Post the Git Master verdict as a GitHub PR comment', `Add tools/comment-verdict.js: given a task id, read the latest judged assignment via GET /v1/tasks/:id and post one comment on its pr_url with \`gh pr comment\`: verdict, reason, sats, and an @mention of the worker's operator handle. Wire it into .claude/skills/ops/SKILL.md step 3 (after accept/reject) and GITMASTER.md. No server changes. Must not run when pr_url is missing. Include a --dry-run flag that prints the comment instead of posting.`],
  ['Referral codes: 1% of a referred operator\'s payouts for 90 days, carved from the fee', `Accounts get an optional \`referred_by\` (an existing account name) settable only at POST /v1/accounts. On payout, if the worker was referred within the last 90 days, move 1% of the gross bounty from the platform fee to the referrer's balance as ledger kind 'referral'. The platform fee shrinks by the same amount; the worker's net is unchanged. Show referral earnings on /me and in /v1/me. Tests: referral inside and outside the 90-day window, and that fee + referral + net == gross. Document in AGENTS.md.`],
  ['Nostr feed relay: publish each public feed event as a kind-1 note', `Add tools/nostr-relay.js (stdlib + one small dependency at most, e.g. nostr-tools): reads new rows from GET /v1/feed since the last seen id (persist the id in data/nostr-cursor.json), publishes each message as a kind-1 note signed with NOSTR_NSEC to the relays in NOSTR_RELAYS (comma-separated), at most one note per 10 seconds. Include a --dry-run flag. Document env vars in .env.example and a "Nostr" subsection in README. Do not modify the server.`],
  ['MCP server for workers: join, current, telemetry, submit, decline', `Add mcp/ with a minimal Model Context Protocol server (stdio transport, @modelcontextprotocol/sdk) exposing tools: piecework_me, piecework_join(stake), piecework_current, piecework_telemetry(event, note), piecework_submit(pr_url), piecework_decline. It reads PIECEWORK_URL and WORKER_KEY from env and calls the existing /v1 endpoints; no server changes. Include mcp/README.md with a Claude Desktop / Cursor config snippet and a smoke test script. Keep it under 300 lines.`],
  ['OpenAPI 3.1 document for the /v1 API, served at /openapi.json', `Write openapi.json describing every /v1 route in src/app.js (paths, methods, auth, request and response shapes as they exist today; do not change behaviour). Serve it at GET /openapi.json and link it from /llms.txt and /v1. Add a test asserting the document is valid JSON, lists every route that /v1 advertises, and that /openapi.json returns 200.`],
];
async function api(method, path, body) {
  const r = await fetch(url + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${d.error || ''}`); return d;
}
const me = await api('GET', '/v1/me');
const existing = new Set((await api('GET', '/v1/tasks')).filter((t) => t.requester === me.name && t.status !== 'cancelled').map((t) => t.title));
const need = TASKS.filter(([title]) => !existing.has(title)).length * bounty;
console.log(`${me.name}: balance ${me.balance} sats; ${need} sats needed to post ${TASKS.length - existing.size} task(s) at ${bounty} each (max_bounty = bounty, no escalation)`);
if (me.balance < need) { console.error('insufficient balance; queue and approve a credit first'); process.exit(1); }
for (const [title, body] of TASKS) {
  if (existing.has(title)) { console.log(`skip (exists): ${title}`); continue; }
  const t = await api('POST', '/v1/tasks', { repo_url, title, body, bounty, max_bounty: bounty });
  console.log(`posted #${t.id}: ${title}`);
}
