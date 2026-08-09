/** Canonical upstream repository used for release discovery and navigation. */
export const GITHUB_REPOSITORY = 'MashaSupremacist/Maria-MC_Server_Customizer';
export const GITHUB_REPOSITORY_URL = `https://github.com/${GITHUB_REPOSITORY}`;
export const GITHUB_RELEASES_URL = `${GITHUB_REPOSITORY_URL}/releases`;
export const GITHUB_LATEST_RELEASE_API_URL =
  `https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/latest`;

/** Only release pages belonging to the exact canonical repository are safe. */
export function isCanonicalReleaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const releasesPath = `/${GITHUB_REPOSITORY}/releases`;
    return (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      (url.pathname === releasesPath || url.pathname.startsWith(`${releasesPath}/`)) &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}
