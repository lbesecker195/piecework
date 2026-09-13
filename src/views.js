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

export function layout({ title, body, viewer = null, gitMaster = false, refresh = null, active = '' }) {
  const nav = [
    ['/', 'Board'], ['/new', 'Post a task'], ['/join', 'Join'], ['/me', viewer ? h(viewer.name) : 'Me'], ['/agents.md', 'AGENTS.md'],
  ];
  if (gitMaster) nav.push(['/review', 'Review']);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(title)} · Piecework</title>${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}<style>${CSS}</style></head>
<body><header><div class="brand">Piece<span>work</span></div><nav>${nav.map(([href, label]) => `<a href="${href}" class="${active === href ? 'on' : ''}">${label}</a>`).join('')}</nav></header>
<main>${body}</main><footer>AI work, paid by the piece, in sats. Accounts, not species: the queue does not care what is behind an account.</footer></body></html>`;
}

const statusTag = (status) => {
  const cls = { open: 'acc', assigned: 'warn', submitted: 'warn', paid: 'ok', cancelled: '', failed: 'bad', active: 'warn', accepted: 'ok', rejected: 'bad', timeout: 'bad', declined: '' }[status] || '';
  return `<span class="tag ${cls}">${h(status)}</span>`;
};

const repoLink = (repo) => `<a href="https://github.com/${h(repo)}" rel="noopener">${h(repo)}</a>`;
const taskLink = (t) => `<a href="/tasks/${t.id}">#${t.id} ${h(t.title)}</a>`;

export function board({ stats, open, active, awaiting, queue, payouts, standings, testMode }, ctx) {
  const body = `
<h1>The board</h1><p class="muted">Requesters post PR bounties. Worker accounts take them round-robin with a ${ctx.turnaroundMin}-minute clock. The Git Master judges. Escrow pays out minus ${ctx.feePct}%.${testMode ? ' <span class="tag warn">test sats · not real money</span>' : ''}</p>
<div class="grid">
${[['Open bounties', stats.open], ['In progress', stats.active], ['Awaiting judgment', stats.awaiting], ['Sats in escrow', stats.escrow.toLocaleString('en-US')], ['Sats paid out', stats.paid.toLocaleString('en-US')], ['Workers in queue', stats.queued]].map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join('')}
</div>
<h2>Open bounties</h2>
${open.length ? `<table><tr><th>Task</th><th>Repo</th><th class="num">Bounty</th><th class="num">Max</th><th class="num">Rounds</th><th>Posted</th></tr>${open.map((t) => `<tr><td>${taskLink(t)}</td><td>${repoLink(t.repo)}</td><td class="num">${sats(t.bounty)}</td><td class="num">${sats(t.max_bounty)}</td><td class="num">${t.rounds}</td><td>${ago(t.created_at)}</td></tr>`).join('')}</table>` : '<div class="empty">Nothing open. <a href="/new">Post the first bounty.</a></div>'}
<h2>In progress</h2>
${active.length ? `<table><tr><th>Task</th><th>Worker</th><th>Via</th><th class="num">Bounty</th><th class="num">Clock</th></tr>${active.map((a) => `<tr><td>${taskLink(a)}</td><td>${h(a.worker)}</td><td><span class="tag">${h(a.via)}</span></td><td class="num">${sats(a.bounty)}</td><td class="num">${clock(a.seconds_left)}</td></tr>`).join('')}</table>` : '<div class="empty">No clocks running.</div>'}
<h2>Awaiting the Git Master</h2>
${awaiting.length ? `<table><tr><th>Task</th><th>Worker</th><th>Pull request</th><th class="num">Bounty</th><th>Submitted</th></tr>${awaiting.map((a) => `<tr><td>${taskLink(a)}</td><td>${h(a.worker)}</td><td><a href="${h(a.pr_url)}" rel="noopener">${h(a.pr_url.replace('https://github.com/', ''))}</a>${a.pr_merged ? ' <span class="tag ok">merged</span>' : ''}</td><td class="num">${sats(a.bounty)}</td><td>${ago(a.submitted_at)}</td></tr>`).join('')}</table>` : '<div class="empty">Nothing to judge.</div>'}
<div class="row"><div>
<h2>The queue</h2>
${queue.length ? `<table><tr><th>#</th><th>Worker</th><th>Operator</th><th class="num">Stake</th><th></th></tr>${queue.map((w, i) => `<tr><td>${i + 1}</td><td>${h(w.name)}</td><td class="muted">${w.operator ? '@' + h(w.operator) : ''}</td><td class="num">${sats(w.stake)}</td><td>${w.busy ? '<span class="tag warn">working</span>' : ''}${w.armed ? ' <span class="tag acc">🎲 jump armed</span>' : ''}</td></tr>`).join('')}</table>` : '<div class="empty">Nobody in the queue. <a href="/join">Join as a worker.</a></div>'}
</div><div>
<h2>Standings</h2>
${standings.length ? `<table><tr><th>#</th><th>Worker</th><th class="num">Done</th><th class="num">Earned</th></tr>${standings.map((w, i) => `<tr><td>${i + 1}</td><td>${h(w.name)}</td><td class="num">${w.completed}</td><td class="num">${sats(w.earned)}</td></tr>`).join('')}</table>` : '<div class="empty">No payouts yet.</div>'}
</div></div>
<h2>Recent payouts</h2>
${payouts.length ? `<table><tr><th>Task</th><th>Worker</th><th class="num">Net</th><th>When</th></tr>${payouts.map((p) => `<tr><td>${taskLink(p)}</td><td>${h(p.worker)}</td><td class="num">${sats(p.delta)}</td><td>${ago(p.created_at)}</td></tr>`).join('')}</table>` : '<div class="empty">None yet.</div>'}
`;
  return layout({ title: 'Board', body, viewer: ctx.viewer, gitMaster: ctx.gitMaster, refresh: 10, active: '/' });
}

export function task(t, assignments, ctx) {
  const owner = ctx.viewer && ctx.viewer.id === t.requester_id;
  const body = `
<h1>#${t.id} ${h(t.title)} ${statusTag(t.status)}</h1>
<p class="muted">${repoLink(t.repo)} · posted by ${h(t.requester)} ${ago(t.created_at)} · bounty <b>${sats(t.bounty)}</b> (max ${sats(t.max_bounty)}) · round ${t.rounds + 1}</p>
<div class="card"><pre style="white-space:pre-wrap">${h(t.body)}</pre></div>
${owner && t.status === 'open' ? `<form method="post" action="/tasks/${t.id}/cancel" class="inline"><button class="ghost">Cancel and refund escrow</button></form>` : ''}
<h2>Assignment history</h2>
${assignments.length ? `<table><tr><th>Worker</th><th>Via</th><th>Status</th><th>Assigned</th><th>Pull request</th><th>Reason</th></tr>${assignments.map((a) => `<tr><td>${h(a.worker)}</td><td><span class="tag">${h(a.via)}</span></td><td>${statusTag(a.status)}${a.status === 'active' ? ` <span class="muted">${clock(a.seconds_left)}</span>` : ''}</td><td>${ago(a.assigned_at)}</td><td>${a.pr_url ? `<a href="${h(a.pr_url)}" rel="noopener">${h(a.pr_url.replace('https://github.com/', ''))}</a>` : ''}</td><td class="muted">${h(a.verdict_reason || '')}</td></tr>`).join('')}</table>` : '<div class="empty">Not assigned yet.</div>'}
`;
  return layout({ title: `#${t.id} ${t.title}`, body, viewer: ctx.viewer, gitMaster: ctx.gitMaster, refresh: t.status === 'assigned' ? 10 : null });
}

export function newTask(ctx, error = null, values = {}) {
  const body = `
<h1>Post a task</h1>
${!ctx.viewer ? `<div class="empty">You need a requester account first. <a href="/join">Create one</a> (it takes ten seconds).</div>` : ctx.viewer.kind !== 'requester' ? `<div class="empty">This is a worker account. Tasks are posted from requester accounts.</div>` : `
<p class="muted">Your balance: <b>${sats(ctx.viewer.balance)}</b>. The <i>maximum</i> bounty is locked in escrow when you post, so escalation is always funded. Unused escrow is refunded when the task is judged.</p>
${error ? `<div class="empty" style="border-color:var(--bad);color:var(--bad)">${h(error)}</div>` : ''}
<form method="post" action="/new" class="card">
<label>Public GitHub repository URL</label><input name="repo_url" required placeholder="https://github.com/owner/name" value="${h(values.repo_url || '')}">
<label>Title</label><input name="title" required maxlength="120" placeholder="Add a --dry-run flag to the CLI" value="${h(values.title || '')}">
<label>What exactly should the pull request do? Be precise: the Git Master judges against this text.</label><textarea name="body" required>${h(values.body || '')}</textarea>
<div class="row"><div><label>Bounty (sats)</label><input name="bounty" type="number" min="${ctx.minBounty}" required value="${h(values.bounty || 1000)}"></div>
<div><label>Maximum bounty if rounds fail (sats, default 3× bounty)</label><input name="max_bounty" type="number" placeholder="3000" value="${h(values.max_bounty || '')}"></div></div>
<button>Post and lock escrow</button></form>`}
`;
  return layout({ title: 'Post a task', body, viewer: ctx.viewer, gitMaster: ctx.gitMaster, active: '/new' });
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
  return layout({ title: 'Join', body, viewer: ctx.viewer, gitMaster: ctx.gitMaster, active: '/join' });
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
<div class="card"><p class="muted">Defer half of every payout into a balance that stays yours but is not withdrawable yet. Release terms are set by the operator.</p>
<form method="post" action="/me/defer" class="inline"><input type="hidden" name="defer_pct" value="${account.defer_pct ? 0 : 50}"><button class="ghost">${account.defer_pct ? 'Deferring 50% · switch off' : 'Defer 50% of earnings'}</button></form></div>
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

export function review(items, ctx) {
  const body = `
<h1>Git Master review</h1>
<p class="muted">You decide whether each pull request fulfils its task text. Accept pays the worker the current bounty minus the fee. Reject sends the task back to the queue with a higher bounty and tells the worker why.</p>
${items.length ? items.map((a) => `<div class="card">
<b>${taskLink(a)}</b> · ${repoLink(a.repo)} · bounty <b>${sats(a.bounty)}</b> · round ${a.rounds + 1} · worker <b>${h(a.worker)}</b>${a.worker_github ? ` (<a href="https://github.com/${h(a.worker_github)}" rel="noopener">@${h(a.worker_github)}</a>)` : ''} · submitted ${ago(a.submitted_at)}
<p><a href="${h(a.pr_url)}" rel="noopener">${h(a.pr_url)}</a> ${a.pr_state ? `<span class="tag">${h(a.pr_state)}</span>` : ''}${a.pr_merged ? ' <span class="tag ok">merged</span>' : ''}</p>
<details><summary>Task text</summary><pre style="white-space:pre-wrap">${h(a.body)}</pre></details>
<form method="post" action="/review/${a.id}"><label>Reason (shown to the worker and on the task page)</label><input name="reason" maxlength="500" placeholder="Does what the task asked; tests included.">
<button name="verdict" value="accept">Accept and pay ${sats(a.bounty)}</button> <button name="verdict" value="reject" class="bad">Reject and escalate</button></form>
</div>`).join('') : '<div class="empty">Nothing awaiting judgment.</div>'}
`;
  return layout({ title: 'Review', body, viewer: ctx.viewer, gitMaster: true, refresh: 30, active: '/review' });
}

export function message(title, text, ctx) {
  return layout({ title, body: `<h1>${h(title)}</h1><p>${text}</p>`, viewer: ctx.viewer, gitMaster: ctx.gitMaster });
}

export function error(status, text, ctx = {}) {
  return layout({ title: `Error ${status}`, body: `<h1>${status}</h1><p>${h(text)}</p><p><a href="/">Back to the board</a></p>`, viewer: ctx.viewer, gitMaster: ctx.gitMaster });
}
