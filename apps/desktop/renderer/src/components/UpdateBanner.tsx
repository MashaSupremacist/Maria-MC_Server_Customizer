import { useEffect, useState } from 'react';
import { type UpdateInfo } from '@msc/shared-types';
import { api } from '../lib/api';

/**
 * Checks the GitHub Releases endpoint once on mount and shows a compact
 * banner when a newer version is published. Fails silently when the check
 * cannot complete (offline, unpublished repo, etc.).
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
        // Soft fail: never surface errors for the update check.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!info?.updateAvailable || !info.releaseUrl) return null;

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
      </div>
      <button type="button" className="btn btn-sm" onClick={openRelease}>
        View Release
      </button>
    </div>
  );
}
