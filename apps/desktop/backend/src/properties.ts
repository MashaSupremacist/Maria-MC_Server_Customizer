import fs from 'node:fs';

/** A parsed server.properties file, preserving comments and line order. */
export interface PropertiesFile {
  /** Key → value for the known/parsed entries (comments excluded). */
  entries: Map<string, string>;
  /** Original raw lines, in order (comments, blanks, and entries). */
  rawLines: string[];
}

/**
 * Parse a Java .properties-style file used by Minecraft (server.properties,
 * bukkit.yml-style is not covered). Preserves comments (# and !) and blank
 * lines so a save round-trip does not destroy unrelated content.
 */
export function parseProperties(text: string): PropertiesFile {
  const rawLines: string[] = [];
  const entries = new Map<string, string>();

  for (const raw of text.split(/\r?\n/)) {
    rawLines.push(raw);
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;

    const eqIndex = line.indexOf('=');
    const colonIndex = line.indexOf(':');
    let sep = -1;
    if (eqIndex >= 0 && (colonIndex < 0 || eqIndex < colonIndex)) {
      sep = eqIndex;
    } else if (colonIndex >= 0) {
      sep = colonIndex;
    }
    if (sep < 0) continue; // no separator → treat as comment-ish / skip

    const key = line.slice(0, sep).trim();
    let value = line.slice(sep + 1).trim();
    // Strip a single trailing comment (space + #...) only when preceded by a space.
    value = unescapeProperties(value);
    if (key) entries.set(key, value);
  }

  return { entries, rawLines };
}

/** Serialize entries back, preserving original lines where the key is known. */
export function serializeProperties(file: PropertiesFile, overrides: Map<string, string>): string {
  const seen = new Set<string>();
  const lines: string[] = [];

  for (const raw of file.rawLines) {
    const line = raw.trim();
    const key = lineKey(line);
    if (key !== null && overrides.has(key)) {
      lines.push(`${key}=${escapeProperties(overrides.get(key) ?? '')}`);
      seen.add(key);
      continue;
    }
    lines.push(raw);
  }

  // Append any new keys not already in the file.
  for (const [key, value] of overrides) {
    if (!seen.has(key)) {
      lines.push(`${key}=${escapeProperties(value)}`);
    }
  }

  return lines.join('\n') + '\n';
}

/** Extract the key from a non-comment line, or null. */
function lineKey(line: string): string | null {
  if (line === '' || line.startsWith('#') || line.startsWith('!')) return null;
  const eqIndex = line.indexOf('=');
  const colonIndex = line.indexOf(':');
  let sep = -1;
  if (eqIndex >= 0 && (colonIndex < 0 || eqIndex < colonIndex)) {
    sep = eqIndex;
  } else if (colonIndex >= 0) {
    sep = colonIndex;
  }
  if (sep < 0) return null;
  const key = line.slice(0, sep).trim();
  return key || null;
}

/** Minimal escaping for property values (spaces, colons, equals, hashes). */
function escapeProperties(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/=/g, '\\=')
    .replace(/#/g, '\\#')
    .replace(/^ /, '\\ ');
}

/** Minimal unescaping for property values. */
function unescapeProperties(value: string): string {
  return value
    .replace(/\\([\\:=#! ])/g, '$1')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
}

/** Read a server.properties file, returning null if absent. */
export function readPropertiesFile(filePath: string): PropertiesFile | null {
  if (!fs.existsSync(filePath)) return null;
  return parseProperties(fs.readFileSync(filePath, 'utf8'));
}
