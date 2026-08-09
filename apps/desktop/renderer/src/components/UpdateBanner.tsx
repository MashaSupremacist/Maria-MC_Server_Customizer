import { useEffect, useState } from 'react';
import { type UpdateInfo } from '@msc/shared-types';
import { api } from '../lib/api';

/**
 * Checks the GitHub Releases endpoint once on mount and shows a compact
 * banner when a newer version is published, or a distinct status when the
 * check could not complete.
 */
export default function UpdateBanner(): React.JSX.Element | null {
  const [info, setInfo] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .checkForUpdate()
      .then((result) => {
        if (!cancelled) setInfo(result);
      })
      .catch(() => {
        // IPC failures are distinct from a successful "up to date" result.
        if (!cancelled) {
          setInfo({
            checkStatus: 'failed',
            updateAvailable: false,
            latestVersion: null,
            currentVersion: '',
            releaseUrl: null,
            notes: null,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!info) return null;

  if (info.checkStatus === 'failed') {
    return (
      <div className="update-banner" role="status">
        <div className="update-banner-text">
          <span>Update check failed</span>
          <span className="muted">{info.error ?? 'Check your connection and try again later.'}</span>
        </div>
      </div>
    );
  }

  if (!info.updateAvailable || !info.releaseUrl) return null;

  const openRelease = (): void => {
    if (info.releaseUrl) void api.openReleaseUrl(info.releaseUrl);
  };

  return (
    <div className="update-banner">
      <div className="update-banner-text">
        <span className="muted">Update available</span>
        <span>
          v{info.latestVersion} &rarr; you are on v{info.currentVersion}
        </span>
        <span className="muted">Updates are downloaded and installed manually from GitHub.</span>
      </div>
      <button type="button" className="btn btn-sm" onClick={openRelease}>
        View Release
      </button>
    </div>
  );
}
