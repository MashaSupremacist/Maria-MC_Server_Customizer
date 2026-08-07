import fs from 'node:fs';
import path from 'node:path';
import yauzl from 'yauzl';

/**
 * Paths that are never overwritten by a pack import/extract. These are live
 * server state or generated on first launch; clobbering them would destroy a
 * running setup (or the world).
 */
export const SKIP_PATHS = new Set([
  'server.properties',
  'eula.txt',
  'banned-ips.json',
  'banned-players.json',
  'ops.json',
  'whitelist.json',
  'usercache.json',
  'playit.key',
  'playit.toml',
]);

/** Top-level folders that are never touched by a pack import. */
export const SKIP_TOP_LEVEL_DIRS = new Set(['world', 'logs', 'crash-reports']);

/** Modpack file extensions we accept. */
export const PACK_EXTENSIONS = new Set(['.mrpack', '.zip']);

/** Strip a leading prefix from a slash-normalized relative path, if present. */
export function stripPrefix(rel: string, prefix: string): string {
  return rel === prefix || rel.startsWith(prefix) ? rel.slice(prefix.length) : rel;
}

/** Whether a pack file path must never overwrite server state. */
export function shouldSkip(rel: string): boolean {
  const top = rel.split('/')[0];
  if (SKIP_TOP_LEVEL_DIRS.has(top)) return true;
  if (SKIP_PATHS.has(rel)) return true;
  // Never install disabled-mod artifacts or other servers' backups.
  if (rel.endsWith('.jar.disabled')) return true;
  if (rel.startsWith('backups/')) return true;
  return false;
}

/** Join a relative path under a root, refusing anything that escapes. */
export function safeJoin(root: string, rel: string): string | null {
  const target = path.resolve(root, rel);
  const rootWithSep = path.resolve(root) + path.sep;
  if (target !== path.resolve(root) && !target.startsWith(rootWithSep)) return null;
  return target;
}

/** List all entry names in a zip, or null if the file is not a valid zip. */
export function listZipEntries(filePath: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
      if (err || !zipfile) {
        resolve(null);
        return;
      }
      const names: string[] = [];
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        names.push(entry.fileName.replace(/\\/g, '/'));
        zipfile.readEntry();
      });
      zipfile.on('end', () => resolve(names));
      zipfile.on('error', () => resolve(null));
    });
  });
}

/** Read a single entry's full text content. */
export function readZipEntryText(filePath: string, entryName: string): Promise<string | null> {
  return new Promise((resolve) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
      if (err || !zipfile) {
        resolve(null);
        return;
      }
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (entry.fileName !== entryName) {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) {
            zipfile.close();
            resolve(null);
            return;
          }
          let text = '';
          stream.on('data', (c: Buffer) => (text += c.toString()));
          stream.on('end', () => {
            zipfile.close();
            resolve(text);
          });
          stream.on('error', () => {
            zipfile.close();
            resolve(null);
          });
        });
      });
      zipfile.on('end', () => {
        zipfile.close();
        resolve(null);
      });
      zipfile.on('error', () => resolve(null));
    });
  });
}

/**
 * Extract a single entry to a destination file (creating parent dirs).
 * Returns whether the entry was found and written.
 */
export function extractZipEntryToFile(
  filePath: string,
  entryName: string,
  destPath: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
      if (err || !zipfile) {
        resolve(false);
        return;
      }
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        try {
          zipfile.close();
        } catch {
          // ignore
        }
        resolve(ok);
      };
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        const name = entry.fileName.replace(/\\/g, '/');
        if (name !== entryName) {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) {
            finish(false);
            return;
          }
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          const out = fs.createWriteStream(destPath);
          stream.pipe(out);
          out.on('error', () => finish(false));
          stream.on('error', () => finish(false));
          out.on('close', () => finish(true));
        });
      });
      zipfile.on('end', () => finish(false));
      zipfile.on('error', () => finish(false));
    });
  });
}

/** Walk a zip, calling the visitor for each file entry. */
export function walkZip(
  filePath: string,
  visitor: (entry: yauzl.Entry, stream: NodeJS.ReadableStream) => void,
): Promise<void> {
  return new Promise((resolve) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
      if (err || !zipfile) {
        resolve();
        return;
      }
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) {
            zipfile.readEntry();
            return;
          }
          let advanced = false;
          const advance = (): void => {
            if (advanced) return;
            advanced = true;
            zipfile.readEntry();
          };
          stream.on('end', advance);
          stream.on('error', advance);
          try {
            visitor(entry, stream);
          } catch {
            advance();
          }
        });
      });
      zipfile.on('end', () => resolve());
      zipfile.on('error', () => resolve());
    });
  });
}

/** Stream a zip entry into a destination file (creating parent dirs). */
export function writeEntryStream(stream: NodeJS.ReadableStream, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const out = fs.createWriteStream(dest);
  stream.pipe(out);
  out.on('error', () => stream.resume());
}
