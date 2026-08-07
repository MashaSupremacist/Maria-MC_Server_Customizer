import { type UpdateInfo } from '@msc/shared-types';

/**
 * GitHub repository that hosts the app releases.
 * The check quietly returns "no update" when the repo isn't published yet.
 */
const REPO = 'minecraft-server-customizer/minecraft-server-customizer';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_URL = `https://github.com/${REPO}/releases`;

/**
 * Compare two semver-ish versions ("0.1.0" vs "0.1.1").
 * Returns true when candidate is newer than current.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const toParts = (v: string): number[] =>
    v
      .replace(/^v/, '')
      .split(/[.-]/)
      .map((p) => (p.match(/^\d+$/) ? parseInt(p, 10) : NaN));

  const a = toParts(candidate);
  const b = toParts(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

/**
 * Query the GitHub Releases API for the newest published version and compare
 * it with the running version. Fails soft (no update) on any network or
 * parsing error so the app never breaks because of the check.
 */
export async function checkForUpdate(currentVersion: string): Promise<UpdateInfo> {
  const fallback: UpdateInfo = {
    updateAvailable: false,
    latestVersion: null,
    currentVersion,
    releaseUrl: null,
    notes: null,
  };

  try {
    const response = await fetch(RELEASES_API, {
      headers: { 'User-Agent': 'minecraft-server-customizer' },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return fallback;

    const release = (await response.json()) as {
      tag_name?: string;
      html_url?: string;
      body?: string;
      draft?: boolean;
      prerelease?: boolean;
    };
    if (release.draft || release.prerelease) return fallback;

    const latest = release.tag_name ?? '';
    if (!latest || !isNewerVersion(latest, currentVersion)) return fallback;

    return {
      updateAvailable: true,
      latestVersion: latest,
      currentVersion,
      releaseUrl: release.html_url ?? RELEASES_URL,
      notes: release.body?.slice(0, 500) ?? null,
    };
  } catch {
    return fallback;
  }
}
