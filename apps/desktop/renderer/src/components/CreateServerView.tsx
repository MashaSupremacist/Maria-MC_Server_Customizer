import { useState } from 'react';
import type { AppInfo, Edition, ServerRecord } from '@msc/shared-types';
import ServerForm from './ServerForm';
import BedrockServerForm from './BedrockServerForm';
import AddExistingServerForm from './AddExistingServerForm';
import PackServerForm from './PackServerForm';
import type { InstallController } from '../hooks/useVanillaInstall';
import type { BedrockInstallController } from '../hooks/useBedrockInstall';

interface CreateServerViewProps {
  edition: Edition;
  appInfo: AppInfo | null;
  libraryPath: string | null;
  libraryError: string | null;
  /** Last java.exe used; pre-fills the install form. */
  lastJavaPath: string | null;
  install: InstallController;
  bedrockInstall: BedrockInstallController;
  onSelectLibrary: () => Promise<void>;
  onCreated: (server: ServerRecord) => void;
}

export type CreateMethod = 'install' | 'existing' | 'pack';

/**
 * The "Add Server" view: library folder picker plus a toggle between
 * installing a brand-new server and registering an existing server folder.
 * Defined at module level (not inside App) so its child forms — which fetch
 * version lists on mount — are not remounted on every App re-render.
 */
export default function CreateServerView({
  edition,
  appInfo,
  libraryPath,
  libraryError,
  lastJavaPath,
  install,
  bedrockInstall,
  onSelectLibrary,
  onCreated,
}: CreateServerViewProps): React.JSX.Element {
  const [createMethod, setCreateMethod] = useState<CreateMethod>('install');

  return (
    <section className="page">
      <header className="page-header">
        <h1>Add Server</h1>
        <span className="page-edition muted">
          {edition === 'java' ? 'Java Edition' : 'Bedrock Edition'}
        </span>
        {appInfo && <span className="page-version muted">v{appInfo.version}</span>}
      </header>
      <div className="panel panel-stretch">
        <h2 className="panel-title">Server Library</h2>
        <div className="dash-row dash-row-column">
          <span className="muted">Where server instances are stored</span>
          <span className="path-text">{libraryPath ?? 'Not set'}</span>
        </div>
        <div className="dash-row">
          <button type="button" className="btn" onClick={() => void onSelectLibrary()}>
            {libraryPath ? 'Change Folder' : 'Select Folder'}
          </button>
        </div>
        {libraryError && <div className="error-banner">{libraryError}</div>}
      </div>
      <div className="add-server-tabs" role="tablist" aria-label="Add server method">
        <button
          type="button"
          role="tab"
          aria-selected={createMethod === 'install'}
          className={`add-server-tab${createMethod === 'install' ? ' active' : ''}`}
          onClick={() => setCreateMethod('install')}
        >
          Install New Server
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={createMethod === 'existing'}
          className={`add-server-tab${createMethod === 'existing' ? ' active' : ''}`}
          onClick={() => setCreateMethod('existing')}
        >
          Add Existing Server
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={createMethod === 'pack'}
          className={`add-server-tab${createMethod === 'pack' ? ' active' : ''}`}
          onClick={() => setCreateMethod('pack')}
        >
          From Server Pack
        </button>
      </div>
      {libraryPath ? (
        <div className="panel-stretch">
          {createMethod === 'pack' ? (
            <PackServerForm
              initialJavaPath={lastJavaPath}
              onCreated={onCreated}
            />
          ) : createMethod === 'existing' ? (
            <AddExistingServerForm
              initialJavaPath={lastJavaPath}
              onCreated={onCreated}
              onSwitchToInstall={() => setCreateMethod('install')}
            />
          ) : edition === 'java' ? (
            <ServerForm
              libraryPath={libraryPath}
              install={install}
              initialJavaPath={lastJavaPath}
              onCreated={onCreated}
            />
          ) : (
            <BedrockServerForm
              libraryPath={libraryPath}
              install={bedrockInstall}
              onCreated={onCreated}
            />
          )}
        </div>
      ) : (
        <p className="muted panel-stretch">Choose a library folder to create servers.</p>
      )}
    </section>
  );
}
