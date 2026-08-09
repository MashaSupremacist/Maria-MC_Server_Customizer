import { type UpdateInfo } from '@msc/shared-types';
import {
  GITHUB_LATEST_RELEASE_API_URL,
  GITHUB_RELEASES_URL,
  isCanonicalReleaseUrl,
} from './repository';

export const UPDATE_CHECK_TIMEOUT_MS = 8_000;

/** Return true when a semver-like candidate is newer than the current version. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const toParts = (version: string): number[] =>
    version
      .replace(/^v/, '')
      .split(/[.-]/)
      .map((part) => (part.match(/^\d+$/) ? parseInt(part, 10) : Number.NaN));

  const candidateParts = toParts(candidate);
  const currentParts = toParts(current);
  const length = Math.max(candidateParts.length, currentParts.length);
  for (let index = 0; index < length; index += 1) {
    const candidatePart = candidateParts[index] ?? 0;
    const currentPart = currentParts[index] ?? 0;
    if (candidatePart > currentPart) return true;
    if (candidatePart < currentPart) return false;
  }
  return false;
}

function result(
  checkStatus: UpdateInfo['checkStatus'],
  currentVersion: string,
  overrides: Partial<UpdateInfo> = {},
): UpdateInfo {
  return {
    checkStatus,
    updateAvailable: checkStatus === 'update-available',
    latestVersion: null,
    currentVersion,
    releaseUrl: null,
    notes: null,
    ...overrides,
  };
}

/** Query the canonical GitHub Releases endpoint with a bounded request. */
export async function checkForUpdate(
  currentVersion: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UpdateInfo> {
  try {
    const response = await fetchImpl(GITHUB_LATEST_RELEASE_API_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'minecraft-server-customizer',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
    });
    if (!response.ok) {
      return result('failed', currentVersion, { error: `GitHub returned HTTP ${response.status}` });
    }

    const release = (await response.json()) as {
      tag_name?: string;
      html_url?: string;
      body?: string;
      draft?: boolean;
      prerelease?: boolean;
    } | null;
    if (!release || typeof release.tag_name !== 'string' || release.tag_name.length === 0) {
      return result('failed', currentVersion, { error: 'GitHub returned malformed release metadata' });
    }

    if (release.draft || release.prerelease || !isNewerVersion(release.tag_name, currentVersion)) {
      return result('up-to-date', currentVersion, { latestVersion: release.tag_name });
    }

    const releaseUrl =
      typeof release.html_url === 'string' && isCanonicalReleaseUrl(release.html_url)
        ? release.html_url
        : GITHUB_RELEASES_URL;
    return result('update-available', currentVersion, {
      latestVersion: release.tag_name,
      releaseUrl,
      notes: typeof release.body === 'string' ? release.body.slice(0, 500) : null,
    });
  } catch (error) {
    return result('failed', currentVersion, {
      error: error instanceof Error ? error.message : 'Update request failed',
    });
  }
}
