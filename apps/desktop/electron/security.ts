export interface TrustedRendererPolicy {
  productionFileUrl: string;
  developmentOrigin: string | null;
}

/** Build the exact URL policy used by navigation and privileged IPC. */
export function createTrustedRendererPolicy(
  productionFileUrl: string,
  developmentServerUrl?: string,
): TrustedRendererPolicy {
  const productionUrl = new URL(productionFileUrl);
  if (productionUrl.protocol !== 'file:') {
    throw new Error('The production renderer must use a file URL');
  }

  let developmentOrigin: string | null = null;
  if (developmentServerUrl) {
    const developmentUrl = new URL(developmentServerUrl);
    if (
      (developmentUrl.protocol !== 'http:' && developmentUrl.protocol !== 'https:') ||
      developmentUrl.username !== '' ||
      developmentUrl.password !== ''
    ) {
      throw new Error('The development renderer must use a trusted HTTP(S) origin');
    }
    developmentOrigin = developmentUrl.origin;
  }

  return {
    productionFileUrl: productionUrl.toString(),
    developmentOrigin,
  };
}

/** Accept only the configured dev origin or the exact packaged index file. */
export function isTrustedRendererUrl(value: string, policy: TrustedRendererPolicy): boolean {
  try {
    const candidate = new URL(value);
    if (candidate.username !== '' || candidate.password !== '') return false;

    if (
      policy.developmentOrigin &&
      (candidate.protocol === 'http:' || candidate.protocol === 'https:') &&
      candidate.origin === policy.developmentOrigin
    ) {
      return true;
    }

    const production = new URL(policy.productionFileUrl);
    return (
      candidate.protocol === 'file:' &&
      candidate.host === production.host &&
      // The shipped application is Windows-only, where file paths are
      // case-insensitive. Query/hash state does not change renderer identity.
      candidate.pathname.toLowerCase() === production.pathname.toLowerCase()
    );
  } catch {
    return false;
  }
}

export function assertTrustedRendererUrl(
  value: string,
  policy: TrustedRendererPolicy,
): void {
  if (!isTrustedRendererUrl(value, policy)) {
    throw new Error('Blocked privileged IPC from an untrusted renderer');
  }
}

const ALLOWED_EXTERNAL_ORIGINS = new Set([
  'https://adoptium.net',
  'https://playit.gg',
]);

/** External window requests are limited to links intentionally used by the UI. */
export function isAllowedExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      ALLOWED_EXTERNAL_ORIGINS.has(url.origin)
    );
  } catch {
    return false;
  }
}
