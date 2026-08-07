import { buildApp } from './app';

const dataDir = process.env.MSC_DATA_DIR ?? '';
const authToken = process.env.MSC_AUTH_TOKEN ?? '';
const port = Number(process.env.MSC_PORT ?? '0');
const appVersion = process.env.MSC_APP_VERSION ?? '0.1.0';

if (!dataDir) {
  console.error('MSC_DATA_DIR is required');
  process.exit(1);
}
if (!authToken) {
  console.error('MSC_AUTH_TOKEN is required');
  process.exit(1);
}

async function main(): Promise<void> {
  const app = await buildApp({ dataDir, authToken, appVersion });

  await app
    .listen({ port, host: '127.0.0.1' })
    .then((address) => {
      const url = new URL(address);
      // Signal readiness on stdout so the parent (Electron main) can read the
      // chosen port. Format: MSC_READY <port>
      process.stdout.write(`MSC_READY ${url.port}\n`);
    })
    .catch((err: unknown) => {
      console.error('Backend failed to start:', err);
      process.exit(1);
    });

  function shutdown(signal: string): void {
    console.log(`Received ${signal}, shutting down`);
    void app.close().then(() => process.exit(0));
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGBREAK', () => shutdown('SIGBREAK'));
}

void main();
