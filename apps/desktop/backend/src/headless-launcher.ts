import fs from 'node:fs';
import path from 'node:path';

export interface ModernForgeLaunch {
  /** The generated launcher retained for diagnostics; it is not executed. */
  launcherPath: string;
  /** Java response-file arguments, relative to the server root. */
  args: string[];
}

export type BatchLaunchPlan =
  | { kind: 'run-batch'; appendNogui: boolean }
  | { kind: 'unsupported'; message: string };

/**
 * Recognize Forge's generated `run.bat` layout and launch Java directly.
 * This preserves its response files while avoiding both cmd.exe wrappers and
 * Minecraft's desktop GUI.
 */
export function resolveModernForgeLaunch(folderPath: string): ModernForgeLaunch | null {
  const launcherPath = path.join(folderPath, 'run.bat');
  const userJvmArgsPath = path.join(folderPath, 'user_jvm_args.txt');
  if (!isFile(launcherPath) || !isFile(userJvmArgsPath)) return null;

  let launcher: string;
  try {
    launcher = fs.readFileSync(launcherPath, 'utf8');
  } catch {
    return null;
  }

  // The generated launcher names both response files. Do not treat an
  // unrelated run.bat as Forge merely because a similarly named file exists.
  if (!/@user_jvm_args\.txt/i.test(launcher) || !/@libraries[\\/].*win_args\.txt/i.test(launcher)) {
    return null;
  }

  const forgeRoot = path.join(folderPath, 'libraries', 'net', 'minecraftforge', 'forge');
  let versions: fs.Dirent[];
  try {
    versions = fs.readdirSync(forgeRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates = versions
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(forgeRoot, entry.name, 'win_args.txt'))
    .filter(isFile)
    .sort((a, b) => a.localeCompare(b));
  if (candidates.length !== 1) return null;

  const gameArgsPath = candidates[0];
  return {
    launcherPath,
    args: [
      `@${path.relative(folderPath, userJvmArgsPath).replace(/\\/g, '/')}`,
      `@${path.relative(folderPath, gameArgsPath).replace(/\\/g, '/')}`,
      'nogui',
    ],
  };
}

/**
 * Decide whether a user-provided batch launcher can be supervised headlessly.
 * It must either already contain `nogui` or forward `%*` so the app can add
 * it. Launchers that use `start`/`javaw` would detach or hide output and are
 * refused rather than creating an unmanaged window.
 */
export function inspectBatchLauncherForHeadlessMode(launcherPath: string): BatchLaunchPlan {
  let content: string;
  try {
    content = fs.readFileSync(launcherPath, 'utf8');
  } catch {
    return { kind: 'unsupported', message: 'The batch launcher could not be read.' };
  }

  const activeLines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^::/.test(line) && !/^rem\b/i.test(line));

  if (activeLines.some((line) => /(^|\s)start(?:\s|$)/i.test(line))) {
    return {
      kind: 'unsupported',
      message: 'This launcher uses the Windows START command, which detaches the server from the Customizer.',
    };
  }
  if (activeLines.some((line) => /(^|\s)javaw(?:\.exe)?(?:\s|$)/i.test(line))) {
    return {
      kind: 'unsupported',
      message: 'This launcher uses javaw, which prevents the Customizer from receiving server logs.',
    };
  }
  if (activeLines.some((line) => /(?:^|\s)(?:nogui|--?nogui)(?:\s|$)/i.test(line))) {
    return { kind: 'run-batch', appendNogui: false };
  }
  if (/%\*/.test(content)) {
    return { kind: 'run-batch', appendNogui: true };
  }
  return {
    kind: 'unsupported',
    message: 'This launcher does not include or forward the required "nogui" argument. Add "nogui" to its Java command or use a supported Forge run.bat.',
  };
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}
