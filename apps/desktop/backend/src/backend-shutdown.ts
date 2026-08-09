import type { BackendApp } from './app';

/** Build an idempotent signal handler around the app's graceful shutdown. */
export function createSignalShutdownHandler(
  app: Pick<BackendApp, 'gracefulShutdown'>,
  exit: (code: number) => void = (code) => process.exit(code),
  log: Pick<Console, 'log' | 'error'> = console,
): (signal: string) => void {
  let shutdownPromise: Promise<void> | null = null;
  return (signal: string): void => {
    if (shutdownPromise) return;
    log.log(`Received ${signal}, shutting down`);
    shutdownPromise = app.gracefulShutdown();
    void shutdownPromise.then(
      () => exit(0),
      (error: unknown) => {
        log.error('Backend shutdown failed:', error);
        exit(1);
      },
    );
  };
}
