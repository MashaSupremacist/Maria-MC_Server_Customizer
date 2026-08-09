import type { ServerEdition, ServerRecord } from '@msc/shared-types';
import type { DatabaseResult } from './db';

export class ServerEditionError extends Error {
  readonly statusCode = 400;

  constructor(serverId: string, expected: ServerEdition, actual: ServerEdition) {
    super(`Server ${serverId} is ${actual} edition; this operation requires ${expected} edition`);
    this.name = 'ServerEditionError';
  }
}

export function requireServerEdition(
  db: DatabaseResult,
  serverId: string,
  expected: ServerEdition,
): ServerRecord {
  const record = db.getServer(serverId);
  if (!record) throw new Error(`No server record with id ${serverId}`);
  if (record.edition !== expected) throw new ServerEditionError(serverId, expected, record.edition);
  return record;
}
