import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findServerExecutable,
  findServerJar,
  isBedrockOnlineLine,
  parseBedrockPlayerDelta,
  parseBedrockPlayerName,
  parsePlayerCount,
  parsePlayerDelta,
  parsePlayerList,
  parsePlayerName,
  ProcessManager,
  type ServerConfig,
} from '../process-manager';

/**
 * Fake Java for tests.
 *
 * ProcessManager always builds java-style args:
 *   -Xms<mem>M -Xmx<mem>M [jvmArgs...] -jar <jar> nogui
 *
 * A real java.exe accepts those. To fake that without compiling, the test
 * points javaPath at cmd.exe with jvmArgs = ['/c', fakeJavaCmd], and the .cmd
 * wrapper ignores the trailing java-style args and runs a Node script that
 * behaves like a Vanilla server. This only affects tests; production always
 * spawns a real java.exe with shell:false.
 */
const FAKE_JAVA_CMD = `@echo off\r\nnode "%~dp0fake-server.js" %*\r\n`;

const FAKE_SERVER_SCRIPT = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
console.log('[FakeServer] Starting...');
setTimeout(() => {
  console.log('Done (1.234s)! For help, type "help"');
}, 300);
rl.on('line', (line) => {
  if (line.trim() === 'stop') {
    console.log('Stopping server...');
    process.exit(0);
  }
  console.log('echo: ' + line);
});
process.on('SIGTERM', () => { process.exit(0); });
`;

let tempDir: string;

function makeServerConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    serverId: 'test-server',
    name: 'Test Server',
    folderPath: tempDir,
    javaPath: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
    memoryMb: 1024,
    jvmArgs: ['/c', path.join(tempDir, 'fake-java.cmd')],
    port: 25565,
    ...overrides,
  };
}

function writeFakeServer(): void {
  fs.writeFileSync(path.join(tempDir, 'fake-java.cmd'), FAKE_JAVA_CMD);
  fs.writeFileSync(path.join(tempDir, 'fake-server.js'), FAKE_SERVER_SCRIPT);
  fs.writeFileSync(path.join(tempDir, 'server.jar'), 'not a real jar');
  // Most tests exercise process behavior, not the EULA gate; write it so the
  // server is allowed to start. The missing-eula test creates the folder
  // without it on purpose.
  fs.writeFileSync(path.join(tempDir, 'eula.txt'), 'eula=true\n');
}

describe('findServerJar', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-jar-'));
  });
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('prefers server.jar', () => {
    writeFakeServer();
    expect(findServerJar(tempDir)).toBe(path.join(tempDir, 'server.jar'));
  });

  it('falls back to a single other jar', () => {
    fs.writeFileSync(path.join(tempDir, 'paper-1.21.jar'), 'x');
    expect(findServerJar(tempDir)).toBe(path.join(tempDir, 'paper-1.21.jar'));
  });

  it('returns null when there are multiple jars and no server.jar', () => {
    fs.writeFileSync(path.join(tempDir, 'a.jar'), 'x');
    fs.writeFileSync(path.join(tempDir, 'b.jar'), 'x');
    expect(findServerJar(tempDir)).toBeNull();
  });

  it('ignores a modern forge installer jar (forge-<mc>-<build>-installer.jar)', () => {
    // Regression: forge-1.19.2-43.3.5-installer.jar is a bootstrap GUI, not a
    // runnable server. It must not be treated as the forge server jar.
    fs.writeFileSync(path.join(tempDir, 'forge-1.19.2-43.3.5-installer.jar'), 'x');
    expect(findServerJar(tempDir, 'forge')).toBeNull();
    // A real forge server jar alongside it still wins.
    fs.writeFileSync(path.join(tempDir, 'forge-1.19.2-43.3.5.jar'), 'x');
    expect(findServerJar(tempDir, 'forge')).toBe(path.join(tempDir, 'forge-1.19.2-43.3.5.jar'));
  });

  it('returns null when the folder does not exist', () => {
    expect(findServerJar(path.join(tempDir, 'missing'))).toBeNull();
  });
});

describe('ProcessManager', () => {
  let manager: ProcessManager;
  const states: Array<{ state: string; exitCode: number | null }> = [];
  const logs: string[] = [];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-proc-'));
    states.length = 0;
    logs.length = 0;
    manager = new ProcessManager({
      onState: (serverId, state, exitCode) => {
        states.push({ state, exitCode });
      },
      onLog: (_serverId, log) => {
        logs.push(log.text);
      },
      onStats: () => {
        // not asserted here
      },
    });
  });

  afterEach(async () => {
    manager.shutdown();
    // Wait for the child to fully exit so the temp dir is not file-locked.
    await waitFor(() => manager.runningServerId === null, 5000).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 200));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('starts, reaches online, and emits logs', async () => {
    writeFakeServer();
    const err = manager.start(makeServerConfig());
    expect(err).toBeNull();
    expect(manager.runningServerId).toBe('test-server');

    await waitFor(() => logs.some((l) => l.includes('Done (1.234s)')));
    expect(logs.some((l) => l.startsWith('[FakeServer] Starting'))).toBe(true);
    expect(states.some((s) => s.state === 'online')).toBe(true);
  });

  it('blocks a second start while one is running', async () => {
    writeFakeServer();
    manager.start(makeServerConfig());
    const err = manager.start(makeServerConfig());
    expect(err?.code).toBe('already-running');
    manager.stop();
    await waitFor(() => manager.runningServerId === null, 5000);
  });

  it('fails with missing-jar when there is no jar', () => {
    const err = manager.start(makeServerConfig());
    expect(err?.code).toBe('missing-jar');
  });

  it('fails with folder-not-found when the folder is missing', () => {
    const err = manager.start(
      makeServerConfig({ folderPath: path.join(tempDir, 'nope') }),
    );
    expect(err?.code).toBe('folder-not-found');
  });

  it('fails with missing-java when javaPath is absent', () => {
    writeFakeServer();
    const err = manager.start(
      makeServerConfig({ javaPath: path.join(tempDir, 'missing-java.exe') }),
    );
    expect(err?.code).toBe('missing-java');
  });

  it('fails with missing-eula when there is no eula.txt', () => {
    // Build the folder manually (writeFakeServer writes an eula.txt).
    fs.writeFileSync(path.join(tempDir, 'fake-java.cmd'), FAKE_JAVA_CMD);
    fs.writeFileSync(path.join(tempDir, 'fake-server.js'), FAKE_SERVER_SCRIPT);
    fs.writeFileSync(path.join(tempDir, 'server.jar'), 'not a real jar');
    const err = manager.start(makeServerConfig());
    expect(err?.code).toBe('missing-eula');
    expect(err?.message).toContain('eula.txt');
  });

  it('starts when eula.txt exists', async () => {
    writeFakeServer();
    const err = manager.start(makeServerConfig());
    expect(err).toBeNull();
    manager.stop();
    await waitFor(() => manager.runningServerId === null, 5000);
  });

  it('launches a batch launcher (start.bat) via cmd /c with no jar and no java', async () => {
    // A server-pack folder with only a start.bat (no server.jar, no eula.txt,
    // no configured java). The script owns the java invocation.
    fs.writeFileSync(path.join(tempDir, 'fake-server.js'), FAKE_SERVER_SCRIPT);
    fs.writeFileSync(
      path.join(tempDir, 'start.bat'),
      `@echo off\r\nnode "%~dp0fake-server.js" %*\r\n`,
    );
    const err = manager.start(
      makeServerConfig({
        javaPath: '',
        jvmArgs: [],
        folderPath: tempDir,
      }),
    );
    expect(err).toBeNull();
    await waitFor(() => logs.some((l) => l.includes('Done (1.234s)')));
    expect(states.some((s) => s.state === 'online')).toBe(true);
    // Started via the batch launcher, not java -jar.
    expect(logs.some((l) => l.includes('via batch launcher'))).toBe(true);
    manager.stop();
    await waitFor(() => manager.runningServerId === null, 5000);
  });

  it('launches a batch launcher whose folder path contains spaces', async () => {
    // Regression: paths like "C:\Servers\Minecraft Servers\CARP\start.bat"
    // were passed to cmd /c unquoted, so cmd split on the space and tried to
    // run "C:\Servers\Minecraft". The launcher must be invoked by filename
    // with the server folder as cwd.
    const spaced = path.join(tempDir, 'My Servers', 'CARP');
    fs.mkdirSync(spaced, { recursive: true });
    fs.writeFileSync(path.join(spaced, 'fake-server.js'), FAKE_SERVER_SCRIPT);
    fs.writeFileSync(
      path.join(spaced, 'start.bat'),
      `@echo off\r\nnode "%~dp0fake-server.js" %*\r\n`,
    );
    const err = manager.start(
      makeServerConfig({
        javaPath: '',
        jvmArgs: [],
        folderPath: spaced,
      }),
    );
    expect(err).toBeNull();
    await waitFor(() => logs.some((l) => l.includes('Done (1.234s)')));
    expect(states.some((s) => s.state === 'online')).toBe(true);
    manager.stop();
    await waitFor(() => manager.runningServerId === null, 5000);
  });

  it('puts the configured java bin on PATH for a batch launcher', async () => {
    // Regression: run.bat calls bare `java`, which resolves via PATH. When a
    // javaPath is configured, its bin folder must come first so the pack uses
    // the selected runtime instead of whatever the system PATH provides.
    const fakeBin = path.join(tempDir, 'fake-java', 'bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    const fakeJava = path.join(fakeBin, 'java.cmd');
    const marker = path.join(tempDir, 'fake-java-invoked.txt');
    // The fake java.cmd writes a marker file when invoked via PATH.
    fs.writeFileSync(fakeJava, `@echo off\r\n> "${marker}" echo ran\r\n`);
    fs.writeFileSync(
      path.join(tempDir, 'start.bat'),
      // The launcher calls bare `java` exactly like a real pack's run.bat.
      '@echo off\r\njava\r\n',
    );
    const err = manager.start(
      makeServerConfig({
        javaPath: fakeJava,
        jvmArgs: [],
        folderPath: tempDir,
      }),
    );
    expect(err).toBeNull();
    // The bare `java` in start.bat resolved to the configured fake runtime,
    // which wrote the marker. A marker file is used rather than log capture
    // because a child .cmd's stdout isn't guaranteed to reach the parent pipe.
    await waitFor(() => fs.existsSync(marker), 10000);
    manager.stop();
    await waitFor(() => manager.runningServerId === null, 5000);
  });

  it('sends commands via stdin', async () => {
    writeFakeServer();
    manager.start(makeServerConfig());
    const ok = manager.sendCommand('say hello');
    expect(ok).toBe(true);
    await waitFor(() => logs.some((l) => l.includes('echo: say hello')));
    expect(logs.some((l) => l === '> say hello')).toBe(true);
    manager.stop();
    await waitFor(() => manager.runningServerId === null, 5000);
  });

  it('marks a graceful stop as offline', async () => {
    writeFakeServer();
    manager.start(makeServerConfig());
    await waitFor(() => logs.some((l) => l.includes('Done (1.234s)')));
    manager.stop();
    await waitFor(() => manager.runningServerId === null, 5000);
    const last = states[states.length - 1];
    expect(last.state).toBe('offline');
  });

  it('marks an unexpected exit as crashed', async () => {
    writeFakeServer();
    manager.start(makeServerConfig());
    await waitFor(() => logs.some((l) => l.includes('Done (1.234s)')));
    manager.forceKill();
    await waitFor(() => manager.runningServerId === null, 5000);
    const last = states[states.length - 1];
    expect(last.state).toBe('crashed');
  });

  it('reports correct status shape', async () => {
    writeFakeServer();
    manager.start(makeServerConfig());
    const status = manager.getStatus('test-server');
    expect(status.state).toBe('starting');
    expect(status.serverId).toBe('test-server');
    expect(status.pid).toBeTypeOf('number');
    expect(Array.isArray(status.logs)).toBe(true);
    expect(status.address).toBe('127.0.0.1:25565');
    expect(status.stats).toMatchObject({ cpuPercent: 0, memoryMb: 0, playerCount: null });
    // Stop it so teardown can remove the temp dir.
    manager.stop();
    await waitFor(() => manager.runningServerId === null, 5000);
  });

  it('seeds playerCount to 0 when the server comes online so deltas work', async () => {
    writeFakeServer();
    manager.start(makeServerConfig());
    await waitFor(() => logs.some((l) => l.includes('Done (1.234s)')));
    const status = manager.getStatus('test-server');
    expect(status.state).toBe('online');
    expect(status.stats.playerCount).toBe(0);
    manager.stop();
    await waitFor(() => manager.runningServerId === null, 5000);
  });

  it('tracks online player names from join/leave lines', async () => {
    const FAKE = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
console.log('Done (1.234s)! For help, type "help"');
setTimeout(() => console.log('Steve joined the game'), 100);
setTimeout(() => console.log('Alex joined the game'), 200);
setTimeout(() => console.log('Steve left the game'), 300);
setTimeout(() => process.exit(0), 500);
rl.on('line', () => {});
`;
    writeFakeServer();
    fs.writeFileSync(path.join(tempDir, 'fake-server.js'), FAKE);
    manager.start(makeServerConfig());

    await waitFor(() => manager.getStatus('test-server').stats.onlinePlayers.length === 2);
    expect(manager.getStatus('test-server').stats.onlinePlayers).toEqual(['Steve', 'Alex']);
    expect(manager.getStatus('test-server').stats.playerCount).toBe(2);

    await waitFor(
      () => manager.getStatus('test-server').stats.onlinePlayers.length === 1,
      5000,
    );
    expect(manager.getStatus('test-server').stats.onlinePlayers).toEqual(['Alex']);
    expect(manager.getStatus('test-server').stats.playerCount).toBe(1);

    await waitFor(() => manager.runningServerId === null, 5000);
  });

  it('tracks players from prefixed join lines in the same chunk as the Done line', async () => {
    // Emulate a real Vanilla server (modern versions no longer print the
    // periodic "There are N of a max of M players online" report, so the only
    // signal is the prefixed join/leave lines). The Done seed and the first
    // join land in the same stdout write, which previously dropped the delta
    // because playerCount was still null when the join was processed.
    const FAKE = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
process.stdout.write(
  'Done (1.234s)! For help, type "help"\\n' +
  '[21:12:00] [Server thread/INFO]: Steve joined the game\\n'
);
setTimeout(() => process.exit(0), 500);
rl.on('line', () => {});
`;
    writeFakeServer();
    fs.writeFileSync(path.join(tempDir, 'fake-server.js'), FAKE);
    manager.start(makeServerConfig());

    await waitFor(
      () => manager.getStatus('test-server').stats.onlinePlayers.length === 1,
      5000,
    );
    expect(manager.getStatus('test-server').stats.onlinePlayers).toEqual(['Steve']);
    expect(manager.getStatus('test-server').stats.playerCount).toBe(1);

    await waitFor(() => manager.runningServerId === null, 5000);
  });
});

describe('parsePlayerCount', () => {
  it('parses a vanilla player-count line', () => {
    expect(parsePlayerCount('There are 3 of a max of 20 players online: a, b, c')).toBe(3);
    expect(parsePlayerCount('There are 0 of a max of 20 players online:')).toBe(0);
  });

  it('returns null for unrelated lines', () => {
    expect(parsePlayerCount('Done (1.234s)!')).toBeNull();
    expect(parsePlayerCount('[21:12:00] [Server thread/INFO]: Starting server')).toBeNull();
    expect(parsePlayerCount('')).toBeNull();
  });
});

describe('parsePlayerDelta', () => {
  it('detects join and leave deltas', () => {
    expect(parsePlayerDelta('Steve joined the game')).toBe(1);
    expect(parsePlayerDelta('Alex left the game')).toBe(-1);
    expect(parsePlayerDelta('Done (1.234s)!')).toBeNull();
    expect(parsePlayerDelta('')).toBeNull();
  });
});

describe('parsePlayerName', () => {
  it('extracts the player name from join/leave lines', () => {
    expect(parsePlayerName('Steve joined the game')).toBe('Steve');
    expect(parsePlayerName('Alex left the game')).toBe('Alex');
    expect(parsePlayerName('player_42 joined the game')).toBe('player_42');
    expect(parsePlayerName('Done (1.234s)!')).toBeNull();
    expect(parsePlayerName('')).toBeNull();
  });

  it('extracts the name from real prefixed server log lines', () => {
    expect(parsePlayerName('[21:12:00] [Server thread/INFO]: Steve joined the game')).toBe('Steve');
    expect(parsePlayerName('[21:12:05] [Server thread/INFO]: Alex left the game')).toBe('Alex');
    expect(parsePlayerName('[21:12:00] [Server thread/WARN]: Steve left the game')).toBe('Steve');
  });
});

describe('parsePlayerList', () => {
  it('parses names from a full player-count report', () => {
    expect(parsePlayerList('There are 2 of a max of 20 players online: Steve, Alex')).toEqual([
      'Steve',
      'Alex',
    ]);
    expect(parsePlayerList('There are 1 of a max of 20 players online: Steve')).toEqual(['Steve']);
    expect(parsePlayerList('There are 3 of a max of 20 players online: a, b, c')).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('returns an empty list when the report lists nobody', () => {
    expect(parsePlayerList('There are 0 of a max of 20 players online:')).toEqual([]);
  });

  it('returns null when no names are listed (modern report omits them)', () => {
    expect(parsePlayerList('There are 0 of a max of 20 players online')).toBeNull();
  });

  it('returns null for unrelated lines', () => {
    expect(parsePlayerList('Done (1.234s)!')).toBeNull();
    expect(parsePlayerList('')).toBeNull();
  });
});

describe('parseBedrockPlayerName', () => {
  it('extracts the name from Bedrock connect/disconnect lines', () => {
    expect(parseBedrockPlayerName('Player connected: Steve, xuid: 123')).toBe('Steve');
    expect(parseBedrockPlayerName('Player disconnected: Alex, xuid: 456')).toBe('Alex');
    expect(parseBedrockPlayerName('Server started.')).toBeNull();
  });
});

function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = (): void => {
      if (predicate()) {
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        reject(new Error('waitFor timed out'));
      } else {
        setTimeout(poll, 50);
      }
    };
    poll();
  });
}

// --- Bedrock Dedicated Server tests ---

/** Fake bedrock_server.exe: a .cmd wrapper that runs a Node script. */
const FAKE_BEDROCK_CMD = `@echo off\r\nnode "%~dp0fake-bedrock.js" %*\r\n`;

const FAKE_BEDROCK_SCRIPT = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
console.log('[BDS] Starting bedrock server...');
setTimeout(() => {
  console.log('Server started.');
  console.log('Level "Bedrock level" started');
}, 300);
rl.on('line', (line) => {
  if (line.trim() === 'stop') {
    console.log('Stopping server...');
    process.exit(0);
  }
  console.log('echo: ' + line);
});
process.on('SIGTERM', () => { process.exit(0); });
`;

describe('findServerExecutable', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-exe-'));
  });
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('finds bedrock_server.exe for the bedrock edition', () => {
    fs.writeFileSync(path.join(tempDir, 'bedrock_server.exe'), 'x');
    expect(findServerExecutable(tempDir, 'bedrock')).toBe(path.join(tempDir, 'bedrock_server.exe'));
  });

  it('accepts a .cmd wrapper for bedrock', () => {
    fs.writeFileSync(path.join(tempDir, 'bedrock_server.cmd'), '@echo off');
    expect(findServerExecutable(tempDir, 'bedrock')).toBe(path.join(tempDir, 'bedrock_server.cmd'));
  });

  it('returns null for bedrock when the exe is missing', () => {
    expect(findServerExecutable(tempDir, 'bedrock')).toBeNull();
  });

  it('delegates to findServerJar for the java edition', () => {
    fs.writeFileSync(path.join(tempDir, 'server.jar'), 'x');
    expect(findServerExecutable(tempDir, 'java')).toBe(path.join(tempDir, 'server.jar'));
  });

  it('falls back to a batch launcher when no jar exists', () => {
    fs.writeFileSync(path.join(tempDir, 'start.bat'), '@echo off');
    expect(findServerExecutable(tempDir, 'java')).toBe(path.join(tempDir, 'start.bat'));
  });

  it('prefers a jar over a batch launcher when both exist', () => {
    fs.writeFileSync(path.join(tempDir, 'server.jar'), 'x');
    fs.writeFileSync(path.join(tempDir, 'start.bat'), '@echo off');
    expect(findServerExecutable(tempDir, 'java')).toBe(path.join(tempDir, 'server.jar'));
  });

  it('returns null when neither a jar nor a batch launcher exists', () => {
    fs.writeFileSync(path.join(tempDir, 'readme.txt'), 'hi');
    expect(findServerExecutable(tempDir, 'java')).toBeNull();
  });
});

describe('Bedrock ProcessManager', () => {
  let manager: ProcessManager;
  const states: Array<{ state: string; exitCode: number | null }> = [];
  const logs: string[] = [];

  function writeFakeBedrock(): void {
    fs.writeFileSync(path.join(tempDir, 'fake-bedrock.cmd'), FAKE_BEDROCK_CMD);
    fs.writeFileSync(path.join(tempDir, 'fake-bedrock.js'), FAKE_BEDROCK_SCRIPT);
    // The ProcessManager finds the executable by name; a .cmd wrapper lets the
    // test avoid needing a real bedrock_server.exe (mirrors the playit tests).
    fs.writeFileSync(path.join(tempDir, 'bedrock_server.cmd'), FAKE_BEDROCK_CMD);
  }

  function bedrockConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
    return {
      serverId: 'bedrock-server',
      name: 'Bedrock Test',
      folderPath: tempDir,
      javaPath: '',
      memoryMb: 1024,
      jvmArgs: [],
      port: 19132,
      edition: 'bedrock',
      ...overrides,
    };
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-bedrock-'));
    states.length = 0;
    logs.length = 0;
    manager = new ProcessManager({
      onState: (_serverId, state, exitCode) => {
        states.push({ state, exitCode });
      },
      onLog: (_serverId, log) => {
        logs.push(log.text);
      },
      onStats: () => {
        // not asserted
      },
    });
  });

  afterEach(async () => {
    manager.shutdown();
    await waitFor(() => manager.runningServerId === null, 5000).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 200));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('starts bedrock_server.exe, reaches online, and streams logs', async () => {
    writeFakeBedrock();
    const err = manager.start(bedrockConfig());
    expect(err).toBeNull();
    expect(manager.runningServerId).toBe('bedrock-server');

    await waitFor(() => logs.some((l) => l.includes('Server started.')));
    expect(states.some((s) => s.state === 'online')).toBe(true);
    // No Java args in the command line.
    const commandLog = logs.find((l) => l.startsWith('Command:'));
    expect(commandLog).toContain('bedrock_server.cmd');
    expect(commandLog).not.toContain('-jar');
    expect(manager.getStatus('bedrock-server').stats.playerCount).toBe(0);
  });

  it('fails with missing-executable when bedrock_server.exe is absent', () => {
    const err = manager.start(bedrockConfig());
    expect(err?.code).toBe('missing-executable');
  });

  it('tracks online player names from bedrock connect/disconnect lines', async () => {
    const FAKE = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
console.log('Server started.');
setTimeout(() => console.log('Player connected: Steve, xuid: 123'), 100);
setTimeout(() => console.log('Player connected: Alex, xuid: 456'), 200);
setTimeout(() => console.log('Player disconnected: Steve, xuid: 123'), 300);
setTimeout(() => process.exit(0), 500);
rl.on('line', () => {});
`;
    writeFakeBedrock();
    fs.writeFileSync(path.join(tempDir, 'fake-bedrock.js'), FAKE);
    manager.start(bedrockConfig());

    await waitFor(
      () => manager.getStatus('bedrock-server').stats.onlinePlayers.length === 2,
      5000,
    );
    expect(manager.getStatus('bedrock-server').stats.onlinePlayers).toEqual(['Steve', 'Alex']);
    expect(manager.getStatus('bedrock-server').stats.playerCount).toBe(2);

    await waitFor(
      () => manager.getStatus('bedrock-server').stats.onlinePlayers.length === 1,
      5000,
    );
    expect(manager.getStatus('bedrock-server').stats.onlinePlayers).toEqual(['Alex']);
    expect(manager.getStatus('bedrock-server').stats.playerCount).toBe(1);

    await waitFor(() => manager.runningServerId === null, 5000);
  });

  it('sends commands via stdin to the bedrock server', async () => {
    writeFakeBedrock();
    manager.start(bedrockConfig());
    const ok = manager.sendCommand('say hello');
    expect(ok).toBe(true);
    await waitFor(() => logs.some((l) => l.includes('echo: say hello')));
    manager.stop();
    await waitFor(() => manager.runningServerId === null, 5000);
  });

  it('marks a graceful stop as offline', async () => {
    writeFakeBedrock();
    manager.start(bedrockConfig());
    await waitFor(() => logs.some((l) => l.includes('Server started.')));
    manager.stop();
    await waitFor(() => manager.runningServerId === null, 5000);
    expect(states[states.length - 1].state).toBe('offline');
  });
});

describe('isBedrockOnlineLine', () => {
  it('detects the BDS online line', () => {
    expect(isBedrockOnlineLine('Server started.')).toBe(true);
    expect(isBedrockOnlineLine('Level "Bedrock level" started')).toBe(true);
    expect(isBedrockOnlineLine('Done (1.234s)!')).toBe(false);
    expect(isBedrockOnlineLine('')).toBe(false);
  });
});

describe('parseBedrockPlayerDelta', () => {
  it('detects connect and disconnect deltas', () => {
    expect(parseBedrockPlayerDelta('Player connected: Steve, xuid: 123')).toBe(1);
    expect(parseBedrockPlayerDelta('Player disconnected: Alex, xuid: 456')).toBe(-1);
    expect(parseBedrockPlayerDelta('Server started.')).toBeNull();
    expect(parseBedrockPlayerDelta('')).toBeNull();
  });
});
