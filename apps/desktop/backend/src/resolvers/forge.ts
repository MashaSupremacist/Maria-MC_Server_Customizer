import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildChildProcessEnvironment } from '../child-process-env';
import type { FlavorResolver, ResolvedDownload } from './types';
import { fetchMetadata } from '../metadata-fetch';

const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge';

/** Minimal maven-metadata.xml parser (extracts <version> elements). */
function parseMavenVersions(xml: string): string[] {
  const versions: string[] = [];
  const re = /<version>([^<]+)<\/version>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    versions.push(m[1]);
  }
  return versions;
}

/** Sort dotted Forge/Minecraft versions numerically, newest first. */
function compareVersionDescending(a: string, b: string): number {
  const aParts = tokenizeVersion(a);
  const bParts = tokenizeVersion(b);
  const length = Math.max(aParts.length, bParts.length);
  for (let index = 0; index < length; index += 1) {
    const left = aParts[index];
    const right = bParts[index];
    if (left === undefined && right === undefined) return 0;
    // An otherwise identical unqualified release is newer than a qualifier.
    if (left === undefined) return typeof right === 'string' ? -1 : 1;
    if (right === undefined) return typeof left === 'string' ? 1 : -1;
    if (left === right) continue;
    if (typeof left === 'number' && typeof right === 'number') return right - left;
    if (typeof left === 'number') return -1;
    if (typeof right === 'number') return 1;
    return right.localeCompare(left, undefined, { numeric: true, sensitivity: 'base' });
  }
  return 0;
}

function tokenizeVersion(version: string): Array<number | string> {
  return (version.match(/\d+|[a-z]+/gi) ?? []).map((part) =>
    /^\d+$/.test(part) ? Number(part) : part.toLowerCase(),
  );
}

/**
 * Resolver for Forge servers. Forge ships an installer jar; the generic
 * pipeline downloads it, then the installStep runs `java -jar installer.jar
 * --installServer` which generates the server jar + libraries.
 */
export class ForgeResolver implements FlavorResolver {
  private readonly fetchImpl: typeof fetch;
  private readonly mavenUrl: string;
  private readonly metadataTimeoutMs: number;

  constructor(options: { fetchImpl?: typeof fetch; mavenUrl?: string; metadataTimeoutMs?: number } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.mavenUrl = options.mavenUrl ?? FORGE_MAVEN;
    this.metadataTimeoutMs = options.metadataTimeoutMs ?? 15_000;
  }

  /** All Forge versions (e.g. "1.21.1-52.0.57"), newest first. */
  async listVersions(signal?: AbortSignal): Promise<string[]> {
    const res = await fetchMetadata(`${this.mavenUrl}/maven-metadata.xml`, {
      fetchImpl: this.fetchImpl,
      signal,
      timeoutMs: this.metadataTimeoutMs,
    });
    if (!res.ok) throw new Error(`Failed to fetch Forge versions (${res.status})`);
    return parseMavenVersions(res.text).sort(compareVersionDescending);
  }

  /** Forge version strings for a specific Minecraft version, newest first. */
  async listVersionsForGame(gameVersion: string, signal?: AbortSignal): Promise<string[]> {
    const all = await this.listVersions(signal);
    return all.filter((v) => v.startsWith(`${gameVersion}-`));
  }

  async supports(version: string): Promise<boolean> {
    const list = await this.listVersionsForGame(version);
    return list.length > 0;
  }

  async resolveDownloads(request: {
    version: string;
    forgeBuild?: string;
    signal?: AbortSignal;
  }): Promise<ResolvedDownload[]> {
    const forgeVersion = await this.resolveForgeVersion(request.version, request.forgeBuild, request.signal);
    const artifactUrl = `${this.mavenUrl}/${forgeVersion}/forge-${forgeVersion}-installer.jar`;
    const checksums = await this.resolveArtifactChecksums(artifactUrl, request.signal);
    return [
      {
        url: artifactUrl,
        fileName: 'forge-installer.jar',
        digest: checksums.sha256
          ? { algorithm: 'sha256', value: checksums.sha256 }
          : checksums.sha1
            ? { algorithm: 'sha1', value: checksums.sha1 }
            : undefined,
        sha1: checksums.sha1,
      },
    ];
  }

  /**
   * Run `java -jar forge-installer.jar --installServer` in the server folder.
   * The installer generates `forge-<mc>-<build>.jar` (server) + libraries.
   */
  async installStep(request: {
    version: string;
    serverFolder: string;
    forgeBuild?: string;
    javaPath?: string | null;
    signal?: AbortSignal;
  }): Promise<void> {
    const forgeVersion = await this.resolveForgeVersion(request.version, request.forgeBuild, request.signal);
    const installerJar = path.join(request.serverFolder, 'forge-installer.jar');
    if (!fs.existsSync(installerJar)) {
      throw new Error(`Forge installer not found: ${installerJar}`);
    }

    // Resolve a java executable: prefer the configured server java, then
    // JAVA_HOME, then PATH. Packaged machines often have no Java on PATH, so
    // the configured javaPath is what makes Forge converts work there.
    let javaPath: string;
    if (request.javaPath) {
      // An explicitly configured path is authoritative: fail loudly rather
      // than silently falling back to PATH when it is broken.
      if (!fs.existsSync(request.javaPath)) {
        throw new Error(
          `Java executable not found: ${request.javaPath}. Configure a valid Java path in Settings, then try again.`,
        );
      }
      javaPath = request.javaPath;
    } else if (process.env.JAVA_HOME) {
      const javaHomeExe = path.join(process.env.JAVA_HOME, 'bin', 'java.exe');
      const javaHomeBin = path.join(process.env.JAVA_HOME, 'bin', 'java');
      javaPath = fs.existsSync(javaHomeExe) ? javaHomeExe : javaHomeBin;
    } else {
      // Last resort: rely on PATH.
      javaPath = 'java';
    }

    await runProcess(
      javaPath,
      ['-jar', installerJar, '--installServer'],
      request.serverFolder,
    );

    // Legacy installers write a runnable root jar. Modern installers instead
    // generate run.bat plus user_jvm_args.txt and a versioned win_args.txt
    // under libraries/. Both are complete, runnable Forge installations.
    const expected = `forge-${forgeVersion}.jar`;
    const serverJar = path.join(request.serverFolder, expected);
    const shim = path.join(request.serverFolder, `forge-${forgeVersion}-shim.jar`);
    if (fs.existsSync(serverJar)) {
      fs.rmSync(shim, { force: true });
    } else if (!fs.existsSync(shim) && !hasModernForgeLauncher(request.serverFolder, forgeVersion)) {
      // Fall back to any forge-*.jar present (older installer naming).
      const candidates = fs
        .readdirSync(request.serverFolder)
        .filter((f) => f.startsWith('forge-') && f.endsWith('.jar') && f !== 'forge-installer.jar');
      if (candidates.length === 0) {
        throw new Error(
          `Forge installer produced neither a runnable server jar nor a modern run.bat/argument-file layout (expected ${expected})`,
        );
      }
      fs.renameSync(path.join(request.serverFolder, candidates[0]), serverJar);
    }
    // Clean up the installer so it is never launched as the server jar.
    fs.rmSync(installerJar, { force: true });
  }

  private async resolveForgeVersion(
    gameVersion: string,
    buildOverride?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const list = await this.listVersionsForGame(gameVersion, signal);
    if (list.length === 0) {
      throw new Error(`No Forge build available for Minecraft ${gameVersion}`);
    }
    if (buildOverride) {
      const match = list.find((v) => v === `${gameVersion}-${buildOverride}`);
      if (!match) {
        throw new Error(`Forge build ${buildOverride} not found for Minecraft ${gameVersion}`);
      }
      return match;
    }
    return list[0];
  }

  private async resolveArtifactChecksums(
    artifactUrl: string,
    signal?: AbortSignal,
  ): Promise<{ sha256?: string; sha1?: string }> {
    const [sha256, sha1] = await Promise.all([
      this.readMavenChecksum(`${artifactUrl}.sha256`, 'sha256', signal),
      this.readMavenChecksum(`${artifactUrl}.sha1`, 'sha1', signal),
    ]);
    return {
      ...(sha256 ? { sha256 } : {}),
      ...(sha1 ? { sha1 } : {}),
    };
  }

  private async readMavenChecksum(
    url: string,
    algorithm: 'sha1' | 'sha256',
    signal?: AbortSignal,
  ): Promise<string | null> {
    let response: Response;
    try {
      const metadata = await fetchMetadata(url, {
        fetchImpl: this.fetchImpl,
        signal,
        timeoutMs: this.metadataTimeoutMs,
      });
      response = new Response(metadata.text, { status: metadata.status });
    } catch (error) {
      if (signal?.aborted) throw error;
      // Some Maven mirrors omit sidecar checksum files. The verified download
      // helper will still enforce bounds/timeouts even when no digest exists.
      return null;
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Failed to fetch Forge ${algorithm.toUpperCase()} checksum (${response.status})`);
    }
    const text = await response.text();
    const length = algorithm === 'sha256' ? 64 : 40;
    const match = text.match(new RegExp(`(?:^|\\s)([a-fA-F0-9]{${length}})(?:\\s|$)`));
    if (!match) {
      throw new Error(`Forge ${algorithm.toUpperCase()} checksum metadata is invalid`);
    }
    return match[1].toLowerCase();
  }
}

/** Validate the launcher-only layout generated by current Forge installers. */
function hasModernForgeLauncher(serverFolder: string, forgeVersion: string): boolean {
  let rootEntries: string[];
  try {
    rootEntries = fs.readdirSync(serverFolder);
  } catch {
    return false;
  }
  const runBat = rootEntries.find((entry) => entry.toLowerCase() === 'run.bat');
  const userArgs = rootEntries.find((entry) => entry.toLowerCase() === 'user_jvm_args.txt');
  if (!runBat || !userArgs) return false;

  const winArgs = path.join(
    serverFolder,
    'libraries',
    'net',
    'minecraftforge',
    'forge',
    forgeVersion,
    'win_args.txt',
  );
  if (!fs.existsSync(winArgs) || !fs.statSync(winArgs).isFile()) return false;

  // Reject an unrelated run.bat accidentally left in the folder. The modern
  // Forge script names both generated argument files in its Java invocation.
  try {
    const launcher = fs.readFileSync(path.join(serverFolder, runBat), 'utf8').replace(/\\/g, '/');
    return /@user_jvm_args\.txt/i.test(launcher) && /@libraries\/.*\/win_args\.txt/i.test(launcher);
  } catch {
    return false;
  }
}

/** Run a child process to completion, capturing output for diagnostics. */
function runProcess(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Windows cannot exec a .cmd/.bat directly; route them through cmd /c
    // (mirrors java-service.ts handling of java wrappers).
    const isCmdWrapper = /\.(cmd|bat)$/i.test(command);
    const child = isCmdWrapper
      ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command, ...args], {
          cwd,
          windowsHide: true,
          env: buildChildProcessEnvironment(),
        })
      : spawn(command, args, {
          cwd,
          windowsHide: true,
          env: buildChildProcessEnvironment(),
        });
    const output: string[] = [];
    child.stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
    child.on('error', (err) => reject(new Error(`Failed to run ${command}: ${err.message}`)));
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const tail = output.join('').trim().split(/\r?\n/).slice(-8).join('\n');
      const detail = tail ? `\n${tail}` : '';
      reject(new Error(`Forge installer exited with code ${code}${detail}`));
    });
  });
}
