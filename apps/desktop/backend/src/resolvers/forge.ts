import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { FlavorResolver, ResolvedDownload } from './types';

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

/**
 * Resolver for Forge servers. Forge ships an installer jar; the generic
 * pipeline downloads it, then the installStep runs `java -jar installer.jar
 * --installServer` which generates the server jar + libraries.
 */
export class ForgeResolver implements FlavorResolver {
  private readonly fetchImpl: typeof fetch;
  private readonly mavenUrl: string;

  constructor(options: { fetchImpl?: typeof fetch; mavenUrl?: string } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.mavenUrl = options.mavenUrl ?? FORGE_MAVEN;
  }

  /** All Forge versions (e.g. "1.21.1-52.0.57"), newest first. */
  async listVersions(): Promise<string[]> {
    const res = await this.fetchImpl(`${this.mavenUrl}/maven-metadata.xml`);
    if (!res.ok) throw new Error(`Failed to fetch Forge versions (${res.status})`);
    const xml = await res.text();
    return parseMavenVersions(xml);
  }

  /** Forge version strings for a specific Minecraft version, newest first. */
  async listVersionsForGame(gameVersion: string): Promise<string[]> {
    const all = await this.listVersions();
    return all.filter((v) => v.startsWith(`${gameVersion}-`));
  }

  async supports(version: string): Promise<boolean> {
    const list = await this.listVersionsForGame(version);
    return list.length > 0;
  }

  async resolveDownloads(request: {
    version: string;
    forgeBuild?: string;
  }): Promise<ResolvedDownload[]> {
    const forgeVersion = await this.resolveForgeVersion(request.version, request.forgeBuild);
    return [
      {
        url: `${this.mavenUrl}/${forgeVersion}/forge-${forgeVersion}-installer.jar`,
        fileName: 'forge-installer.jar',
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
  }): Promise<void> {
    const forgeVersion = await this.resolveForgeVersion(request.version, request.forgeBuild);
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

    // The installer writes the runnable server jar: forge-<mc>-<build>.jar
    // (some modern installers also drop a -shim.jar, which is a thin launcher
    // that is also runnable). Prefer the real jar and remove the shim so the
    // launcher never picks the shim over the full server jar.
    const expected = `forge-${forgeVersion}.jar`;
    const serverJar = path.join(request.serverFolder, expected);
    const shim = path.join(request.serverFolder, `forge-${forgeVersion}-shim.jar`);
    if (fs.existsSync(serverJar)) {
      fs.rmSync(shim, { force: true });
    } else if (!fs.existsSync(shim)) {
      // Fall back to any forge-*.jar present (older installer naming).
      const candidates = fs
        .readdirSync(request.serverFolder)
        .filter((f) => f.startsWith('forge-') && f.endsWith('.jar') && f !== 'forge-installer.jar');
      if (candidates.length === 0) {
        throw new Error(`Forge installer did not produce a server jar (expected ${expected})`);
      }
      fs.renameSync(path.join(request.serverFolder, candidates[0]), serverJar);
    }
    // Clean up the installer so it is never launched as the server jar.
    fs.rmSync(installerJar, { force: true });
  }

  private async resolveForgeVersion(
    gameVersion: string,
    buildOverride?: string,
  ): Promise<string> {
    const list = await this.listVersionsForGame(gameVersion);
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
        })
      : spawn(command, args, { cwd, windowsHide: true });
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
