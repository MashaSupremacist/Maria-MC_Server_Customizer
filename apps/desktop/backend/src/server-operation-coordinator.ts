import crypto from 'node:crypto';

export type ServerOperationKind =
  | 'start'
  | 'stop'
  | 'delete'
  | 'convert'
  | 'backup'
  | 'restore'
  | 'world-import'
  | 'modpack-import'
  | 'extension-mutation'
  | 'pack-mutation'
  | 'settings-write';

export interface ServerOperation {
  operationId: string;
  serverId: string;
  kind: ServerOperationKind;
  startedAt: string;
  cancelRequested: boolean;
}

export interface OperationConflict {
  code: 'server-busy';
  message: string;
  active: ServerOperation;
}

export class ServerOperationConflictError extends Error {
  readonly conflict: OperationConflict;

  constructor(active: ServerOperation) {
    const snapshot = { ...active };
    super(`Server ${active.serverId} is busy with ${active.kind}`);
    this.name = 'ServerOperationConflictError';
    this.conflict = {
      code: 'server-busy',
      message: this.message,
      active: snapshot,
    };
  }
}

/**
 * Owns the single mutating operation allowed for each server. Read-only work
 * does not need a lease. Callers must keep a lease until their mutation has
 * either committed or rolled back.
 */
export class ServerOperationCoordinator {
  private readonly active = new Map<string, ServerOperation>();

  inspect(serverId: string): ServerOperation | null {
    const operation = this.active.get(serverId);
    return operation ? { ...operation } : null;
  }

  list(): ServerOperation[] {
    return [...this.active.values()].map((operation) => ({ ...operation }));
  }

  acquire(
    serverId: string,
    kind: ServerOperationKind,
    operationId: string = crypto.randomUUID(),
  ): ServerOperation {
    const current = this.active.get(serverId);
    if (current) throw new ServerOperationConflictError(current);

    const operation: ServerOperation = {
      operationId,
      serverId,
      kind,
      startedAt: new Date().toISOString(),
      cancelRequested: false,
    };
    this.active.set(serverId, operation);
    return { ...operation };
  }

  release(serverId: string, operationId: string): boolean {
    const current = this.active.get(serverId);
    if (!current || current.operationId !== operationId) return false;
    this.active.delete(serverId);
    return true;
  }

  requestCancel(serverId: string, operationId: string): boolean {
    const current = this.active.get(serverId);
    if (!current || current.operationId !== operationId) return false;
    current.cancelRequested = true;
    return true;
  }

  isCancellationRequested(serverId: string, operationId: string): boolean {
    const current = this.active.get(serverId);
    return current?.operationId === operationId && current.cancelRequested;
  }

  async run<T>(
    serverId: string,
    kind: ServerOperationKind,
    task: (operation: ServerOperation) => Promise<T> | T,
    operationId?: string,
  ): Promise<T> {
    const operation = this.acquire(serverId, kind, operationId);
    try {
      return await task(operation);
    } finally {
      this.release(serverId, operation.operationId);
    }
  }
}
