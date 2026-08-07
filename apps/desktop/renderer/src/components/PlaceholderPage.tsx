import { type Edition, type PageId } from '@msc/shared-types';

interface PlaceholderPageProps {
  pageId: string;
  edition: Edition;
  appVersion?: string;
}

const pageTitles: Record<PageId, string> = {
  dashboard: 'Dashboard',
  console: 'Console',
  worlds: 'Worlds',
  players: 'Players',
  settings: 'Settings',
  gamerules: 'Gamerules',
  datapacks: 'Datapacks',
  'mods-plugins': 'Mods / Plugins',
  backups: 'Backups',
  playit: 'Playit',
  permissions: 'Permissions',
  allowlist: 'Allowlist',
  'behavior-packs': 'Behavior Packs',
  'resource-packs': 'Resource Packs',
};

export default function PlaceholderPage({
  pageId,
  edition,
  appVersion,
}: PlaceholderPageProps): React.JSX.Element {
  const title =
    pageTitles[pageId as PageId] ?? pageTitles.dashboard;
  const editionLabel = edition === 'java' ? 'Java Edition' : 'Bedrock Edition';

  return (
    <section className="page">
      <header className="page-header">
        <h1>{title}</h1>
        <span className="page-edition muted">{editionLabel}</span>
        {appVersion && (
          <span className="page-version muted">v{appVersion}</span>
        )}
      </header>
      <div className="placeholder">
        <p>
          <strong>{title}</strong> is not implemented yet.
        </p>
        <p className="muted">
          This placeholder will be replaced in a later phase.
        </p>
      </div>
    </section>
  );
}
