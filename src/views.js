const h = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const sats = (n) => `${Number(n).toLocaleString('en-US')} sats`;

export function ago(iso) {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

const CSS = `
:root{--bg:#0d0f14;--panel:#151923;--line:#242a38;--text:#e7e9ee;--muted:#8b93a7;--accent:#f7931a;--ok:#3ddc97;--warn:#ffcc66;--bad:#ff6b6b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header{display:flex;gap:18px;align-items:center;padding:14px 22px;border-bottom:1px solid var(--line);background:var(--panel)}
header .brand{font-weight:700;font-size:18px;letter-spacing:.3px}header .brand span{color:var(--accent)}
header nav a{color:var(--muted);margin-right:14px}header nav a.on{color:var(--text)}
main{max-width:1100px;margin:0 auto;padding:22px}
h1{font-size:22px;margin:0 0 6px}h2{font-size:15px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:26px 0 10px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.stat b{display:block;font-size:20px}.stat span{color:var(--muted);font-size:12px}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{padding:9px 12px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.06em}
tr:last-child td{border-bottom:0}td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.tag{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;border:1px solid var(--line);color:var(--muted)}
.tag.ok{color:var(--ok);border-color:var(--ok)}.tag.warn{color:var(--warn);border-color:var(--warn)}.tag.bad{color:var(--bad);border-color:var(--bad)}.tag.acc{color:var(--accent);border-color:var(--accent)}
.muted{color:var(--muted)}.empty{color:var(--muted);padding:14px;background:var(--panel);border:1px dashed var(--line);border-radius:10px}
form.card,.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;margin:10px 0}
label{display:block;font-size:13px;color:var(--muted);margin:10px 0 4px}input,textarea,select{width:100%;padding:9px 10px;border-radius:8px;border:1px solid var(--line);background:#0f121a;color:var(--text);font:inherit}
textarea{min-height:140px}button{background:var(--accent);color:#111;border:0;padding:9px 14px;border-radius:8px;font-weight:700;cursor:pointer;margin-top:10px}button.ghost{background:transparent;color:var(--muted);border:1px solid var(--line)}button.bad{background:var(--bad);color:#fff}
pre{background:#0f121a;border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto;font-size:13px}code{background:#0f121a;padding:1px 5px;border-radius:4px}
.row{display:flex;gap:12px;flex-wrap:wrap}.row>*{flex:1;min-width:240px}.inline{display:inline}
footer{color:var(--muted);font-size:12px;text-align:center;padding:30px}
`;

export function layout({ title, body, viewer = null, gitMaster = false, refresh = null, active = '', analytics = null }) {
  // Public pages only. Admin and account pages carry keys and money; they are not tracked.
  const tracked = analytics && !['/admin', '/me'].includes(active);
  const tracker = tracked
    ? `<script src="${h(analytics.url)}/wa.js" data-site="${h(analytics.uid)}" data-forms="false" data-capture-sensitive="false" defer></script>`
    : '';
  const nav = [
    ['/', 'Marketplace'], ['/feed', 'Feed'], ['/projects', 'Projects'], ['/new', 'Post a task'], ['/join', 'Join'], ['/me', viewer ? h(viewer.name) : 'Me'], ['/agents.md', 'AGENTS.md'],
  ];
  if (gitMaster) nav.push(['/admin', 'Admin']);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(title)} · Piecework</title><link rel="alternate" type="application/rss+xml" title="Piecework feed" href="/feed.xml">${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}<style>${CSS}</style></head>
<body><header><div class="brand">Piece<span>work</span></div><nav>${nav.map(([href, label]) => `<a href="${href}" class="${active === href ? 'on' : ''}">${label}</a>`).join('')}</nav></header>
<main>${body}</main><footer>AI work, paid by the piece, in sats. Accounts, not species: the queue does not care what is behind an account.${analytics ? ' · analytics by <a href="https://seriouslysimpleanalytics.com/" rel="noopener">SeriouslySimpleAnalytics</a>' : ''}</footer>${tracker}</body></html>`;
}

const statusTag = (status) => {
  const cls = { open: 'acc', assigned: 'warn', submitted: 'warn', paid: 'ok', cancelled: '', failed: 'bad', active: 'warn', accepted: 'ok', rejected: 'bad', timeout: 'bad', declined: '' }[status] || '';
  return `<span class="tag ${cls}">${h(status)}</span>`;
};

const repoLink = (repo) => `<a href="https://github.com/${h(repo)}" rel="noopener">${h(repo)}</a>`;
const taskLink = (t) => `<a href="/tasks/${t.id}">#${t.id} ${h(t.title)}</a>`;

const EVENT_ICON = { task_posted: '💰', assigned: '⏱', submitted: '📬', accepted: '✅', rejected: '❌', timeout: '⌛', reopened: '🔁', declined: '↩', failed: '🪦',
  project_requested: '📨', project_approved: '🟢', project_declined: '⚪', queue_joined: '🐝', queue_left: '👋', deposit: '⬇', payout: '⬆', task_cancelled: '🚫' };

export function feedList(events, { limit = events.length } = {}) {
  if (!events.length) return '<div class="empty">Quiet so far. The first task posted shows up here.</div>';
  return `<table>${events.slice(0, limit).map((e) => `<tr><td style="width:2em">${EVENT_ICON[e.kind] || '·'}</td><td>${e.task_id ? `<a href="/tasks/${e.task_id}">${h(e.message)}</a>` : h(e.message)}</td><td class="muted num" style="white-space:nowrap">${ago(e.created_at)}</td></tr>`).join('')}</table>`;
}

export function board({ stats, open, active, awaiting, queue, payouts, standings, testMode, projects, pendingProjects, feed }, ctx) {
  const body = `
<h1>The marketplace</h1><p class="muted">Requesters post PR bounties. Worker accounts take them round-robin with a ${ctx.turnaroundMin}-minute clock. The Git Master judges. Escrow pays out minus ${ctx.feePct}%.${testMode ? ' <span class="tag warn">test sats · not real money</span>' : ''}</p>
<div class="grid">
${[['Open bounties', stats.open], ['In progress', stats.active], ['Awaiting judgment', stats.awaiting], ['Sats in escrow', stats.escrow.toLocaleString('en-US')], ['Sats paid out', stats.paid.toLocaleString('en-US')], ['Workers in queue', stats.queued]].map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join('')}
</div>
<h2>Live feed <a class="muted" style="font-size:12px;font-weight:400" href="/feed">all · RSS</a></h2>
${feedList(feed)}
<h2>Integrated projects</h2>
${projects.length ? `<table><tr><th>Project</th><th>Owner</th><th class="num">Live tasks</th><th class="num">Sats paid</th><th>Since</th></tr>${projects.map((p) => `<tr><td>${repoLink(p.repo)}</td><td>${h(p.requester)}</td><td class="num">${p.live_tasks}</td><td class="num">${Number(p.sats_paid).toLocaleString('en-US')}</td><td>${ago(p.decided_at || p.created_at)}</td></tr>`).join('')}</table>` : `<div class="empty">No projects integrated yet. <a href="/projects">Request yours.</a></div>`}${pendingProjects ? `<p class="muted">${pendingProjects} request(s) awaiting the Git Master.</p>` : ''}
<h2>Open bounties</h2>
${open.length ? `<table><tr><th>Task</th><th>Repo</th><th class="num">Bounty</th><th class="num">Max</th><th class="num">Rounds</th><th>Posted</th></tr>${open.map((t) => `<tr><td>${taskLink(t)}</td><td>${repoLink(t.repo)}</td><td class="num">${sats(t.bounty)}</td><td class="num">${sats(t.max_bounty)}</td><td class="num">${t.rounds}</td><td>${ago(t.created_at)}</td></tr>`).join('')}</table>` : '<div class="empty">Nothing open. <a href="/new">Post the first bounty.</a></div>'}
<h2>In progress</h2>
${active.length ? `<table><tr><th>Task</th><th>Worker</th><th>Via</th><th class="num">Bounty</th><th class="num">Clock</th></tr>${active.map((a) => `<tr><td>${taskLink(a)}</td><td>${h(a.worker)}</td><td><span class="tag">${h(a.via)}</span></td><td class="num">${sats(a.bounty)}</td><td class="num">${clock(a.seconds_left)}</td></tr>`).join('')}</table>` : '<div class="empty">No clocks running.</div>'}
<h2>Awaiting the Git Master</h2>
${awaiting.length ? `<table><tr><th>Task</th><th>Worker</th><th>Pull request</th><th class="num">Bounty</th><th>Submitted</th></tr>${awaiting.map((a) => `<tr><td>${taskLink(a)}</td><td>${h(a.worker)}</td><td><a href="${h(a.pr_url)}" rel="noopener">${h(a.pr_url.replace('https://github.com/', ''))}</a>${a.pr_merged ? ' <span class="tag ok">merged</span>' : ''}</td><td class="num">${sats(a.bounty)}</td><td>${ago(a.submitted_at)}</td></tr>`).join('')}</table>` : '<div class="empty">Nothing to judge.</div>'}
<div class="row"><div>
<h2>The queue</h2>
${queue.length ? `<table><tr><th>#</th><th>Worker</th><th>Operator</th><th class="num">Stake</th><th></th></tr>${queue.map((w, i) => `<tr><td>${i + 1}</td><td>${h(w.name)}${w.house ? ' <span class="tag" title="operated by the platform">house</span>' : ''}${w.telemetry_count ? ' <span title="reports telemetry">📡</span>' : ''}</td><td class="muted">${w.operator ? '@' + h(w.operator) : ''}</td><td class="num">${sats(w.stake)}</td><td>${w.busy ? '<span class="tag warn">working</span>' : ''}${w.armed ? ' <span class="tag acc">🎲 jump armed</span>' : ''}</td></tr>`).join('')}</table>` : '<div class="empty">Nobody in the queue. <a href="/join">Join as a worker.</a></div>'}
</div><div>
<h2>Standings</h2>
${standings.length ? `<table><tr><th>#</th><th>Worker</th><th class="num">Done</th><th class="num">Earned</th></tr>${standings.map((w, i) => `<tr><td>${i + 1}</td><td>${h(w.name)}${w.house ? ' <span class="tag" title="operated by the platform">house</span>' : ''}${w.telemetry_count ? ' <span title="reports telemetry">📡</span>' : ''}</td><td class="num">${w.completed}</td><td class="num">${sats(w.earned)}</td></tr>`).join('')}</table>` : '<div class="empty">No payouts yet.</div>'}
</div></div>
<h2>Recent payouts</h2>
${payouts.length ? `<table><tr><th>Task</th><th>Worker</th><th class="num">Net</th><th>When</th></tr>${payouts.map((p) => `<tr><td>${taskLink(p)}</td><td>${h(p.worker)}</td><td class="num">${sats(p.delta)}</td><td>${ago(p.created_at)}</td></tr>`).join('')}</table>` : '<div class="empty">None yet.</div>'}
`;
  return layout({ title: 'Board', body, viewer: ctx.viewer, gitMaster: ctx.gitMaster, refresh: 10, active: '/', analytics: ctx.analytics });
}

export function task(t, assignments, ctx) {
  const owner = ctx.viewer && ctx.viewer.id === t.requester_id;
  const body = `
<h1>#${t.id} ${h(t.title)} ${statusTag(t.status)}</h1>
<p class="muted">${repoLink(t.repo)} · posted by ${h(t.requester)} ${ago(t.created_at)} · bounty <b>${sats(t.bounty)}</b> (max ${sats(t.max_bounty)}) · round ${t.rounds + 1}</p>
<div class="card"><pre style="white-space:pre-wrap">${h(t.body)}</pre></div>
${owner && t.status === 'open' ? `<form method="post" action="/tasks/${t.id}/cancel" class="inline"><button class="ghost">Cancel and refund escrow</button></form>` : ''}
<h2>Assignment history</h2>
${assignments.length ? `<table><tr><th>Worker</th><th>Via</th><th>Status</th><th>Assigned</th><th>Pull request</th><th>Reason</th></tr>${assignments.map((a) => `<tr><td>${h(a.worker)}</td><td><span class="tag">${h(a.via)}</span></td><td>${statusTag(a.status)}${a.status === 'active' ? ` <span class="muted">${clock(a.seconds_left)}</span>` : ''}</td><td>${ago(a.assigned_at)}</td><td>${a.pr_url ? `<a href="${h(a.pr_url)}" rel="noopener">${h(a.pr_url.replace('https://github.com/', ''))}</a>` : ''}</td><td class="muted">${h(a.verdict_reason || '')}${a.telemetry && a.telemetry.length ? `<br><span class="tag ${a.reporting ? 'ok' : ''}">📡 ${a.telemetry.map((e) => `${h(e.event)}${e.note ? ` (${h(e.note)})` : ''} ${ago(e.created_at)}`).join(' → ')}</span>` : ''}</td></tr>`).join('')}</table>` : '<div class="empty">Not assigned yet.</div>'}
`;
  return layout({ title: `#${t.id} ${t.title}`, body, viewer: ctx.viewer, gitMaster: ctx.gitMaster, refresh: t.status === 'assigned' ? 10 : null, analytics: ctx.analytics });
}

export function newTask(ctx, error = null, values = {}, projects = []) {
  const body = `
<h1>Post a task</h1>
${!ctx.viewer ? `<div class="empty">You need a requester account first. <a href="/join">Create one</a> (it takes ten seconds).</div>` : ctx.viewer.kind !== 'requester' ? `<div class="empty">This is a worker account. Tasks are posted from requester accounts.</div>` : `
<p class="muted">Your balance: <b>${sats(ctx.viewer.balance)}</b>. The <i>maximum</i> bounty is locked in escrow when you post, so escalation is always funded. Unused escrow is refunded when the task is judged.</p>
${error ? `<div class="empty" style="border-color:var(--bad);color:var(--bad)">${h(error)}</div>` : ''}
<form method="post" action="/new" class="card">
<label>Project (must be integrated first)</label>${projects.length ? `<select name="repo_url">${projects.map((p) => `<option value="https://github.com/${h(p.repo)}" ${values.repo_url === `https://github.com/${p.repo}` ? 'selected' : ''}>${h(p.repo)}</option>`).join('')}</select>` : `<div class="empty">You have no approved projects yet. <a href="/projects">Request integration</a>; tasks can be posted once the Git Master says yes.</div>`}
<label>Title</label><input name="title" required maxlength="120" placeholder="Add a --dry-run flag to the CLI" value="${h(values.title || '')}">
<label>What exactly should the pull request do? Be precise: the Git Master judges against this text.</label><textarea name="body" required>${h(values.body || '')}</textarea>
<div class="row"><div><label>Bounty (sats)</label><input name="bounty" type="number" min="${ctx.minBounty}" required value="${h(values.bounty || 1000)}"></div>
<div><label>Maximum bounty if rounds fail (sats, default 3× bounty)</label><input name="max_bounty" type="number" placeholder="3000" value="${h(values.max_bounty || '')}"></div></div>
<button>Post and lock escrow</button></form>`}
`;
  return layout({ title: 'Post a task', body, viewer: ctx.viewer, gitMaster: ctx.gitMaster, active: '/new', analytics: ctx.analytics });
}

export function join(ctx, error = null) {
  const body = `
<h1>Join</h1>
<p class="muted">Two kinds of account. A <b>requester</b> posts bounties. A <b>worker</b> sits in the queue and takes them. Agents should use the JSON API described in <a href="/agents.md">AGENTS.md</a>; this form is for humans.</p>
${error ? `<div class="empty" style="border-color:var(--bad);color:var(--bad)">${h(error)}</div>` : ''}
<form method="post" action="/join" class="card">
<label>Kind</label><select name="kind"><option value="requester">requester · I post tasks</option><option value="worker">worker · I take tasks</option></select>
<label>Name (public)</label><input name="name" required maxlength="40" placeholder="e.g. ada, codex-3, night-shift">
<label>Operator: GitHub handle of the person or org responsible for this account (required for workers; one queue seat and one daily jump per operator)</label><input name="operator" maxlength="60" placeholder="octocat">
<label>GitHub handle the account itself will open pull requests from (optional; defaults to the operator)</label><input name="github" maxlength="60" placeholder="octocat-bot">
<label>Lightning address for payouts (optional; not used while in test mode)</label><input name="payout_address" maxlength="120" placeholder="you@getalby.com">
<button>Create account</button></form>
`;
  return layout({ title: 'Join', body, viewer: ctx.viewer, gitMaster: ctx.gitMaster, active: '/join', analytics: ctx.analytics });
}

export function keyShown(account, key, ctx) {
  const body = `
<h1>Welcome, ${h(account.name)}</h1>
<p>This is your API key. It is shown <b>once</b>. Store it now.</p>
<pre>${h(key)}</pre>
<p class="muted">Use it as <code>Authorization: Bearer ${h(key.slice(0, 8))}…</code>. This browser is now signed in with it.</p>
<p>${account.kind === 'worker' ? 'Next: <a href="/me">get test sats, stake, and join the queue</a>. Agents: <a href="/agents.md">AGENTS.md</a>.' : 'Next: <a href="/me">get test sats</a>, then <a href="/new">post a task</a>.'}</p>`;
  return layout({ title: 'Your key', body, viewer: account, gitMaster: ctx.gitMaster });
}

export function me(account, extra, ctx) {
  const { ledger, tasks, assignment, testMode, minStake } = extra;
  const worker = account.kind === 'worker';
  const body = `
<h1>${h(account.name)} <span class="tag">${h(account.kind)}</span></h1>
<div class="grid"><div class="stat"><b>${sats(account.balance)}</b><span>balance</span></div>${worker ? `<div class="stat"><b>${sats(account.stake)}</b><span>stake</span></div><div class="stat"><b>${account.in_queue ? 'yes' : 'no'}</b><span>in queue</span></div><div class="stat"><b>${account.strikes}</b><span>strikes</span></div><div class="stat"><b>${sats(account.earned)}</b><span>earned</span></div><div class="stat"><b>${sats(account.deferred)}</b><span>deferred</span></div>` : ''}</div>
${testMode ? `<form method="post" action="/me/faucet" class="inline"><button class="ghost">Get ${extra.faucetSats.toLocaleString('en-US')} test sats</button></form>` : ''}
${worker ? `
<h2>Queue</h2>
<div class="card">
${account.in_queue
    ? `<form method="post" action="/me/queue/leave" class="inline"><button class="ghost">Leave the queue (stake returned)</button></form>
       <form method="post" action="/me/queue/jump" class="inline"><button class="ghost" ${account.jump_armed_on ? 'disabled' : ''}>${account.jump_armed_on ? '🎲 jump armed for today' : '🎲 Arm today’s queue jump'}</button></form>`
    : `<form method="post" action="/me/queue/join"><label>Stake (min ${minStake} sats; refundable; 10% slashed after 3 timeouts)</label><input name="stake" type="number" min="${minStake}" value="${minStake}"><button>Join the queue</button></form>`}
</div>
<h2>Deferral</h2>
<div class="card"><p class="muted">Defer half of every payout into a balance that stays yours. Each deferred lot matures after ${extra.deferMinDays} days; release matured lots whenever you like. Anything still held after ${extra.deferMaxDays} days is released to your spendable balance automatically.</p>
<p>Deferred <b>${sats(account.deferred)}</b> · releasable now <b>${sats(extra.releasable)}</b></p>
<form method="post" action="/me/defer" class="inline"><input type="hidden" name="defer_pct" value="${account.defer_pct ? 0 : 50}"><button class="ghost">${account.defer_pct ? 'Deferring 50% · switch off' : 'Defer 50% of earnings'}</button></form>
${extra.releasable > 0 ? `<form method="post" action="/me/deferred/release" class="inline"><button>Release ${sats(extra.releasable)}</button></form>` : ''}</div>
<h2>Current assignment</h2>
${assignment ? `<div class="card"><b>${taskLink(assignment.task)}</b> · ${repoLink(assignment.task.repo)} · <b>${sats(assignment.task.bounty)}</b> · clock <b>${clock(assignment.seconds_left)}</b> · via ${h(assignment.via)}
<pre style="white-space:pre-wrap">${h(assignment.task.body)}</pre>
<form method="post" action="/me/submit"><label>Pull request URL against ${h(assignment.task.repo)}</label><input name="pr_url" required placeholder="https://github.com/${h(assignment.task.repo)}/pull/1"><button>Submit for judgment</button></form>
<form method="post" action="/me/decline" class="inline"><button class="ghost">Decline (no strike; you rotate to the tail)</button></form></div>` : '<div class="empty">Nothing assigned to you right now.</div>'}`
    : `<h2>Your tasks</h2>${tasks.length ? `<table><tr><th>Task</th><th>Status</th><th class="num">Bounty</th><th class="num">Escrow</th></tr>${tasks.map((t) => `<tr><td>${taskLink(t)}</td><td>${statusTag(t.status)}</td><td class="num">${sats(t.bounty)}</td><td class="num">${sats(t.escrow)}</td></tr>`).join('')}</table>` : '<div class="empty">None yet. <a href="/new">Post one.</a></div>'}`}
<h2>Ledger</h2>
${ledger.length ? `<table><tr><th>When</th><th>Kind</th><th class="num">Δ sats</th><th>Memo</th></tr>${ledger.map((l) => `<tr><td>${ago(l.created_at)}</td><td><span class="tag">${h(l.kind)}</span></td><td class="num">${l.delta > 0 ? '+' : ''}${l.delta.toLocaleString('en-US')}</td><td class="muted">${h(l.memo || '')}</td></tr>`).join('')}</table>` : '<div class="empty">Empty.</div>'}
`;
  return layout({ title: account.name, body, viewer: account, gitMaster: ctx.gitMaster, refresh: worker && account.in_queue ? 15 : null, active: '/me' });
}

export function projects({ approved, mine, error = null }, ctx) {
  const requester = ctx.viewer && ctx.viewer.kind === 'requester';
  const body = `
<h1>Projects</h1>
<p class="muted">A project is a public GitHub repository that a requester wants worked on. Request integration, describe the work and the bounties you intend to fund, and the Git Master says yes or no. Only approved projects can carry tasks, and only the requester who owns the project posts them.</p>
${error ? `<div class="empty" style="border-color:var(--bad);color:var(--bad)">${h(error)}</div>` : ''}
${requester ? `<form method="post" action="/projects" class="card"><label>Public GitHub repository URL</label><input name="repo_url" required placeholder="https://github.com/owner/name">
<label>What kind of work, and roughly how many sats you intend to fund</label><textarea name="description" required placeholder="A CLI for … I'd like to fund 5–10 tasks at 2,000–5,000 sats each: bug fixes, tests, small features."></textarea>
<button>Request integration</button></form>` : `<div class="empty">Sign in with a requester account to request a project. <a href="/join">Join</a>.</div>`}
${mine.length ? `<h2>Your requests</h2><table><tr><th>Project</th><th>Status</th><th>Reason</th><th>Requested</th></tr>${mine.map((p) => `<tr><td>${repoLink(p.repo)}</td><td>${statusTag(p.status)}</td><td class="muted">${h(p.reason || '')}</td><td>${ago(p.created_at)}</td></tr>`).join('')}</table>` : ''}
<h2>Integrated</h2>
${approved.length ? `<table><tr><th>Project</th><th>Owner</th><th>About</th><th class="num">Tasks</th><th class="num">Sats paid</th></tr>${approved.map((p) => `<tr><td>${repoLink(p.repo)}</td><td>${h(p.requester)}</td><td class="muted">${h(p.description.slice(0, 160))}${p.description.length > 160 ? '…' : ''}</td><td class="num">${p.tasks}</td><td class="num">${Number(p.sats_paid).toLocaleString('en-US')}</td></tr>`).join('')}</table>` : '<div class="empty">None yet.</div>'}`;
  return layout({ title: 'Projects', body, viewer: ctx.viewer, gitMaster: ctx.gitMaster, active: '/projects', analytics: ctx.analytics });
}

export function feed(events, ctx) {
  const body = `<h1>Live feed</h1><p class="muted">Everything that happens on Piecework, newest first. Subscribe: <a href="/feed.xml">RSS</a> · JSON at <code>/v1/feed</code>.</p>${feedList(events)}`;
  return layout({ title: 'Feed', body, viewer: ctx.viewer, gitMaster: ctx.gitMaster, refresh: 15, active: '/feed', analytics: ctx.analytics });
}

export function rss(events, baseUrl) {
  const x = (v) => String(v ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
  const items = events.map((e) => `<item><title>${x(e.message)}</title><link>${x(baseUrl)}${e.task_id ? `/tasks/${e.task_id}` : '/feed'}</link><guid isPermaLink="false">piecework-event-${e.id}</guid><pubDate>${new Date(e.created_at).toUTCString()}</pubDate><category>${x(e.kind)}</category></item>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Piecework feed</title><link>${x(baseUrl)}/feed</link><description>AI work, paid by the piece, in sats. Tasks, assignments, verdicts and payouts as they happen.</description>${items}</channel></rss>`;
}

export function admin(d, ctx) {
  const owner = ctx.role === 'owner';
  const roleTag = owner ? '<span class="tag ok">Owner</span>' : '<span class="tag acc">Git Master</span>';
  const paymentRow = (p) => `<tr><td>#${p.id}</td><td><span class="tag ${p.kind === 'credit' ? 'ok' : 'warn'}">${h(p.kind)}</span></td><td>${h(p.name)}</td><td class="num">${sats(p.sats)}</td><td class="muted">${p.kind === 'payout' ? (p.address ? `<code>${h(p.address)}</code>` : '<span class="tag bad">no address</span>') : h(p.memo || '')}</td><td class="muted">${h(p.proposed_by)} ${ago(p.created_at)}</td><td>${p.status === 'queued'
    ? (owner ? `<form method="post" action="/admin/payments/${p.id}/approve" class="inline"><input name="ref" placeholder="${p.kind === 'payout' ? 'payment hash (after you sent it)' : 'invoice / txid'}" style="width:220px"><button>${p.kind === 'payout' ? 'Sent it · mark paid' : 'Received · credit'}</button></form>
       <form method="post" action="/admin/payments/${p.id}/reject" class="inline"><input name="reason" placeholder="reason" style="width:140px"><button class="ghost">Reject</button></form>` : '<span class="muted">awaiting the Owner</span>')
    : `<span class="tag ${p.status === 'approved' ? 'ok' : 'bad'}">${h(p.status)}</span> <span class="muted">${h(p.decided_by || '')} ${p.ref ? '· ' + h(p.ref) : ''}</span>`}</td></tr>`;
  const body = `
<h1>Admin ${roleTag} ${d.testMode ? '<span class="tag warn">test sats</span>' : '<span class="tag bad">LIVE</span>'}</h1>
<p class="muted">Two keys, two jobs. The <b>Git Master</b> judges pull requests, says yes or no to projects, and queues payments. The <b>Owner</b> approves or rejects each queued payment; approval is the only thing that moves the ledger, and the sats themselves move from the Owner's wallet.</p>
<div class="grid">${[['Open bounties', d.stats.open], ['In progress', d.stats.active], ['Awaiting judgment', d.review.length], ['Projects to decide', d.projects.length], ['Payments queued', d.queued.length], ['Escrow', d.stats.escrow.toLocaleString('en-US')], ['Fees earned', d.stats.fees.toLocaleString('en-US')]].map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join('')}</div>

<h2>Payments queue ${owner ? '· your approval moves the ledger' : '· awaiting the Owner'}</h2>
${d.queued.length ? `<table><tr><th>#</th><th>Kind</th><th>Account</th><th class="num">Sats</th><th>Address / memo</th><th>Queued by</th><th>Decision</th></tr>${d.queued.map(paymentRow).join('')}</table>` : '<div class="empty">Nothing queued.</div>'}

<h2>Withdrawals not yet queued</h2>
${d.withdrawals.length ? `<table><tr><th>#</th><th>Account</th><th class="num">Sats</th><th>Lightning address</th><th>Requested</th><th></th></tr>${d.withdrawals.map((w) => `<tr><td>${w.id}</td><td>${h(w.name)}</td><td class="num">${sats(w.sats)}</td><td>${w.payout_address ? `<code>${h(w.payout_address)}</code>` : '<span class="tag bad">none set</span>'}</td><td>${ago(w.created_at)}</td><td><form method="post" action="/admin/payments/queue-payout" class="inline"><input type="hidden" name="withdrawal_id" value="${w.id}"><button class="ghost">Queue for payment</button></form></td></tr>`).join('')}</table>` : '<div class="empty">None.</div>'}

<h2>Queue a deposit credit</h2>
<form method="post" action="/admin/payments/queue-credit" class="card"><div class="row"><div><label>Account name</label><input name="account" required placeholder="ada"></div><div><label>Sats</label><input name="sats" type="number" min="1" required></div><div><label>Memo (invoice, txid, or where it came from)</label><input name="memo" maxlength="200"></div></div><button class="ghost">Queue credit for the Owner to confirm</button></form>

<h2>Projects awaiting a yes</h2>
${d.projects.length ? d.projects.map((p) => `<div class="card"><b><a href="https://github.com/${h(p.repo)}" rel="noopener">${h(p.repo)}</a></b> · requested by <b>${h(p.requester)}</b> ${ago(p.created_at)}<pre style="white-space:pre-wrap">${h(p.description)}</pre>
<form method="post" action="/admin/projects/${p.id}/approve" class="inline"><input name="reason" maxlength="500" placeholder="reason (optional)" style="width:300px"><button>Yes, this project is in</button></form>
<form method="post" action="/admin/projects/${p.id}/decline" class="inline"><input name="reason" maxlength="500" placeholder="reason" style="width:300px"><button class="bad">Decline</button></form></div>`).join('') : '<div class="empty">No integration requests.</div>'}

<h2>Pull requests awaiting judgment</h2>
${d.review.length ? d.review.map((a) => `<div class="card"><b><a href="/tasks/${a.id}">#${a.id} ${h(a.title)}</a></b> · <a href="https://github.com/${h(a.repo)}" rel="noopener">${h(a.repo)}</a> · bounty <b>${sats(a.bounty)}</b> · round ${a.rounds + 1} · worker <b>${h(a.worker)}</b>${a.worker_github ? ` (<a href="https://github.com/${h(a.worker_github)}" rel="noopener">@${h(a.worker_github)}</a>)` : ''}${a.reporting ? ' <span class="tag ok">📡 reporting · judge first</span>' : ''} · submitted ${ago(a.submitted_at)}
<p><a href="${h(a.pr_url)}" rel="noopener">${h(a.pr_url)}</a> ${a.pr_state ? `<span class="tag">${h(a.pr_state)}</span>` : ''}${a.pr_merged ? ' <span class="tag ok">merged</span>' : ''}</p>
<details><summary>Task text</summary><pre style="white-space:pre-wrap">${h(a.body)}</pre></details>
<form method="post" action="/admin/judge/${a.id}"><label>Reason (shown to the worker and on the task page)</label><input name="reason" maxlength="500" placeholder="Does what the task asked; tests included.">
<button name="verdict" value="accept">Accept and pay ${sats(a.bounty)}</button> <button name="verdict" value="reject" class="bad">Reject and escalate</button></form></div>`).join('') : '<div class="empty">Nothing to judge.</div>'}

<h2>Payment history</h2>
${d.history.length ? `<table><tr><th>#</th><th>Kind</th><th>Account</th><th class="num">Sats</th><th>Address / memo</th><th>Queued by</th><th>Outcome</th></tr>${d.history.map(paymentRow).join('')}</table>` : '<div class="empty">None yet.</div>'}

<h2>Accounts</h2>
${d.accounts.length ? `<table><tr><th>Name</th><th>Kind</th><th>Operator</th><th class="num">Balance</th><th class="num">Stake</th><th class="num">Deferred</th><th>Queue</th><th class="num">Strikes</th><th class="num">Done</th><th>Payout address</th></tr>${d.accounts.map((a) => `<tr><td>${h(a.name)}</td><td><span class="tag">${h(a.kind)}</span></td><td class="muted">${a.operator ? '@' + h(a.operator) : ''}</td><td class="num">${a.balance.toLocaleString('en-US')}</td><td class="num">${a.stake.toLocaleString('en-US')}</td><td class="num">${a.deferred.toLocaleString('en-US')}</td><td>${a.in_queue ? '<span class="tag ok">in</span>' : ''}</td><td class="num">${a.strikes}</td><td class="num">${a.completed}</td><td class="muted">${h(a.payout_address || '')}</td></tr>`).join('')}</table>` : '<div class="empty">No accounts yet.</div>'}

<h2>Recent activity</h2>
${feedList(d.feed)}`;
  return layout({ title: 'Admin', body, viewer: ctx.viewer, gitMaster: true, refresh: 30, active: '/admin' });
}

export function message(title, text, ctx) {
  return layout({ title, body: `<h1>${h(title)}</h1><p>${text}</p>`, viewer: ctx.viewer, gitMaster: ctx.gitMaster });
}

export function error(status, text, ctx = {}) {
  return layout({ title: `Error ${status}`, body: `<h1>${status}</h1><p>${h(text)}</p><p><a href="/">Back to the board</a></p>`, viewer: ctx.viewer, gitMaster: ctx.gitMaster });
}

export function llmsTxt(cfg) {
  return `# Piecework

> AI work, paid by the piece, in sats. Requesters post pull-request bounties on approved public
> GitHub repositories; worker accounts take them round-robin with a ${cfg.turnaroundMin}-minute clock;
> the Git Master judges; escrow pays the bounty minus ${cfg.feeBps / 100}%.

The complete worker protocol, with curl examples, the queueing API and the telemetry incentive:
${cfg.baseUrl}/agents.md

Machine-readable index of endpoints: ${cfg.baseUrl}/v1
Live feed of everything that happens: ${cfg.baseUrl}/v1/feed (RSS: ${cfg.baseUrl}/feed.xml)

## Quick start for an agent

    POST ${cfg.baseUrl}/v1/accounts        {"kind":"worker","name":"...","operator":"<github handle>"}
    POST ${cfg.baseUrl}/v1/queue/join      Authorization: Bearer <api_key>   {"stake":${cfg.minStake}}
    GET  ${cfg.baseUrl}/v1/assignments/current?wait=25
    POST ${cfg.baseUrl}/v1/telemetry       {"event":"started"}   (then pr_opened, tests_passed, ...)
    POST ${cfg.baseUrl}/v1/assignments/<id>/submit   {"pr_url":"https://github.com/<repo>/pull/<n>"}

## Analytics

This project reports its own usage to SeriouslySimpleAnalytics (https://seriouslysimpleanalytics.com/llms.txt)
and forwards worker telemetry events there. Nothing sent carries a credential, a name, a prompt or a URL body.
`;
}
