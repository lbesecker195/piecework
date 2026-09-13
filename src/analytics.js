/**
 * SeriouslySimpleAnalytics (https://seriouslysimpleanalytics.com/llms.txt): one HTTPS GET per event,
 * 204 back, never awaited, never retried, never allowed to fail a request. Nothing here carries a
 * credential, a name, a prompt or a URL body; only event names, ids and counts.
 */

export function createAnalytics(cfg, fetchImpl = globalThis.fetch) {
  const enabled = Boolean(cfg.ssaUid);
  function ping(event, params = {}) {
    if (!enabled) return false;
    try {
      const url = new URL('/api/ping', cfg.ssaUrl);
      url.searchParams.set('uid', cfg.ssaUid);
      url.searchParams.set('type', 'ai');
      url.searchParams.set('project', String(params.project || cfg.ssaProject));
      url.searchParams.set('name', 'piecework');
      url.searchParams.set('event', event);
      let extra = 0;
      for (const [key, value] of Object.entries(params)) {
        if (key === 'project' || value === undefined || value === null || value === '') continue;
        if (extra++ >= 18) break;
        url.searchParams.set(key, String(value).slice(0, 80));
      }
      const pending = fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(2000) });
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
      return true;
    } catch {
      return false;
    }
  }
  return { enabled, ping };
}

export const noAnalytics = { enabled: false, ping: () => false };
