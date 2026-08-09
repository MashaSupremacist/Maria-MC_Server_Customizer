import fs from 'node:fs';
import path from 'node:path';
import type {
  BedrockAllowlistEntry,
  BedrockPermissionEntry,
  BedrockPermissionLevel,
  CommandResult,
} from '@msc/shared-types';
import type { DatabaseResult } from './db';
import { requireServerEdition } from './server-edition';

export interface OnlineStatus {
  (serverId: string): boolean;
}

const PERMISSION_LEVELS: BedrockPermissionLevel[] = ['operator', 'member', 'visitor'];

/**
 * Manages a Bedrock server's allowlist.json and permissions.json. Bedrock
 * rewrites these files while the server is online, so edits are refused while
 * the server is running (mirrors the Java whitelist handling).
 */
export class BedrockPlayerService {
  private readonly db: DatabaseResult;
  private isOnline: OnlineStatus;

  constructor(db: DatabaseResult, isOnline: OnlineStatus) {
    this.db = db;
    this.isOnline = isOnline;
  }

  private recordPath(serverId: string): string {
    const record = requireServerEdition(this.db, serverId, 'bedrock');
    return record.folderPath;
  }

  /** Read the allowlist (offline-safe; missing file → empty list). */
  readAllowlist(serverId: string): BedrockAllowlistEntry[] {
    return this.readJson(serverId, 'allowlist.json') as BedrockAllowlistEntry[];
  }

  /** Replace the allowlist. Refuses while the server is online. */
  updateAllowlist(serverId: string, entries: BedrockAllowlistEntry[]): CommandResult {
    const guard = this.mutationGuard(serverId, 'allowlist');
    if (guard) return guard;
    for (const entry of entries) {
      if (typeof entry.name !== 'string' || entry.name.trim() === '') {
        return { ok: false, error: 'Every allowlist entry needs a player name' };
      }
    }
    this.writeJson(serverId, 'allowlist.json', entries);
    return { ok: true };
  }

  /** Read the permissions list (offline-safe; missing file → empty list). */
  readPermissions(serverId: string): BedrockPermissionEntry[] {
    return this.readJson(serverId, 'permissions.json') as BedrockPermissionEntry[];
  }

  /** Replace the permissions list. Refuses while the server is online. */
  updatePermissions(serverId: string, entries: BedrockPermissionEntry[]): CommandResult {
    const guard = this.mutationGuard(serverId, 'permissions');
    if (guard) return guard;
    for (const entry of entries) {
      if (!PERMISSION_LEVELS.includes(entry.permission)) {
        return {
          ok: false,
          error: `Permission must be one of: ${PERMISSION_LEVELS.join(', ')}`,
        };
      }
      if (entry.name !== undefined && entry.name.trim() === '') {
        return { ok: false, error: 'Player name cannot be empty' };
      }
    }
    this.writeJson(serverId, 'permissions.json', entries);
    return { ok: true };
  }

  private mutationGuard(serverId: string, what: string): CommandResult | null {
    if (this.isOnline(serverId)) {
      return {
        ok: false,
        error: `Stop the server to edit ${what}.json. Use console commands while online.`,
      };
    }
    return null;
  }

  private readJson(serverId: string, fileName: string): unknown[] {
    const filePath = path.join(this.recordPath(serverId), fileName);
    if (!fs.existsSync(filePath)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private writeJson(serverId: string, fileName: string, entries: unknown[]): void {
    const folder = this.recordPath(serverId);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, fileName), JSON.stringify(entries, null, 2), 'utf8');
  }
}
