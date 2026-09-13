const REPO_RE = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const PR_RE = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/;

/** "https://github.com/owner/name" -> "owner/name", or null. */
export function parseRepo(url) {
  const match = REPO_RE.exec(String(url || '').trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

/** "https://github.com/owner/name/pull/12" -> { repo: "owner/name", number: 12 }, or null. */
export function parsePr(url) {
  const match = PR_RE.exec(String(url || '').trim());
  return match ? { repo: `${match[1]}/${match[2]}`, number: Number(match[3]) } : null;
}

export async function fetchPr(repo, number, token = null) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'piecework' };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/pulls/${number}`, { headers });
    if (!response.ok) return null;
    const pr = await response.json();
    return {
      state: pr.state,
      merged: Boolean(pr.merged_at),
      title: pr.title,
      author: pr.user?.login,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changed_files,
      draft: Boolean(pr.draft),
    };
  } catch {
    return null;
  }
}

/** Refresh PR state on every submitted assignment. Information for the Git Master, never a verdict. */
export async function pollSubmitted(db, cfg) {
  const rows = db.prepare("SELECT id, pr_url FROM assignments WHERE status = 'submitted' AND pr_url IS NOT NULL").all();
  for (const row of rows) {
    const parsed = parsePr(row.pr_url);
    if (!parsed) continue;
    const pr = await fetchPr(parsed.repo, parsed.number, cfg.githubToken);
    if (pr) {
      db.prepare('UPDATE assignments SET pr_state = ?, pr_merged = ? WHERE id = ?').run(pr.state, pr.merged ? 1 : 0, row.id);
    }
  }
}
