// Current app version. Bumped in lockstep with package.json and the README
// release badge. The update-check reads this to decide whether a newer
// GitHub release exists.
export const APP_VERSION = '1.7.1';

const GITHUB_LATEST_RELEASE = 'https://api.github.com/repos/amarisaster/Haven/releases/latest';
const DISMISSED_KEY = 'haven-dismissed-update-version';

export interface UpdateInfo {
  latest: string;
  url: string;
  notes: string;
}

// Returns the latest release if it's strictly newer than APP_VERSION AND the
// user hasn't already dismissed that specific version's banner. Returns null
// otherwise — including on network failures, since a failed check should not
// surface anything to the user.
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    const res = await fetch(GITHUB_LATEST_RELEASE, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return null;
    const data = await res.json() as { tag_name?: string; html_url?: string; body?: string };
    const tag = (data.tag_name || '').trim();
    const latest = tag.startsWith('v') ? tag.slice(1) : tag;
    if (!latest) return null;
    if (!isNewer(latest, APP_VERSION)) return null;
    if (localStorage.getItem(DISMISSED_KEY) === latest) return null;
    return {
      latest,
      url: data.html_url || 'https://github.com/amarisaster/Haven/releases/latest',
      notes: (data.body || '').slice(0, 240),
    };
  } catch {
    return null;
  }
}

export function dismissUpdate(version: string) {
  localStorage.setItem(DISMISSED_KEY, version);
}

// Numeric semver compare. Accepts `major.minor.patch` and ignores pre-release
// suffixes (anything after a `-`). Returns true when `a` is strictly newer.
export function isNewer(a: string, b: string): boolean {
  const parse = (s: string) => s.split('-')[0].split('.').map(n => Number(n) || 0);
  const [a1, a2, a3] = parse(a);
  const [b1, b2, b3] = parse(b);
  if (a1 !== b1) return a1 > b1;
  if (a2 !== b2) return a2 > b2;
  return a3 > b3;
}
