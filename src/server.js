import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { dispatch, sweepTimeouts } from './dispatch.js';
import { autoReleaseDeferred } from './ledger.js';
import { tx } from './util.js';
import { pollSubmitted } from './github.js';
import { newKey } from './util.js';

const cfg = { ...config };
const keyFromFile = (name, prefix) => {
  const keyPath = `${dirname(cfg.dbPath)}/${name}.key`;
  mkdirSync(dirname(keyPath), { recursive: true });
  if (!existsSync(keyPath)) writeFileSync(keyPath, newKey(prefix), { mode: 0o600 });
  return readFileSync(keyPath, 'utf8').trim();
};
if (!cfg.gitMasterKey) cfg.gitMasterKey = keyFromFile('gitmaster', 'pwgm');
if (!cfg.ownerKey) cfg.ownerKey = keyFromFile('owner', 'pwown');

const db = openDb(cfg.dbPath);
const app = createApp({ db, cfg });

const tick = () => {
  try {
    const timeouts = sweepTimeouts(db, cfg);
    for (const t of timeouts) console.log(`[timeout] assignment ${t.assignment} worker ${t.worker}${t.ejected ? ` ejected, slashed ${t.slashed}` : ` strike ${t.strikes}`}`);
    for (const a of dispatch(db, cfg)) console.log(`[dispatch] task ${a.task} -> worker ${a.worker} via ${a.via}`);
  } catch (error) {
    console.error('[tick]', error);
  }
};
setInterval(tick, 3000);
setInterval(() => pollSubmitted(db, cfg).catch((error) => console.error('[github]', error)), 60_000);
setInterval(() => {
  try {
    for (const r of tx(db, () => autoReleaseDeferred(db, cfg))) console.log(`[deferral] account ${r.account}: ${r.released} sats auto-released after ${cfg.deferMaxDays} days`);
  } catch (error) {
    console.error('[deferral]', error);
  }
}, 60_000);

app.listen(cfg.port, () => {
  console.log(`Piecework ${cfg.testMode ? '(test sats)' : '(LIVE)'} on ${cfg.baseUrl}`);
  console.log(`  board      ${cfg.baseUrl}/`);
  console.log(`  agents     ${cfg.baseUrl}/agents.md`);
  console.log(`  feed       ${cfg.baseUrl}/feed  (RSS ${cfg.baseUrl}/feed.xml)`);
  console.log(`  git master ${cfg.baseUrl}/admin?key=${cfg.gitMasterKey}`);
  console.log(`  owner      ${cfg.baseUrl}/admin?key=${cfg.ownerKey}`);
});
