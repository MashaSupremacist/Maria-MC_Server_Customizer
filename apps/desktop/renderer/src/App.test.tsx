import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ServerRecord } from '@msc/shared-types';
import { installMscMock } from './test/msc-mock';

vi.mock('./hooks/useServerRuntime', () => ({
  useServerRuntime: () => ({
    state: 'offline', pid: null, uptimeSeconds: 0, exitCode: null, logs: [], address: null,
    stats: { cpuPercent: 0, memoryMb: 0, playerCount: null, onlinePlayers: [] },
    error: null, startError: null, clearError: vi.fn(), start: vi.fn(), stop: vi.fn(),
    restart: vi.fn(), forceKill: vi.fn(), sendCommand: vi.fn(),
  }),
}));
vi.mock('./hooks/useVanillaInstall', () => ({
  useVanillaInstall: () => ({ install: { phase: 'idle' }, error: null, serverTypes: [], start: vi.fn(), cancel: vi.fn(), clearError: vi.fn() }),
}));
vi.mock('./hooks/useBedrockInstall', () => ({
  useBedrockInstall: () => ({ install: { phase: 'idle' }, error: null, versions: [], versionsError: null, start: vi.fn(), cancel: vi.fn(), clearError: vi.fn() }),
}));
vi.mock('./components/ServerControls', () => ({ default: () => <div>server controls</div> }));
vi.mock('./components/DashboardStats', () => ({
  default: ({ server }: { server: ServerRecord }) => <div data-testid="dashboard-server">{server.edition}:{server.name}</div>,
}));
vi.mock('./components/PlayitIndicator', () => ({ default: () => null }));
vi.mock('./components/UpdateBanner', () => ({ default: () => null }));

import App from './App';

function server(id: string, edition: 'java' | 'bedrock', name: string): ServerRecord {
  return {
    id, edition, name, serverType: edition === 'java' ? 'paper' : 'bedrock',
    folderPath: `C:\\servers\\${id}`, canonicalFolderPath: `C:\\servers\\${id}`,
    folderExists: true, folderOwned: true, javaPath: edition === 'java' ? 'C:\\Java\\java.exe' : null,
    memoryMb: 2048, port: edition === 'java' ? 25565 : 19132, version: '1.21.1', jvmArgs: [],
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  };
}

describe('App edition selection', () => {
  beforeEach(() => {
    installMscMock({
      getAppInfo: vi.fn().mockResolvedValue({ name: 'MSC', version: '0.5.1', platform: 'win32' }),
      getSettings: vi.fn().mockResolvedValue({ serverLibraryPath: 'C:\\servers', playitPath: null, playitPublicAddress: null, lastJavaPath: null }),
      listServers: vi.fn().mockResolvedValue([
        server('bedrock-1', 'bedrock', 'Bedrock One'),
        server('java-1', 'java', 'Java One'),
      ]),
      checkForUpdate: vi.fn().mockResolvedValue({ checkStatus: 'up-to-date', updateAvailable: false, latestVersion: '0.5.1', currentVersion: '0.5.1', releaseUrl: null, notes: null }),
    });
  });

  it('selects the matching server, filters the picker, and resets to dashboard on edition change', async () => {
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByTestId('dashboard-server')).toHaveTextContent('java:Java One');
    expect(screen.queryByRole('button', { name: /Bedrock One/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Bedrock' }));
    await waitFor(() => expect(screen.getByTestId('dashboard-server')).toHaveTextContent('bedrock:Bedrock One'));
    expect(screen.queryByRole('button', { name: /Java One/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mods / Plugins' })).not.toBeInTheDocument();
  });
});
