import { useState } from 'react';
import type { ServerRecord } from '@msc/shared-types';

interface DeleteServerDialogProps {
  server: ServerRecord;
  onCancel: () => void;
  onConfirm: (deleteFolder: boolean) => void;
}

export default function DeleteServerDialog({
  server,
  onCancel,
  onConfirm,
}: DeleteServerDialogProps): React.JSX.Element {
  const [typed, setTyped] = useState('');
  const [deleteFolder, setDeleteFolder] = useState(false);
  const folderMissing = !server.folderExists;
  const folderDeletable = server.folderOwned && !folderMissing;

  const confirmed = typed.trim() === server.name;

  return (
    <div className="dialog-overlay">
      <div className="dialog">
        <h2 className="dialog-title">Delete server</h2>
        <p>
          This will permanently remove the server <strong>{server.name}</strong> from
          the application.
        </p>

        <div className="dialog-details">
          <div className="dash-row">
            <span className="muted">Folder</span>
            <span className="path-text">{server.canonicalFolderPath}</span>
          </div>
          {folderMissing && (
            <div className="dash-row">
              <span className="text-danger">Folder is already missing on disk.</span>
            </div>
          )}
        </div>

        <label className="dash-row muted checkbox-label">
          <input
            type="checkbox"
            checked={deleteFolder}
            disabled={!folderDeletable}
            onChange={(e) => setDeleteFolder(e.target.checked)}
          />
          Also delete the server folder on disk
          {folderMissing ? ' (already gone)' : !server.folderOwned ? ' (external folder is preserved)' : ''}
        </label>

        <div className="form-row">
          <label className="form-label" htmlFor="delete-confirm">
            Type the server name to confirm
          </label>
          <input
            id="delete-confirm"
            className="input"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={server.name}
            autoFocus
          />
        </div>

        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={!confirmed}
            onClick={() => onConfirm(deleteFolder)}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
