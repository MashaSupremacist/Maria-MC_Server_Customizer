import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('./ServerForm', () => ({ default: () => <div>Java install form</div> }));
vi.mock('./BedrockServerForm', () => ({ default: () => <div>Bedrock install form</div> }));
vi.mock('./AddExistingServerForm', () => ({ default: () => <div>Existing form</div> }));
vi.mock('./PackServerForm', () => ({ default: () => <div>Pack form</div> }));

import CreateServerView from './CreateServerView';

const common = {
  appInfo: null,
  libraryPath: 'C:\\servers',
  libraryError: null,
  lastJavaPath: null,
  install: { install: { phase: 'idle' as const }, error: null, serverTypes: [], start: vi.fn(), cancel: vi.fn(), clearError: vi.fn() },
  bedrockInstall: { install: { phase: 'idle' as const }, error: null, versions: [], versionsError: null, start: vi.fn(), cancel: vi.fn(), clearError: vi.fn() },
  onSelectLibrary: vi.fn(),
  onCreated: vi.fn(),
};

describe('CreateServerView edition methods', () => {
  it('offers server-pack creation only for Java Edition', async () => {
    const user = userEvent.setup();
    const view = render(<CreateServerView {...common} edition="java" />);
    await user.click(screen.getByRole('tab', { name: 'From Server Pack' }));
    expect(screen.getByText('Pack form')).toBeInTheDocument();

    view.rerender(<CreateServerView {...common} edition="bedrock" />);
    expect(screen.queryByRole('tab', { name: 'From Server Pack' })).not.toBeInTheDocument();
    expect(screen.getByText('Bedrock install form')).toBeInTheDocument();
  });
});
