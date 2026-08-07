import fs from 'node:fs';
import path from 'node:path';
import type {
  ServerPropertiesDocument,
  ServerPropertyEntry,
  UpdatePropertiesRequest,
} from '@msc/shared-types';
import {
  fromBedrockRawValue,
  getBedrockPropertyField,
  toBedrockRawValue,
  validateBedrockProperty,
  BEDROCK_SERVER_PROPERTIES_SCHEMA,
} from './bedrock-server-properties-schema';
import { parseProperties, serializeProperties } from './properties';
import type { DatabaseResult } from './db';

export interface BedrockPropertyValidationResult {
  ok: boolean;
  /** Key → error message for invalid fields. */
  errors: Record<string, string>;
}

/**
 * Reads and updates a Bedrock server's server.properties, preserving comments
 * and unknown keys, validating known fields, and backing up before every save.
 */
export class BedrockPropertiesService {
  private readonly db: DatabaseResult;

  constructor(db: DatabaseResult) {
    this.db = db;
  }

  private propertiesPath(serverId: string): string {
    const record = this.db.getServer(serverId);
    if (!record) throw new Error(`No server record with id ${serverId}`);
    return path.join(record.folderPath, 'server.properties');
  }

  /** Read the current document. If the file is absent, use defaults. */
  read(serverId: string): ServerPropertiesDocument {
    const record = this.db.getServer(serverId);
    if (!record) throw new Error(`No server record with id ${serverId}`);

    const filePath = this.propertiesPath(serverId);
    const file = fs.existsSync(filePath)
      ? parseProperties(fs.readFileSync(filePath, 'utf8'))
      : { entries: new Map<string, string>(), rawLines: [] };

    const fields: ServerPropertyEntry[] = [];

    for (const field of BEDROCK_SERVER_PROPERTIES_SCHEMA) {
      let raw: string | undefined = file.entries.get(field.key);
      if (raw === undefined) {
        raw = toBedrockRawValue(field, field.default);
      }
      fields.push({
        field: { ...field },
        value: fromBedrockRawValue(field, raw),
      });
    }

    // Unknown keys (not in the schema) are preserved and shown as raw text.
    const unknownLines = file.rawLines
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('!'))
      .filter((line) => {
        const key = line.split(/[=:]/)[0]?.trim();
        return key ? !getBedrockPropertyField(key) : false;
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
  validate(serverId: string, values: Record<string, string>): BedrockPropertyValidationResult {
    const errors: Record<string, string> = {};
    for (const [key, raw] of Object.entries(values)) {
      const field = getBedrockPropertyField(key);
      if (!field) {
        errors[key] = 'Unknown property';
        continue;
      }
      const error = validateBedrockProperty(field, raw);
      if (error) errors[key] = error;
    }
    return { ok: Object.keys(errors).length === 0, errors };
  }

  /**
   * Apply an update: back up the current file, validate, merge, write.
   */
  update(
    serverId: string,
    request: UpdatePropertiesRequest,
  ): { document: ServerPropertiesDocument; validation: BedrockPropertyValidationResult } {
    const validation = this.validate(serverId, request.values);
    if (!validation.ok) {
      return { document: this.read(serverId), validation };
    }

    const record = this.db.getServer(serverId);
    if (!record) throw new Error(`No server record with id ${serverId}`);
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
    // Also write any schema defaults not currently in the file.
    const presentKeys = new Set(existing.entries.keys());
    for (const field of BEDROCK_SERVER_PROPERTIES_SCHEMA) {
      if (!presentKeys.has(field.key) && !overrides.has(field.key)) {
        overrides.set(field.key, toBedrockRawValue(field, field.default));
      }
    }

    const newText = serializeProperties(existing, overrides);
    fs.writeFileSync(filePath, newText, 'utf8');

    const document = this.read(serverId);
    document.lastBackupPath = lastBackupPath;
    document.changedKeys = Object.keys(request.values);
    return { document, validation };
  }
}
