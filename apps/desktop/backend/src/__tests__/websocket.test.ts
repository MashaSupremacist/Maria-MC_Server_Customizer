import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { buildApp } from '../app';

const TOKEN = 'ws-test-token';

describe('WebSocket server events', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let wsUrl: string;
  let serverId: string;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-ws-'));
    app = await buildApp({ dataDir, authToken: TOKEN, appVersion: '0.0.0-test' });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    wsUrl = `ws://127.0.0.1:${port}/ws?token=${TOKEN}`;

    // Create a server record pointing at a fake server (node script).
    const fakeServer = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
setTimeout(() => console.log('Done (0.3s)!'), 300);
rl.on('line', (line) => { if (line.trim() === 'stop') process.exit(0); });
process.on('SIGTERM', () => process.exit(0));
`;
    const serverDir = path.join(dataDir, 'fake-server');
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(path.join(serverDir, 'fake-server.js'), fakeServer);
    fs.writeFileSync(
      path.join(serverDir, 'fake-java.cmd'),
      `@echo off\r\nnode "%~dp0fake-server.js" %*\r\n`,
    );
    fs.writeFileSync(path.join(serverDir, 'server.jar'), 'fake');
    // Marks this synthetic fixture as launcher-managed so production Java
    // version detection does not try to execute cmd.exe as java.exe.
    fs.writeFileSync(path.join(serverDir, 'start.bat'), '@echo off\r\n');
    fs.writeFileSync(path.join(serverDir, 'eula.txt'), 'eula=true\n');

    const created = await app.inject({
      method: 'POST',
      url: '/servers',
      headers: { 'x-msc-token': TOKEN },
      payload: {
        name: 'WS Test',
        edition: 'java',
        serverType: 'vanilla',
        folderPath: serverDir,
        javaPath: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
        memoryMb: 512,
        jvmArgs: ['/c', path.join(serverDir, 'fake-java.cmd')],
      },
    });
    serverId = created.json().id;
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('streams server:state and server:log events to connected clients', async () => {
    const events: string[] = [];
    const ws = new WebSocket(wsUrl);

    // Attach the message listener before open so the initial hello is caught.
    ws.on('message', (data) => {
      events.push(String(data));
    });

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });

    // Start the server and wait for events.
    await app.inject({
      method: 'POST',
      url: '/process/start',
      headers: { 'x-msc-token': TOKEN },
      payload: { serverId },
    });

    // Wait for the online state event specifically.
    await waitFor(() =>
      events.some((e) => e.includes('"type":"server:state"') && e.includes('"state":"online"')),
    );

    const joined = events.join('\n');
    expect(joined).toContain('"type":"hello"');
    expect(joined).toContain('"type":"server:state"');
    expect(joined).toContain('"type":"server:log"');
    expect(joined).toContain('"state":"online"');

    ws.close();
    // Stop the server and wait for the child to fully exit before teardown.
    await app.inject({
      method: 'POST',
      url: '/process/stop',
      headers: { 'x-msc-token': TOKEN },
      payload: { serverId },
    });
    await waitFor(async () => {
      const status = await app.inject({
        method: 'GET',
        url: `/servers/${serverId}/status`,
        headers: { 'x-msc-token': TOKEN },
      });
      return status.json().state === 'offline';
    });
  });
});

function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = async (): Promise<void> => {
      try {
        if (await predicate()) resolve();
        else if (Date.now() - start > timeoutMs) reject(new Error('waitFor timed out'));
        else setTimeout(() => void poll(), 50);
      } catch (err) {
        reject(err);
      }
    };
    void poll();
  });
}
