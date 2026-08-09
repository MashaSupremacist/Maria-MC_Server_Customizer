import fs from 'node:fs';
import path from 'node:path';
import type {
  ServerPropertiesDocument,
  ServerPropertyEntry,
  UpdatePropertiesRequest,
} from '@msc/shared-types';
import {
  fromRawValue,
  getPropertyField,
  toRawValue,
  validateProperty,
  SERVER_PROPERTIES_SCHEMA,
} from './server-properties-schema';
import { atomicWriteTextFile, parseProperties, serializeProperties } from './properties';
import type { DatabaseResult } from './db';
import { requireServerEdition } from './server-edition';

export interface PropertyValidationResult {
  ok: boolean;
  /** Key → error message for invalid fields. */
  errors: Record<string, string>;
}

/**
 * Reads and updates a server's server.properties, preserving comments and
 * unknown keys, validating known fields, and backing up before every save.
 */
export class ServerPropertiesService {
  private readonly db: DatabaseResult;

  constructor(db: DatabaseResult) {
    this.db = db;
  }

  private propertiesPath(serverId: string): string {
    const record = requireServerEdition(this.db, serverId, 'java');
    return path.join(record.folderPath, 'server.properties');
  }

  /** Read the current document. If the file is absent, use defaults. */
  read(serverId: string): ServerPropertiesDocument {
    const record = requireServerEdition(this.db, serverId, 'java');

    const filePath = this.propertiesPath(serverId);
    const file = fs.existsSync(filePath)
      ? parseProperties(fs.readFileSync(filePath, 'utf8'))
      : { entries: new Map<string, string>(), rawLines: [] };

    const fields: ServerPropertyEntry[] = [];
    const present = new Set<string>();

    for (const field of SERVER_PROPERTIES_SCHEMA) {
      let raw: string | undefined = file.entries.get(field.key);
      if (raw === undefined) {
        raw = toRawValue(field, field.default);
      } else {
        present.add(field.key);
      }
      fields.push({
        field: { ...field },
        value: fromRawValue(field, raw),
      });
    }

    // Unknown keys (not in the schema) are preserved and shown as raw text.
    const unknownLines = file.rawLines
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('!'))
      .filter((line) => {
        const key = line.split(/[=:]/)[0]?.trim();
        return key ? !getPropertyField(key) : false;
      });

    return {
      serverId,
      fields,
      rawText: unknownLines.join('\n'),
      changedKeys: [],
      lastBackupPath: null,
    };
  }

  /**
   * Validate a proposed update without writing. Returns per-key errors.
   */
  validate(serverId: string, values: Record<string, string>): PropertyValidationResult {
    const errors: Record<string, string> = {};
    for (const [key, raw] of Object.entries(values)) {
      if (/[\r\n]/.test(raw)) {
        errors[key] = 'Property values cannot contain line breaks';
        continue;
      }
      const field = getPropertyField(key);
      if (!field) {
        errors[key] = 'Unknown property';
        continue;
      }
      const error = validateProperty(field, raw);
      if (error) errors[key] = error;
    }
    return { ok: Object.keys(errors).length === 0, errors };
  }

  /**
   * Apply an update: back up the current file, validate, merge, write.
   * Throws on validation failure (with `.errors`).
   */
  update(
    serverId: string,
    request: UpdatePropertiesRequest,
  ): { document: ServerPropertiesDocument; validation: PropertyValidationResult } {
    const validation = this.validate(serverId, request.values);
    if (!validation.ok) {
      return { document: this.read(serverId), validation };
    }

    const record = requireServerEdition(this.db, serverId, 'java');
    const filePath = this.propertiesPath(serverId);

    // Back up the current state (if the file exists) before touching it.
    let lastBackupPath: string | null = null;
    if (fs.existsSync(filePath)) {
      const backupsDir = path.join(record.folderPath, 'msc-backups');
      fs.mkdirSync(backupsDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      lastBackupPath = path.join(backupsDir, `server.properties.bak-${stamp}`);
      fs.copyFileSync(filePath, lastBackupPath);
    }

    const existing = fs.existsSync(filePath)
      ? parseProperties(fs.readFileSync(filePath, 'utf8'))
      : { entries: new Map<string, string>(), rawLines: [] };

    // Convert typed values back to raw strings for the file.
    const overrides = new Map<string, string>();
    for (const [key, raw] of Object.entries(request.values)) {
      overrides.set(key, raw);
    }
    // Also write any schema defaults not currently in the file, so a fresh
    // install gets a complete file (Phase 4 already does this, but be safe).
    const presentKeys = new Set(existing.entries.keys());
    for (const field of SERVER_PROPERTIES_SCHEMA) {
      if (!presentKeys.has(field.key) && !overrides.has(field.key)) {
        overrides.set(field.key, toRawValue(field, field.default));
      }
    }

    const newText = serializeProperties(existing, overrides);
    atomicWriteTextFile(filePath, newText);

    const document = this.read(serverId);
    document.lastBackupPath = lastBackupPath;
    document.changedKeys = Object.keys(request.values);
    return { document, validation };
  }
}
