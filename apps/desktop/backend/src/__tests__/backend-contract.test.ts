import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';

describe('Electron-to-backend route contract', () => {
  let app: FastifyInstance;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-route-contract-'));
    app = await buildApp({ dataDir, authToken: 'contract', appVersion: 'test' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('has a registered Fastify method/path for every backendFetch call', () => {
    const mainPath = path.resolve(__dirname, '..', '..', '..', 'electron', 'main.ts');
    const source = fs.readFileSync(mainPath, 'utf8');
    const calls = [...source.matchAll(/backendFetch\(\s*['"](GET|POST|PUT|PATCH|DELETE)['"]\s*,\s*(?:`([^`]+)`|'([^']+)'|"([^"]+)")/g)]
      .map((match) => ({ method: match[1], route: match[2] ?? match[3] ?? match[4] }));

    expect(calls.length).toBeGreaterThan(40);
    const missing = calls.filter(({ method, route }) => {
      const registeredPattern = route
        .split('?')[0]
        .replace(/\$\{query\}$/g, '')
        .replace(/\$\{([^}]+)\}/g, (_whole, expression: string) =>
          /kind/i.test(expression) ? ':kind' : ':id',
        );
      return !app.hasRoute({ method, url: registeredPattern });
    });
    expect(missing).toEqual([]);
  });

  it('keeps the gamerule update adapter on PUT', () => {
    const mainPath = path.resolve(__dirname, '..', '..', '..', 'electron', 'main.ts');
    const source = fs.readFileSync(mainPath, 'utf8');
    expect(source).toMatch(/backendFetch\('PUT', `\/servers\/\$\{id\}\/gamerules`/);
  });
});
