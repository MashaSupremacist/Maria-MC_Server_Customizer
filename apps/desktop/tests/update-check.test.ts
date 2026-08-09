import { describe, expect, it, vi } from 'vitest';
import {
  GITHUB_LATEST_RELEASE_API_URL,
  GITHUB_RELEASES_URL,
  isCanonicalReleaseUrl,
} from '../electron/repository';
import { checkForUpdate, isNewerVersion } from '../electron/update-check';

function response(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as Response;
}

describe('canonical release URLs', () => {
  it.each([
    GITHUB_RELEASES_URL,
    `${GITHUB_RELEASES_URL}/`,
    `${GITHUB_RELEASES_URL}/tag/v0.5.1`,
  ])('accepts %s', (url) => {
    expect(isCanonicalReleaseUrl(url)).toBe(true);
  });

  it.each([
    'http://github.com/MashaSupremacist/Maria-MC_Server_Customizer/releases',
    'https://github.com/MashaSupremacist/Maria-MC_Server_Customizer/issues',
    'https://github.com/MashaSupremacist/Maria-MC_Server_Customizer-evil/releases',
    'https://github.com.evil.example/MashaSupremacist/Maria-MC_Server_Customizer/releases',
    'https://user@github.com/MashaSupremacist/Maria-MC_Server_Customizer/releases',
    `${GITHUB_RELEASES_URL}/tag/v0.5.1?redirect=https://evil.example`,
  ])('rejects %s', (url) => {
    expect(isCanonicalReleaseUrl(url)).toBe(false);
  });
});

describe('checkForUpdate', () => {
  it('uses canonical metadata and returns a safe newer release', async () => {
    const fetchImpl = vi.fn(async () => response({
      tag_name: 'v0.5.1',
      html_url: `${GITHUB_RELEASES_URL}/tag/v0.5.1`,
      body: 'Release notes',
    }));

    const result = await checkForUpdate('0.5.0', fetchImpl as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][0]).toBe(GITHUB_LATEST_RELEASE_API_URL);
    expect(fetchImpl.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    expect(result).toEqual({
      checkStatus: 'update-available',
      updateAvailable: true,
      latestVersion: 'v0.5.1',
      currentVersion: '0.5.0',
      releaseUrl: `${GITHUB_RELEASES_URL}/tag/v0.5.1`,
      notes: 'Release notes',
    });
  });

  it('replaces an untrusted API release URL with the canonical releases page', async () => {
    const fetchImpl = vi.fn(async () => response({
      tag_name: 'v0.5.1',
      html_url: 'https://evil.example/download.exe',
    }));

    const result = await checkForUpdate('0.5.0', fetchImpl as typeof fetch);

    expect(result.checkStatus).toBe('update-available');
    expect(result.releaseUrl).toBe(GITHUB_RELEASES_URL);
  });

  it('distinguishes up-to-date from failed checks', async () => {
    const current = await checkForUpdate(
      '0.5.1',
      vi.fn(async () => response({ tag_name: 'v0.5.1', html_url: GITHUB_RELEASES_URL })) as typeof fetch,
    );
    const failed = await checkForUpdate(
      '0.5.1',
      vi.fn(async () => response({}, false)) as typeof fetch,
    );
    const networkFailed = await checkForUpdate(
      '0.5.1',
      vi.fn(async () => Promise.reject(new Error('offline'))) as typeof fetch,
    );

    expect(current.checkStatus).toBe('up-to-date');
    expect(current.updateAvailable).toBe(false);
    expect(failed.checkStatus).toBe('failed');
    expect(failed.updateAvailable).toBe(false);
    expect(networkFailed.checkStatus).toBe('failed');
  });
});

describe('isNewerVersion', () => {
  it('compares semver-like versions', () => {
    expect(isNewerVersion('v0.5.1', '0.5.0')).toBe(true);
    expect(isNewerVersion('0.5.0', '0.5.0')).toBe(false);
    expect(isNewerVersion('0.4.9', '0.5.0')).toBe(false);
  });
});
