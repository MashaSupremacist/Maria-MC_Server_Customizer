import fs from 'node:fs';
import path from 'node:path';
import type {
  CommandResult,
  GameruleEntry,
  GamerulesDocument,
  PlayerListEntry,
} from '@msc/shared-types';
import type { DatabaseResult } from './db';
import type { ServerManagerService } from './server-manager';
import { gamerulesForVersion, getGameruleDef } from './gamerule-catalog';
import { requireServerEdition } from './server-edition';

export interface CommandRunner {
  (serverId: string, command: string): boolean;
}

export interface OnlineStatus {
  (serverId: string): boolean;
}

/**
 * Manages gamerules and player administration. Uses Minecraft console
 * commands when the server is online; edits whitelist/ops JSON files only
 * when the server is offline (or falls back to command dispatch).
 */
export class PlayerService {
  private readonly db: DatabaseResult;
  private readonly manager: ServerManagerService;

  constructor(db: DatabaseResult, manager: ServerManagerService) {
    this.db = db;
    this.manager = manager;
  }

  private recordPath(serverId: string): string {
    const record = requireServerEdition(this.db, serverId, 'java');
    return record.folderPath;
  }

  private isOnline(serverId: string): boolean {
    return this.manager.runningServerId() === serverId;
  }

  /** Read gamerules: online via command, offline via the world's gamerules.json. */
  readGamerules(serverId: string): GamerulesDocument {
    const record = requireServerEdition(this.db, serverId, 'java');
    const offline = !this.isOnline(serverId);
    const defs = gamerulesForVersion(record.version);

    // Offline: read from <world>/gamerules.json or <world>/settings/gamerules.json.
    const worldFolder = this.findWorldFolder(record.folderPath);
    const gamerulesJsonPath = worldFolder ? this.resolveGamerulesFile(worldFolder) : null;
    const fileValues = new Map<string, string | number | boolean>();
    if (gamerulesJsonPath && fs.existsSync(gamerulesJsonPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(gamerulesJsonPath, 'utf8')) as Record<string, string | number | boolean>;
        for (const [key, value] of Object.entries(parsed)) {
          fileValues.set(key, value);
        }
      } catch {
        // unreadable file → defaults
      }
    }

    const rules: GameruleEntry[] = defs.map((def) => {
      const raw = fileValues.get(def.key);
      let value = raw;
      if (value === undefined) value = def.defaultValue;
      if (def.type === 'integer' && typeof value === 'string') value = parseInt(value, 10) || 0;
      if (def.type === 'boolean' && typeof value === 'string') value = value === 'true';
      return {
        key: def.key,
        category: def.category,
        type: def.type,
        description: def.description,
        defaultValue: def.defaultValue,
        min: def.min,
        max: def.max,
        value,
      };
    });

    return { serverId, rules, offline };
  }

  /** Update a gamerule. Online: send the command. Offline: edit gamerules.json. */
  updateGamerule(serverId: string, key: string, rawValue: string): CommandResult {
    requireServerEdition(this.db, serverId, 'java');
    const def = getGameruleDef(key);
    if (!def) return { ok: false, error: `Unknown gamerule: ${key}` };

    // Validate.
    if (def.type === 'integer') {
      const n = Number(rawValue);
      if (!Number.isInteger(n)) return { ok: false, error: 'Must be a whole number' };
      if (def.min !== undefined && n < def.min) return { ok: false, error: `Must be at least ${def.min}` };
      if (def.max !== undefined && n > def.max) return { ok: false, error: `Must be at most ${def.max}` };
    } else if (rawValue !== 'true' && rawValue !== 'false') {
      return { ok: false, error: 'Must be true or false' };
    }

    if (this.isOnline(serverId)) {
      const ok = this.manager.sendCommand(serverId, `gamerule ${key} ${rawValue}`);
      return ok ? { ok: true } : { ok: false, offline: true, error: 'Failed to send command' };
    }

    // Offline: write to <world>/gamerules.json or <world>/settings/gamerules.json.
    const worldFolder = this.findWorldFolder(this.db.getServer(serverId)?.folderPath ?? '');
    if (!worldFolder) return { ok: false, error: 'No world folder found' };
    const filePath = this.resolveGamerulesFile(worldFolder);
    let data: Record<string, string | number | boolean> = {};
    if (fs.existsSync(filePath)) {
      try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch {
        data = {};
      }
    }
    data[key] = def.type === 'integer' ? parseInt(rawValue, 10) : rawValue === 'true';
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return { ok: true };
  }

  /** Read the whitelist JSON (offline-safe). */
  readWhitelist(serverId: string): PlayerListEntry[] {
    return this.readPlayerJson(serverId, 'whitelist.json');
  }

  /** Replace the whitelist (only meaningful offline). */
  updateWhitelist(serverId: string, entries: PlayerListEntry[]): CommandResult {
    if (this.isOnline(serverId)) {
      return { ok: false, error: 'Stop the server to edit the whitelist file. Use /whitelist commands while online.' };
    }
    this.writePlayerJson(serverId, 'whitelist.json', entries);
    return { ok: true };
  }

  /** Read the ops JSON (offline-safe). */
  readOperators(serverId: string): PlayerListEntry[] {
    return this.readPlayerJson(serverId, 'ops.json');
  }

  updateOperators(serverId: string, entries: PlayerListEntry[]): CommandResult {
    if (this.isOnline(serverId)) {
      return { ok: false, error: 'Stop the server to edit ops.json. Use /op commands while online.' };
    }
    this.writePlayerJson(serverId, 'ops.json', entries);
    return { ok: true };
  }

  /** Read the bans JSON (offline-safe). */
  readBans(serverId: string): PlayerListEntry[] {
    return this.readPlayerJson(serverId, 'banned-players.json');
  }

  updateBans(serverId: string, entries: PlayerListEntry[]): CommandResult {
    if (this.isOnline(serverId)) {
      return { ok: false, error: 'Stop the server to edit banned-players.json. Use /ban commands while online.' };
    }
    this.writePlayerJson(serverId, 'banned-players.json', entries);
    return { ok: true };
  }

  /** Read the IP-bans JSON (offline-safe). */
  readIpBans(serverId: string): PlayerListEntry[] {
    return this.readPlayerJson(serverId, 'banned-ips.json');
  }

  updateIpBans(serverId: string, entries: PlayerListEntry[]): CommandResult {
    if (this.isOnline(serverId)) {
      return { ok: false, error: 'Stop the server to edit banned-ips.json. Use /ban-ip commands while online.' };
    }
    this.writePlayerJson(serverId, 'banned-ips.json', entries);
    return { ok: true };
  }

  /** Run a player admin command against the running server (kick/ban/op/…). */
  runCommand(serverId: string, command: string): CommandResult {
    if (!this.isOnline(serverId)) {
      return { ok: false, offline: true, error: 'Server is offline' };
    }
    const ok = this.manager.sendCommand(serverId, command);
    return ok ? { ok: true } : { ok: false, error: 'Failed to send command' };
  }

  private readPlayerJson(serverId: string, fileName: string): PlayerListEntry[] {
    const filePath = path.join(this.recordPath(serverId), fileName);
    if (!fs.existsSync(filePath)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as PlayerListEntry[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private writePlayerJson(serverId: string, fileName: string, entries: PlayerListEntry[]): void {
    const folder = this.recordPath(serverId);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, fileName), JSON.stringify(entries, null, 2), 'utf8');
  }

  /** Find the active world folder (level-name from server.properties, or "world"). */
  private findWorldFolder(serverFolder: string): string | null {
    if (!fs.existsSync(serverFolder)) return null;
    // Read level-name from server.properties if present.
    let levelName = 'world';
    const propsPath = path.join(serverFolder, 'server.properties');
    if (fs.existsSync(propsPath)) {
      const text = fs.readFileSync(propsPath, 'utf8');
      const match = text.match(/^level-name=(.+)$/m);
      if (match) levelName = match[1].trim();
    }
    const candidate = path.join(serverFolder, levelName);
    return fs.existsSync(candidate) ? candidate : null;
  }

  /**
   * Resolve the gamerules file for a world. Modern versions keep it at
   * <world>/settings/gamerules.json; older ones at <world>/gamerules.json.
   */
  private resolveGamerulesFile(worldFolder: string): string {
    const modern = path.join(worldFolder, 'settings', 'gamerules.json');
    const legacy = path.join(worldFolder, 'gamerules.json');
    if (fs.existsSync(modern)) return modern;
    if (fs.existsSync(legacy)) return legacy;
    // Default to the modern location for new writes.
    return modern;
  }
}
