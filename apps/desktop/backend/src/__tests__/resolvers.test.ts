import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import crypto from 'node:crypto';
import { FabricResolver } from '../resolvers/fabric';
import { PaperResolver } from '../resolvers/paper';
import { ForgeResolver } from '../resolvers/forge';
import { VanillaResolver } from '../resolvers/vanilla';

/** Start a fake HTTP server that mimics the vanilla manifest + jar. */
function startFakeServer(handlers: Record<string, (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void>): Promise<{ baseUrl: string; server: Server }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = req.url ?? '';
      // Match by prefix (longest wins) so query strings work.
      const entries = Object.entries(handlers).filter(([key]) => url.startsWith(key));
      const handler = entries.sort((a, b) => b[0].length - a[0].length)[0]?.[1];
      if (handler) handler(req, res);
      else {
        res.statusCode = 404;
        res.end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server });
    });
  });
}

function json(res: import('node:http').ServerResponse, data: unknown): void {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(data));
}

// Runs sequentially: fake HTTP servers are timing-sensitive under workers.
describe.sequential('resolvers', () => {
  let server: Server | null = null;
  afterEach(() => {
    server?.close();
    server = null;
  });

  it('vanilla resolves the official server jar', async () => {
    const jarContent = Buffer.from('fake-jar');
    const sha1 = crypto.createHash('sha1').update(jarContent).digest('hex');
    const { baseUrl, server: s } = await startFakeServer({
      '/manifest': (_req, res) =>
        json(res, {
          latest: { release: '1.21.1' },
          versions: [{ id: '1.21.1', type: 'release', url: `${baseUrl}/version/1.21.1`, releaseTime: '2024-01-01T00:00:00Z' }],
        }),
      '/version/1.21.1': (_req, res) =>
        json(res, { downloads: { server: { url: `${baseUrl}/jar`, sha1, size: jarContent.length } } }),
      '/jar': (_req, res) => {
        res.setHeader('content-type', 'application/java-archive');
        res.end(jarContent);
      },
    });
    server = s;
    const resolver = new VanillaResolver({
      fetchImpl: fetch,
      manifestUrl: `${baseUrl}/manifest`,
    });
    const downloads = await resolver.resolveDownloads({ version: '1.21.1' });
    expect(downloads).toHaveLength(1);
    expect(downloads[0].fileName).toBe('server.jar');
    expect(downloads[0].sha1).toBe(sha1);
    const versions = await resolver.listVersions();
    expect(versions[0].id).toBe('1.21.1');
  });

  it('fabric resolves loader jar and optional fabric api', async () => {
    const { baseUrl, server: s } = await startFakeServer({
      '/meta/game': (_req, res) => json(res, [{ version: '1.21.1', stable: true }]),
      '/meta/loader/1.21.1': (_req, res) =>
        json(res, [{ version: '0.16.9', stable: true }, { version: '0.16.8', stable: true }]),
      '/meta/loader/1.21.1/0.16.9/server/jar': (_req, res) => res.end('loader'),
      '/modrinth?game_versions': (_req, res) =>
        json(res, [
          { files: [{ url: `${baseUrl}/fabric-api.jar`, primary: true, filename: 'fabric-api.jar' }] },
        ]),
    });
    server = s;
    const resolver = new FabricResolver({
      fetchImpl: fetch,
      metaUrl: `${baseUrl}/meta`,
      modrinthUrl: `${baseUrl}/modrinth`,
    });
    expect(await resolver.listGameVersions()).toEqual(['1.21.1']);
    expect(await resolver.listLoaderVersions('1.21.1')).toEqual(['0.16.9', '0.16.8']);
    const downloads = await resolver.resolveDownloads({ version: '1.21.1', includeFabricApi: true });
    expect(downloads.map((d) => d.fileName)).toEqual(['fabric-server-launch.jar', 'fabric-api.jar']);
  });

  it('paper resolves a build jar', async () => {
    const { baseUrl, server: s } = await startFakeServer({
      '/project': (_req, res) => json(res, { versions: ['1.21', '1.21.1'] }),
      '/project/versions/1.21.1': (_req, res) => json(res, { builds: [10, 11] }),
      '/project/versions/1.21.1/builds/11': (_req, res) =>
        json(res, { downloads: { application: { name: 'paper-1.21.1-11.jar', sha256: 'abc' } } }),
      '/project/versions/1.21.1/builds/11/downloads/paper-1.21.1-11.jar': (_req, res) => res.end('paper'),
    });
    server = s;
    const resolver = new PaperResolver({ fetchImpl: fetch, apiUrl: `${baseUrl}/project` });
    expect(await resolver.listVersions()).toEqual(['1.21.1', '1.21']);
    const downloads = await resolver.resolveDownloads({ version: '1.21.1' });
    expect(downloads[0].fileName).toBe('paper-1.21.1-11.jar');
    expect(downloads[0].url).toContain('paper-1.21.1-11.jar');
  });

  it('forge lists versions and resolves the installer jar', async () => {
    const { baseUrl, server: s } = await startFakeServer({
      '/maven/net/minecraftforge/forge/maven-metadata.xml': (_req, res) => {
        res.setHeader('content-type', 'application/xml');
        res.end(
          `<?xml version="1.0"?><metadata><groupId>net.minecraftforge</groupId><artifactId>forge</artifactId><versioning><latest>1.21.1-52.0.57</latest><versions><version>1.21.1-52.0.57</version><version>1.21.1-52.0.56</version><version>1.21-51.0.33</version></versions></versioning></metadata>`,
        );
      },
    });
    server = s;
    const resolver = new ForgeResolver({ fetchImpl: fetch, mavenUrl: `${baseUrl}/maven/net/minecraftforge/forge` });
    const versions = await resolver.listVersionsForGame('1.21.1');
    expect(versions).toEqual(['1.21.1-52.0.57', '1.21.1-52.0.56']);
    const downloads = await resolver.resolveDownloads({ version: '1.21.1' });
    expect(downloads[0].fileName).toBe('forge-installer.jar');
    expect(downloads[0].url).toContain('forge-1.21.1-52.0.57-installer.jar');
  });
});
