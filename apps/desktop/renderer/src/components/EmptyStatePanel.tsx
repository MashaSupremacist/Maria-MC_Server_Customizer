import type { Edition } from '@msc/shared-types';

interface EmptyStatePanelProps {
  edition: Edition;
  /** The nav page the user is looking at (for the title + hint copy). */
  pageTitle: string;
  /** Called when the user clicks "Add a server". */
  onAddServer: () => void;
}

/**
 * Shown on server-required pages when no server exists yet. Replaces the old
 * "not implemented yet" placeholder with a friendly explanation and a call to
 * action, so first-time users are never left staring at a dead page.
 */
export default function EmptyStatePanel({
  edition,
  pageTitle,
  onAddServer,
}: EmptyStatePanelProps): React.JSX.Element {
  return (
    <div className="panel empty-state">
      <h2 className="panel-title">No server yet</h2>
      <p className="muted">
        Add a {edition === 'java' ? 'Java' : 'Bedrock'} server to use{' '}
        <strong>{pageTitle}</strong> here. You can install a fresh server from
        the official sources, or add an existing server folder you already
        have.
      </p>
      <div className="dash-row">
        <button type="button" className="btn" onClick={onAddServer}>
          + Add a server
        </button>
      </div>
    </div>
  );
}
