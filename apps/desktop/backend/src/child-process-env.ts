import path from 'node:path';

/**
 * Environment variables that ordinary Windows command-line programs may need.
 * Backend control-plane values (notably MSC_AUTH_TOKEN) are intentionally not
 * included, so server packs and helper processes cannot inherit them.
 */
const ALLOWED_ENVIRONMENT_KEYS = [
  'ALLUSERSPROFILE',
  'APPDATA',
  'CommonProgramFiles',
  'CommonProgramFiles(x86)',
  'CommonProgramW6432',
  'ComSpec',
  'HOMEDRIVE',
  'HOMEPATH',
  'JAVA_HOME',
  'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'PSModulePath',
  'SystemDrive',
  'SystemRoot',
  'TEMP',
  'TMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'windir',
  // Keep helper processes usable in non-Windows development and CI.
  'HOME',
  'LANG',
  'LC_ALL',
  'SHELL',
  'TMPDIR',
] as const;

export interface ChildProcessEnvironmentOptions {
  /** Source environment; injectable for deterministic tests. */
  source?: NodeJS.ProcessEnv;
  /** Directory to place before the inherited PATH (for selected Java). */
  prependPath?: string;
}

/**
 * Build the minimal environment passed to an untrusted or external child.
 * Key lookup is case-insensitive because Windows commonly exposes `Path`
 * instead of `PATH` and environment names are case-insensitive there.
 */
export function buildChildProcessEnvironment(
  options: ChildProcessEnvironmentOptions = {},
): NodeJS.ProcessEnv {
  const source = options.source ?? process.env;
  const sourceByLowercase = new Map<string, string>();
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) sourceByLowercase.set(key.toLowerCase(), value);
  }

  const result: NodeJS.ProcessEnv = {};
  for (const key of ALLOWED_ENVIRONMENT_KEYS) {
    const value = sourceByLowercase.get(key.toLowerCase());
    if (value !== undefined) result[key] = value;
  }

  if (options.prependPath) {
    const inheritedPath = sourceByLowercase.get('path') ?? '';
    result.PATH = inheritedPath
      ? `${options.prependPath}${path.delimiter}${inheritedPath}`
      : options.prependPath;
  }

  return result;
}
