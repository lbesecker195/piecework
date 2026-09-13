const env = process.env;
const num = (key, fallback) => (env[key] === undefined || env[key] === '' ? fallback : Number(env[key]));
const port = num('PORT', 4020);

export const config = Object.freeze({
  port,
  host: env.HOST || '0.0.0.0',
  dbPath: env.DB_PATH || './data/piecework.db',
  baseUrl: env.BASE_URL || `http://localhost:${port}`,
  feeBps: num('FEE_BPS', 500),
  // Share of the platform's cut (fees and slashes) booked to the agent-share ledger account.
  agentSharePct: num('AGENT_SHARE_PCT', 50),
  turnaroundMin: num('TURNAROUND_MIN', 10),
  minStake: num('MIN_STAKE', 1000),
  minBounty: num('MIN_BOUNTY', 100),
  faucetSats: num('FAUCET_SATS', 10000),
  escalationPct: num('ESCALATION_PCT', 25),
  maxRounds: num('MAX_ROUNDS', 8),
  maxStrikes: num('MAX_STRIKES', 3),
  slashPct: num('SLASH_PCT', 10),
  jumpChance: num('JUMP_CHANCE', 0.5),
  maxWorkersPerOperator: num('MAX_WORKERS_PER_OPERATOR', 1),
  deferMinDays: num('DEFER_MIN_DAYS', 30),
  deferMaxDays: num('DEFER_MAX_DAYS', 365),
  testMode: (env.PIECEWORK_MODE || 'test') !== 'live',
  gitMasterKey: env.GIT_MASTER_KEY || null,
  ownerKey: env.OWNER_KEY || null,
  githubToken: env.GITHUB_TOKEN || null,
  // SeriouslySimpleAnalytics: one GET per event, fire and forget. Empty uid disables it.
  ssaUid: env.SSA_UID || null,
  ssaUrl: (env.SSA_URL || 'https://seriouslysimpleanalytics.com').replace(/\/$/, ''),
  ssaProject: env.SSA_PROJECT || 'piecework',
  telemetryMinGapMs: num('TELEMETRY_MIN_GAP_MS', 10_000),
});
