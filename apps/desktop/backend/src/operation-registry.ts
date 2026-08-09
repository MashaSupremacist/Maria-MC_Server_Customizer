import type {
  OperationKind,
  OperationState,
  OperationStatus,
  WsServerEvent,
} from '@msc/shared-types';

export interface OperationRegistryOptions {
  maximumEntries?: number;
  terminalTtlMs?: number;
  now?: () => number;
}

const DEFAULT_MAXIMUM_ENTRIES = 200;
const DEFAULT_TERMINAL_TTL_MS = 15 * 60 * 1000;

interface EventProgress {
  operationId: string;
  kind: OperationKind;
  status: string;
  percent: number | null;
  message: string;
  serverId?: string;
  javaPath?: string;
}

/** Bounded in-memory history for reconnect/remount progress reconciliation. */
export class OperationRegistry {
  private readonly entries = new Map<string, OperationStatus>();
  private readonly maximumEntries: number;
  private readonly terminalTtlMs: number;
  private readonly now: () => number;

  constructor(options: OperationRegistryOptions = {}) {
    this.maximumEntries = Math.max(1, options.maximumEntries ?? DEFAULT_MAXIMUM_ENTRIES);
    this.terminalTtlMs = Math.max(0, options.terminalTtlMs ?? DEFAULT_TERMINAL_TTL_MS);
    this.now = options.now ?? Date.now;
  }

  recordEvent(event: WsServerEvent): OperationStatus | null {
    const normalized = normalizeEvent(event);
    if (!normalized) return null;
    const previous = this.entries.get(normalized.operationId);
    return this.record(previous ? { ...normalized, kind: previous.kind } : normalized);
  }

  record(progress: EventProgress): OperationStatus {
    this.purgeExpired();
    const timestamp = new Date(this.now()).toISOString();
    const previous = this.entries.get(progress.operationId);
    const entry: OperationStatus = {
      operationId: progress.operationId,
      kind: progress.kind,
      state: operationState(progress.status),
      status: progress.status,
      percent: progress.percent,
      message: progress.message,
      ...(progress.serverId ?? previous?.serverId
        ? { serverId: progress.serverId ?? previous?.serverId }
        : {}),
      ...(progress.javaPath ?? previous?.javaPath
        ? { javaPath: progress.javaPath ?? previous?.javaPath }
        : {}),
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    this.entries.delete(progress.operationId);
    this.entries.set(progress.operationId, entry);
    this.trim();
    return entry;
  }

  get(operationId: string): OperationStatus | null {
    this.purgeExpired();
    return this.entries.get(operationId) ?? null;
  }

  private purgeExpired(): void {
    const cutoff = this.now() - this.terminalTtlMs;
    for (const [id, entry] of this.entries) {
      if (entry.state !== 'active' && Date.parse(entry.updatedAt) < cutoff) {
        this.entries.delete(id);
      }
    }
  }

  private trim(): void {
    while (this.entries.size > this.maximumEntries) {
      const terminal = [...this.entries].find(([, entry]) => entry.state !== 'active');
      if (!terminal) return;
      this.entries.delete(terminal[0]);
    }
  }
}

function operationState(status: string): OperationState {
  if (status === 'complete') return 'succeeded';
  if (status === 'failed') return 'failed';
  if (status === 'canceled') return 'canceled';
  return 'active';
}

function normalizeEvent(event: WsServerEvent): EventProgress | null {
  switch (event.type) {
    case 'install:progress':
      return {
        operationId: event.installId,
        kind: 'server-install',
        ...event.progress,
      };
    case 'java:progress':
      return {
        operationId: event.javaInstallId,
        kind: 'java-install',
        ...event.progress,
      };
    case 'world:import-progress':
      return {
        operationId: event.importId,
        kind: 'world-import',
        ...event.progress,
      };
    case 'backup:progress':
      return {
        operationId: event.backupId,
        kind: 'backup',
        ...event.progress,
        serverId: event.progress.backup?.serverId,
      };
    default:
      return null;
  }
}
