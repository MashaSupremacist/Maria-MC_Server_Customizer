import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JavaRequirement, ServerRecord, WsServerEvent } from '@msc/shared-types';
import { installMscMock } from '../test/msc-mock';

const socketState = vi.hoisted(() => ({
  handlers: [] as Array<(event: WsServerEvent) => void>,
}));

vi.mock('../lib/socket', () => ({
  connectWebSocket: vi.fn(async () => ({
    onEvent(handler: (event: WsServerEvent) => void) {
      socketState.handlers.push(handler);
      return () => {
        socketState.handlers = socketState.handlers.filter((entry) => entry !== handler);
      };
    },
  })),
}));

import JavaRequiredDialog from './JavaRequiredDialog';

const server: ServerRecord = {
  id: 'server-1',
  name: 'Java Server',
  edition: 'java',
  serverType: 'vanilla',
  folderPath: 'C:\\servers\\java',
  canonicalFolderPath: 'C:\\servers\\java',
  folderExists: true,
  folderOwned: true,
  javaPath: null,
  memoryMb: 1024,
  port: 25565,
  version: '1.21.1',
  jvmArgs: [],
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

const requirement: JavaRequirement = {
  minecraftVersion: '1.21.1',
  requiredJava: 21,
  requiredLabel: 'Java 21',
  detected: null,
  compatible: false,
  serverJavaPath: null,
};

describe('JavaRequiredDialog operation recovery', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    socketState.handlers = [];
  });

  it('recovers a completed Java install from the operation registry', async () => {
    const key = 'msc.active-java-runtime-install:21';
    window.sessionStorage.setItem(key, 'java-op');
    installMscMock({
      getJavaDownloadInfo: vi.fn().mockResolvedValue({
        majorVersion: 21,
        label: 'Java 21',
        downloadSizeMb: 100,
        installPath: 'C:\\runtimes\\java-21',
      }),
      getOperationStatus: vi.fn().mockResolvedValue({
        operationId: 'java-op',
        kind: 'java-install',
        state: 'succeeded',
        status: 'complete',
        percent: 100,
        message: 'Installed',
        javaPath: 'C:\\runtimes\\java-21\\bin\\java.exe',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      }),
    });

    render(
      <JavaRequiredDialog
        server={server}
        requirement={requirement}
        onClose={vi.fn()}
        onJavaInstalled={vi.fn()}
      />,
    );

    expect(await screen.findByText('Java runtime installed successfully.')).toBeInTheDocument();
    expect(window.sessionStorage.getItem(key)).toBeNull();
  });

  it('retains the operation id after requesting cancellation until terminal confirmation', async () => {
    const user = userEvent.setup();
    const key = 'msc.active-java-runtime-install:21';
    window.sessionStorage.setItem(key, 'java-op');
    installMscMock({
      getJavaDownloadInfo: vi.fn().mockResolvedValue({
        majorVersion: 21,
        label: 'Java 21',
        downloadSizeMb: 100,
        installPath: 'C:\\runtimes\\java-21',
      }),
      getOperationStatus: vi.fn().mockResolvedValue({
        operationId: 'java-op',
        kind: 'java-install',
        state: 'active',
        status: 'downloading',
        percent: 25,
        message: 'Downloading',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      }),
      cancelJavaInstall: vi.fn().mockResolvedValue({ canceled: true }),
    });

    render(
      <JavaRequiredDialog
        server={server}
        requirement={requirement}
        onClose={vi.fn()}
        onJavaInstalled={vi.fn()}
      />,
    );
    await user.click(await screen.findByRole('button', { name: 'Cancel Installation' }));
    expect(window.sessionStorage.getItem(key)).toBe('java-op');

    await waitFor(() => expect(socketState.handlers.length).toBeGreaterThan(0));
    act(() => {
      for (const handler of socketState.handlers) {
        handler({
          type: 'java:progress',
          javaInstallId: 'java-op',
          progress: { status: 'canceled', percent: null, message: 'Installation canceled' },
        });
      }
    });
    await waitFor(() => expect(window.sessionStorage.getItem(key)).toBeNull());
  });
});
