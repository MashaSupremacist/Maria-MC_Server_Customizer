import { usePlayit } from '../hooks/usePlayit';

/**
 * Compact, global Playit tunnel status indicator shown on the Dashboard.
 * Playit is machine-wide (not per-server), so this lives beside the page
 * header rather than inside the server's stat tiles.
 */
export default function PlayitIndicator(): React.JSX.Element {
  const playit = usePlayit();
  const { state, detectedAddress, settings, error, start, stop } = playit;

  return (
    <div className="playit-indicator" title="Playit tunnel status (global)">
      <span className={`playit-dot ${state}`} />
      <span className="playit-state">Playit {state}</span>
      {(state === 'online' || state === 'starting' || state === 'stopping') && (
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void stop()}
          disabled={state === 'stopping'}
        >
          Stop
        </button>
      )}
      {state === 'offline' && (
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void start()}
          disabled={!settings?.playitPath}
          title={settings?.playitPath ? undefined : 'Select a Playit executable on the Playit page first'}
        >
          Start
        </button>
      )}
      {(detectedAddress ?? settings?.playitPublicAddress) && (
        <span className="playit-address path-text">
          {(detectedAddress ?? settings?.playitPublicAddress) ?? ''}
        </span>
      )}
      {error && <span className="playit-error">{error}</span>}
    </div>
  );
}
